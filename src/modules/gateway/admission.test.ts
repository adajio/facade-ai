import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import type { PoolClient } from 'pg';
import { approvalIsCurrent, customerScope, validCustomerAccess, validRouteLifetime, verifyApprovedResearchInputs, type CustomerScope } from './admission.js';
import { hash, type ModelAuthorization } from './types.js';

test('only an explicit null gives a customer route an approval without expiration', () => {
  const projectId = randomUUID();
  const scope = { projectId, scopeId: null, allowImages: true, approvalRef: 'fixture', originalSha256s: ['a'.repeat(64)] };
  const access = { keyFingerprint: hash('fixture'), evidenceRef: 'fixture', validUntil: null, scopes: [scope] };
  assert.ok(validCustomerAccess(access, 'fixture'));
  assert.equal(customerScope(access, projectId, null), scope);
  assert.equal(customerScope(access, randomUUID(), null), undefined);
  assert.equal(customerScope({ ...access, validUntil: '2000-01-01' }, projectId, null), undefined);
  assert.equal(approvalIsCurrent('invalid date'), false);
  assert.equal(validRouteLifetime({ validUntil: null, customerAccess: access }), true);
  assert.equal(validRouteLifetime({ validUntil: null }), false);
  assert.equal(validRouteLifetime({ validUntil: null, customerAccess: access, syntheticScopes: [scope] }), false);
  assert.equal(validRouteLifetime({ validUntil: '2000-01-01', syntheticScopes: [scope] }), true);
});

test('customer intake access checks the current accepted version in its approved project', async () => {
  const projectId = randomUUID();
  const versionId = randomUUID();
  const documentId = randomUUID();
  const evidenceId = randomUUID();
  const sha256 = 'a'.repeat(64);
  const scope: CustomerScope = { projectId, scopeId: null, approvalRef: 'fixture', allowImages: true, acceptedProjectOriginals: true };
  const access = { keyFingerprint: hash('fixture'), evidenceRef: 'fixture', validUntil: '2099-01-01', scopes: [scope] };
  assert.ok(validCustomerAccess(access, 'fixture'));
  assert.ok(!validCustomerAccess(access, 'different-key'));
  const context: ModelAuthorization = {
    dataClass: 'customer', projectId, scopeId: null, generationId: randomUUID(), jobId: randomUUID(),
    payload: { mode: 'primary', branch: 'B', place: { source: { projectId, versionId, documentId, sha256 } } },
    inputRefs: [evidenceId],
  };
  const createTx = (options: { accepted?: boolean; mappedHash?: string; intake?: boolean } = {}) => {
    const audit: unknown[][] = [];
    const db = {
      async query(sql: string, params: unknown[]) {
        audit.push(params);
        if (sql.includes('FROM projects')) return { rowCount: options.intake === false ? 0 : 1 };
        if (sql.includes('FROM reader_evidence')) return {
          rowCount: 1, rows: [{ versionId, sha256: options.mappedHash ?? sha256 }],
        };
        assert.match(sql, /state='accepted'/);
        assert.match(sql, /replaces_version_id/);
        return { rows: options.accepted === false ? [] : [{ id: versionId, documentId, sha256 }] };
      },
    } as unknown as PoolClient;
    return { db, audit };
  };
  const positive = createTx();
  assert.equal(await verifyApprovedResearchInputs(positive.db, context, scope), true);
  assert.deepEqual(positive.audit, [[projectId], [projectId, context.jobId, [evidenceId]], [projectId, versionId, null, null]]);
  for (const options of [{ accepted: false }, { mappedHash: 'b'.repeat(64) }, { intake: false }]) {
    assert.equal(await verifyApprovedResearchInputs(createTx(options).db, context, scope), false);
  }
  assert.equal(await verifyApprovedResearchInputs(createTx().db, { ...context, dataClass: 'synthetic' }, scope), false);
  assert.equal(await verifyApprovedResearchInputs(createTx().db, { ...context, scopeId: randomUUID() }, scope), false);
});
