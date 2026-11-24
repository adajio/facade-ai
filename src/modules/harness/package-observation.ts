import type { PoolClient } from 'pg';
import { z } from 'zod';
import { contradictoryDeliveryLine, exactDeliveryStatement } from '../../domain/delivery-statement.js';
import { hash } from '../gateway/types.js';
import { deliveredLines } from '../questions/attribute-aliases.js';
import type { Observation } from '../pdf/types.js';
import type { VerifiedNativeDeliveryLine } from '../pdf/native-line.js';
import { supportsFacadeHeader, type ObservationInput, type ReaderContext } from './contracts.js';
import { packageRoles, type PackageBinding, type PackageFact, type PackageSourceRole } from './package-analysis.js';
import { hasPrintedRevision } from './pair-evidence.js';
import { adjacentFacadeTypeHeader } from './facade-type-evidence.js';

const literal = z.string().trim().min(1).max(500).refine((value) => !value.includes('\0'));
const label = z.string().trim().min(1).max(160).refine((value) => !value.includes('\0'));
const bindingFields = { state: z.enum(['identified', 'common', 'unclear', 'unidentified']), reason: literal };
export const packageBindingEdit = z.strictObject({ ...bindingFields, candidateIds: z.array(z.string().uuid()).max(24) });
const partIndex=z.number().int().min(0).max(11);
const sourceField = z.strictObject({ value: literal, quote: literal });

