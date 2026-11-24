import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { intakeClient } from './intake-client.mjs';

const [origin, login, passwordPath, machinePath, outputPath] = process.argv.slice(2);
const rawMachine = await readFile(machinePath);
const frozen = JSON.parse(rawMachine);
const hash = (value) => createHash('sha256').update(value).digest('hex');
assert.equal(frozen.mode ?? 'managed-test', 'managed-test');
assert.equal(frozen.qualifiesProduction ?? false, false);
assert.equal(frozen.balance.spentUsdNanos, 0);
assert.equal(frozen.balance.reserveUsdNanos, 0);
assert.ok(frozen.readings.length);
const { call, http } = await intakeClient(origin, login, (await readFile(passwordPath, 'utf8')).trim());
const projects = [];
try {
  for (const reading of frozen.readings) {
    const { projectId } = reading;
    const path = '/api/v1/projects/' + projectId;
    const { json: assessment } = await call('GET', path + '/facade-assessment', 200);
    const { json: project } = await call('GET', '/api/projects/' + projectId, 200);
    assert.equal(project.catalogVersionId, null);
    assert.equal(project.stage, null);
    assert.deepEqual(project.scopes, []);
    assert.equal(assessment.projectId, projectId);
    const { json: historical } = await call('GET', path + '/facade-assessment/' + assessment.version, 200);
    assert.equal(historical.historical, true);
    assert.deepEqual(historical.coverage, assessment.coverage);
    assert.deepEqual(historical.observations, assessment.observations);
    const { json: summary } = await call('GET', '/api/projects/' + projectId + '/snapshot', 200);
    assert.equal(summary.facadeAssessmentVersion, assessment.version);
    const observations = [];
    const seen = new Set();
    let after = null;
    do {
      const { json: page } = await call('GET', assessment.observations.href + (after ? '?after=' + after : ''), 200);
      assert.equal(page.version, assessment.version);
      assert.ok(!page.nextCursor || page.nextCursor !== after);
      const known = new Map(reading.facts.map((fact) => [fact.id, fact.observation]));
      for (const item of page.items) {
        assert.ok(!seen.has(item.id));
        seen.add(item.id);
        const saved = known.get(item.id);
        assert.ok(saved && saved.source.versionId === item.versionId && saved.source.sha256 === item.sha256);
        const { json: evidence } = await call('GET', item.evidenceHref, 200);
        assert.equal(evidence.source.projectId, projectId);
        assert.equal(evidence.source.versionId, item.versionId);
        assert.equal(evidence.source.sha256, item.sha256);
        const { bytes } = await call('GET', evidence.contentUrl, 200);
        assert.equal(hash(bytes), evidence.sha256);
        observations.push({ ...item, opened: { representation: evidence.representation, address: evidence.address, sha256: evidence.sha256 } });
      }
      after = page.nextCursor;
    } while (after);
    assert.equal(observations.length, Object.values(assessment.observations.counts).reduce((total, count) => total + count, 0));
    const eligibility = [];
    for (const { assessmentContextId } of assessment.contexts) {
      const { json } = await call('GET', path + '/letters/eligible?assessmentContextId=' + assessmentContextId, 200);
      eligibility.push({ assessmentContextId, ...json });
    }
    projects.push({ project, assessment, summary, observations, eligibility });
  }
} finally {
  await writeFile(outputPath, JSON.stringify({ mode: 'managed-test', qualifiesProduction: false,
    toolSha256: hash(await readFile(new URL(import.meta.url))), machineSha256: hash(rawMachine), projects, http }, null, 2) + '\n',
    { flag: 'wx', mode: 0o600 });
}
