import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';

const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');

export function acceptanceHttp(origin, intake) {
  const project = `/api/projects/${intake.projectId}`;
  const south = intake.scopeIds['Южный пирс'];
  const http = [];
  async function call(session, method, path, expected, body, version) {
    const response = await fetch(origin + path, { method, redirect: 'error', signal: AbortSignal.timeout(15_000),
      headers: { origin, 'idempotency-key': randomUUID(), ...session,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        ...(version === undefined ? {} : { 'if-match': `"${version}"` }) },
      body: body === undefined ? undefined : JSON.stringify(body) });
    const bytes = Buffer.from(await response.arrayBuffer());
    const json = response.headers.get('content-type')?.includes('application/json') ? JSON.parse(bytes) : null;
    http.push({ method, path, status: response.status, code: json?.code });
    assert.equal(response.status, expected, `${method} ${path}: ${response.status} ${json?.code ?? ''}`);
    return { json, bytes, response };
  }

  async function login(name, password) {
    const { response, json } = await call({}, 'POST', '/api/sessions', 200, { login: name, password });
    return { cookie: response.headers.get('set-cookie').split(';')[0], 'x-csrf-token': json.csrfToken };
  }

  async function currentScopes(session) {
    return Object.fromEntries(await Promise.all(Object.entries(intake.scopeIds).map(async ([name, id]) => [
      name, (await call(session, 'GET', `${project}/assessments/current?scopeId=${id}`, 200)).json,
    ])));
  }

  async function engineerPhase(owner, initial, { persistProjected }) {
    await persistProjected(await currentScopes(owner));
    const name = `early_review_${randomUUID().slice(0, 8)}`;
    const password = `${randomUUID()}-engineer`;
    const { json: invitation } = await call(owner, 'POST', '/api/users/invitations', 201, { login: name });
    await call({}, 'POST', '/api/invitations/complete', 204, { token: invitation.token, password });
    const beforeMembership = (await call(owner, 'GET', project, 200)).json;
    await call(owner, 'PUT', `${project}/members/${invitation.userId}`, 200, { role: 'engineer' }, beforeMembership.version);
    const engineer = await login(name, password);
    const projected = await currentScopes(engineer);
    const opened = [];
    const outcomes = {};
    for (const [scope, input] of Object.entries(projected)) {
      const base = `scopeId=${input.scope.id}`;
      for (const hold of input.holds) {
        await call(engineer, 'POST', `${project}/supplements/holds/${hold.id}/resolve`, 200, {
          generation: hold.generation, reason: 'В изолированной копии сверены закрытая опись и прежние решения без изменения охвата.',
          impacts: [{ scopeId: input.scope.id, assessmentVersion: input.version, questionIds: [] }],
        }, hold.version);
      }
      const { json: assessment } = await call(engineer, 'GET', `${project}/assessments/current?${base}`, 200);
      const gap = assessment.questions.find(({ requirement }) => requirement.positionId === 'gap');
      const limits = assessment.scope.id === south ? ['applicability_unknown'] :
        ['primary_coverage_pending', 'dispute_unresolved', 'pair_variant_unclear',
          'pair_applicability_unclear', 'pair_comparability_unclear'];
      for (const code of limits) assert.ok(gap.machine.limitations.includes(code), `${scope}: ${code}`);
      if (assessment.scope.id !== south) assert.ok(!gap.machine.limitations.includes('pair_revision_unclear'));
      for (const cite of gap.machine.citations.filter(({ components }) => components?.length)) {
        for (const part of cite.components) {
          const { json: evidence } = await call(engineer, 'GET', part.evidenceHref, 200);
          const { bytes } = await call(engineer, 'GET', evidence.contentUrl, 200);
          assert.equal(sha(bytes), evidence.sha256);
          assert.equal(evidence.source.versionId, part.source.versionId);
          assert.equal(evidence.source.sha256, part.source.sha256);
          opened.push({ scope, observationId: cite.observationId, role: part.role, evidenceId: evidence.id,
            source: evidence.source, address: part.address });
        }
      }
      assert.equal(gap.outcome, 'needs_review');
      const { json: decision } = await call(engineer, 'POST', `/api/questions/${gap.id}/decisions`, 201, {
        action: 'correct', outcome: 'needs_review', requestExternal: false,
        reason: 'Испытательная роль открыла адресные опоры. Применимость пары и завершение первичного покрытия остаются открыты.',
      }, gap.version);
      const { json: eligible } = await call(engineer, 'GET', `${project}/letters/eligible?${base}`, 200);
      assert.deepEqual(eligible.items, []);
      const { json: refused } = await call(engineer, 'POST', `${project}/letters`, 422, {
        scopeId: input.scope.id, recipient: gap.requirement.recipient,
        items: [{ questionId: gap.id, questionVersion: decision.version, decisionId: decision.id }],
      });
      assert.equal(refused.code, 'no_eligible_items');
      const after = (await call(engineer, 'GET', `${project}/assessments/current?${base}`, 200)).json;
      const { json: conclusion } = await call(engineer, 'POST', `${project}/conclusions`, 201, {
        scopeId: input.scope.id, startWork: 'cannot_start',
        reason: assessment.scope.id === south ? 'Применимость опор к исполнению в южной области требует уточнения.'
          : 'Полнота первичной проверки и применимость северной пары остаются открыты.',
      }, after.version);
      const { json: concluded } = await call(engineer, 'GET', `${project}/assessments/current?${base}`, 200);
      assert.equal(concluded.conclusion.id, conclusion.id);
      assert.equal(concluded.conclusion.startWork, 'cannot_start');
      outcomes[scope] = { stage: assessment.scope.stage, reasons: gap.machine.limitations, decision, eligible, refused,
        conclusion: concluded.conclusion,
        originalHistory: (await call(engineer, 'GET', `${project}/assessments/${initial[scope].version}?${base}`, 200)).json.version };
    }
    assert.deepEqual((await call(engineer, 'GET', `${project}/letters`, 200)).json.items, []);
    return { outcomes, opened, http };
  }
  return { call, login, currentScopes, engineerPhase };
}
