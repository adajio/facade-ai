import { id } from './http';
import { projectApi, scopedUrl, type Position } from './workspace';

export type WorkReceiptFilter = 'all' | 'open' | 'processing';
export const workReceiptFilters: Record<WorkReceiptFilter, string> = {
  all: 'Все поступления',
  open: 'Опись открыта',
  processing: 'Обрабатываются',
};

export type AreaCounts = {
  outcome: string; covered: number; total: number; checked?: number; review?: number; ready?: number;
  previousConclusion?: { assessmentVersion: number; reason: string };
  letter?: number; contextId?: string; concluded?: boolean; conflicts?: number; actionable?: number;
};
export type WorkArea = AreaCounts & { contextId: string; name: string; kind: string };

export type ResearchContinuation = { available: number; queued: number; needsAction: number };

export type WorkSlice = Position & {
  projectId: string;
  workSliceId: string;
  scopeId: string | null;
  catalogAssigned: boolean;
  continuation?: ResearchContinuation;
  readingService?: { enabled: boolean; observedAt: string; validUntil: string } | null;
  confirmedBytes: number;
  acceptedOccurrences: number;
  files?: { accepted: number; prepared: number };
  totals: Record<WorkReceiptFilter, number>;
  filters: { filter: WorkReceiptFilter; total: number }[];
  readings: { state: 'ready' | 'leased' | 'done' | 'held'; branch: 'A' | 'B' | null; total: number }[];
  stops?: { jobId: string; branch: 'A' | 'B' | null; reason: string | null; nextAction: string | null;
    receiptId: string | null; versionId: string | null; label: string | null }[];
  moreStops?: boolean;
  latestReceipt?: { receiptId: string; number: number } | null;
  activeReceipt: { receiptId: string; number: number; filter: WorkReceiptFilter } | null;
  assessment: (AreaCounts & { kind: 'scope' | 'facade'; version: number; contexts?: WorkArea[] }) | null;
};

export function chooseWorkArea(slice: WorkSlice, requested: string | null): WorkSlice {
  const assessment = slice.assessment;
  if (!assessment || assessment.kind !== 'facade') return slice;
  const areas = assessment.contexts;
  if (!areas?.length) {
    return requested && requested !== assessment.contextId ? { ...slice, assessment: null } : slice;
  }
  const area = requested ? areas.find((a) => a.contextId === requested) : areas.length === 1 ? areas[0] : undefined;
  return { ...slice, assessment: area ? { ...assessment, ...area, kind: 'facade' } : null };
}

export function currentOperation(slice: WorkSlice) {
  if (!(slice.files?.accepted ?? slice.acceptedOccurrences)) return 1;
  const a = slice.assessment;
  if (!a) return 2;
  if (a.concluded) return a.letter ? 5 : 4;
  if (a.actionable ?? (a.review && (a.checked || a.conflicts))) return 3;
  if (a.total && a.review === 0) return 4;
  return 2;
}

export function requirementsUrl(slice: WorkSlice, filter = 'all') {
  return scopedUrl(slice.projectId, 'completeness', {
    scope: slice.scopeId, context: slice.assessment?.contextId, filter, seen: slice.assessment?.version,
  });
}

export function readingStatus(slice: WorkSlice, now: number) {
  const signal = slice.readingService;
  if (!slice.files?.accepted && !slice.acceptedOccurrences) return 'Чтение начнётся после приёма оригинала.';
  if (slice.readings.some((row) => row.state === 'leased') && slice.readings.some((row) => row.state === 'held'))
    return 'Часть заданий выполняется. Для остановленных заданий проверьте причину и следующее действие.';
  if (slice.readings.some((row) => row.state === 'leased')) return 'Идёт автоматическое чтение. Принятые оригиналы уже доступны.';
  const current = signal && Date.parse(signal.validUntil) > now;
  if (slice.readings.some((row) => row.state === 'held')) return 'Есть приостановленные задания. Откройте документ, чтобы увидеть причину и разрешённое продолжение.';
  if (current && !signal.enabled && (!slice.readings.length || slice.readings.some((row) => row.state === 'ready'))) return 'Автоматическое чтение отключено. Включить разрешённый маршрут может оператор. Оригиналы доступны для ручной сверки.';
  if (slice.readings.some((row) => row.state === 'ready')) return 'Чтение в очереди. Система продолжит при доступности исполнителя и маршрута.';
  if (slice.readings.length) return 'Задания чтения завершены. Проверьте результат и остаток по требованиям.';
  if (!current) return 'Начало чтения не подтверждено. Актуального сигнала исполнителя нет.';
  return 'Исполнитель доступен. Назначение чтения этого комплекта пока не подтверждено.';
}

export function workSliceApi(projectId: string, workSliceId = 'current') {
  return projectApi(projectId) + '/work-slices/' + id(workSliceId);
}
