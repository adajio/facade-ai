import type { FastifyInstance } from 'fastify';
import type { Pool, PoolClient } from 'pg';
import { lockIntakeProject } from '../intake/gate.js';
import { verifyOriginalBasis, type OriginalBasis } from '../intake/accepted-originals.js';
import { requireAccess, uuid } from './auth.js';
import { executeCommand, transaction } from './commands.js';
import { invalid, unavailable } from './errors.js';
import { object, text } from './input.js';
import { lockProjectApplicability, setProjectStage, stageStatus, versionHref } from './project-state.js';

type ProjectParams = { projectId: string };
type VersionParams = ProjectParams & { versionId: string };
type Evidence = { id: string; versionId: string; address: object };
type StageConfirmation = { stage: string; reason: string; evidenceId: string | null; originalBasis: OriginalBasis | null; actorId: string; actorName?: string; version: number };

async function evidenceFor(db: Pool | PoolClient, projectId: string, ids: string[], versionId?: string) {
  if (!ids.length) return [];
  const { rows } = await db.query<Evidence>(
    `SELECT id, version_id AS "versionId", payload->'address' AS address
       FROM reader_evidence WHERE project_id = $1 AND id = ANY($2::uuid[])
       AND ($3::uuid IS NULL OR version_id = $3) AND jsonb_typeof(payload->'address') = 'object'
       ORDER BY id`,
    [projectId, ids, versionId ?? null],
  );
  if (rows.length !== ids.length) throw unavailable();
  return rows;
}

function evidenceIds(value: unknown) {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 30) throw invalid('invalid_stage_evidence');
  return [...new Set(value.map(uuid))].sort();
}

async function documentStage(
  db: Pool | PoolClient, projectId: string, versionId: string, address: object | null,
) {
  const { rows: [row] } = await db.query<StageConfirmation>(
    `SELECT stage, reason, evidence_id AS "evidenceId", original_basis AS "originalBasis", actor_id AS "actorId",
        (SELECT login FROM users WHERE id=actor_id) AS "actorName", version
       FROM document_stage_confirmations WHERE project_id = $1 AND version_id = $2 AND target = $3::jsonb`,
    [projectId, versionId, JSON.stringify(address)],
  );
  return row ?? { stage: null, reason: null, evidenceId: null, actorId: null, version: 1 };
}

