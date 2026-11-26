import type { Pool, PoolClient } from 'pg';
import { allowsCatalogPair } from '../access/catalog-comparison.js';
import { getCatalog, getProject, matchesDefaultProfile } from '../access/project-state.js';
import type { CatalogRequirement } from '../access/input.js';
import type { Branch, PackageBlock, PackageSemanticCheck, Place } from './contracts.js';
import type { Observation } from '../pdf/types.js';
import { compareCitationValues, type VerifiedPairEvidence } from '../assessment/domain.js';
import { printedPairVariant } from './pair-evidence.js';
import { currentFacadeScopes } from './package-walk.js';
import { buildFacadeProfiles, facadeDiscoveryVersion, type FacadeMention, type FacadeProfile } from './facade-discovery.js';

export const originalPackageRoles = ['drawing', 'detail', 'schedule', 'specification', 'calculation', 'inventory',
  'correspondence', 'model', 'other', 'unknown'] as const;
export const packageRoles = [...originalPackageRoles, 'brief', 'certificate', 'test_report', 'design'] as const;
export type PackageSourceRole = typeof packageRoles[number];

export interface PackageBinding {
  state: 'identified' | 'common' | 'unclear' | 'unidentified';
  candidates: { id: string; label: string }[];
  quote: string | null;
  reason: string;
  version: number;
  actorId: string | null;
}

export interface PackageFact {
  id: string;
  branch: Branch;
  windowId: string;
  observation: Observation;
  evidenceHref: string;
  attribute: string | null;
  sourceRole: PackageSourceRole;
  designStage: string | null;
  revision: string | null;
  variant: string | null;
  revisionStatus: 'current' | 'superseded' | 'unknown';
  basis: { role?: string; stage?: string; revision?: string;
    revisionEvidence?: { evidenceId: string; quote: string; lineId?: string; href: string };
    valueRole?: {kind:'design'|'as_built'|'limit';quote:string};
    deliveryLine?: {
      text: string; canonicalSha256: string; source: Observation['source'];
      runId: string; branch: Branch; readerVersion: string; unitId: string; lineId: string;
      box: NonNullable<Observation['address']['box']>; anchorEvidenceId: string; submittedEvidenceId: string;
      crops: { evidenceId: string; text: string; frame: NonNullable<Observation['address']['box']>;
        box: NonNullable<Observation['address']['box']> }[];
    };
    parts?: Partial<Record<'attribute'|'role'|'stage'|'revision'|'binding'|'valueRole',
      {evidenceId:string;lineId:string;quote:string;address?:Observation['address']}>> };
  binding: PackageBinding;
  materials: { id: string; label: string; quote: string }[];
}

export interface PackageWalkState {
  status:'pending'|'ready';
  limitation:string|null;
  blocks:PackageBlock[];
  branches:Record<Branch,{
    reviewed:{blockId:string;evidenceId:string}[];
    remaining:{blockId:string;reason:string}[];
    complete:boolean;
    followup:{jobId:string;status:string;reason:string|null}|null;
    completedFollowupId:string|null;
    profileScan?:{reviewed:string[];remaining:string[]};
  }>;
}

export interface PackageWindow {
  id: string;
  place: Place;
  readerVersion: string | null;
  format: string;
  structure?: PackageWalkState;
  branches: Record<Branch, {
    status: 'pending' | 'queued' | 'reading' | 'held' | 'covered' | 'reviewed_no_match' | 'refused';
    reason: string | null;
    jobId: string | null;
    nextAction: string | null;
  }>;
}

export interface PackageComparison {
  aFactId: string;
  bFactId: string;
  status: 'agreement' | 'reading_disagreement' | 'applicability_unclear';
}

export interface PackageAnalysis {
  facts: PackageFact[];
  semanticChecks: PackageSemanticCheck[];
  candidates: PackageBinding['candidates'];
  facadeProfiles: FacadeProfile[];
  facadeMentions: FacadeMention[];
  windows: PackageWindow[];
  comparisons: PackageComparison[];
  reviewCandidates: { a: string; b: string; property: string; scope: { id: string; label: string };catalogVersionId?:string;stage?:string }[];
  comparisonFollowups: string[];
  verifiedPairs: { a: string; b: string; proof: VerifiedPairEvidence;
    titles: { A: ReviewTitle | null; B: ReviewTitle | null } }[];
  coverage: {
    inventory: 'open' | 'closed';
    acceptedVersions: number;
    mappedVersions: number;
    refusedVersions: number;
    pendingVersions: number;
    completedWindows: number;
    structurallyReviewedWindows: number;
    physicalBoundary: 'mapped_places' | 'verified';
    facadeBoundary: 'observed_facades' | 'verified';
    physicalProof: PackageCoverageProof | null;
    physicalLimitations: { versionId: string; reason: string }[];
    subjectProof: (PackageCoverageProof & { facadeIds: string[]; commonChecked: boolean }) | null;
  };
}

