import { evidenceCounts, hasRemainder, localFinding, requirementChecked, requirementDone } from '../../../src/modules/work-slice/progress';
import type { AssessmentQuestion } from './workspace';

export const triageOptions = ['review', 'letter', 'done'] as const;
export type Triage = typeof triageOptions[number] | 'all' | 'checked' | EvidenceFilter;
export type EvidenceFilter = 'proven' | 'partial' | 'remainder';
export const evidenceFilters: Record<EvidenceFilter, string> = {
  proven: 'Доказанные выводы',
  partial: 'Найдено частично',
  remainder: 'Остаток проверки',
};
export { evidenceCounts, hasRemainder, localFinding, requirementChecked };
type Bucket = typeof triageOptions[number];

export function requirementTitle({ subject, part }: AssessmentQuestion['requirement']) {
  return subject && part && subject !== part ? subject + ' · ' + part : part || subject;
}

export function matchesSelection(row: AssessmentQuestion, selection: string) {
  if (selection === 'all') return true;
  if (selection === 'checked') return requirementChecked(row);
  if (selection === 'remainder') return hasRemainder(row);
  if (selection === 'proven' || selection === 'partial') return selection === localFinding(row);
  return selection === bucket(row) || selection === row.outcome;
}

export function bucket(row: AssessmentQuestion): Bucket {
  if (row.letterEligible !== undefined) {
    if (row.letterEligible) return 'letter';
    return requirementDone(row) ? 'done' : 'review';
  }
  if (row.decision?.action === 'request_clarification' && row.decision.requestExternal && row.clarification) return 'letter';
  if (requirementDone(row)) return 'done';
  if ((row.outcome === 'confirmed_missing' || row.outcome === 'confirmed_conflict') &&
      row.decision?.requestExternal === true) return 'letter';
  return 'review';
}

export function triageCounts(rows: AssessmentQuestion[]): Record<Bucket, number> {
  const result = { review: 0, letter: 0, done: 0 };
  for (const row of rows) result[bucket(row)]++;
  return result;
}
