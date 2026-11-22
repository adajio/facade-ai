import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { test } from 'node:test';
import pg from 'pg';

const build = pathToFileURL(resolve(process.env.FACADE_ACCESS_BUILD_DIR ?? 'dist') + '/');
const enabled = process.env.FACADE_ACCESS_TEST === '1';

const catalogRule = {
  key: 'SZ-01',
  part: 'Спецификация крепежа',
  formats: ['PDF'],
  equivalents: ['XLSX'],
  applicability: 'all',
  sourceRoles: ['основной'],
  completenessCriterion: 'Указаны размеры и материал',
  addressee: 'Проектировщик',
};

test('access v1.1 on Fastify and PostgreSQL', { skip: !enabled, timeout: 240_000 }, async (t) => {
  assert.ok(process.env.DATABASE_URL, 'use an isolated migrated test database');
  const { createApi } = await import(new URL('src/platform/api.js', build));
  const { bootstrapAdmin } = await import(new URL('src/modules/access/bootstrap.js', build));
  const { lockProjectScopes, transaction } = await import(new URL('src/modules/access/index.js', build));
  process.env.FACADE_LOGIN_ACCOUNT_LIMIT = '8';
  process.env.FACADE_LOGIN_SOURCE_LIMIT = '80';
  const password = randomUUID();
  const nextPassword = randomUUID();
  const db = new pg.Pool({ connectionString: process.env.DATABASE_URL });
  t.after(() => db.end());

  const admin = await bootstrapAdmin(db, { organization: 'Синтетическая', login: 'OWNER', password });
  await assert.rejects(
    bootstrapAdmin(db, { organization: 'Лишняя', login: 'second-owner', password }),
    { code: 'already_bootstrapped' },
  );
  const app = await createApi({
    databaseUrl: process.env.DATABASE_URL,
    dataDir: process.env.FACADE_DATA_DIR,
    host: '127.0.0.1',
    port: 0,
  });
  t.after(() => app.close());
  const origin = await app.listen({ host: '127.0.0.1', port: 0 });

  async function request(path, {
    auth, body, method = 'GET', key, version, status = 200, csrf = true, source = origin,
  } = {}) {
    const headers = { Origin: source };
    if (auth) headers.Cookie = auth.cookie;
    if (auth && csrf) headers['X-CSRF-Token'] = auth.csrf;
    if (key) headers['Idempotency-Key'] = key;
    if (version != null) headers['If-Match'] = `"${version}"`;
    const serialized = body === undefined ? undefined : JSON.stringify(body);
    if (serialized !== undefined) headers['Content-Type'] = 'application/json';
    const response = await fetch(`${origin}/api${path}`, { headers, body: serialized, method });
    assert.equal(response.status, status, `${method} ${path}`);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    const value = status === 204 ? undefined : await response.json();
    return { response, value };
  }

  async function login(login, secret = password) {
    const { response, value } = await request('/sessions', { method: 'POST', body: { login, password: secret } });
    const setCookie = response.headers.get('set-cookie');
    assert.match(setCookie, /; HttpOnly; SameSite=Lax/);
    return { cookie: setCookie.split(';')[0], csrf: value.csrfToken };
  }

  const owner = await login(' Owner ');
  async function invite(login) {
    const { value } = await request('/users/invitations', {
      auth: owner, method: 'POST', body: { login }, key: `invite:${login}`, status: 201,
    });
    assert.ok(value.token);
    const replay = await request('/users/invitations', {
      auth: owner, method: 'POST', body: { login }, key: `invite:${login}`, status: 201,
    });
    assert.equal(replay.value.id, value.id);
    assert.equal(replay.value.token, undefined);
    const body = { token: value.token, password };
    await request('/invitations/complete', { method: 'POST', body, status: 204 });
    const used = await request('/invitations/complete', { method: 'POST', body, status: 422 });
    assert.equal(used.value.code, 'token_unavailable');
    return value.userId;
  }

  await t.test('authentication, Origin and CSRF', async () => {
    await request('/me', { status: 401 });
    await request('/sessions', { method: 'POST', body: { login: 'owner', password }, source: 'https://example.invalid', status: 403 });
    const { value } = await request('/catalogs', {
      auth: owner, csrf: false, method: 'POST', body: {}, status: 403,
    });
    assert.equal(value.code, 'csrf_required');
    const unauthorized = { method: 'POST', status: 401 };
    const unknown = await request('/sessions', { ...unauthorized, body: { login: 'missing', password } });
    const wrong = await request('/sessions', { ...unauthorized, body: { login: 'owner', password: nextPassword } });
    assert.equal(wrong.value.code, unknown.value.code);
    assert.equal(wrong.value.message, unknown.value.message);
    const { value: profile } = await request('/me', { auth: owner });
    assert.deepEqual(profile.actions.sort(), ['organization:admin', 'organization:create-project']);
    assert.deepEqual(profile.projects, []);
  });

  const ids = {};
  for (const role of ['engineer', 'viewer', 'stranger', 'operator', 'admin']) ids[role] = await invite(role);
  const accountRows = await db.query('SELECT id, password_hash FROM users');
  assert.equal(new Set(accountRows.rows.map((row) => row.password_hash)).size, 6);
  assert.ok(accountRows.rows.every((row) => row.password_hash.startsWith('$argon2id$v=19$')));

  for (const [name, flags] of [['operator', { technicalOperator: true }], ['admin', { orgAdmin: true }]]) {
    await request(`/users/${ids[name]}`, { auth: owner, method: 'PATCH', version: 2, key: `role:${name}`, body: flags });
  }
  const catalogInput = { key: 'fasteners', name: 'Крепёж', requirements: [catalogRule] };
  const { value: catalog } = await request('/catalogs', {
    auth: owner, method: 'POST', body: catalogInput, key: 'catalog-1', status: 201,
  });
  const { value: catalog2 } = await request('/catalogs', {
    auth: owner, method: 'POST', key: 'catalog-2', status: 201,
    body: { ...catalogInput, name: 'Крепёж 2', requirements: [{ ...catalogRule, formats: ['DWG'] }] },
  });
  const { value: catalog3 } = await request('/catalogs', {
    auth: owner, method: 'POST', key: 'catalog-3', status: 201,
    body: { ...catalogInput, name: 'Крепёж 3', requirements: [{ ...catalogRule, formats: ['IFC'] }] },
  });
  assert.equal(catalog2.revision, 2);
  assert.equal(catalog3.revision, 3);

  let project;
  let scope1;
  let scope2;
  const projectInput = { name: 'Испытательный проект', catalogVersionId: catalog.id, stage: 'stage-1', scopeName: 'А' };
  const createProject = (body, status = 201) => request('/projects', {
    auth: owner, body, method: 'POST', key: 'project-1', status,
  });

  await t.test('duplicate concurrent commands yield one project, mismatched body yields 409', async () => {
    const [first, second] = await Promise.all([
      createProject(projectInput), createProject({
        scopeName: 'А', stage: 'stage-1', catalogVersionId: catalog.id, name: 'Испытательный проект',
      }),
    ]);
    assert.deepEqual(first.value, second.value);
    project = first.value;
    [scope1] = project.scopes;
    const conflict = await createProject({ ...projectInput, name: 'Другое назначение' }, 409);
    assert.equal(conflict.value.code, 'idempotency_conflict');
    await createProject({ ...projectInput, extra: true }, 409);
    assert.equal((await db.query('SELECT id FROM projects')).rowCount, 1);
    const { value } = await request(`/projects/${project.id}/scopes`, {
      auth: owner, method: 'POST', key: 'scope-b', body: { name: 'Б', stage: 'stage-2' }, status: 201,
    });
    scope2 = value;
  });

  let version = (await request(`/projects/${project.id}`, { auth: owner })).value.version;
  const member = (name) => `/projects/${project.id}/members/${ids[name]}`;
  const auth = {};
  for (const name of Object.keys(ids)) auth[name] = await login(name);

  await t.test('memberships isolate projects and scoped, expiring operator access', async () => {
    for (const name of ['engineer', 'viewer']) {
      const { value } = await request(member(name), {
        auth: owner, method: 'PUT', body: { role: name }, key: `assign:${name}`, version,
      });
      version = value.version;
      await request('/me', { auth: auth[name], status: 401 });
      auth[name] = await login(name);
    }
    const projectPath = `/projects/${project.id}`;
    const viewer = await request(projectPath, { auth: auth.viewer });
    assert.deepEqual(viewer.value.actions, ['project:read']);
    const { value: operators } = await request('/me', { auth: auth.operator });
    assert.deepEqual(operators.actions, ['operator:diagnose']);
    assert.deepEqual(operators.projects, []);

    for (const name of ['stranger', 'admin', 'operator']) {
      const actual = (await request(projectPath, { auth: auth[name], status: 404 })).value;
      const random = (await request(`/projects/${randomUUID()}`, { auth: auth[name], status: 404 })).value;
      assert.equal(actual.code, random.code);
      assert.equal(actual.message, random.message);
    }

    const bad = await request(member('operator'), {
      auth: owner, method: 'PUT', body: { role: 'viewer' }, key: 'operator-unbounded', version, status: 422,
    });
    assert.equal(bad.value.code, 'operator_grant_required');
    const authorized = await request(member('operator'), {
      auth: owner, method: 'PUT', body: {
        role: 'viewer', scopeId: scope1.id, reason: 'Синтетическая сверка',
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      },
      key: 'operator-scoped', version,
    });
    version = authorized.value.version;
    auth.operator = await login('operator');
    await request(`${projectPath}/scopes/${scope1.id}`, { auth: auth.operator });
    await request(`${projectPath}/scopes/${scope2.id}`, { auth: auth.operator, status: 404 });
    await request(projectPath, { auth: auth.operator, status: 404 });
    await db.query(
      "UPDATE project_memberships SET expires_at = now() - interval '1 second' WHERE project_id = $1 AND user_id = $2",
      [project.id, ids.operator],
    );
    await request(`${projectPath}/scopes/${scope1.id}`, { auth: auth.operator, status: 404 });
  });

  const scopePath = `/projects/${project.id}/scopes/${scope1.id}`;
  const customRules = [{ ...catalogRule, part: 'Крепёж области А' }];
  const updateScope = (actor, version, key, status = 200) => request(`${scopePath}/requirements`, {
    auth: actor, method: 'PUT', body: { requirements: customRules }, key, version, status,
  });

  await t.test('catalog pins retain each assessment and event without a current assessment GET', async () => {
    const catalogPath = `/projects/${project.id}/catalog`;
    const firstVersion = version;
    const pin = (id, key, expected, auth, status = 200) => request(catalogPath, {
      auth, method: 'PUT', version: expected, key, body: { catalogVersionId: id }, status,
    });

    await pin(catalog2.id, 'pin-viewer', firstVersion, auth.viewer, 403);
    const first = await pin(catalog2.id, 'pin-2', firstVersion, owner);
    const stale = await pin(catalog3.id, 'pin-stale', firstVersion, owner, 412);
    assert.equal(stale.value.code, 'version_conflict');
    const second = await pin(catalog3.id, 'pin-3', first.value.version, owner);
    version = second.value.version;
    assert.deepEqual((await pin(catalog2.id, 'pin-2', firstVersion, owner)).value, first.value);
    assert.equal((await pin(catalog3.id, 'pin-3-noop', version, owner)).value.version, version);

    const events = await db.query(
      `SELECT payload->>'scopeId' AS "scopeId", (payload->>'assessmentVersion')::integer AS version
       FROM supplement_project_events WHERE project_id = $1 AND type = 'assessment.changed' ORDER BY cursor`,
      [project.id],
    );
    for (const scope of [scope1, scope2]) {
      const history = await db.query(
        `SELECT a.version, a.catalog_version_id AS "catalogVersionId", a.change->>'reason' AS reason,
                q.requirement->'requiredFormats' AS "requiredFormats"
         FROM assessment_revisions a JOIN assessment_question_revisions q
           ON q.scope_id = a.scope_id AND q.assessment_version = a.version
         WHERE a.scope_id = $1 ORDER BY a.version`,
        [scope.id],
      );
      assert.deepEqual(history.rows, [
        { version: 1, catalogVersionId: catalog.id, reason: 'catalog_initialized', requiredFormats: ['pdf'] },
        { version: 2, catalogVersionId: catalog2.id, reason: 'catalog_changed', requiredFormats: ['dwg'] },
        { version: 3, catalogVersionId: catalog3.id, reason: 'catalog_changed', requiredFormats: ['ifc'] },
      ]);
      assert.deepEqual(events.rows.filter(({ scopeId }) => scopeId === scope.id).map(({ version }) => version), [1, 2, 3]);
      const path = `/projects/${project.id}/assessments/2?scopeId=${scope.id}`;
      const historical = (await request(path, { auth: auth.viewer })).value;
      assert.equal(historical.version, 2);
      assert.equal(historical.catalogVersionId, catalog2.id);
      await request(path, { auth: auth.stranger, status: 404 });
    }
    const currentPath = `/projects/${project.id}/assessments/current?scopeId=${scope1.id}`;
    const current = (await request(currentPath, { auth: auth.viewer })).value;
    assert.equal(current.version, 3);
    assert.equal(current.catalogVersionId, catalog3.id);
  });

  await t.test('scope edit honors 412, replay and receipt access', async () => {
    const denied = await updateScope(auth.viewer, 3, 'viewer-write', 403);
    assert.equal(denied.value.code, 'forbidden');
    const stale = await updateScope(auth.engineer, 1, 'scope-stale', 412);
    assert.equal(stale.value.code, 'version_conflict');
    assert.equal(stale.value.currentVersion, 3);
    assert.equal(stale.value.href, `/api${scopePath}`);
    const first = await updateScope(auth.engineer, 3, 'scope-edit');
    assert.equal(first.value.version, 4);
    assert.equal(first.value.catalogVersionId, catalog3.id);
    const repeat = await updateScope(auth.engineer, 3, 'scope-edit');
    assert.deepEqual(repeat.value, first.value);
    const updated = (await request(scopePath, { auth: auth.viewer })).value;
    assert.deepEqual(updated.requirements, customRules);

    const removed = await request(member('engineer'), {
      auth: owner, method: 'DELETE', version, key: 'remove-engineer',
    });
    version = removed.value.version;
    await updateScope(auth.engineer, 3, 'scope-edit', 401);
    auth.engineer = await login('engineer');
    await updateScope(auth.engineer, 3, 'scope-edit', 404);
    const event = await db.query(
      "SELECT object_id FROM access_audit WHERE action = 'project.members.remove' AND outcome = 'ok'",
    );
    assert.deepEqual(event.rows, [{ object_id: ids.engineer }]);
    assert.equal((await db.query('SELECT scope_id FROM scope_requirements WHERE scope_id = $1', [scope1.id])).rowCount, 1);
  });

  await t.test('shared scope locks admit independent scopes and serialize whole-project work', async () => {
    await transaction(db, async (holder) => {
      const scopes = await lockProjectScopes(holder, project.id, [scope1.id]);
      assert.equal(scopes[0].id, scope1.id);
      await transaction(db, async (other) => {
        await other.query("SET LOCAL lock_timeout = '700ms'");
        const independent = await lockProjectScopes(other, project.id, [scope2.id]);
        assert.equal(independent[0].id, scope2.id);
      });
      await assert.rejects(transaction(db, async (other) => {
        await other.query("SET LOCAL lock_timeout = '100ms'");
        await lockProjectScopes(other, project.id);
      }), { code: '55P03' });
      await assert.rejects(transaction(db, async (other) => {
        await lockProjectScopes(other, project.id, [randomUUID()]);
      }), { statusCode: 404 });
    });
    await transaction(db, async (tx) => {
      const scopes = await lockProjectScopes(tx, project.id);
      assert.deepEqual(scopes.map(({ id }) => id), [scope1.id, scope2.id].sort());
    });
  });

  await t.test('password reset, explicit session revocation and credential rotation', async () => {
    const issued = await request(`/users/${ids.viewer}/password-resets`, {
      auth: owner, method: 'POST', key: 'reset-viewer', status: 201,
    });
    assert.ok(issued.value.token);
    const cookies = [auth.viewer, await login('viewer')];
    const results = await Promise.all([
      fetch(`${origin}/api/password-resets/complete`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', Origin: origin },
        body: JSON.stringify({ token: issued.value.token, password: nextPassword }),
      }),
      fetch(`${origin}/api/password-resets/complete`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', Origin: origin },
        body: JSON.stringify({ token: issued.value.token, password: nextPassword }),
      }),
    ]);
    assert.deepEqual(results.map((response) => response.status).sort(), [204, 422]);
    for (const session of cookies) await request('/me', { auth: session, status: 401 });
    await request('/sessions', { method: 'POST', body: { login: 'viewer', password }, status: 401 });
    auth.viewer = await login('viewer', nextPassword);
    await request(`/users/${ids.viewer}/revoke-sessions`, {
      auth: owner, method: 'POST', key: 'revoke-viewer',
    });
    await request('/me', { auth: auth.viewer, status: 401 });

    const first = await login('viewer', nextPassword);
    const rotated = await request('/sessions', {
      auth: first, method: 'POST', body: { login: 'viewer', password: nextPassword },
    });
    const cookie = rotated.response.headers.get('set-cookie').split(';')[0];
    assert.notEqual(first.cookie, cookie);
    await request('/me', { auth: first, status: 401 });
    const latest = { cookie, csrf: rotated.value.csrfToken };
    await request('/sessions/current', { auth: latest, method: 'DELETE', status: 204 });
    await request('/me', { auth: latest, status: 401 });

    await request('/password/change', {
      auth: auth.stranger, method: 'POST', status: 204,
      body: { currentPassword: password, password: nextPassword },
    });
    await request('/me', { auth: auth.stranger, status: 401 });
    auth.stranger = await login('stranger', nextPassword);

    const persisted = await db.query('SELECT response_body::text AS receipt FROM command_receipts');
    assert.ok(persisted.rows.every((row) => !row.receipt.includes(issued.value.token)));
    assert.ok(persisted.rows.every((row) => !row.receipt.includes(password)));
  });

  await t.test('owner transfer and the last active administrator are protected', async () => {
    const cannotDisable = await request(`/users/${admin.userId}`, {
      auth: owner, method: 'PATCH', version: 1, key: 'disable-owner', body: { state: 'disabled' }, status: 409,
    });
    assert.equal(cannotDisable.value.code, 'project_owner_required');
    const transferred = await request(`/projects/${project.id}/owner`, {
      auth: auth.admin, method: 'PUT', version, key: 'transfer-admin', body: { userId: ids.engineer },
    });
    version = transferred.value.version;
    await request('/me', { auth: owner, status: 401 });
    const newOwner = await login('engineer');
    const oldOwner = await login('owner');
    const snapshot = await request(`/projects/${project.id}/members`, { auth: newOwner });
    assert.deepEqual(
      snapshot.value.members.filter((row) => row.role === 'project_manager').map(({ userId }) => userId),
      [ids.engineer],
    );
    await request(member('engineer').replace(ids.engineer, admin.userId), {
      auth: newOwner, method: 'DELETE', version, key: 'remove-first-owner',
    });
    await request('/projects', { auth: oldOwner, method: 'POST', body: projectInput, key: 'project-1', status: 401 });
    const admin2session = await login('owner');
    await request('/projects', { auth: admin2session, method: 'POST', body: projectInput, key: 'project-1', status: 404 });
    await request(`/users/${ids.admin}`, {
      auth: admin2session, method: 'PATCH', version: 3, key: 'remove-admin-2', body: { orgAdmin: false },
    });
    const last = await request(`/users/${admin.userId}`, {
      auth: admin2session, method: 'PATCH', version: 1, key: 'remove-last-admin', body: { orgAdmin: false }, status: 409,
    });
    assert.equal(last.value.code, 'last_org_admin');
  });

  await t.test('login limits also apply to unknown accounts', async () => {
    for (let count = 0; count <= 8; count += 1) {
      const limited = await request('/sessions', {
        method: 'POST', body: { login: 'new-unknown-login', password }, status: count < 8 ? 401 : 429,
      });
      if (count === 8) assert.ok(limited.response.headers.get('retry-after'));
    }
  });
});
