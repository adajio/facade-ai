import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { hash, verify } from '@node-rs/argon2';
import type { Options } from '@node-rs/argon2';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { Pool, PoolClient } from 'pg';
import { AccessError, forbidden, invalid, unauthenticated, unavailable } from './errors.js';

export type AccessDb = Pool | PoolClient;
export type ProjectRole = 'project_manager' | 'engineer' | 'viewer';
export type ProjectAction = 'project:read' | 'project:engineer' | 'project:manage';
export type AccessRequirement =
  | { action: 'session' }
  | { action: ProjectAction | 'organization:assign-owner'; projectId: string; scopeId?: string }
  | {
      action: 'organization:admin' | 'organization:create-project' | 'operator:diagnose';
      organizationId?: string;
    };

export interface AccessActor {
  userId: string;
  organizationId: string;
  sessionId: string;
  role: ProjectRole | 'org_admin' | 'project_creator' | 'technical_operator' | 'user';
}

export interface Account {
  id: string;
  organizationId: string;
  login: string;
  state: 'invited' | 'active' | 'disabled';
  version: number;
  orgAdmin: boolean;
  canCreateProject: boolean;
  technicalOperator: boolean;
}

export const accountColumns = `
  u.id, u.organization_id AS "organizationId", u.login, u.state, u.version,
  u.org_admin AS "orgAdmin", u.can_create_project AS "canCreateProject",
  u.technical_operator AS "technicalOperator"`;

export interface SessionAccount extends Account {
  sessionId: string;
  lastSeenAt: Date;
}

const cookieName = 'facade_session';
const secretPattern = /^[A-Za-z0-9_-]{43}$/;
const uuidPattern = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const argon: Options = {
  algorithm: 2, // Argon2id
  version: 1, // Argon2 v1.3 (PHC v=19)
  memoryCost: 19 * 1024,
  timeCost: 2,
  parallelism: 1,
};
let dummyHash: Promise<string> | undefined;

function duration(name: string, fallback: number): number {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isSafeInteger(value) || value < 1 || value > 31_536_000) {
    throw new Error(`${name} must be a positive integer (maximum 31536000)`);
  }
  return value;
}

export function accessConfig() {
  const configured = process.env.FACADE_PUBLIC_ORIGIN;
  const port = process.env.PORT ?? '3000';
  const origins = configured
    ? [new URL(configured)]
    : [new URL(`http://localhost:${port}`), new URL(`http://127.0.0.1:${port}`)];
  for (const origin of origins) {
    const local = ['localhost', '127.0.0.1', '[::1]'].includes(origin.hostname);
    if ((!local && origin.protocol !== 'https:') ||
        !['http:', 'https:'].includes(origin.protocol) ||
        origin.pathname !== '/' || origin.search || origin.hash || origin.username || origin.password) {
      throw new Error('FACADE_PUBLIC_ORIGIN must be an HTTPS origin or a loopback HTTP origin');
    }
  }
  return {
    origins: origins.map((origin) => origin.origin),
    explicitOrigin: configured !== undefined,
    secureCookie: origins[0].protocol === 'https:',
    absoluteSeconds: duration('FACADE_SESSION_ABSOLUTE_SECONDS', 8 * 3600),
    idleSeconds: duration('FACADE_SESSION_IDLE_SECONDS', 30 * 60),
    inviteSeconds: duration('FACADE_INVITE_SECONDS', 24 * 3600),
    resetSeconds: duration('FACADE_RESET_SECONDS', 30 * 60),
    loginWindowSeconds: duration('FACADE_LOGIN_WINDOW_SECONDS', 15 * 60),
    loginAccountLimit: duration('FACADE_LOGIN_ACCOUNT_LIMIT', 8),
    loginSourceLimit: duration('FACADE_LOGIN_SOURCE_LIMIT', 30),
  };
}
export type AccessConfig = ReturnType<typeof accessConfig>;

