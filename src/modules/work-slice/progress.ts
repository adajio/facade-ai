export type RequirementProgress = {
  outcome: string;
  decision?: { action: string; outcome: string } | null;
  semanticRemainder?: { state: string };
  machine?: { outcome: string; delivery?: string; readability?: string; limitations?: readonly string[] };
};

export function localFinding({ machine, semanticRemainder }: RequirementProgress) {
  if (machine?.outcome === 'confirmed_missing' || machine?.outcome === 'confirmed_conflict') return 'proven';
  if (machine?.outcome === 'covered') {
    if (semanticRemainder?.state === 'open' || machine.limitations?.length) return 'partial';
    if (semanticRemainder?.state === 'complete') return 'proven';
  }
  if (machine?.outcome === 'needs_review' && machine.delivery === 'received' && machine.readability === 'readable') return 'partial';
}

export function hasRemainder({ outcome, machine, semanticRemainder }: RequirementProgress) {
  return outcome !== 'excluded' && (outcome === 'needs_review' || semanticRemainder?.state === 'open' ||
    machine?.outcome === 'covered' && Boolean(machine.limitations?.length));
}

export function requirementChecked(row: RequirementProgress) {
  const { outcome, decision } = row;
  if (outcome === 'needs_review') return false;
  if (outcome !== 'covered' || !hasRemainder(row)) return true;
  return decision?.outcome === 'covered' && (decision.action === 'confirm' || decision.action === 'correct');
}

export function requirementDone(row: RequirementProgress) {
  return (row.outcome === 'covered' || row.outcome === 'excluded') && requirementChecked(row);
}

export function evidenceCounts(rows: readonly RequirementProgress[]) {
  const result = { proven: 0, partial: 0, remainder: 0 };
  for (const row of rows) {
    const finding = localFinding(row);
    if (finding) result[finding]++;
    if (hasRemainder(row)) result.remainder++;
  }
  return result;
}
