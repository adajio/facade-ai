import { inventoryOpen } from '../intake/receipts.js';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Pool, PoolClient } from 'pg';
import {
  authorize, csrfToken, organizationActions, projectActions, readCookie, readSession, requireAccess,
  revokeSessions, touchSession, uuid,
} from './auth.js';
import type { ProjectRole } from './auth.js';
import { executeCommand, lockProjectScopes, lockScopeSet } from './commands.js';
import type { ProjectScope } from './commands.js';
import { AccessError, forbidden, invalid, unavailable } from './errors.js';
import { object, requirements, text } from './input.js';
import type { CatalogRequirement } from './input.js';
import {
  assertApplicableCatalog, assignCatalog, catalogColumns, catalogOptions, catalogProfileColumn, catalogState, defaultProfile,
  getCatalog, getProject, initialProjectStage, lockProjectApplicability, projectColumns, resolveDefault,
  resolvePublishedProfile, stageStatus, versionHref,
} from './project-state.js';
import type { Catalog, Project } from './project-state.js';
import { registerStages } from './stages.js';
import { publicAccount } from './sessions.js';
import { getAccount } from './users.js';

interface ProjectMember {
  userId: string;
  role: ProjectRole;
  scopeId: string | null;
  expiresAt: string | null;
  reason: string | null;
}

type ProjectParams = { projectId: string };
type ScopeParams = ProjectParams & { scopeId: string };
type MemberParams = ProjectParams & { userId: string };

async function projectVersion(tx: PoolClient, projectId: string) {
  const project = await getProject(tx, projectId, true);
  return { current: project.version, href: versionHref(projectId) };
}

async function advanceProject(tx: PoolClient, projectId: string) {
  const { rows: [saved] } = await tx.query<{ version: number }>(
    'UPDATE projects SET version = version + 1 WHERE id = $1 RETURNING version',
    [projectId],
  );
  return saved.version;
}

function memberInput(payload: Record<string, unknown>) {
  const { role } = payload;
  if (role !== 'project_manager' && role !== 'engineer' && role !== 'viewer') throw invalid('invalid_role');
  const scopeId = payload.scopeId == null ? null : uuid(payload.scopeId);
  const reason = payload.reason == null ? null : text(payload.reason, 'reason', 500);
  const expiresAt = payload.expiresAt == null ? null : expiry(payload.expiresAt);
  if ((scopeId || expiresAt) && (role !== 'viewer' || !expiresAt || !reason)) {
    throw invalid('invalid_temporary_grant', 'Временный просмотр требует срока и основания.');
  }
  return { role, scopeId, expiresAt, reason } satisfies Omit<ProjectMember, 'userId'>;
}

function expiry(value: unknown) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(value)) {
    throw invalid('invalid_expiry');
  }
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) throw invalid('invalid_expiry');
  return date.toISOString();
}

async function saveMember(tx: PoolClient, organizationId: string, projectId: string, member: ProjectMember) {
  const account = await getAccount(tx, organizationId, member.userId);
  if (account.state !== 'active') throw unavailable();
  if (account.technicalOperator && (member.role !== 'viewer' || !member.expiresAt || !member.reason)) {
    throw invalid('operator_grant_required', 'Оператору требуется отдельное временное назначение на просмотр.');
  }
  if (member.expiresAt && new Date(member.expiresAt).getTime() <= Date.now()) throw invalid('invalid_expiry');

  const { rows: [owner] } = await tx.query<{ userId: string }>(
    "SELECT user_id AS \"userId\" FROM project_memberships WHERE project_id = $1 AND role = 'project_manager'",
    [projectId],
  );
  if (owner?.userId === member.userId && member.role !== 'project_manager') {
    throw new AccessError(409, 'project_owner_required', 'Сначала передайте владение проектом.');
  }
  if (member.role === 'project_manager' && owner && owner.userId !== member.userId) {
    await tx.query("UPDATE project_memberships SET role = 'engineer' WHERE project_id = $1 AND user_id = $2",
      [projectId, owner.userId]);
    await revokeSessions(tx, owner.userId);
  }

  const { rowCount } = await tx.query(
    `INSERT INTO project_memberships (organization_id, project_id, user_id, role, scope_id, expires_at, reason)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (project_id, user_id) DO UPDATE SET role = EXCLUDED.role, scope_id = EXCLUDED.scope_id,
       expires_at = EXCLUDED.expires_at, reason = EXCLUDED.reason
     WHERE (project_memberships.role, project_memberships.scope_id, project_memberships.expires_at,
       project_memberships.reason) IS DISTINCT FROM (EXCLUDED.role, EXCLUDED.scope_id, EXCLUDED.expires_at, EXCLUDED.reason)`,
    [organizationId, projectId, member.userId, member.role, member.scopeId, member.expiresAt, member.reason],
  );
  if (rowCount) await revokeSessions(tx, member.userId);
  const version = await advanceProject(tx, projectId);
  return { member, version };
}

