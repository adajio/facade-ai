import type { Pool, PoolClient } from 'pg';
import { hash, transaction } from '../gateway/types.js';
import { currentPackageSource, currentPackageWindows } from '../gateway/package-slots.js';
import { lockIntakeProject } from '../intake/gate.js';
import type { Observation, ReaderAddress, ReaderLine } from '../pdf/types.js';
import { deliveredLines } from '../questions/attribute-aliases.js';
import { publishProjectEvent } from '../supplements/events.js';
import type { PackageBinding, PackageFact } from './package-analysis.js';
import { affirmedFacadeKind } from './facade-type-evidence.js';

export const facadeDiscoveryVersion=2;

export type FacadeEvidence = {
  factId: string; branch: 'A' | 'B'; evidenceId: string; versionId: string; readerVersion: string;
  address: ReaderAddress; lineId?: string; quote: string;
};
export type FacadeMention = FacadeEvidence & {
  label: string; kind: 'registry' | 'reference' | 'context' | 'designation' | 'unresolved';
  context?: { building: string; axes: string };
  partialContext?: { building?: string; axes?: string; conflicting?: true };
  contextQuote?: string;
  lookupToken?: string;
  relation?: { sourceLabel?: string; targetLabels: string[] };
  qualifier?: { evidenceId: string; lineId: string; quote: string; address: ReaderAddress };
};

export type FacadeProfile = {
  facadeId: string; label: string; identity: 'independent' | 'one_branch' | 'engineer' | 'unresolved';
  mentions: FacadeMention[];
  attributes: Partial<Record<'facadeKind' | 'building' | 'axes' | 'stage' | 'revision' | 'variant' | 'documentRole' | 'valueRole',
    { value: string; status?: string; evidence: FacadeEvidence[] }[]>>;
  conflicts: string[];
};

const clauses = /[|;·\r\n]/u;
const facadeHeading = /^(?:facade(?:\s+(?:mark|designation|id))?|фасад|(?:марка|обозначение|код) фасада)\s*[:№=]?$/iu;
const registered = /^(?:project facade (?:identifier|id)|идентификатор фасада проекта|код фасада проекта)\s*[:№=]\s*(.+)$/iu;
const referred = /^(?:project facade (?:reference|ref)|ссылка на (?:код|идентификатор) фасада проекта)\s*[:№=]\s*(.+)$/iu;
const viewName = /^(?:view(?: name)?|detail view|вид|наименование вида)\s*[:№=]\s*(.+)$/iu;
const viewReference = /(?:^|\s)(refers to|reference to|does not refer to|not referring to|не относится к|не ссылается на|относится к|ссылается на)(?=\s|[:№=]|$)\s*[:№=]?\s*(.*)$/iu;
const designation = /^(?:facade(?:\s+(?:mark|designation|id))?|фасад|(?:марка|обозначение|код) фасада)\s*[:№=]\s*(.+)$/iu;
const inlineDesignation = /^(?:facade|фасад)\s+([\p{L}\p{N}_.\/‐‑‒–—-]+)(?=\s+(?:в\s+|по\s+|in\s+|at\s+|axes\s+|grid\s+|корпус|building|block))/iu;
const buildingField = /^(?:building|block|корпус|здани[ея]|секция)\s*[:№=]\s*(.+)$/iu;
const axesField = /^(?:axes|grid|оси|осях)\s*[:№=]\s*(.+)$/iu;
const inlineBuilding = /(?<!\p{L})(?:корпус(?:а|е)?|здани[еяи]|building|block)\s*[:№=]?\s+([\p{L}\p{N}_.‐‑‒–—-]+)/iu;
const inlineAxes = /(?<!\p{L})(?:в\s+осях|по\s+осям|axes|grid)\s*[:№=]?\s+([\p{L}\p{N}_.\/‐‑‒–—-]+(?:\s*[-‐‑‒–—/]\s*[\p{L}\p{N}_.]+)?)/iu;
const normalize = (value: string) => value.normalize('NFC').trim();
const foldedLabel = (value: string) => normalize(value).toLowerCase().replace(/[‐‑‒–—]/gu,'-').replace(/\s+/gu, ' ');
const printedMark = /^(?=[\p{L}\p{N}_.\/‐‑‒–—-]*\p{N})[\p{L}\p{N}_.\/‐‑‒–—-]+$/u;
const direction = /\b(?:north(?:east|west)?|south(?:east|west)?|east|west)(?:ern)?\b|(?<!\p{L})(?:северо-восточн|северо-западн|юго-восточн|юго-западн|северн|южн|восточн|западн)(?:ый|ого|ому|ым|ом)(?!\p{L})/iu;
const directionSubject = /(?<!\p{L})(?:facade|фасад(?:а|у|ом|е)?)(?!\p{L})/iu;

