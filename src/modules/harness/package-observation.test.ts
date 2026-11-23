import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import type { Pool, PoolClient } from 'pg';
import { groundComponents } from '../pdf/components.js';
import { createReaderService, sha256 } from '../pdf/service.js';
import type { Evidence, Observation, ReaderComponentInput, ReaderLine } from '../pdf/types.js';
import { verifiedNativeLineCrops, type NativeLineCrop } from '../pdf/native-line.js';
import { packageCommonGrounded, packageNonDeliveryGrounded, publishPackageObservation, verifiedNativeInventoryRole } from './package-observation.js';
import type { ObservationInput, ReaderContext } from './contracts.js';
import type { PackageFact } from './package-analysis.js';

const item = 'Теплотехнический расчёт';
const input = (quote: string): Omit<ObservationInput, 'evidence'> => ({
  quote, deliveryStatement: { status: 'not_delivered', item },
  package: { role: { value: 'inventory', quote: 'Опись' } },
});

test('package non-delivery requires the referenced item to govern the negative predicate', () => {
  assert.equal(packageNonDeliveryGrounded(input('Опись | Теплотехнический расчёт передан | Паспорт не передан'), false), false);
  assert.equal(packageNonDeliveryGrounded(input('Опись | Теплотехнический расчёт передан, а Паспорт не передан'), false), false);
  assert.equal(packageNonDeliveryGrounded(input('Опись | Теплотехнический расчёт — не передан'), false), true);
  assert.equal(packageNonDeliveryGrounded(input('Опись | не передан Теплотехнический расчёт'), false), true);
  assert.equal(packageNonDeliveryGrounded(input('Опись | не передан Теплотехнический расчёт'), true), false);
  assert.equal(packageNonDeliveryGrounded(input('Опись | не передан Теплотехнический расчёт'), false,
    'Опись | не передан Теплотехнический расчёт | Теплотехнический расчёт передан'), false);
  assert.equal(packageNonDeliveryGrounded(input('Опись | Теплотехнический расчёт не передан'), false,
    'Опись | Теплотехнический расчёт не передан, но теплотехнический расчёт передан'), false);
  assert.equal(packageNonDeliveryGrounded(input('Опись | Теплотехнический расчёт не передан'), false,
    'Опись | Теплотехнический расчёт не передан и передан'), false);
  assert.equal(packageNonDeliveryGrounded(input('Опись | Теплотехнический расчёт не передан'), false,
    'Опись | Теплотехнический расчёт не передан, но Паспорт передан'), true);
});

test('package non-delivery keeps a compound printed item intact beside a separate status', () => {
  const quote = 'Опись | Схема и паспорт не переданы. Расчёт передан.';
  const claim = (item: string) => ({ ...input(quote), deliveryStatement: { status: 'not_delivered' as const, item } });
  assert.equal(packageNonDeliveryGrounded(claim('Схема и паспорт'), false, quote), true);
  assert.equal(packageNonDeliveryGrounded(claim('Паспорт'), false, quote), false);
  assert.equal(packageNonDeliveryGrounded(claim('Расчёт'), false, quote), false);
  assert.equal(packageNonDeliveryGrounded(claim('Схема и паспорт'), false, `${quote} Схема и паспорт переданы.`), false);
});

test('common materials require a positive statement that covers the entire building', () => {
  assert.equal(packageCommonGrounded('Specification | applies to all facades'), true);
  assert.equal(packageCommonGrounded('Does not apply to all facades'), false);
  assert.equal(packageCommonGrounded('For all facades except the curved bay'), false);
  assert.equal(packageCommonGrounded('List of all facades'), false);
});

