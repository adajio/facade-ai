import { originalUrl } from './copilot';

export type PreliminaryStatus = 'present' | 'partial' | 'not_found' | 'unassessed';
export type PreliminarySource = { documentId: string; versionId: string; label: string; anchor: string };
export type PreliminaryRow = { key: string; title: string; status: PreliminaryStatus; finding: string; sources: PreliminarySource[] };
export type PreliminaryReview = {
  id: string; receiptId: string; catalogVersionId: string; model: string; createdAt: string; stage: string;
  scopeNote: string; isCurrent: boolean; draftText: string; rows: PreliminaryRow[];
};
export const preliminaryStatusLabels: Record<PreliminaryStatus, string> = {
  present: 'Представлено', partial: 'Частично', not_found: 'Не найдено', unassessed: 'Не оценено',
};
type ParsedPlace = {label: string; page?: number};

export function preliminarySourcePlace(source: PreliminarySource): ParsedPlace {
  const original = source.anchor.trim();
  if (original.startsWith('{')) {
    try {
      const anchor = JSON.parse(original);
      const at = anchor?.address?.locator ?? {};
      const page = Number(at.page);
      const validPage = Number.isSafeInteger(page) && page > 0;
      const parts = [
        validPage && `Стр. ${page}`,
        at.sheet && `Лист ${at.sheet}`, at.cell && `Ячейка ${at.cell}`,
        at.layout && `Лист чертежа ${at.layout}`, at.layer && `Слой ${at.layer}`,
      ].filter(Boolean);
      if (!parts.length && typeof anchor?.unitId === 'string') parts.push(anchor.unitId);
      if (typeof anchor?.lineId === 'string' && anchor.lineId.length <= 40) parts.push(`Строка ${anchor.lineId}`);
      if (parts.length) return {label:parts.join(' · '), page:validPage ? page : undefined};
    } catch { /* Plain-text addresses from previous reviews remain readable. */ }
  }
  const match = original.match(/^(?:стр(?:аница)?\.?\s*)?([1-9]\d*)(?:\s*[-–—,].*)?$/iu);
  return {label:original, page:match ? Number(match[1]) : undefined};
}

export function preliminarySourceUrl(source: PreliminarySource) {
  const page = /\.pdf$/iu.test(source.label) ? preliminarySourcePlace(source).page : undefined;
  return originalUrl(source.documentId, source.versionId, page);
}
