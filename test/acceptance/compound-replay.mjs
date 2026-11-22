import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { createFormatAdapters } from '../../dist/src/modules/formats/index.js';
import { groundComponents } from '../../dist/src/modules/pdf/components.js';
import { hasAddressedSubject } from '../../dist/src/modules/questions/subject-evidence.js';
import { evaluate } from '../../dist/src/modules/assessment/domain.js';
import { renderGround } from '../../dist/src/modules/letters/grounds.js';
import { advance } from '../../dist/src/modules/harness/session.js';

const [, , machineFile, intakeFile, originalsDirectory] = process.argv;
assert.ok(machineFile && intakeFile && originalsDirectory, 'Use a frozen machine snapshot, its intake manifest and original directory.');
const { main } = JSON.parse(readFileSync(machineFile, 'utf8'));
const intake = JSON.parse(readFileSync(intakeFile, 'utf8'));
assert.equal(main.projectId, intake.projectId);

function recordedJob(file, subject, branch, unitId) {
  const source = intake.originals[`Комплект/Монтаж/${file}`];
  assert.ok(source, file);
  const job = main.jobs.find((item) => item.place.source.versionId === source.versionId &&
    item.place.unitId === unitId && item.purpose === `primary_${branch.toLowerCase()}` &&
    item.question.subject.startsWith(subject));
  assert.ok(job, `${file} ${subject} ${branch}`);
  const trace = main.trace.filter(({ job_id }) => job_id === job.id).map(({ event }) => event);
  const delivered = new Set(trace.filter(({ kind }) => kind === 'model').flatMap(({ inputRefs }) => inputRefs));
  const reads = [];
  for (const event of trace) {
    if (event.kind !== 'tool' || !delivered.has(event.reply.evidence?.evidenceId) ||
        typeof event.reply.body.content !== 'string') continue;
    const ref = event.reply.evidence;
    const representation = main.representation.find(({ id }) => id === ref.evidenceId);
    assert.equal(representation.job_id, job.id);
    assert.equal(representation.branch, branch);
    assert.equal(representation.source.sha256, source.sha256);
    const body = JSON.parse(event.reply.body.content);
    if (!Array.isArray(body.lines)) continue;
    reads.push({ lines: body.lines, ref, event, evidence: {
      id: ref.evidenceId, source: representation.source, receiptId: source.receiptId ?? intake.receiptId,
      readerVersion: ref.readerVersion, address: representation.address, branch, runId: job.id,
      format: representation.format, representation: representation.representation,
    } });
  }
  return { file, job, trace, reads, branch };
}

const pdf = recordedJob('Выпуск 134.pdf', 'Зазор', 'B', '1');
const doc = recordedJob('Протокол монтажа.doc', 'Зазор', 'A', 'table:1:1');
const docx = recordedJob('Протокол монтажа.docx', 'Зазор', 'B', 'table:1:1');
const xls = recordedJob('Подбор.xls', 'Габаритная', 'B', 'sheet:1:1');
const xlsx = recordedJob('Подбор.xlsx', 'Габаритная', 'B', 'sheet:1:1');
const dwg = recordedJob('Конструкции.dwg', 'Толщина', 'A', 'space:5e2c614c23f02239bc03c6c0');
const dxf = recordedJob('Узлы.dxf', 'Толщина', 'A', 'space:5e2c614c23f02239bc03c6c0');
const ifc = recordedJob('Сборка.ifc', 'Шаг', 'B', 'entities:1');

const literal = (value) => ({ text }) => text.trim() === value;
const byCell = (cell, text) => (line) => line.locator?.cell === cell && literal(text)(line);
const part = (role, search, text, kind, to) => ({ role, search, text, link: kind === 'anchor' ? { kind } : { kind, to } });
const value = (text, search = literal(text)) => part('value', search, text, 'anchor');
function bind(job, definitions, format, sourceRole, supported = true, newRepresentation) {
  const read = job.reads.find(({ lines }) => definitions.every(({ search }) => lines.filter(search).length === 1));
  assert.ok(read, `No delivered common representation for ${job.file}`);
  const inputs = definitions.map(({ role, search, text, link }) => {
    const line = read.lines.find(search);
    return { role, literal: text, quote: line.text, lineId: line.id, evidenceId: read.evidence.id, link };
  });
  const issued = newRepresentation ? { ...read, evidence: { ...read.evidence, address: newRepresentation.address },
    lines: newRepresentation.lines } : read;
  const { components, ifcUnit } = groundComponents(inputs, new Map([[read.evidence.id, issued]]));
  const [anchor] = components;
  const unit = ifcUnit ?? components.find(({ role }) => role === 'unit')?.literal;
  const quote = { quote: anchor.quote, lineId: anchor.lineId, value: anchor.literal, unit, grounding: 'text', components };
  const established = hasAddressedSubject(job.job.question, quote, read.lines);
  assert.equal(established, supported, job.file);
  const finding = { kind: 'value', applicability: established ? 'active' : 'unknown', sourceRole, format,
    comparisonKey: 'same-assigned-attribute', citation: {
      observationId: job.job.id, evidenceId: anchor.evidenceId, receiptId: anchor.receiptId,
      ...anchor.source, address: anchor.address, label: job.file, quote: anchor.quote, value: anchor.literal, unit,
      branch: job.branch, href: anchor.evidenceHref, components,
    } };
  return { finding, established };
}

