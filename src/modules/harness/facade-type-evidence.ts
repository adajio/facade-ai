import type { ReaderLine } from '../pdf/types.js';

const typeField = /^(?:тип фасада|facade (?:kind|type))\s*[:=№–—]\s*([\p{L}\p{N}][\p{L}\p{N} _-]{0,99})\s*$/iu;
const negative = /^(?:not\b|no\b|none\b|n[- ]?a\b|unknown\b|unspecified\b|undetermined\b|absent\b|не\s|нет(?:\s|$)|отсутству|неприменим|неопредел|без\s)|\s(?:not (?:confirmed|specified|verified|applicable)|не (?:подтвержд[её]н|указан|проверен))$/iu;

export function affirmedFacadeKind(quote: string) {
  const values = new Set(quote.split(/[|·;,\n]/u).flatMap((clause) => typeField.exec(clause.trim())?.[1]?.trim() ?? []));
  const kind = values.size === 1 ? values.values().next().value : undefined;
  return kind && !negative.test(kind) ? kind : undefined;
}

export function adjacentFacadeTypeHeader(lines: ReaderLine[], anchorId: string, headerId: string, quote: string) {
  const anchorIndex = lines.findIndex(({ id }) => id === anchorId);
  const anchor = lines[anchorIndex];
  const header = lines[anchorIndex - 1];
  if (!anchor || !header || header.id !== headerId || lines.filter(({ id }) => id === anchorId || id === headerId).length !== 2 ||
    !typeField.test(anchor.text.trim()) || !anchor.text.includes(quote) || !affirmedFacadeKind(quote) ||
    affirmedFacadeKind(anchor.text) !== affirmedFacadeKind(quote)) return;
  const sameRow = typeof anchor.locator?.row === 'number' && anchor.locator.row === header.locator?.row &&
    ['sheet', 'sheetId', 'table'].some((key) => anchor.locator?.[key] !== undefined) &&
    ['sheet', 'sheetId', 'table', 'section'].every((key) => anchor.locator?.[key] === header.locator?.[key]) &&
    typeof header.locator?.column === 'number' && anchor.locator.column === header.locator.column + 1;
  const above = header.box, below = anchor.box;
  if (sameRow || above && below && above.height > 0 && below.height > 0 &&
    below.y >= above.y + above.height && below.y - (above.y + above.height) <= 3 * Math.max(above.height, below.height) &&
    Math.abs(below.x - above.x) <= Math.min(above.height, below.height)) return header;
}
