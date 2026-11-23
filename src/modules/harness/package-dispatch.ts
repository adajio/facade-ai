import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import type { WorkQueue } from '../gateway/queue.js';
import { hash, transaction } from '../gateway/types.js';
import type { ResearchAdmission } from '../gateway/gateway.js';
import { lockIntakeProject } from '../intake/gate.js';
import type { Branch, Place, PrimaryJob } from './contracts.js';
import { buildMap, jobFields, originalJoins, type IntakeJob } from './dispatch.js';
import type { ResearchProfile } from './profile.js';
import type { ReaderService } from './reader.js';
import { authorizedPackageReview } from './package-review.js';
import { jobSchema } from './contracts.js';
import { packageFollowupKind } from './package-walk.js';
import { researchKind } from './runner.js';

const branches = ['A', 'B'] as const;
const projectLimit = 8;
const globalLimit = 96;
const mapContract = 'overlapping-windows-v1';
const readingContract = 'package-primary-v1';

const packageSources = `JOIN projects p ON p.id=j.project_id
  JOIN LATERAL (
    SELECT lower(substring(c.relative_path FROM '[.][a-zA-Z0-9]+$')) AS extension
    FROM intake_occurrences c WHERE c.version_id=j.version_id AND c.project_id=j.project_id AND c.state='accepted'
    ORDER BY (c.receipt_id=j.receipt_id) DESC,c.created_at,c.id LIMIT 1
  ) source ON true`;
const enabledProject = (parameter: string) => `(p.intake_mode OR p.id=ANY(${parameter}::uuid[])
  OR EXISTS (SELECT 1 FROM harness_package_projects h WHERE h.project_id=p.id))`;

async function ensurePackageGeneration(tx: PoolClient, queue: WorkQueue, projectId: string) {
  const project = await tx.query('SELECT 1 FROM harness_package_projects WHERE project_id=$1', [projectId]);
  if (project.rowCount) return;
  const generationId = randomUUID();
  await queue.openGeneration({ projectId, scopeId: null, generationId }, tx);
  await tx.query('INSERT INTO harness_package_projects(project_id,generation_id) VALUES($1,$2)', [projectId, generationId]);
}

export async function activatePackageProjects(db: Pool, queue: WorkQueue, projectIds: readonly string[]) {
  for (const projectId of projectIds) {
    await transaction(db, async (tx) => {
      await lockIntakeProject(tx, projectId);
      const target = await tx.query('SELECT 1 FROM projects WHERE id=$1', [projectId]);
      if (target.rowCount) await ensurePackageGeneration(tx, queue, projectId);
    });
  }
}

