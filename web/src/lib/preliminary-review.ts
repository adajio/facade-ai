import { originalUrl } from './copilot';

export type PreliminaryStatus = 'present' | 'partial' | 'not_found' | 'unassessed';
export type PreliminarySource = {
  documentId: string; versionId: string; label: string; anchor: string;
  originalSha256?: string; quote?: string; limitation?: string;
};
export type PreliminaryPropertyStatus = 'confirmed' | 'unanswered' | 'not_mentioned' | 'insufficient' | 'conflicting';
export type PreliminaryScopeSide = { element: string; zone?: string; purpose?: string; variant?: string };
export type PreliminaryFactScope = {
  basis?: 'literal'; kind: 'applicable' | 'unrelated' | 'undetermined'; target: PreliminaryScopeSide; observed?: PreliminaryScopeSide;
  reason: string; sources: PreliminarySource[];
};
export type PreliminaryAnalysis = {
  applicability: { kind: 'included' | 'excluded' | 'undetermined'; reason: string; sources: PreliminarySource[] };
  properties: {
    key: string; label: string; status: PreliminaryPropertyStatus; finding: string; sources: PreliminarySource[]; scope?: PreliminaryFactScope;
    letter: { kind: 'ask' | 'omit'; text: string };
    response?: { state: 'received' | 'not_received'; finding: string; sources: PreliminarySource[] };
  }[];
  tensions: {
    key: string; propertyKey: string; status: 'open' | 'resolved'; finding: string;
    sides: { text: string; sources: PreliminarySource[] }[]; resolutionSources: PreliminarySource[];
  }[];
};
export type PreliminaryRow = {
  key: string; title: string; status: PreliminaryStatus; finding: string; sources: PreliminarySource[];
  analysis?: PreliminaryAnalysis;
  retained?: { status: 'present' | 'partial'; finding: string; sources: PreliminarySource[] };
};
export type PreliminaryChanges = {
  baselineId: string | null;
  baselineAt: string | null;
  baselineReceiptId?: string | null;
  baselineScope?: 'same_receipt' | 'previous_receipt' | null;
  rows: {
    key: string; changed: boolean; previousStatus: PreliminaryStatus | null; previousFinding: string | null;
    addedSources: PreliminarySource[]; removedSources: PreliminarySource[];
    analysisChanged?: boolean; previousAnalysis?: PreliminaryAnalysis | null; retainedChanged?: boolean;
  }[];
  letter: { changed: boolean; added: string[]; removed: string[] };
};
export type PreliminaryReview = {
  id: string; receiptId: string; catalogVersionId: string; model: string; createdAt: string; stage: string;
  scopeNote: string; isCurrent: boolean; draftText: string; rows: PreliminaryRow[]; changes?: PreliminaryChanges;
};
export const preliminaryStatusLabels: Record<PreliminaryStatus, string> = {
  present: 'Представлено', partial: 'Частично', not_found: 'Не найдено', unassessed: 'Не оценено',
};
export function preliminaryLetterQuestion(property: PreliminaryAnalysis['properties'][number]) {
  return property.letter.kind === 'ask' && (!property.scope || property.scope.kind === 'applicable')
    ? property.letter.text : undefined;
}

export function preliminaryNextAction(row: PreliminaryRow) {
  const analysis = row.analysis;
  if (analysis?.applicability.kind === 'excluded') return analysis.applicability.reason;
  const question = analysis?.properties.map(preliminaryLetterQuestion).find(Boolean);
  if (question) return question;
  if (analysis?.applicability.kind === 'undetermined') return analysis.applicability.reason;
  const unresolved = analysis?.properties.find(property => property.status !== 'confirmed');
  if (unresolved) {
    const action = unresolved.scope && unresolved.scope.kind !== 'applicable'
      ? unresolved.scope.reason : unresolved.letter.kind === 'omit' ? unresolved.letter.text : unresolved.finding;
    return unresolved.label + ' · ' + action;
  }
  if (row.status === 'present' && analysis?.properties.length) return 'Открытых уточнений по сохранённому разбору нет.';
  return 'Адресный вопрос пока не сформирован.';
}

