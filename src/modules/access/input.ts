import { invalid } from './errors.js';

export function object(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw invalid();
  return value as Record<string, unknown>;
}

export function text(value: unknown, label: string, max = 200): string {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > max || value.includes('\0')) {
    throw invalid('invalid_field', `Проверьте поле ${label}.`);
  }
  return value.trim();
}

export function optionalFlag(value: unknown): boolean | undefined {
  if (value === undefined || typeof value === 'boolean') return value;
  throw invalid();
}

function list(value: unknown, label: string, minimum = 0): string[] {
  if (!Array.isArray(value) || value.length < minimum || value.length > 30) throw invalid();
  return [...new Set(value.map((entry) => text(entry, label)))];
}

export interface CatalogRequirement {
  key: string;
  part: string;
  formats: string[];
  equivalents: string[];
  applicability: string;
  level?: 'facade' | 'common';
  sourceRoles: string[];
  completenessCriterion: string;
  addressee: string;
}

export function requirements(value: unknown): CatalogRequirement[] {
  if (!Array.isArray(value) || value.length > 500) throw invalid('invalid_requirements');
  const keys = new Set<string>();
  return value.map((entry) => {
    const row = object(entry);
    const key = text(row.key, 'key', 100);
    if (keys.has(key)) throw invalid('duplicate_requirement');
    const { level } = row;
    if (level !== undefined && level !== 'facade' && level !== 'common') throw invalid('invalid_requirement_level');
    keys.add(key);
    return {
      key,
      part: text(row.part, 'part'),
      formats: list(row.formats, 'formats', 1),
      equivalents: list(row.equivalents, 'equivalents'),
      applicability: text(row.applicability, 'applicability', 2000),
      ...(level === undefined ? {} : { level }),
      sourceRoles: list(row.sourceRoles, 'sourceRoles', 1),
      completenessCriterion: text(row.completenessCriterion, 'completenessCriterion', 2000),
      addressee: text(row.addressee, 'addressee'),
    };
  });
}
