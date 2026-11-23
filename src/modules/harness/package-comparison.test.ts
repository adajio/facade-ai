import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import type { CatalogRequirement } from '../access/input.js';
import { comparePackageFacts, packageCatalogAliases, type PackageFact } from './package-analysis.js';
import { locatePairQuote } from './pair-evidence.js';

const facade = { id: randomUUID(), label: 'Facade K' };
const projectId = randomUUID();
function measurement(branch: 'A' | 'B', attribute: string, value: string, unit: string): PackageFact {
  const id = randomUUID();
  const evidenceId = randomUUID();
  const quote = `Drawing | Facade K | ${attribute} ${value} ${unit}`;
  return {
    id, branch, attribute, windowId: randomUUID(), evidenceHref: '/api/v1/evidence/' + evidenceId,
    sourceRole: 'drawing', designStage: null, revision: 'R7', variant: 'v2', revisionStatus: 'current',
    basis: { role: 'Drawing', revision: 'R7 current' }, materials: [],
    binding: { state: 'identified', candidates: [facade], quote, reason: 'Printed designation', version: 1, actorId: null },
    observation: {
      id, branch, quote, evidenceId, value, unit, source: { projectId,
        documentId: randomUUID(), versionId: randomUUID(), sha256: branch.repeat(64).toLowerCase() },
      runId: randomUUID(), receiptId: randomUUID(), scope: null, address: { unitId: '1' },
      grounding: 'text', readerVersion: 'fixture',
    },
  };
}

test('approved equivalent names join only comparable facts and equivalent values do not schedule review', () => {
  const approved = packageCatalogAliases([{ key: 'gap', part: 'Gap', aliases: ['Clearance'] }]);
  const a = measurement('A', 'Gap', '30', 'mm');
  const equivalent = measurement('B', 'Clearance', '3,00', 'cm');
  const conflict = measurement('B', 'Clearance', '4.1', 'cm');
  assert.deepEqual(comparePackageFacts([a, conflict]).reviewCandidates, []);
  assert.deepEqual(comparePackageFacts([a, equivalent], approved).reviewCandidates, []);
  assert.deepEqual(comparePackageFacts([a, conflict], approved).reviewCandidates, [
    { a: a.id, b: conflict.id, property: 'Gap', scope: facade },
  ]);
  const unrelated = { ...conflict, binding: { ...conflict.binding, candidates: [{ id: randomUUID(), label: facade.label }] } };
  assert.deepEqual(comparePackageFacts([a, unrelated], approved).reviewCandidates, []);
  const ambiguous = packageCatalogAliases([{ key: 'gap', part: 'Gap', aliases: ['Clearance'] },
    { key: 'opening', part: 'Opening', aliases: ['Clearance'] }]);
  assert.deepEqual(comparePackageFacts([a, conflict], ambiguous).reviewCandidates, []);
});

test('verbatim duplicate title text requires the evidence lineId to identify one physical place', () => {
  const text = 'Drawing | Revision R7 current';
  const first = { id: 'header', text, box: { x: 0, y: 1, width: 30, height: 10 } };
  const second = { id: 'footer', text, box: { x: 0, y: 50, width: 30, height: 10 } };
  assert.equal(locatePairQuote([first, second], text).length, 2);
  assert.deepEqual(locatePairQuote([first, second], text, 'footer'), [second]);
  assert.deepEqual(locatePairQuote([first, second], text, 'unseen'), []);
});

test('typed catalogue comparisons require the confirmed type of the addressed facade', () => {
  const a = measurement('A', 'Gap', '30', 'mm');
  const b = measurement('B', 'Gap', '40', 'mm');
  a.designStage = b.designStage = 'RD';
  a.basis.valueRole = b.basis.valueRole = { kind: 'design', quote: 'Design gap' };
  b.sourceRole = 'specification';
  const requirement: CatalogRequirement = {
    key: 'gap', part: 'Gap', level: 'facade', applicability: 'all', facadeKinds: ['ventilated'],
    formats: ['pdf'], equivalents: [], aliases: [], sourceRoles: ['drawing', 'specification'],
    completenessCriterion: 'Addressed design gap', addressee: 'engineer',
    comparison: { sources: [
      { sourceRole: 'drawing', valueRole: 'design', priority: 1 },
      { sourceRole: 'specification', valueRole: 'design', priority: 1 },
    ] },
  };
  const catalog = { versionId: randomUUID(), stage: 'RD', requirements: [requirement] };
  assert.equal(comparePackageFacts([a, b], undefined, catalog).reviewCandidates.length, 0);
  const facadeKinds = new Map([[randomUUID(), 'ventilated'], [facade.id, 'curtain wall']]);
  assert.equal(comparePackageFacts([a, b], undefined, { ...catalog, facadeKinds }).reviewCandidates.length, 0);
  facadeKinds.set(facade.id, 'ventilated');
  assert.deepEqual(comparePackageFacts([a, b], undefined, { ...catalog, facadeKinds }).reviewCandidates, [
    { a: a.id, b: b.id, property: 'Gap', scope: facade, stage: 'RD', catalogVersionId: catalog.versionId },
  ]);
  const other: CatalogRequirement = { ...requirement, key: 'other-gap', facadeKinds: ['curtain wall'], comparison: undefined };
  const twoKinds = { ...catalog, facadeKinds, requirements: [requirement, other] };
  assert.equal(comparePackageFacts([a, b], undefined, twoKinds).reviewCandidates.length, 1);
  other.facadeKinds = ['ventilated'];
  assert.equal(comparePackageFacts([a, b], undefined, twoKinds).reviewCandidates.length, 0);
  requirement.comparison!.sources[1].priority = 2;
  assert.equal(comparePackageFacts([a, b], undefined, { ...catalog, facadeKinds }).reviewCandidates.length, 0);
});
