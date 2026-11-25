import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { test } from 'node:test';
import Fastify from 'fastify';
import pg from 'pg';

const built = (path) => import(new URL(`../../../dist/src/modules/${path}.js`, import.meta.url));

test('a location link applies only to the exact physical page or XLSX sheet and cell', async () => {
  const { facadePlaceKey, matchingDocumentFacadeLink } = await built('assessment/document-facades');
  const page = (value) => ({ unitId: String(value), locator: { page: value } });
  const cell = (sheet, value) => ({ unitId: 'range', locator: { sheet, cell: value } });
  const fallback = { facadeId: 'whole' };
  const left = { facadeId: 'left' };
  const byPlace = new Map([['document', fallback], [facadePlaceKey(page(1)), left], [facadePlaceKey(cell('А', 'I3')), left]]);
  assert.equal(matchingDocumentFacadeLink(byPlace, page(1)), left);
  assert.equal(matchingDocumentFacadeLink(byPlace, page(2)), fallback);
  assert.equal(matchingDocumentFacadeLink(byPlace, cell('А', 'I3')), left);
  assert.equal(matchingDocumentFacadeLink(byPlace, cell('Б', 'I3')), fallback);
  assert.equal(matchingDocumentFacadeLink(byPlace, cell('А', 'I4')), fallback);
});

