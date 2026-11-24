import type { FastifyRequest } from 'fastify';
import type { Pool, PoolClient } from 'pg';
import { authorize, digest, readSession, requireMutationProtection, touchSession, uuid } from './auth.js';
import type { AccessActor, AccessRequirement } from './auth.js';
import { AccessError, invalid, unavailable } from './errors.js';

export async function transaction<T>(db: Pool, work: (tx: PoolClient) => Promise<T>): Promise<T> {
  const tx = await db.connect();
  let discardConnection = false;
  try {
    await tx.query('BEGIN');
    const result = await work(tx);
    await tx.query('COMMIT');
    return result;
  } catch (error) {
    try {
      await tx.query('ROLLBACK');
    } catch {
      discardConnection = true;
    }
    throw error;
  } finally {
    tx.release(discardConnection);
  }
}

async function advisoryLock(tx: PoolClient, name: string, exclusive: boolean) {
  const lock = exclusive ? 'pg_advisory_xact_lock' : 'pg_advisory_xact_lock_shared';
  await tx.query(`SELECT ${lock}(hashtextextended($1, 0))`, [name]);
}

export function lockOrganization(tx: PoolClient, organizationId: string, exclusive: boolean) {
  return advisoryLock(tx, `facade:access:org:${organizationId}`, exclusive);
}

export function lockSession(tx: PoolClient, sessionId: string, exclusive: boolean) {
  return advisoryLock(tx, `facade:access:session:${sessionId}`, exclusive);
}

export function lockScopeSet(tx: PoolClient, projectId: string, exclusive: boolean) {
  return advisoryLock(tx, `facade:access:scope-set:${uuid(projectId)}`, exclusive);
}

export interface ProjectScope {
  id: string;
  projectId: string;
  stage: string;
  name: string;
  version: number;
}

export async function lockProjectScopes(
  tx: PoolClient,
  projectId: string,
  scopeIds?: readonly string[],
): Promise<ProjectScope[]> {
  projectId = uuid(projectId);
  const sortedIds = scopeIds && [...new Set(scopeIds.map(uuid))].sort();
  await lockScopeSet(tx, projectId, !sortedIds);
  const { rows } = await tx.query<ProjectScope>(
    `SELECT id, project_id AS "projectId", stage, name, version
     FROM project_scopes WHERE project_id = $1 AND ($2::uuid[] IS NULL OR id = ANY($2))
     ORDER BY id FOR UPDATE`,
    [projectId, sortedIds ?? null],
  );
  if (sortedIds && rows.length !== sortedIds.length) throw unavailable();
  return rows;
}

export interface AuditEvent {
  actorId?: string;
  organizationId?: string;
  projectId?: string;
  role: string;
  action: string;
  objectId?: string;
  version?: number;
  outcome: string;
  requestId?: string;
  details?: Record<string, unknown>;
}