type ReviewTitle = { evidenceId: string; quote: string; lineId?: string };

interface PackageCoverageProof {
  versionIds: string[];
  basisIds: string[];
}

type FactRow = Omit<PackageFact, 'variant' | 'evidenceHref'> & {
  register: { quote: string; commonChecked: boolean } | null; mentions: FacadeMention[] | null;
};
type WindowRow = Omit<PackageWindow, 'branches'> & {
  branch: Branch | null;
  walk: boolean;
  state: 'ready' | 'leased' | 'held' | 'done' | null;
  jobId: string | null;
  outcome: { kind?: string; reason?: string } | null;
  reason: string | null;
  nextAction: string | null;
  blocker: string | null;
  blockerState: string | null;
  mapRefusal: string | null;
};

const accepted = `SELECT DISTINCT o.version_id FROM intake_occurrences o
  WHERE o.project_id=$1 AND o.state='accepted' AND NOT EXISTS (
    SELECT 1 FROM intake_document_versions successor JOIN intake_occurrences other
      ON other.version_id=successor.id AND other.project_id=successor.project_id AND other.state='accepted'
    WHERE successor.project_id=$1 AND successor.replaces_version_id=o.version_id
  )`;

function branchState(row: WindowRow): PackageWindow['branches'][Branch] {
  const { state, reason, outcome, jobId, nextAction, blocker, mapRefusal } = row;
  if (mapRefusal) return { status: 'refused', reason: mapRefusal, jobId: null, nextAction: null };
  if (blocker) return { status: 'held', reason: row.blockerState === 'paid' ? 'prior_paid_window_incompatible'
    : row.blockerState === 'unknown' || row.blockerState === 'sending' ? 'prior_effect_unsettled' : 'prior_effect_reserved', jobId: null,
    nextAction: `Сверить исходную работу ${blocker}.` };
  if (state === 'done') {
    const status = outcome?.kind === 'covered' ? 'covered' :
      outcome?.kind === 'reviewed_no_match' ? 'reviewed_no_match' : 'refused';
    return { status, reason: outcome?.reason ?? null, jobId, nextAction };
  }
  return { status: state === 'leased' ? 'reading' : state === 'held' ? 'held' : state === 'ready' ? 'queued' : 'pending',
    reason: reason ?? (!state ? 'awaiting_profile_or_slot' : null), jobId, nextAction };
}

function projectWindows(rows: WindowRow[]): PackageWindow[] {
  const windows = new Map<string, PackageWindow>();
  for (const row of rows) {
    let window = windows.get(row.id);
    if (!window) {
      const initial = branchState({ ...row, state: null, blocker: null, jobId: null, reason: null, nextAction: null });
      window = { id: row.id, place: row.place, readerVersion: row.readerVersion, format: row.format,
        branches: { A: initial, B: initial } };
      windows.set(row.id, window);
    }
    if (row.branch) window.branches[row.branch] = branchState(row);
  }
  return [...windows.values()];
}

function bindingScope(a: PackageFact, b: PackageFact) {
  if (a.binding.state === 'common' && b.binding.state === 'common') return { id: 'common', label: 'common' };
  if (a.binding.state !== 'identified' || b.binding.state !== 'identified') return;
  const ids = a.binding.candidates.filter(({ id }) => b.binding.candidates.some((candidate) => candidate.id === id));
  return ids.length === 1 ? ids[0] : undefined;
}

function hasKnownFacade({ binding }: PackageFact) {
  return binding.state === 'identified' && binding.candidates.length === 1;
}

function comparisonFollowup(a: PackageFact, b: PackageFact, scope: ReturnType<typeof bindingScope>) {
  const left = a.observation;
  const right = b.observation;
  if ([a, b].some(({ observation, sourceRole, revisionStatus }) => observation.grounding !== 'text' ||
    !observation.quote || !observation.lineId || !observation.unit || revisionStatus === 'superseded' ||
    ['other', 'inventory', 'correspondence'].includes(sourceRole)) ||
    left.source.projectId !== right.source.projectId || left.source.documentId === right.source.documentId ||
    left.source.sha256 === right.source.sha256 ||
    a.variant && b.variant && a.variant !== b.variant ||
    a.designStage && b.designStage && normalizeAttribute(a.designStage) !== normalizeAttribute(b.designStage) ||
    a.basis.valueRole && b.basis.valueRole && a.basis.valueRole.kind !== b.basis.valueRole.kind ||
    compareCitationValues({ value: left.value ?? null, unit: left.unit ?? null },
      { value: right.value ?? null, unit: right.unit ?? null }) !== 'different') return [];
  if (!scope) {
    const unbound = (fact: PackageFact) => ['unidentified', 'unclear'].includes(fact.binding.state) && !fact.binding.candidates.length;
    if (hasKnownFacade(a) && unbound(b)) return [b];
    if (hasKnownFacade(b) && unbound(a)) return [a];
    return [];
  }
  return [a, b].filter((fact) => (fact.binding.state !== 'common' && !hasKnownFacade(fact)) ||
    !fact.basis.role || fact.sourceRole === 'unknown' || !fact.designStage || fact.revisionStatus === 'unknown' || !fact.variant);
}