export async function preparePackageMap(
  db: Pool, queue: WorkQueue, service: Pick<ReaderService, 'map' | 'readerVersion' | 'formatFor'>, packageProjects: readonly string[],
) {
  const { rows: formats } = await db.query<{ media: string; extension: string | null }>(
    `SELECT DISTINCT v.media_type AS media,source.extension FROM intake_reader_jobs j ${originalJoins} ${packageSources}
     WHERE ${enabledProject('$1')}`, [[...packageProjects]]);
  const versions = await Promise.all(formats.map(async (input) => ({
    ...input, version: await service.readerVersion(service.formatFor(input.media, input.extension ?? '')),
  })));
  const { rows: [job] } = await db.query<IntakeJob & { requested: string | null }>(
    `SELECT ${jobFields}, expected.version AS requested FROM intake_reader_jobs j ${originalJoins} ${packageSources}
     JOIN jsonb_to_recordset($1::jsonb) AS expected(media text,extension text,version text)
       ON expected.media=v.media_type AND expected.extension IS NOT DISTINCT FROM source.extension
     LEFT JOIN harness_package_maps m ON m.version_id=j.version_id AND m.active
     WHERE ${enabledProject('$2')}
       AND (m.version_id IS NULL OR m.requested_reader_version IS DISTINCT FROM expected.version
         OR m.physical_basis_id IS NULL AND m.physical_limitation IS NULL)
       AND NOT EXISTS (SELECT 1 FROM harness_package_map_retries r WHERE r.version_id=j.version_id AND r.retry_at>clock_timestamp())
     ORDER BY j.created_at,j.id LIMIT 1`, [JSON.stringify(versions), [...packageProjects]]);
  if (!job) return false;
  let map;
  try {
    map = await buildMap(job, service.map);
    if (map.readerVersion && map.readerVersion !== job.requested) throw new Error('reader_profile_changed');
  } catch (error) {
    const code = typeof error === 'object' && error && 'code' in error && typeof error.code === 'string'
      ? error.code : 'reader_map_retry';
    await db.query(
      `INSERT INTO harness_package_map_retries(version_id,reason,retry_at) VALUES($1,$2,clock_timestamp()+interval '5 seconds')
       ON CONFLICT(version_id) DO UPDATE SET reason=EXCLUDED.reason,retry_at=EXCLUDED.retry_at`, [job.versionId, code]);
    return true;
  }
  const fingerprint = hash([mapContract, job.versionId, job.sha256, job.requested, map.format, map.units]);
  await transaction(db, async (tx) => {
    await lockIntakeProject(tx, job.projectId);
    const basis = 'basisId' in map.physical ? map.physical.basisId : null;
    const limitation = 'limitation' in map.physical ? map.physical.limitation : null;
    const current = await tx.query<{ fingerprint: string }>(
      'SELECT fingerprint FROM harness_package_maps WHERE version_id=$1 AND active', [job.versionId]);
    if (current.rows[0]?.fingerprint === fingerprint) {
      await tx.query(
        `UPDATE harness_package_maps SET physical_proof=$2,physical_basis_id=$3,physical_limitation=$4,active=true
         WHERE version_id=$1 AND active AND physical_basis_id IS NULL AND physical_limitation IS NULL`,
        [job.versionId, Boolean(basis), basis, limitation]);
      await tx.query('DELETE FROM harness_package_map_retries WHERE version_id=$1', [job.versionId]);
      return;
    }
    await ensurePackageGeneration(tx, queue, job.projectId);
    await tx.query('UPDATE harness_package_maps SET active=false WHERE version_id=$1 AND active', [job.versionId]);
    await tx.query(
      `INSERT INTO harness_package_maps(project_id,version_id,fingerprint,reader_version,requested_reader_version,format,refusal,physical_proof,physical_basis_id,physical_limitation)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT(version_id,fingerprint) DO UPDATE
       SET active=true,physical_proof=EXCLUDED.physical_proof,physical_basis_id=EXCLUDED.physical_basis_id,
         physical_limitation=EXCLUDED.physical_limitation`,
      [job.projectId, job.versionId, fingerprint, map.readerVersion, job.requested, map.format,
       map.units[0]?.refusal ?? null, Boolean(basis), basis, limitation]);
    const windows = map.units.map(({ id: unitId, refusal, ...address }) => ({
      place: { source: { projectId: job.projectId, versionId: job.versionId, documentId: job.documentId, sha256: job.sha256 },
        unitId, ...address },
    }));
    await tx.query(
      `INSERT INTO harness_package_windows(id,project_id,version_id,map_fingerprint,ordinal,place)
       SELECT gen_random_uuid(),$1,$2,$3,position,(unit->'place')
       FROM jsonb_array_elements($4::jsonb) WITH ORDINALITY AS items(unit,position)
       ON CONFLICT(version_id,map_fingerprint,ordinal) DO NOTHING`,
      [job.projectId, job.versionId, fingerprint, JSON.stringify(windows)]);
    await tx.query(
      `INSERT INTO harness_document_maps(version_id,project_id,physical_units,format) VALUES($1,$2,$3,$4)
       ON CONFLICT(version_id) DO NOTHING`, [job.versionId, job.projectId, JSON.stringify(map.units), map.format]);
    await tx.query('DELETE FROM harness_package_map_retries WHERE version_id=$1', [job.versionId]);
    await tx.query('UPDATE intake_reader_jobs SET dispatched_at=coalesce(dispatched_at,clock_timestamp()) WHERE id=$1', [job.id]);
  });
  return true;
}

const currentSource = `EXISTS (
  SELECT 1 FROM intake_occurrences o WHERE o.project_id=w.project_id AND o.version_id=w.version_id AND o.state='accepted'
) AND NOT EXISTS (
  SELECT 1 FROM intake_document_versions v JOIN intake_occurrences o ON o.project_id=v.project_id
    AND o.version_id=v.id AND o.state='accepted'
  WHERE v.project_id=w.project_id AND v.replaces_version_id=w.version_id
)`;
const selectedWindows = `harness_package_windows w JOIN harness_package_maps m
  ON m.version_id=w.version_id AND m.fingerprint=w.map_fingerprint AND m.active`;
const activeJobs = `harness_package_branches b JOIN ${selectedWindows} ON w.id=b.window_id
  JOIN gateway_jobs j ON j.id=b.job_id AND j.state<>'done' WHERE b.active AND ${currentSource}`;

