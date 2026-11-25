import { PNG } from 'pngjs';
import { pngBase64Length } from '../gateway/admission.js';
import type { VisualPolicy } from '../gateway/types.js';
import type { Box, ImageTransform } from '../pdf/types.js';
import { hashBytes, type Message, type ToolReply } from './openrouter.js';

export type VisualReceipt = {
  evidenceId: string;
  part: number;
  total: number;
  sha256?: string;
  pixelBox?: Box;
  sourceBox?: Box;
};

export type VisualTurn = {
  policy: VisualPolicy;
  fragments: Map<string, Fragment[]>;
};

type Fragment = Omit<VisualReceipt, 'part' | 'total' | 'evidenceId'> & { url: string };
type ImageMessage = Extract<Message, { role: 'user'; content: unknown[] }>;
type ModelRequest = { messages: Message[] };

const pngPrefix = 'data:image/png;base64,';
const sourceLimits = {
  maxImageBytes: 4 * 1024 ** 2,
  maxImageWidth: 12_000_000,
  maxImageHeight: 12_000_000,
  maxImagePixels: 12_000_000,
};
const maxFragments = 64;

function fragmentRasters(url: string, transform: ImageTransform, policy: VisualPolicy): Fragment[] {
  if (pngBase64Length(url, sourceLimits) === null) throw new Error('unsupported PNG');
  const bytes = Buffer.from(url.slice(pngPrefix.length), 'base64');
  const { width, height, pixelsPerPoint, pixelOriginX, pixelOriginY } = transform;
  if (bytes[24] > 8 || bytes.readUInt32BE(16) !== width || bytes.readUInt32BE(20) !== height
    || ![pixelsPerPoint, pixelOriginX, pixelOriginY].every(Number.isFinite) || pixelsPerPoint <= 0) {
    throw new Error('invalid visual transform');
  }
  const png = PNG.sync.read(bytes);
  const result: Fragment[] = [];

  function partition(box: Box, depth: number) {
    if (depth > 16 || result.length >= maxFragments) throw new Error('visual fragment limit');
    const { x, y, width: w, height: h } = box;
    if (w <= policy.maxImageWidth && h <= policy.maxImageHeight && w * h <= policy.maxImagePixels) {
      const tile = new PNG({ width: w, height: h });
      tile.gamma = png.gamma;
      for (let row = 0; row < h; row++) {
        const offset = ((y + row) * width + x) * 4;
        png.data.copy(tile.data, row * w * 4, offset, offset + w * 4);
      }
      const encoded = PNG.sync.write(tile, { colorType: 6 });
      const url = pngPrefix + encoded.toString('base64');
      if (pngBase64Length(url, policy) !== null) {
        result.push({ url, sha256: hashBytes(encoded), pixelBox: box,
          sourceBox: { x: (pixelOriginX + x) / pixelsPerPoint, y: (pixelOriginY + y) / pixelsPerPoint,
            width: w / pixelsPerPoint, height: h / pixelsPerPoint } });
        return;
      }
    }

    if (w === 1 && h === 1) throw new Error('pixel does not fit visual policy');
    // Retain original pixels and overlap at the cut so a line can be read on either side.
    const splitWidth = w > 1 && (h === 1 || w / policy.maxImageWidth >= h / policy.maxImageHeight);
    if (splitWidth) {
      const mid = Math.floor(w / 2), overlap = Math.min(32, Math.floor(w / 8));
      partition({ x, y, width: mid + overlap, height: h }, depth + 1);
      partition({ x: x + mid - overlap, y, width: w - mid + overlap, height: h }, depth + 1);
    } else {
      const mid = Math.floor(h / 2), overlap = Math.min(32, Math.floor(h / 8));
      partition({ x, y, width: w, height: mid + overlap }, depth + 1);
      partition({ x, y: y + mid - overlap, width: w, height: h - mid + overlap }, depth + 1);
    }
  }

  partition({ x: 0, y: 0, width, height }, 0);
  return result;
}

