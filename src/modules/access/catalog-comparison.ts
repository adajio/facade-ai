import type { CatalogComparisonRule, ValueRole } from "./input.js";

type Source = { sourceRole: string; valueRole?: ValueRole };

export function comparisonSource(comparison: CatalogComparisonRule | undefined, source: Source) {
  return comparison?.sources.find((rule) =>
    rule.sourceRole === source.sourceRole && rule.valueRole === source.valueRole);
}

export function allowsCatalogPair(comparison: CatalogComparisonRule | undefined, left: Source, right: Source): boolean {
  if (!comparison) return left.sourceRole === right.sourceRole && left.valueRole === right.valueRole;
  const a = comparisonSource(comparison, left);
  const b = comparisonSource(comparison, right);
  return Boolean(a && b && a.valueRole === b.valueRole && a.priority === b.priority);
}
