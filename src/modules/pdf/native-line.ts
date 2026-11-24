import { contains, validBox, type Box, type ReaderLine } from './types.js';

export type NativeLineCrop = { evidenceId: string; frame: Box; line: ReaderLine };
export type VerifiedNativeDeliveryLine = {
  line: ReaderLine;
  canonicalSha256: string;
  submittedEvidenceId: string;
  anchorEvidenceId: string;
  crops: [NativeLineCrop] | [NativeLineCrop, NativeLineCrop];
};

const tolerance = 0.02;
const axes = ['x', 'y'] as const;
type Axis = typeof axes[number];
const extent = { x: 'width', y: 'height' } as const;
const end = (box: Box, axis: Axis) => box[axis] + box[extent[axis]];
const near = (a: number, b: number) => Math.abs(a - b) <= tolerance;

function aligned(full: Box, part: Box, along: Axis) {
  const across = along === 'x' ? 'y' : 'x';
  return near(full[across], part[across]) && near(full[extent[across]], part[extent[across]]);
}

export function nativeLineFragment(line: ReaderLine, crop: NativeLineCrop) {
  const full = line.box;
  const box = crop.line.box;
  const text = crop.line.text;
  const start = line.text.indexOf(text);
  if (!text || start < 0 || line.text.indexOf(text, start + 1) >= 0 || crop.line.id !== line.id
    || !full || !validBox(full) || !box || !validBox(box) || !validBox(crop.frame)
    || !contains(crop.frame, box) || !contains(full, box)) return;
  const along = axes.filter((axis) => aligned(full, box, axis));
  if (along.length) return { crop, box, start, endText: start + text.length, along };
}

type NativeFragment = NonNullable<ReturnType<typeof nativeLineFragment>>;

function coversLine(full: Box, prefix: NativeFragment, suffix: NativeFragment, axis: Axis) {
  const [first, last] = prefix.box[axis] < suffix.box[axis] ? [prefix, suffix] : [suffix, prefix];
  const textOverlaps = prefix.endText > suffix.start;
  // A seam in whitespace can separate the word boxes while the windows touch.
  const continuous = end(first.box, axis) + tolerance >= last.box[axis]
    || (!textOverlaps && end(first.crop.frame, axis) + tolerance >= last.crop.frame[axis]);
  return first.box[axis] < last.box[axis] && end(first.box, axis) < end(last.box, axis)
    && near(first.box[axis], full[axis]) && near(end(last.box, axis), end(full, axis)) && continuous;
}

// Verify text and original PDF coordinates against the canonical line. The
// pair must cover the whole line to use positive evidence from both crops.
export function verifiedNativeLineCrops(
  line: ReaderLine, crops: NativeLineCrop[], submittedEvidenceId: string, quote: string,
): Pick<VerifiedNativeDeliveryLine, 'crops' | 'anchorEvidenceId'> | undefined {
  const full = line.box;
  if (!full || !validBox(full)) return;
  const fragments = crops.map((crop) => nativeLineFragment(line, crop)).filter((crop) => crop !== undefined);
  for (const prefix of fragments) {
    if (prefix.start !== 0) continue;
    for (const suffix of fragments) {
      if (suffix.start <= 0 || prefix.endText >= suffix.endText || suffix.endText !== line.text.length
        || line.text.slice(prefix.endText, suffix.start).trim()
        || ![prefix.crop.evidenceId, suffix.crop.evidenceId].includes(submittedEvidenceId)
        || !prefix.along.some((axis) => suffix.along.includes(axis) && coversLine(full, prefix, suffix, axis))) continue;
      const pair: [NativeLineCrop, NativeLineCrop] = [prefix.crop, suffix.crop];
      const anchors = pair.filter(({ line: part }) => part.text.includes(quote));
      const anchor = anchors.find(({ evidenceId }) => evidenceId === submittedEvidenceId) ?? anchors[0];
      if (anchor) return { crops: pair, anchorEvidenceId: anchor.evidenceId };
    }
  }
  const submitted = fragments.find(({ crop }) => crop.evidenceId === submittedEvidenceId && crop.line.text.includes(quote));
  if (submitted) return { crops: [submitted.crop], anchorEvidenceId: submittedEvidenceId };
}
