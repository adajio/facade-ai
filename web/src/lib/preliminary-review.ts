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
export function preliminarySourceUrl(source: PreliminarySource) {
  const match = /\.pdf$/iu.test(source.label)
    ? source.anchor.trim().match(/^(?:стр(?:аница)?\.?\s*)?([1-9]\d*)(?:\s*[-–—,].*)?$/iu) : null;
  return originalUrl(source.documentId, source.versionId, match ? Number(match[1]) : undefined);
}
