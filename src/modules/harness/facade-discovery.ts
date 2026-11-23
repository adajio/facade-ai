import type { Pool, PoolClient } from 'pg';
import { hash, transaction } from '../gateway/types.js';
import { currentPackageSource, currentPackageWindows } from '../gateway/package-slots.js';
import { lockIntakeProject } from '../intake/gate.js';
import type { Observation, ReaderAddress, ReaderLine } from '../pdf/types.js';
import { deliveredLines } from '../questions/attribute-aliases.js';
import { publishProjectEvent } from '../supplements/events.js';
import type { PackageBinding, PackageFact } from './package-analysis.js';

export type FacadeEvidence = {
  factId: string; branch: 'A' | 'B'; evidenceId: string; versionId: string; readerVersion: string;
  address: ReaderAddress; lineId?: string; quote: string;
};
export type FacadeMention = FacadeEvidence & {
  label: string; kind: 'registry' | 'reference' | 'context' | 'designation' | 'unresolved';
  context?: { building: string; axes: string };
  contextQuote?: string;
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
const facadeType = /^(?:facade (?:type|kind)|тип фасада)\s*[:№=]\s*(.+)$/iu;
const registered = /^(?:project facade (?:identifier|id)|идентификатор фасада проекта|код фасада проекта)\s*[:№=]\s*(.+)$/iu;
const referred = /^(?:project facade (?:reference|ref)|ссылка на (?:код|идентификатор) фасада проекта)\s*[:№=]\s*(.+)$/iu;
const designation = /^(?:facade(?:\s+(?:mark|designation|id))?|фасад|(?:марка|обозначение|код) фасада)\s*[:№=]\s*(.+)$/iu;
const inlineDesignation = /^(?:facade|фасад)\s+([\p{L}\p{N}_.\/‐‑‒–—-]+)(?=\s+(?:в\s+|по\s+|in\s+|at\s+|axes\s+|grid\s+|корпус|building|block))/iu;
const buildingField = /^(?:building|block|корпус|здани[ея]|секция)\s*[:№=]\s*(.+)$/iu;
const axesField = /^(?:axes|grid|оси|осях)\s*[:№=]\s*(.+)$/iu;
const inlineBuilding = /(?<!\p{L})(?:корпус(?:а|е)?|здани[еяи]|building|block)\s*[:№=]?\s+([\p{L}\p{N}_.‐‑‒–—-]+)/iu;
const inlineAxes = /(?<!\p{L})(?:в\s+осях|по\s+осям|axes|grid)\s*[:№=]?\s+([\p{L}\p{N}_.\/‐‑‒–—-]+(?:\s*[-‐‑‒–—/]\s*[\p{L}\p{N}_.]+)?)/iu;
const normalize = (value: string) => value.normalize('NFC').trim();
const foldedLabel = (value: string) => normalize(value).toLowerCase().replace(/[‐‑‒–—]/gu,'-').replace(/\s+/gu, ' ');
const printedMark = /^(?=[\p{L}\p{N}_.\/‐‑‒–—-]*\p{N})[\p{L}\p{N}_.\/‐‑‒–—-]+$/u;

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
    const label=uniqueField(part[0],registered)??uniqueField(part[0],referred)??uniqueField(part[0],designation)??uniqueField(part[0],inlineDesignation);
    return label?[{label:foldedLabel(label),at:part.index}]:[];
  });
  const distinct=new Set(anchors.map(({label})=>label));
  const segments=distinct.size<=1?[line]:anchors.flatMap(({label,at},index)=>
    label===mark?[line.slice(at,anchors[index+1]?.at??line.length).replace(/[|;·\s]+$/u,'').trimStart()]:[]);
  const qualified=segments.flatMap((contextQuote)=>{
    const building=uniqueField(contextQuote,buildingField)??uniqueField(contextQuote,inlineBuilding);
    const axes=uniqueField(contextQuote,axesField)??uniqueField(contextQuote,inlineAxes);
    return building&&axes?[{context:{building,axes},contextQuote}]:[];
  });
  const identities=new Set(qualified.map(({context})=>JSON.stringify([foldedLabel(context.building),foldedLabel(context.axes)])));
  return identities.size===1?qualified[0]:undefined;
}