type ComparisonCatalog={versionId:string;stage:string|null;requirements:CatalogRequirement[];facadeKinds?:ReadonlyMap<string,string>};

function pairCandidate(a: PackageFact, b: PackageFact, scope: { id: string; label: string } | undefined,
  property:string,catalog?:ComparisonCatalog) {
  const left = a.observation;
  const right = b.observation;
  if (!scope || !left.quote || !right.quote || left.grounding !== 'text' || right.grounding !== 'text' ||
    left.source.documentId === right.source.documentId || left.source.sha256 === right.source.sha256 ||
    !a.basis.role || !b.basis.role ||
    [a,b].some(({sourceRole})=>['other','inventory','correspondence','unknown'].includes(sourceRole)) ||
    a.revisionStatus === 'superseded' || b.revisionStatus === 'superseded' ||
    (a.variant && b.variant && a.variant !== b.variant) ||
    (a.designStage && b.designStage && a.designStage !== b.designStage)) return;
  const facadeKind=catalog?.facadeKinds?.get(scope.id);
  const rules=catalog?.requirements.filter((rule)=>normalizeAttribute(rule.part)===normalizeAttribute(property)&&
    (!rule.level||rule.level===(scope.id==='common'?'common':'facade'))&&
    (!rule.facadeKinds?.length||Boolean(facadeKind&&rule.facadeKinds.includes(facadeKind))))??[];
  const rule=rules.length===1?rules[0]:undefined;
  const crossRole=a.sourceRole!==b.sourceRole;
  const roles=[a,b].map(({sourceRole,basis})=>({sourceRole,valueRole:basis.valueRole?.kind}));
  if(!allowsCatalogPair(rule?.comparison,roles[0],roles[1]))return;
  if(crossRole&&(!rule?.comparison||!catalog?.stage||
    ![a,b].every(({designStage})=>designStage&&normalizeAttribute(designStage)===normalizeAttribute(catalog.stage!))))return;
  return { a: a.id, b: b.id, scope,...(rule?.comparison&&catalog?.stage?{catalogVersionId:catalog.versionId,stage:catalog.stage}:{}) };
}

function normalizeAttribute(value: string) {
  return value.normalize('NFKC').trim().toLowerCase().replace(/\s+/gu, ' ');
}

export function packageCatalogAliases(requirements: Pick<CatalogRequirement, 'key' | 'part' | 'aliases'>[]) {
  const distinct = new Map<string, Map<string, string>>();
  for (const { key, part, aliases } of requirements) {
    for (const text of [part, ...(aliases ?? [])]) {
      const name = normalizeAttribute(text);
      const positions = distinct.get(name) ?? new Map<string, string>();
      positions.set(key, part);
      distinct.set(name, positions);
    }
  }
  return new Map([...distinct].flatMap(([name, positions]) =>
    positions.size === 1 ? [[name, positions.values().next().value!] as const] : []));
}

async function approvedComparisonCatalog(db: Pool | PoolClient, projectId: string):Promise<ComparisonCatalog|undefined> {
  const project = await getProject(db, projectId);
  if (!project.catalogVersionId) return;
  const catalog = await getCatalog(db, project.organizationId, project.catalogVersionId);
  if (project.intakeMode && !matchesDefaultProfile(project, catalog)) return;
  return {versionId:catalog.id,stage:project.stage,requirements:catalog.requirements.filter(({applicability})=>{
    const rule=normalizeAttribute(applicability);
    return ['all','applicable','*','все','для всех','все фасады'].includes(rule)||
      rule.startsWith('stage:')&&normalizeAttribute(project.stage??'')===rule.slice(6).trim();
  })};
}

const lengthPowers = new Map([['m', 3], ['м', 3], ['cm', 1], ['см', 1], ['mm', 0], ['мм', 0]]);

function possibleDisagreement(left: Observation, right: Observation) {
  if (left.value === undefined || right.value === undefined || Boolean(left.unit) !== Boolean(right.unit)) return false;
  const [a, b] = [left, right].map(({ value, unit }) => ({
    literal: value!.trim().normalize('NFC'), unit: unit?.trim() ?? '',
  }));
  const leftPower = lengthPowers.get(a.unit);
  const rightPower = lengthPowers.get(b.unit);
  const numeric = /^([+-]?)(\d{1,48})(?:[.,](\d{1,48}))?$/u;
  const l = numeric.exec(a.literal);
  const r = numeric.exec(b.literal);
  if (l && r && (a.unit === b.unit || leftPower !== undefined && rightPower !== undefined)) {
    const fractionA = l[3] ?? '';
    const fractionB = r[3] ?? '';
    const exponentA = (leftPower ?? 0) - fractionA.length;
    const exponentB = (rightPower ?? 0) - fractionB.length;
    const exponent = Math.min(exponentA, exponentB);
    return BigInt(l[1] + l[2] + fractionA) * 10n ** BigInt(exponentA - exponent) !==
      BigInt(r[1] + r[2] + fractionB) * 10n ** BigInt(exponentB - exponent);
  }
  return a.unit !== b.unit || a.literal !== b.literal;
}