export function preliminaryQuestions(rows: PreliminaryRow[]) {
  const unique = (sources: PreliminarySource[]) => [...new Map(sources.map(source => [
    JSON.stringify([source.versionId,source.anchor,source.quote,source.limitation]), source,
  ])).values()];
  const normalize = (text: string) => text.normalize('NFC').toLocaleLowerCase('ru')
    .replaceAll('ё','е').replace(/\s+/gu,' ').trim().replace(/[.!?]+$/u,'');
  const questions = new Map<string, { key: string; subjects: Set<string>; property: string; text: string; sources: PreliminarySource[] }>();
  for (const row of rows) {
    for (const property of row.analysis?.properties ?? []) {
      const text = preliminaryLetterQuestion(property);
      if (!text) continue;
      const target = property.scope?.target;
      const identity = JSON.stringify([normalize(text),target
        ? [target.element,target.zone,target.purpose,target.variant].map(value => normalize(value ?? ''))
        : normalize(property.label)]);
      const question = questions.get(identity) ?? { key: identity, subjects: new Set<string>(), property: property.label, text, sources: [] };
      question.subjects.add(row.title + ' · ' + property.label);
      question.sources = unique([...question.sources, ...property.sources, ...(property.response?.sources ?? []),
        ...(property.scope?.sources ?? []), ...(row.analysis?.tensions.filter(tension => tension.propertyKey === property.key)
          .flatMap(tension => tension.sides.flatMap(side => side.sources)) ?? [])]);
      questions.set(identity,question);
    }
  }
  return [...questions.values()];
}

type ParsedPlace = {label: string; page?: number};

export function preliminarySourcePlace(source: PreliminarySource): ParsedPlace {
  const original = source.anchor.trim();
  if (original.startsWith('{')) {
    try {
      const anchor = JSON.parse(original);
      const address = anchor?.address;
      const at = address?.locator ?? {};
      const page = Number(at.page);
      const validPage = Number.isSafeInteger(page) && page > 0;
      const drawing = typeof at.space === 'string' && typeof at.derivativeSha256 === 'string';
      const drawingText = drawing && anchor.drawingText?.origin === 'dwg_native_geometry';
      const parts = [
        drawingText && 'Надпись на чертеже',
        validPage && `Стр. ${page}`,
        (at.sheet ?? at.sheetName) && `Лист ${at.sheet ?? at.sheetName}`,
        at.cell && `Ячейка ${at.cell}`, at.range && `Диапазон ${at.range}`,
        at.row && `Строка ${at.row}`, at.paragraph && `Абзац ${at.paragraph}`, at.table && `Таблица ${at.table}`,
        (at.layout || drawing) && (at.space === 'Model' && !at.layout ? 'Пространство модели' : `Лист чертежа ${at.layout ?? at.space}`), at.layer && `Слой ${at.layer}`,
      ].filter(Boolean);
      const unitId = address?.unitId ?? anchor?.unitId;
      if (drawingText && (at.part !== undefined || unitId)) parts.push(at.part !== undefined ? `Участок ${at.part}` : `Участок ${unitId}`);
      else if (!parts.length && typeof unitId === 'string') parts.push(unitId);
      if (!drawingText && typeof anchor?.lineId === 'string' && anchor.lineId.length <= 40) parts.push(`Строка ${anchor.lineId}`);
      if (address?.box) {
        const { x, y, width, height } = address.box;
        const coordinates = [x, y, width, height];
        if (coordinates.every(Number.isFinite)) parts.push(`Область ${coordinates.map((value) => Math.round(value * 100) / 100).join(', ')}${drawing ? ' ед. чертежа' : ' пт'}`);
      }
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