export function collectFacadeMentions(observation: Observation, initial: Pick<PackageBinding,'quote'|'candidates'>,
  reference: FacadeEvidence, lines: ReaderLine[], evidenceByLine: ReadonlyMap<string,string> = new Map()): FacadeMention[] {
  const { quote, lineId } = reference;
  const line = lines.find(({ id, text }) => id === lineId && text.includes(quote));
  const possible = new Set(initial.candidates.map(({ label }) => normalize(label)));
  if (!line || observation.grounding !== 'text') {
    return [...possible].map((label) => ({ ...reference, label, kind: 'unresolved' }));
  }
  const projectMarks = fields(quote, registered);
  const referenceMarks = fields(quote, referred);
  const localMarks = new Set([...fields(quote,designation),...fields(quote,inlineDesignation)]);
  const column = facadeColumn(lines, line);
  for(const label of [...projectMarks,...referenceMarks,...localMarks])possible.add(label);
  if (column && quote === line.text && quote.length <= 160) possible.add(normalize(quote));
  return [...possible].map((label) => {
    const mark = foldedLabel(label);
    const isRegistry = [...projectMarks].some((label)=>foldedLabel(label)===mark);
    const isReference = [...referenceMarks].some((label)=>foldedLabel(label)===mark);
    const isLocal = [...localMarks].some((label)=>foldedLabel(label)===mark);
    const isCell = column && foldedLabel(line.text) === mark;
    const scope=isRegistry||isReference||isLocal ? addressedContext(line.text,mark):undefined;
    const kind = isRegistry ? 'registry' : isReference ? 'reference' : isLocal && scope ? 'context' : isLocal || isCell ? 'designation' : 'unresolved';
    return { ...reference, label, kind, ...scope,
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
  return JSON.stringify([mention.kind,foldedLabel(mention.label),mention.context&&
    [foldedLabel(mention.context.building),foldedLabel(mention.context.axes)]]);
}

export function resolveFacadeMentions(projectId: string, mentions: FacadeMention[],
  established: ReadonlyMap<FacadeMention,{id:string;label:string}> = new Map()) {
  const groups = Map.groupBy(mentions, ({ label }) => foldedLabel(label));
  const resolved = new Map<FacadeMention,{ id: string; label: string }>();
  for (const group of groups.values()) {
    const registries=group.filter(({kind})=>kind==='registry');
    const registerContexts=new Set(registries.flatMap(({context})=>context?
      [JSON.stringify([foldedLabel(context.building),foldedLabel(context.axes)])]:[]));
    const registry = registerContexts.size<=1 ? registries.find(({context})=>context)??registries[0] : undefined;
    const registerId = registry && facadeId(projectId, 'printed-project-facade-id', registry.label);
    const contexts = new Map(group.flatMap(({ context }) => context ?
      [[JSON.stringify([foldedLabel(context.building),foldedLabel(context.axes)]),context] as const] : []));
    for (const item of group) {
      const contextKey = item.context && JSON.stringify([foldedLabel(item.context.building),foldedLabel(item.context.axes)]);
      const registryContext = registry?.context && JSON.stringify([foldedLabel(registry.context.building),foldedLabel(registry.context.axes)]);
      const sameBranch=registries.filter(({branch})=>branch===item.branch);
      const sameLine=sameBranch.some((entry)=>entry.versionId===item.versionId&&entry.address.unitId===item.address.unitId&&
        entry.lineId===item.lineId);
      if (registerId && (item.kind==='registry' || item.kind==='context' && contextKey===registryContext
        || item.kind==='reference' && sameBranch.length>0 && (!contextKey || !registryContext || contextKey===registryContext)
        || item.kind==='designation' && sameLine)) {
        resolved.set(item,{id:registerId,label:registry!.label});
      } else if ((item.kind==='context'||item.kind==='registry') && contextKey) {
        const context = contexts.get(contextKey)!;
        const label = group.find((other) => (other.kind==='context'||other.kind==='registry') && foldedLabel(other.label)===foldedLabel(item.label)
          && other.context && foldedLabel(other.context.building)===foldedLabel(context.building)
          && foldedLabel(other.context.axes)===foldedLabel(context.axes))!.label;
        resolved.set(item,{id:facadeId(projectId,JSON.stringify(['building-axes',context.building,context.axes]),label),label});
      }
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
      WHERE f.project_id=$1 AND discovery.fact_id IS NULL AND ${currentPackageSource}
      ORDER BY f.id LIMIT 32`, [projectId]);
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
    const evidenceId=component?.evidenceId??observation.evidenceId;
    const lineId=component?.lineId??observation.lineId;
    const reference: FacadeEvidence={factId:row.id,branch:observation.branch,
      evidenceId,versionId:observation.source.versionId,readerVersion:observation.readerVersion,
      address:component?.address??observation.address,lineId,quote};
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
  await tx.query('INSERT INTO harness_facade_discovery(fact_id,mentions) VALUES($1,$2) ON CONFLICT DO NOTHING',
    [row.id,JSON.stringify(mentions)]);
}

async function reconcileBindings(tx:PoolClient,projectId:string) {
  const { rows }=await tx.query<{
    id:string; version:number; state:PackageBinding['state']; candidates:PackageBinding['candidates']; quote:string|null;
    actor:string|null; mentions:FacadeMention[]; basis:PackageFact['basis']; revisionStatus:PackageFact['revisionStatus']; resolved:boolean;
    versionId:string; mapFingerprint:string;
  }>(`SELECT f.id,binding.version,binding.state,binding.candidates,binding.quote,binding.actor_id AS actor,d.mentions,
       f.basis,f.revision_status AS "revisionStatus",d.resolved,o.version_id AS "versionId",w.map_fingerprint AS "mapFingerprint"
    FROM ${activeDiscoveryFacts} JOIN harness_facade_discovery d ON d.fact_id=f.id
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
        const kind=row.revisionStatus==='current'&&row.basis.stage ? uniqueField(mention.quote,facadeType) : undefined;
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
    await tx.query(`INSERT INTO harness_package_bindings(fact_id,version,state,candidates,quote,reason)
      VALUES($1,$2,$3,$4,$5,$6)`,[row.id,row.version+1,state,JSON.stringify(candidates),row.quote,
      state==='identified'?'Обозначение связано с адресным проектным идентификатором или контекстом корпуса и осей.'
        :'Адресное упоминание не устанавливает однозначную принадлежность фасаду.']);
  }
  const stored=await tx.query<{facade_id:string;fingerprint:string}>(
    'SELECT facade_id,fingerprint FROM harness_facade_profile_proofs WHERE project_id=$1',[projectId]);
  const previous=new Map(stored.rows.map(({facade_id,fingerprint})=>[facade_id,fingerprint]));
  const changed:string[]=[];
  for(const [id,items] of proof) {
    const fingerprint=hash([...items.claims].sort());
    if(previous.get(id)!==fingerprint) {
      await tx.query(`INSERT INTO harness_facade_profile_proofs(project_id,facade_id,fingerprint,version_ids) VALUES($1,$2,$3,$4)
        ON CONFLICT(project_id,facade_id) DO UPDATE SET fingerprint=EXCLUDED.fingerprint,version_ids=EXCLUDED.version_ids`,
        [projectId,id,fingerprint,[...items.versions]]);
      changed.push(id);
    }
    previous.delete(id);
  }
  if(previous.size) {
    changed.push(...previous.keys());
    await tx.query('DELETE FROM harness_facade_profile_proofs WHERE project_id=$1 AND facade_id=ANY($2)',[projectId,[...previous.keys()]]);
  }
  if(changed.length) {
    await tx.query(`INSERT INTO harness_semantic_scope_epochs(project_id,scope_key,epoch)
      SELECT $1,id,1 FROM unnest($2::text[]) id ON CONFLICT(project_id,scope_key)
      DO UPDATE SET epoch=harness_semantic_scope_epochs.epoch+1`,[projectId,changed]);
    await publishProjectEvent(tx,projectId,{type:'package-analysis.changed',payload:{}});
  }
  const completed=await tx.query(`UPDATE harness_facade_discovery SET resolved=true WHERE NOT resolved AND fact_id=ANY($1::uuid[])`,
    [rows.map(({id})=>id)]);
  if(completed.rowCount&&!changed.length)await publishProjectEvent(tx,projectId,{type:'package-analysis.changed',payload:{}});
}

export function buildFacadeProfiles(facts: PackageFact[], mentions: FacadeMention[], candidates: PackageBinding['candidates']): FacadeProfile[] {
  const byFact=Map.groupBy(mentions,({factId})=>factId);
  return candidates.map(({id,label})=>{
    const relevant=facts.filter((f)=>f.binding.state==='identified'&&f.binding.candidates.some((c)=>c.id===id));
    const addressed=relevant.flatMap((f)=>(byFact.get(f.id)??[])
      .filter((mention)=>mention.kind!=='unresolved'&&foldedLabel(mention.label)===foldedLabel(label)));
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
      attach('building',m.context?.building,context);
      attach('axes',m.context?.axes,context);
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
        return component&&part?{...anchor,...part,address:component.address}: {...anchor,quote:quote??anchor.quote};
      };
      if(basis.stage)attach('stage',fact.designStage,ref('stage',basis.stage));
      if(basis.revision)attach('revision',fact.revision,ref('revision',basis.revision),fact.revisionStatus);
      if(basis.role&&fact.sourceRole!=='unknown') {
        attach('documentRole',fact.sourceRole,ref('role',basis.role));
        if(fact.revisionStatus==='current')attach('facadeKind',uniqueField(o.quote,facadeType),anchor);
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
