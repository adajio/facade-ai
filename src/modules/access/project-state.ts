import type { Pool, PoolClient } from 'pg';
import { refreshScopeAssessment } from '../assessment/index.js';
import { lockIntakeProject } from '../intake/index.js';
import type { AccessActor } from './auth.js';
import { lockProjectScopes, writeAudit } from './commands.js';
import type { ProjectScope } from './commands.js';
import { AccessError, forbidden, invalid, unavailable } from './errors.js';
import { object, text } from './input.js';
import type { CatalogRequirement } from './input.js';

export interface Project {
  id: string;
  organizationId: string;
  name: string;
  catalogVersionId: string | null;
  intakeMode: boolean;
  stage: string | null;
  confirmedFacadeKinds: string[];
  version: number;
}

export interface DefaultProfile {
  stage: string;
  facadeKinds: string[];
  approvalReference: string;
}

export interface Catalog {
  id: string;
  key: string;
  name: string;
  revision: number;
  requirements: CatalogRequirement[];
  defaultProfile?: DefaultProfile | null;
}

export const projectColumns = [
  'id', 'organization_id AS "organizationId"', 'name', 'catalog_version_id AS "catalogVersionId"',
  'intake_mode AS "intakeMode"', 'project_stage AS stage', 'confirmed_facade_kinds AS "confirmedFacadeKinds"', 'version',
];
export const catalogColumns = 'id, catalog_key AS key, name, revision, requirements';
export const catalogProfileColumn = `CASE WHEN default_stage IS NOT NULL THEN jsonb_build_object(
  'stage', default_stage, 'facadeKinds', default_facade_kinds, 'approvalReference', approval_reference
) END AS "defaultProfile"`;

export function facadeKindSet(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > 100) throw invalid('invalid_facade_kinds');
  return [...new Set(value.map((item) => text(item, 'facadeKind', 100)))].sort();
}

export function defaultProfile(value: unknown): DefaultProfile {
  const input = object(value);
  const facadeKinds = facadeKindSet(input.facadeKinds);
  if (!facadeKinds.length) throw invalid('invalid_facade_kinds');
  return {
    stage: text(input.stage, 'stage'),
    facadeKinds,
    approvalReference: text(input.approvalReference, 'approvalReference', 500),
  };
}

export function versionHref(projectId: string) { return `/api/projects/${projectId}`; }

export function stageStatus(project: Project) {
  if (project.stage !== null) return 'confirmed';
  return project.intakeMode ? 'unknown' : 'legacy_unconfirmed';
}

export function catalogState(catalog: Catalog | null) {
  if (!catalog) return 'unassigned';
  return catalog.requirements.length ? 'assigned' : 'legacy_empty';
}

export async function getProject(db: Pool | PoolClient, id: string, lock = false) {
  const { rows: [row] } = await db.query<Project>(
    `SELECT ${projectColumns.join(', ')} FROM projects WHERE id = $1${lock ? ' FOR UPDATE' : ''}`, [id],
  );
  if (!row) throw unavailable();
  return row;
}

export async function getCatalog(db: Pool | PoolClient, organizationId: string, id: string) {
  const { rows: [row] } = await db.query<Catalog>(
    `SELECT ${catalogColumns}, ${catalogProfileColumn} FROM catalog_versions WHERE organization_id = $1 AND id = $2`,
    [organizationId, id],
  );
  if (!row) throw unavailable();
  return row;
}

export async function lockProjectApplicability(tx: PoolClient, projectId: string) {
  await lockIntakeProject(tx, projectId);
  const scopes = await lockProjectScopes(tx, projectId);
  return { project: await getProject(tx, projectId, true), scopes };
}

export async function catalogOptions(db: Pool | PoolClient, project: Project, after: string | null = null) {
  const { rows } = await db.query<Pick<Catalog, 'id' | 'key' | 'name' | 'revision'>>(
    `SELECT id, catalog_key AS key, name, revision FROM catalog_versions WHERE organization_id = $1
       AND (NOT $2::boolean OR (default_stage = $3 AND default_facade_kinds = $4 AND jsonb_array_length(requirements) > 0))
       AND ($5::uuid IS NULL OR id > $5) ORDER BY id LIMIT 101`,
    [project.organizationId, project.intakeMode, project.stage, project.confirmedFacadeKinds, after],
  );
  const reason = !project.intakeMode ? 'legacy' : !project.stage ? 'stage_unknown'
    : !project.confirmedFacadeKinds.length ? 'facades_unconfirmed' : !rows.length && !after ? 'no_approved_profile'
    : rows.length > 1 ? 'multiple_profiles' : 'applicable_profile';
  return { reason, catalogs: rows.slice(0, 100), nextCursor: rows.length > 100 ? rows[99].id : null };
}

export async function assertApplicableCatalog(tx: PoolClient, project: Project, catalogVersionId: string) {
  const catalog = await getCatalog(tx, project.organizationId, catalogVersionId);
  if (project.intakeMode && !matchesDefaultProfile(project, catalog)) {
    throw invalid('catalog_not_applicable', 'Версия каталога не утверждена для установленной стадии и фасадов.');
  }
}

