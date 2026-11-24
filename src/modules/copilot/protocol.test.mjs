import assert from 'node:assert/strict';
import { test } from 'node:test';
import { decodeTurn, recentTranscript } from '../../../dist/src/modules/copilot/protocol.js';

const call = (id, name = 'open_source', args = { sourceId: id }) => ({
  id, type: 'function', function: { name, arguments: JSON.stringify(args) },
});
const completion = (tool_calls, finish_reason = 'tool_calls') => ({
  choices: [{ finish_reason, message: { role: 'assistant', content: null, tool_calls } }],
});

test('one provider turn can open three validated sources in order', () => {
  const calls = [call('fixture-a'), call('fixture-b'), call('fixture-c')];
  const result = decodeTurn(completion(calls));
  assert.deepEqual(result?.actions.map(({ action, callId }) => [action.name, action.args.sourceId, callId]),
    calls.map(({ id }) => ['open_source', id, id]));
  assert.deepEqual(result?.message.tool_calls, calls);
});

test('read batches retain completion, size, tool ID and argument checks', () => {
  const open = call('open');
  assert.equal(decodeTurn(completion([open, call('answer', 'submit_answer', { claims: [], limitations: [] })])), null);
  assert.equal(decodeTurn(completion([open, call('ocr', 'research_source', { sourceId: 'open', reason: 'fixture' })])), null);
  assert.equal(decodeTurn(completion([open, open])), null);
  assert.equal(decodeTurn(completion([open, call('bad', 'open_source', { sourceId: 1 })])), null);
  assert.equal(decodeTurn(completion(Array.from({ length: 13 }, (_, id) => call('item-' + id)))), null);
  assert.equal(decodeTurn(completion([open], 'length')), null);
  assert.equal(decodeTurn(completion([])), null);
});

test('history truncation keeps whole tool exchanges', () => {
  const initial = [{ role: 'system', content: 'Fixture' }, { role: 'user', content: 'Fixture' }];
  const exchange = (...calls) => [
    decodeTurn(completion(calls)).message,
    ...calls.map(({ id }) => ({ role: 'tool', tool_call_id: id, content: '{}' })),
  ];
  const early = exchange(call('first'), call('second'), call('third'));
  const last = exchange(call('last'));
  const turns = [...initial, ...early, ...last];
  assert.deepEqual(recentTranscript(turns, 4), [...initial, ...last]);
  assert.deepEqual(recentTranscript(turns, 6), turns);
});
