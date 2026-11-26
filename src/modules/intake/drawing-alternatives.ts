import type { PreparationItem } from './package-preparation.js';

export type DrawingAlternative = {
  originalOccurrenceId: string; originalVersionId: string; originalPath: string;
  availableOccurrenceId: string; availableVersionId: string; availablePath: string;
  relation: 'sibling_pdf_same_stem';
};

/** The parent archive and full relative stem include the revision. Never infer sheet equivalence. */
export function deriveDrawingAlternatives(items: PreparationItem[], parents: Map<string, string | null>): DrawingAlternative[] {
  const key = (item: PreparationItem) => JSON.stringify([parents.get(item.occurrenceId!),
    item.label.normalize('NFC').replaceAll('\\','/').toLowerCase().replace(/\.[^./]+$/u,'')]);
  const pdfs = new Map<string, PreparationItem[]>();
  for (const item of items) {
    if (item.kind !== 'document' || item.state !== 'available' || item.format !== 'pdf' ||
        !item.occurrenceId || !parents.has(item.occurrenceId) || !item.documentId || !item.versionId ||
        !item.originalSha256 || !item.windowIds?.length || !/\.pdf$/iu.test(item.label)) continue;
    const group = pdfs.get(key(item)) ?? [];
    group.push(item);
    pdfs.set(key(item), group);
  }
  const result: DrawingAlternative[] = [];
  for (const item of items) {
    if (item.kind !== 'document' || item.state !== 'unavailable' || !item.occurrenceId || !parents.has(item.occurrenceId) ||
        !item.versionId || !/\.(?:dwg|dxf)$/iu.test(item.label)) continue;
    const candidates = pdfs.get(key(item));
    if (candidates?.length !== 1) continue;
    const companion = candidates[0];
    result.push({originalOccurrenceId:item.occurrenceId,originalVersionId:item.versionId,originalPath:item.label,
      availableOccurrenceId:companion.occurrenceId!,availableVersionId:companion.versionId!,availablePath:companion.label,
      relation:'sibling_pdf_same_stem'});
  }
  return result;
}
