import { SupplementError } from './errors.js';

const uuidPattern = /^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const maxCursor = 9_223_372_036_854_775_807n;

export function identifier(value: unknown): string {
  if (typeof value !== 'string' || !uuidPattern.test(value)) {
    throw new SupplementError(422, 'invalid_id', 'Передайте действительный идентификатор.');
  }
  return value.toLowerCase();
}

export function optionalIdentifier(value: unknown): string | undefined {
  return value === undefined ? undefined : identifier(value);
}

export function objectInput(value: unknown, fields: string[]): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some((key) => !fields.includes(key))) {
    throw new SupplementError(422, 'invalid_input', 'Проверьте поля запроса.');
  }
  return value as Record<string, unknown>;
}

export function identifiers(value: unknown, min: number, max: number): string[] {
  if (!Array.isArray(value) || value.length < min || value.length > max) {
    throw new SupplementError(422, 'invalid_ids', 'Проверьте список идентификаторов.');
  }
  const ids = value.map(identifier);
  if (new Set(ids).size !== ids.length) {
    throw new SupplementError(422, 'invalid_ids', 'Идентификаторы в списке должны быть уникальны.');
  }
  return ids.sort();
}

export function expectedGeneration(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) {
    throw new SupplementError(422, 'generation_required', 'Передайте поколение причины удержания.');
  }
  return value;
}

export function eventCursor(value: unknown): string {
  if (value === undefined) return '0';
  if (typeof value !== 'string' || !/^(0|[1-9][0-9]{0,18})$/.test(value) || BigInt(value) > maxCursor) {
    throw new SupplementError(422, 'invalid_cursor', 'Проверьте курсор событий проекта.');
  }
  return value;
}

export function pageLimit(value: unknown): number {
  if (value === undefined) return 100;
  if (typeof value !== 'string' || !/^[1-9][0-9]{0,2}$/.test(value) || Number(value) > 100) {
    throw new SupplementError(422, 'invalid_limit', 'Размер страницы должен быть от 1 до 100.');
  }
  return Number(value);
}
