import type { Observation, ReaderLine, ReaderObservationComponent } from "../pdf/types.js";
import { ifcLengthProperty, stepEntity } from "../formats/ifc-units.js";
import { escapeRegex, normalize } from "./domain.js";

type AssignedSubject = { subject: string; property: string; aliases?: readonly string[]; variant?: string; scopeName?: string };
type Measure = Pick<Observation, "value" | "unit">;

function words(text: string): string[] {
  return normalize(text).match(/[\p{L}\p{N}]+(?:[-‐‑−][\p{L}\p{N}]+)*/gu)?.map((word) =>
    word.replace(/[‐‑−]/gu, "-")) ?? [];
}

function containsWords(text: string, required: readonly string[]): boolean {
  const found = new Set(words(text));
  return required.every((word) => found.has(word));
}

function measureLabel(text: string, { value, unit }: Measure, requireUnit = false): string | undefined {
  if (!value) return;
  const boundary = "(?<![\\p{L}\\p{N}.,+-])";
  const end = "(?![\\p{L}\\p{N}]|[.,]\\d)";
  const measure = new RegExp(`${boundary}[+-]?\\d+(?:[,.]\\d+)?(?:\\s*${escapeRegex(unit ?? "")})?${end}`, "gu");
  const literal = new RegExp(`^${escapeRegex(value.trim())}(?:\\s*${escapeRegex(unit ?? "")})${requireUnit ? "" : "?"}$`, "u");
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
  const valueLine = lines.find(({ id }) => id === observation.lineId);
  if (observation.components?.length) return hasCompoundSubject(target, observation, lines);
  if (!valueLine || !observation.quote || !valueLine.text.includes(observation.quote)) return false;
  if (!matchesPrintedScope(target.scopeName, [valueLine.text])) return false;
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

function matchesPrintedScope(scopeName: string | undefined, sources: readonly string[]): boolean {
  if (!scopeName) return true;
  const pattern = /(?:^|[|·;\n])\s*(?:участок|область|зона|scope|zone)(?:\s*[:№]\s*|\s+)([^|·;\n]+)/giu;
  return sources.every((text) => Array.from(text.matchAll(pattern)).every((match) =>
    normalize(match[1].trim().replace(/[.:]+$/u, "")) === normalize(scopeName)));
}

const variantSuffix = /(?:исполнени[ея]|variant)\s*[:№]?\s*([a-zа-я]\d*)(?=$|[^\p{L}\p{N}])/iu;

function tableColumnHeading(lines: readonly ReaderLine[], line: ReaderLine): ReaderLine | undefined {
  const { row, column } = line.locator ?? {};
  if (typeof row !== "number" || typeof column !== "number") return;
  return lines.filter((other) => sameTable(other, line) && other.locator?.column === column &&
    typeof other.locator.row === "number" && other.locator.row < row &&
    !/^\s*[+-]?\d+(?:[.,]\d+)?(?:\s+[^\d\s]+)?\s*$/u.test(other.text))
    .sort((a, b) => Number(b.locator?.row) - Number(a.locator?.row))[0];
}

function hasAssignedVariant(
  variant: string, local: readonly ReaderObservationComponent[], value: ReaderObservationComponent,
  lines: readonly ReaderLine[], label: string,
): boolean {
  const named = local.find((part) => part.role === "variant");
  if (named && normalize(named.literal) !== variant) return false;
  if (named?.binding?.kind === "variant_field") return true;
  const markedVariant = (text: string) => normalize(variantSuffix.exec(text)?.[1] ?? "") === variant;
  if (markedVariant(label)) return true;
  const namedPrefix = `[|/]\\s*${escapeRegex(variant)}\\s*(?=[|,';)]|$)`;
  if (new RegExp(namedPrefix, "iu").test(label)) return true;
  if (local.some((part) => part.role === "identifier" && part.link.kind === "ifc_reference" &&
      new RegExp(`${escapeRegex(part.literal)}/${escapeRegex(variant)}(?=['"|;,)]|$)`, "iu").test(part.quote))) return true;
  const own = named?.evidenceId === value.evidenceId && lines.find(({ id }) => id === named.lineId);
  if (!own || named.link.kind !== "same_row") return false;
  if (markedVariant(own.text)) return true;
  const heading = tableColumnHeading(lines, own);
  return Boolean(heading && /^(?:исполнение|вариант|variant)\s*[:№]?\s*$/iu.test(heading.text.trim()) &&
    normalize(own.text) === variant);
}

function hasCompoundSubject(
  target: AssignedSubject,
  observation: Pick<Observation, "value" | "unit" | "components">,
  lines: readonly ReaderLine[],
) {
  const [value] = observation.components ?? [];
  if (!value || value.role !== "value" || value.link.kind !== "anchor") return false;
  const local = observation.components!.filter((part) => part.source.versionId === value.source.versionId && part.source.sha256 === value.source.sha256);
  const anchor = lines.find(({ id }) => id === value.lineId);
  if (!anchor?.text.includes(value.quote)) return false;
  const archived = /(?:\b(?:change\s*log|(?:revision|reference|change)\s+history|previous\s+revision)\b|истори[яи]\s+(?:изменений|редакций)|предыдущая\s+редакция)/iu;
  if (archived.test(anchor.text) || (typeof anchor.locator?.section === "string" && archived.test(anchor.locator.section))) return false;
  const localText = (part: ReaderObservationComponent) => part.evidenceId === value.evidenceId
    ? lines.find(({ id }) => id === part.lineId)?.text ?? part.quote : part.quote;
  const identifiers = local.filter((part) => part.role === "identifier" && part.link.kind !== "column_header");
  if (!matchesPrintedScope(target.scopeName, [anchor.text, ...identifiers.map(localText)])) return false;

  const unit = local.find((part) => part.role === "unit");
  if (unit?.link.kind === "source_context" && !unit.binding && unit.lineId === value.lineId && observation.unit &&
      measureLabel(anchor.text, { ...observation, value: value.literal }, true) === undefined) return false;

  const entity = stepEntity(anchor.text);
  const primaryLabel = value.binding?.kind === "value_context" ? value.binding.text
    : ifcLengthProperty(entity) ? entity?.args[0] : measureLabel(anchor.text, { ...observation, value: value.literal });
  if (primaryLabel === undefined) return false;
  const fallbackHeader = local.find((part) => part.link.kind === "column_header");
  const heading = tableColumnHeading(lines, anchor)?.text ?? (fallbackHeader && localText(fallbackHeader));
  const preceding = identifiers.filter((part) => part.link.kind === "same_row" && part.lineId !== value.lineId &&
    (typeof anchor.locator?.column === "number" ? Number(part.address.locator?.column) < anchor.locator.column
      : !anchor.box || !part.address.box || part.address.box.x < anchor.box.x));
  const label = [primaryLabel, heading ?? preceding.map(localText).join(" ")].join(" ");
  const attributeWords = new Set(engineeringWords(label));
  const identityWords = new Set([...attributeWords, ...identifiers.flatMap((part) => engineeringWords(part.literal))]);
  const inlineCodes = new Set(engineeringWords(anchor.text).filter(isIdentifier));
  if (inlineCodes.size === 1) for (const code of inlineCodes) identityWords.add(code);
  const expected = `${target.subject} ${target.property}`;
  const variant = normalize(target.variant ?? variantSuffix.exec(expected)?.[1] ?? "");
  if (variant && !hasAssignedVariant(variant, local, value, lines, primaryLabel)) return false;
  const removeVariant = (name: string) => name.replace(new RegExp(variantSuffix.source, "giu"), "");
  const properties = new Set(engineeringWords(removeVariant(target.property)));
  const names = [expected, ...target.aliases ?? []];
  return names.some((name) => {
    const required = engineeringWords(removeVariant(name));
    const sheet = anchor.locator?.sheet;
    // A dimensions sheet qualifies a column already labelled as length.
    const dimensions = typeof sheet === "string" && engineeringWords(sheet).includes("габарит") && attributeWords.has("длина");
    return required.length > 0 && required.every((word) => isIdentifier(word) || (name === expected && !properties.has(word)) ? identityWords.has(word)
      : attributeWords.has(word) || (word === "габарит" && dimensions));
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