async function priorEffect(tx: PoolClient, projectId: string, place: Place, branch: Branch, readerVersion: string, jobId?: string, rootJobId?: string) {
  const { rows: [prior] } = await tx.query<{ job_id: string }>(
    `SELECT a.job_id FROM gateway_jobs j JOIN gateway_attempts a ON a.job_id=j.id
     WHERE j.project_id=$1 AND j.subject_id=$2 AND j.purpose=$3 AND j.id IS DISTINCT FROM $5::uuid AND ((j.id IS DISTINCT FROM $8::uuid AND NOT EXISTS(SELECT 1 FROM harness_package_followups sibling
        WHERE sibling.root_job_id=$8 AND sibling.job_id=j.id)) OR a.state<>'paid')
       AND ((j.payload#>>'{packageWindow,readerVersion}' IS NOT NULL AND j.payload#>>'{packageWindow,readerVersion}'<>$7)
         OR (j.payload#>>'{place,unitId}'=$4 AND
             j.payload#>'{place,box}' IS NOT DISTINCT FROM $6::jsonb))
       AND a.state IN ('reserved','prepared','sending','unknown','paid')
     ORDER BY CASE WHEN a.state IN ('sending','unknown') THEN 0 ELSE 1 END,a.created_at LIMIT 1`,
    [projectId, place.source.versionId, branch === 'A' ? 'primary_a' : 'primary_b', place.unitId, jobId ?? null, place.box ? JSON.stringify(place.box) : null, readerVersion, rootJobId ?? null]);
  return prior?.job_id ?? null;
}

export async function dispatchPackagePair(db: Pool, queue: WorkQueue, profile: ResearchProfile, walk = false) {
  if (!profile.A || !profile.B) return false;
  return transaction(db, async (tx) => {
    // Serialize the slot decision. Reader and sender locks always follow the project lock.
    await tx.query("SELECT pg_advisory_xact_lock(hashtextextended('facade/package-dispatch',0))");
    const { rows: routes } = await tx.query<{ id: string; revision: string }>(
      'SELECT id,revision FROM gateway_routes WHERE enabled AND id=ANY($1::text[])',
      [[profile.A!.routeId, profile.B!.routeId]]);
    if (routes.length !== 2) return false;
    const pinned = branches.map((branch) => {
      const settings = profile[branch]!;
      const revision = routes.find(({ id }) => id === settings.routeId)!.revision;
      return { branch, settings, revision, profileHash: hash([readingContract, settings, revision]) };
    });
    const profileHash = hash(pinned.map((entry) => entry.profileHash));
    const outdated = await tx.query<{ project_id: string }>(
      'SELECT project_id FROM harness_package_projects WHERE profile_hash IS DISTINCT FROM $1 ORDER BY project_id LIMIT 1',
      [profileHash]);
    if (outdated.rows[0]) {
      const projectId = outdated.rows[0].project_id;
      await lockIntakeProject(tx, projectId);
      await tx.query('UPDATE harness_package_projects SET profile_hash=$2 WHERE project_id=$1', [projectId, profileHash]);
      await tx.query(
        `UPDATE harness_package_branches b SET active=false FROM harness_package_windows w
         WHERE w.id=b.window_id AND w.project_id=$1 AND b.active AND b.profile_hash<>ALL($2::text[])`,
        [projectId, pinned.map((entry) => entry.profileHash)]);
      return true;
    }
    const { rows: [{ count }] } = await tx.query<{ count: number }>(
      `SELECT count(*)::int AS count FROM ${activeJobs}`);
    if (count > globalLimit - 2) return false;
    const { rows: [next] } = await tx.query<{
      projectId: string; generationId: string; windowId: string; place: Place; readerVersion: string;
    }>(
      `SELECT p.project_id AS "projectId",p.generation_id AS "generationId",candidate.*
       FROM harness_package_projects p
       JOIN LATERAL (
         SELECT w.id AS "windowId",w.place,m.reader_version AS "readerVersion"
         FROM ${selectedWindows}
         WHERE w.project_id=p.project_id AND m.refusal IS NULL AND ${currentSource}
           AND (SELECT count(*) FROM harness_package_branches b WHERE b.window_id=w.id AND b.active
             AND (b.job_id IS NOT NULL OR EXISTS (SELECT 1 FROM gateway_attempts a WHERE a.job_id=b.blocker_job_id
                   AND a.state IN ('reserved','prepared','sending','unknown','paid'))))<2
         ORDER BY w.version_id,w.ordinal LIMIT 1
       ) candidate ON true
       WHERE (SELECT count(*) FROM ${activeJobs} AND w.project_id=p.project_id)<=$1-2
         AND (SELECT count(*) FROM gateway_grants g JOIN gateway_routes r ON r.id=g.route_id AND r.revision=g.revision AND r.enabled
              WHERE g.project_id=p.project_id AND g.allowed AND
              ((g.route_id=$2 AND g.data_class=$3 AND g.purpose='primary_a') OR
               (g.route_id=$4 AND g.data_class=$5 AND g.purpose='primary_b')))=2
       ORDER BY p.last_turn,p.project_id LIMIT 1`,
      [projectLimit, profile.A!.routeId, profile.A!.dataClass, profile.B!.routeId, profile.B!.dataClass]);
    if (!next) return false;
    await lockIntakeProject(tx, next.projectId);
    const ref = { projectId: next.projectId, scopeId: null, generationId: next.generationId };
    for (const { branch, revision, profileHash: branchHash, settings } of pinned) {
      const { rows: [previous] } = await tx.query<{ job_id: string | null }>(
        'SELECT job_id FROM harness_package_branches WHERE window_id=$1 AND branch=$2 AND profile_hash=$3',
        [next.windowId, branch, branchHash]);
      const blocker = previous?.job_id ? null : await priorEffect(tx, next.projectId, next.place, branch, next.readerVersion);
      let jobId = previous?.job_id ?? null;
      if (!jobId && !blocker) {
        const key = hash([next.windowId, branchHash]);
        await queue.declarePrimary(ref, { id: key + ':' + branch, branch, place: key }, tx);
        const payload: PrimaryJob = { mode: 'primary', branch, settings, place: next.place, observationProtocol: 2,
          packageWindow: { id: next.windowId, readerVersion: next.readerVersion, routeRevision: revision, ...(walk ? { walkProtocol: 1 as const } : {}) } };
        jobId = await queue.enqueue({ ...ref, key: 'package:' + key + ':' + branch, kind: researchKind,
          subjectId: next.place.source.versionId, obligationId: key + ':' + branch,
          purpose: branch === 'A' ? 'primary_a' : 'primary_b', payload }, tx);
      }
      await tx.query(
        `INSERT INTO harness_package_branches(window_id,branch,profile_hash,route_revision,settings,job_id,blocker_job_id)
         VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(window_id,branch,profile_hash)
         DO UPDATE SET active=true,job_id=EXCLUDED.job_id,blocker_job_id=EXCLUDED.blocker_job_id`,
        [next.windowId, branch, branchHash, revision, settings, jobId, blocker]);
    }
    await tx.query("UPDATE harness_package_projects SET last_turn=nextval('harness_package_turn') WHERE project_id=$1", [next.projectId]);
    return true;
  });
}

