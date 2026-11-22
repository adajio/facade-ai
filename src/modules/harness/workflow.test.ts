import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import type { ModelResult, ResearchTask } from './contracts.js';
import { commands, hashBytes, initialMessages, request } from './openrouter.js';
import type { ResearchEvent, SessionPorts } from './session.js';
import { runResearchWorkflow } from './workflow.js';

const receipt = (name: string, args: unknown, finishReason = 'tool_calls') => ({
  status: 'paid' as const,
  attemptId: randomUUID(),
  output: {
    choices: [{
      finish_reason: finishReason,
      message: {
        role: 'assistant', content: null,
        reasoning_details: [{ type: 'reasoning.encrypted', data: 'test-reasoning' }],
        tool_calls: [{ id: `call-${randomUUID()}`, type: 'function', function: { name, arguments: JSON.stringify(args) } }],
      },
    }],
  },
});

function setup() {
  const events: ResearchEvent[] = [];
  const projectId = randomUUID();
  const task: ResearchTask = {
    jobId: randomUUID(), projectId, scopeId: randomUUID(), generationId: randomUUID(),
    job: { mode: 'primary', branch: 'A',
      place: { source: { projectId, versionId: randomUUID(), documentId: randomUUID(), sha256: 'a'.repeat(64) },
        unitId: '1', page: 1 },
      settings: { routeId: 'a', model: 'managed/a', dataClass: 'synthetic', maxTokens: 1000, maxTurns: 12, maxKnownRejections: 1 } },
  };
  const place = task.job.mode === 'primary' ? task.job.place : assert.fail();
  const pixels = Buffer.from('synthetic pixel output');
  const lines = Buffer.from('Толщина 2 мм');
  const overviewId = randomUUID();
  const textId = randomUUID();
  const observationId = randomUUID();
  const reads: string[] = [];
  const recorded: string[] = [];
  const isSurvey = (kind: string) => kind === 'survey';
  const ports: SessionPorts = {
    load: async () => events,
    async append(expectedLength, create) {
      assert.equal(expectedLength, events.length);
      const event = await create({} as PoolClient);
      events.push(event);
      return event;
    },
    reader: {
      inventory: async () => [place],
      async read(context, request) {
        assert.ok(events.at(-1)?.kind === 'intent');
        if (request.support) assert.fail('Primary may only see its own branch');
        reads.push(context.effectKey);
        const image = isSurvey(request.kind);
        const bytes = image ? pixels : lines;
        return { place, readerVersion: 'test', mediaType: image ? 'image/png' : 'text/plain',
          bytes, sha256: hashBytes(bytes), evidenceId: image ? overviewId : textId };
      },
      async record(_tx, context, input) {
        assert.equal(input.evidence.evidenceId, textId);
        recorded.push(context.effectKey);
        return { observationId };
      },
    },
    call: async () => assert.fail('Set the model script'),
  };
  return { events, task, ports, pixels, overviewId, textId, observationId, reads, recorded };
}

test('Mastra sends exact tool content, holds an unsettled turn and resumes only that turn', async () => {
  const { task, ports, events, pixels, overviewId, textId, observationId, reads, recorded } = setup();
  let sendCount = 0;
  let heldRequest: unknown;
  const signal = new AbortController().signal;
  ports.call = async ({ effectKey, request, inputRefs }): Promise<ModelResult> => {
    sendCount++;
    switch (sendCount) {
      case 1: return receipt('survey', {});
      case 2:
        assert.deepEqual(inputRefs, [overviewId]);
        assert.ok(JSON.stringify(request.messages).includes(pixels.toString('base64')));
        assert.ok(JSON.stringify(request.messages).includes('test-reasoning'));
        return receipt('extract', {});
      case 3:
        assert.deepEqual(inputRefs, [overviewId, textId]);
        assert.ok(JSON.stringify(request.messages).includes('Толщина 2 мм'));
        heldRequest = { effectKey, request };
        return { status: 'held', code: 'unknown_charge', nextAction: 'reconcile' };
      case 4:
        assert.deepEqual({ effectKey, request }, heldRequest);
        return receipt('save_observation', { evidenceId: textId, quote: 'Толщина 2 мм', value: '2', unit: 'мм' });
      case 5:
        return receipt('finish_reading', { status: 'covered', explanation: 'Получена цитата.' }, 'length');
      case 6:
        assert.ok(JSON.stringify(request.messages).includes('truncated_answer'));
        return receipt('finish_reading', { status: 'covered', explanation: 'Получена цитата.' });
      default: return assert.fail('Unexpected model send');
    }
  };
  const first = await runResearchWorkflow(task, ports, signal);
  assert.equal(first.status, 'suspended');
  assert.equal(reads.length, 2);
  assert.equal(recorded.length, 0);
  let final = await runResearchWorkflow(task, ports, signal);
  if (final.status === 'continue') final = await runResearchWorkflow(task, ports, signal);
  assert.deepEqual(final, { status: 'done', outcome: { kind: 'covered', observationIds: [observationId] } });
  assert.equal(sendCount, 6);
  assert.equal(reads.length, 2);
  assert.equal(recorded.length, 1);
  assert.equal(events.filter(({ kind }) => kind === 'model').length, 5);
});

