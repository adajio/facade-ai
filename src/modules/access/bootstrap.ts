import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import pg from 'pg';
import type { Pool } from 'pg';
import { normalizeLogin, passwordHash, validatePassword } from './auth.js';
import { transaction, writeAudit } from './commands.js';
import { AccessError, invalid } from './errors.js';
import { text } from './input.js';

export async function bootstrapAdmin(db: Pool, input: { organization: string; login: string; password: string }) {
  const organization = text(input.organization, 'organization');
  const login = normalizeLogin(input.login);
  if (!login) throw invalid('invalid_login');
  const hash = await passwordHash(validatePassword(input.password));

  return transaction(db, async (tx) => {
    await tx.query("SELECT pg_advisory_xact_lock(hashtextextended('facade:access:bootstrap', 0))");
    const { rowCount } = await tx.query('SELECT 1 FROM access_bootstrap');
    if (rowCount) throw new AccessError(409, 'already_bootstrapped', 'Администратор установки уже создан.');

    const { rows: [{ id: organizationId }] } = await tx.query<{ id: string }>(
      'INSERT INTO organizations (name) VALUES ($1) RETURNING id',
      [organization],
    );
    const { rows: [{ id: userId }] } = await tx.query<{ id: string }>(
      `INSERT INTO users (organization_id, login, password_hash, state, org_admin, can_create_project)
       VALUES ($1, $2, $3, 'active', true, true) RETURNING id`,
      [organizationId, login, hash],
    );
    await tx.query('INSERT INTO access_bootstrap (organization_id, user_id) VALUES ($1, $2)', [organizationId, userId]);
    await writeAudit(tx, {
      organizationId, role: 'installation_operator', action: 'organization.bootstrap',
      objectId: userId, outcome: 'ok',
    });
    return { organizationId, userId };
  });
}

async function main() {
  const [organization, login] = process.argv.slice(2);
  if (!process.env.DATABASE_URL || !organization || !login || process.stdin.isTTY) {
    console.error('DATABASE_URL and arguments <organization> <login> are required. Provide the password via stdin.');
    process.exitCode = 1;
    return;
  }
  const db = new pg.Pool({ connectionString: process.env.DATABASE_URL });
  try {
    const passFile = process.platform === 'win32' ? 'CONIN$' : '/dev/stdin';
    const password = (await readFile(passFile, 'utf8')).replace(/\r?\n$/, '');
    console.log(JSON.stringify(await bootstrapAdmin(db, { organization, login, password })));
  } catch (error) {
    console.error(error instanceof AccessError ? error.code : 'bootstrap_failed');
    process.exitCode = 1;
  } finally {
    await db.end();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