function directionalMark(line: string) {
  // A direction must name the facade in the heading, even when the words are reversed or inflected.
  const subject=directionSubject.exec(line);
  const marker=direction.exec(line);
  if(!subject||!marker||line.slice(Math.min(subject.index+subject[0].length,marker.index+marker[0].length),
    Math.max(subject.index,marker.index)).trim().replace(/^[:№=]$/u,'').trim())return;
  const token=foldedLabel(marker[0]).replace(/(?:ern|ый|ого|ому|ым|ом)$/u,'');
  return {label:`${marker[0]} ${subject[0]}`,token,heading:!line.slice(0,Math.min(subject.index,marker.index)).trim()};
}

function localFacadeFields(line: string) {
  const marks=[...fields(line,designation),...fields(line,inlineDesignation)].filter((label)=>printedMark.test(label));
  const orientations=line.split(clauses).map((part)=>directionalMark(part.trim())).filter((item)=>item!==undefined);
  return [...marks.map((label)=>({label,token:undefined,heading:true})),...orientations];
}

function fields(line: string, pattern: RegExp) {
  return new Set(line.split(clauses).flatMap((part) => {
    const match = pattern.exec(part.trim());
    return match ? [normalize(match[1])] : [];
  }).filter(Boolean));
}

function uniqueField(line: string, pattern: RegExp) {
  const values=fields(line,pattern);
  return values.size === 1 ? [...values][0] : undefined;
}

function facadeColumn(lines: ReaderLine[], cell: ReaderLine) {
  const locator = cell.locator;
  if (!locator || typeof locator.row !== 'number' || typeof locator.column !== 'number' ||
    (locator.sheet ?? locator.sheetId ?? locator.table) === undefined) return;
  const { row } = locator;
  const above = lines.filter((line) => {
    const sameColumn = line.locator?.column === locator.column &&
      ['sheet','sheetId','table','section'].every((key) => line.locator?.[key] === locator[key]);
    return sameColumn && typeof line.locator?.row === 'number' && line.locator.row < row && line.text.trim();
  }).sort((a,b) => Number(b.locator!.row) - Number(a.locator!.row));
  // Follow consecutive typed rows only. A different heading or a blank interval closes the table section.
  let expected=row-1;
  for(const candidate of above) {
    if(candidate.locator?.row!==expected--) break;
    const text=candidate.text.trim();
    if(facadeHeading.test(text))return candidate;
    if(!printedMark.test(text))break;
  }
}

function addressedContext(line: string, mark: string) {
  const anchors=[...line.matchAll(/[^|;·\r\n]+/gu)].flatMap((part)=>{
    const candidate=localFacadeFields(part[0]).find(({heading})=>heading);
    const label=uniqueField(part[0],registered)??uniqueField(part[0],referred);
    const key=label?foldedLabel(label):candidate?.token??foldedLabel(candidate?.label??uniqueField(part[0],designation)??'');
    return key?[{label:key,at:part.index}]:[];
  });
  const distinct=new Set(anchors.map(({label})=>label));
  const segments=distinct.size<=1?[line]:anchors.flatMap(({label,at},index)=>
    label===mark?[line.slice(at,anchors[index+1]?.at??line.length).replace(/[|;·\s]+$/u,'').trimStart()]:[]);
  const qualifiers=(quote:string,field:RegExp,inline:RegExp)=>new Map(quote.split(clauses).flatMap((clause)=>{
    const explicit=fields(clause,field);
    return [...(explicit.size?explicit:fields(clause,inline))].map((value)=>[foldedLabel(value),value] as const);
  }));
  const qualified=segments.map((contextQuote)=>{
    const buildings=qualifiers(contextQuote,buildingField,inlineBuilding);
    const grids=qualifiers(contextQuote,axesField,inlineAxes);
    return {buildings,grids,contextQuote};
  });
  const buildings=new Map(qualified.flatMap(({buildings})=>[...buildings]));
  const grids=new Map(qualified.flatMap(({grids})=>[...grids]));
  const building=buildings.size===1?[...buildings.values()][0]:undefined;
  const axes=grids.size===1?[...grids.values()][0]:undefined;
  const conflicting=buildings.size>1||grids.size>1;
  const complete=qualified.find(({buildings,grids})=>buildings.size===1&&grids.size===1);
  if(!building&&!axes&&!conflicting)return;
  const contextQuote=complete?.contextQuote??qualified.find(({buildings,grids})=>buildings.size||grids.size)?.contextQuote;
  const context=building&&axes&&complete&&!conflicting?{building,axes}:undefined;
  return {context,contextQuote,partialContext:{building,axes,...(conflicting?{conflicting:true as const}:{})}};
}

