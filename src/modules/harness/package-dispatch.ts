import { preparedPackageWindow, preparedManifestForWindow, preflightPackageWindow, packagePreparationInput, verifyCurrentPreparation, refreshReceiptPreparation } from './package-preparation.js';
import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import type { WorkQueue } from '../gateway/queue.js';
import { currentPackagePrimary, currentPackageSource as currentSource, currentPackageWindows as selectedWindows,
  lockPackagePrimarySlots, packagePrimaryGlobalLimit, packagePrimaryProjectLimit,
  packageResumeWaitingSlot, runnablePackagePrimary } from '../gateway/package-slots.js';
import { hash, transaction } from '../gateway/types.js';
import type { ResearchAdmission } from '../gateway/gateway.js';
import { lockIntakeProject } from '../intake/gate.js';
import { dwgPredecessor, pinnedDwgPredecessorSql } from '../intake/dwg-predecessor.js';
import type { Branch, Place, PrimaryJob } from './contracts.js';
import { buildMap, jobFields, originalJoins, type IntakeJob } from './dispatch.js';
import type { ResearchProfile } from './profile.js';
import type { ReaderService } from './reader.js';
import { authorizedPackageReview } from './package-review.js';
import { jobSchema } from './contracts.js';
import { packageFollowupKind } from './package-walk.js';
import { researchKind } from './runner.js';
import { memoryVersion } from '../project-memory/contracts.js';
import { profileHintLines,profileHintPatterns } from './facade-profile-hints.js';
import { dxfEncodingRecoveryVersion, dxfGroupRecoveryVersion, dxfRecoveryVersionPatterns, legacyDxfEncodingHold, legacyDxfGroupHold } from '../formats/dwg-profile.js';
import { admitBackgroundCall } from './reading-stop.js';
import { readDirectedReadingPlans, currentDirectedWindow, addressedWindowCurrent } from './directed-reading.js';
import { largeJpegRecoveryVersion, rasterDimensionLimit } from '../formats/raster-profile.js';

const branches = ['A', 'B'] as const;
const mapContract = 'overlapping-windows-v1';
const readingContract = 'package-primary-v1';

