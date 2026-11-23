import type { Pool, PoolClient } from 'pg';
import type { Branch, Place } from './contracts.js';
import type { Observation } from '../pdf/types.js';
import type { VerifiedPairEvidence } from '../assessment/domain.js';
import { printedPairVariant } from './pair-evidence.js';

export const packageRoles = ['drawing', 'detail', 'schedule', 'specification', 'calculation', 'inventory',
  'correspondence', 'model', 'other', 'unknown'] as const;
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
    revisionEvidence?: { evidenceId: string; quote: string; href: string } };
  binding: PackageBinding;
  materials: { id: string; label: string; quote: string }[];
}

export interface PackageWindow {
  id: string;
  place: Place;
  readerVersion: string | null;
  format: string;
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
  candidates: PackageBinding['candidates'];
  windows: PackageWindow[];
  comparisons: PackageComparison[];
  reviewCandidates: { a: string; b: string; scope: { id: string; label: string } }[];
  verifiedPairs: { a: string; b: string; proof: VerifiedPairEvidence;
    titles: { A: ReviewTitle | null; B: ReviewTitle | null } }[];
  coverage: {
    inventory: 'open' | 'closed';
    acceptedVersions: number;
    mappedVersions: number;
    refusedVersions: number;
    pendingVersions: number;
    completedWindows: number;
    physicalBoundary: 'mapped_places' | 'verified';
    facadeBoundary: 'observed_facades' | 'verified';
    physicalProof: PackageCoverageProof | null;
    physicalLimitations: { versionId: string; reason: string }[];
    subjectProof: (PackageCoverageProof & { facadeIds: string[]; commonChecked: boolean }) | null;
  };
}

type ReviewTitle = { evidenceId: string; quote: string };

interface PackageCoverageProof {
  versionIds: string[];
  basisIds: string[];
}