function addressedFixture(quote: string) {
  const source = { projectId: randomUUID(), documentId: randomUUID(), versionId: randomUUID(), sha256: 'c'.repeat(64) };
  const place = { source, unitId: 'sheet-22' };
  const observation: Observation = { id: randomUUID(), source, scope: null, receiptId: randomUUID(), runId: randomUUID(),
    branch: 'B', address: { unitId: place.unitId }, evidenceId: randomUUID(), readerVersion: 'fixture', grounding: 'text',
    lineId: 'row-7', quote };
  const evidence = { evidenceId: observation.evidenceId, readerVersion: observation.readerVersion, place, sha256: source.sha256 };
  const context: ReaderContext = { branch: 'B', effectKey: 'fixture-save', task: { projectId: source.projectId, scopeId: null,
    generationId: randomUUID(), jobId: observation.runId, job: { mode: 'primary', branch: 'B', place,
      settings: { routeId: 'fixture', model: 'fixture', dataClass: 'synthetic', maxTurns: 8, maxTokens: 128, maxKnownRejections: 1 },
      packageWindow: { id: randomUUID(), readerVersion: 'fixture', routeRevision: 'r1', walkProtocol: 1 } } } };
  const issued = [{ id: evidence.evidenceId, content: JSON.stringify({ lines: [{ id: observation.lineId, text: quote }] }) }];
  const facts: unknown[][] = [];
  const tx = { query: async (sql: string, values: unknown[]) => {
    if (sql.includes('FROM harness_research_events')) return { rows: issued };
    if (sql.includes('INSERT INTO harness_package_facts')) facts.push(values);
    return { rows: [{ id: observation.id }], rowCount: 1 };
  } } as unknown as PoolClient;
  return { observation, evidence, context, issued, facts, tx };
}

test('a split native line verifies only the submitted non-delivery and inventory role', async () => {
  const quote = 'Torsion test report not supplied';
  const f = addressedFixture(quote);
  const left = randomUUID();
  const { lineId, evidenceId } = f.observation;
  const box = (x: number, width: number) => ({ x, y: 20, width, height: 10 });
  const full = { id: lineId!, text: 'Inventory | Item: Torsion test report | ' + quote, box: box(10, 400) };
  const crops: NativeLineCrop[] = [
    { evidenceId: left, frame: box(0, 230), line: { ...full, text: 'Inventory | Item: Torsion test', box: box(10, 210) } },
    { evidenceId, frame: box(198, 245), line: { ...full, text: 'Item: Torsion test report | ' + quote, box: box(200, 210) } },
  ];
  const pair = verifiedNativeLineCrops(full, crops, left, quote);
  assert.equal(pair?.anchorEvidenceId, evidenceId);
  assert.equal(verifiedNativeLineCrops(full, crops.slice(0, 1), left, quote), undefined);
  for (const line of [
    { ...crops[1].line, id: 'adjacent' },
    { ...crops[1].line, box: box(225, 185) },
    { ...crops[1].line, text: 'Item: Altered test report | ' + quote },
  ]) assert.equal(verifiedNativeLineCrops(full, [crops[0], { ...crops[1], line }], left, quote), undefined);
  const proof = { ...pair!, line: full, canonicalSha256: 'd'.repeat(64), submittedEvidenceId: left };
  const claim = { evidence: f.evidence, sourceRole: 'inventory', quote, lineId,
    deliveryStatement: { status: 'not_delivered' as const, item: 'Torsion test report',
      context: { lineId: lineId!, quote: 'Inventory' } } };
  assert.equal(packageNonDeliveryGrounded(claim, false, crops[1].line.text), false);
  const role = verifiedNativeInventoryRole(claim, proof);
  assert.deepEqual(role, { evidenceId: left, quote: 'Inventory' });
  assert.deepEqual(verifiedNativeInventoryRole({ ...claim, quote: crops[0].line.text,
    deliveryStatement: { ...claim.deliveryStatement, context: { lineId: lineId!, quote } } }, proof), role);
  assert.equal(verifiedNativeInventoryRole({ ...claim, package: { role: { value: 'inventory', quote: 'Other inventory' } } }, proof), undefined);
  assert.equal(verifiedNativeInventoryRole({ ...claim, deliveryStatement: { ...claim.deliveryStatement,
    context: { lineId: 'different', quote: 'Inventory' } } }, proof), undefined);
  assert.equal(verifiedNativeInventoryRole({ ...claim, deliveryStatement: { ...claim.deliveryStatement, item: 'Another report' } }, proof), undefined);
  assert.equal(verifiedNativeInventoryRole(claim, { ...proof, line: { ...full, text: full.text + ' | it was supplied' } }), undefined);
  const result = await publishPackageObservation(f.tx, f.context, { ...claim, verifiedDelivery: { ...proof, role: role! } },
    { ...f.observation, deliveryStatement: claim.deliveryStatement });
  assert.deepEqual(f.facts[0].slice(4, 9), ['Torsion test report', 'inventory', null, null, 'unknown']);
  assert.deepEqual(result?.confirmed.map(({ field, evidenceId }) => [field, evidenceId]), [['sourceRole', left]]);
  const basis = f.facts[0][9] as PackageFact['basis'];
  assert.deepEqual(basis.deliveryLine, {
    text: full.text, canonicalSha256: proof.canonicalSha256, source: f.observation.source,
    runId: f.observation.runId, branch: f.observation.branch, readerVersion: f.observation.readerVersion,
    unitId: f.observation.address.unitId, lineId, box: full.box,
    anchorEvidenceId: evidenceId, submittedEvidenceId: left,
    crops: crops.map((entry) => ({ evidenceId: entry.evidenceId, text: entry.line.text, frame: entry.frame, box: entry.line.box })),
  });
});

