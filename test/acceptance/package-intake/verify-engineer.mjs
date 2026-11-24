import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { intakeClient } from './intake-client.mjs';

const [origin, login, passwordPath, frozenPath, policyPath, projectId, output] = process.argv.slice(2);
assert.match(projectId, /^[a-f0-9-]{36}$/u);
const frozen = JSON.parse(await readFile(frozenPath, 'utf8'));
assert.match(frozen.machineSha256, /^[a-f0-9]{64}$/u);
const source = frozen.projects.find(({ project }) => project.id === projectId);
assert.ok(source && source.project.catalogVersionId === null && source.project.stage === null);
const directory = '/api/projects/' + projectId;
const path = '/api/v1/projects/' + projectId;
const catalogInput = JSON.parse(await readFile(policyPath, 'utf8'));
assert.match(catalogInput.key, /^pkgintake-qa-/u);
assert.ok(catalogInput.requirements.every(({ level, evidenceRule }) => ['common', 'facade'].includes(level) && evidenceRule.allOf.length));
const owner = await intakeClient(origin, login, (await readFile(passwordPath, 'utf8')).trim());
const ownerCall = owner.call;
const version = (value) => ({ headers: { 'if-match': '"' + value + '"' } });
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const report = { projectId, machineSha256: frozen.machineSha256, initialVersion: source.assessment.version,
  stage: null, contexts: [], checkpoints: [] };
let engineer;

