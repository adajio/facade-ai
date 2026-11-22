import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { groundComponents } from './components.js';
import type { Evidence, ReaderComponentInput, ReaderLine } from './types.js';
import { projectLengthAssignment } from '../formats/ifc-units.js';

const projectId = randomUUID();
function view(lines: ReaderLine[], format = 'xlsx', original?: Evidence) {
  const evidence: Evidence = {
    id: randomUUID(), source: original?.source ?? { projectId, documentId: randomUUID(), versionId: randomUUID(), sha256: 'd'.repeat(64) },
    receiptId: original?.receiptId ?? randomUUID(), runId: original?.runId ?? randomUUID(), branch: 'A', readerVersion: 'fixture',
    format, address: { unitId: randomUUID() }, representation: 'native', mediaType: 'application/json',
    sha256: 'a'.repeat(64), size: 1, limitations: [],
  };
  return { evidence, lines };
}
type View = ReturnType<typeof view>;
const lookup = (...views: View[]) => new Map(views.map((item) => [item.evidence.id, item]));
const part = (issuer: View, line: ReaderLine, role: ReaderComponentInput['role'], literal: string, link: ReaderComponentInput['link']): ReaderComponentInput =>
  ({ evidenceId: issuer.evidence.id, role, literal, quote: line.text, lineId: line.id, link });
const cell = (table: string, row: number, column: number, text: string): ReaderLine =>
  ({ id: `${table}:${row}:${column}`, text, locator: { sheet: 'Schedule', table, row, column } });

test('split unit, variant and linked revision keep independent opening addresses', () => {
  const value = cell('sizes', 2, 3, '18');
  const unit = cell('sizes', 1, 3, 'Clearance (mm)');
  const variant = cell('sizes', 2, 2, 'variant D');
  const key = cell('sizes', 2, 1, 'Valve GA-762');
  const otherUnit = cell('shipping', 1, 3, 'cm');
  const anotherMeasureUnit = cell('sizes', 2, 6, 'cm');
  const issue = { id: 'issuer-line', text: 'Valve GA-762 revision R2' };
  const proof = view([value, unit, variant, key, otherUnit, anotherMeasureUnit]);
  const revision = view([issue], 'txt');
  const inputs = [part(proof, value, 'value', '18', { kind: 'anchor' }),
    part(proof, unit, 'unit', 'mm', { kind: 'column_header', to: 0 }),
    part(proof, variant, 'variant', 'D', { kind: 'same_row', to: 0 }),
    part(proof, key, 'identifier', 'GA-762', { kind: 'same_row', to: 0 }),
    part(revision, issue, 'identifier', 'GA-762', { kind: 'shared_identifier', to: 3 }),
    part(revision, issue, 'revision', 'R2', { kind: 'source_context', to: 4 })];
  const { components: saved } = groundComponents(inputs, lookup(proof, revision));
  assert.equal(saved[0].quote, '18');
  assert.equal(saved[1].address.locator?.row, 1);
  assert.equal(saved[5].source.versionId, revision.evidence.source.versionId);
  assert.equal(saved[5].evidenceHref, `/api/v1/evidence/${revision.evidence.id}`);
  assert.throws(() => groundComponents([inputs[0], part(proof, otherUnit, 'unit', 'cm', { kind: 'column_header', to: 0 })], lookup(proof)));
  assert.throws(() => groundComponents([inputs[0], part(proof, anotherMeasureUnit, 'unit', 'cm', { kind: 'same_row', to: 0 })], lookup(proof)));
  const anotherVersion = view([unit]);
  assert.throws(() => groundComponents([inputs[0], part(anotherVersion, unit, 'unit', 'mm', { kind: 'column_header', to: 0 })], lookup(proof, anotherVersion)));
  assert.throws(() => groundComponents([inputs[0], { ...inputs[1], quote: '18 mm' }], lookup(proof)));
  assert.throws(() => groundComponents([...inputs.slice(0, 4), { ...inputs[5], link: { kind: 'source_context', to: 0 } }], lookup(proof, revision)));
  const replaced = { ...revision, evidence: { ...revision.evidence, source: { ...revision.evidence.source, documentId: proof.evidence.source.documentId } } };
  assert.throws(() => groundComponents(inputs, lookup(proof, replaced)));
});