function registerMembers(app: FastifyInstance, db: Pool) {
  app.get<{ Params: ProjectParams }>('/api/projects/:projectId/members', async (request, reply) => {
    const projectId = uuid(request.params.projectId);
    await requireAccess(db, request, { action: 'project:manage', projectId });
    const query = request.query as { cursor?: string };
    const { rows: [snapshot] } = await db.query<{ version: number; members: Array<ProjectMember & { login: string }> }>(
      `SELECT p.version, COALESCE((
         SELECT jsonb_agg(to_jsonb(member) ORDER BY member."userId") FROM (
           SELECT u.id AS "userId", u.login, u.state, m.role, m.scope_id AS "scopeId",
                  m.expires_at AS "expiresAt", m.reason
           FROM project_memberships m JOIN users u ON u.id = m.user_id
           WHERE m.project_id = p.id AND ($2::uuid IS NULL OR u.id > $2)
           ORDER BY u.id LIMIT 101
         ) member
       ), '[]'::jsonb) AS members FROM projects p WHERE p.id = $1`,
      [projectId, query.cursor == null ? null : uuid(query.cursor)],
    );
    return reply.header('ETag', `"${snapshot.version}"`).send({
      version: snapshot.version,
      members: snapshot.members.slice(0, 100),
      nextCursor: snapshot.members.length > 100 ? snapshot.members[99].userId : null,
    });
  });

  app.put<{ Params: MemberParams }>('/api/projects/:projectId/members/:userId', async (request, reply) => {
    const projectId = uuid(request.params.projectId);
    const member = { userId: uuid(request.params.userId), ...memberInput(object(request.body)) };
    const result = await executeCommand(db, request, {
      requirement: { action: 'project:manage', projectId },
      operation: 'project.members.upsert', input: member, authorizationWrite: true,
      version: async (tx) => {
        if (member.scopeId) await lockProjectScopes(tx, projectId, [member.scopeId]);
        return projectVersion(tx, projectId);
      },
    }, async (tx, actor) => {
      const body = await saveMember(tx, actor.organizationId, projectId, member);
      return {
        body, audit: { objectId: member.userId, version: body.version, details: { ...member } },
      };
    });
    return reply.code(result.status).header('ETag', `"${result.body.version}"`).send(result.body);
  });

  app.delete<{ Params: MemberParams }>('/api/projects/:projectId/members/:userId', async (request, reply) => {
    const projectId = uuid(request.params.projectId);
    const userId = uuid(request.params.userId);
    const result = await executeCommand(db, request, {
      requirement: { action: 'project:manage', projectId },
      operation: 'project.members.remove', input: { userId }, authorizationWrite: true,
      version: (tx) => projectVersion(tx, projectId),
    }, async (tx) => {
      const { rows: [current] } = await tx.query<{ role: ProjectRole }>(
        'SELECT role FROM project_memberships WHERE project_id = $1 AND user_id = $2', [projectId, userId],
      );
      if (!current) throw unavailable();
      if (current.role === 'project_manager') {
        throw new AccessError(409, 'project_owner_required', 'Сначала передайте владение проектом.');
      }
      await tx.query('DELETE FROM project_memberships WHERE project_id = $1 AND user_id = $2', [projectId, userId]);
      await revokeSessions(tx, userId);
      const version = await advanceProject(tx, projectId);
      return { body: { userId, version }, audit: { objectId: userId, version, details: { role: current.role } } };
    });
    return reply.code(result.status).header('ETag', `"${result.body.version}"`).send(result.body);
  });

  app.put<{ Params: ProjectParams }>('/api/projects/:projectId/owner', async (request, reply) => {
    const projectId = uuid(request.params.projectId);
    const { userId: providedId } = object(request.body);
    const userId = uuid(providedId);
    const result = await executeCommand(db, request, {
      requirement: { action: 'organization:assign-owner', projectId },
      operation: 'project.owner.transfer', input: { userId }, authorizationWrite: true,
      version: async (tx) => ({ current: (await getProject(tx, projectId, true)).version }),
    }, async (tx, actor) => {
      const body = await saveMember(tx, actor.organizationId, projectId, {
        userId, role: 'project_manager', scopeId: null, expiresAt: null, reason: null,
      });
      return { body, audit: { objectId: userId, version: body.version } };
    });
    return reply.code(result.status).header('ETag', `"${result.body.version}"`).send(result.body);
  });
}

