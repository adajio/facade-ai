import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPdfAdapter } from '../pdf/pdf-adapter.js';
import { ReaderError, type ReaderAdapter } from '../pdf/types.js';
import { FormatHold, readInput } from './model.js';

const signedData = Buffer.from('2a864886f70d010702', 'hex');
const data = Buffer.from('2a864886f70d010701', 'hex');
const pdfHeader = Buffer.from('%PDF-');
const versionPrefix = 'cms-signature-v1:';
const detached = 'signature_detached';

type Tlv = { tag: number; start: number; end: number; next: number };
type Signature = { kind: 'detached' } | { kind: 'embedded_pdf'; pdf: Buffer; sha256: string };

function invalid(): never {
  throw new ReaderError('signature_invalid', 'Не удалось разобрать структуру контейнера подписи', 422);
}

function unsupported(): never {
  throw new ReaderError('signature_format_unsupported', 'Формат контейнера подписи не установлен', 415);
}

/** Read CMS container boundaries; certificates and signer data are not returned. */
export function inspectSignature(bytes: Buffer): Signature {
  let budget = 100_000;
  function read(offset: number, limit: number, depth = 0): Tlv {
    if (offset + 2 > limit || depth > 24 || --budget < 0) invalid();
    const tag = bytes[offset++], length = bytes[offset++];
    if (tag === 0 || (tag & 0x1f) === 0x1f) invalid();
    if (length === 128) {
      if (!(tag & 0x20)) invalid();
      let end = offset;
      while (end + 2 <= limit && (bytes[end] !== 0 || bytes[end + 1] !== 0)) end = read(end, limit, depth + 1).next;
      if (end + 2 > limit) invalid();
      return { tag, start: offset, end, next: end + 2 };
    }
    let count = length;
    if (length > 128) {
      const lengthBytes = length - 128;
      if (lengthBytes > 4 || offset + lengthBytes > limit) invalid();
      count = bytes.readUIntBE(offset, lengthBytes);
      offset += lengthBytes;
    }
    const end = offset + count;
    if (end > limit) invalid();
    return { tag, start: offset, end, next: end };
  }
  function unpack(parent: Tlv, maximum: number) {
    const children: Tlv[] = [];
    for (let offset = parent.start; offset < parent.end;) {
      if (children.length >= maximum) invalid();
      const child = read(offset, parent.end);
      children.push(child);
      offset = child.next;
    }
    return children;
  }
  const oid = (element: Tlv | undefined, expected: Buffer) => element?.tag === 6 && bytes.subarray(element.start, element.end).equals(expected);

  if (bytes[0] !== 0x30) unsupported();
  const envelope = read(0, bytes.length);
  const [type, wrapped, extra] = unpack(envelope, 3);
  if (!oid(type, signedData)) unsupported();
  if (envelope.next !== bytes.length || wrapped?.tag !== 0xa0 || extra) invalid();
  const [signature, extraSignature] = unpack(wrapped, 2);
  if (signature?.tag !== 0x30 || extraSignature) invalid();
  const [version, algorithms, content, ...rest] = unpack(signature, 6);
  if (version?.tag !== 2 || version.start === version.end || algorithms?.tag !== 0x31 || content?.tag !== 0x30) invalid();
  const signerSet = rest.at(-1);
  const optional = rest.slice(0, -1).map(({ tag }) => tag);
  if (signerSet?.tag !== 0x31 || signerSet.start === signerSet.end ||
    optional.some((tag, index) => (tag !== 0xa0 && tag !== 0xa1) || index > 0 && optional[index - 1] >= tag)) invalid();
  const signer = read(signerSet.start, signerSet.end);
  if (signer.tag !== 0x30 || read(signer.start, signer.end).tag !== 2) invalid();
  const [contentType, payload, extraContent] = unpack(content, 3);
  if (!oid(contentType, data)) unsupported();
  if (!payload) return { kind: 'detached' };
  if (payload.tag !== 0xa0 || extraContent) invalid();
  const [octet, extraOctet] = unpack(payload, 2);
  if (!octet || extraOctet) invalid();

  const parts: Buffer[] = [];
  function append(element: Tlv, depth: number) {
    if (depth > 16 || parts.length >= 32_768) invalid();
    if (element.tag === 4) {
      parts.push(bytes.subarray(element.start, element.end));
    } else if (element.tag === 0x24) {
      for (let offset = element.start; offset < element.end;) {
        const part = read(offset, element.end);
        append(part, depth + 1);
        offset = part.next;
      }
    } else invalid();
  }
  append(octet, 0);
  const pdf = parts.length === 1 ? parts[0] : Buffer.concat(parts);
  if (!pdf.subarray(0, pdfHeader.length).equals(pdfHeader)) {
    throw new ReaderError('signature_payload_unsupported', 'Содержимое контейнера подписи не является PDF', 415);
  }
  return { kind: 'embedded_pdf', pdf, sha256: createHash('sha256').update(pdf).digest('hex') };
}

const detachedUnit = { id: 'original', label: 'Отделённая подпись',
  locator: { coverage: 'original_only', signatureKind: detached, limitations: detached } };

async function getSignature(path: string) {
  try {
    return inspectSignature(await readInput(path));
  } catch (error) {
    if (!(error instanceof FormatHold)) throw error;
    throw new ReaderError(error.code, 'Контейнер подписи превышает предел чтения или недоступен полностью', 422);
  }
}

async function withPdf<T>(signature: Extract<Signature, { kind: 'embedded_pdf' }>, operation: (path: string) => Promise<T>) {
  const directory = await mkdtemp(join(tmpdir(), 'facade-cms-pdf-'));
  try {
    const path = join(directory, 'embedded.pdf');
    await writeFile(path, signature.pdf, { mode: 0o600 });
    return await operation(path);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

export function createSignatureAdapter(): ReaderAdapter {
  const pdf = createPdfAdapter({ ocrLanguages: process.env.FACADE_PDF_OCR_LANGUAGES, profile: process.env.FACADE_READER_PROFILE });
  return {
    format: 'sig',
    version: async () => versionPrefix + await pdf.version(),
    async inspect(path) {
      const signature = await getSignature(path);
      if (signature.kind === 'detached') return [detachedUnit];
      const pages = await withPdf(signature, (embedded) => pdf.inspect(embedded));
      return pages.map((page) => ({ ...page, locator: { ...page.locator, signatureKind: signature.kind, embeddedSha256: signature.sha256 } }));
    },
    async read(path, request, unit, containedWords) {
      const signature = await getSignature(path);
      if (signature.kind === 'detached') {
        if (request.representation !== 'native' || request.address.box || Object.entries(request.address.locator ?? {}).some(([key, value]) => unit.locator?.[key] !== value)) {
          throw new ReaderError(detached, 'В отделённой подписи нет документа для чтения', 422);
        }
        const address = { unitId: unit.id, locator: unit.locator };
        const output = { address, lines: [], limitations: [detached] };
        return { ...output, mediaType: 'application/json', bytes: Buffer.from(JSON.stringify(output)) };
      }
      if (signature.sha256 !== unit.locator?.embeddedSha256) {
        throw new ReaderError('signature_payload_mismatch', 'Вложенный PDF отличается от закреплённого', 424);
      }
      return withPdf(signature, (embedded) => pdf.read(embedded, request, unit, containedWords));
    },
  };
}