export async function authorizedPackageWindow(
  db: Pool | PoolClient, work: { id: string; projectId: string; generationId: string; branch: Branch; place: Place;
    windowId: string; readerVersion: string },
) {
  const result = await db.query(
    `SELECT 1 FROM ${selectedWindows}
     JOIN harness_package_branches b ON b.window_id=w.id AND b.active
     JOIN harness_package_projects p ON p.project_id=w.project_id
     LEFT JOIN harness_package_followups f ON f.root_job_id=b.job_id AND f.window_id=w.id AND f.branch=b.branch AND f.job_id=$5
     JOIN gateway_jobs j ON (j.id=b.job_id OR j.id=f.job_id) AND j.generation_id=p.generation_id AND j.scope_id IS NULL
     JOIN gateway_generations g ON g.generation_id=j.generation_id AND g.current AND g.scope_id IS NULL
     JOIN intake_reader_jobs ij ON ij.version_id=w.version_id AND ij.project_id=w.project_id
     JOIN intake_originals o ON o.id=ij.original_id AND o.project_id=w.project_id
     WHERE w.id=$1 AND w.project_id=$2 AND w.place=$3 AND m.reader_version=$4 AND j.id=$5
       AND j.generation_id=$6 AND b.branch=$7
       AND (j.payload#>>'{packageWindow,followup,semantic,catalogVersionId}' IS NULL OR EXISTS (
         SELECT 1 FROM projects catalog WHERE catalog.id=w.project_id
          AND catalog.catalog_version_id::text=j.payload#>>'{packageWindow,followup,semantic,catalogVersionId}'
          AND catalog.project_stage=j.payload#>>'{packageWindow,followup,semantic,stage}'
          AND coalesce((SELECT epoch FROM harness_semantic_epochs e WHERE e.project_id=catalog.id),0)::text=
            j.payload#>>'{packageWindow,followup,semantic,epoch}'
          AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(j.payload#>'{packageWindow,followup,semantic,positions}') item
            WHERE coalesce((SELECT epoch FROM harness_semantic_scope_epochs se WHERE se.project_id=catalog.id AND
              se.scope_key=coalesce(item->>'facadeId','common')),0)::text<>item->>'scopeEpoch'))) AND o.sha256=w.place#>>'{source,sha256}' AND ${currentSource}`,
    [work.windowId, work.projectId, work.place, work.readerVersion, work.id, work.generationId, work.branch]);
  return Boolean(result.rowCount);
}