function referencedFacade(line: string) {
  const statements=line.split(clauses).flatMap((clause)=>{
    const text=clause.trim();
    const match=viewReference.exec(text);
    return match?[{prefix:text.slice(0,match.index).trim(),predicate:match[1],literal:match[2]}]:[];
  });
  if(!statements.length)return;
  const {prefix}=statements[0];
  const sourceLabel=prefix?(uniqueField(prefix,viewName)??uniqueField(prefix,designation)??prefix):
    uniqueField(line,viewName)??uniqueField(line,designation);
  const labels=new Map<string,string>();
  let ambiguous=false;
  for (const {predicate,literal} of statements) {
    if(/^(?:does not|not |не )/iu.test(predicate))ambiguous=true;
    const targets=literal.replace(/^(?:the\s+)?(?:project\s+)?(?:facade(?: (?:identifier|id))?|фасаду?)\s*[:№=]?\s+/iu,'').split(
      /\s*(?:,|&|\s+(?:and|or|и|или|либо)\s+)\s*/iu);
    for(const value of targets) {
      const target=normalize(value.replace(/\s+(?:in\s+axes|at\s+grid|в\s+осях|по\s+осям)\b.*$/iu,'').replace(/[.。]$/u,''));
      if(!/^[\p{L}\p{N}][\p{L}\p{N}_.\/ ‐‑‒–—-]{0,159}$/u.test(target))ambiguous=true;
      else labels.set(foldedLabel(target),target);
    }
  }
  const targetLabels=[...labels.values()];
  const context=addressedContext(line,sourceLabel?foldedLabel(sourceLabel):'');
  const unique=!ambiguous&&targetLabels.length===1&&fields(line,buildingField).size<=1&&fields(line,axesField).size<=1;
  return {label:unique?targetLabels[0]:sourceLabel||targetLabels[0]||line,
    kind:unique?'reference' as const:'unresolved' as const,relation:{...(sourceLabel?{sourceLabel}:{}),targetLabels},...context};
}

export function collectFacadeMentions(observation: Observation, initial: Pick<PackageBinding,'quote'|'candidates'>,
  reference: FacadeEvidence, lines: ReaderLine[], evidenceByLine: ReadonlyMap<string,string> = new Map()): FacadeMention[] {
  const { quote, lineId } = reference;
  const line = lines.find(({ id, text }) => id === lineId && text.includes(quote));
  const possible = new Set(initial.candidates.map(({ label }) => normalize(label)));
  if (!line || observation.grounding !== 'text') {
    return [...possible].map((label) => ({ ...reference, label, kind: 'unresolved' }));
  }
  const relation=referencedFacade(line.text);
  if(relation)return [{...reference,quote:line.text,...relation}];
  const projectMarks = fields(quote, registered);
  const referenceMarks = fields(quote, referred);
  const localMarks = localFacadeFields(quote);
  const column = facadeColumn(lines, line);
  for(const label of [...projectMarks,...referenceMarks,...localMarks.map(({label})=>label)])possible.add(label);
  if (column && quote === line.text && quote.length <= 160) possible.add(normalize(quote));
  return [...possible].map((label) => {
    const mark = foldedLabel(label);
    const isRegistry = [...projectMarks].some((label)=>foldedLabel(label)===mark);
    const isReference = [...referenceMarks].some((label)=>foldedLabel(label)===mark);
    const orientation=directionalMark(label);
    const local=localMarks.find(({label,token})=>foldedLabel(label)===mark||token&&token===orientation?.token);
    const isCell = column && foldedLabel(line.text) === mark;
    const scope=isRegistry||isReference||local?.heading ? addressedContext(line.text,local?.token??mark):undefined;
    const kind = isRegistry ? 'registry' : isReference ? 'reference' : local?.heading && scope?.context ? 'context' : local || isCell ? 'designation' : 'unresolved';
    return { ...reference, label, kind, ...scope, ...(local?.token?{lookupToken:local.token}:{}),
      ...(isCell && column ? { qualifier: { evidenceId:evidenceByLine.get(column.id)??reference.evidenceId, lineId: column.id, quote: column.text,
        address: { ...reference.address, locator: column.locator, box: column.box } } } : {}) };
  });
}

