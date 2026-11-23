import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import type { PoolClient } from 'pg';
import { groundComponents } from '../pdf/components.js';
import type { Evidence, Observation, ReaderComponentInput, ReaderLine } from '../pdf/types.js';
import { packageCommonGrounded, packageNonDeliveryGrounded, publishPackageObservation } from './package-observation.js';
import type { ObservationInput, ReaderContext } from './contracts.js';

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