type FactRow = Omit<PackageFact, 'variant' | 'evidenceHref'> & { register: { quote: string; commonChecked: boolean } | null };
type WindowRow = Omit<PackageWindow, 'branches'> & {
  branch: Branch | null;
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

function pairCandidate(a: PackageFact, b: PackageFact, scope: { id: string; label: string } | undefined) {
  const left = a.observation;
  const right = b.observation;
  if (!scope || !left.quote || !right.quote || left.grounding !== 'text' || right.grounding !== 'text' ||
    left.source.documentId === right.source.documentId || left.source.sha256 === right.source.sha256 ||
    !a.basis.role || !b.basis.role || a.sourceRole !== b.sourceRole ||
    ['other', 'inventory', 'correspondence', 'unknown'].includes(a.sourceRole) ||
    a.revisionStatus === 'superseded' || b.revisionStatus === 'superseded' ||
    (a.variant && b.variant && a.variant !== b.variant) ||
    (a.designStage && b.designStage && a.designStage !== b.designStage)) return;
  return { a: a.id, b: b.id, scope };
}

function normalizedValue(value: string | undefined) {
  const literal = value?.trim().normalize('NFC');
  const numeric = literal && /^([+-]?)(\d+)(?:[.,](\d+))?$/.exec(literal);
  if (!numeric) return literal;
  const [, sign, integer, decimals = ''] = numeric;
  const whole = integer.replace(/^0+(?=\d)/, '');
  const fraction = decimals.replace(/0+$/, '');
  return `${sign === '-' && (whole !== '0' || fraction) ? '-' : ''}${whole}${fraction ? '.' + fraction : ''}`;
}

function compare(facts: PackageFact[]) {
  const comparisons: PackageComparison[] = [];
  const reviewCandidates: PackageAnalysis['reviewCandidates'] = [];
  const grouped = new Map<string, { A: PackageFact[]; B: PackageFact[] }>();
  for (const fact of facts) {
    if (!fact.attribute || fact.observation.grounding === 'limited' || fact.observation.limitation) continue;
    const key = fact.attribute.normalize('NFC').trim().toLowerCase();
    const group = grouped.get(key) ?? { A: [], B: [] };
    group[fact.branch].push(fact);
    grouped.set(key, group);
  }
  // Bound the interactive pair list. Assessment separately uses the complete evidence set.
  for (const { A, B } of grouped.values()) {
    for (const a of A) for (const b of B) {
      const left = a.observation;
      const right = b.observation;
      const sameLocation = left.source.versionId === right.source.versionId &&
        left.address.unitId === right.address.unitId && left.lineId && left.lineId === right.lineId;
      const scope = bindingScope(a, b);
      if (!sameLocation && !scope) continue;
      const different = left.value !== undefined && right.value !== undefined &&
        Boolean(left.unit) === Boolean(right.unit) &&
        (left.unit !== right.unit || normalizedValue(left.value) !== normalizedValue(right.value));
      const proposal = different ? pairCandidate(a, b, scope) : undefined;
      if (proposal) reviewCandidates.push(proposal);
      if (comparisons.length >= 200) continue;
      const comparable = sameLocation && left.unit === right.unit && a.variant === b.variant;
      const equal = normalizedValue(left.value) === normalizedValue(right.value) && left.deliveryStatement?.status === right.deliveryStatement?.status;
      comparisons.push({ aFactId: a.id, bFactId: b.id, status: comparable ? equal ? 'agreement' : 'reading_disagreement'
        : 'applicability_unclear' });
    }
  }
  return { comparisons, reviewCandidates };
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
  const { rows } = await db.query<FactRow>(
    `WITH accepted AS (${accepted})
     SELECT f.id,o.branch,f.window_id AS "windowId",o.payload AS observation,f.attribute,f.source_role AS "sourceRole",
       f.design_stage AS "designStage",f.revision,f.revision_status AS "revisionStatus",f.basis,f.materials,f.subject_register AS register,
       jsonb_build_object('state',b.state,'quote',b.quote,'reason',b.reason,'candidates',b.candidates,'version',b.version,'actorId',b.actor_id) AS binding
     FROM harness_package_facts f JOIN reader_observations o ON o.id=f.id
     JOIN accepted a ON a.version_id=o.version_id
     JOIN harness_package_branches active ON active.job_id=f.job_id AND active.active
     JOIN harness_package_windows w ON w.id=f.window_id
     JOIN harness_package_maps m ON m.version_id=w.version_id AND m.fingerprint=w.map_fingerprint AND m.active
     JOIN LATERAL (SELECT * FROM harness_package_bindings h WHERE h.fact_id=f.id ORDER BY version DESC LIMIT 1) b ON true
     WHERE f.project_id=$1 ORDER BY o.created_at,f.id`, args);
  const { rows: [inventory] } = await db.query<{ closed: boolean }>(
    `SELECT EXISTS(SELECT 1 FROM intake_receipts WHERE project_id=$1) AND NOT EXISTS (
       SELECT 1 FROM intake_receipts r WHERE r.project_id=$1 AND (r.sealed_at IS NULL OR EXISTS (
         SELECT 1 FROM intake_occurrences o WHERE o.receipt_id=r.id AND (o.inventory_pending OR o.state='declared')
       ) OR EXISTS (SELECT 1 FROM intake_imports i WHERE i.receipt_id=r.id AND i.state IN ('queued','running','paused')))
     ) AS closed`, args);
  const windows = projectWindows(windowRows);
  const facts = rows.map(({ register, ...fact }) => ({
    ...fact, evidenceHref: `/api/v1/evidence/${fact.observation.evidenceId}`,
    variant: (fact.observation.grounding === 'text' && fact.observation.quote ?
      printedPairVariant(fact.observation.quote) : null) ?? fact.observation.components?.find(({ role }) => role === 'variant')?.literal ?? null,
  }));
  const candidates = [...new Map(facts.flatMap(({ binding }) => binding.candidates)
    .map((candidate) => [candidate.id, candidate])).values()];
  const completedWindows = windows.filter(({ branches }) => Object.values(branches)
    .every(({ status }) => status === 'covered' || status === 'reviewed_no_match')).length;
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
    !facts.some(({ binding, attribute, observation, materials }) => binding.state === 'unclear' ||
      (binding.state === 'unidentified' && (attribute || observation.value !== undefined || materials.length)))
    ? { versionIds, basisIds: [a.id, b.id], facadeIds, commonChecked: true } : null;
  const mappedVersions = new Set(windows.map(({ place }) => place.source.versionId)).size;
  const comparison = compare(facts);
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
  return { facts: published, candidates, windows, ...comparison, verifiedPairs, coverage: {
    inventory: inventory.closed ? 'closed' : 'open', acceptedVersions: versionIds.length, mappedVersions,
    refusedVersions: versions.rows.filter(({ refusal }) => refusal !== null).length,
    pendingVersions: versionIds.length - mappedVersions, completedWindows,
    physicalBoundary: physicalProof ? 'verified' : 'mapped_places', facadeBoundary: subjectProof ? 'verified' : 'observed_facades',
    physicalProof, subjectProof,
    physicalLimitations: versions.rows.flatMap(({ id, basis, limitation }) =>
      basis ? [] : [{ versionId: id, reason: limitation ?? 'physical_inventory_pending' }]),
  } };
}