function facadeId(projectId: string, identity: string, label: string) {
  const key = hash([projectId,identity,normalize(label)]);
  return [key.slice(0,8),key.slice(8,12),'8'+key.slice(13,16),'a'+key.slice(17,20),key.slice(20,32)].join('-');
}

function identityKey(mention: FacadeMention) {
  if(mention.kind!=='context'&&mention.kind!=='registry')return;
  return JSON.stringify([mention.kind,mention.lookupToken??foldedLabel(mention.label),mention.context&&
    [foldedLabel(mention.context.building),foldedLabel(mention.context.axes)]]);
}

export function resolveFacadeMentions(projectId: string, mentions: FacadeMention[],
  established: ReadonlyMap<FacadeMention,{id:string;label:string}> = new Map()) {
  const groups = Map.groupBy(mentions, ({ label,lookupToken }) => lookupToken??foldedLabel(label));
  const resolved = new Map<FacadeMention,{ id: string; label: string }>();
  for (const group of groups.values()) {
    const registries=group.filter(({kind})=>kind==='registry');
    const registryClaims=registries.map((item)=>item.partialContext??item.context);
    const claims=(field:'building'|'axes')=>new Set(registryClaims.flatMap((claim)=>claim?.[field]?[foldedLabel(claim[field])]:[]));
    const buildings=claims('building'),axes=claims('axes');
    const registry = buildings.size<=1&&axes.size<=1&&!registries.some(({partialContext})=>partialContext?.conflicting)
      ? registries.find(({context})=>context)??registries[0] : undefined;
    const registerId = registry && facadeId(projectId, 'printed-project-facade-id', registry.label);
    const contexts = new Map(group.flatMap(({ context }) => context ?
      [[JSON.stringify([foldedLabel(context.building),foldedLabel(context.axes)]),context] as const] : []));
    for (const item of group) {
      const contextKey = item.context && JSON.stringify([foldedLabel(item.context.building),foldedLabel(item.context.axes)]);
      const registryContext = registry?.context && JSON.stringify([foldedLabel(registry.context.building),foldedLabel(registry.context.axes)]);
      const sameBranch=registries.filter(({branch})=>branch===item.branch);
      const sameLine=sameBranch.some((entry)=>entry.versionId===item.versionId&&entry.address.unitId===item.address.unitId&&
        entry.lineId===item.lineId);
      const partial=item.partialContext??item.context;
      const compatible=!(item.partialContext?.conflicting || partial?.building&&buildings.size&&!buildings.has(foldedLabel(partial.building)) ||
        partial?.axes&&axes.size&&!axes.has(foldedLabel(partial.axes)));
      const hasReferenceTarget=sameBranch.some((entry)=>!item.relation||entry.versionId===item.versionId||
        contextKey!==undefined&&contextKey===registryContext&&entry.context!==undefined);
      if (registerId && (item.kind==='registry' || item.kind==='context' && contextKey===registryContext
        || item.kind==='reference' && hasReferenceTarget && compatible
        || item.kind==='designation' && sameLine && compatible)) {
        resolved.set(item,{id:registerId,label:registry!.label});
      } else if ((item.kind==='context'||item.kind==='registry') && contextKey) {
        const context = contexts.get(contextKey)!;
        const label = group.find((other) => (other.kind==='context'||other.kind==='registry')
          && other.context && foldedLabel(other.context.building)===foldedLabel(context.building)
          && foldedLabel(other.context.axes)===foldedLabel(context.axes))!.label;
        resolved.set(item,{id:facadeId(projectId,JSON.stringify(['building-axes',context.building,context.axes]),label),label});
      }
    }
    // A source-local contextual identity may also have been established from its printed building and axes.
    if(!registries.length)for(const item of group) {
      if(item.kind!=='reference'||!item.relation||!item.context||item.partialContext?.conflicting)continue;
      const context=item.context;
      const targets=new Map(group.flatMap((source)=>{
        const canonical=resolved.get(source);
        return canonical&&source.kind==='context'&&source.versionId===item.versionId&&source.branch===item.branch&&source.context&&
          foldedLabel(source.context.building)===foldedLabel(context.building)&&foldedLabel(source.context.axes)===foldedLabel(context.axes)
          ? [[canonical.id,canonical] as const]:[];
      }));
      if(targets.size===1)resolved.set(item,targets.values().next().value!);
    }
  }
  // A new identifier may add proof to an existing contextual identity. Retain the issued ID
  // only while its old attachment resolves to one current identity under the new proof.
  const targetsByPrevious=Map.groupBy([...established].filter(([mention])=>resolved.has(mention)),([,candidate])=>candidate.id);
  const stable=new Map<string,{id:string;label:string}>();
  for(const entries of targetsByPrevious.values()) {
    const groups=new Set(entries.map(([mention])=>resolved.get(mention)!.id));
    const target=[...groups][0];
    if(groups.size===1&&!stable.has(target))stable.set(target,entries[0][1]);
  }
  for(const [mention,candidate] of resolved)resolved.set(mention,stable.get(candidate.id)??candidate);
  return resolved;
}

