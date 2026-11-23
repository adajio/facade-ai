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

interface CatalogEvidenceOption {
  sourceRole: string;
  mode?: 'value' | 'presence';
  formats?: string[];
  subject?: string;
  representations?: ('native' | 'ocr' | 'render')[];
}

export interface CatalogEvidenceRule {
  allOf: { anyOf: CatalogEvidenceOption[] }[];
  distinctOriginals?: boolean;
}

function invalidEvidenceRule() {
  return invalid('invalid_evidence_rule', 'Проверьте группы доказательств, роли источников, форматы и способы чтения.');
}

function ruleObject(value: unknown, keys: string[]) {
  const row = object(value);
  if (Object.keys(row).some((key) => !keys.includes(key))) throw invalidEvidenceRule();
  return row;
}

function ruleList(value: unknown): unknown[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 16) throw invalidEvidenceRule();
  return value;
}

function evidenceRule(value: unknown, roles: string[], allowedFormats: string[]): CatalogEvidenceRule {
  const rule = ruleObject(value, ['allOf', 'distinctOriginals']);
  const distinctOriginals = optionalFlag(rule.distinctOriginals);
  const allOf = ruleList(rule.allOf).map((group) => ({
    anyOf: ruleList(ruleObject(group, ['anyOf']).anyOf).map((item): CatalogEvidenceOption => {
      const option = ruleObject(item, ['sourceRole', 'mode', 'formats', 'subject', 'representations']);
      const sourceRole = text(option.sourceRole, 'sourceRole');
      const { mode } = option;
      if (mode !== undefined && mode !== 'value' && mode !== 'presence') throw invalidEvidenceRule();
      const formats = option.formats === undefined ? undefined : list(option.formats, 'formats', 1);
      if (!roles.includes(sourceRole) || formats?.some((format) => !allowedFormats.includes(format))) {
        throw invalidEvidenceRule();
      }
      const representations = option.representations === undefined ? undefined :
        list(option.representations, 'representations', 1).map((entry) => {
          if (entry !== 'native' && entry !== 'ocr' && entry !== 'render') throw invalidEvidenceRule();
          return entry;
        });
      return {
        sourceRole,
        ...(mode === undefined ? {} : { mode }),
        ...(formats === undefined ? {} : { formats }),
        ...(option.subject === undefined ? {} : { subject: text(option.subject, 'subject') }),
        ...(representations === undefined ? {} : { representations }),
      };
    }),
  }));
  return { allOf, ...(distinctOriginals === undefined ? {} : { distinctOriginals }) };
}

export interface CatalogRequirement {
  key: string;
  part: string;
  aliases?: string[];
  formats: string[];
  equivalents: string[];
  applicability: string;
  level?: 'facade' | 'common';
  sourceRoles: string[];
  completenessCriterion: string;
  evidenceRule?: CatalogEvidenceRule;
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
    const formats = list(row.formats, 'formats', 1);
    const equivalents = list(row.equivalents, 'equivalents');
    const sourceRoles = list(row.sourceRoles, 'sourceRoles', 1);
    return {
      key,
      part: text(row.part, 'part'),
      ...(row.aliases === undefined ? {} : { aliases: list(row.aliases, 'aliases') }),
      formats,
      equivalents,
      applicability: text(row.applicability, 'applicability', 2000),
      ...(level === undefined ? {} : { level }),
      sourceRoles,
      completenessCriterion: text(row.completenessCriterion, 'completenessCriterion', 2000),
      ...(row.evidenceRule === undefined ? {} : {
        evidenceRule: evidenceRule(row.evidenceRule, sourceRoles, [...formats, ...equivalents]),
      }),
      addressee: text(row.addressee, 'addressee'),
    };
  });
}