export function uuid(value: unknown): string {
  if (typeof value !== 'string' || !uuidPattern.test(value)) throw unavailable();
  return value.toLowerCase();
}

export function normalizeLogin(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const login = value.normalize('NFKC').trim().toLowerCase();
  return /^[a-z0-9][a-z0-9_.@+-]{0,127}$/.test(login) ? login : undefined;
}

export function validatePassword(value: unknown): string {
  if (typeof value !== 'string' || value.length < 12 || Buffer.byteLength(value) > 1024) {
    throw invalid('invalid_password', 'Пароль должен содержать от 12 символов и не превышать 1024 байта.');
  }
  return value;
}

export function passwordHash(password: string) {
  return hash(password, argon);
}

export async function verifyPassword(stored: string | null | undefined, password: string) {
  const encoded = stored ?? await (dummyHash ??= passwordHash(randomSecret()));
  const valid = await verify(encoded, password);
  return stored != null && valid;
}

export function digest(text: string) {
  return createHash('sha256').update(text, 'utf8').digest();
}

export function randomSecret() {
  return randomBytes(32).toString('base64url');
}

export function isSecret(value: unknown): value is string {
  return typeof value === 'string' && secretPattern.test(value);
}

export function readCookie(request: FastifyRequest): string | undefined {
  const cookies = request.headers.cookie?.split(';')
    .map((entry) => entry.trim())
    .filter((entry) => entry.startsWith(`${cookieName}=`));
  if (cookies?.length !== 1) return undefined;
  const value = cookies[0].slice(cookieName.length + 1);
  return isSecret(value) ? value : undefined;
}

export function writeCookie(reply: FastifyReply, token: string, config: AccessConfig) {
  const maxAge = token ? config.absoluteSeconds : 0;
  const secure = config.secureCookie ? '; Secure' : '';
  reply.header('Set-Cookie', `${cookieName}=${token}; Path=/; Max-Age=${maxAge}; HttpOnly; SameSite=Lax${secure}`);
}

export function csrfToken(cookie: string): string {
  return createHmac('sha256', cookie).update('facade-session-csrf-v1').digest('base64url');
}

export function checkOrigin(request: FastifyRequest, config: AccessConfig) {
  const origin = request.headers.origin;
  if (config.explicitOrigin && origin && config.origins.includes(origin)) return;
  const host = request.headers.host;
  const loopbackHost = host && /^(localhost|127\.0\.0\.1|\[::1\])(?::[0-9]{1,5})?$/.test(host);
  if (!config.explicitOrigin && loopbackHost &&
      (origin === `http://${host}` || origin === `https://${host}`)) return;
  throw new AccessError(403, 'invalid_origin', 'Источник запроса не разрешён.');
}

export function checkCsrf(request: FastifyRequest, cookie: string) {
  const submitted = request.headers['x-csrf-token'];
  if (!isSecret(submitted) ||
      !timingSafeEqual(Buffer.from(csrfToken(cookie)), Buffer.from(submitted))) {
    throw new AccessError(403, 'csrf_required', 'Обновите сеанс и повторите действие.');
  }
}

export function requireMutationProtection(request: FastifyRequest) {
  if (['GET', 'HEAD', 'OPTIONS'].includes(request.method)) return;
  const cookie = readCookie(request);
  if (!cookie) throw unauthenticated();
  checkOrigin(request, accessConfig());
  checkCsrf(request, cookie);
}

export async function readSession(db: AccessDb, request: FastifyRequest): Promise<SessionAccount> {
  const token = readCookie(request);
  if (!token) throw unauthenticated();
  const { rows: [session] } = await db.query<SessionAccount>(
    `SELECT ${accountColumns}, s.id AS "sessionId", s.last_seen_at AS "lastSeenAt"
     FROM access_sessions s JOIN users u ON u.id = s.user_id
     WHERE s.token_hash = $1 AND s.revoked_at IS NULL AND u.state = 'active'
       AND s.expires_at > statement_timestamp()
       AND s.last_seen_at > statement_timestamp() - make_interval(secs => $2)`,
    [digest(token), accessConfig().idleSeconds],
  );
  if (!session) throw unauthenticated();
  return session;
}