const packageSources = `JOIN projects p ON p.id=j.project_id
  JOIN LATERAL (
    SELECT CASE WHEN lower(regexp_replace(c.relative_path, '^.*/', '')) IN ('thumbs.db','desktop.ini') THEN lower(regexp_replace(c.relative_path, '^.*/', ''))
      ELSE lower(substring(c.relative_path FROM '[.][a-zA-Z0-9]+$')) END AS extension
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
  const versions = await Promise.all(formats.map(async (input) => {
    const version = await service.readerVersion(service.formatFor(input.media, input.extension ?? ''));
    const predecessor = dwgPredecessor(version);
    return { ...input, version, recovery: dxfGroupRecoveryVersion(version),
      encoding_recovery: dxfEncodingRecoveryVersion(version),predecessor_versions:predecessor.versions,predecessor_before:predecessor.before,
      raster_recovery: largeJpegRecoveryVersion(version,input.media,input.extension ?? '') };
  }));
  const { rows: [job] } = await db.query<IntakeJob & { requested: string | null; baseVersion: string | null; rasterRecovery: string | null }>(
    `SELECT ${jobFields}, effective.version AS requested,expected.version AS "baseVersion",expected.raster_recovery AS "rasterRecovery"
       FROM intake_reader_jobs j ${originalJoins} ${packageSources}
     JOIN jsonb_to_recordset($1::jsonb) AS expected(media text,extension text,version text,recovery text,encoding_recovery text,
       raster_recovery text,predecessor_versions text[],predecessor_before timestamptz)
       ON expected.media=v.media_type AND expected.extension IS NOT DISTINCT FROM source.extension
     LEFT JOIN harness_package_maps m ON m.version_id=j.version_id AND m.active
     LEFT JOIN harness_package_map_retries retry ON retry.version_id=j.version_id
     LEFT JOIN reader_maps old_dwg ON old_dwg.project_id=j.project_id AND old_dwg.document_id=j.document_id
       AND old_dwg.version_id=j.version_id AND old_dwg.original_sha256=o.sha256 AND old_dwg.reader_version=expected.version
       AND old_dwg.format='dwg' AND jsonb_array_length(old_dwg.units)=1
       AND NOT EXISTS (SELECT 1 FROM dwg_derivatives d WHERE d.project_id=j.project_id AND d.version_id=j.version_id
         AND d.reader_version=expected.version)
     CROSS JOIN LATERAL (SELECT CASE
       WHEN expected.raster_recovery IS NOT NULL AND m.reader_version IS NULL
         AND (m.requested_reader_version=expected.raster_recovery OR
           m.requested_reader_version=expected.version AND m.refusal=$5) THEN expected.raster_recovery
       WHEN expected.version LIKE '%:dwg:unavailable:%' AND (m.reader_version LIKE ANY($4::text[]) OR EXISTS (
         SELECT 1 FROM dwg_derivatives d WHERE d.project_id=j.project_id AND d.version_id=j.version_id AND d.reader_version=m.reader_version
       )) THEN m.requested_reader_version
       WHEN expected.recovery IS NOT NULL AND old_dwg.units @> $3::jsonb
         AND old_dwg.units#>'{0,locator,dxfFraming}' IS NULL THEN expected.recovery
       WHEN expected.encoding_recovery IS NOT NULL AND old_dwg.units @> $6::jsonb
         AND old_dwg.units#>'{0,locator,dxfEncoding}' IS NULL THEN expected.encoding_recovery
       ELSE expected.version END AS version) effective
     WHERE ${enabledProject('$2')}
       AND NOT COALESCE(${pinnedDwgPredecessorSql('m','expected.predecessor_versions','expected.predecessor_before')},false)
       AND (m.version_id IS NULL OR m.requested_reader_version IS DISTINCT FROM effective.version
         OR m.physical_basis_id IS NULL AND m.physical_limitation IS NULL)
       AND (retry.retry_at IS NULL OR retry.retry_at<=clock_timestamp())
     ORDER BY (m.version_id IS NOT NULL OR retry.version_id IS NOT NULL),
       coalesce(retry.retry_at,j.created_at),j.created_at,j.id LIMIT 1`, [JSON.stringify(versions), [...packageProjects], JSON.stringify(legacyDxfGroupHold), dxfRecoveryVersionPatterns, rasterDimensionLimit, JSON.stringify(legacyDxfEncodingHold)]);
  if (!job) return false;
  let map;
  let requested = job.requested;
  try {
    map = await buildMap(job, service.map);
    // Successful maps keep their ordinary reader identity. Failed large JPEG checks get a
    // versioned attempt marker so only the older dimension refusals are prepared again.
    if (job.rasterRecovery) {
      if (requested === job.rasterRecovery && map.readerVersion) requested = job.baseVersion;
      if (map.units[0]?.refusal === rasterDimensionLimit && !map.readerVersion) requested = job.rasterRecovery;
    }
    if (map.readerVersion && map.readerVersion !== requested) throw new Error('reader_profile_changed');
  } catch (error) {
    const code = typeof error === 'object' && error && 'code' in error && typeof error.code === 'string'
      ? error.code : 'reader_map_retry';
    await db.query(
      `INSERT INTO harness_package_map_retries(version_id,reason,retry_at) VALUES($1,$2,clock_timestamp()+interval '5 seconds')
       ON CONFLICT(version_id) DO UPDATE SET reason=EXCLUDED.reason,retry_at=EXCLUDED.retry_at`, [job.versionId, code]);
    return true;
  }
  const fingerprint = hash([mapContract, job.versionId, job.sha256, requested, map.format, map.units]);
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
      [job.projectId, job.versionId, fingerprint, map.readerVersion, requested, map.format,
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
  // This may be the last file in a sealed receipt. The independent sweep also handles
  // receipts sealed after all maps were built and interrupted publications.
  await transaction(db, tx => refreshReceiptPreparation(tx, { projectId: job.projectId, receiptId: job.receiptId }, service));
  return true;
}

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

export async function dispatchPackagePair(db: Pool, queue: WorkQueue, profile: ResearchProfile, walkOverride?: boolean,
  reader?: Pick<ReaderService, 'readerVersion' | 'formatFor'>) {
  if (!profile.A || !profile.B) return false;
  return transaction(db, async (tx) => {
    const { rows: routes } = await tx.query<{ id: string; revision: string }>(
      'SELECT id,revision FROM gateway_routes WHERE id=ANY($1::text[])',
      [[profile.A!.routeId, profile.B!.routeId]]);
    if (routes.length !== 2) return false;
    const pinned = branches.map((branch) => {
      const settings = profile[branch]!;
      const revision = routes.find(({ id }) => id === settings.routeId)!.revision;
      return { branch, settings, revision, profileHash: hash([readingContract, settings, revision]) };
    });
    const profileHash = hash(pinned.map((entry) => entry.profileHash));
    const requiresOverview = pinned.some(({settings})=>settings.model==='gpt-6.1-terra');
    const outdated = await tx.query<{ project_id: string }>(
      'SELECT project_id FROM harness_package_projects WHERE profile_hash IS DISTINCT FROM $1 ORDER BY project_id LIMIT 1',
      [profileHash]);
    if (outdated.rows[0]) {
      const projectId = outdated.rows[0].project_id;
      await lockPackagePrimarySlots(tx);
      await lockIntakeProject(tx, projectId);
      await tx.query('UPDATE harness_package_projects SET profile_hash=$2 WHERE project_id=$1', [projectId, profileHash]);
      return true;
    }
    const { rows: [{ count }] } = await tx.query<{ count: number }>(
      `SELECT count(*)::int AS count FROM ${runnablePackagePrimary}`);
    if (count >= packagePrimaryGlobalLimit) return false;
    const { rows: [waiting] } = await tx.query<{ id: string; projectId: string; reason: string | null; lastTurn: string; requestCursor: string }>(
      `SELECT target.id,target.project_id AS "projectId",target.reason,p.last_turn AS "lastTurn",
         target.request_cursor AS "requestCursor" FROM (
         SELECT j.id,j.project_id,j.reason,
           (SELECT e.cursor FROM gateway_outbox e WHERE e.job_id=j.id AND e.lease_epoch=j.lease_epoch AND e.event_type=$1) AS request_cursor
         FROM ${currentPackagePrimary} AND j.state='held'
         AND EXISTS(SELECT 1 FROM gateway_grants gr JOIN gateway_routes r ON r.id=gr.route_id AND r.revision=gr.revision AND r.enabled
           WHERE gr.project_id=j.project_id AND gr.allowed AND gr.purpose=j.purpose AND gr.route_id=j.payload#>>'{settings,routeId}'
             AND gr.data_class=j.payload#>>'{settings,dataClass}' AND gr.revision=j.payload#>>'{packageWindow,routeRevision}')
         AND NOT EXISTS(SELECT 1 FROM gateway_attempts a WHERE a.job_id=j.id AND a.state IN ('sending','unknown'))
       ) target JOIN harness_package_projects p ON p.project_id=target.project_id
       WHERE target.request_cursor IS NOT NULL
         AND (SELECT count(*) FROM ${runnablePackagePrimary} AND w.project_id=target.project_id)<$2
       ORDER BY p.last_turn,p.project_id,target.request_cursor,target.id LIMIT 1`,
      [packageResumeWaitingSlot, packagePrimaryProjectLimit]);
    const directedPlans = await readDirectedReadingPlans(tx,requiresOverview,db);
    const { rows: [next] } = await tx.query<{
      projectId: string; generationId: string; windowId: string; place: Place; readerVersion: string; walkDefault: boolean;
      lastTurn: string; directedReceiptId: string | null; firstAssignment: boolean; firstLook: Branch[]; available: Branch[]; inspectionLines: string[];
    }>(
      `SELECT p.project_id AS "projectId",p.generation_id AS "generationId",p.last_turn AS "lastTurn",candidate.*,
        (project.intake_mode AND project.package_walk_default) AS "walkDefault",
        CASE WHEN directed.mode<>'ordinary' THEN directed."receiptId" END AS "directedReceiptId"
       FROM harness_package_projects p
       JOIN projects project ON project.id=p.project_id
       JOIN gateway_generations generation ON generation.generation_id=p.generation_id AND generation.current
       LEFT JOIN jsonb_to_recordset($12::jsonb) AS directed("projectId" uuid,mode text,"receiptId" uuid,"windowIds" uuid[],"requirementsByWindow" jsonb)
         ON directed."projectId"=p.project_id
       JOIN LATERAL (
         SELECT ARRAY(
           SELECT profile.branch FROM jsonb_to_recordset($3::jsonb) AS profile(branch text,route text,class text,revision text)
           JOIN gateway_grants gr ON gr.project_id=p.project_id AND gr.route_id=profile.route AND gr.data_class=profile.class
             AND gr.purpose=CASE profile.branch WHEN 'A' THEN 'primary_a' ELSE 'primary_b' END
             AND gr.revision=profile.revision AND gr.allowed
           JOIN gateway_routes r ON r.id=gr.route_id AND r.revision=gr.revision AND r.enabled
         ) AS branches,
         least($2::int,$1::int-(SELECT count(*) FROM ${runnablePackagePrimary} AND w.project_id=p.project_id)) AS slots
       ) admission ON admission.slots>0 AND cardinality(admission.branches)>0
       JOIN LATERAL (
         WITH progress AS (
           SELECT prior.version_id,prior.map_fingerprint,b.branch,bool_or(read_receipt.opened IS TRUE) AS opened
           FROM harness_package_windows prior
           JOIN harness_package_maps map ON map.version_id=prior.version_id AND map.fingerprint=prior.map_fingerprint AND map.active
           JOIN harness_package_branches b ON b.window_id=prior.id AND b.active
           JOIN gateway_jobs root ON root.id=b.job_id AND root.generation_id=p.generation_id
           LEFT JOIN LATERAL (
             SELECT true AS opened FROM reader_evidence e
             WHERE e.project_id=prior.project_id AND e.version_id=prior.version_id AND e.reader_version=map.reader_version
               AND e.run_id=root.id AND e.branch=b.branch LIMIT 1
           ) read_receipt ON true
           WHERE prior.project_id=p.project_id AND b.branch=ANY(admission.branches)
             AND coalesce($4::boolean,project.intake_mode AND project.package_walk_default)
           GROUP BY prior.version_id,prior.map_fingerprint,b.branch
         ), pending AS (
           SELECT w.id,w.project_id,w.version_id,w.ordinal,w.place,m.reader_version,
             array_agg(requested.branch ORDER BY status.fresh DESC,requested.branch) AS available,
             coalesce(array_agg(requested.branch) FILTER(WHERE status.unopened),'{}'::text[]) AS unopened,
             bool_or(status.fresh) AS fresh
           FROM ${selectedWindows}
           CROSS JOIN LATERAL unnest(admission.branches) AS requested(branch)
           LEFT JOIN progress ON progress.version_id=w.version_id AND progress.map_fingerprint=w.map_fingerprint
             AND progress.branch=requested.branch
           CROSS JOIN LATERAL (SELECT coalesce($4::boolean,project.intake_mode AND project.package_walk_default) AS walk) config
           CROSS JOIN LATERAL (SELECT config.walk AND NOT coalesce(progress.opened,false) AS unopened,
             config.walk AND progress.branch IS NULL AS fresh) status
           WHERE w.project_id=p.project_id AND (m.refusal IS NULL OR m.refusal='physical_inventory_unverified') AND ${currentSource} AND ${preparedPackageWindow}
             AND ((coalesce(directed.mode,'ordinary')='ordinary' AND NOT $11::boolean) OR w.id=ANY(directed."windowIds"))
             AND NOT EXISTS (
               SELECT 1 FROM harness_package_branches b WHERE b.window_id=w.id AND b.branch=requested.branch AND b.active
                 AND (b.job_id IS NOT NULL OR EXISTS (SELECT 1 FROM gateway_attempts a WHERE a.job_id=b.blocker_job_id
                     AND a.state IN ('reserved','prepared','sending','unknown','paid')))
             )
           GROUP BY w.id,m.reader_version
         )
         SELECT pending.id AS "windowId",pending.place,pending.reader_version AS "readerVersion",
           pending.available[1:admission.slots::int] AS available,pending.unopened AS "firstLook",pending.fresh AS "firstAssignment",
           coalesce(hints.line_ids,'{}'::text[]) AS "inspectionLines"
         FROM pending
         LEFT JOIN LATERAL (SELECT ARRAY(${profileHintLines('pending.project_id','pending.version_id','pending.reader_version',
           "pending.place->>'unitId'",5)}) AS line_ids) hints ON cardinality(pending.unopened)>0
         JOIN (SELECT o.version_id,min(o.created_at) AS accepted_at FROM intake_occurrences o
           WHERE o.project_id=p.project_id AND o.state='accepted' GROUP BY o.version_id) original
           ON original.version_id=pending.version_id
         ORDER BY array_position(directed."windowIds",pending.id) NULLS LAST,
           pending.fresh DESC,(coalesce(cardinality(hints.line_ids),0)>0) DESC,
           CASE WHEN pending.fresh THEN original.accepted_at END,pending.version_id,pending.ordinal LIMIT 1
       ) candidate ON true
       ORDER BY p.last_turn,p.project_id LIMIT 1`,
      [packagePrimaryProjectLimit, packagePrimaryGlobalLimit-count, JSON.stringify(pinned.map(({branch,settings,revision})=>({
        branch,route:settings.routeId,class:settings.dataClass,revision,
      }))), walkOverride??null,memoryVersion,...profileHintPatterns,requiresOverview,JSON.stringify(directedPlans)]);
    const sameProject = waiting && next && waiting.projectId === next.projectId;
    // A first assignment can take one slot ahead of a waiting continuation.
    // Persist the alternation via queue events, including across worker restarts.
    const lastTurnWasFirstLook = sameProject && next.firstAssignment && (await tx.query<{ first: boolean }>(
      `SELECT e.event_type='queued' AND j.priority>0 AS first
       FROM harness_package_branches b JOIN gateway_jobs j ON j.id=b.job_id
       JOIN gateway_outbox e ON e.job_id=j.id AND e.event_type IN ('queued','resumed')
       WHERE j.project_id=$1 AND e.cursor>$2 ORDER BY e.cursor DESC LIMIT 1`,
      [waiting.projectId,waiting.requestCursor])).rows[0]?.first;
    const resumeFirst = waiting && (!next || BigInt(waiting.lastTurn)<BigInt(next.lastTurn) ||
      (waiting.lastTurn===next.lastTurn && (waiting.projectId<next.projectId ||
        sameProject && (!next.firstAssignment || lastTurnWasFirstLook))));
    // Hashing and storage access happen before the global scheduling lock. Revalidate all
    // mutable admission facts after acquiring it.
    const preflight = next && reader ? await preflightPackageWindow(tx,reader,next.projectId,next.windowId) : [];
    const applicablePreflight = next?.directedReceiptId ? preflight.filter(item=>item.receiptId===next.directedReceiptId) : preflight;
    await lockPackagePrimarySlots(tx);
    if (resumeFirst && await queue.resume(waiting.id, waiting.reason ? [waiting.reason] : undefined, tx)) {
      await tx.query("UPDATE harness_package_projects SET last_turn=nextval('harness_package_turn') WHERE project_id=$1", [waiting.projectId]);
      return true;
    }
    if (!next || (reader && !applicablePreflight.length)) return false;
    const { rows: [slots] } = await tx.query<{ total: number; project: number }>(
      `SELECT count(*)::int AS total,count(*) FILTER (WHERE w.project_id=$1)::int AS project FROM ${runnablePackagePrimary}`, [next.projectId]);
    const availableSlots = Math.min(packagePrimaryGlobalLimit-slots.total,packagePrimaryProjectLimit-slots.project);
    if (availableSlots <= 0) return false;
    await lockIntakeProject(tx, next.projectId);
    const stillCurrent = await tx.query(`SELECT 1 FROM ${selectedWindows} JOIN harness_package_projects p ON p.project_id=w.project_id
      JOIN gateway_generations g ON g.generation_id=p.generation_id AND g.current
      WHERE w.project_id=$1 AND w.id=$2 AND p.generation_id=$3 AND m.reader_version=$4 AND (m.refusal IS NULL OR m.refusal='physical_inventory_unverified') AND ${currentSource}`,
      [next.projectId,next.windowId,next.generationId,next.readerVersion]);
    if (!stillCurrent.rowCount) return false;
    const directed = await currentDirectedWindow(tx,next.projectId,next.windowId,requiresOverview,next.directedReceiptId,db);
    if (!directed.allowed) return false;
    const preparationId = reader ? await preparedManifestForWindow(tx, next.projectId, next.windowId, applicablePreflight) : directed.preparationId;
    if (directed.preparationId && preparationId!==directed.preparationId) return false;
    if (reader && !preparationId) return false;
    // A blocked sibling can be issued later, after a worker's option changes.
    const { rows: [{ walkPinned }] } = await tx.query<{ walkPinned: boolean | null }>(
      `SELECT bool_and(coalesce(j.payload#>>'{packageWindow,walkProtocol}'='1',false)) AS "walkPinned"
       FROM harness_package_branches b JOIN gateway_jobs j ON j.id=b.job_id
       WHERE b.window_id=$1 AND b.active`,
      [next.windowId]);
    const walk = walkPinned ?? walkOverride ?? next.walkDefault;
    const ref = { projectId: next.projectId, scopeId: null, generationId: next.generationId };
    const selected = pinned.filter(({branch})=>next.available.includes(branch)).slice(0,availableSlots);
    for (const { branch, revision, profileHash: branchHash, settings } of selected) {
      // An assigned branch belongs to this window even when the default has since changed.
      const { rows: [active] } = await tx.query<{ profile_hash: string; occupied: boolean }>(
        `SELECT b.profile_hash,(b.job_id IS NOT NULL OR EXISTS (
           SELECT 1 FROM gateway_attempts a WHERE a.job_id=b.blocker_job_id
             AND a.state IN ('reserved','prepared','sending','unknown','paid')
         )) AS occupied FROM harness_package_branches b WHERE b.window_id=$1 AND b.branch=$2 AND b.active`,
        [next.windowId, branch]);
      if (active?.occupied) continue;
      const grant = await tx.query(
        `SELECT 1 FROM gateway_grants gr JOIN gateway_routes r ON r.id=gr.route_id AND r.revision=gr.revision AND r.enabled
         WHERE gr.project_id=$1 AND gr.route_id=$2 AND gr.data_class=$3 AND gr.purpose=$4 AND gr.revision=$5 AND gr.allowed`,
        [next.projectId,settings.routeId,settings.dataClass,branch==='A'?'primary_a':'primary_b',revision]);
      if (!grant.rowCount) continue;
      if (active && active.profile_hash !== branchHash) {
        await tx.query(`UPDATE harness_package_branches SET active=false
          WHERE window_id=$1 AND branch=$2 AND profile_hash=$3 AND job_id IS NULL`, [next.windowId, branch, active.profile_hash]);
      }
      const { rows: [previous] } = await tx.query<{ job_id: string | null }>(
        'SELECT job_id FROM harness_package_branches WHERE window_id=$1 AND branch=$2 AND profile_hash=$3',
        [next.windowId, branch, branchHash]);
      const blocker = previous?.job_id ? null : await priorEffect(tx, next.projectId, next.place, branch, next.readerVersion);
      let jobId = previous?.job_id ?? null;
      if (!jobId && !blocker) {
        const key = hash([next.windowId, branchHash]);
        await queue.declarePrimary(ref, { id: key + ':' + branch, branch, place: key }, tx);
        const payload: PrimaryJob = { mode: 'primary', branch, settings, place: next.place, observationProtocol: 2,
          packageWindow: { id: next.windowId, readerVersion: next.readerVersion, routeRevision: revision, packageReadingVersion: 2,
            ...(preparationId ? {preparationId} : {}),
            ...(directed.requirements?.length ? {directedRequirements:directed.requirements} : {}),
            ...(directed.goals?.length ? {directedGoals:directed.goals,goalReportId:directed.reportId,goalCatalogId:directed.goalCatalogId,goalStage:directed.goalStage} : {}),
            ...(walk ? { walkProtocol: 1 as const,profileInspection:{lineIds:next.inspectionLines} } : {}) } };
        jobId = await queue.enqueue({ ...ref, key: 'package:' + key + ':' + branch, kind: researchKind,
          ...(walk&&next.firstAssignment&&next.firstLook.includes(branch)?{priority:next.inspectionLines.length?2:1}:{}),
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
              se.scope_key=coalesce(item->>'facadeId','common')),0)::text<>item->>'scopeEpoch'
              OR EXISTS (SELECT 1 FROM harness_stale_facade_profiles stale WHERE stale.project_id=catalog.id AND
                stale.facade_id::text=item->>'facadeId')))) AND o.sha256=w.place#>>'{source,sha256}' AND ${currentSource}`,
    [work.windowId, work.projectId, work.place, work.readerVersion, work.id, work.generationId, work.branch]);
  return Boolean(result.rowCount);
}

export function packageModelAdmission(enabled: boolean, packageProjects: readonly string[], allowEffects: boolean,
  reader?: () => Pick<ReaderService, 'readerVersion' | 'formatFor'> | undefined): ResearchAdmission {
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
      // Keep the gateway journal available for exact paid/unknown replay; never
      // start a new effect when the original window is no longer authorized.
      return { dispatchBlock: 'analysis_input_denied' };
    }
    const evidence = await tx.query(
      `SELECT 1 FROM reader_evidence WHERE project_id=$1 AND version_id=$2 AND reader_version=$3
       AND run_id=$4 AND branch=$5 AND id::text=ANY($6::text[])`,
      [work.projectId, place.source.versionId, packageWindow.readerVersion, work.lease.jobId, branch, input.inputRefs]);
    if (evidence.rowCount !== new Set(input.inputRefs).size) return { deny: 'analysis_input_denied' };
    if (!await paidPackageEffectsAllowed()) return { dispatchBlock: 'analysis_replay_only' };
    if (packageWindow.preparationId) {
      const {rows:[target]}=await tx.query<{receipt:string}>(`SELECT receipt_id AS receipt FROM intake_package_preparations
        WHERE project_id=$1 AND id=$2`,[work.projectId,packageWindow.preparationId]);
      if (!target) return {dispatchBlock:'preparation_changed'};
      const effect=hash([work.projectId,work.scopeId,work.generationId,work.key,input.effectKey]);
      const stop=await admitBackgroundCall(tx,work.projectId,target.receipt,packageWindow.preparationId,effect);
      if (stop) return {dispatchBlock:stop};
      if (packageWindow.directedRequirements?.length && !await addressedWindowCurrent(tx,work.projectId,target.receipt,packageWindow))
        return {dispatchBlock:'no_addressed_goal'};
    }
    if (packageWindow.preparationId) {
      // Existing started work and replay retain their original effect. An unstarted job
      // must still belong to the currently verified manifest at the final gate.
      const started = await tx.query(`SELECT 1 FROM gateway_attempts WHERE job_id=$1
        AND state IN ('sending','unknown','paid') LIMIT 1`, [work.lease.jobId]);
      if (!started.rowCount) {
        const service = reader?.();
        if (!service) return { dispatchBlock: 'preparation_verification_unavailable' };
        const target = await tx.query<{ receiptId: string }>(`SELECT prep.receipt_id AS "receiptId" FROM intake_package_preparations prep
          JOIN intake_receipts r ON r.project_id=prep.project_id AND r.id=prep.receipt_id AND r.analysis_scenario=2
          WHERE prep.project_id=$1 AND prep.id=$2`, [work.projectId, packageWindow.preparationId]);
        if (!target.rows[0]) return { dispatchBlock: 'preparation_changed' };
        const proof = await packagePreparationInput(tx,{projectId:work.projectId,receiptId:target.rows[0].receiptId},service);
        if (!await verifyCurrentPreparation(tx,proof,packageWindow.preparationId,packageWindow.id))
          return { dispatchBlock: 'preparation_changed' };
      }
    }
    if (await priorEffect(tx, work.projectId, place, branch, packageWindow.readerVersion, work.lease.jobId, packageWindow.followup?.rootJobId)) return { dispatchBlock: 'analysis_prior_effect' };
    return {};
  };
}