export async function writeAudit(db: Pool | PoolClient, event: AuditEvent) {
  await db.query(
    `INSERT INTO access_audit
       (actor_id, organization_id, project_id, role, action, object_id,
        object_version, outcome, request_id, details)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
    [
      event.actorId ?? null, event.organizationId ?? null, event.projectId ?? null,
      event.role, event.action, event.objectId ?? null, event.version ?? null,
      event.outcome, event.requestId ?? null, JSON.stringify(event.details ?? {}),
    ],
  );
}

type Version = { current: number; href?: string; details?: Record<string, unknown> };
interface Options<T> {
  operation: string;
  requirement: AccessRequirement;
  input: unknown;
  version?: (tx: PoolClient, actor: AccessActor) => Promise<Version>;
  authorizationWrite?: boolean;
  authorizeReplay?: (tx: PoolClient, actor: AccessActor, body: T) => Promise<void>;
}
interface CommandResult<T, S> {
  body: T;
  status?: number;
  audit?: Pick<AuditEvent, 'projectId' | 'objectId' | 'version' | 'details'>;
  transient?: S;
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(value, (_key, item: unknown) => {
    if (item !== null && typeof item === 'object' && !Array.isArray(item)) {
      const record = item as Record<string, unknown>;
      return Object.fromEntries(Object.keys(record).sort().map((key) => [key, record[key]]));
    }
    return item;
  });
}

function expectedVersion(request: FastifyRequest): number {
  const match = request.headers['if-match']?.match(/^"([1-9][0-9]*)"$/);
  const value = Number(match?.[1]);
  if (!Number.isSafeInteger(value)) throw invalid('version_required', 'Передайте версию в If-Match.');
  return value;
}

function commandKey(request: FastifyRequest): string {
  const key = request.headers['idempotency-key'];
  if (typeof key !== 'string' || !/^[\w.:~-]{1,160}$/.test(key)) {
    throw invalid('idempotency_key_required', 'Передайте ключ повторения в Idempotency-Key.');
  }
  return key;
}

export async function executeCommand<T, S = never>(
  db: Pool,
  request: FastifyRequest,
  options: Options<T>,
  work: (tx: PoolClient, actor: AccessActor) => Promise<CommandResult<T, S>>,
): Promise<{ status: number; body: T; replayed: boolean; transient?: S }> {
  requireMutationProtection(request);
  const initial = await readSession(db, request);
  let actor: AccessActor | undefined;

  try {
    return await transaction(db, async (tx) => {
      await lockOrganization(tx, initial.organizationId, options.authorizationWrite === true);
      await lockSession(tx, initial.sessionId, false);
      const session = await readSession(tx, request);
      actor = await authorize(tx, session, options.requirement);
      const projectId = 'projectId' in options.requirement ? uuid(options.requirement.projectId) : null;
      const key = commandKey(request);
      const expected = options.version ? expectedVersion(request) : null;
      const contentType = request.headers['content-type']?.split(';', 1)[0].trim().toLowerCase();
      const hasJsonBody = contentType === 'application/json' || contentType?.endsWith('+json');
      const fingerprint = digest(canonicalJson({
        input: options.input,
        body: hasJsonBody ? request.body : undefined,
        scopeId: 'scopeId' in options.requirement ? options.requirement.scopeId : null,
        expected,
      }));

      const coordinates = [actor.organizationId, actor.userId, projectId, options.operation, key] as const;
      await advisoryLock(tx, `facade:access:receipt:${JSON.stringify(coordinates)}`, true);
      const { rows: [receipt] } = await tx.query<{
        hash: Buffer; status: number; body: T;
      }>(
        `SELECT request_hash AS hash, response_status AS status, response_body AS body
         FROM command_receipts WHERE organization_id = $1 AND user_id = $2
           AND project_id IS NOT DISTINCT FROM $3::uuid AND operation = $4 AND command_key = $5`,
        [...coordinates],
      );
      if (receipt) {
        await options.authorizeReplay?.(tx, actor, receipt.body);
        if (!receipt.hash.equals(fingerprint)) {
          throw new AccessError(409, 'idempotency_conflict', 'Ключ повторения уже связан с другой командой.');
        }
        await touchSession(tx, session);
        return { status: receipt.status, body: receipt.body, replayed: true };
      }

      if (options.version) {
        const { current, href, details } = await options.version(tx, actor);
        if (current !== expected) {
          throw new AccessError(412, 'version_conflict', 'Данные изменились. Откройте актуальную версию.', {
            currentVersion: current, href, details,
          });
        }
      }

      const result = await work(tx, actor);
      const status = result.status ?? 200;
      await writeAudit(tx, {
        actorId: actor.userId, organizationId: actor.organizationId,
        projectId: projectId ?? undefined, role: actor.role, action: options.operation,
        outcome: 'ok', requestId: request.id, ...result.audit,
      });
      await tx.query(
        `INSERT INTO command_receipts
           (organization_id, user_id, project_id, operation, command_key,
            request_hash, response_status, response_body)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [...coordinates, fingerprint, status, JSON.stringify(result.body ?? null)],
      );
      await touchSession(tx, session);
      return { status, body: result.body, replayed: false, transient: result.transient };
    });
  } catch (error) {
    if (error instanceof AccessError) {
      await writeAudit(db, {
        actorId: initial.id, organizationId: initial.organizationId, role: actor?.role ?? 'user',
        action: options.operation, outcome: error.code, requestId: request.id,
      });
    }
    throw error;
  }
}