test('visual and text tools advertise only arguments accepted in their assigned role', () => {
  const { task } = setup();
  const primary = request(task.job, initialMessages(task.job));
  for (const name of ['survey', 'zoom', 'extract', 'ocr', 'search']) {
    const schema = primary.tools.find(({ function: tool }) => tool.name === name)!.function.parameters;
    assert.equal(schema.additionalProperties, false);
    assert.ok(!Object.hasOwn(schema.properties ?? {}, 'support'), name);
  }
  const place = task.job.mode === 'primary' ? task.job.place : assert.fail();
  const citation = { observationId: randomUUID(), evidenceId: randomUUID(), place, quote: '2 мм', value: '2', unit: 'мм' };
  const dispute = { id: randomUUID(), question: { id: randomUUID(), subject: 'Test', property: 'Thickness' },
    a: { ...citation, branch: 'A' as const }, b: { ...citation, observationId: randomUUID(), branch: 'B' as const } };
  for (const job of [
    { mode: 'lead' as const, dispute, settings: task.job.settings },
    { mode: 'verify' as const, branch: 'B' as const, dispute, settings: task.job.settings,
      proposal: { aObservationId: dispute.a.observationId, bObservationId: dispute.b.observationId, explanation: 'Test' } },
  ]) {
    const review = request(job, initialMessages(job));
    for (const name of ['survey', 'zoom', 'extract', 'ocr', 'search']) {
      const schema = review.tools.find(({ function: tool }) => tool.name === name)!.function.parameters;
      assert.equal(schema.additionalProperties, false);
      assert.ok(Object.hasOwn(schema.properties ?? {}, 'support'), name);
      assert.ok(Array.isArray(schema.required) && schema.required.includes('support'), name);
    }
  }
});

test('a reserved old request keeps its original shape and a bad support argument receives a safe retry', async () => {
  const { task, ports, events, reads } = setup();
  const oldReceipt = receipt('survey', { support: 'A' });
  const oldRequest = request(task.job, initialMessages(task.job), true);
  const sent: string[] = [];
  ports.call = async ({ effectKey, request: wire }) => {
    sent.push(effectKey);
    const survey = wire.tools.find(({ function: tool }) => tool.name === 'survey')!.function.parameters;
    switch (sent.length) {
      case 1:
        assert.ok(!Object.hasOwn(survey.properties ?? {}, 'support'));
        return { status: 'held', code: 'effect_conflict', attemptId: oldReceipt.attemptId, nextAction: 'inspect_original_effect' };
      case 2:
        assert.deepEqual(wire, oldRequest);
        return oldReceipt;
      case 3: {
        assert.ok(!Object.hasOwn(survey.properties ?? {}, 'support'));
        assert.deepEqual(wire.messages.at(-1), { role: 'tool', tool_call_id: oldReceipt.output.choices[0].message.tool_calls[0].id,
          content: JSON.stringify({ ok: false, code: 'foreign_branch', nextAction: 'Повторите survey с {}. Страница уже закреплена за вашим заданием.' }) });
        assert.deepEqual(reads, []);
        return receipt('survey', { support: 'B' });
      }
      case 4:
        assert.match(String(wire.messages.at(-1)?.content), /Повторите survey с \{\}/);
        assert.deepEqual(reads, []);
        return receipt('survey', { page: 7 });
      case 5:
        assert.match(String(wire.messages.at(-1)?.content), /invalid_arguments/);
        assert.deepEqual(reads, []);
        return receipt('survey', {});
      case 6:
        assert.equal(reads.length, 1);
        return receipt('finish_reading', { status: 'no_match', explanation: 'Reviewed assigned page.' });
      default: return assert.fail('Unexpected model send');
    }
  };
  const signal = new AbortController().signal;
  let result = await runResearchWorkflow(task, ports, signal);
  if (result.status === 'continue') result = await runResearchWorkflow(task, ports, signal);
  assert.equal(result.status === 'done' && result.outcome.kind, 'reviewed_no_match');
  assert.equal(sent[0], sent[1]);
  const first = events[0];
  assert.equal(first.kind === 'model' && first.requestHash, hashBytes(JSON.stringify(oldRequest)));
});