const known = [];
known.push(bind(pdf, [value('37'), part('unit', literal('мм'), 'мм', 'same_row', 0),
  part('identifier', literal('QF-91 · зазор'), 'QF-91', 'same_row', 0)], 'pdf', 'drawing'));
for (const [job, format] of [[doc, 'doc'], [docx, 'docx']]) {
  known.push(bind(job, [value('44'), part('unit', literal('мм'), 'мм', 'same_row', 0),
    part('identifier', literal('QF-91'), 'QF-91', 'same_row', 0),
    part('identifier', literal('Зазор'), 'Зазор', 'column_header', 0)], format, 'protocol'));
}
for (const [job, format] of [[xls, 'xls'], [xlsx, 'xlsx']]) {
  known.push(bind(job, [value('1860', byCell('B3', '1860')), part('unit', byCell('B2', 'Длина, мм'), 'мм', 'column_header', 0),
    part('identifier', byCell('A3', 'QF-91'), 'QF-91', 'same_row', 0)], format, 'schedule'));
}
for (const [job, format] of [[dwg, 'dwg'], [dxf, 'dxf']]) {
  const line = literal('QF-91 | hinge bracket | A | 18.7 mm');
  known.push(bind(job, [value('18.7', line), part('unit', line, 'mm', 'source_context', 0),
    part('variant', line, 'A', 'source_context', 0)], format, 'drawing', false));
}

const recordedIfc = ifc.reads.find(({ lines }) => lines.some(({ text }) => text.includes("'AnchorSpacing'") && text.includes('172.')) &&
  lines.some(({ text }) => text.includes('.LENGTHUNIT.,.MILLI.,.METRE.')));
assert.ok(recordedIfc);
const boundIfc = ['#1', '#10', '#15', '#16', '#17', '#18', '#19'];
const byStep = (step) => ({ locator }) => locator?.step === step;
const stepText = (step) => recordedIfc.lines.find(byStep(step)).text;
const steps = [value('172', byStep('#19')),
  part('relationship', byStep('#17'), 'Pset_FacadeGeometry', 'ifc_reference', 0),
  part('relationship', byStep('#18'), '#17', 'ifc_reference', 1),
  part('identifier', byStep('#10'), 'QF-91', 'ifc_reference', 2),
  part('relationship', byStep('#1'), '#16', 'ifc_reference', 0),
  part('relationship', byStep('#16'), '#15', 'ifc_reference', 4),
  part('unit', byStep('#15'), stepText('#15'), 'ifc_reference', 5)];
const ifcOriginal = join(originalsDirectory, 'Комплект', 'Монтаж', ifc.file);
assert.equal(createHash('sha256').update(readFileSync(ifcOriginal)).digest('hex'), recordedIfc.evidence.source.sha256);
const ifcAdapter = createFormatAdapters().find(({ format }) => format === 'ifc');
const ifcUnit = (await ifcAdapter.inspect(ifcOriginal)).find(({ id }) => id === ifc.job.place.unitId);
const freshIfc = await ifcAdapter.read(ifcOriginal, { address: { unitId: ifcUnit.id }, representation: 'native' }, ifcUnit);
for (const step of boundIfc) {
  const old = recordedIfc.lines.find(byStep(step));
  const now = freshIfc.lines.find(byStep(step));
  assert.deepEqual([old.id, old.text], [now.id, now.text], step);
}
known.push(bind(ifc, steps, 'ifc', 'model', true, freshIfc));
assert.equal(known.at(-1).finding.citation.unit, 'mm');
const replayedIfc = { opening: recordedIfc.evidence.id, proof: 'prior_returned_lines_plus_current_original_map',
  records: recordedIfc.lines.filter(({ locator }) => boundIfc.includes(locator?.step)) };

const gapFindings = known.slice(0, 3).map(({ finding }) => finding);
const requirement = {
  positionId: 'gap', partId: 'gap', subject: pdf.job.question.subject, part: pdf.job.question.subject,
  formats: ['pdf', 'docx', 'doc'], requiredFormats: ['pdf', 'docx', 'doc'], equivalentFormats: [],
  sourceRoles: ['drawing', 'protocol'], completeness: '', recipient: 'ООО «Испытательная сторона»',
  requestedAction: 'Подтвердить зазор QF-91', applicability: 'applicable',
};
const conflict = evaluate(requirement, { findings: gapFindings, remaining: [], completenessChecked: true });
assert.equal(conflict.outcome, 'confirmed_conflict');
assert.equal(conflict.citations.length, 3);
const ground = renderGround({ questionId: pdf.job.question.id, questionVersion: 1, decisionId: dwg.job.id,
  scope: { id: pdf.job.scope_id, name: 'Северный берег', stage: 'РД' }, scopeId: pdf.job.scope_id,
  subject: requirement.subject, part: requirement.part, recipient: requirement.recipient,
  requestedAction: requirement.requestedAction, kind: conflict.outcome, citations: conflict.citations,
  requiredFormats: requirement.formats, catalogVersionId: intake.projectId });