async function listProjects(db: Pool, request: FastifyRequest) {
  const session = await readSession(db, request);
  await touchSession(db, session);
  const { cursor, search } = request.query as { cursor?: string; search?: string };
  const name = search === undefined ? '' : text(search, 'название проекта');
  const { rows } = await db.query<{
    id: string; name: string; version: number; role: ProjectRole; scopeId: string | null;
  }>(
    `SELECT p.id, p.name, p.version, m.role, m.scope_id AS "scopeId",
       CASE WHEN m.scope_id IS NULL THEN p.project_stage END AS stage,
       CASE WHEN m.scope_id IS NULL THEN GREATEST(last_event.created_at, receipt.created_at, receipt.sealed_at) END AS "lastActivityAt",
       CASE WHEN m.scope_id IS NOT NULL THEN NULL WHEN receipt.id IS NULL THEN 'awaiting_receipt'
         WHEN receipt.open THEN 'inventory_open' ELSE 'inventory_sealed' END AS "receiptState",
       receipt.number::float8 AS "receiptNumber",
       CASE WHEN m.scope_id IS NULL THEN p.catalog_version_id END AS "catalogVersionId",
       CASE WHEN m.scope_id IS NULL AND c.id IS NOT NULL THEN
         jsonb_build_object('id', c.id, 'name', c.name, 'revision', c.revision) END AS catalog
     FROM project_memberships m JOIN projects p ON p.id = m.project_id
     LEFT JOIN catalog_versions c ON c.organization_id = p.organization_id AND c.id = p.catalog_version_id
     LEFT JOIN LATERAL (SELECT e.created_at FROM supplement_project_events e WHERE e.project_id=p.id
       AND m.scope_id IS NULL ORDER BY e.cursor DESC LIMIT 1) last_event ON true
     LEFT JOIN LATERAL (SELECT r.id,r.number,r.created_at,r.sealed_at,${inventoryOpen} AS open FROM intake_receipts r WHERE r.project_id=p.id
       AND m.scope_id IS NULL ORDER BY r.number DESC LIMIT 1) receipt ON true
     WHERE m.organization_id = $1 AND m.user_id = $2
       AND (m.expires_at IS NULL OR m.expires_at > statement_timestamp())
       AND ($3::uuid IS NULL OR p.id > $3) AND ($4::text='' OR strpos(lower(p.name),lower($4))>0) ORDER BY p.id LIMIT 101`,
    [session.organizationId, session.id, cursor == null ? null : uuid(cursor), name],
  );
  const projects = rows.slice(0, 100).map((project) => ({ ...project, actions: projectActions(project.role) }));
  return {
    user: publicAccount(session),
    csrfToken: csrfToken(readCookie(request)!),
    actions: organizationActions(session),
    projects,
    nextCursor: rows.length > 100 ? rows[99].id : null,
  };
}