test('an engineer links and types a facade from an accepted PDF with zero machine findings', {
  skip: process.env.FACADE_D7_DATABASE_TEST !== '1' || !process.env.DATABASE_URL,
}, async (t) => {
  const origin = 'http://127.0.0.1:3000';
  process.env.FACADE_PUBLIC_ORIGIN = origin;
  const db = new pg.Pool({ connectionString: process.env.DATABASE_URL });
  const app = Fastify();
  app.decorate('db', db);
  t.after(async () => { await app.close(); await db.end(); });
  for (const name of ['access', 'assessment']) await app.register((await built(`${name}/index`)).register);
  const { bootstrapAdmin } = await built('access/bootstrap');
  const { passwordHash } = await built('access/auth');
  const password = 'd7-synthetic-fixture-password';
  const { userId, organizationId } = await bootstrapAdmin(db, { organization: 'Synthetic D7', login: 'd7-owner', password });
  const request = async (method, url, payload, { session, version, status = 200 } = {}) => {
    const response = await app.inject({ method, url, payload, headers: { origin, ...session,
      'idempotency-key': randomUUID(), ...(version === undefined ? {} : { 'if-match': `"${version}"` }) } });
    assert.equal(response.statusCode, status, `${method} ${url}: ${response.body}`);
    return response;
  };
  const login = async (name) => {
    const response = await request('POST', '/api/sessions', { login: name, password });
    return { cookie: response.headers['set-cookie'].split(';')[0], 'x-csrf-token': response.json().csrfToken };
  };
  const owner = await login('d7-owner');
  const row = { key: 'panel', part: 'Кассеты', level: 'facade', applicability: 'all', formats: ['pdf'],
    equivalents: [], sourceRoles: ['drawing'], completenessCriterion: 'Нужен адрес', addressee: 'Заказчик', facadeKinds: ['panel'] };
  let legacyCatalogVersion;
  for (const [key, stage, facadeKinds] of [['d7-intake', 'Стадия 1', []], ['d7-panel', 'РД', ['panel']]]) {
    const published = await request('POST', '/api/catalogs', { key, name: key, requirements: [row],
      defaultProfile: { stage, facadeKinds, approvalReference: 'Synthetic rule' } }, { session: owner, status: 201 });
    legacyCatalogVersion = published.json().id;
  }
  const legacy = (await request('POST', '/api/projects', { name: 'Ранний проект', catalogVersionId: legacyCatalogVersion, stage: 'РД' },
    { session: owner, status: 201 })).json();
  const legacyPath = `/api/v1/projects/${legacy.id}`;
  const legacyScope = legacy.scopes[0].id;
  const legacyAssessment = (await request('GET', `${legacyPath}/assessments/current?scopeId=${legacyScope}`, undefined, { session: owner })).json();
  await request('POST', `${legacyPath}/conclusions`, { scopeId: legacyScope, startWork: 'cannot_start', reason: 'Пустой состав' },
    { session: owner, version: legacyAssessment.version, status: 201 });
  const legacySaved = (await request('GET', `${legacyPath}/assessments/current?scopeId=${legacyScope}`, undefined, { session: owner })).json();
  assert.equal(legacySaved.conclusion.startWork, 'cannot_start');
  assert.equal(legacySaved.conclusion.basis, undefined);
  const createProject = async (name) => (await request('POST', '/api/projects', { mode: 'intake', name },
    { session: owner, status: 201 })).json();
  const project = await createProject('Синтетические фасады');
  async function addMember(role) {
    const name = `d7-${role}`;
    const { rows: [user] } = await db.query(`INSERT INTO users(organization_id,login,state,password_hash)
      VALUES($1,$2,'active',$3) RETURNING id`, [organizationId, name, await passwordHash(password)]);
    await db.query(`INSERT INTO project_memberships(project_id,organization_id,user_id,role)
      VALUES($1,$2,$3,$4)`, [project.id, organizationId, user.id, role]);
    return login(name);
  }
  const engineer = await addMember('engineer');
  const viewer = await addMember('viewer');
  const projectPath = `/api/v1/projects/${project.id}`;
  const facadePath = `${projectPath}/facade-assessment`;
  const noMaterials = (await request('GET', facadePath, undefined, { session: engineer })).json();
  const [emptyArea] = noMaterials.contexts;
  const emptyConclusion = { assessmentContextId: emptyArea.assessmentContextId, startWork: 'can_start', reason: 'Попытка без источника' };
  assert.equal((await request('POST', `${projectPath}/conclusions`, emptyConclusion,
    { session: engineer, version: emptyArea.version, status: 422 })).json().code, 'conclusion_basis_required');
  assert.equal((await request('POST', `${projectPath}/conclusions`, { ...emptyConclusion,
    basis: { kind: 'original', versionId: randomUUID(), anchor: '1' } },
    { session: engineer, version: emptyArea.version, status: 422 })).json().code, 'conclusion_materials_required');
  async function seedOriginal(projectId, { documentId = randomUUID(), replaces = null } = {}) {
    const versionId = randomUUID();
    const raw = randomUUID();
    const sha256 = createHash('sha256').update(raw).digest('hex');
    const { rows: [receipt] } = await db.query(`INSERT INTO intake_receipts(project_id,source,created_by,sealed_at)
      VALUES($1,'upload',$2,now()) RETURNING id`, [projectId, userId]);
    await db.query('INSERT INTO intake_documents(id,project_id) VALUES($1,$2) ON CONFLICT DO NOTHING', [documentId, projectId]);
    await db.query('INSERT INTO intake_originals(id,project_id,object_key,size,sha256) VALUES($1::uuid,$2,$1::uuid::text,1,$3)', [raw, projectId, sha256]);
    await db.query(`INSERT INTO intake_document_versions(id,project_id,document_id,original_id,media_type,replaces_version_id)
      VALUES($1,$2,$3,$4,'application/pdf',$5)`, [versionId, projectId, documentId, raw, replaces]);
    await db.query(`INSERT INTO intake_occurrences(project_id,receipt_id,relative_path,declared_media_type,version_id,state)
      VALUES($1,$2,'Synthetic.pdf','application/pdf',$3,'accepted')`, [projectId, receipt.id, versionId]);
    await db.query(`INSERT INTO reader_maps(project_id,document_id,version_id,reader_version,receipt_id,original_sha256,format,units)
      VALUES($1,$2,$3,'d7-synthetic',$4,$5,'pdf',$6)`, [projectId, documentId, versionId, receipt.id, sha256,
      JSON.stringify([1, 2].map((page) => ({ id: String(page), locator: { page } })))]);
    return { documentId, versionId, sha256 };
  }
  const original = await seedOriginal(project.id);
  const unrelated = await seedOriginal(project.id);
  const foreign = await seedOriginal((await createProject('Соседний проект')).id);
  const linksPath = (versionId = original.versionId) => `${projectPath}/versions/${versionId}/facade-links`;
  const assessment = async (version) => (await request('GET', facadePath + (version ? `/${version}` : ''), undefined,
    { session: engineer })).json();
  const empty = await assessment();
  assert.equal(empty.observations.proposalCounts.facadeKind, 0);
  assert.equal(empty.contexts.filter(({ kind }) => kind === 'facade').length, 0);
  const leftInput = { target: 'place', pageOrAnchor: '1', facadeName: 'А', reason: 'На первой странице указан фасад А' };
  const putLink = async (input, version, status = 200, session = engineer, path = linksPath()) =>
    (await request('PUT', path, input, { version, status, session })).json();
  assert.equal((await putLink(leftInput, 1, 403, viewer)).code, 'forbidden');
  assert.equal((await putLink(leftInput, 1, 404, engineer, linksPath(foreign.versionId))).code, 'not_found');
  assert.equal((await putLink({ ...leftInput, pageOrAnchor: '3' }, 1, 422)).code, 'original_address_unavailable');
  const saved = await putLink(leftInput, 1);
  assert.equal(saved.links[0].basis.sha256, original.sha256);
  assert.equal(saved.links[0].basis.address.locator.page, 1);
  assert.equal(saved.links[0].authorName, 'd7-engineer');
  const rightInput = { ...leftInput, facadeName: 'Б', pageOrAnchor: '2' };
  assert.equal((await putLink(rightInput, 1, 412)).code, 'version_conflict');
  const both = await putLink(rightInput, saved.version);
  const [left, right] = both.links;
  assert.equal(left.assessmentContextId, saved.assessmentContextId);
  assert.equal(right.basis.address.locator.page, 2);
  const visibleOriginals = async (contextId) => (await request('GET', `${projectPath}/confirmation-originals?assessmentContextId=${contextId}`, undefined,
    { session: engineer })).json().originals.map(({ id }) => id);
  assert.deepEqual(await visibleOriginals(left.assessmentContextId), [original.versionId]);
  assert.ok((await visibleOriginals(emptyArea.assessmentContextId)).includes(unrelated.versionId));

  const projectState = async () => (await request('GET', `/api/projects/${project.id}`, undefined, { session: engineer })).json();
  const typePath = `${facadePath}/facades/${left.facadeId}/kind`;
  const type = { kind: 'panel', provenanceKind: 'engineer_override', documentVersionId: original.versionId,
    pageOrAnchor: '1', reason: 'Тип в штампе листа' };
  const typeVersion = (await projectState()).version;
  assert.equal((await request('PUT', typePath, { ...type, pageOrAnchor: '2' },
    { session: engineer, version: typeVersion, status: 422 })).json().code, 'facade_type_basis_invalid');
  const typed = (await request('PUT', typePath, type, { session: engineer, version: typeVersion })).json();
  assert.equal(typed.facadeType.state, 'confirmed');
  assert.equal(typed.facadeType.authorName, 'd7-engineer');
  assert.equal(typed.facadeType.version, 1);
  const state = await assessment();
  assert.equal(state.stage, 'Стадия 1');
  assert.equal(state.outcome, 'needs_review');
  assert.equal(state.observations.proposalCounts.facadeKind, 0);
  const findArea = (snapshot, link) => snapshot.contexts.find(({ assessmentContextId }) => assessmentContextId === link.assessmentContextId);
  const leftArea = findArea(state, left);
  const rightArea = findArea(state, right);
  assert.equal(leftArea.questions[0].requirement.applicability, 'applicable');
  assert.equal(rightArea.questions[0].requirement.applicability, 'unknown');
  assert.deepEqual(leftArea.questions[0].machine.citations, []);
  assert.equal(leftArea.questions[0].letterEligible, false);
  assert.deepEqual(rightArea.documentFacadeLinks, [right]);
  assert.ok(leftArea.questions.every(({ outcome }) => outcome === 'needs_review'));
  const conclusion = { assessmentContextId: leftArea.assessmentContextId, startWork: 'can_start_with_limitations',
    reason: 'Только подготовка', basis: { kind: 'original', versionId: original.versionId, anchor: '1' } };
  assert.equal((await request('POST', `${projectPath}/conclusions`, { ...conclusion, basis: { ...conclusion.basis, anchor: '2' } },
    { session: engineer, version: leftArea.version, status: 422 })).json().code, 'conclusion_basis_unavailable');
  await request('POST', `${projectPath}/conclusions`, conclusion, { session: engineer, version: leftArea.version, status: 201 });
  const savedAssessment = await assessment();
  assert.equal(findArea(savedAssessment, left).conclusion.basis.original.address.locator.page, 1);

  const readQuestion = async (link) => findArea(await assessment(), link).questions[0];
  const position = await readQuestion(left);
  const rightPosition = await readQuestion(right);
  const decide = (question, payload, status = 201) => request('POST', `/api/v1/questions/${question.id}/decisions`,
    { reason: 'Синтетическая ручная проверка', ...payload }, { session: engineer, version: question.version, status });
  await decide(position, { action: 'confirm', startWorkCritical: false });
  assert.equal(findArea(await assessment(), left).conclusion.id, findArea(savedAssessment, left).conclusion.id);
  const confirmed = await readQuestion(left);
  await decide(confirmed, { action: 'exclude', exclusion: { kind: 'not_required', until: '2000-11-25T00:00:00Z' } }, 422);
  const until = '2099-11-25T00:00:00.000Z';
  await decide(confirmed, { action: 'exclude', exclusion: { kind: 'not_required', until }, startWorkCritical: true });
  const excludedSnapshot = await assessment();
  const excluded = findArea(excludedSnapshot, left).questions[0];
  assert.equal(excluded.outcome, 'excluded');
  assert.deepEqual(excluded.decision.exclusion, { kind: 'not_required', until });
  assert.equal(excluded.decision.startWorkCritical, true);
  assert.equal(excluded.letterEligible, false);
  assert.equal(excluded.machine.outcome, 'needs_review');
  assert.deepEqual(await readQuestion(right), rightPosition);
  const previous = findArea(excludedSnapshot, left).previousConclusion;
  assert.match(previous.reason, /Инженерское решение/);
  assert.equal(findArea(await assessment(previous.assessmentVersion), left).conclusion.id, findArea(savedAssessment, left).conclusion.id);
  await decide(excluded, { action: 'revoke' });
  const revoked = await readQuestion(left);
  assert.equal(revoked.outcome, 'needs_review');
  assert.equal(revoked.decision.action, 'revoke');
  assert.equal(revoked.previousDecisionId, excluded.decision.id);
  assert.equal(findArea(await assessment(excludedSnapshot.version), left).questions[0].outcome, 'excluded');
  await decide(revoked, { action: 'exclude', exclusion: { kind: 'work_without_data' }, startWorkCritical: false });
  assert.equal((await readQuestion(left)).decision.exclusion.kind, 'work_without_data');
  assert.deepEqual(await readQuestion(right), rightPosition);

  const beforeReassignment = findArea(await assessment(), left);
  await request('POST', `${projectPath}/conclusions`, conclusion, { session: engineer, version: beforeReassignment.version, status: 201 });

  const reassigned = await putLink({ target: 'place', pageOrAnchor: '1', facadeId: right.facadeId,
    reason: 'Связь первой страницы адресно пересмотрена' }, both.version);
  const afterReassignment = await assessment();
  assert.equal(findArea(afterReassignment, left).facadeType.state, 'stale');
  assert.equal(findArea(afterReassignment, left).conclusion, null);
  assert.match(findArea(afterReassignment, left).previousConclusion.reason, /другим фасадом/);
  assert.deepEqual(findArea(afterReassignment, right).documentFacadeLinks[1], right);
  assert.ok(reassigned.links.every(({ facadeId }) => facadeId === right.facadeId));

  const whole = await putLink({ target: 'document', pageOrAnchor: '1', facadeId: left.facadeId,
    reason: 'Редакция относится к фасаду А с отдельными листами фасада Б' }, reassigned.version);
  assert.equal(whole.links.find(({ target }) => target === 'document').basis.address.locator.page, 1);
  assert.equal(findArea(await assessment(), left).facadeType.state, 'stale');

  await seedOriginal(project.id, { documentId: original.documentId, replaces: original.versionId });
  assert.equal((await putLink(leftInput, whole.version, 404)).code, 'not_found');
  const retained = (await request('GET', linksPath(), undefined, { session: viewer })).json();
  assert.equal(retained.current, false);
  assert.equal(retained.editable, false);
  assert.deepEqual(retained.links, whole.links);
  const afterReplacement = await assessment();
  assert.equal(findArea(afterReplacement, left).facadeType.state, 'stale');
  assert.equal(findArea(afterReplacement, left).conclusion, null);
  assert.equal(findArea(await assessment(savedAssessment.version), left).conclusion.basis.original.sha256, original.sha256);
  assert.ok(findArea(afterReplacement, right));
  assert.equal((await db.query('SELECT count(*)::int AS count FROM letters WHERE project_id=$1', [project.id])).rows[0].count, 0);
});
