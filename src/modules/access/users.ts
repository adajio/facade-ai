import type { FastifyInstance } from 'fastify';
import type { Pool, PoolClient } from 'pg';
import { accountColumns, normalizeLogin, requireAccess, revokeSessions, uuid } from './auth.js';
import type { AccessActor, AccessConfig, Account } from './auth.js';
import { executeCommand } from './commands.js';
import { AccessError, invalid, unavailable } from './errors.js';
import { object, optionalFlag } from './input.js';
import { issueToken } from './sessions.js';

interface ManagedAccount extends Account {
  hasPassword: boolean;
}

export async function getAccount(db: Pool | PoolClient, organizationId: string, userId: string) {
  const { rows: [account] } = await db.query<ManagedAccount>(
    `SELECT ${accountColumns}, u.password_hash IS NOT NULL AS "hasPassword"
     FROM users u WHERE u.organization_id = $1 AND u.id = $2`,
    [organizationId, userId],
  );
  if (!account) throw unavailable();
  return account;
}

export function registerUsers(app: FastifyInstance, db: Pool, config: AccessConfig) {
  const requirement = { action: 'organization:admin' } as const;

  app.get('/api/users', async (request) => {
    const actor = await requireAccess(db, request, requirement);
    const query = request.query as { cursor?: string };
    const { rows } = await db.query<Account>(
      `SELECT ${accountColumns} FROM users u WHERE u.organization_id = $1
       AND ($2::uuid IS NULL OR u.id > $2) ORDER BY u.id LIMIT 101`,
      [actor.organizationId, query.cursor == null ? null : uuid(query.cursor)],
    );
    return { users: rows.slice(0, 100), nextCursor: rows.length > 100 ? rows[99].id : null };
  });

  app.post('/api/users/invitations', async (request, reply) => {
    const payload = object(request.body);
    const login = normalizeLogin(payload.login);
    if (!login) throw invalid('invalid_login');
    const result = await executeCommand(db, request, {
      requirement, operation: 'invitation.issue', input: { login }, authorizationWrite: true,
    }, async (tx, actor) => {
      await tx.query(
        `INSERT INTO users (organization_id, login) VALUES ($1, $2) ON CONFLICT (login) DO NOTHING`,
        [actor.organizationId, login],
      );
      const { rows: [account] } = await tx.query<{ id: string; state: string }>(
        'SELECT id, state FROM users WHERE login = $1 AND organization_id = $2',
        [login, actor.organizationId],
      );
      if (account?.state !== 'invited') {
        throw new AccessError(409, 'login_unavailable', 'Логин недоступен для приглашения.');
      }
      const { token, ...receipt } = await issueToken(tx, account.id, 'invite', config.inviteSeconds);
      return {
        status: 201, body: { ...receipt, userId: account.id }, transient: { token },
        audit: { objectId: account.id },
      };
    });
    return reply.code(result.status).send({ ...result.body, ...result.transient });
  });

  app.post<{ Params: { userId: string } }>('/api/users/:userId/password-resets', async (request, reply) => {
    const userId = uuid(request.params.userId);
    const result = await executeCommand(db, request, {
      requirement, operation: 'password-reset.issue', input: { userId }, authorizationWrite: true,
    }, async (tx, actor) => {
      const account = await getAccount(tx, actor.organizationId, userId);
      if (account.state !== 'active') throw unavailable();
      const { token, ...receipt } = await issueToken(tx, userId, 'reset', config.resetSeconds);
      return { status: 201, body: { ...receipt, userId }, transient: { token }, audit: { objectId: userId } };
    });
    return reply.code(result.status).send({ ...result.body, ...result.transient });
  });

  app.post<{ Params: { userId: string } }>('/api/users/:userId/revoke-sessions', async (request, reply) => {
    const userId = uuid(request.params.userId);
    const result = await executeCommand(db, request, {
      requirement, operation: 'user.sessions.revoke', input: { userId }, authorizationWrite: true,
    }, async (tx, actor) => {
      await getAccount(tx, actor.organizationId, userId);
      await revokeSessions(tx, userId);
      return { body: { userId }, audit: { objectId: userId } };
    });
    return reply.code(result.status).send(result.body);
  });

  app.patch<{ Params: { userId: string } }>('/api/users/:userId', async (request, reply) => {
    const userId = uuid(request.params.userId);
    const payload = object(request.body);
    const login = payload.login === undefined ? undefined : normalizeLogin(payload.login);
    const state = payload.state;
    if (payload.login !== undefined && !login) throw invalid('invalid_login');
    if (state !== undefined && state !== 'active' && state !== 'disabled') throw invalid('invalid_state');
    const updates = {
      login, state: state as "active" | "disabled" | undefined,
      orgAdmin: optionalFlag(payload.orgAdmin),
      canCreateProject: optionalFlag(payload.canCreateProject),
      technicalOperator: optionalFlag(payload.technicalOperator),
    };
    if (Object.values(updates).every((value) => value === undefined)) throw invalid();
    let current: ManagedAccount;
    const result = await executeCommand(db, request, {
      requirement, operation: 'user.update', input: { userId, updates }, authorizationWrite: true,
      version: async (tx, actor) => {
        current = await getAccount(tx, actor.organizationId, userId);
        return { current: current.version, href: '/api/users' };
      },
    }, async (tx, actor) => {
      const next = {
        login: updates.login ?? current.login,
        state: updates.state ?? current.state,
        orgAdmin: updates.orgAdmin ?? current.orgAdmin,
        canCreateProject: updates.canCreateProject ?? current.canCreateProject,
        technicalOperator: updates.technicalOperator ?? current.technicalOperator,
      };
      if (next.state === 'active' && !current.hasPassword) throw invalid('invitation_required');
      await checkRoles(tx, actor, current, next);

      const { rows: [saved] } = await tx.query<Account>(
        `UPDATE users u SET login = $2, state = $3, org_admin = $4, can_create_project = $5,
                              technical_operator = $6, version = version + 1
         WHERE id = $1 RETURNING ${accountColumns}`,
        [userId, next.login, next.state, next.orgAdmin, next.canCreateProject, next.technicalOperator],
      ).catch((error: unknown) => {
        if ((error as { code?: string }).code === '23505') {
          throw new AccessError(409, 'login_unavailable', 'Логин недоступен.');
        }
        throw error;
      });
      if (next.state === 'disabled') {
        await tx.query(
          `UPDATE access_tokens SET invalidated_at = statement_timestamp()
           WHERE user_id = $1 AND consumed_at IS NULL AND invalidated_at IS NULL`,
          [userId],
        );
      }
      await revokeSessions(tx, userId);
      return {
        body: saved,
        audit: {
          objectId: userId, version: saved.version,
          details: {
            state: saved.state, orgAdmin: saved.orgAdmin, canCreateProject: saved.canCreateProject,
            technicalOperator: saved.technicalOperator,
          },
        },
      };
    });
    return reply.code(result.status).header('ETag', `"${result.body.version}"`).send(result.body);
  });
}