const activeDiscoveryFacts = `harness_package_facts f
  JOIN reader_observations o ON o.id=f.id
  LEFT JOIN harness_package_followups child ON child.job_id=f.job_id
  JOIN harness_package_branches root ON root.job_id=coalesce(child.root_job_id,f.job_id) AND root.active
  JOIN gateway_jobs j ON j.id=root.job_id
  JOIN gateway_generations g ON g.generation_id=j.generation_id AND g.current
  JOIN ${currentPackageWindows} ON w.id=f.window_id`;

type DiscoveryRow = { id: string; observation: Observation; basis: PackageFact['basis']; original: PackageBinding };

export async function reconcileNextFacadeDiscovery(db: Pool) {
  const { rows: [next] } = await db.query<{ project_id: string }>(
    'SELECT project_id FROM harness_facade_discovery_dirty ORDER BY changed_at,project_id LIMIT 1');
  if (!next) return false;
  return transaction(db, async (tx) => {
    const projectId=next.project_id;
    await lockIntakeProject(tx,projectId);
    if (!(await tx.query('SELECT 1 FROM harness_facade_discovery_dirty WHERE project_id=$1 FOR UPDATE',[projectId])).rowCount) return false;
    const { rows: due } = await tx.query<DiscoveryRow>(`SELECT f.id,o.payload AS observation,f.basis,
        jsonb_build_object('quote',first.quote,'candidates',first.candidates) AS original
      FROM ${activeDiscoveryFacts} JOIN harness_package_bindings first ON first.fact_id=f.id AND first.version=1
      LEFT JOIN harness_facade_discovery discovery ON discovery.fact_id=f.id
      WHERE f.project_id=$1 AND coalesce(discovery.discovery_version,0)<$2 AND ${currentPackageSource}
      ORDER BY f.id LIMIT 32`, [projectId,facadeDiscoveryVersion]);
    for (const row of due) await recordDiscovery(tx,row);
    if (due.length===32) {
      await tx.query('UPDATE harness_facade_discovery_dirty SET changed_at=clock_timestamp() WHERE project_id=$1',[projectId]);
      return true;
    }
    await reconcileBindings(tx,projectId);
    await tx.query('DELETE FROM harness_facade_discovery_dirty WHERE project_id=$1',[projectId]);
    return true;
  });
}