export function comparePackageFacts(facts: PackageFact[], aliases: ReadonlyMap<string, string> = new Map(), catalog?:ComparisonCatalog) {
  const comparisons: PackageComparison[] = [];
  const reviewCandidates: PackageAnalysis['reviewCandidates'] = [];
  const comparisonFollowups = new Set<string>();
  const grouped = new Map<string, { A: PackageFact[]; B: PackageFact[]; property: string }>();
  for (const fact of facts) {
    if (!fact.attribute || fact.observation.grounding === 'limited' || fact.observation.limitation) continue;
    const property = aliases.get(normalizeAttribute(fact.attribute)) ?? fact.attribute;
    const key = normalizeAttribute(property);
    const group = grouped.get(key) ?? { A: [], B: [], property };
    group[fact.branch].push(fact);
    grouped.set(key, group);
  }
  // Bound the interactive pair list. Assessment separately uses the complete evidence set.
  for (const { A, B, property } of grouped.values()) {
    for (const a of A) for (const b of B) {
      const left = a.observation;
      const right = b.observation;
      const sameLocation = left.source.versionId === right.source.versionId &&
        left.address.unitId === right.address.unitId && left.lineId && left.lineId === right.lineId;
      const scope = bindingScope(a, b);
      const different = possibleDisagreement(left, right);
      const proposal = different ? pairCandidate(a, b, scope,property,catalog) : undefined;
      if (proposal) reviewCandidates.push({ ...proposal, property });
      else if (different) for (const target of comparisonFollowup(a, b, scope)) comparisonFollowups.add(target.id);
      if (!sameLocation && !scope) continue;
      if (comparisons.length >= 200) continue;
      const comparable = sameLocation && left.unit === right.unit && a.variant === b.variant;
      const equal = !different && (left.value === undefined) === (right.value === undefined) &&
        left.deliveryStatement?.status === right.deliveryStatement?.status;
      comparisons.push({ aFactId: a.id, bFactId: b.id, status: comparable ? equal ? 'agreement' : 'reading_disagreement'
        : 'applicability_unclear' });
    }
  }
  return { comparisons, reviewCandidates, comparisonFollowups: [...comparisonFollowups] };
}

async function packageFactRows(db: Pool | PoolClient, projectId: string) {
  return (await db.query<FactRow>(
    `WITH accepted AS (${accepted})
     SELECT f.id,o.branch,f.window_id AS "windowId",o.payload AS observation,f.attribute,f.source_role AS "sourceRole",
       f.design_stage AS "designStage",f.revision,f.revision_status AS "revisionStatus",f.basis,f.materials,f.subject_register AS register,d.mentions,
       jsonb_build_object('state',CASE WHEN b.state IN ('identified','unclear') AND (stale.yes OR b.actor_id IS NULL AND NOT coalesce(d.resolved,false))
         THEN 'unclear' ELSE b.state END,'quote',b.quote,'reason',CASE WHEN stale.yes THEN 'Зависимая опора заменена.' ELSE b.reason END,
         'candidates',CASE WHEN NOT stale.yes AND (b.actor_id IS NOT NULL OR d.resolved) THEN b.candidates ELSE '[]'::jsonb END,
         'version',b.version,'actorId',b.actor_id) AS binding
     FROM harness_package_facts f JOIN reader_observations o ON o.id=f.id
     JOIN accepted a ON a.version_id=o.version_id
     LEFT JOIN harness_package_followups followup ON followup.job_id=f.job_id
     JOIN harness_package_branches active ON active.job_id=coalesce(followup.root_job_id,f.job_id) AND active.active
     JOIN harness_package_windows w ON w.id=f.window_id
     JOIN harness_package_maps m ON m.version_id=w.version_id AND m.fingerprint=w.map_fingerprint AND m.active
     LEFT JOIN harness_facade_discovery d ON d.fact_id=f.id AND d.discovery_version=${facadeDiscoveryVersion}
     JOIN LATERAL (SELECT * FROM harness_package_bindings h WHERE h.fact_id=f.id ORDER BY version DESC LIMIT 1) b ON true
     CROSS JOIN LATERAL (SELECT EXISTS(SELECT 1 FROM harness_stale_facade_profiles stale
       CROSS JOIN LATERAL jsonb_array_elements(b.candidates) candidate
       WHERE b.actor_id IS NULL AND stale.project_id=f.project_id AND stale.facade_id::text=candidate->>'id') AS yes) stale
     WHERE f.project_id=$1 ORDER BY o.created_at,f.id`, [projectId])).rows;
}

