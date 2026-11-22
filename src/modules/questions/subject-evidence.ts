import type { Observation, ReaderLine } from "../pdf/types.js";
import { escapeRegex, normalize } from "./domain.js";

type AssignedSubject = { subject: string; property: string };
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
  observation: Pick<Observation, "quote" | "value" | "unit" | "lineId" | "grounding">,
  lines: readonly ReaderLine[],
): boolean {
  if (observation.grounding !== "text" || !observation.lineId) return false;
  const valueLine = lines.find(({ id }) => id === observation.lineId);
  if (!valueLine || !observation.quote || !valueLine.text.includes(observation.quote)) return false;
  const required = [...new Set(words(`${target.subject} ${target.property}`))];
  if (!required.length) return false;
  const label = measureLabel(valueLine.text, observation);
  if (label === undefined) return false;
  if (containsWords(label, required)) return true;

  const identifiers = required.filter((word) => /\p{L}/u.test(word) && /\p{N}/u.test(word));
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