export async function touchSession(db: AccessDb, session: SessionAccount) {
  const interval = Math.min(30, Math.floor(accessConfig().idleSeconds / 3));
  if (Date.now() - session.lastSeenAt.getTime() < interval * 1000) return;
  await db.query(
    `UPDATE access_sessions SET last_seen_at = statement_timestamp()
     WHERE id = $1 AND revoked_at IS NULL
       AND last_seen_at <= statement_timestamp() - make_interval(secs => $2)`,
    [session.sessionId, interval],
  );
}

export function projectActions(role: ProjectRole): ProjectAction[] {
  switch (role) {
    case 'project_manager': return ['project:read', 'project:engineer', 'project:manage'];
    case 'engineer': return ['project:read', 'project:engineer'];
    case 'viewer': return ['project:read'];
  }
}

export function organizationActions(account: Account): AccessRequirement['action'][] {
  const actions: AccessRequirement['action'][] = [];
  if (account.orgAdmin) actions.push('organization:admin');
  if (account.canCreateProject && !account.technicalOperator) actions.push('organization:create-project');
  if (account.technicalOperator) actions.push('operator:diagnose');
  return actions;
}

export async function authorize(
  db: AccessDb,
  session: SessionAccount,
  requirement: AccessRequirement,
): Promise<AccessActor> {
  const actor: AccessActor = {
    userId: session.id,
    organizationId: session.organizationId,
    sessionId: session.sessionId,
    role: 'user',
  };

  if ('projectId' in requirement) {
    const projectId = uuid(requirement.projectId);
    if (requirement.action === 'organization:assign-owner') {
      if (!session.orgAdmin) throw forbidden();
      const { rowCount } = await db.query(
        'SELECT 1 FROM projects WHERE id = $1 AND organization_id = $2',
        [projectId, session.organizationId],
      );
      if (!rowCount) throw unavailable();
      return { ...actor, role: 'org_admin' };
    }
    const scopeId = requirement.scopeId == null ? null : uuid(requirement.scopeId);
    const { rows: [membership] } = await db.query<{ role: ProjectRole }>(
      `SELECT m.role FROM project_memberships m
       WHERE m.project_id = $1 AND m.organization_id = $2 AND m.user_id = $3
         AND (m.expires_at IS NULL OR m.expires_at > statement_timestamp())
         AND (m.scope_id IS NULL OR m.scope_id = $4)
         AND ($4::uuid IS NULL OR EXISTS (
             SELECT 1 FROM project_scopes s WHERE s.project_id = $1 AND s.id = $4
         ))`,
      [projectId, session.organizationId, session.id, scopeId],
    );
    if (!membership) throw unavailable();
    if (!projectActions(membership.role).includes(requirement.action)) throw forbidden();
    return { ...actor, role: membership.role };
  }

  if (requirement.action === 'session') return actor;
  if (requirement.organizationId != null && uuid(requirement.organizationId) !== session.organizationId) {
    throw unavailable();
  }
  if (!organizationActions(session).includes(requirement.action)) throw forbidden();
  const role = {
    'organization:admin': 'org_admin',
    'organization:create-project': 'project_creator',
    'operator:diagnose': 'technical_operator',
  } as const;
  return { ...actor, role: role[requirement.action] };
}

export async function requireAccess(
  db: AccessDb,
  request: FastifyRequest,
  requirement: AccessRequirement,
): Promise<AccessActor> {
  requireMutationProtection(request);
  const session = await readSession(db, request);
  const actor = await authorize(db, session, requirement);
  await touchSession(db, session);
  return actor;
}

export async function revokeSessions(tx: PoolClient, userId: string) {
  await tx.query(
    'UPDATE access_sessions SET revoked_at = statement_timestamp() WHERE user_id = $1 AND revoked_at IS NULL',
    [userId],
  );
}