function packageFact(row: FactRow): PackageFact {
  const { register, mentions, ...fact } = row;
  return {
    ...fact, evidenceHref: `/api/v1/evidence/${fact.observation.evidenceId}`,
    variant: (fact.observation.grounding === 'text' && fact.observation.quote ?
      printedPairVariant(fact.observation.quote) : null) ?? fact.observation.components?.find(({ role }) => role === 'variant')?.literal ?? null,
  };
}

async function compareCurrentPackageFacts(db: Pool | PoolClient, projectId: string, facts: PackageFact[]) {
  const catalog=facts.length?await approvedComparisonCatalog(db,projectId):undefined;
  if(catalog?.stage&&catalog.requirements.some(({facadeKinds})=>facadeKinds?.length)) {
    const {rows:kinds}=await db.query<{id:string;kind:string}>(
      `SELECT DISTINCT id,kind FROM (${currentFacadeScopes('$1','$2::text')}) facade WHERE kind IS NOT NULL`,
      [projectId,catalog.stage]);
    catalog.facadeKinds=new Map(kinds.map(({id,kind})=>[id,kind]));
  }
  return comparePackageFacts(facts,catalog&&packageCatalogAliases(catalog.requirements),catalog);
}

export async function readComparisonTargets(db: PoolClient, projectId: string) {
  const facts = (await packageFactRows(db, projectId)).map(packageFact);
  const { comparisonFollowups } = await compareCurrentPackageFacts(db, projectId, facts);
  const eligible = new Set(comparisonFollowups);
  return facts.filter(({ id }) => eligible.has(id));
}

