import { pairProofVersion, type VerifiedPairEvidence } from '../assessment/domain.js';
import type { ReaderLine } from '../pdf/types.js';
import type { Branch } from './contracts.js';

export type PairQuote = { support: Branch; evidenceId: string; quote: string; line: string };
type Supports = Record<Branch, string[]>;
type PairFailure = { code: string; nextAction: string };

const variant = /(?<![\p{L}\p{N}_-])(?:variant|execution|исполнени[ея]|вариант)(?:\s*[:№=]\s*|\s+)([\p{L}\p{N}]+(?:[-_.][\p{L}\p{N}]+)*)(?![\p{L}\p{N}_-])/giu;
const revision = /(?<![\p{L}\p{N}_-])(?:revision|rev\.?|редакция|ревизия|ред\.?)(?:\s*[:№=]\s*|\s+)([\p{L}\p{N}]+(?:[-_.][\p{L}\p{N}]+)*)(?![\p{L}\p{N}_-])/giu;
const scope = /(?:^|[|·;])\s*(?:scope|zone|area|область|участок|зона)\s*[:№=]\s*([^|·;]+)/giu;
const ineffective = /(?<![\p{L}\p{N}])(?:superseded|withdrawn|obsolete|archived|draft|not[ -]+current|не\s+действует|недействующая|замен[её]н[а-яё]*|отмен[её]н[а-яё]*|архивн[а-яё]*|черновик)(?![\p{L}\p{N}])/iu;
const currentPrefix = /(?<![\p{L}\p{N}])(?:current|effective|действующая|актуальная)\s*$/iu;
const currentSuffix = /^(?:\s|[:=,(-])+(?:(?:is|является)\s+)?(?:current|effective|действующая|актуальная)(?![\p{L}\p{N}])/iu;
const code = /^(?:[\p{L}]{1,3}|(?=[\p{L}\p{N}_.-]*\d)[\p{L}\p{N}_.-]{1,24})$/u;
const branches = ['A', 'B'] as const;
const normalized = (value: string) => value.normalize('NFKC').trim().toLowerCase().replace(/\s+/gu, ' ');

function fields(line: string, pattern: RegExp) {
  return [...line.matchAll(pattern)].map((match) => ({ value: normalized(match[1]), match }))
    .filter(({ value }) => code.test(value));
}

function values(lines: string[], field: RegExp) {
  return new Set(lines.flatMap((line) => fields(line, field).map(({ value }) => value)));
}

function scopes(line: string) {
  return [...line.matchAll(scope)].map((match) => normalized(match[1].replace(/[.:]+$/u, '')));
}

export function locatePairQuote(lines: ReaderLine[], quote: string, lineId?: string) {
  return lines.filter(({ id, text }) => (lineId === undefined || lineId === id) && text.includes(quote));
}

export function printedPairVariant(line: string): string | null {
  const marks = values([line], variant);
  return marks.size === 1 ? marks.values().next().value! : null;
}

export function hasPrintedPairScope(line: string, label: string): boolean {
  const labels = scopes(line);
  return labels.length > 0 && labels.every((item) => item === normalized(label));
}

export function currentRevision(line: string, label: string): boolean {
  if (ineffective.test(line)) return false;
  return fields(line, revision).some(({ value, match }) => value === label &&
    (currentPrefix.test(line.slice(0, match.index)) || currentSuffix.test(line.slice(match.index + match[0].length))));
}

function oneValue(quotes: PairQuote[], anchors: string[], field: RegExp): string | undefined {
  const quoted = values(quotes.map(({ quote }) => quote), field);
  if (quoted.size !== 1) return;
  const visible = values([...anchors, ...quotes.map(({ line }) => line)], field);
  const value = quoted.values().next().value!;
  if (visible.size === 1 && visible.has(value)) return value;
}

export function pairSourceEvidence(input: {
  variants: PairQuote[]; revisions: PairQuote[]; applicability: PairQuote[];
  anchors: Supports; scopeName: string; assignedVariant?: string;
  confirmVariant: boolean; confirmRevision: boolean; confirmApplicability: boolean; scopeAcrossVersion?: boolean;
}): { proof?: VerifiedPairEvidence } | { failure: PairFailure } {
  const { anchors, scopeName, confirmVariant, confirmRevision, confirmApplicability } = input;
  function fail(code: string, nextAction: string) { return { failure: { code, nextAction } }; }
  const expectedScope = normalized(scopeName);
  if (confirmApplicability && [
    ...anchors.A, ...anchors.B, ...[...input.variants, ...input.revisions, ...input.applicability].map(({ line }) => line),
  ].some((line) => scopes(line).some((printed) => printed !== expectedScope))) {
    return fail('pair_scope_conflict', 'Опора указывает другую область. Проверьте применимость или укажите несовместимость.');
  }
  const marks = (quotes: PairQuote[], field: RegExp) => branches.map((side) =>
    oneValue(quotes.filter(({ support }) => support === side), anchors[side], field));
  const [variantA, variantB] = confirmVariant ? marks(input.variants, variant) : [];
  if (confirmVariant && (!variantA || !variantB)) {
    return fail('pair_variant_not_addressed', 'Для каждой опоры процитируйте однозначное обозначение исполнения. Если его нельзя установить, укажите unclear.');
  }
  if (confirmVariant && (variantA !== variantB || (input.assignedVariant && variantA !== normalized(input.assignedVariant)))) {
    return fail('pair_variant_conflict', 'В опорах обозначены разные исполнения либо исполнение отличается от назначенного. Укажите несовместимость или оставьте вопрос открытым.');
  }
  const [revisionA, revisionB] = confirmRevision ? marks(input.revisions, revision) : [];
  if (confirmRevision && (!revisionA || !revisionB)) {
    return fail('pair_revision_not_addressed', 'Для каждой опоры процитируйте однозначное обозначение редакции. Если редакцию нельзя подтвердить, укажите unclear.');
  }
  if (confirmRevision && [...anchors.A, ...anchors.B, ...input.revisions.map(({ line }) => line)]
    .some((line) => fields(line, revision).length > 0 && ineffective.test(line))) {
    return fail('pair_revision_inactive', 'Одна из цитат помечает редакцию как недействующую. Проверьте актуальную опору или укажите unclear.');
  }
  const effectiveForScope = (side: Branch, label: string) => input.revisions.some(({ support, evidenceId, quote }) => {
    if (support !== side || !currentRevision(quote, label)) return false;
    return scopes(quote).includes(expectedScope) || input.applicability.some((addressed) =>
      addressed.support === side && (input.scopeAcrossVersion || addressed.evidenceId === evidenceId) && scopes(addressed.quote).includes(expectedScope));
  });
  if (revisionA && revisionB && revisionA !== revisionB &&
    (!effectiveForScope('A', revisionA) || !effectiveForScope('B', revisionB))) {
    return fail('pair_revision_applicability_unproven',
      'Для разных редакций процитируйте, где каждая прямо обозначена как действующая для назначенной области. Если таких сведений нет, укажите unclear.');
  }
  if (variantA && revisionA && revisionB && confirmApplicability) {
    return { proof: { version: pairProofVersion, variant: variantA, revisionA, revisionB, scope: expectedScope } };
  }
  return {};
}