async function recordDiscovery(tx: PoolClient, row: DiscoveryRow) {
  const { observation, original, basis }=row;
  const part=basis.parts?.binding;
  const component=part && observation.components?.find(({ evidenceId,lineId })=>part.evidenceId===evidenceId&&part.lineId===lineId);
  const quote=original.quote??observation.quote;
  let mentions: FacadeMention[]=[];
  if (quote) {
    const evidenceId=part?.evidenceId??observation.evidenceId;
    const lineId=part?.lineId??observation.lineId;
    const reference: FacadeEvidence={factId:row.id,branch:observation.branch,
      evidenceId,versionId:observation.source.versionId,readerVersion:observation.readerVersion,
      address:part?.address??component?.address??observation.address,lineId,quote};
    const addressed=observation.components?.filter((item)=>item.binding && item.readerVersion===reference.readerVersion &&
      item.source.versionId===reference.versionId && item.address.unitId===reference.address.unitId)??[];
    const evidenceIds=[...new Set([evidenceId,...addressed.map((item)=>item.evidenceId)])];
    const { rows: opened }=await tx.query<{ evidenceId:string; content:string }>(
      `SELECT DISTINCT ON (event#>>'{reply,evidence,evidenceId}') event#>>'{reply,evidence,evidenceId}' AS "evidenceId",
        event#>>'{reply,body,content}' AS content FROM harness_research_events
       WHERE job_id=$1 AND event#>>'{reply,evidence,evidenceId}'=ANY($2::text[])
       ORDER BY event#>>'{reply,evidence,evidenceId}',sequence`,[observation.runId,evidenceIds]);
    const lines=new Map<string,ReaderLine>();
    const evidenceByLine=new Map<string,string>();
    for(const id of evidenceIds)for(const line of deliveredLines(opened.find((claim)=>claim.evidenceId===id)?.content??null)) {
      if(lines.has(line.id)||line.id===lineId&&id!==evidenceId)continue;
      lines.set(line.id,line);
      evidenceByLine.set(line.id,id);
    }
    mentions=collectFacadeMentions(observation,original,reference,[...lines.values()],evidenceByLine);
  }
  await tx.query(`INSERT INTO harness_facade_discovery(fact_id,mentions,discovery_version) VALUES($1,$2,$3) ON CONFLICT(fact_id)
    DO UPDATE SET prior_mentions=coalesce(harness_facade_discovery.prior_mentions,'[]'::jsonb)||jsonb_build_array(
        jsonb_build_object('version',harness_facade_discovery.discovery_version,'mentions',harness_facade_discovery.mentions)),
      mentions=EXCLUDED.mentions,discovery_version=EXCLUDED.discovery_version,resolved=false
    WHERE harness_facade_discovery.discovery_version<EXCLUDED.discovery_version`,[row.id,JSON.stringify(mentions),facadeDiscoveryVersion]);
}

