import { AccessError } from '../access/errors.js';
import { formats, layouts } from './content.js';
import type { Selection, TextRange, WordingReview } from './content.js';

export class LetterError extends AccessError {
  constructor(
    statusCode: number,
    code: string,
    message: string,
    details?: Record<string, unknown>,
  ) {
    super(statusCode, code, message, details);
  }
}

function invalid(message: string): never {
  throw new LetterError(422, 'invalid_letter_input', message);
}

function fields(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) invalid('Ожидается объект JSON.');
  const record = value as Record<string, unknown>;
  if (Object.keys(record).some((key) => !keys.includes(key))) invalid('Передано неизвестное поле.');
  return record;
}

export function identifier(value: unknown, field: string): string {
  if (typeof value !== 'string' || !/^[\da-f]{8}-(?:[\da-f]{4}-){3}[\da-f]{12}$/i.test(value)) {
    invalid(`Требуется идентификатор ${field}.`);
  }
  return value.toLowerCase();
}

function text(value: unknown, field: string, limit: number): string {
  // Text must round-trip through UTF-8, PostgreSQL text and WordprocessingML.
  if (typeof value !== 'string' || !value.trim() || value.length > limit || !value.isWellFormed()
    || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\ufffe\uffff]/u.test(value)) {
    invalid(`Недопустимое поле ${field}.`);
  }
  return value;
}

function recipient(value: unknown): string {
  const result = text(value, 'recipient', 300).trim();
  if (/[\r\n\t]/u.test(result)) invalid('Адресат указывается одной строкой.');
  return result;
}

function items<T>(value: unknown, parse: (item: unknown) => T, key: (item: T) => string): T[] {
  if (!Array.isArray(value) || value.length > 100) invalid('Ожидается массив до 100 пунктов.');
  const parsed = value.map(parse);
  if (new Set(parsed.map(key)).size !== parsed.length) invalid('Пункты повторяются.');
  return parsed;
}

function selection(input: Record<string, unknown>): Selection {
  const questionVersion = input.questionVersion;
  if (typeof questionVersion !== 'number' || !Number.isSafeInteger(questionVersion) || questionVersion < 1) {
    invalid('Требуется положительная версия вопроса.');
  }
  return {
    questionId: identifier(input.questionId, 'questionId'),
    questionVersion,
    decisionId: identifier(input.decisionId, 'decisionId'),
  };
}

function select(value: unknown) {
  return items(value, (item) => selection(fields(item, ['questionId', 'questionVersion', 'decisionId'])),
    (item) => item.questionId);
}

function choice<T extends string>(value: unknown, allowed: readonly T[]): T {
  const chosen = allowed.find((item) => item === value);
  if (!chosen) invalid('Передано недопустимое значение.');
  return chosen;
}

function time(value: unknown, field: string): string {
  const iso = text(value, field, 40);
  const parts = /^(\d{4}-\d\d-\d\d)T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d{1,3})?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/u.exec(iso);
  if (!parts) invalid(`Требуется время ${field} с часовым поясом.`);
  const day = new Date(`${parts[1]}T00:00:00.000Z`);
  const time = new Date(iso);
  if (!Number.isFinite(time.valueOf()) || !Number.isFinite(day.valueOf())
    || day.toISOString().slice(0, 10) !== parts[1] || parts[1].startsWith('0000')) {
    invalid(`Недопустимое время ${field}.`);
  }
  return time.toISOString();
}

export function assessmentTarget(input: Record<string, unknown>) {
  if ((input.scopeId === undefined) === (input.assessmentContextId === undefined)) {
    invalid('Укажите область или контекст оценки.');
  }
  return input.scopeId !== undefined ? { scopeId: identifier(input.scopeId, 'scopeId') } :
    { assessmentContextId: identifier(input.assessmentContextId, 'assessmentContextId') };
}

export function parseCreate(value: unknown) {
  const input = fields(value, ['scopeId', 'assessmentContextId', 'recipient', 'items']);
  return {
    ...assessmentTarget(input),
    recipient: recipient(input.recipient),
    items: select(input.items),
  };
}