function registerCatalogs(app: FastifyInstance, db: Pool) {
  app.get('/api/catalogs', async (request) => {
    const session = await readSession(db, request);
    const query = request.query as { cursor?: string };
    if (!session.orgAdmin && !session.canCreateProject) {
      const { rowCount } = await db.query(
        "SELECT 1 FROM project_memberships WHERE user_id = $1 AND role = 'project_manager' LIMIT 1",
        [session.id],
      );
      if (!rowCount) throw forbidden();
    }
    await touchSession(db, session);
    const { rows } = await db.query<Catalog>(
      `SELECT ${catalogColumns}, ${catalogProfileColumn}
       FROM catalog_versions WHERE organization_id = $1
       AND ($2::uuid IS NULL OR id > $2) ORDER BY id LIMIT 101`,
      [session.organizationId, query.cursor == null ? null : uuid(query.cursor)],
    );
    return { catalogs: rows.slice(0, 100), nextCursor: rows.length > 100 ? rows[99].id : null };
  });

  app.post('/api/catalogs', async (request, reply) => {
    const payload = object(request.body);
    const input = {
      key: text(payload.key, 'key', 100),
      name: text(payload.name, 'name'),
      requirements: requirements(payload.requirements),
      ...(payload.defaultProfile === undefined ? {} : { defaultProfile: defaultProfile(payload.defaultProfile) }),
    };
    const result = await executeCommand(db, request, {
      requirement: { action: 'organization:admin' },
      operation: 'catalog.publish', input, authorizationWrite: true,
    }, async (tx, actor) => {
      const profile = input.defaultProfile;
      if (profile && !input.requirements.length) {
        throw invalid('empty_default_profile', 'Для рабочего профиля требуется хотя бы одно утверждённое требование.');
      }
      const { rows: [body] } = await tx.query<Catalog>(
        `INSERT INTO catalog_versions (organization_id, catalog_key, revision, name, requirements, created_by,
             default_stage, default_facade_kinds, approval_reference)
         SELECT $1, $2, COALESCE(MAX(revision), 0) + 1, $3, $4, $5, $6, $7, $8
         FROM catalog_versions WHERE organization_id = $1 AND catalog_key = $2
         RETURNING ${catalogColumns}`,
        [actor.organizationId, input.key, input.name, JSON.stringify(input.requirements), actor.userId,
          profile?.stage ?? null, profile?.facadeKinds ?? null, profile?.approvalReference ?? null],
      );
      if (profile) {
        await resolvePublishedProfile(tx, profile, actor);
        body.defaultProfile = profile;
      }
      return { status: 201, body, audit: { objectId: body.id, version: body.revision, details: profile && { ...profile } } };
    });
    return reply.code(result.status).send(result.body);
  });
}

function registerScopes(app: FastifyInstance, db: Pool) {
  app.post<{ Params: ProjectParams }>('/api/projects/:projectId/scopes', async (request, reply) => {
    const projectId = uuid(request.params.projectId);
    const payload = object(request.body);
    const input = { stage: text(payload.stage, 'stage'), name: text(payload.name, 'name') };
    const result = await executeCommand(db, request, {
      requirement: { action: 'project:manage', projectId }, operation: 'project.scope.create', input,
    }, async (tx) => {
      await lockScopeSet(tx, projectId, true);
      const { rows: [body] } = await tx.query<ProjectScope>(
        `INSERT INTO project_scopes (project_id, stage, name) VALUES ($1, $2, $3)
         ON CONFLICT (project_id, stage, name) DO NOTHING
         RETURNING id, project_id AS "projectId", stage, name, version`,
        [projectId, input.stage, input.name],
      );
      if (!body) throw new AccessError(409, 'scope_exists', 'Такая область уже существует.');
      await advanceProject(tx, projectId);
      return { status: 201, body, audit: { objectId: body.id, version: body.version } };
    });
    return reply.code(result.status).header('ETag', `"${result.body.version}"`).send(result.body);
  });

  app.get<{ Params: ScopeParams }>('/api/projects/:projectId/scopes/:scopeId', async (request, reply) => {
    const projectId = uuid(request.params.projectId);
    const scopeId = uuid(request.params.scopeId);
    const actor = await requireAccess(db, request, { action: 'project:read', projectId, scopeId });
    const { rows: [body] } = await db.query<ProjectScope & { requirements: CatalogRequirement[]; catalogVersionId: string | null }>(
      `SELECT s.id, p.id AS "projectId", s.stage, s.name, s.version, c.id AS "catalogVersionId",
              COALESCE(r.requirements, c.requirements, '[]'::jsonb) AS requirements
       FROM project_scopes s JOIN projects p ON p.id = s.project_id
       LEFT JOIN catalog_versions c ON c.organization_id = p.organization_id AND c.id = p.catalog_version_id
       LEFT JOIN scope_requirements r ON r.scope_id = s.id AND r.version = s.version AND r.catalog_version_id = c.id
       WHERE p.id = $1 AND s.id = $2`,
      [projectId, scopeId],
    );
    if (!body) throw unavailable();
    return reply.header('ETag', `"${body.version}"`).send({
      ...body, role: actor.role, actions: projectActions(actor.role as ProjectRole),
    });
  });

  app.put<{ Params: ScopeParams }>('/api/projects/:projectId/scopes/:scopeId/requirements', async (request, reply) => {
    const projectId = uuid(request.params.projectId);
    const scopeId = uuid(request.params.scopeId);
    const payload = object(request.body);
    const input = { scopeId, requirements: requirements(payload.requirements) };
    const result = await executeCommand(db, request, {
      requirement: { action: 'project:engineer', projectId, scopeId },
      operation: 'project.scope.requirements', input,
      version: async (tx) => {
        const [scope] = await lockProjectScopes(tx, projectId, [scopeId]);
        return { current: scope.version, href: `${versionHref(projectId)}/scopes/${scopeId}` };
      },
    }, async (tx, actor) => {
      const project = await getProject(tx, projectId);
      if (project.catalogVersionId === null) throw invalid('catalog_required', 'Нет рабочего каталога.');
      const { rows: [{ version }] } = await tx.query<{ version: number }>(
        'UPDATE project_scopes SET version = version + 1 WHERE id = $1 AND project_id = $2 RETURNING version',
        [scopeId, projectId],
      );
      await tx.query(
        `INSERT INTO scope_requirements (scope_id, version, catalog_version_id, requirements, author_id)
         VALUES ($1, $2, $3, $4, $5)`,
        [scopeId, version, project.catalogVersionId, JSON.stringify(input.requirements), actor.userId],
      );
      return { body: { scopeId, version, catalogVersionId: project.catalogVersionId }, audit: { objectId: scopeId, version } };
    });
    return reply.code(result.status).header('ETag', `"${result.body.version}"`).send(result.body);
  });
}

