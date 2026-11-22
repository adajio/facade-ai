import type { FastifyInstance } from 'fastify';
import type { Pool, PoolClient } from 'pg';
import {
  accountColumns, csrfToken, digest, isSecret, normalizeLogin, passwordHash, randomSecret,
  readSession, requireMutationProtection, revokeSessions, validatePassword, verifyPassword, writeCookie,
} from './auth.js';
import type { AccessConfig, Account, SessionAccount } from './auth.js';
import { lockOrganization, lockSession, transaction, writeAudit } from './commands.js';
import { AccessError, invalid } from './errors.js';
import { object } from './input.js';

interface Credential extends Account {
  passwordHash: string | null;
}

function loginError() {
  return new AccessError(401, 'invalid_credentials', 'Вход не выполнен. Проверьте логин и пароль.');
}

async function consumeLoginAttempt(db: Pool, ip: string, login: string | undefined, config: AccessConfig) {
  return transaction(db, async (tx) => {
    const buckets = [
      { id: digest(`source:${ip}`), limit: config.loginSourceLimit },
      { id: digest(`account:${login ?? '<invalid>'}`), limit: config.loginAccountLimit },
    ];
    for (const bucket of buckets) {
      const { rows: [result] } = await tx.query<{ attempts: number }>(
        `INSERT INTO access_login_limits (bucket, expires_at, attempts)
         VALUES ($1, statement_timestamp() + make_interval(secs => $2), 1)
         ON CONFLICT (bucket) DO UPDATE SET
           attempts = CASE WHEN access_login_limits.expires_at <= statement_timestamp()
             THEN 1 ELSE LEAST(access_login_limits.attempts + 1, 31536001) END,
           expires_at = CASE WHEN access_login_limits.expires_at <= statement_timestamp()
             THEN EXCLUDED.expires_at ELSE access_login_limits.expires_at END
         RETURNING attempts`,
        [bucket.id, config.loginWindowSeconds],
      );
      if (result.attempts > bucket.limit) return false;
    }
    return true;
  });
}

export type TokenPurpose = 'invite' | 'reset';

export async function issueToken(tx: PoolClient, userId: string, purpose: TokenPurpose, ttl: number) {
  await tx.query(
    `UPDATE access_tokens SET invalidated_at = statement_timestamp()
     WHERE user_id = $1 AND purpose = $2 AND consumed_at IS NULL AND invalidated_at IS NULL`,
    [userId, purpose],
  );
  const token = randomSecret();
  const { rows: [issued] } = await tx.query<{ id: string; expiresAt: Date }>(
    `INSERT INTO access_tokens (user_id, purpose, token_hash, expires_at)
     VALUES ($1, $2, $3, statement_timestamp() + make_interval(secs => $4))
     RETURNING id, expires_at AS "expiresAt"`,
    [userId, purpose, digest(token), ttl],
  );
  return { ...issued, expiresAt: issued.expiresAt.toISOString(), token };
}

async function completeToken(db: Pool, body: unknown, purpose: TokenPurpose, requestId: string) {
  const { token, password } = object(body);
  const badToken = () => invalid('token_unavailable', 'Ссылка недействительна или её срок истёк.');
  if (!isSecret(token)) throw badToken();
  const hash = digest(token);
  const { rows: [target] } = await db.query<{ userId: string; organizationId: string }>(
    `SELECT t.user_id AS "userId", u.organization_id AS "organizationId"
     FROM access_tokens t JOIN users u ON u.id = t.user_id
     WHERE t.token_hash = $1 AND t.purpose = $2 AND t.consumed_at IS NULL
       AND t.invalidated_at IS NULL AND t.expires_at > statement_timestamp()`,
    [hash, purpose],
  );
  if (!target) throw badToken();
  const encoded = await passwordHash(validatePassword(password));

  await transaction(db, async (tx) => {
    await lockOrganization(tx, target.organizationId, true);
    const { rowCount } = await tx.query(
      `UPDATE access_tokens SET consumed_at = statement_timestamp()
       WHERE token_hash = $1 AND purpose = $2 AND consumed_at IS NULL
         AND invalidated_at IS NULL AND expires_at > statement_timestamp()`,
      [hash, purpose],
    );
    if (!rowCount) throw badToken();
    const { rows: [saved] } = await tx.query<{ version: number }>(
      `UPDATE users SET password_hash = $1, state = 'active', version = version + 1
       WHERE id = $2 AND state = $3 RETURNING version`,
      [encoded, target.userId, purpose === 'invite' ? 'invited' : 'active'],
    );
    if (!saved) throw badToken();
    await revokeSessions(tx, target.userId);
    await writeAudit(tx, {
      actorId: target.userId, organizationId: target.organizationId, role: 'user',
      action: purpose === 'invite' ? 'invitation.complete' : 'password-reset.complete',
      objectId: target.userId, version: saved.version, outcome: 'ok', requestId,
    });
  });
}

function publicAccount(credential: Account) {
  return { id: credential.id, organizationId: credential.organizationId, login: credential.login };
}

export { publicAccount };

