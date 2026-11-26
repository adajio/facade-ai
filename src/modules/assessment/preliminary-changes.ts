import { canonicalJson } from './domain.js';

export type ReviewSource = { documentId: string; versionId: string; originalSha256: string; label: string; anchor: string; quote?: string; limitation?: string };
export type ReviewRow = { key: string; title: string; status: 'present'|'partial'|'not_found'|'unassessed'; finding: string; sources: ReviewSource[] };
type Review = { id: string; createdAt: Date; rows: ReviewRow[]; draftText: string };

function difference<T>(left: T[], right: T[], identity: (item: T) => string) {
  const counts = new Map<string, number>();
  for (const item of right) { const key = identity(item); counts.set(key,(counts.get(key) ?? 0) + 1); }
  return left.filter(item => {
    const key = identity(item), count = counts.get(key) ?? 0;
    if (!count) return true;
    counts.set(key,count-1);
    return false;
  });
}

export function preliminaryChanges(review: Review, baseline?: Review) {
  const previousByKey = new Map(baseline?.rows.map(row => [row.key,row]));
  const rows = review.rows.map(row => {
    const previous = previousByKey.get(row.key);
    const addedSources = previous ? difference(row.sources,previous.sources,canonicalJson) : [];
    const removedSources = previous ? difference(previous.sources,row.sources,canonicalJson) : [];
    const changed = Boolean(previous && (row.status !== previous.status || row.finding !== previous.finding || addedSources.length || removedSources.length));
    return { key:row.key, changed, previousStatus:previous?.status ?? null, previousFinding:previous?.finding ?? null, addedSources, removedSources };
  });
  const lines = (text: string) => text.split(/\r?\n/);
  const current = lines(review.draftText), older = baseline ? lines(baseline.draftText) : [];
  const changed = Boolean(baseline && canonicalJson(current) !== canonicalJson(older));
  const added = changed ? difference(current,older,line => line) : [];
  const removed = changed ? difference(older,current,line => line) : [];
  // If paragraphs were only reordered, show the two orders as written.
  const reordered = changed && !added.length && !removed.length;
  return {baselineId:baseline?.id ?? null, baselineAt:baseline?.createdAt ?? null, rows,
    letter:{changed, added:reordered ? current : added, removed:reordered ? older : removed}};
}
