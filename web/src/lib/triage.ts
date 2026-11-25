import type { AssessmentQuestion } from './workspace';

export const triageOptions = ['review', 'letter', 'done'] as const;
export type Triage = typeof triageOptions[number] | 'all' | 'checked';
type Bucket = typeof triageOptions[number];

export function requirementTitle({ subject, part }: AssessmentQuestion['requirement']) {
  return subject && part && subject !== part ? subject + ' · ' + part : part || subject;
}

export function matchesSelection(row: AssessmentQuestion, selection: string) {
  if (selection === 'all') return true;
  if (selection === 'checked') return row.outcome !== 'needs_review';
  return selection === bucket(row) || selection === row.outcome;
}

export function bucket(row: AssessmentQuestion): Bucket {
  if (row.letterEligible !== undefined) {
    if (row.letterEligible) return 'letter';
    return row.outcome === 'covered' || row.outcome === 'excluded' ? 'done' : 'review';
  }
  if (row.decision?.action === 'request_clarification' && row.decision.requestExternal && row.clarification) return 'letter';
  if (row.outcome === 'covered' || row.outcome === 'excluded') return 'done';
  if ((row.outcome === 'confirmed_missing' || row.outcome === 'confirmed_conflict') &&
      row.decision?.requestExternal === true) return 'letter';
  return 'review';
}

export function triageCounts(rows: AssessmentQuestion[]): Record<Bucket, number> {
  const result = { review: 0, letter: 0, done: 0 };
  for (const row of rows) result[bucket(row)]++;
  return result;
}