async function checkRoles(
  tx: PoolClient,
  actor: AccessActor,
  previous: ManagedAccount,
  next: Pick<Account, 'state' | 'orgAdmin' | 'technicalOperator'>,
) {
  if (previous.state === 'active' && previous.orgAdmin && (next.state !== 'active' || !next.orgAdmin)) {
    const { rowCount } = await tx.query(
      `SELECT 1 FROM users WHERE organization_id = $1 AND id <> $2
       AND org_admin AND state = 'active' LIMIT 1`,
      [actor.organizationId, previous.id],
    );
    if (!rowCount) throw new AccessError(409, 'last_org_admin', 'Сначала передайте полномочия администратора.');
  }

  if (next.state !== 'active') {
    const { rowCount } = await tx.query(
      `SELECT 1 FROM project_memberships WHERE user_id = $1 AND role = 'project_manager' LIMIT 1`,
      [previous.id],
    );
    if (rowCount) throw new AccessError(409, 'project_owner_required', 'Сначала передайте владение проектом.');
  }

  if (next.technicalOperator && !previous.technicalOperator) {
    const { rowCount } = await tx.query(
      `SELECT 1 FROM project_memberships WHERE user_id = $1 AND expires_at IS NULL LIMIT 1`,
      [previous.id],
    );
    if (rowCount) throw new AccessError(409, 'operator_project_access', 'Сначала отзовите постоянный проектный доступ.');
  }
}
