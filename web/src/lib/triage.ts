import type { AssessmentQuestion } from './workspace';

export const triageOptions = ['review', 'letter', 'done'] as const;
export type Triage = typeof triageOptions[number];

export function bucket(row: AssessmentQuestion): Triage {
  if (row.decision?.action === 'request_clarification' && row.decision.requestExternal && row.clarification) return 'letter';
  if (row.outcome === 'covered' || row.outcome === 'excluded') return 'done';
  if ((row.outcome === 'confirmed_missing' || row.outcome === 'confirmed_conflict') &&
      row.decision?.requestExternal === true) return 'letter';
  return 'review';
}

export function triageCounts(rows: AssessmentQuestion[]): Record<Triage, number> {
  const result = { review: 0, letter: 0, done: 0 };
  for (const row of rows) result[bucket(row)]++;
  return result;
}
