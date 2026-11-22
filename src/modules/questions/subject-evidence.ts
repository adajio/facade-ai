import type { Observation, ReaderLine, ReaderObservationComponent } from "../pdf/types.js";
import { escapeRegex, normalize } from "./domain.js";

type AssignedSubject = { subject: string; property: string; aliases?: readonly string[]; variant?: string };
type Measure = Pick<Observation, "value" | "unit">;

function words(text: string): string[] {
  return normalize(text).match(/[\p{L}\p{N}]+(?:[-‐‑−][\p{L}\p{N}]+)*/gu)?.map((word) =>
    word.replace(/[‐‑−]/gu, "-")) ?? [];
}

function containsWords(text: string, required: readonly string[]): boolean {
  const found = new Set(words(text));
  return required.every((word) => found.has(word));
}

function measureLabel(text: string, { value, unit }: Measure): string | undefined {
  if (!value) return;
  const boundary = "(?<![\\p{L}\\p{N}.,+-])";
  const end = "(?![\\p{L}\\p{N}]|[.,]\\d)";
  const measure = new RegExp(`${boundary}[+-]?\\d+(?:[,.]\\d+)?(?:\\s*${escapeRegex(unit ?? "")})?${end}`, "gu");
  const literal = new RegExp(`^${escapeRegex(value.trim())}(?:\\s*${escapeRegex(unit ?? "")})?$`, "u");
  let previous = 0;
  const labels: string[] = [];
  for (const part of text.matchAll(measure)) {
    if (literal.test(part[0])) labels.push(text.slice(previous, part.index));
    previous = part.index + part[0].length;
  }
  return labels.length === 1 ? labels[0] : undefined;
}

function sameTable(a: ReaderLine, b: ReaderLine): boolean {
  return ["table", "sheet", "section"].every((key) => a.locator?.[key] === b.locator?.[key]);
}

function priorLabel(before: readonly ReaderLine[]): string {
  const boundary = before.findLastIndex(({ text }) => /^[+-]?\d+(?:[.,]\d+)?(?:\s+[^\d\s]+)?$/u.test(text.trim()));
  return before.slice(boundary + 1).map(({ text }) => text).join(" ");
}

/** Verify an assigned attribute against the addressed line, with only structural context from its delivered representation. */
export function hasAddressedSubject(
  target: AssignedSubject,
  observation: Pick<Observation, "quote" | "value" | "unit" | "lineId" | "grounding" | "components">,
  lines: readonly ReaderLine[],
): boolean {
  if (observation.grounding !== "text" || !observation.lineId) return false;
  if (observation.components?.length) return hasCompoundSubject(target, observation.components);
  const valueLine = lines.find(({ id }) => id === observation.lineId);
  if (!valueLine || !observation.quote || !valueLine.text.includes(observation.quote)) return false;
  const names = [`${target.subject} ${target.property}`, ...target.aliases ?? []];
  return names.some((name) => bindsAttribute([...new Set(words(name))], observation, valueLine, lines));
}

function engineeringWords(text: string): string[] {
  const named = text.replace(/\bAnchorSpacing\b/giu, "шаг креплений")
    .replace(/\bhinge\s+bracket\b/giu, "шарнирный кронштейн")
    .replace(/\bthickness\b/giu, "толщина");
  return words(named).map((word) => {
    if (/^габарит(?:ы|ная|ной|ное)?$/u.test(word)) return "габарит";
    if (/^шарнирн(?:ый|ого|ая)$/u.test(word)) return "шарнирный";
    if (/^кронштейн(?:а|ы)?$/u.test(word)) return "кронштейн";
    return word;
  });
}

