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
  const { lockProjectScopes, transaction, updateConfirmedFacadeKinds } = await import(new URL('src/modules/access/index.js', build));
  const { lockOrganization } = await import(new URL('src/modules/access/commands.js', build));
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

  await t.test('first intake project and approved catalog resolution', async () => {
    const creatorId = await invite('intake-creator');
    await request(`/users/${creatorId}`, {
      auth: owner, method: 'PATCH', version: 2, key: 'intake-creator:right',
      body: { canCreateProject: true },
    });
    const creator = await login('intake-creator');
    const initialEngineer = await login('engineer');
    assert.equal((await db.query('SELECT id FROM catalog_versions')).rowCount, 0);
    const create = (auth, name, status = 201) => request('/projects', {
      auth, method: 'POST', key: name, body: { mode: 'intake', name }, status,
    });
    await create(initialEngineer, 'no-create-permission', 403);
    const first = (await create(creator, 'first-intake')).value;
    assert.deepEqual((await create(creator, 'first-intake')).value, first);
    const path = `/projects/${first.id}`;
    const read = (auth = creator) => request(path, { auth });
    const { value: created } = await read();
    assert.equal(created.role, 'project_manager');
    assert.equal(created.catalogVersionId, null);
    assert.equal(created.catalog, null);
    assert.equal(created.catalogState, 'unassigned');
    assert.equal(created.stage, null);
    assert.equal(created.stageStatus, 'unknown');
    assert.deepEqual(created.scopes, []);
    assert.deepEqual((await request('/me', { auth: creator })).value.projects.map(({ id, role }) => [id, role]),
      [[first.id, 'project_manager']]);
    await request(path, { auth: owner, status: 404 });
    const { value: membership } = await request(`${path}/members/${ids.engineer}`, {
      auth: creator, method: 'PUT', key: 'intake-engineer', version: created.version, body: { role: 'engineer' },
    });
    const engineer = await login('engineer');
    assert.equal((await read(engineer)).value.role, 'engineer');
    await request(path + '/catalog-options', { auth: engineer, status: 403 });
    const confirm = (path, auth, key, version, status = 200, stage = 'RD') => request(path + '/stage', {
      auth, method: 'PUT', key, version, body: { stage, reason: 'Синтетическое решение' }, status,
    });
    await confirm(path, engineer, 'engineer-project-stage', membership.version, 403);
    const staged = (await confirm(path, creator, 'project-stage', membership.version)).value;
    assert.equal(staged.stageStatus, 'confirmed');
    const stale = await confirm(path, creator, 'stale-stage', membership.version, 412, 'P');
    assert.equal(stale.value.currentVersion, staged.version);

    const publish = (auth, key, requirements, defaultProfile, status = 201) => request('/catalogs', {
      auth, method: 'POST', key, body: { key, name: key, requirements, defaultProfile }, status,
    });
    const profile = { stage: 'RD', facadeKinds: ['synthetic-kind'], approvalReference: 'synthetic-reference' };
    await publish(creator, 'unauthorized-profile', [catalogRule], profile, 403);
    const empty = (await publish(owner, 'empty-profile', [], profile, 422)).value;
    assert.equal(empty.code, 'empty_default_profile');
    const legacyCatalog = (await publish(owner, 'legacy-empty', [])).value;
    const { value: legacy } = await request('/projects', {
      auth: owner, method: 'POST', key: 'old-client', body: { name: 'old-client', catalogVersionId: legacyCatalog.id }, status: 201,
    });
    const historical = (await request(`/projects/${legacy.id}`, { auth: owner })).value;
    assert.equal(historical.stageStatus, 'legacy_unconfirmed');
    assert.equal(historical.stage, null);
    assert.equal(historical.scopes[0].stage, 'design');
    assert.equal(historical.catalogState, 'legacy_empty');

    const setKinds = (projectId, expectedVersion, facadeKinds, userId = ids.engineer) => transaction(db, async (tx) => {
      await lockOrganization(tx, created.organizationId, false);
      return updateConfirmedFacadeKinds(tx, {
        projectId, expectedVersion, facadeKinds, actor: {
          organizationId: created.organizationId, userId, role: userId === creatorId ? 'project_manager' : 'engineer',
        },
      });
    });
    const resolvedKinds = await setKinds(first.id, staged.version, ['synthetic-kind', 'synthetic-kind']);
    assert.deepEqual(resolvedKinds.confirmedFacadeKinds, ['synthetic-kind']);
    assert.equal(resolvedKinds.catalogVersionId, null);
    const options = (path) => request(path + '/catalog-options', { auth: creator });
    assert.equal((await options(path)).value.reason, 'no_approved_profile');
    const invalidLevel = await publish(owner, 'working-invalid-level', [{ ...catalogRule, level: 'document' }], profile, 422);
    assert.equal(invalidLevel.value.code, 'invalid_requirement_level');
    const approved = (await publish(owner, 'working-a', [{ ...catalogRule, level: 'facade' }], profile)).value;
    assert.equal(approved.requirements[0].level, 'facade');
    assert.equal((await read()).value.catalogVersionId, approved.id);
    const second = (await create(creator, 'second-intake')).value;
    const secondPath = `/projects/${second.id}`;
    const secondStage = (await confirm(secondPath, creator, 'second-stage', second.version)).value;
    assert.equal((await setKinds(second.id, secondStage.version, profile.facadeKinds, creatorId)).catalogVersionId, approved.id);
    const racing = (await create(creator, 'racing-intake')).value;
    const racingPath = `/projects/${racing.id}`;
    const waiting = await setKinds(racing.id, racing.version, profile.facadeKinds, creatorId);
    const [, attemptedPin] = await Promise.all([
      confirm(racingPath, creator, 'racing-stage', waiting.version),
      fetch(`${origin}/api${racingPath}/catalog`, {
        method: 'PUT',
        headers: {
          Origin: origin, Cookie: creator.cookie, 'X-CSRF-Token': creator.csrf,
          'Idempotency-Key': 'racing-pin', 'If-Match': `"${waiting.version}"`, 'Content-Type': 'application/json',
        },
        body: JSON.stringify({ catalogVersionId: approved.id }),
      }),
    ]);
    assert.ok([412, 422].includes(attemptedPin.status));
    assert.equal((await request(racingPath, { auth: creator })).value.catalogVersionId, approved.id);
    const otherProfile = (await publish(owner, 'working-b', [{ ...catalogRule, level: 'common' }], profile)).value;
    assert.equal(otherProfile.requirements[0].level, 'common');
    const third = (await create(creator, 'third-intake')).value;
    const thirdPath = `/projects/${third.id}`;
    const thirdStage = (await confirm(thirdPath, creator, 'third-stage', third.version)).value;
    await setKinds(third.id, thirdStage.version, profile.facadeKinds, creatorId);
    const choices = (await options(thirdPath)).value;
    assert.equal(choices.reason, 'multiple_profiles');
    assert.deepEqual(choices.catalogs.map(({ id }) => id).sort(), [approved.id, otherProfile.id].sort());
    const pin = (id, version, status, key) => request(thirdPath + '/catalog', {
      auth: creator, method: 'PUT', key, version, body: { catalogVersionId: id }, status,
    });
    assert.equal((await pin(legacyCatalog.id, choices.version, 422, 'empty-cannot-pin')).value.code, 'catalog_not_applicable');
    assert.equal((await pin(otherProfile.id, thirdStage.version, 412, 'stale-pin')).value.code, 'version_conflict');
    assert.equal((await pin(otherProfile.id, choices.version, 200, 'manual-pin')).value.catalogVersionId, otherProfile.id);
    const afterStageChange = (await confirm(path, creator, 'changed-stage', (await read()).value.version, 200, 'P')).value;
    assert.equal(afterStageChange.catalogVersionId, approved.id);
    assert.equal((await db.query('SELECT id FROM project_scopes WHERE project_id = $1', [first.id])).rowCount, 0);
    assert.equal((await db.query("SELECT id FROM access_audit WHERE project_id = $1 AND action = 'project.catalog.auto_assign'", [first.id])).rowCount, 1);

    const originalId = randomUUID();
    const sha = '1'.repeat(64);
    await db.query('INSERT INTO intake_originals (id, project_id, object_key, size, sha256) VALUES ($1,$2,$3,1,$4)',
      [originalId, first.id, originalId, sha]);
    const { rows: [document] } = await db.query('INSERT INTO intake_documents (project_id) VALUES ($1) RETURNING id', [first.id]);
    const { rows: [receipt] } = await db.query("INSERT INTO intake_receipts (project_id, source, created_by) VALUES ($1,'upload',$2) RETURNING id",
      [first.id, creatorId]);
    const versions = [];
    for (const page of ['P', 'RD']) {
      const { rows: [{ id: versionId }] } = await db.query(
        "INSERT INTO intake_document_versions (project_id, document_id, original_id, media_type) VALUES ($1,$2,$3,'application/pdf') RETURNING id",
        [first.id, document.id, originalId]);
      await db.query(`INSERT INTO reader_maps (project_id, document_id, version_id, reader_version, receipt_id, original_sha256, format, units)
         VALUES ($1,$2,$3,'fixture',$4,$5,'pdf','[]')`, [first.id, document.id, versionId, receipt.id, sha]);
      const evidenceId = randomUUID();
      const address = { unitId: page };
      await db.query(`INSERT INTO reader_evidence (id, project_id, version_id, reader_version, run_id, branch, operation_key, request_sha256, payload)
        VALUES ($1,$2,$3,'fixture',$4,'A','title',$5,$6)`, [evidenceId, first.id, versionId, randomUUID(), sha, { address }]);
      versions.push({ versionId, evidenceId, address, stage: page });
    }
    for (const [index, basis] of versions.entries()) {
      const url = `${path}/versions/${basis.versionId}/stage`;
      const body = { stage: basis.stage, reason: 'Синтетический титул', evidenceId: basis.evidenceId, target: index ? 'place' : 'document' };
      const saved = await request(url, { auth: engineer, method: 'PUT', key: `version-stage-${index}`, version: 1, body });
      assert.equal(saved.value.version, 2);
      const current = await request(url + (index ? `?evidenceId=${basis.evidenceId}` : ''), { auth: creator });
      assert.equal(current.value.stage, basis.stage);
      assert.deepEqual(current.value.address, index ? basis.address : null);
      await request(url, { auth: engineer, method: 'PUT', key: `version-stale-${index}`, version: 1, body, status: 412 });
      await request(url, { auth: engineer, method: 'PUT', key: `version-wrong-basis-${index}`, version: 2,
        body: { ...body, evidenceId: versions[1 - index].evidenceId }, status: 404 });
    }
    assert.equal((await read()).value.version, afterStageChange.version);
  });

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
    assert.equal((await db.query('SELECT id FROM projects WHERE name = $1', [projectInput.name])).rowCount, 1);
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
