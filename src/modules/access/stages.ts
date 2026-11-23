import type { FastifyInstance } from 'fastify';
import type { Pool, PoolClient } from 'pg';
import { requireAccess, uuid } from './auth.js';
import { executeCommand } from './commands.js';
import { invalid, unavailable } from './errors.js';
import { object, text } from './input.js';
import { lockProjectApplicability, setProjectStage, stageStatus, versionHref } from './project-state.js';

type ProjectParams = { projectId: string };
type VersionParams = ProjectParams & { versionId: string };
type Evidence = { id: string; versionId: string; address: object };
type StageConfirmation = { stage: string; reason: string; evidenceId: string; actorId: string; version: number };

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
    `SELECT stage, reason, evidence_id AS "evidenceId", actor_id AS "actorId", version
       FROM document_stage_confirmations WHERE project_id = $1 AND version_id = $2 AND target = $3::jsonb`,
    [projectId, versionId, JSON.stringify(address)],
  );
  return row ?? { stage: null, reason: null, evidenceId: null, actorId: null, version: 1 };
}

export function registerStages(app: FastifyInstance, db: Pool) {
  app.put<{ Params: ProjectParams }>('/api/projects/:projectId/stage', async (request, reply) => {
    const projectId = uuid(request.params.projectId);
    const payload = object(request.body);
    const input = {
      stage: text(payload.stage, 'stage'), reason: text(payload.reason, 'reason', 500),
      evidenceIds: evidenceIds(payload.evidenceIds),
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
      const { project: previous, scopes } = locked;
      const project = await setProjectStage(tx, previous, scopes, input.stage, actor);
      const body = { ...project, stageStatus: stageStatus(project), reason: input.reason, evidence };
      return { body, audit: { objectId: projectId, version: project.version, details: {
        previous: previous.stage, previousStatus: stageStatus(previous), stage: project.stage, reason: input.reason,
        evidence, expectedVersion: previous.version,
      } } };
    });
    return reply.code(result.status).header('ETag', `"${result.body.version}"`).send(result.body);
  });

  const url = '/api/projects/:projectId/versions/:versionId/stage';
  app.get<{ Params: VersionParams; Querystring: { evidenceId?: string } }>(url, async (request, reply) => {
    const projectId = uuid(request.params.projectId);
    const versionId = uuid(request.params.versionId);
    await requireAccess(db, request, { action: 'project:read', projectId });
    const { rowCount } = await db.query('SELECT 1 FROM intake_document_versions WHERE project_id = $1 AND id = $2',
      [projectId, versionId]);
    if (!rowCount) throw unavailable();
    const address = request.query.evidenceId === undefined ? null
      : (await evidenceFor(db, projectId, [uuid(request.query.evidenceId)], versionId))[0].address;
    const current = await documentStage(db, projectId, versionId, address);
    return reply.header('ETag', `"${current.version}"`).send({ versionId, address, ...current });
  });

  app.put<{ Params: VersionParams }>(url, async (request, reply) => {
    const projectId = uuid(request.params.projectId);
    const versionId = uuid(request.params.versionId);
    const payload = object(request.body);
    if (payload.target !== 'document' && payload.target !== 'place') throw invalid('invalid_stage_target');
    const input = {
      versionId, target: payload.target, stage: text(payload.stage, 'stage'),
      reason: text(payload.reason, 'reason', 500), evidenceId: uuid(payload.evidenceId),
    };
    let basis: Evidence;
    let address: object | null;
    let current: Awaited<ReturnType<typeof documentStage>>;
    const result = await executeCommand(db, request, {
      requirement: { action: 'project:engineer', projectId }, operation: 'document.stage.confirm', input,
      version: async (tx) => {
        // Serialize first writes as well, when there is no confirmation row to lock.
        const { rowCount } = await tx.query(
          'SELECT 1 FROM intake_document_versions WHERE project_id = $1 AND id = $2 FOR NO KEY UPDATE', [projectId, versionId],
        );
        if (!rowCount) throw unavailable();
        [basis] = await evidenceFor(tx, projectId, [input.evidenceId], versionId);
        address = input.target === 'place' ? basis.address : null;
        current = await documentStage(tx, projectId, versionId, address);
        const href = `${versionHref(projectId)}/versions/${versionId}/stage`;
        return { current: current.version, href: address === null ? href : `${href}?evidenceId=${basis.id}` };
      },
    }, async (tx, actor) => {
      const version = current.version + 1;
      await tx.query(
        `INSERT INTO document_stage_confirmations
           (project_id, version_id, target, stage, reason, evidence_id, actor_id, version)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         ON CONFLICT (project_id, version_id, target) DO UPDATE
         SET stage = EXCLUDED.stage, reason = EXCLUDED.reason, evidence_id = EXCLUDED.evidence_id,
             actor_id = EXCLUDED.actor_id, version = EXCLUDED.version`,
        [projectId, versionId, JSON.stringify(address), input.stage, input.reason, basis.id, actor.userId, version],
      );
      const body = { versionId, address, stage: input.stage, reason: input.reason, evidenceId: basis.id, actorId: actor.userId, version };
      return { body, audit: { objectId: versionId, version, details: {
        previous: current.stage, stage: input.stage, target: input.target, evidence: basis,
        reason: input.reason, expectedVersion: current.version,
      } } };
    });
    return reply.code(result.status).header('ETag', `"${result.body.version}"`).send(result.body);
  });
}