export function registerStages(app: FastifyInstance, db: Pool) {
  app.put<{ Params: ProjectParams }>('/api/projects/:projectId/stage', async (request, reply) => {
    const projectId = uuid(request.params.projectId);
    const payload = object(request.body);
    const manual = payload.provenanceKind === 'engineer_override';
    if (payload.provenanceKind !== undefined && !manual && payload.provenanceKind !== 'machine_verified' ||
        !manual && (payload.documentVersionId !== undefined || payload.pageOrAnchor !== undefined) ||
        manual && payload.evidenceIds !== undefined) throw invalid('invalid_stage_evidence');
    const input = {
      stage: text(payload.stage, 'stage'), reason: text(payload.reason, 'reason', manual ? 2000 : 500),
      evidenceIds: evidenceIds(payload.evidenceIds),
      ...(manual ? { documentVersionId: uuid(payload.documentVersionId), pageOrAnchor: text(payload.pageOrAnchor, 'адрес', 200) } : {}),
    };
    let locked: Awaited<ReturnType<typeof lockProjectApplicability>>;
    const result = await executeCommand(db, request, {
      requirement: { action: 'project:manage', projectId }, operation: 'project.stage.confirm', input,
      version: async (tx) => {
        locked = await lockProjectApplicability(tx, projectId);
        return { current: locked.project.version, href: versionHref(projectId) };
      },
    }, async (tx, actor) => {
      const evidence = await evidenceFor(tx, projectId, input.evidenceIds);
      const basis = input.documentVersionId && input.pageOrAnchor ?
        await verifyOriginalBasis(tx, projectId, input.documentVersionId, input.pageOrAnchor) :
        evidence.length ? { provenanceKind: 'machine_verified' as const, evidenceIds: evidence.map(({ id }) => id) } : undefined;
      const { project: previous, scopes } = locked;
      const project = await setProjectStage(tx, previous, scopes, input.stage, actor, basis);
      const body = { ...project, stageStatus: stageStatus(project), reason: input.reason, evidence };
      return { body, audit: { objectId: projectId, version: project.version, details: {
        previous: previous.stage, previousStatus: stageStatus(previous), stage: project.stage, reason: input.reason,
        evidence, ...(basis ? { basis } : {}), expectedVersion: previous.version,
      } } };
    });
    return reply.code(result.status).header('ETag', `"${result.body.version}"`).send(result.body);
  });

  const url = '/api/projects/:projectId/versions/:versionId/stage';
  app.get<{ Params: VersionParams; Querystring: { evidenceId?: string; pageOrAnchor?: string } }>(url, async (request, reply) => {
    const projectId = uuid(request.params.projectId);
    const versionId = uuid(request.params.versionId);
    await requireAccess(db, request, { action: 'project:read', projectId });
    const { rowCount } = await db.query('SELECT 1 FROM intake_document_versions WHERE project_id = $1 AND id = $2',
      [projectId, versionId]);
    if (!rowCount) throw unavailable();
    const { evidenceId, pageOrAnchor } = request.query;
    if (evidenceId !== undefined && pageOrAnchor !== undefined) throw invalid('invalid_stage_evidence');
    const address = pageOrAnchor !== undefined ? (await transaction(db, (tx) =>
      verifyOriginalBasis(tx, projectId, versionId, text(pageOrAnchor, 'адрес', 200)))).address :
      evidenceId ? (await evidenceFor(db, projectId, [uuid(evidenceId)], versionId))[0].address : null;
    const current = await documentStage(db, projectId, versionId, address);
    return reply.header('ETag', `"${current.version}"`).send({ versionId, address, ...current });
  });

  app.put<{ Params: VersionParams }>(url, async (request, reply) => {
    const projectId = uuid(request.params.projectId);
    const versionId = uuid(request.params.versionId);
    const payload = object(request.body);
    if (payload.target !== 'document' && payload.target !== 'place') throw invalid('invalid_stage_target');
    if ((payload.evidenceId === undefined) === (payload.pageOrAnchor === undefined)) throw invalid('invalid_stage_evidence');
    const input = {
      versionId, target: payload.target, stage: text(payload.stage, 'stage'),
      reason: text(payload.reason, 'reason', 500),
      evidenceId: payload.evidenceId === undefined ? undefined : uuid(payload.evidenceId),
      pageOrAnchor: payload.pageOrAnchor === undefined ? undefined : text(payload.pageOrAnchor, 'адрес', 200),
    };
    let evidence: Evidence | undefined;
    let original: OriginalBasis | undefined;
    let address: object | null;
    let current: Awaited<ReturnType<typeof documentStage>>;
    const result = await executeCommand(db, request, {
      requirement: { action: 'project:engineer', projectId }, operation: 'document.stage.confirm', input,
      version: async (tx) => {
        await lockIntakeProject(tx, projectId);
        // Serialize first writes as well, when there is no confirmation row to lock.
        const { rowCount } = await tx.query(
          'SELECT 1 FROM intake_document_versions WHERE project_id = $1 AND id = $2 FOR NO KEY UPDATE', [projectId, versionId],
        );
        if (!rowCount) throw unavailable();
        if (input.evidenceId) [evidence] = await evidenceFor(tx, projectId, [input.evidenceId], versionId);
        else original = await verifyOriginalBasis(tx, projectId, versionId, input.pageOrAnchor!);
        address = input.target === 'place' ? (original ?? evidence)!.address : null;
        current = await documentStage(tx, projectId, versionId, address);
        const href = `${versionHref(projectId)}/versions/${versionId}/stage`;
        return { current: current.version, href: address === null ? href : href + '?' + new URLSearchParams(input.evidenceId ? { evidenceId: input.evidenceId } : { pageOrAnchor: input.pageOrAnchor! }) };
      },
    }, async (tx, actor) => {
      const version = current.version + 1;
      await tx.query(
        `INSERT INTO document_stage_confirmations
           (project_id, version_id, target, stage, reason, evidence_id, actor_id, version, original_basis)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
         ON CONFLICT (project_id, version_id, target) DO UPDATE
         SET stage = EXCLUDED.stage, reason = EXCLUDED.reason, evidence_id = EXCLUDED.evidence_id,
             actor_id = EXCLUDED.actor_id, version = EXCLUDED.version, original_basis = EXCLUDED.original_basis`,
        [projectId, versionId, JSON.stringify(address), input.stage, input.reason, evidence?.id ?? null, actor.userId, version, original ?? null],
      );
      const body = { versionId, address, stage: input.stage, reason: input.reason, evidenceId: evidence?.id ?? null, originalBasis: original ?? null, actorId: actor.userId, version };
      return { body, audit: { objectId: versionId, version, details: {
        previous: current.stage, stage: input.stage, target: input.target, evidence, ...(original ? { originalBasis: original } : {}),
        reason: input.reason, expectedVersion: current.version,
      } } };
    });
    return reply.code(result.status).header('ETag', `"${result.body.version}"`).send(result.body);
  });
}
