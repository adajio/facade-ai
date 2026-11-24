import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, stat, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { intakeClient } from '../package-intake/intake-client.mjs';

const [origin, login, passwordFile, frozenPath, catalogPath, output, cut = 'primary'] = process.argv.slice(2);
assert.notEqual(origin, 'http://127.0.0.1:18443');
assert.equal((await stat(dirname(output))).mode & 0o077, 0);
const frozen = await readFile(frozenPath);
const machine = JSON.parse(frozen);
assert.ok(['primary', 'continuation'].includes(cut));
assert.equal(machine.phase, cut);
assert.equal(machine.helper.length > 0, cut === 'continuation');
const projectId = machine.project.id;
assert.match(projectId, /^[0-9a-f-]{36}$/u);
const catalog = JSON.parse(await readFile(catalogPath, 'utf8'));
assert.match(catalog.key, /^project-memory-synthetic-[a-z0-9-]+$/u);
assert.equal(catalog.requirements.length, 3);
const { call } = await intakeClient(origin, login, (await readFile(passwordFile, 'utf8')).trim());
const base = '/api/v1/projects/' + projectId;
const projectPath = '/api/projects/' + projectId;
const assessmentPath = base + '/facade-assessment';
const version = (number) => ({ headers: { 'if-match': '"' + number + '"' } });
const assessment = async () => (await call('GET', assessmentPath, 200)).json;
const project = async () => (await call('GET', projectPath, 200)).json;
const report = { machineSha256: createHash('sha256').update(frozen).digest('hex'), opened: [], types: [], contexts: [] };

async function openBasis(item) {
  const { json: basis } = await call('GET', item.evidenceHref ?? item.href, 200);
  const { bytes } = await call('GET', basis.contentUrl, 200);
  assert.equal(createHash('sha256').update(bytes).digest('hex'), basis.sha256);
  assert.equal(basis.source.versionId, item.versionId);
  report.opened.push(basis.source.versionId);
}

try {
  const before = await assessment();
  report.before = before;
  const byProposal = async (name, facadeId) => {
    const view = await assessment();
    const query = new URLSearchParams({ proposal: name, limit: '100' });
    if (facadeId) query.set('facadeId', facadeId);
    return (await call('GET', view.observations.href + '?' + query, 200)).json.items;
  };
  let current = await project();
  const stages = (await byProposal('stage')).filter((item) => item.designStage && item.basis?.stage && item.revisionStatus === 'current');
  if (!current.stage && new Set(stages.map(({ designStage }) => designStage)).size === 1) {
    const [stage] = stages;
    await openBasis(stage);
    const staged = await call('PUT', projectPath + '/stage', [200, 409, 422], {
      stage: stage.designStage, evidenceIds: [stage.evidenceId], reason: 'Стадия сверена в оригинале по основанию приложения.',
    }, version(current.version));
    report.stage = { status: staged.response.status, result: staged.json };
  }
  for (const { facadeId } of before.contexts) {
    if (!facadeId) continue;
    const found = (await byProposal('facadeKind', facadeId)).filter((item) =>
      item.proposedFacadeKind && item.facadeKindSourceVerified && item.revisionStatus === 'current');
    const types = new Set(found.map(({ proposedFacadeKind }) => proposedFacadeKind));
    if (types.size !== 1) {
      report.types.push({ facadeId, proposals: found.length, distinct: types.size });
      continue;
    }
    const [source] = found;
    await openBasis(source);
    const result = await call('PUT', assessmentPath + '/facades/' + facadeId + '/kind', [200, 404, 409, 422], {
      kind: source.proposedFacadeKind, observationId: source.id,
      reason: 'Адресное основание типа открыто и сверено в оригинале.',
    }, version((await project()).version));
    report.types.push({ facadeId, status: result.response.status, result: result.json });
  }
  const retained = (await call('GET', '/api/catalogs', 200)).json.catalogs.filter(({ key }) => key === catalog.key);
  assert.ok(retained.length <= 1);
  const registered = retained[0] ?? (await call('POST', '/api/catalogs', 201, catalog)).json;
  current = await project();
  if (current.catalogVersionId !== registered.id) {
    const result = await call('PUT', projectPath + '/catalog', [200, 409, 422], { catalogVersionId: registered.id }, version(current.version));
    report.catalog = { status: result.response.status, result: result.json };
  } else report.catalog = { autoAssigned: true };
  report.after = await assessment();
  for (const context of report.after.contexts) {
    const { assessmentContextId, kind } = context;
    const appeal = await call('GET', base + '/letters/eligible?assessmentContextId=' + assessmentContextId, 200);
    const item = { assessmentContextId, kind, eligibility: appeal.json };
    if (!appeal.json.items.length) {
      const draft = await call('POST', base + '/letters', [409, 422], {
        assessmentContextId, recipient: 'Проектировщик · синтетическая проверка', items: [],
      });
      item.draft = { status: draft.response.status, code: draft.json.code };
    }
    report.contexts.push(item);
  }
} catch (error) {
  report.error = error.name;
  process.exitCode = 1;
} finally {
  await writeFile(output, JSON.stringify(report, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
  console.log(JSON.stringify({ opened: report.opened.length, types: report.types.length,
    stage: report.stage?.status ?? null, catalog: report.catalog?.status ?? report.catalog?.autoAssigned ?? null,
    contexts: report.contexts.map(({ kind, eligibility, draft }) => ({ kind, eligible: eligibility.items.length, draft })),
    error: report.error ?? null }));
}