function hasCompoundSubject(target: AssignedSubject, components: ReaderObservationComponent[]) {
  const [value] = components;
  if (!value || value.role !== "value" || value.link.kind !== "anchor") return false;
  const local = components.filter((part) => part.source.versionId === value.source.versionId && part.source.sha256 === value.source.sha256);
  const variantSuffix = /(?:исполнени[ея]|variant)\s*[:№]?\s*([a-zа-я]\d*)(?=$|[^\p{L}\p{N}])/iu;
  const names = [target.subject + " " + target.property, ...target.aliases ?? []];
  const variant = normalize(target.variant ?? variantSuffix.exec(names[0]!)?.[1] ?? "");
  if (variant) {
    const named = local.find((part) => part.role === "variant");
    const identifier = local.filter((part) => part.role === "identifier" || part.role === "value");
    const variantCode = escapeRegex(variant);
    const explicitVariant = new RegExp(`(?:исполнени[ея]|variant)\\s*[:№]?\\s*${variantCode}(?=$|[^\\p{L}\\p{N}])|[|/]\\s*${variantCode}\\s*(?=[|\\s,'";)]|$)`, "iu");
    if (named ? normalize(named.literal) !== variant : !identifier.some(({ quote }) => explicitVariant.test(quote))) return false;
  }
  const row = typeof value.address.locator?.row === "number";
  const headers = local.filter((part) => part.link.kind === "column_header");
  const usesHeading = row && headers.length > 0;
  const text = local.filter((part) => part.role !== "revision" && part.role !== "variant" &&
    (!usesHeading || part.role !== "unit" || part.link.kind === "column_header")).map(({ quote }) => quote);
  if (usesHeading && typeof value.address.locator?.sheet === "string") text.push(value.address.locator.sheet);
  const supported = new Set(engineeringWords(text.join(" ")));
  return names.some((name) => {
    const required = engineeringWords(name.replace(new RegExp(variantSuffix.source, "giu"), ""));
    return required.length > 0 && required.every((word) => supported.has(word));
  });
}

export function isAttributeAlias(target: AssignedSubject, alias: string, unit: string): boolean {
  const identifiers = words(`${target.subject} ${target.property}`).filter(isIdentifier);
  const excluded = new Set([...identifiers, ...words(unit), "mm", "мм", "cm", "см", "m", "м"]);
  const tokens = words(alias);
  return identifiers.every((identifier) => tokens.includes(identifier)) &&
    tokens.some((token) => !excluded.has(token) && !isIdentifier(token) && /\p{L}{2}/u.test(token));
}

function isIdentifier(word: string): boolean {
  return /\p{L}/u.test(word) && /\p{N}/u.test(word);
}

function bindsAttribute(required: string[], observation: Measure, valueLine: ReaderLine, lines: readonly ReaderLine[]): boolean {
  if (!required.length) return false;
  const label = measureLabel(valueLine.text, observation);
  if (label === undefined) return false;
  if (containsWords(label, required)) return true;

  const identifiers = required.filter(isIdentifier);
  const { row, column, line } = valueLine.locator ?? {};
  if (typeof row === "number" && typeof column === "number") {
    const table = lines.filter((candidate) => sameTable(candidate, valueLine));
    const context = table.filter(({ locator }) =>
      locator?.row === row && typeof locator.column === "number" && locator.column < column);
    const sorted = context.sort((a, b) => Number(a.locator?.column) - Number(b.locator?.column));
    const heading = table.filter(({ locator }) => locator?.column === column && locator.row === 1 && row > 1)
      .map(({ text }) => text).join(" ");
    const rowIdentifiers = sorted.flatMap(({ text }) => words(text).filter((word) => identifiers.includes(word)));
    return containsWords(`${rowIdentifiers.join(" ")} ${priorLabel(sorted)} ${heading} ${label}`, required);
  }
  if (valueLine.box) {
    const { x, y, height } = valueLine.box;
    const before = lines.filter(({ box }) => box && box.x < x &&
      Math.abs(box.y + box.height / 2 - y - height / 2) <= Math.min(box.height, height) / 2);
    return containsWords(`${priorLabel(before.sort((a, b) => a.box!.x - b.box!.x))} ${label}`, required);
  }
  if (typeof line !== "number") return false;
  const preceding = lines.find(({ locator }) => locator?.line === line - 1);
  const otherMeasurement = observation.unit
    ? new RegExp(`\\d(?:[,.]\\d+)?\\s*${escapeRegex(observation.unit)}(?![\\p{L}\\p{N}])`, "iu")
    : /\d/u;
  // A sentence naming the attribute can qualify the next addressed line only when both name the same item.
  return Boolean(preceding && identifiers.length && containsWords(label, identifiers) &&
    containsWords(preceding.text, required) && !otherMeasurement.test(preceding.text));
}