assert.equal(ground.sources.length, 3);
assert.ok(ground.sources.every(({ address }) => address.components?.length));

const stopStart = dwg.trace.findIndex((event) => event.kind === 'model' &&
  event.message.tool_calls?.[0]?.function.name === 'save_observation');
const start = dwg.trace.slice(0, stopStart);
const historicalRejects = dwg.trace.slice(stopStart).filter(({ kind }) => kind === 'model').slice(0, 2);
assert.equal(historicalRejects.length, 2);
assert.equal(historicalRejects[0].message.tool_calls[0].function.arguments, historicalRejects[1].message.tool_calls[0].function.arguments);
const task = { jobId: dwg.job.id, projectId: main.projectId, scopeId: dwg.job.scope_id, generationId: dwg.job.generation_id,
  job: { mode: 'primary', branch: 'A', place: dwg.job.place, settings: dwg.job.settings, question: dwg.job.question,
    observationProtocol: 2 } };
let continued = false;
let sends = 0;
const copied = [...start];
const ports = {
  load: async () => copied, continued: async () => continued,
  async append(n, make) { assert.equal(n, copied.length); const item = await make({}); copied.push(item); return item; },
  async call() {
    const old = historicalRejects[sends++];
    assert.ok(old, 'No new model send while hold is active');
    return { status: 'paid', attemptId: old.attemptId, output: { choices: [{ message: old.message, finish_reason: old.finishReason }] } };
  },
  reader: { async record() { assert.fail('Rejected arguments must not persist a finding'); } },
};
let pending;
for (let i = 0; i < 8; i++) {
  pending = await advance(task, ports);
  if (pending.status !== 'continue') break;
}
assert.equal(pending.hold?.reason, 'repeated_rejected_action');
assert.equal(sends, 2);
const stop = copied.at(-1).stop;
assert.ok(stop.evidence.length && stop.lastRequest.tool === 'save_observation');
assert.deepEqual(await advance(task, ports), pending);
continued = true;
let resumed;
ports.call = async (call) => {
  resumed = { effectKey: call.effectKey, inputRefs: call.inputRefs };
  return { status: 'held', code: 'offline_replay_checkpoint', nextAction: 'Offline guard' };
};
assert.equal((await advance(task, ports)).hold?.reason, 'offline_replay_checkpoint');
assert.ok(resumed.effectKey.endsWith(`:model:${stop.lastRequest.turn + 1}`));
assert.ok(stop.evidence.every(({ evidenceId }) => resumed.inputRefs.includes(evidenceId)));

const foreignRead = pdf.reads[0];
const ownRead = dwg.reads.find(({ lines }) => lines.some(({ text }) => text.includes('hinge bracket | A | 18.7 mm')));
const ownLine = ownRead.lines.find(({ text }) => text.includes('hinge bracket | A | 18.7 mm'));
const foreign = [...start];
const foreignAssistant = { role: 'assistant', content: null, tool_calls: [{ id: 'offline-foreign-support', type: 'function', function: {
  name: 'save_compound_observation', arguments: JSON.stringify({ components: [
    { role: 'value', literal: '18.7', quote: ownLine.text, lineId: ownLine.id, evidenceId: ownRead.evidence.id, link: { kind: 'anchor' } },
    { role: 'identifier', literal: foreignRead.lines[0].text, quote: foreignRead.lines[0].text,
      lineId: foreignRead.lines[0].id, evidenceId: foreignRead.evidence.id, link: { kind: 'same_row', to: 0 } },
  ] }),
} }] };
const foreignPorts = { ...ports, load: async () => foreign,
  async append(length, create) { assert.equal(length, foreign.length); const event = await create({}); foreign.push(event); return event; },
  async call() { return { status: 'paid', attemptId: historicalRejects[0].attemptId,
    output: { choices: [{ message: foreignAssistant, finish_reason: 'tool_calls' }] } }; },
};
await advance(task, foreignPorts);
await advance(task, foreignPorts);
assert.equal(foreign.at(-1).reply.body.code, 'evidence_not_delivered');

console.log(JSON.stringify({ sourceProject: main.projectId, networkRequests: 0,
  compound: known.map(({ finding: { citation }, established }) => ({ label: citation.label, branch: citation.branch,
    sourceHash: citation.sha256, value: citation.value, unit: citation.unit, address: citation.address,
    questionEstablished: established, components: citation.components })),
  ifc: replayedIfc, syntheticConflictReplay: ground, repeatedRejectedAction: { stopped: stop, resumed },
  foreignEvidence: { issuedTo: pdf.branch, assignedTo: dwg.branch, code: foreign.at(-1).reply.body.code },
}, null, 2));