test('text-only auto replies exhaust the assigned turns without executing an alleged tool call', async () => {
  const { task, ports, events, reads, recorded } = setup();
  task.job.settings = { ...task.job.settings, toolChoice: 'auto', maxTurns: 2 };
  const plainText = JSON.stringify({ lastToolCall: 'finish_reading', claim: 'Толщина 2 мм' });
  ports.call = async ({ request, inputRefs }) => {
    assert.equal(request.tool_choice, 'auto');
    assert.deepEqual(inputRefs, []);
    if (events.length > 0) {
      assert.equal(request.messages.at(-2)?.content, plainText);
      assert.match(String(request.messages.at(-1)?.content), /Продолжите с помощью доступных инструментов/);
    }
    return { status: 'paid', attemptId: randomUUID(), output: {
      choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: plainText } }],
    } };
  };
  const final = await runResearchWorkflow(task, ports, new AbortController().signal);
  assert.equal(final.status === 'suspended' && final.hold.reason, 'turn_limit');
  assert.deepEqual(events.map(({ kind }) => kind), ['model', 'model']);
  assert.deepEqual(reads, []);
  assert.deepEqual(recorded, []);
});

test('lost tool reply is recovered by the same operation key; known 429 retries with its original attempt', async () => {
  const { task, ports, reads, events } = setup();
  const rejectedId = randomUUID();
  const send = new Map<string, number>();
  const append = ports.append;
  let drop = true;
  ports.append = async (expectedLength, create) => append(expectedLength, async (tx) => {
    const event = await create(tx);
    if (event.kind === 'tool' && drop) {
      drop = false;
      throw new Error('Lost tool result');
    }
    return event;
  });
  ports.call = async ({ effectKey, retryRejectedAttemptId }) => {
    const n = (send.get(effectKey) ?? 0) + 1;
    send.set(effectKey, n);
    if (effectKey.endsWith(':1') && n === 1) {
      return { status: 'rejected', attemptId: rejectedId, code: 'http_429', retryable: true };
    }
    if (effectKey.endsWith(':1')) {
      assert.equal(retryRejectedAttemptId, rejectedId);
      return receipt('survey', {});
    }
    assert.equal(retryRejectedAttemptId, undefined);
    return receipt('finish_reading', { status: 'no_match', explanation: 'Окно просмотрено.' });
  };
  const signal = new AbortController().signal;
  await assert.rejects(runResearchWorkflow(task, ports, signal), /Lost tool result/);
  assert.equal(events.at(-1)?.kind, 'intent');
  const final = await runResearchWorkflow(task, ports, signal);
  assert.equal(final.status, 'done');
  if (final.status === 'done') assert.equal(final.outcome.kind, 'reviewed_no_match');
  assert.equal(reads.length, 2);
  assert.equal(reads[0], reads[1]);
  assert.equal(send.size, 2);
});

test('delivery statements require a literal quote and preserve the legacy tool wire format', () => {
  const { task } = setup();
  if (task.job.mode !== 'primary') return assert.fail();
  const toolsFor = (job: typeof task.job) => request(job, initialMessages(job)).tools
    .find(({ function: tool }) => tool.name === 'save_observation')!.function;
  const old = toolsFor(task.job);
  const current = toolsFor({ ...task.job, observationProtocol: 2 });
  assert.deepEqual(Object.keys(old.parameters.properties ?? {}), [
    'evidenceId', 'quote', 'lineId', 'value', 'unit', 'normalizedValue', 'sourceRole', 'limitation', 'alternatives', 'box',
  ]);
  assert.ok(Object.hasOwn(current.parameters.properties ?? {}, 'deliveryStatement'));
  const input = {
    evidenceId: randomUUID(), sourceRole: 'inventory',
    deliveryStatement: { status: 'not_delivered', item: 'Torsion test report' },
  };
  assert.equal(commands.save_observation.safeParse(input).success, false);
  assert.equal(commands.save_observation.safeParse({ ...input, quote: 'No report included.', value: '0' }).success, false);
  assert.equal(commands.save_observation.safeParse({
    ...input, quote: 'Torsion test report is not included.',
  }).success, true);
});
