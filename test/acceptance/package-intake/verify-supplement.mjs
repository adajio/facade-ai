import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { intakeClient, submitOnce } from './intake-client.mjs';

const [mode, origin, engineerPath, initialPath, input, output] = process.argv.slice(2);
assert.ok(['declare', 'reassess'].includes(mode));
const read = async (file) => JSON.parse(await readFile(file, 'utf8'));
const write = (value) => writeFile(output, JSON.stringify(value, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const { login, password } = await read(engineerPath);
const { projectId, contexts, final } = await read(initialPath);
const { call, http } = await intakeClient(origin, login, password);
const base = '/api/v1/projects/' + projectId;
const [recipientCase, ...extraLetters] = contexts.filter(({ letter }) => letter?.status === 201);
assert.ok(recipientCase && extraLetters.length === 0, 'open control requires one real eligible letter');
const recipientContext = recipientCase.id;
const letter = recipientCase.letter.result;
const letterPath = '/api/v1/letters/' + letter.id;
const stage = final.stage;
const facadeContexts = final.contexts.filter(({ kind }) => kind === 'facade');
assert.equal(facadeContexts.length, 2);
const otherContext = facadeContexts.find(({ assessmentContextId: id }) => id !== recipientContext);
const previous = facadeContexts.find(({ assessmentContextId: id }) => id === recipientContext);
assert.equal(previous.questions[0].machine.outcome, 'confirmed_missing');
assert.equal(otherContext.questions[0].machine.outcome, 'covered');
const originalQuestion = previous.questions[0];
const ifMatch = (version) => ({ headers: { 'if-match': '"' + version + '"' } });
const { json: initialRevision } = await call('GET', letterPath + '/revisions/' + letter.revisionId, 200);
assert.equal(initialRevision.items.length, 1);

if (mode === 'declare') {
  const { json: sent } = await call('POST', letterPath + '/sent', 201, {
    revisionId: letter.revisionId, itemIds: initialRevision.items.map(({ id }) => id),
    recipient: letter.recipient, text: recipientCase.letter.text, sentAt: new Date().toISOString(),
  });
  const supplement = await submitOnce({ call }, projectId, input);
  const { json: link } = await call('POST', base + '/supplements/links', 201, {
    receiptId: supplement.receiptId, letterId: letter.id, sentId: sent.id, itemId: initialRevision.items[0].id,
  });
  const { json: held } = await call('GET', base + '/facade-assessment', 200);
  assert.deepEqual(held.contexts.find(({ assessmentContextId }) => assessmentContextId === recipientContext).questionHolds,
    [{ questionId: originalQuestion.id, receiptIds: [supplement.receiptId] }]);
  const { json: hold, response } = await call('GET', letterPath + '/current-text', 409, undefined, ifMatch(letter.version));
  await write({ mode, supplement, sent, link, held, oldTextStatus: response.status, oldTextCode: hold.code, http });
} else {
  const recorded = await read(input);
  assert.equal(recorded.mode, 'declare');
  const { json: held } = await call('GET', base + '/facade-assessment', 200);
  const context = held.contexts.find(({ assessmentContextId }) => assessmentContextId === recipientContext);
  const target = context.questions.find(({ id }) => id === originalQuestion.id);
  const newCitations = target.machine.citations.filter(({ receiptId }) => receiptId === recorded.supplement.receiptId);
  const references = ({ observationId, evidenceId, versionId }) => ({ observationId, evidenceId, versionId });
  assert.ok(new Set(newCitations.map(({ branch }) => branch)).size === 2, 'new version lacks independently published A/B citations');
  const selected = ['A', 'B'].map((branch) => references(newCitations.find((citation) => citation.branch === branch)));
  const old = originalQuestion.machine.citations.map(references);
  const { json: replacement, response: changed } = await call('POST', '/api/v1/questions/' + target.id + '/source-replacements',
    [201, 409, 422], { replaced: old, replacements: selected, reason: 'Адресные опоры открыты в приложении; досылка касается только этого пункта.' },
    ifMatch(target.version));
  const { json: updated } = await call('GET', base + '/facade-assessment', 200);
  const updatedContext = updated.contexts.find(({ assessmentContextId }) => assessmentContextId === recipientContext);
  const preservedContext = updated.contexts.find(({ assessmentContextId }) => assessmentContextId === otherContext.assessmentContextId);
  assert.equal(updated.stage, stage);
  assert.deepEqual(preservedContext.questions, otherContext.questions);
  const { json: saved } = await call('GET', recorded.sent.url, 200);
  assert.equal(saved.text, recipientCase.letter.text);
  for (const artifact of recipientCase.exports) {
    const { bytes } = await call('GET', artifact.historicalUrl, 200);
    assert.equal(hash(bytes), artifact.sha256);
  }
  const { json: history } = await call('GET', base + '/facade-assessment/' + final.version, 200);
  assert.equal(history.historical, true);
  assert.deepEqual(history.coverage, final.coverage);
  const { response: stale, json: response } = await call('GET', letterPath + '/current-text', [409, 412], undefined, ifMatch(letter.version));
  await write({ mode, replacement, replacementStatus: changed.status, before: target, after: updatedContext, preservedContext,
    historicalTextSha256: hash(saved.text), exportsVerified: recipientCase.exports.length,
    staleStatus: stale.status, staleCode: response.code, http });
  assert.equal(changed.status, 201);
  assert.deepEqual(updatedContext.questionHolds, []);
  assert.equal(updatedContext.questions.find(({ id }) => id === target.id).machine.outcome, 'covered');
}