export async function readPackageAnalysis(db: Pool | PoolClient, projectId: string): Promise<PackageAnalysis> {
  // The assessment caller supplies its existing transaction.
  const args = [projectId];
  const versions = await db.query<{ id: string; refusal: string | null; basis: string | null; limitation: string | null }>(
    `WITH accepted AS (${accepted}) SELECT a.version_id AS id,m.refusal,m.physical_basis_id AS basis,
        coalesce(m.physical_limitation,r.reason) AS limitation
       FROM accepted a LEFT JOIN harness_package_maps m ON m.version_id=a.version_id AND m.active
       LEFT JOIN harness_package_map_retries r ON r.version_id=a.version_id
       ORDER BY a.version_id`, args);
  const { rows: windowRows } = await db.query<WindowRow>(
    `WITH accepted AS (${accepted})
     SELECT w.id,w.place,m.reader_version AS "readerVersion",m.format,
       b.branch,j.state,j.id AS "jobId",j.result AS outcome,j.reason,j.next_action AS "nextAction",
       coalesce(j.payload#>>'{packageWindow,walkProtocol}'='1',false) AS walk,
       CASE WHEN prior.state IS NOT NULL THEN b.blocker_job_id END AS blocker,prior.state AS "blockerState",
       m.refusal AS "mapRefusal"
     FROM accepted a JOIN harness_package_maps m ON m.version_id=a.version_id AND m.active
     JOIN harness_package_windows w ON w.version_id=m.version_id AND w.map_fingerprint=m.fingerprint
     LEFT JOIN harness_package_branches b ON b.window_id=w.id AND b.active
     LEFT JOIN gateway_jobs j ON j.id=b.job_id
     LEFT JOIN LATERAL (SELECT a.state FROM gateway_attempts a WHERE a.job_id=b.blocker_job_id
       AND a.state IN ('reserved','prepared','sending','unknown','paid')
       ORDER BY CASE WHEN a.state IN ('sending','unknown') THEN 0 WHEN a.state='paid' THEN 1 ELSE 2 END, a.created_at LIMIT 1
     ) prior ON true
     ORDER BY w.version_id,w.ordinal,b.branch`, args);
  const rows = await packageFactRows(db, projectId);
  const { rows: [inventory] } = await db.query<{ closed: boolean }>(
    `SELECT EXISTS(SELECT 1 FROM intake_receipts WHERE project_id=$1) AND NOT EXISTS (
       SELECT 1 FROM intake_receipts r WHERE r.project_id=$1 AND (r.sealed_at IS NULL OR EXISTS (
         SELECT 1 FROM intake_occurrences o WHERE o.receipt_id=r.id AND (o.inventory_pending OR o.state='declared')
       ) OR EXISTS (SELECT 1 FROM intake_imports i WHERE i.receipt_id=r.id AND i.state IN ('queued','running','paused')))
     ) AS closed`, args);
  const windows = projectWindows(windowRows);
  const walkIds=[...new Set(windowRows.filter(({walk})=>walk).map(({id})=>id))];
  const {rows:walkRows}=walkIds.length?await db.query<{
    id:string;blocks:PackageBlock[]|null;limitation:string|null;branch:Branch;
    checks:{blockId:string;evidenceId:string;reviewed:boolean;reason:string;profileScan:boolean}[];profileBlocks:string[]|null;
    childId:string|null;childState:string|null;childReason:string|null;completedFollowupId:string|null;
  }>(
    `SELECT b.window_id AS id,s.blocks,s.limitation,b.branch,
       coalesce(checked.items,'[]') AS checks,child.id AS "childId",child.state AS "childState",child.reason AS "childReason",
       closed.id AS "completedFollowupId",scan.blocks AS "profileBlocks"
     FROM harness_package_branches b LEFT JOIN harness_package_structures s ON s.window_id=b.window_id
     LEFT JOIN LATERAL (
       SELECT j.id,j.state,coalesce(j.reason,j.result->>'reason') AS reason FROM harness_package_followups f JOIN gateway_jobs j ON j.id=f.job_id
       WHERE f.root_job_id=b.job_id ORDER BY j.created_at DESC,j.id LIMIT 1
     ) child ON true
     LEFT JOIN LATERAL (
       SELECT j.id FROM harness_package_followups f JOIN gateway_jobs j ON j.id=f.job_id
       WHERE f.root_job_id=b.job_id AND f.plan_key LIKE 'blocks:%' AND j.state='done'
         AND j.result->>'kind' IN ('covered','reviewed_no_match')
         AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(s.blocks) block WHERE NOT EXISTS (
           SELECT 1 FROM harness_package_block_checks proof WHERE proof.block_id=block->>'id' AND proof.reviewed
             AND (proof.job_id=b.job_id OR EXISTS (
               SELECT 1 FROM harness_package_followups earlier JOIN gateway_jobs step ON step.id=earlier.job_id
               WHERE earlier.root_job_id=b.job_id AND earlier.job_id=proof.job_id
                 AND (step.created_at,step.id)<=(j.created_at,j.id)
                 AND (step.state='done' OR step.state='held' AND step.reason='turn_limit_final')))
         ))
       ORDER BY j.created_at DESC,j.id LIMIT 1
     ) closed ON true
     LEFT JOIN LATERAL (
       SELECT array_agg(DISTINCT block_id ORDER BY block_id) AS blocks FROM harness_package_followups f
       JOIN gateway_jobs j ON j.id=f.job_id
       CROSS JOIN LATERAL jsonb_array_elements_text(coalesce(j.payload#>'{packageWindow,followup,discovery,candidateBlocks}',f.blocks)) block_id
       WHERE f.root_job_id=b.job_id AND f.plan_key LIKE 'facade-profile-scan:%'
     ) scan ON true
     LEFT JOIN LATERAL (
       SELECT jsonb_agg(jsonb_build_object('blockId',c.block_id,'evidenceId',c.evidence_id,'reviewed',c.reviewed,'reason',c.reason,
         'profileScan',coalesce(history.plan_key LIKE 'facade-profile-scan:%' AND history.blocks?c.block_id,false))
         ORDER BY c.job_id IS DISTINCT FROM child.id,c.reviewed DESC) AS items
       FROM harness_package_block_checks c LEFT JOIN harness_package_followups history
         ON history.root_job_id=b.job_id AND history.job_id=c.job_id WHERE c.job_id=b.job_id OR history.job_id IS NOT NULL
     ) checked ON true WHERE b.active AND b.window_id=ANY($1::uuid[])`,[walkIds]):{rows:[]};
  const byWindow=new Map(windows.map((window)=>[window.id,window]));
  for(const row of walkRows) {
    const window=byWindow.get(row.id)!;
    const waiting={reviewed:[],remaining:[],complete:false,followup:null,completedFollowupId:null};
    const structure=window.structure??={status:row.blocks?'ready':'pending',limitation:row.limitation,blocks:row.blocks??[],
      branches:{A:waiting,B:waiting}};
    const reviewed=structure.blocks.flatMap(({id})=>{
      const check=row.checks.find((check)=>check.blockId===id&&check.reviewed);
      return check?[{blockId:id,evidenceId:check.evidenceId}]:[];
    });
    const remaining=structure.blocks.filter(({id})=>!reviewed.some(({blockId})=>blockId===id)).map(({id})=>({
      blockId:id,reason:row.checks.find((check)=>check.blockId===id)?.reason??'block_not_reviewed',
    }));
    const complete=structure.status==='ready'&&Boolean(structure.blocks.length)&&!remaining.length&&!structure.limitation;
    const profileReviewed=row.profileBlocks?.filter((blockId)=>row.checks.some((check)=>check.blockId===blockId&&check.reviewed&&check.profileScan));
    structure.branches[row.branch]={reviewed,remaining,complete,
      followup:row.childId?{jobId:row.childId,status:row.childState!,reason:row.childReason}:null,
      completedFollowupId:complete?row.completedFollowupId:null,
      ...(row.profileBlocks&&profileReviewed?{profileScan:{reviewed:profileReviewed,
        remaining:row.profileBlocks.filter((blockId)=>!profileReviewed.includes(blockId))}}:{})};
  }
  const {rows:semanticChecks}=walkIds.length?await db.query<PackageSemanticCheck>(
    `SELECT s.window_id AS "windowId",s.branch,s.job_id AS "jobId",b.job_id AS "primaryJobId",s.reader_version AS "readerVersion",
       s.facade_id AS "facadeId",s.position_id AS "positionId",s.catalog_version_id AS "catalogVersionId",s.stage,s.basis_ids AS "basisIds",s.disposition,s.subject,s.reason
     FROM harness_package_semantic_checks s JOIN gateway_jobs job ON job.id=s.job_id
     JOIN projects p ON p.id=job.project_id AND p.catalog_version_id=s.catalog_version_id AND p.project_stage=s.stage
     LEFT JOIN harness_semantic_epochs epoch ON epoch.project_id=p.id
     LEFT JOIN harness_semantic_scope_epochs scope_epoch ON scope_epoch.project_id=p.id
       AND scope_epoch.scope_key=coalesce(s.facade_id::text,'common')
     LEFT JOIN harness_package_followups f ON f.job_id=s.job_id
     JOIN harness_package_branches b ON b.job_id=coalesce(f.root_job_id,s.job_id) AND b.active
     WHERE s.window_id=ANY($1::uuid[]) AND p.id=$2 AND s.applicability_epoch=coalesce(epoch.epoch,0)
       AND s.scope_epoch=coalesce(scope_epoch.epoch,0)
       AND NOT EXISTS(SELECT 1 FROM harness_stale_facade_profiles stale WHERE stale.project_id=p.id AND stale.facade_id=s.facade_id)
       AND NOT EXISTS (
       SELECT 1 FROM unnest(s.basis_ids) item(id)
       JOIN LATERAL (SELECT state,candidates FROM harness_package_bindings x WHERE x.fact_id=item.id ORDER BY version DESC LIMIT 1) current ON true
       WHERE (s.facade_id IS NULL AND current.state<>'common') OR (s.facade_id IS NOT NULL AND
         (current.state<>'identified' OR NOT EXISTS(SELECT 1 FROM jsonb_array_elements(current.candidates) c WHERE c->>'id'=s.facade_id::text)))
     ) ORDER BY s.window_id,s.branch,s.position_id`,[walkIds,projectId]):{rows:[]};

  const facts = rows.map(packageFact);
  const candidates = [...new Map(facts.flatMap(({ binding }) => binding.candidates)
    .map((candidate) => [candidate.id, candidate])).values()];
  const facadeMentions=rows.flatMap(({mentions})=>mentions??[]);
  const facadeProfiles=buildFacadeProfiles(facts,facadeMentions,candidates);
  const completedWindows = windows.filter(({ branches,structure }) => (['A','B'] as const).every((key)=>{
    const {status,reason}=branches[key];
    return status==='covered'||status==='reviewed_no_match'||
      (status==='held'&&reason==='turn_limit_final'&&Boolean(structure?.branches[key].completedFollowupId));
  })).length;
  const structurallyReviewedWindows=windows.filter(({structure})=>structure?.branches.A.complete&&structure.branches.B.complete).length;
  const versionIds = versions.rows.map(({ id }) => id);
  const physicalProof = versionIds.length && versions.rows.every(({ basis }) => basis)
    ? { versionIds, basisIds: versions.rows.map(({ basis }) => basis!) } : null;
  const facadeIds = candidates.map(({ id }) => id).sort();
  const registers = rows.filter((fact) => fact.register?.commonChecked && fact.binding.state === 'identified' &&
    fact.revisionStatus === 'current' && Boolean(fact.basis.role && fact.basis.revision) &&
    (fact.sourceRole === 'schedule' || fact.sourceRole === 'inventory') &&
    JSON.stringify(fact.binding.candidates.map(({ id }) => id).sort()) === JSON.stringify(facadeIds));
  const a = registers.find((fact) => fact.branch === 'A');
  const b = a && registers.find((fact) => fact.branch === 'B' && fact.observation.runId !== a.observation.runId &&
    fact.observation.source.versionId === a.observation.source.versionId &&
    fact.observation.address.unitId === a.observation.address.unitId && fact.register?.quote === a.register?.quote);
  const subjectProof = a && b && inventory.closed && physicalProof && completedWindows === windows.length &&
    windows.every(({structure})=>!structure||structure.branches.A.complete&&structure.branches.B.complete) &&
    !facts.some(({ binding, attribute, observation, materials }) => binding.state === 'unclear' ||
      (binding.state === 'unidentified' && (attribute || observation.value !== undefined || materials.length)))
    ? { versionIds, basisIds: [a.id, b.id], facadeIds, commonChecked: true } : null;
  const mappedVersions = new Set(windows.map(({ place }) => place.source.versionId)).size;
  const comparison = await compareCurrentPackageFacts(db, projectId, facts);
  const reviewed = await db.query<PackageAnalysis['verifiedPairs'][number]>(
    `SELECT p.a_fact_id AS a,p.b_fact_id AS b,p.proof,
       jsonb_build_object('A',a_title.title,'B',b_title.title) AS titles
     FROM harness_package_review_pairs p
     JOIN gateway_jobs lead ON lead.id=p.lead_job_id AND lead.state='done'
     JOIN gateway_jobs a ON a.id=p.a_job_id AND a.state='done'
     JOIN gateway_jobs b ON b.id=p.b_job_id AND b.state='done'
     JOIN reader_observations oa ON oa.id=p.a_fact_id JOIN reader_observations ob ON ob.id=p.b_fact_id
     LEFT JOIN LATERAL (
       SELECT source AS title FROM jsonb_array_elements(lead.result#>'{checks,revision,sources}') AS asks(source)
       JOIN reader_evidence e ON e.id::text=source->>'evidenceId' AND e.run_id=lead.id AND e.version_id=oa.version_id
       ORDER BY e.created_at,e.id LIMIT 1
     ) a_title ON true
     LEFT JOIN LATERAL (
       SELECT source AS title FROM jsonb_array_elements(lead.result#>'{checks,revision,sources}') AS asks(source)
       JOIN reader_evidence e ON e.id::text=source->>'evidenceId' AND e.run_id=lead.id AND e.version_id=ob.version_id
       ORDER BY e.created_at,e.id LIMIT 1
     ) b_title ON true
     WHERE p.project_id=$1
       AND lead.result->>'kind'='proposal' AND a.result->>'verdict'='supported' AND b.result->>'verdict'='supported'
       AND p.proof IS NOT NULL AND (lead.result->'verifiedPair')=p.wire_proof AND (a.result->'verifiedPair')=p.wire_proof AND (b.result->'verifiedPair')=p.wire_proof
       AND NOT EXISTS (SELECT 1 FROM harness_package_bindings x WHERE x.fact_id=p.a_fact_id AND x.version>p.a_binding_version)
       AND NOT EXISTS (SELECT 1 FROM harness_package_bindings x WHERE x.fact_id=p.b_fact_id AND x.version>p.b_binding_version)`, args);
  const current = new Map(comparison.reviewCandidates.map((pair) => [pair.a + '/' + pair.b, pair]));
  const verifiedPairs = reviewed.rows.filter((pair) => current.get(pair.a + '/' + pair.b)?.scope.id === pair.proof.scope);
  const titleByFact = new Map<string, { variant: string; revision: string; evidence: ReviewTitle }[]>();
  for (const { a, b, proof, titles } of verifiedPairs) {
    for (const [id, revision, evidence] of [[a, proof.revisionA, titles.A], [b, proof.revisionB, titles.B]] as const) {
      if (!evidence) continue;
      const records = titleByFact.get(id) ?? [];
      records.push({ variant: proof.variant, revision, evidence });
      titleByFact.set(id, records);
    }
  }
  const published = facts.map((fact) => {
    const titles = titleByFact.get(fact.id);
    if (!titles?.length) return fact;
    const [first] = titles;
    if (titles.some(({ variant, revision }) => variant !== first.variant || revision.toLowerCase() !== first.revision.toLowerCase())) return fact;
    return { ...fact, variant: fact.variant ?? first.variant, revision: fact.revision ?? first.revision,
      revisionStatus: 'current' as const,
      basis: { ...fact.basis, revision: fact.basis.revision ?? first.evidence.quote, revisionEvidence: {
        ...first.evidence, href: `/api/v1/evidence/${first.evidence.evidenceId}`,
      } },
    };
  });
  return { facts: published, semanticChecks, candidates, facadeProfiles, facadeMentions, windows, ...comparison, verifiedPairs, coverage: {
    inventory: inventory.closed ? 'closed' : 'open', acceptedVersions: versionIds.length, mappedVersions,
    refusedVersions: versions.rows.filter(({ refusal }) => refusal !== null).length,
    pendingVersions: versionIds.length - mappedVersions, completedWindows, structurallyReviewedWindows,
    physicalBoundary: physicalProof ? 'verified' : 'mapped_places', facadeBoundary: subjectProof ? 'verified' : 'observed_facades',
    physicalProof, subjectProof,
    physicalLimitations: versions.rows.flatMap(({ id, basis, limitation }) =>
      basis ? [] : [{ versionId: id, reason: limitation ?? 'physical_inventory_pending' }]),
  } };
}