test('reader checks stored PDF bytes and excludes a crop from another run or branch', async () => {
  const f = addressedFixture('Panel report not supplied');
  const source = f.observation.source;
  const readerVersion = 'fixture';
  const scope = { runId: f.observation.runId, branch: f.observation.branch, operationKey: 'save' };
  const locator = { page: 1, rotation: 0 };
  const address = { unitId: '1', locator };
  const lineId = '1.0.2.0';
  const box = (x: number, width: number) => ({ x, y: 20, width, height: 10 });
  const line = { id: lineId, text: 'Inventory | Item: Panel report | Panel report not supplied', box: box(10, 400) };
  const canonical = Buffer.from(JSON.stringify({ address, lines: [line], limitations: [] }));
  const identity = { sha256: sha256(canonical), size: canonical.length, address };
  const files = new Map([[identity.sha256, canonical]]);
  const evidence = new Map<string, Evidence>();
  for (const [text, x, width] of [['Inventory | Item: Panel', 10, 210], ['Item: Panel report | Panel report not supplied', 200, 210]] as const) {
    const id = randomUUID();
    const clipped = { ...address, box: box(x, width) };
    const bytes = Buffer.from(JSON.stringify({ address: clipped, lines: [{ ...line, text, box: clipped.box }], limitations: [] }));
    const receipted: Evidence = { id, source, receiptId: f.observation.receiptId, runId: scope.runId, branch: scope.branch,
      readerVersion, format: 'pdf', address: clipped, representation: 'native', mediaType: 'application/json',
      sha256: sha256(bytes), size: bytes.length, limitations: [] };
    evidence.set(id, receipted);
    files.set(receipted.sha256, bytes);
  }
  const db = { query: async (sql: string, params: string[]) => {
    if (sql.includes('FROM reader_observations')) return { rows: [] };
    if (sql.includes('project_memory_blocks')) {
      assert.equal(params[1], source.projectId);
      assert.equal(params[2], source.versionId);
      assert.equal(params[6], source.documentId);
      assert.equal(params[7], source.sha256);
      return { rows: params[5] === readerVersion ? [identity] : [] };
    }
    assert.match(sql, /reader_evidence/);
    assert.equal(params[0], source.projectId);
    const payload = evidence.get(params[1]);
    return { rows: payload ? [{ payload }] : [] };
  } };
  const reader = createReaderService(db as unknown as Pool, {
    async resolveOriginal() { assert.fail('Canonical verification must not reopen an original or use a model'); },
    artifacts: {
      async put() { assert.fail('Verification must not modify the artifact store'); },
      async get(projectId, hash) { assert.equal(projectId, source.projectId); return files.get(hash)!; },
    },
  }, []);
  const ids = [...evidence.values()].map(({ id: evidenceId, sha256 }) => ({ evidenceId, sha256 }));
  const verify = () => reader.verifyNativeDeliveryLine(source, scope, {
    readerVersion, unitId: '1', lineId, submittedEvidenceId: ids[1].evidenceId,
    quote: 'Panel report not supplied', issued: ids,
  }, db as unknown as PoolClient);
  await assert.rejects(reader.pin(source, scope, {
    evidenceId: ids[1].evidenceId, scope: null, lineId, quote: 'Panel report not supplied',
    deliveryStatement: { status: 'not_delivered', item: 'Panel report' },
  }), { code: 'package_non_delivery_unproven' });
  assert.equal((await verify())?.canonicalSha256, identity.sha256);
  const left = evidence.get(ids[0].evidenceId)!;
  for (const changed of [{ runId: randomUUID() }, { branch: 'A' as const }, { readerVersion: 'different' },
    { source: { ...source, versionId: randomUUID() } }, { source: { ...source, projectId: randomUUID() } }]) {
    evidence.set(left.id, { ...left, ...changed });
    const verified = await verify();
    assert.deepEqual(verified?.crops.map(({ evidenceId }) => evidenceId), [ids[1].evidenceId]);
    assert.equal(verifiedNativeInventoryRole({ sourceRole: 'inventory', quote: 'Panel report not supplied',
      deliveryStatement: { status: 'not_delivered', item: 'Panel report' } }, verified!), undefined);
  }
  evidence.set(left.id, left);
  files.set(identity.sha256, Buffer.from('damaged'));
  await assert.rejects(verify(), { code: 'reader_artifact_mismatch' });
});