test('IFC joins actual STEP references within one version, excluding quoted lookalikes', () => {
  const value = { id: '1', text: "#100=IFCPROPERTYSINGLEVALUE('Clearance',$,IFCLENGTHMEASURE(18.),#105);", locator: { step: '#100' } };
  const relation = { id: '2', text: "#101=IFCPROPERTYSET('Q',$,'Dimensions',$,(#100));", locator: { step: '#101' } };
  const length = { id: '3', text: '#105=IFCSIUNIT(*,.LENGTHUNIT.,.MILLI.,.METRE.);', locator: { step: '#105' } };
  const deceptive = { ...relation, text: "#101=IFCPROPERTYSET('Q',$,'#100',$,(#109));" };
  const first = view([value, length], 'ifc');
  const related = view([relation], 'ifc', first.evidence);
  const a = part(first, value, 'value', '18', { kind: 'anchor' });
  const b = part(related, relation, 'relationship', 'IFCPROPERTYSET', { kind: 'ifc_reference', to: 0 });
  const u = part(first, length, 'unit', 'METRE', { kind: 'ifc_reference', to: 0 });
  const result = groundComponents([a, b, u], lookup(first, related));
  assert.equal(result.components[1].address.locator?.step, '#101');
  assert.equal(result.ifcUnit, 'mm');
  assert.throws(() => groundComponents([a, b], lookup(first, related)), /Составная опора/);
  assert.throws(() => groundComponents([a, { ...b, quote: deceptive.text }], lookup(first, { ...related, lines: [deceptive] })));
  const stranger = view([relation], 'ifc');
  assert.throws(() => groundComponents([a, { ...b, evidenceId: stranger.evidence.id }], lookup(first, stranger)));
});

test('IFC default uses the project length assignment, with an explicit property override taking precedence', () => {
  const line = (step: string, body: string) => ({ id: step, text: `${step}=${body};`, locator: { step } });
  const value = line('#20', "IFCPROPERTYSINGLEVALUE('Clearance',$,IFCLENGTHMEASURE(25.0),$)");
  const project = line('#1', "IFCPROJECT('id',$,'Project',$,$,$,$,$,#2)");
  const assigned = line('#2', 'IFCUNITASSIGNMENT((#3,#4))');
  const metric = line('#3', 'IFCSIUNIT(*,.LENGTHUNIT.,.MILLI.,.METRE.)');
  const area = line('#4', 'IFCSIUNIT(*,.AREAUNIT.,$,.SQUARE_METRE.)');
  const metre = line('#5', 'IFCSIUNIT(*,.LENGTHUNIT.,$,.METRE.)');
  const lines = [value, project, assigned, metric, area, metre];
  const raw = view(lines, 'ifc');
  const locator = projectLengthAssignment(lines.map(({ text }) => text));
  assert.equal(locator?.ifcProjectLengthUnitStep, '#3');
  const issuer = { ...raw, evidence: { ...raw.evidence, address: { ...raw.evidence.address, locator } } };
  const a = part(issuer, value, 'value', '25.0', { kind: 'anchor' });
  const p = part(issuer, project, 'relationship', 'IFCPROJECT', { kind: 'ifc_reference', to: 0 });
  const s = part(issuer, assigned, 'relationship', 'IFCUNITASSIGNMENT', { kind: 'ifc_reference', to: 1 });
  const length = part(issuer, metric, 'unit', 'METRE', { kind: 'ifc_reference', to: 2 });
  assert.equal(groundComponents([a, p, s, length], lookup(issuer)).ifcUnit, 'mm');
  assert.throws(() => groundComponents([a, p, s, part(issuer, area, 'unit', 'SQUARE_METRE', { kind: 'ifc_reference', to: 2 })], lookup(issuer)));
  assert.throws(() => groundComponents([a, p, s, part(issuer, metre, 'unit', 'METRE', { kind: 'ifc_reference', to: 2 })], lookup(issuer)));
  const override = line('#20', "IFCPROPERTYSINGLEVALUE('Clearance',$,IFCLENGTHMEASURE(25.0),#5)");
  const overridden = { ...issuer, lines: [override, ...lines.slice(1)] };
  const ov = part(issuer, override, 'value', '25.0', { kind: 'anchor' });
  assert.throws(() => groundComponents([ov, p, s, length], lookup(overridden)));
  assert.equal(groundComponents([ov, part(issuer, metre, 'unit', 'METRE', { kind: 'ifc_reference', to: 0 })], lookup(overridden)).ifcUnit, 'm');
  assert.equal(projectLengthAssignment([project, line('#2', 'IFCUNITASSIGNMENT((#3,#5))'), metric, metre]
    .map(({ text }) => text)), undefined);
});
