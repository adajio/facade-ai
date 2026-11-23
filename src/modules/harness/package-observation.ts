import type { PoolClient } from 'pg';
import { z } from 'zod';
import { hash } from '../gateway/types.js';
import { deliveredLines } from '../questions/attribute-aliases.js';
import type { Observation } from '../pdf/types.js';
import { type ObservationInput, type ReaderContext } from './contracts.js';
import { packageRoles, type PackageBinding, type PackageSourceRole } from './package-analysis.js';

const literal = z.string().trim().min(1).max(500).refine((value) => !value.includes('\0'));
const label = z.string().trim().min(1).max(160).refine((value) => !value.includes('\0'));
const bindingFields = { state: z.enum(['identified', 'common', 'unclear', 'unidentified']), reason: literal };
export const packageBindingEdit = z.strictObject({ ...bindingFields, candidateIds: z.array(z.string().uuid()).max(24) });
const sourceField = z.strictObject({ value: literal, quote: literal });

export const packageDetails = z.strictObject({
  attribute: literal.optional(),
  role: z.strictObject({ value: z.enum(packageRoles), quote: literal }).optional(),
  stage: sourceField.optional(),
  revision: sourceField.extend({ status: z.enum(['current', 'superseded', 'unknown']) }).optional(),
  binding: z.strictObject({ ...bindingFields, labels: z.array(label).max(24), quote: literal.optional(),
    projectIdentifiers: z.array(z.strictObject({ label, quote: literal })).max(24).optional(),
    projectContext: z.strictObject({ building: sourceField, axes: sourceField }).optional() }).optional(),
  materials: z.array(z.strictObject({ label, quote: literal })).max(24).optional(),
  subjectRegister: z.strictObject({ labels: z.array(label).min(1).max(24), quote: literal,
    commonQuote: literal.optional() }).optional(),
});

export type PackageDetails = z.infer<typeof packageDetails>;

export function packageNonDeliveryGrounded(input: Omit<ObservationInput, 'evidence'>, image: boolean, fullLine?: string) {
  if (input.deliveryStatement?.status !== 'not_delivered') return true;
  const role = input.package?.role;
  return !image && Boolean(input.quote && directlyNotDelivered(input.quote, input.deliveryStatement.item) &&
    role?.value === 'inventory' && input.quote.includes(role.quote) && roleWords.inventory!.test(role.quote) &&
    (!fullLine || !directlyDelivered(fullLine, input.deliveryStatement.item)));
}

const common = /(?:\b(?:(?:applies to|for) all facades?|common materials?|entire building)\b|для\s+все[хм]?\s+фасад|общ(?:ие|ий|ая|его)\s+(?:материал|раздел|требован)|для\s+здания\s+в\s+целом)/iu;
const exclusion = /(?:\b(?:except|excluding|only|not|other than)\b|(?<!\p{L})(?:кроме|исключая|только|не)(?!\p{L}))/iu;
const commonRegister = /(?:\b(?:no common materials|all common materials (?:are )?(?:listed|included|checked))\b|общи\p{L}*\s+материал\p{L}*\s+(?:перечислен\p{L}*|проверен\p{L}*)\s+полностью|общи\p{L}*\s+материал\p{L}*\s+нет)/iu;

export function packageCommonGrounded(quote: string) {
  return common.test(quote) && !exclusion.test(quote);
}
const entireRegister = /(?:\b(?:complete|full|exhaustive)\s+(?:list|schedule|register)\s+of\s+facades?\b|(?:полн\p{L}*|исчерпывающ\p{L}*)\s+(?:перечень|список|ведомость)\s+фасад)/iu;
const absent = /(?:\b(?:not (?:supplied|provided|delivered|included|sent)|omitted|was not transmitted)\b|не\s+(?:(?:передан|предоставлен|поставлен|направлен|приложен)(?:а|о|ы)?(?!\p{L})|вош[её]л(?!\p{L}))|отсутствует\s+в\s+(?:составе|комплекте))/iu;
const delivered = /(?:\b(?:supplied|provided|delivered|included|sent|transmitted|received)\b|(?:передан|предоставлен|поставлен|направлен|приложен|получен|принят)(?:а|о|ы)?(?!\p{L}))/iu;
const statementSeparator = /[|;·,]+|\s+(?:and|but|whereas|or|и|но|а|однако|либо|или)\s+/iu;

function directlyNotDelivered(quote: string, item: string) {
  return statementAbout(quote, item, absent);
}

function directlyDelivered(quote: string, item: string) {
  return statementAbout(quote, item, delivered, absent, true);
}