test('printed revision with a colon is published from the addressed source', async () => {
  for (const [mark, value] of [['Revision: C-62K current', 'C-62K'], ['Ред.: Д-27 действующая', 'Д-27']]) {
    const f = addressedFixture(`Stage: TP | ${mark}`);
    await publishPackageObservation(f.tx, f.context, { evidence: f.evidence,
      package: { stage: { value: 'TP', quote: 'Stage: TP' }, revision: { value, quote: mark, status: 'current' } },
    }, f.observation);
    assert.deepEqual(f.facts[0].slice(6, 9), ['TP', value, 'current']);
  }
});

test('an unrelated code cannot become the revision and a printed identifier does not prove current status', async () => {
  const unrelated = addressedFixture('Revision: F-18 | Ticket Q-92 current');
  const wrong = await publishPackageObservation(unrelated.tx, unrelated.context, { evidence: unrelated.evidence,
    package: { revision: { value: 'Q-92', quote: unrelated.observation.quote!, status: 'current' } },
  }, unrelated.observation);
  assert.deepEqual(unrelated.facts[0].slice(7, 9), [null, 'unknown']);
  assert.deepEqual(wrong?.rejected.map(({ field, code }) => [field, code]), [['revision', 'field_not_grounded']]);

  const undated = addressedFixture('Rev. № M-43');
  const saved = await publishPackageObservation(undated.tx, undated.context, { evidence: undated.evidence,
    package: { revision: { value: 'M-43', quote: 'Rev. № M-43', status: 'current' } },
  }, undated.observation);
  assert.deepEqual(undated.facts[0].slice(7, 9), ['M-43', 'unknown']);
  assert.deepEqual(saved?.confirmed.map(({ field }) => field), ['revision']);
  assert.deepEqual(saved?.rejected.map(({ field }) => field), ['revisionStatus']);
});