export function packageModelAdmission(enabled: boolean, packageProjects: readonly string[], allowEffects: boolean): ResearchAdmission {
  return async (tx, work, route, input) => {
    async function paidPackageEffectsAllowed() {
      if (!enabled || !allowEffects) return false;
      const native = await tx.query('SELECT 1 FROM projects WHERE id=$1 AND intake_mode', [work.projectId]);
      return Boolean(native.rowCount) || packageProjects.includes(work.projectId);
    }
    if (work.kind !== researchKind && work.kind !== packageFollowupKind) return {};
    if (work.purpose === 'review' && work.scopeId !== null) return {};
    if (work.scopeId !== null) {
      const transition = await tx.query(`SELECT 1 FROM projects p WHERE p.id=$1 AND (p.intake_mode OR EXISTS (
        SELECT 1 FROM harness_package_projects h WHERE h.project_id=p.id))`, [work.projectId]);
      return packageProjects.includes(work.projectId) || transition.rowCount ? { dispatchBlock: 'analysis_legacy_replay_only' } : {};
    }
    if (work.purpose === 'review') {
      const parsed = jobSchema.safeParse(work.payload);
      if (!parsed.success || parsed.data.mode === 'primary' || parsed.data.packageReview?.routeRevision !== route.revision ||
        !await authorizedPackageReview(tx, work.projectId, work.generationId, parsed.data, work.lease.jobId)) {
        return { deny: 'analysis_input_denied' };
      }
      const { dispute, mode, packageReview } = parsed.data;
      const evidence = await tx.query(
        `SELECT 1 FROM reader_evidence WHERE project_id=$1 AND run_id=$2 AND branch=$3 AND id::text=ANY($4::text[])
         AND ((version_id=$5 AND reader_version=$6) OR (version_id=$7 AND reader_version=$8))`,
        [work.projectId, work.lease.jobId, mode === 'lead' ? 'A' : parsed.data.branch, input.inputRefs,
         dispute.a.place.source.versionId, packageReview.readerVersions.A, dispute.b.place.source.versionId, packageReview.readerVersions.B]);
      if (evidence.rowCount !== new Set(input.inputRefs).size) return { deny: 'analysis_input_denied' };
      return await paidPackageEffectsAllowed() ? {} : { dispatchBlock: 'analysis_replay_only' };
    }
    const { place, branch, packageWindow } = work.payload as PrimaryJob;
    if (!packageWindow || packageWindow.routeRevision !== route.revision || (work.kind === packageFollowupKind) !== Boolean(packageWindow.followup)) return { deny: 'analysis_target_changed' };
    if (!await authorizedPackageWindow(tx, { id: work.lease.jobId, projectId: work.projectId,
      generationId: work.generationId, branch, place, windowId: packageWindow.id, readerVersion: packageWindow.readerVersion })) {
      return { deny: 'analysis_input_denied' };
    }
    const evidence = await tx.query(
      `SELECT 1 FROM reader_evidence WHERE project_id=$1 AND version_id=$2 AND reader_version=$3
       AND run_id=$4 AND branch=$5 AND id::text=ANY($6::text[])`,
      [work.projectId, place.source.versionId, packageWindow.readerVersion, work.lease.jobId, branch, input.inputRefs]);
    if (evidence.rowCount !== new Set(input.inputRefs).size) return { deny: 'analysis_input_denied' };
    if (!await paidPackageEffectsAllowed()) return { dispatchBlock: 'analysis_replay_only' };
    if (await priorEffect(tx, work.projectId, place, branch, packageWindow.readerVersion, work.lease.jobId, packageWindow.followup?.rootJobId)) return { dispatchBlock: 'analysis_prior_effect' };
    return {};
  };
}