export const packageDetails = z.strictObject({
  attribute: literal.optional(),
  valueRole:z.strictObject({kind:z.enum(['design','as_built','limit']),quote:literal}).optional(),
  references:z.strictObject({attribute:partIndex.optional(),role:partIndex.optional(),stage:partIndex.optional(),
    revision:partIndex.optional(),binding:partIndex.optional(),valueRole:partIndex.optional()}).optional(),
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

export const profileScanDetails=packageDetails.extend({facadeHeaderLineId:literal.optional()});
export type PackageDetails = z.infer<typeof profileScanDetails>;

const referenceFields = ['attribute', 'role', 'stage', 'revision', 'binding', 'valueRole'] as const;
type ReferenceField = typeof referenceFields[number];
type MetadataField = ReferenceField | 'sourceRole' | 'revisionStatus' | 'materials' | 'subjectRegister' | 'subjectRegister.commonQuote';
type MetadataRefusal = 'reference_required' | 'reference_invalid' | 'quote_not_supported' | 'field_not_grounded';

export interface PackageMetadataReceipt {
  confirmed: { field: MetadataField; evidenceId: string; lineId?: string; box?: Observation['address']['box']; componentIndex?: number; itemIndex?: number }[];
  rejected: { field: MetadataField; code: MetadataRefusal; nextAction: string; itemIndex?: number }[];
}

const fieldGuidance: Record<ReferenceField, string> = {
  attribute: 'Укажите название поля в дословной строке значения, строке этого ряда или заголовке его столбца.',
  role: 'В package.role.quote процитируйте только фрагмент с видом документа, например «Schedule». Завершите цитату перед разделителем и следующим полем. Для отдельной строки укажите её компонент в package.references.role.',
  stage: 'Процитируйте дословное обозначение стадии.',
  revision: 'Процитируйте обозначение вместе с печатной подписью поля редакции.',
  binding: 'Процитируйте напечатанную принадлежность и все заявленные обозначения. Если область неясна, оставьте unclear.',
  valueRole: 'Процитируйте, что это проектное или исполнительное значение либо предел.',
};

export function packageNonDeliveryGrounded(input: Omit<ObservationInput, 'evidence'>, image: boolean, fullLine?: string) {
  if (input.deliveryStatement?.status !== 'not_delivered') return true;
  const role = input.package?.role;
  return !image && Boolean(input.quote && exactDeliveryStatement(input.quote, input.deliveryStatement.item, 'not_delivered') &&
    role?.value === 'inventory' && input.quote.includes(role.quote) && roleWords.inventory!.test(role.quote) &&
    (!fullLine || !contradictoryDeliveryLine(fullLine, input.deliveryStatement.item)));
}

export function verifiedNativeInventoryRole(input: Omit<ObservationInput, 'evidence'>, proof: VerifiedNativeDeliveryLine) {
  const claim = input.deliveryStatement;
  const role = input.package?.role;
  const full = proof.line.text;
  if (claim?.status !== 'not_delivered' || (input.sourceRole ?? role?.value) !== 'inventory' || (role && role.value !== 'inventory')
    || input.package?.references?.role !== undefined || input.package?.facadeHeaderLineId
    || !input.quote || !full.includes(input.quote)
    || !(exactDeliveryStatement(input.quote, claim.item, 'not_delivered') ||
      exactDeliveryStatement(claim.context?.quote ?? '', claim.item, 'not_delivered'))
    || !exactDeliveryStatement(full, claim.item, 'not_delivered') || contradictoryDeliveryLine(full, claim.item)
    || (claim.context && (claim.context.lineId !== proof.line.id ||
      !proof.crops.some(({ line }) => line.text.includes(claim.context!.quote))))) return;
  const segments = roleSegments(full);
  if (segments.some((segment) => roleWords.other!.exec(segment)?.index === 0)) return;
  if (role && !roleSegments(role.quote).some((segment) => inventoryRolePrefix.test(segment))) return;
  const printed = segments.find((segment) => inventoryRolePrefix.test(segment) && (!role || segment.includes(role.quote)));
  const quote = role?.quote ?? (printed && inventoryRolePrefix.exec(printed)?.[0]);
  const crop = quote && printed && proof.crops.find(({ line }) => line.text.includes(quote));
  if (crop && quote) return { evidenceId: crop.evidenceId, quote };
}

const common = /(?:\b(?:(?:applies to|for) all facades?|common materials?|entire building)\b|для\s+все[хм]?\s+фасад|общ(?:ие|ий|ая|его)\s+(?:материал|раздел|требован)|для\s+здания\s+в\s+целом)/iu;
const exclusion = /(?:\b(?:except|excluding|only|not|other than)\b|(?<!\p{L})(?:кроме|исключая|только|не)(?!\p{L}))/iu;
const commonRegister = /(?:\b(?:no common materials|all common materials (?:are )?(?:listed|included|checked))\b|общи\p{L}*\s+материал\p{L}*\s+(?:перечислен\p{L}*|проверен\p{L}*)\s+полностью|общи\p{L}*\s+материал\p{L}*\s+нет)/iu;

export function packageCommonGrounded(quote: string) {
  return common.test(quote) && !exclusion.test(quote);
}
const entireRegister = /(?:\b(?:complete|full|exhaustive)\s+(?:list|schedule|register)\s+of\s+facades?\b|(?:полн\p{L}*|исчерпывающ\p{L}*)\s+(?:перечень|список|ведомость)\s+фасад)/iu;
const current = /(?:\b(?:current|effective)\b|действующ\p{L}*|актуальн\p{L}*)/iu;
const inactive = /(?:\b(?:superseded|obsolete|withdrawn|draft|not[ -]+current)\b|замен[её]н\p{L}*|архивн\p{L}*|не\s+действующ\p{L}*|недействующ\p{L}*|неактуальн\p{L}*|отмен[её]н\p{L}*|черновик)/iu;
const roleWords: Partial<Record<PackageSourceRole, RegExp>> = {
  drawing: /drawing|черт[её]ж|схема/iu, detail: /detail|узел|деталь/iu, schedule: /schedule|ведомость|таблица/iu,
  specification: /specification|спецификация/iu, calculation: /calculation|расч[её]т/iu,
  inventory: /inventory|transmittal|опись|сопроводительн\p{L}*\s+письмо/iu,
  correspondence: /correspondence|letter|переписка|письмо/iu, model: /model|модель/iu,
  other: /commercial offer|quotation|reference material|коммерческ\p{L}*\s+предложен|справочн\p{L}*\s+материал/iu,
};
const roleSegments = (line: string) => line.split(/[|;·]/u).map((segment) => segment.trim().replace(
  /^(?:document(?: type| role)?|type|title|тип документа|вид документа|документ)\s*:\s*/iu, ''));
const inventoryRolePrefix = /^(?:inventory|transmittal|опись|сопроводительн\p{L}*\s+письмо)(?![\p{L}\p{N}_])/iu;
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

function bindingFor(observation: Observation, details: PackageDetails, fullLine?: string, citedQuote=observation.quote): PackageBinding {
  const proposal = details.binding;
  const quote = proposal?.quote && citedQuote?.includes(proposal.quote) ? proposal.quote : null;
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
  const references=details.references??{};
  const fields=referenceFields;
  const supportIds=[...new Set([observation.evidenceId,...(observation.components??[]).map(({evidenceId})=>evidenceId)])];
  const {rows:issued}=grounding==='text'&&(details.role||details.binding||details.facadeHeaderLineId||Object.keys(references).length)
    ? await tx.query<{ id:string;content:string|null;readKind?:string;box?:Observation['address']['box'] }>(
      `SELECT DISTINCT ON(event#>>'{reply,evidence,evidenceId}') event#>>'{reply,evidence,evidenceId}' AS id,
        event#>>'{reply,body,content}' AS content,event#>>'{reply,readKind}' AS "readKind",
        event#>'{reply,evidence,place,box}' AS box FROM harness_research_events
        WHERE job_id=$1 AND event#>>'{reply,evidence,evidenceId}'=ANY($2::text[])
        ORDER BY event#>>'{reply,evidence,evidenceId}',sequence`,[task.jobId,supportIds]):{rows:[]};
  function fullLine(evidenceId:string,lineId:string|undefined) {
    return deliveredLines(issued.find(({id})=>id===evidenceId)?.content??null).find(({id})=>id===lineId)?.text;
  }
  const anchor={evidenceId:observation.evidenceId,lineId:observation.lineId,quote:observation.quote,
    address:observation.address};
  const opened=issued.find(({id})=>id===observation.evidenceId);
  const headerLine=supportsFacadeHeader(task.job)&&details.facadeHeaderLineId&&anchor.lineId&&anchor.quote&&
    opened?.readKind==='extract'&&!opened.box&&details.binding?.state==='identified'&&details.binding.labels.length===1
    ? adjacentFacadeTypeHeader(deliveredLines(opened.content),anchor.lineId,details.facadeHeaderLineId,anchor.quote) : undefined;
  const header=headerLine&&!inactive.test(headerLine.text)?{...anchor,lineId:headerLine.id,quote:headerLine.text,
    address:{unitId:observation.address.unitId,locator:headerLine.locator,box:headerLine.box}}:undefined;
  const headerFields=new Set<ReferenceField>(['role','stage','revision','binding']);
  const citations=Object.fromEntries(fields.map((field)=>{
    const reference=references[field];
    if(details.facadeHeaderLineId&&headerFields.has(field))return [field,header];
    if(reference===undefined)return [field,anchor];
    const part=observation.components?.[reference];
    return [field,part?.binding&&part.source.versionId===observation.source.versionId&&
      part.source.sha256===observation.source.sha256?part:undefined];
  })) as Record<typeof fields[number],typeof anchor|undefined>;
  const verified = input.verifiedDelivery;
  const roleCrop = verified?.crops.find(({ evidenceId }) => evidenceId === verified.role.evidenceId);
  if (verified && roleCrop) citations.role = {
    ...anchor, evidenceId: roleCrop.evidenceId, lineId: verified.line.id, quote: verified.role.quote,
    address: { ...anchor.address, box: roleCrop.line.box },
  };
  const rolePart=citations.role;
  const fullRole=rolePart&&fullLine(rolePart.evidenceId,rolePart.lineId);
  const segments = fullRole === undefined ? undefined : roleSegments(fullRole);
  const role = details.role;
  const isCommercial = Boolean(segments?.some((segment) => roleWords.other!.exec(segment)?.index === 0));
  const confirmedRole = verified && roleCrop ? { value: 'inventory' as const, quote: verified.role.quote }
    : role && rolePart?.quote?.includes(role.quote) && (!isCommercial || role.value === 'other') &&
      segments?.some((segment) => segment.includes(role.quote) && roleWords[role.value]?.exec(segment)?.index === 0) ? role : undefined;
  const stage = details.stage && citations.stage?.quote?.includes(details.stage.quote) && hasLiteral(details.stage.quote, details.stage.value)
    ? details.stage : undefined;
  const revision = details.revision && citations.revision?.quote?.includes(details.revision.quote) &&
    hasPrintedRevision(details.revision.quote, details.revision.value)
    ? details.revision : undefined;
  const revisionStatus = revision?.status === 'current' && current.test(revision.quote) && !inactive.test(revision.quote)
    ? 'current' : revision?.status === 'superseded' && inactive.test(revision.quote) ? 'superseded' : 'unknown';
  const bindingPart=citations.binding;
  const bindingAnchor=bindingPart?{...observation,lineId:bindingPart.lineId,address:bindingPart.address}:observation;
  const binding=bindingFor(bindingAnchor,details,bindingPart&&fullLine(bindingPart.evidenceId,bindingPart.lineId),bindingPart?.quote??'');
  const proposal = details.subjectRegister;
  const register = proposal && revisionStatus === 'current' && (confirmedRole?.value === 'schedule' || confirmedRole?.value === 'inventory') &&
    text?.includes(proposal.quote) && entireRegister.test(proposal.quote) && !exclusion.test(proposal.quote) &&
    binding.state === 'identified' && proposal.labels.every((name) => binding.candidates.some(({ label }) => name === label)) &&
    binding.candidates.every(({ label }) => proposal.labels.includes(label))
    ? { quote: proposal.quote, commonChecked: Boolean(proposal.commonQuote && text.includes(proposal.commonQuote) && commonRegister.test(proposal.commonQuote) && !exclusion.test(proposal.commonQuote)) }
    : null;
  const attributeQuote=citations.attribute?.quote;
  const attributeGrounded = Boolean(details.attribute && attributeQuote &&
    hasLiteral(attributeQuote.toLocaleLowerCase('ru'), details.attribute.toLocaleLowerCase('ru')));
  const attribute = (attributeGrounded ? details.attribute : deliveryStatement?.item) ?? null;
  const materialGrounded = details.materials?.map((material) => Boolean(quote?.includes(material.quote) && hasLiteral(material.quote, material.label))) ?? [];
  const materials = details.materials?.flatMap((material, index) => materialGrounded[index]
    ? [{ ...material, id: packageCandidateId(observation, material.label) }] : []) ?? [];
  const functionalRoles={design:/(?:design value|nominal value|проектн\p{L}* значен|номинальн\p{L}* значен)/iu,
    as_built:/(?:as[- ]built|actual value|фактическ\p{L}* значен|исполнительн\p{L}* размер)/iu,
    limit:/(?:limit|maximum|minimum|предел|предельн\p{L}* значен|не более|не менее)/iu};
  const proposedRole=details.valueRole;
  const valueRole=proposedRole&&citations.valueRole?.quote?.includes(proposedRole.quote)&&
    functionalRoles[proposedRole.kind].test(proposedRole.quote)?proposedRole:undefined;
  const scopedBinding = binding.quote && (binding.state === 'identified' || binding.state === 'common');
  const qualified={attribute:attributeGrounded,role:confirmedRole,stage,revision,binding:scopedBinding,valueRole};
  const parts=Object.fromEntries(fields.flatMap((name)=>{
    const part=citations[name];
    const verifiedRole = name === 'role' && roleCrop;
    return qualified[name]&&(references[name]!==undefined||header&&headerFields.has(name)||verifiedRole)&&part?.lineId&&part.quote?
      [[name,{lineId:part.lineId,evidenceId:part.evidenceId,quote:part.quote,...(part===header||verifiedRole?{address:part.address}:{})}]]:[];
  }));
  const lineBox = verified?.line.box;
  const crops = verified?.crops.flatMap(({ evidenceId, frame, line }) =>
    line.box ? [{ evidenceId, text: line.text, frame, box: line.box }] : []);
  const deliveryLine: PackageFact['basis']['deliveryLine'] = verified && lineBox && crops?.length === verified.crops.length
    ? { text: verified.line.text, canonicalSha256: verified.canonicalSha256, source: observation.source,
      runId: observation.runId, branch: observation.branch, readerVersion: observation.readerVersion,
      unitId: observation.address.unitId, lineId: verified.line.id, box: lineBox,
      anchorEvidenceId: verified.anchorEvidenceId, submittedEvidenceId: verified.submittedEvidenceId, crops }
    : undefined;
  const basis: PackageFact['basis'] = { role: confirmedRole?.quote, stage: stage?.quote, revision: revision?.quote,
    valueRole,...(Object.keys(parts).length?{parts}:{}),
    ...(deliveryLine ? { deliveryLine } : {}) };
  const saved = await tx.query(
    `INSERT INTO harness_package_facts(id,project_id,window_id,job_id,attribute,source_role,design_stage,revision,revision_status,basis,subject_register,materials)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) ON CONFLICT(id) DO NOTHING RETURNING id`,
    [observation.id, task.projectId, task.job.packageWindow.id, task.jobId, attribute,
     confirmedRole?.value ?? 'unknown', stage?.value ?? null, revision?.value ?? null, revisionStatus, basis, register, JSON.stringify(materials)]);
  if (!saved.rowCount) return;
  await tx.query(
    `INSERT INTO harness_package_bindings(fact_id,version,state,candidates,quote,reason)
     VALUES($1,1,$2,$3,$4,$5) ON CONFLICT DO NOTHING`,
    [observation.id, binding.state, JSON.stringify(binding.candidates), binding.quote, binding.reason]);
  if (task.job.packageWindow.walkProtocol !== 1) return;

  const receipt: PackageMetadataReceipt = { confirmed: [], rejected: [] };
  function confirm(field: MetadataField, ref: typeof anchor, componentIndex?: number, itemIndex?: number) {
    receipt.confirmed.push({ field, evidenceId: ref.evidenceId,
      ...(ref.lineId ? { lineId: ref.lineId } : ref.address.box ? { box: ref.address.box } : {}),
      ...(componentIndex !== undefined ? { componentIndex } : {}), ...(itemIndex !== undefined ? { itemIndex } : {}) });
  }
  function reject(field: MetadataField, code: MetadataRefusal, nextAction: string, itemIndex?: number) {
    receipt.rejected.push({ field, code, nextAction, ...(itemIndex !== undefined ? { itemIndex } : {}) });
  }
  for (const field of fields) {
    if (field === 'role' && verified && rolePart) {
      if (input.sourceRole) confirm('sourceRole', rolePart);
      if (details.role) confirm('role', rolePart);
      continue;
    }
    if (field === 'role' && !details.role && input.sourceRole) {
      reject(field, 'reference_required', fieldGuidance.role);
      continue;
    }
    if (!details[field] || (field === 'binding' && ['unclear', 'unidentified'].includes(details.binding!.state))) continue;
    const ref = citations[field];
    const componentIndex = references[field];
    if (qualified[field] && ref) {
      confirm(field, ref, componentIndex);
      continue;
    }
    const proposedQuote = field === 'attribute' ? undefined : details[field]?.quote;
    const supported = field === 'attribute' ? attributeGrounded : Boolean(proposedQuote && ref?.quote?.includes(proposedQuote));
    const code = componentIndex !== undefined && !ref ? 'reference_invalid' : supported ? 'field_not_grounded'
      : componentIndex === undefined ? 'reference_required' : 'quote_not_supported';
    const nextAction = details.facadeHeaderLineId&&headerFields.has(field)&&!header
      ? 'Откройте нативный текст целого окна. Укажите строку действующего заголовка непосредственно перед строкой типа того же фасада.'
      : code === 'field_not_grounded' ? fieldGuidance[field]
      : code === 'quote_not_supported' ? 'Используйте точную цитату из указанного компонента.'
      : `Откройте нужную строку и укажите индекс адресного компонента в package.references.${field} при save_compound_observation. В повторном сохранении сохраните подтверждённые поля. ${fieldGuidance[field]}`;
    reject(field, code, nextAction);
  }
  if (input.sourceRole && details.role && input.sourceRole !== confirmedRole?.value) {
    reject('sourceRole', 'field_not_grounded', fieldGuidance.role);
  }
  if (revision && revision.status !== 'unknown') {
    if (revisionStatus === revision.status) confirm('revisionStatus', citations.revision!, references.revision);
    else reject('revisionStatus', 'field_not_grounded', 'Процитируйте прямое указание статуса этой редакции или укажите unknown.');
  }
  materialGrounded.forEach((grounded, index) => {
    if (grounded) confirm('materials', anchor, undefined, index);
    else reject('materials', 'quote_not_supported', 'Процитируйте название материала в исходной строке.', index);
  });
  if (proposal) {
    if (register) confirm('subjectRegister', anchor);
    else reject('subjectRegister', 'field_not_grounded', 'Процитируйте полный перечень фасадов из действующей описи или ведомости и подтвердите все её обозначения.');
    if (proposal.commonQuote) {
      if (register?.commonChecked) confirm('subjectRegister.commonQuote', anchor);
      else reject('subjectRegister.commonQuote', 'field_not_grounded', 'В опоре на перечень нужна дословная отметка о полноте или отсутствии общих материалов.');
    }
  }
  return receipt;
}