test('compound save reports missing and invalid references without losing the raw anchor', async () => {
  const f = addressedFixture('Basalt');
  const heading = 'Stage: TP', revision = 'Rev: D-33';
  const sheet = f.observation.address.unitId;
  const lines: ReaderLine[] = [
    { id: 'stage-cell', text: heading, locator: { sheet, row: 7, column: 1 } },
    { id: f.observation.lineId!, text: 'Basalt', locator: { sheet, row: 7, column: 2 } },
    { id: 'revision-cell', text: revision, locator: { sheet, row: 7, column: 3 } },
    { id: 'header-cell', text: 'Material', locator: { sheet, row: 6, column: 2 } },
  ];
  const evidenceId = f.observation.evidenceId;
  const read: Evidence = { ...f.observation, id: evidenceId, format: 'xlsx', representation: 'native', mediaType: 'application/json',
    sha256: 'd'.repeat(64), size: 1, limitations: [] };
  const parts: ReaderComponentInput[] = [
    { role: 'value', literal: 'Basalt', lineId: f.observation.lineId!, quote: 'Basalt', evidenceId, link: { kind: 'anchor' } },
    { role: 'identifier', literal: 'TP', lineId: 'stage-cell', quote: heading, evidenceId, link: { kind: 'same_row', to: 0 } },
  ];
  const delivered = new Map([[evidenceId, { evidence: read, lines }]]);
  f.issued[0].content = JSON.stringify({ lines });
  f.observation.value = 'Basalt';
  f.observation.components = groundComponents(parts, delivered).components;
  const reply: unknown = await publishPackageObservation(f.tx, f.context, { evidence: f.evidence, sourceRole: 'schedule',
    package: { attribute: 'Material', stage: { value: 'TP', quote: heading }, revision: { value: 'D-33', quote: revision, status: 'unknown' },
      references: { stage: 1, revision: 8 } },
  }, f.observation);
  assert.deepEqual(f.facts[0].slice(4, 9), [null, 'unknown', 'TP', null, 'unknown']);
  assert.equal(f.observation.value, 'Basalt');
  assert.ok(reply && typeof reply === 'object' && 'confirmed' in reply && 'rejected' in reply);
  assert.deepEqual(reply.confirmed, [{ field: 'stage', evidenceId, lineId: 'stage-cell', componentIndex: 1 }]);
  assert.ok(Array.isArray(reply.rejected));
  assert.deepEqual(reply.rejected.map(({ field, code }) => [field, code]).sort(), [
    ['attribute', 'reference_required'], ['revision', 'reference_invalid'], ['role', 'reference_required'],
  ]);
  assert.ok(reply.rejected.every(({ nextAction }) => nextAction.length > 0));

  const corrected = { ...f.observation, id: randomUUID(), components: groundComponents([...parts,
    { role: 'identifier', literal: 'Material', lineId: 'header-cell', quote: 'Material', evidenceId, link: { kind: 'column_header', to: 0 } },
    { role: 'revision', literal: 'D-33', lineId: 'revision-cell', quote: revision, evidenceId, link: { kind: 'same_row', to: 0 } },
  ], delivered).components };
  const accepted = await publishPackageObservation(f.tx, f.context, { evidence: f.evidence,
    package: { attribute: 'Material', stage: { value: 'TP', quote: heading }, revision: { value: 'D-33', quote: revision, status: 'unknown' },
      references: { attribute: 2, stage: 1, revision: 3 } },
  }, corrected);
  assert.deepEqual(accepted?.confirmed.map(({ field, componentIndex }) => [field, componentIndex]), [
    ['attribute', 2], ['stage', 1], ['revision', 3],
  ]);
  assert.deepEqual(accepted?.rejected, []);
  assert.deepEqual(f.facts.map((fact) => fact.slice(4, 9)), [[null, 'unknown', 'TP', null, 'unknown'],
    ['Material', 'unknown', 'TP', 'D-33', 'unknown']]);
});
