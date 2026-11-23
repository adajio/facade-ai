import { id } from './http';
import { projectApi, type Position } from './workspace';

export type WorkReceiptFilter = 'all' | 'open' | 'processing';
export const workReceiptFilters: Record<WorkReceiptFilter, string> = {
  all: 'Все поступления',
  open: 'Опись открыта',
  processing: 'Обрабатываются',
};

export type WorkSlice = Position & {
  projectId: string;
  workSliceId: string;
  scopeId: string | null;
  catalogAssigned: boolean;
  confirmedBytes: number;
  acceptedOccurrences: number;
  totals: Record<WorkReceiptFilter, number>;
  filters: { filter: WorkReceiptFilter; total: number }[];
  readings: { state: 'ready' | 'leased' | 'done' | 'held'; branch: 'A' | 'B' | null; total: number }[];
  activeReceipt: { receiptId: string; number: number; filter: WorkReceiptFilter } | null;
  assessment: { kind: 'scope' | 'facade'; version: number; outcome: string; covered: number; total: number } | null;
};

export function workSliceApi(projectId: string, workSliceId = 'current') {
  return projectApi(projectId) + '/work-slices/' + id(workSliceId);
}