export function parsePatch(value: unknown) {
  const input = fields(value, ['recipient', 'layout', 'items']);
  if (!Object.keys(input).length) invalid('Укажите правку редакции.');
  return {
    recipient: input.recipient === undefined ? undefined : recipient(input.recipient),
    layout: input.layout === undefined ? undefined : choice(input.layout, layouts),
    items: input.items === undefined ? [] : items(input.items, (value) => {
      const item = fields(value, ['questionId', 'wording']);
      return {
        questionId: identifier(item.questionId, 'questionId'),
        wording: item.wording === null ? null : text(item.wording, 'wording', 4000).replace(/\r\n?/gu, '\n'),
      };
    }, (item) => item.questionId),
  };
}

function range(value: unknown): TextRange {
  const { start, end } = fields(value, ['start', 'end']);
  if (typeof start !== 'number' || typeof end !== 'number' || !Number.isSafeInteger(start)
    || !Number.isSafeInteger(end) || start < 0 || start >= end || end > 4000) {
    invalid('Укажите границы проверенного фрагмента текста.');
  }
  return { start, end };
}

function wordingReview(value: unknown): WordingReview {
  const input = fields(value, ['wordingSha256', 'scope', 'subject', 'action', 'citations']);
  const wordingSha256 = input.wordingSha256;
  if (typeof wordingSha256 !== 'string' || !/^[a-f0-9]{64}$/u.test(wordingSha256)) {
    invalid('Укажите SHA-256 проверенной формулировки.');
  }
  const citations = items(input.citations, (value) => {
    const citation = fields(value, ['observationId', 'reference', 'value']);
    return {
      observationId: identifier(citation.observationId, 'observationId'),
      reference: range(citation.reference),
      value: citation.value === undefined ? undefined : range(citation.value),
    };
  }, (citation) => citation.observationId);
  return { wordingSha256, scope: range(input.scope), subject: range(input.subject), action: range(input.action), citations };
}

export function parseConfirm(value: unknown) {
  return { items: items(fields(value, ['items']).items, (value) => {
    const item = fields(value, ['questionId', 'questionVersion', 'decisionId', 'review']);
    return {
      ...selection(item),
      review: item.review === undefined ? undefined : wordingReview(item.review),
    };
  }, (item) => item.questionId) };
}

export function parseExport(value: unknown) {
  return { format: choice(fields(value, ['format']).format, formats) };
}

export function parseSent(value: unknown) {
  const input = fields(value, ['revisionId', 'itemIds', 'recipient', 'text', 'sentAt']);
  const itemIds = items(input.itemIds, (id) => identifier(id, 'itemId'), (id) => id);
  if (!itemIds.length) invalid('Укажите отправленные пункты.');
  return {
    revisionId: identifier(input.revisionId, 'revisionId'),
    itemIds,
    recipient: recipient(input.recipient),
    text: text(input.text, 'text', 500_000),
    sentAt: time(input.sentAt, 'sentAt'),
  };
}

export function parseResponse(value: unknown) {
  const input = fields(value, ['sentId', 'itemId', 'kind', 'text', 'receivedAt']);
  return {
    sentId: identifier(input.sentId, 'sentId'),
    itemId: identifier(input.itemId, 'itemId'),
    kind: choice(input.kind, ['response', 'refusal'] as const),
    text: text(input.text, 'text', 50_000),
    receivedAt: time(input.receivedAt, 'receivedAt'),
  };
}

export function parsePage(value: unknown) {
  const input = fields(value, ['limit', 'cursor']);
  const limit = Number(input.limit ?? 30);
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) invalid('Допустимый limit от 1 до 100.');
  return { limit, cursor: input.cursor === undefined ? null : identifier(input.cursor, 'cursor') };
}

export function expectedVersion(header: string | string[] | undefined): number {
  if (header === undefined) throw new LetterError(428, 'if_match_required', 'Укажите If-Match редакции.');
  const match = typeof header === 'string' && /^"([1-9]\d*)"$/u.exec(header);
  const version = match ? Number(match[1]) : NaN;
  if (!Number.isSafeInteger(version)) invalid('Требуется сильный ETag редакции.');
  return version;
}