function statementAbout(quote: string, item: string, expression: RegExp, excluding?: RegExp, allowOmittedSubject = false) {
  const adjacent = /^[\s:—–-]*(?:(?:is|was|бы(?:л|ла|ло|ли))\s+)?[\s:—–-]*$/iu;
  const name = item.toLocaleLowerCase('ru');
  return quote.split(statementSeparator).some((clause) => {
    const predicate = expression.exec(clause);
    if (!predicate || excluding?.test(clause)) return false;
    const before = clause.slice(0, predicate.index).toLocaleLowerCase('ru');
    const after = clause.slice(predicate.index + predicate[0].length).toLocaleLowerCase('ru');
    const beforeIndex = before.lastIndexOf(name);
    const afterIndex = after.indexOf(name);
    if (allowOmittedSubject && adjacent.test(before) && /^[\s.!?—–-]*$/u.test(after)) return true;
    return (beforeIndex !== -1 && hasLiteral(before, name) && adjacent.test(before.slice(beforeIndex + name.length))) ||
      (afterIndex !== -1 && hasLiteral(after, name) && adjacent.test(after.slice(0, afterIndex)));
  });
}
const current = /(?:\b(?:current|effective)\b|действующ\p{L}*|актуальн\p{L}*)/iu;
const inactive = /(?:\b(?:superseded|obsolete|withdrawn|draft|not[ -]+current)\b|замен[её]н\p{L}*|архивн\p{L}*|не\s+действующ\p{L}*|недействующ\p{L}*|неактуальн\p{L}*|отмен[её]н\p{L}*|черновик)/iu;
const roleWords: Partial<Record<PackageSourceRole, RegExp>> = {
  drawing: /drawing|черт[её]ж|схема/iu, detail: /detail|узел|деталь/iu, schedule: /schedule|ведомость|таблица/iu,
  specification: /specification|спецификация/iu, calculation: /calculation|расч[её]т/iu,
  inventory: /inventory|transmittal|опись|сопроводительн\p{L}*\s+письмо/iu,
  correspondence: /correspondence|letter|переписка|письмо/iu, model: /model|модель/iu,
  other: /commercial offer|quotation|reference material|коммерческ\p{L}*\s+предложен|справочн\p{L}*\s+материал/iu,
};
const normalized = (value: string) => value.normalize('NFC').trim();
function hasLiteral(quote: string, value: string) {
  const escaped = value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(?<![\\p{L}\\p{N}_])${escaped}(?![\\p{L}\\p{N}_])`, 'u').test(quote);
}

export function packageCandidateId(observation: Observation, name: string, projectIdentity?: string) {
  // The same addressed label can appear independently in both branches. A label elsewhere stays a separate candidate.
  const reference = projectIdentity
    ? [observation.source.projectId, projectIdentity, normalized(name)]
    : [observation.source.versionId, observation.address.unitId, observation.lineId ?? observation.address.box ?? null, normalized(name)];
  const digest = hash(reference);
  return [digest.slice(0, 8), digest.slice(8, 12), '8' + digest.slice(13, 16),
    'a' + digest.slice(17, 20), digest.slice(20, 32)].join('-');
}

function projectIdentifier(quote: string, name: string) {
  const printed = /(?:project facade (?:identifier|id)|идентификатор фасада проекта|код фасада проекта)\s*[:=№]\s*([^|;·,]+)/iu.exec(quote);
  return printed && normalized(printed[1]) === name;
}

function contextIdentity(ctx: NonNullable<PackageDetails['binding']>['projectContext'], quote: string | null) {
  if (!ctx || !quote) return;
  const { building, axes } = ctx;
  const printedBuilding = /(?:building|block|корпус|здани[ея]|секция)\s*[:№=]\s*([^|;·,]+)/iu.exec(building.quote);
  const printedAxes = /(?:axes|grid|оси|осях)\s*[:№=]\s*([^|;·,]+)/iu.exec(axes.quote);
  if (!quote.includes(building.quote) || !quote.includes(axes.quote) ||
    !printedBuilding || normalized(printedBuilding[1]) !== normalized(building.value) ||
    !printedAxes || normalized(printedAxes[1]) !== normalized(axes.value)) return;
  return JSON.stringify(['building-axes', normalized(building.value), normalized(axes.value)]);
}

function bindingFor(observation: Observation, details: PackageDetails, fullLine?: string): PackageBinding {
  const proposal = details.binding;
  const quote = proposal?.quote && observation.quote?.includes(proposal.quote) ? proposal.quote : null;
  const labels = [...new Set(proposal?.labels.map(normalized))];
  const candidates = labels.filter((name) => quote && hasLiteral(quote, name))
    .map((label) => {
      const registered = observation.grounding === 'text' && Boolean(proposal?.projectIdentifiers?.some((entry) =>
        entry.label === label && quote?.includes(entry.quote) && projectIdentifier(entry.quote, label)));
      const context = observation.grounding === 'text' ? contextIdentity(proposal?.projectContext, quote) : undefined;
      return { id: packageCandidateId(observation, label, registered ? 'printed-project-facade-id' : context), label };
    });
  const unconfirmed = proposal?.state === 'identified' && (!labels.length || labels.length !== candidates.length)
    || proposal?.state === 'common' && (!quote || !fullLine || !packageCommonGrounded(quote) ||
      !packageCommonGrounded(fullLine) || labels.length > 0);
  const state = unconfirmed ? 'unclear' : proposal?.state ?? 'unidentified';
  return { state, candidates: state === 'identified' || state === 'unclear' ? candidates : [], quote,
    reason: unconfirmed ? 'В опоре не подтверждена предложенная принадлежность.'
      : proposal?.reason ?? 'Принадлежность места не установлена при чтении.',
    version: 1, actorId: null };
}

export async function publishPackageObservation(
  tx: PoolClient, { task }: ReaderContext, input: ObservationInput, observation: Observation,
) {
  if (task.scopeId !== null || task.job.mode !== 'primary' || !task.job.packageWindow) return;
  const details = input.package ?? {};
  const { quote, grounding, deliveryStatement } = observation;
  const text = grounding === 'text' ? quote : undefined;
  const { rows: [issued] } = grounding === 'text' && (details.role || details.binding)
    ? await tx.query<{ content: string | null }>(
      `SELECT event#>>'{reply,body,content}' AS content FROM harness_research_events
       WHERE job_id=$1 AND event#>>'{reply,evidence,evidenceId}'=$2 ORDER BY sequence LIMIT 1`,
      [task.jobId, observation.evidenceId])
    : { rows: [] };
  const fullLine = deliveredLines(issued?.content ?? null).find(({ id }) => id === observation.lineId)?.text;
  const segments = fullLine?.split(/[|;·]/u).map((segment) => segment.trim().replace(
    /^(?:document(?: type| role)?|type|title|тип документа|вид документа|документ)\s*:\s*/iu, ''));
  const role = details.role;
  const isCommercial = Boolean(segments?.some((segment) => roleWords.other!.exec(segment)?.index === 0));
  const confirmedRole = role && quote?.includes(role.quote) && (!isCommercial || role.value === 'other') &&
    segments?.some((segment) => segment.includes(role.quote) && roleWords[role.value]?.exec(segment)?.index === 0) ? role : undefined;
  const stage = details.stage && quote?.includes(details.stage.quote) && hasLiteral(details.stage.quote, details.stage.value)
    ? details.stage : undefined;
  const revision = details.revision && quote?.includes(details.revision.quote) &&
    hasLiteral(details.revision.quote, details.revision.value) && /(?:\brev(?:ision)?\.?\s|редакция|ревизия|ред\.\s)/iu.test(details.revision.quote)
    ? details.revision : undefined;
  const revisionStatus = revision?.status === 'current' && current.test(revision.quote) && !inactive.test(revision.quote)
    ? 'current' : revision?.status === 'superseded' && inactive.test(revision.quote) ? 'superseded' : 'unknown';
  const binding = bindingFor(observation, details, fullLine);
  const proposal = details.subjectRegister;
  const register = proposal && revisionStatus === 'current' && (confirmedRole?.value === 'schedule' || confirmedRole?.value === 'inventory') &&
    text?.includes(proposal.quote) && entireRegister.test(proposal.quote) && !exclusion.test(proposal.quote) &&
    binding.state === 'identified' && proposal.labels.every((name) => binding.candidates.some(({ label }) => name === label)) &&
    binding.candidates.every(({ label }) => proposal.labels.includes(label))
    ? { quote: proposal.quote, commonChecked: Boolean(proposal.commonQuote && text.includes(proposal.commonQuote) && commonRegister.test(proposal.commonQuote) && !exclusion.test(proposal.commonQuote)) }
    : null;
  const attribute = details.attribute && quote && hasLiteral(quote.toLocaleLowerCase('ru'), details.attribute.toLocaleLowerCase('ru'))
    ? details.attribute : deliveryStatement?.item ?? null;
  const materials = details.materials?.filter((material) => quote?.includes(material.quote) &&
    hasLiteral(material.quote, material.label)).map((material) => ({ ...material,
      id: packageCandidateId(observation, material.label) })) ?? [];
  const basis = { role: confirmedRole?.quote, stage: stage?.quote, revision: revision?.quote };
  await tx.query(
    `INSERT INTO harness_package_facts(id,project_id,window_id,job_id,attribute,source_role,design_stage,revision,revision_status,basis,subject_register,materials)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) ON CONFLICT(id) DO NOTHING`,
    [observation.id, task.projectId, task.job.packageWindow.id, task.jobId, attribute,
     confirmedRole?.value ?? 'unknown', stage?.value ?? null, revision?.value ?? null, revisionStatus, basis, register, JSON.stringify(materials)]);
  await tx.query(
    `INSERT INTO harness_package_bindings(fact_id,version,state,candidates,quote,reason)
     VALUES($1,1,$2,$3,$4,$5) ON CONFLICT DO NOTHING`,
    [observation.id, binding.state, JSON.stringify(binding.candidates), binding.quote, binding.reason]);
}