try {
  const { json: registry } = await ownerCall('GET', '/api/catalogs', 200);
  const existing = registry.catalogs.filter(({ key }) => key === catalogInput.key);
  assert.ok(existing.length <= 1);
  const catalog = existing[0] ?? (await ownerCall('POST', '/api/catalogs', 201, catalogInput)).json;
  assert.equal(catalog.name, catalogInput.name);
  let current = (await ownerCall('GET', directory, 200)).json;
  assert.equal(current.catalogVersionId, null);
  const printed = source.observations.filter(({ basis, designStage, revisionStatus }) =>
    designStage && basis.stage && revisionStatus !== 'superseded');
  const stages = [...new Set(printed.map(({ designStage }) => designStage))];
  if (stages.length === 1) {
    const { evidenceId, designStage } = printed[0];
    const { json: staged } = await ownerCall('PUT', directory + '/stage', 200,
      { stage: designStage, evidenceIds: [evidenceId], reason: 'Стадия указана в адресном первичном наблюдении.' }, version(current.version));
    report.stage = { value: staged.stage, evidenceId, projectVersion: staged.version };
    current = (await ownerCall('GET', directory, 200)).json;
  }
  const types = source.observations.filter(({ proposedFacadeKind }) => proposedFacadeKind);
  if (types.length) {
    const facadeKinds = [...new Set(types.map(({ proposedFacadeKind }) => proposedFacadeKind))].sort();
    const evidenceIds = [...new Set(types.map(({ evidenceId }) => evidenceId))].sort();
    await ownerCall('PUT', path + '/facade-assessment/facade-kinds', 200,
      { facadeKinds, evidenceIds, reason: 'В исходной адресной опоре напечатан тип фасада.' }, version(current.version));
    current = (await ownerCall('GET', directory, 200)).json;
    report.facadeKinds = { values: facadeKinds, evidenceIds };
  }
  if (current.catalogVersionId === catalog.id) {
    report.catalog = { id: catalog.id, autoAssigned: true, projectVersion: current.version };
  } else {
    const { json: assigned, response } = await ownerCall('PUT', directory + '/catalog', [200, 422],
      { catalogVersionId: catalog.id }, version(current.version));
    report.catalog = { id: catalog.id, status: response.status, code: assigned.code, projectVersion: assigned.version };
  }
  const engineerLogin = 'pkgintake_engineer_' + randomUUID().slice(0, 8);
  const password = randomUUID() + '-local';
  const { json: invitation } = await ownerCall('POST', '/api/users/invitations', 201, { login: engineerLogin });
  await ownerCall('POST', '/api/invitations/complete', 204, { token: invitation.token, password });
  const { json: project } = await ownerCall('GET', directory, 200);
  await ownerCall('PUT', directory + '/members/' + invitation.userId, 200, { role: 'engineer' }, version(project.version));
  engineer = await intakeClient(origin, engineerLogin, password);
  await writeFile(resolve(output, 'engineer-auth.json'), JSON.stringify({ login: engineerLogin, password }) + '\n',
    { mode: 0o600, flag: 'wx' });
  const { call } = engineer;
  const assessment = async () => (await call('GET', path + '/facade-assessment', 200)).json;
  const arranged = await assessment();
  report.catalogProjection = arranged;
  for (const context of arranged.contexts) {
    const id = context.assessmentContextId;
    const record = { id, kind: context.kind, before: context, decisions: [], exports: [] };
    report.contexts.push(record);
    for (const question of context.questions) {
      for (const cite of question.machine.citations ?? []) {
        if (!cite.href) continue;
        const { json: evidence } = await call('GET', cite.href, 200);
        assert.equal(evidence.source.versionId, cite.versionId);
        assert.equal(evidence.source.sha256, cite.sha256);
        const { bytes } = await call('GET', evidence.contentUrl, 200);
        assert.equal(hash(bytes), evidence.sha256);
      }
      if (!['confirmed_missing', 'confirmed_conflict'].includes(question.machine.outcome)) continue;
      const { json, response } = await call('POST', '/api/v1/questions/' + question.id + '/decisions', [201, 409, 422], {
        action: 'confirm', requestExternal: true, reason: 'Штатная проверка синтетических оснований по карточке.',
      }, version(question.version));
      record.decisions.push({ questionId: question.id, status: response.status, result: json });
    }
    const latest = (await assessment()).contexts.find(({ assessmentContextId }) => assessmentContextId === id);
    const allCovered = latest.questions.length && latest.questions.every(({ outcome }) => outcome === 'covered') &&
      Object.values(arranged.coverage).every(({ complete }) => complete);
    const { json: conclusion, response: conclude } = await call('POST', path + '/conclusions', [201, 409, 422], {
      assessmentContextId: id, startWork: allCovered ? 'can_start' : 'cannot_start',
      reason: allCovered ? 'Все правила и границы подтверждены системой.' : 'В карточке остаются подтверждённые проблемы или непроверенная граница.',
    }, version(latest.version));
    record.conclusion = { status: conclude.status, result: conclusion };
    const base = path + '/letters';
    const { json: eligible } = await call('GET', base + '/eligible?assessmentContextId=' + id, 200);
    record.eligible = eligible;
    const recipient = eligible.items[0]?.recipient ?? 'Проектировщик (синтетический)';
    const items = eligible.items.filter((item) => item.recipient === recipient)
      .map(({ questionId, questionVersion, decisionId }) => ({ questionId, questionVersion, decisionId }));
    const { json: letter, response: created } = await call('POST', base, items.length ? 201 : [409, 422], {
      assessmentContextId: id, recipient, items,
    });
    record.letter = { status: created.status, result: letter };
    if (!items.length) continue;
    const letterPath = '/api/v1/letters/' + letter.id;
    const { json: currentLetter } = await call('GET', letterPath + '/current-text', 200, undefined, version(letter.version));
    assert.equal(hash(currentLetter.text), currentLetter.textSha256);
    record.letter.text = currentLetter.text;
    record.letter.sha256 = currentLetter.textSha256;
    for (const format of ['txt', 'docx']) {
      const { json: artifact } = await call('POST', letterPath + '/exports', [200, 201], { format }, version(letter.version));
      const { bytes } = await call('GET', artifact.url, 200);
      const { bytes: historical } = await call('GET', artifact.historicalUrl, 200);
      assert.deepEqual(bytes, historical);
      if (format === 'txt') assert.equal(bytes.toString('utf8').replace(/^\uFEFF/u, '').replace(/\r\n/gu, '\n'), currentLetter.text);
      const file = resolve(output, 'context-' + id + '.' + format);
      await writeFile(file, bytes, { mode: 0o600, flag: 'wx' });
      record.exports.push({ format, file, sha256: hash(bytes), revisionId: artifact.revisionId, historicalUrl: artifact.historicalUrl });
    }
  }
  report.final = await assessment();
} finally {
  report.ownerHttp = owner.http;
  report.engineerHttp = engineer?.http;
  await writeFile(resolve(output, 'engineer.json'), JSON.stringify(report, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
}