async function reconcileBindings(tx:PoolClient,projectId:string) {
  const { rows }=await tx.query<{
    id:string; version:number; state:PackageBinding['state']; candidates:PackageBinding['candidates']; quote:string|null;
    actor:string|null; mentions:FacadeMention[]; basis:PackageFact['basis']; revisionStatus:PackageFact['revisionStatus']; resolved:boolean;
    versionId:string; mapFingerprint:string; anchorQuote:string|null; reinterpreted:boolean;
  }>(`SELECT f.id,binding.version,binding.state,binding.candidates,binding.quote,binding.actor_id AS actor,d.mentions,
       f.basis,f.revision_status AS "revisionStatus",d.resolved,o.version_id AS "versionId",w.map_fingerprint AS "mapFingerprint",
       o.payload->>'quote' AS "anchorQuote",d.prior_mentions IS NOT NULL AND NOT d.resolved AS reinterpreted
    FROM ${activeDiscoveryFacts} JOIN harness_facade_discovery d ON d.fact_id=f.id AND d.discovery_version=${facadeDiscoveryVersion}
    JOIN LATERAL(SELECT * FROM harness_package_bindings x WHERE x.fact_id=f.id ORDER BY version DESC LIMIT 1) binding ON true
    WHERE f.project_id=$1 AND ${currentPackageSource} ORDER BY o.created_at,f.id`,[projectId]);
  const eligible=rows.filter(({actor,state,revisionStatus})=>!actor&&state!=='common'&&revisionStatus!=='superseded');
  const aliases=await tx.query<{identity_key:string;id:string;label:string}>(
    'SELECT identity_key,facade_id AS id,label FROM harness_facade_identity_aliases WHERE project_id=$1',[projectId]);
  const byIdentity=new Map(aliases.rows.map(({identity_key,id,label})=>[identity_key,{id,label}]));
  const established=new Map<FacadeMention,{id:string;label:string}>();
  for(const row of eligible)for(const mark of row.mentions) {
    const key=identityKey(mark);
    if(!key)continue;
    const candidate=row.resolved&&row.state==='identified'&&row.candidates.length===1?row.candidates[0]:byIdentity.get(key);
    if(candidate)established.set(mark,candidate);
  }
  const resolved=resolveFacadeMentions(projectId,eligible.flatMap(({mentions})=>mentions),established);
  for(const [mark,candidate] of resolved) {
    const key=identityKey(mark);
    if(!key||byIdentity.get(key)?.id===candidate.id)continue;
    await tx.query(`INSERT INTO harness_facade_identity_aliases(project_id,identity_key,facade_id,label) VALUES($1,$2,$3,$4)
      ON CONFLICT(project_id,identity_key) DO UPDATE SET facade_id=EXCLUDED.facade_id,label=EXCLUDED.label`,
      [projectId,key,candidate.id,candidate.label]);
    byIdentity.set(key,candidate);
  }
  const proof=new Map<string,{versions:Set<string>;claims:Set<string>}>();
  const changed=new Set<string>();
  for (const row of rows) {
    if (row.actor || row.state==='common') continue;
    const candidates=[...new Map(row.mentions.flatMap((mention)=> {
      const canonical=resolved.get(mention);
      return canonical?[[canonical.id,canonical] as const]:[];
    })).values()];
    const state=candidates.length && row.mentions.every((mention)=>resolved.has(mention)) ? 'identified'
      : row.mentions.length ? 'unclear' : 'unidentified';
    if(state==='identified') for(const {id} of candidates) {
      for(const mention of row.mentions) {
        if(resolved.get(mention)?.id!==id)continue;
        const authority=identityKey(mention);
        const kind=row.revisionStatus==='current'&&row.basis.role&&row.anchorQuote ? affirmedFacadeKind(row.anchorQuote) : undefined;
        if(!authority&&!kind)continue;
        const collected=proof.get(id)??{versions:new Set<string>(),claims:new Set<string>()};
        collected.versions.add(row.versionId);
        const source=[row.versionId,row.mapFingerprint,mention.branch];
        if(authority)collected.claims.add(JSON.stringify([...source,authority]));
        if(kind)collected.claims.add(JSON.stringify([...source,foldedLabel(kind),row.basis.stage,row.basis.revision]));
        proof.set(id,collected);
      }
    }
    if (state===row.state && JSON.stringify(candidates)===JSON.stringify(row.candidates)) continue;
    if(row.reinterpreted)for(const {id} of [...row.candidates,...candidates])changed.add(id);
    await tx.query(`INSERT INTO harness_package_bindings(fact_id,version,state,candidates,quote,reason)
      VALUES($1,$2,$3,$4,$5,$6)`,[row.id,row.version+1,state,JSON.stringify(candidates),row.quote,
      state==='identified'?'Обозначение связано с адресным проектным идентификатором или контекстом корпуса и осей.'
        :'Адресное упоминание не устанавливает однозначную принадлежность фасаду.']);
  }
  const stored=await tx.query<{facade_id:string;fingerprint:string}>(
    'SELECT facade_id,fingerprint FROM harness_facade_profile_proofs WHERE project_id=$1',[projectId]);
  const previous=new Map(stored.rows.map(({facade_id,fingerprint})=>[facade_id,fingerprint]));
  for(const [id,items] of proof) {
    const fingerprint=hash([...items.claims].sort());
    if(previous.get(id)!==fingerprint) {
      await tx.query(`INSERT INTO harness_facade_profile_proofs(project_id,facade_id,fingerprint,version_ids) VALUES($1,$2,$3,$4)
        ON CONFLICT(project_id,facade_id) DO UPDATE SET fingerprint=EXCLUDED.fingerprint,version_ids=EXCLUDED.version_ids`,
        [projectId,id,fingerprint,[...items.versions]]);
      changed.add(id);
    }
    previous.delete(id);
  }
  if(previous.size) {
    for(const id of previous.keys())changed.add(id);
    await tx.query('DELETE FROM harness_facade_profile_proofs WHERE project_id=$1 AND facade_id=ANY($2)',[projectId,[...previous.keys()]]);
  }
  if(changed.size) {
    await tx.query(`INSERT INTO harness_semantic_scope_epochs(project_id,scope_key,epoch)
      SELECT $1,id,1 FROM unnest($2::text[]) id ON CONFLICT(project_id,scope_key)
      DO UPDATE SET epoch=harness_semantic_scope_epochs.epoch+1`,[projectId,[...changed]]);
    await publishProjectEvent(tx,projectId,{type:'package-analysis.changed',payload:{}});
  }
  const completed=await tx.query(`UPDATE harness_facade_discovery SET resolved=true WHERE NOT resolved AND fact_id=ANY($1::uuid[])`,
    [rows.map(({id})=>id)]);
  if(completed.rowCount&&!changed.size)await publishProjectEvent(tx,projectId,{type:'package-analysis.changed',payload:{}});
}