export function registerSessions(app: FastifyInstance, db: Pool, config: AccessConfig) {
  app.post('/api/sessions', async (request, reply) => {
    const payload = object(request.body);
    const login = normalizeLogin(payload.login);
    if (!await consumeLoginAttempt(db, request.ip, login, config)) {
      reply.header('Retry-After', String(config.loginWindowSeconds));
      await writeAudit(db, { role: 'anonymous', action: 'session.login', outcome: 'login_limited', requestId: request.id });
      throw new AccessError(429, 'login_limited', 'Слишком много попыток. Повторите позже.');
    }
    const password = typeof payload.password === 'string' && Buffer.byteLength(payload.password) <= 1024
      ? payload.password : '';
    const { rows: [credential] } = await db.query<Credential>(
      `SELECT ${accountColumns}, u.password_hash AS "passwordHash" FROM users u
       WHERE u.login = $1 AND u.state = 'active'`,
      [login ?? null],
    );
    if (!await verifyPassword(credential?.passwordHash, password)) {
      await writeAudit(db, {
        role: 'anonymous', action: 'session.login', outcome: 'invalid_credentials', requestId: request.id,
      });
      throw loginError();
    }

    let previous: SessionAccount | undefined;
    try {
      previous = await readSession(db, request);
    } catch (error) {
      if (!(error instanceof AccessError) || error.statusCode !== 401) throw error;
    }
    const token = randomSecret();
    await transaction(db, async (tx) => {
      const organizations = new Set([credential.organizationId]);
      if (previous) organizations.add(previous.organizationId);
      for (const id of [...organizations].sort()) await lockOrganization(tx, id, false);
      if (previous) await lockSession(tx, previous.sessionId, true);

      const { rowCount } = await tx.query(
        `INSERT INTO access_sessions (user_id, token_hash, expires_at)
         SELECT id, $2, statement_timestamp() + make_interval(secs => $3)
         FROM users WHERE id = $1 AND state = 'active' AND password_hash = $4 AND login = $5`,
        [credential.id, digest(token), config.absoluteSeconds, credential.passwordHash, credential.login],
      );
      if (!rowCount) throw loginError();
      if (previous) {
        await tx.query(
          'UPDATE access_sessions SET revoked_at = statement_timestamp() WHERE id = $1 AND revoked_at IS NULL',
          [previous.sessionId],
        );
      }
      await writeAudit(tx, {
        actorId: credential.id, organizationId: credential.organizationId, role: 'user',
        action: 'session.login', objectId: credential.id, outcome: 'ok', requestId: request.id,
      });
    });
    writeCookie(reply, token, config);
    return { user: publicAccount(credential), csrfToken: csrfToken(token) };
  });

  app.delete('/api/sessions/current', async (request, reply) => {
    const session = await readSession(db, request);
    await transaction(db, async (tx) => {
      await lockOrganization(tx, session.organizationId, false);
      await lockSession(tx, session.sessionId, true);
      await tx.query(
        'UPDATE access_sessions SET revoked_at = statement_timestamp() WHERE id = $1 AND revoked_at IS NULL',
        [session.sessionId],
      );
      await writeAudit(tx, {
        actorId: session.id, organizationId: session.organizationId, role: 'user',
        action: 'session.logout', objectId: session.id, outcome: 'ok', requestId: request.id,
      });
    });
    writeCookie(reply, '', config);
    return reply.code(204).send();
  });

  app.post('/api/password/change', async (request, reply) => {
    requireMutationProtection(request);
    const session = await readSession(db, request);
    const { currentPassword, password } = object(request.body);
    const updatedPassword = validatePassword(password);
    if (!await consumeLoginAttempt(db, request.ip, session.login, config)) {
      reply.header('Retry-After', String(config.loginWindowSeconds));
      throw new AccessError(429, 'login_limited', 'Слишком много попыток. Повторите позже.');
    }
    const { rows: [credential] } = await db.query<{ passwordHash: string }>(
      'SELECT password_hash AS "passwordHash" FROM users WHERE id = $1',
      [session.id],
    );
    if (typeof currentPassword !== 'string' || Buffer.byteLength(currentPassword) > 1024 ||
        !await verifyPassword(credential?.passwordHash, currentPassword)) {
      throw invalid('invalid_current_password', 'Текущий пароль не подтверждён.');
    }
    const encoded = await passwordHash(updatedPassword);
    await transaction(db, async (tx) => {
      await lockOrganization(tx, session.organizationId, true);
      await readSession(tx, request);
      const { rows: [saved] } = await tx.query<{ version: number }>(
        'UPDATE users SET password_hash = $1, version = version + 1 WHERE id = $2 AND password_hash = $3 RETURNING version',
        [encoded, session.id, credential.passwordHash],
      );
      if (!saved) throw invalid('invalid_current_password', 'Текущий пароль не подтверждён.');
      await revokeSessions(tx, session.id);
      await tx.query(
        `UPDATE access_tokens SET invalidated_at = statement_timestamp()
         WHERE user_id = $1 AND purpose = 'reset' AND consumed_at IS NULL AND invalidated_at IS NULL`,
        [session.id],
      );
      await writeAudit(tx, {
        actorId: session.id, organizationId: session.organizationId, role: 'user',
        action: 'password.change', objectId: session.id, version: saved.version, outcome: 'ok', requestId: request.id,
      });
    });
    writeCookie(reply, '', config);
    return reply.code(204).send();
  });

  app.post('/api/invitations/complete', async (request, reply) => {
    await completeToken(db, request.body, 'invite', request.id);
    return reply.code(204).send();
  });

  app.post('/api/password-resets/complete', async (request, reply) => {
    await completeToken(db, request.body, 'reset', request.id);
    writeCookie(reply, '', config);
    return reply.code(204).send();
  });
}