export function matchesDefaultProfile(project: Project, catalog: Catalog) {
  const profile = catalog.defaultProfile;
  return Boolean(profile && catalog.requirements.length && project.stage === profile.stage &&
    profile.facadeKinds.length === project.confirmedFacadeKinds.length &&
    profile.facadeKinds.every((kind, index) => kind === project.confirmedFacadeKinds[index]));
}

export async function assignCatalog(tx: PoolClient, project: Project, scopes: ProjectScope[], catalogVersionId: string) {
  // Record the old revision before changing the pin, including a solely historical empty catalog.
  if (project.catalogVersionId !== null) {
    for (const scope of scopes) await refreshScopeAssessment(tx, project.id, scope.id);
  }
  const { rows: [saved] } = await tx.query<Project>(
    `UPDATE projects SET catalog_version_id = $2, version = version + 1
     WHERE id = $1 RETURNING ${projectColumns.join(', ')}`,
    [project.id, catalogVersionId],
  );
  await tx.query('UPDATE project_scopes SET version = version + 1 WHERE project_id = $1', [project.id]);
  for (const scope of scopes) await refreshScopeAssessment(tx, project.id, scope.id);
  return saved;
}

async function resolveDefault(tx: PoolClient, project: Project, scopes: ProjectScope[], actor: AccessActor) {
  if (!project.intakeMode || project.catalogVersionId !== null || !project.stage || !project.confirmedFacadeKinds.length) return project;
  const options = await catalogOptions(tx, project);
  if (options.catalogs.length !== 1) return project;
  const saved = await assignCatalog(tx, project, scopes, options.catalogs[0].id);
  await writeAudit(tx, {
    actorId: actor.userId, organizationId: project.organizationId, projectId: project.id,
    role: actor.role, action: 'project.catalog.auto_assign', objectId: project.id, version: saved.version, outcome: 'ok',
    details: { catalogVersionId: saved.catalogVersionId, stage: project.stage, facadeKinds: project.confirmedFacadeKinds },
  });
  return saved;
}

export async function setProjectStage(
  tx: PoolClient, project: Project, scopes: ProjectScope[], stage: string, actor: AccessActor,
) {
  const { rows: [saved] } = await tx.query<Project>(
    `UPDATE projects SET project_stage = $2, version = version + 1
     WHERE id = $1 RETURNING ${projectColumns.join(', ')}`, [project.id, stage],
  );
  return resolveDefault(tx, saved, scopes, actor);
}

export async function resolvePublishedProfile(tx: PoolClient, profile: DefaultProfile, actor: AccessActor) {
  const { rows } = await tx.query<{ id: string }>(
    `SELECT id FROM projects WHERE organization_id = $1 AND intake_mode AND catalog_version_id IS NULL
       AND project_stage = $2 AND confirmed_facade_kinds = $3 ORDER BY id`,
    [actor.organizationId, profile.stage, profile.facadeKinds],
  );
  for (const { id } of rows) {
    const { project, scopes } = await lockProjectApplicability(tx, id);
    await resolveDefault(tx, project, scopes, actor);
  }
}

/** Call from an authorized project mutation, before taking scope or project row locks. */
export async function updateConfirmedFacadeKinds(tx: PoolClient, input: {
  projectId: string;
  expectedVersion: number;
  facadeKinds: readonly string[];
  actor: AccessActor;
}): Promise<Project> {
  const { projectId, actor, expectedVersion } = input;
  const facadeKinds = facadeKindSet(input.facadeKinds);
  if (actor.role !== 'project_manager' && actor.role !== 'engineer') throw forbidden();
  const { project, scopes } = await lockProjectApplicability(tx, projectId);
  if (project.organizationId !== actor.organizationId) throw unavailable();
  const { rowCount } = await tx.query(
    `SELECT 1 FROM project_memberships WHERE project_id = $1 AND organization_id = $2 AND user_id = $3 AND role = $4`,
    [projectId, actor.organizationId, actor.userId, actor.role],
  );
  if (!rowCount) throw unavailable();
  if (project.version !== expectedVersion) {
    throw new AccessError(412, 'version_conflict', 'Данные изменились. Откройте актуальную версию.', {
      currentVersion: project.version, href: versionHref(projectId),
    });
  }
  if (JSON.stringify(project.confirmedFacadeKinds) === JSON.stringify(facadeKinds)) return project;
  const { rows: [saved] } = await tx.query<Project>(
    `UPDATE projects SET confirmed_facade_kinds = $2, version = version + 1
     WHERE id = $1 RETURNING ${projectColumns.join(', ')}`, [project.id, facadeKinds],
  );
  await writeAudit(tx, {
    actorId: actor.userId, organizationId: actor.organizationId, projectId, role: actor.role,
    action: 'project.facade_kinds.confirm', objectId: projectId, version: saved.version, outcome: 'ok',
    details: { previous: project.confirmedFacadeKinds, facadeKinds },
  });
  return resolveDefault(tx, saved, scopes, actor);
}