export function buildFacadeProfiles(facts: PackageFact[], mentions: FacadeMention[], candidates: PackageBinding['candidates']): FacadeProfile[] {
  const byFact=Map.groupBy(mentions,({factId})=>factId);
  return candidates.map(({id,label})=>{
    const relevant=facts.filter((f)=>f.binding.state==='identified'&&f.binding.candidates.some((c)=>c.id===id));
    const localDirection=directionalMark(label)?.token;
    const addressed=relevant.flatMap((f)=>(byFact.get(f.id)??[])
      .filter((mention)=>mention.kind!=='unresolved'&&(foldedLabel(mention.label)===foldedLabel(label)||
        localDirection&&mention.lookupToken===localDirection)));
    const branches=new Set(addressed.map(({branch})=>branch));
    const attributes: FacadeProfile['attributes']={};
    function attach(field:keyof typeof attributes,value:string|undefined|null,evidence:FacadeEvidence,status?:string) {
      if(!value)return;
      const claims=attributes[field]??=[];
      let claim=claims.find((c)=>foldedLabel(c.value)===foldedLabel(value)&&c.status===status);
      if(!claim) { claim={value,...(status?{status}:{}),evidence:[]}; claims.push(claim); }
      if(!claim.evidence.some((ref)=>ref.factId===evidence.factId&&ref.evidenceId===evidence.evidenceId&&ref.lineId===evidence.lineId)) {
        claim.evidence.push(evidence);
      }
    }
    for(const m of addressed) {
      const context={...m,quote:m.contextQuote??m.quote};
      attach('building',m.context?.building??m.partialContext?.building,context);
      attach('axes',m.context?.axes??m.partialContext?.axes,context);
    }
    for(const fact of relevant) {
      if(fact.binding.candidates.length!==1)continue;
      const {observation:o,basis}=fact;
      if(o.grounding!=='text'||!o.quote||fact.revisionStatus==='superseded')continue;
      const anchor:FacadeEvidence={factId:fact.id,branch:fact.branch,evidenceId:o.evidenceId,versionId:o.source.versionId,
        readerVersion:o.readerVersion,address:o.address,lineId:o.lineId,quote:o.quote};
      const ref=(field:keyof NonNullable<typeof basis.parts>,quote?:string)=>{
        const part=basis.parts?.[field];
        const component=part&&o.components?.find((c)=>c.evidenceId===part.evidenceId&&c.lineId===part.lineId);
        return part&&(part.address||component)?{...anchor,...part,address:part.address??component!.address}: {...anchor,quote:quote??anchor.quote};
      };
      if(basis.stage)attach('stage',fact.designStage,ref('stage',basis.stage));
      if(basis.revision)attach('revision',fact.revision,ref('revision',basis.revision),fact.revisionStatus);
      if(basis.role&&fact.sourceRole!=='unknown') {
        attach('documentRole',fact.sourceRole,ref('role',basis.role));
        if(fact.revisionStatus==='current')attach('facadeKind',affirmedFacadeKind(o.quote),anchor);
      }
      if(basis.valueRole)attach('valueRole',basis.valueRole.kind,ref('valueRole',basis.valueRole.quote));
      const variant=o.components?.find(({role,binding,source})=>role==='variant'&&binding?.kind==='variant_field'&&source.versionId===o.source.versionId);
      if(variant)attach('variant',variant.literal,{...anchor,evidenceId:variant.evidenceId,lineId:variant.lineId,
        address:variant.address,quote:variant.quote});
      else attach('variant',fact.variant,anchor);
    }
    const conflicts=(['facadeKind','building','axes','stage','variant'] as const)
      .filter((field)=>(attributes[field]?.length??0)>1);
    return {facadeId:id,label,identity:relevant.some(({binding})=>binding.actorId)?'engineer':
      branches.size===2?'independent':branches.size===1?'one_branch':'unresolved',mentions:addressed,attributes,conflicts};
  });
}