function imageReference(message: Message) {
  if (message.role !== 'user' || !Array.isArray(message.content)) return undefined;
  const [text, image] = message.content;
  if (text?.type !== 'text' || image?.type !== 'image_url') return undefined;
  const { evidenceId, sha256 } = JSON.parse(text.text) as { evidenceId: string; sha256: string };
  return { message, evidenceId, sha256, url: image.image_url.url };
}

export function prepareVisualTurn<T extends ModelRequest>(
  request: T, visual: VisualTurn, replies: Map<string, ToolReply>, delivered: Set<string>,
  sentParts: Map<string, Map<number, VisualReceipt>>,
): { request: T; receipts: VisualReceipt[] } | undefined {
  const references = new Map<number, NonNullable<ReturnType<typeof imageReference>>>();
  request.messages.forEach((message, index) => {
    const ref = imageReference(message);
    if (ref) references.set(index, ref);
  });
  if (!references.size) return { request, receipts: [] };

  const pending: { index: number; url: string; receipt: VisualReceipt }[] = [];
  const queued = new Set<string>();
  for (const [index, ref] of references) {
    if (delivered.has(ref.evidenceId)) {
      visual.fragments.delete(ref.evidenceId);
      continue;
    }
    if (queued.has(ref.evidenceId)) continue;
    queued.add(ref.evidenceId);
    let fragments = visual.fragments.get(ref.evidenceId);
    if (!fragments && pngBase64Length(ref.url, visual.policy) === null) {
      const transform = (replies.get(ref.evidenceId)?.body as { transform?: ImageTransform } | undefined)?.transform;
      if (!transform) return undefined;
      try {
        fragments = fragmentRasters(ref.url, transform, visual.policy);
        visual.fragments.set(ref.evidenceId, fragments);
      } catch {
        return undefined;
      }
    }
    const parts = fragments ?? [{ url: ref.url }];
    for (const [i, { url, ...fragment }] of parts.entries()) {
      const sent = sentParts.get(ref.evidenceId)?.get(i + 1);
      if (sent && (sent.total !== parts.length || sent.sha256 !== fragment.sha256)) return undefined;
      if (!sent) pending.push({
        index, url, receipt: { ...fragment, evidenceId: ref.evidenceId, part: i + 1, total: parts.length },
      });
    }
  }

  function render(batch: typeof pending): T {
    const messages: Message[] = request.messages.flatMap((message, index): Message[] => {
      const ref = references.get(index);
      if (!ref) return [message];
      const parts = batch.filter(item => item.index === index);
      if (!parts.length) {
        return [{ role: 'user', content: JSON.stringify({ evidenceId: ref.evidenceId, sha256: ref.sha256,
          image: delivered.has(ref.evidenceId) ? 'shown_in_previous_turn' : 'waiting_for_visual_batch' }) }];
      }
      return parts.map(({ url, receipt }) => receipt.sourceBox ? {
        role: 'user', content: [
          { type: 'text', text: JSON.stringify({ evidenceId: ref.evidenceId, sha256: ref.sha256, visualFragment: receipt }) },
          { type: 'image_url', image_url: { url } },
        ],
      } satisfies ImageMessage : ref.message);
    });
    if (batch.length < pending.length) {
      messages.push({ role: 'user', content: 'More images or fragments from the opened evidence are queued for the next turn. Inspect the current batch and continue. Finish the reading only after the queued fragments have been shown.' });
    }
    return { ...request, messages };
  }

  if (!pending.length) return { request: render([]), receipts: [] };

  // A route can enforce a smaller serialized request than the sum of its per-image limits.
  for (let count = Math.min(visual.policy.maxImages, pending.length); count > 0; count--) {
    const batch = pending.slice(0, count);
    const candidate = render(batch);
    if (visual.policy.accepts(candidate)) {
      return { request: candidate, receipts: batch.map(item => item.receipt) };
    }
  }
}
