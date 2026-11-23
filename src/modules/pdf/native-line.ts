import { contains, validBox, type Box, type ReaderLine } from './types.js';

export type NativeLineCrop = { evidenceId: string; frame: Box; line: ReaderLine };
export type VerifiedNativeDeliveryLine = {
  line: ReaderLine;
  canonicalSha256: string;
  submittedEvidenceId: string;
  anchorEvidenceId: string;
  crops: [NativeLineCrop] | [NativeLineCrop, NativeLineCrop];
};

export function nativeLineFragment(line: ReaderLine, crop: NativeLineCrop) {
  const full = line.box;
  const box = crop.line.box;
  const text = crop.line.text;
  const start = line.text.indexOf(text);
  if (!text || start < 0 || line.text.indexOf(text, start + 1) >= 0 || crop.line.id !== line.id
    || !full || !validBox(full) || !box || !validBox(box) || !validBox(crop.frame)
    || !contains(crop.frame, box) || !contains(full, box)
    || Math.abs(full.y - box.y) > 0.02 || Math.abs(full.height - box.height) > 0.02) return;
  return { crop, box, start, endText: start + text.length };
}

// Verify text and original PDF coordinates against the canonical line. The
// pair must cover the whole line to use positive evidence from both crops.
export function verifiedNativeLineCrops(
  line: ReaderLine, crops: NativeLineCrop[], submittedEvidenceId: string, quote: string,
): Pick<VerifiedNativeDeliveryLine, 'crops' | 'anchorEvidenceId'> | undefined {
  const full = line.box;
  if (!full || !validBox(full)) return;
  const end = (box: Box) => box.x + box.width;
  const fragments = crops.map((crop) => nativeLineFragment(line, crop)).filter((crop) => crop !== undefined);
  for (const left of fragments) {
    if (left.start !== 0 || Math.abs(left.box.x - full.x) > 0.02) continue;
    for (const right of fragments) {
      if (right.start <= 0 || left.endText >= right.endText || right.endText !== line.text.length
        || right.box.x <= left.box.x || end(right.box) <= end(left.box)
        || Math.abs(end(right.box) - end(full)) > 0.02 || end(left.box) + 0.02 < right.box.x
        || line.text.slice(left.endText, right.start).trim()
        || ![left.crop.evidenceId, right.crop.evidenceId].includes(submittedEvidenceId)) continue;
      const pair: [NativeLineCrop, NativeLineCrop] = [left.crop, right.crop];
      const anchors = pair.filter(({ line: part }) => part.text.includes(quote));
      const anchor = anchors.find(({ evidenceId }) => evidenceId === submittedEvidenceId) ?? anchors[0];
      if (anchor) return { crops: pair, anchorEvidenceId: anchor.evidenceId };
    }
  }
  const submitted = fragments.find(({ crop }) => crop.evidenceId === submittedEvidenceId && crop.line.text.includes(quote));
  if (submitted) return { crops: [submitted.crop], anchorEvidenceId: submittedEvidenceId };
}