export function registerProjects(app: FastifyInstance, db: Pool) {
  app.get('/api/me', (request) => listProjects(db, request));

  app.post('/api/projects', async (request, reply) => {
    const payload = object(request.body);
    const name = text(payload.name, 'name');
    if (payload.mode !== undefined && payload.mode !== 'intake') throw invalid('invalid_project_mode');
    if (payload.mode === 'intake' &&
        ['catalogVersionId', 'stage', 'scopeName'].some((field) => payload[field] != null)) {
      throw invalid('invalid_intake_project', 'Для первичного приёма укажите название проекта.');
    }
    const input = payload.mode === 'intake' ? { name, mode: 'intake' as const } : {
      name,
      catalogVersionId: uuid(payload.catalogVersionId),
      stage: payload.stage === undefined ? 'design' : text(payload.stage, 'stage'),
      scopeName: payload.scopeName === undefined ? 'Общая область' : text(payload.scopeName, 'scopeName'),
    };
    const result = await executeCommand(db, request, {
      requirement: { action: 'organization:create-project' }, operation: 'project.create', input,
      authorizeReplay: async (tx, _actor, body: { id: string; version: number }) => {
        const session = await readSession(tx, request);
        await authorize(tx, session, { action: 'project:read', projectId: body.id });
      },
    }, async (tx, actor) => {
      const legacy = 'catalogVersionId' in input ? input : undefined;
      if (legacy?.catalogVersionId) await getCatalog(tx, actor.organizationId, legacy.catalogVersionId);
      const { rows: [project] } = await tx.query<Project>(
        `INSERT INTO projects (organization_id, name, catalog_version_id, intake_mode, project_stage)
         VALUES ($1, $2, $3, $4, $5) RETURNING ${projectColumns.join(', ')}`,
        [actor.organizationId, input.name, legacy?.catalogVersionId ?? null, !legacy, legacy ? null : initialProjectStage],
      );
      await tx.query(
        `INSERT INTO project_memberships (organization_id, project_id, user_id, role)
         VALUES ($1, $2, $3, 'project_manager')`,
        [actor.organizationId, project.id, actor.userId],
      );
      if (!legacy) {
        const initialized = await resolveDefault(tx, project, [], actor);
        const catalog = initialized.catalogVersionId ? await getCatalog(tx, actor.organizationId, initialized.catalogVersionId) : null;
        return {
          status: 201, body: { ...initialized, catalog, catalogState: catalogState(catalog), stageStatus: stageStatus(initialized), scopes: [] },
          audit: { projectId: project.id, objectId: project.id, version: initialized.version },
        };
      }
      const { rows: [scope] } = await tx.query<ProjectScope>(
        `INSERT INTO project_scopes (project_id, stage, name) VALUES ($1, $2, $3)
         RETURNING id, project_id AS "projectId", stage, name, version`,
        [project.id, legacy.stage, legacy.scopeName],
      );
      const { id, name, organizationId, catalogVersionId, version } = project;
      return {
        status: 201, body: { id, name, organizationId, catalogVersionId, version, scopes: [scope] },
        audit: { projectId: project.id, objectId: project.id, version: project.version },
      };
    });
    return reply.code(result.status).header('ETag', `"${result.body.version}"`).send(result.body);
  });

  app.get<{ Params: ProjectParams }>('/api/projects/:projectId', async (request, reply) => {
    const projectId = uuid(request.params.projectId);
    const actor = await requireAccess(db, request, { action: 'project:read', projectId });
    const query = request.query as { cursor?: string };
    const { rows: [snapshot] } = await db.query<Project & { catalog: Catalog | null; scopes: ProjectScope[] }>(
      `SELECT ${projectColumns.map((column) => 'p.' + column).join(', ')},
              CASE WHEN c.id IS NOT NULL THEN jsonb_build_object('id', c.id, 'key', c.catalog_key, 'name', c.name,
                'revision', c.revision, 'requirements', c.requirements, 'stage', c.default_stage,
                'approvalReference', c.approval_reference, 'publishedAt', c.created_at,
                'publisher', (SELECT u.login FROM users u WHERE u.id=c.created_by)) END AS catalog,
              (SELECT jsonb_build_object('automatic', a.action='project.catalog.auto_assign', 'at', a.occurred_at, 'actor', u.login)
               FROM access_audit a LEFT JOIN users u ON u.id=a.actor_id
               WHERE a.project_id=p.id AND a.action IN ('project.catalog.auto_assign','project.catalog.pin')
                 AND a.details->>'catalogVersionId'=p.catalog_version_id::text AND a.outcome='ok'
               ORDER BY a.id DESC LIMIT 1) AS "catalogAssignment",
              COALESCE((
                SELECT jsonb_agg(to_jsonb(scope) ORDER BY scope.id) FROM (
                  SELECT s.id, s.project_id AS "projectId", s.stage, s.name, s.version
                  FROM project_scopes s WHERE s.project_id = p.id AND ($2::uuid IS NULL OR s.id > $2)
                  ORDER BY s.id LIMIT 101
                ) scope
              ), '[]'::jsonb) AS scopes
       FROM projects p LEFT JOIN catalog_versions c ON c.organization_id = p.organization_id AND c.id = p.catalog_version_id
       WHERE p.id = $1`,
      [projectId, query.cursor == null ? null : uuid(query.cursor)],
    );
    if (!snapshot) throw unavailable();
    const role = actor.role as ProjectRole;
    return reply.header('ETag', `"${snapshot.version}"`).send({
      ...snapshot,
      stageStatus: stageStatus(snapshot),
      catalogState: catalogState(snapshot.catalog),
      scopes: snapshot.scopes.slice(0, 100),
      nextCursor: snapshot.scopes.length > 100 ? snapshot.scopes[99].id : null,
      role, actions: projectActions(role),
    });
  });

  app.get<{ Params: ProjectParams; Querystring: { cursor?: string } }>(
    '/api/projects/:projectId/catalog-options', async (request) => {
      const projectId = uuid(request.params.projectId);
      await requireAccess(db, request, { action: 'project:manage', projectId });
      const project = await getProject(db, projectId);
      const options = await catalogOptions(db, project, request.query.cursor == null ? null : uuid(request.query.cursor));
      return { ...options, version: project.version };
    },
  );

  app.put<{ Params: ProjectParams }>('/api/projects/:projectId/catalog', async (request, reply) => {
    const projectId = uuid(request.params.projectId);
    const catalogVersionId = uuid(object(request.body).catalogVersionId);
    let locked: Awaited<ReturnType<typeof lockProjectApplicability>>;
    const result = await executeCommand(db, request, {
      requirement: { action: 'project:manage', projectId }, operation: 'project.catalog.pin', input: { catalogVersionId },
      version: async (tx) => {
        locked = await lockProjectApplicability(tx, projectId);
        return { current: locked.project.version, href: versionHref(projectId) };
      },
    }, async (tx) => {
      const { project: current, scopes } = locked;
      if (current.catalogVersionId === catalogVersionId) {
        return { body: current, audit: { objectId: projectId, version: current.version, details: { catalogVersionId } } };
      }
      await assertApplicableCatalog(tx, current, catalogVersionId);
      const body = await assignCatalog(tx, current, scopes, catalogVersionId);
      return { body, audit: { objectId: projectId, version: body.version, details: {
        previous: current.catalogVersionId, catalogVersionId, stage: current.stage, facadeKinds: current.confirmedFacadeKinds,
      } } };
    });
    return reply.code(result.status).header('ETag', `"${result.body.version}"`).send(result.body);
  });

  registerMembers(app, db);
  registerCatalogs(app, db);
  registerScopes(app, db);
  registerStages(app, db);
}
