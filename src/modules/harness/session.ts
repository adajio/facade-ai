import type { PoolClient } from 'pg';
import type {
  Branch, EvidenceRef, ModelResult, ReaderPort, ResearchOutcome, ResearchSuspension, ResearchTask,
} from './contracts.js';
import { ReaderRefusal } from './contracts.js';
import { contains } from '../pdf/types.js';
import { isInventoryRole } from '../assessment/domain.js';
import {
  commands, decodeCompletion, hashBytes, imageMessage, initialMessages, permittedTool, request,
  toolMessage, type AssistantMessage, type FunctionCall, type ToolReply,
} from './openrouter.js';

type AssistantEvent = {
  kind: 'model'; turn: number; attemptId: string; finishReason: string;
  message: AssistantMessage | null; inputRefs: string[]; requestHash: string;
};
type RejectionEvent = {
  kind: 'rejected'; turn: number; attemptId: string; code: string; retryable: boolean; retryAt?: string;
};
type ToolIntent = { kind: 'intent'; turn: number; index: number; callId: string; effectKey: string };
type ToolResult = {
  kind: 'tool'; turn: number; index: number; reply: ToolReply; outcome?: ResearchOutcome;
};

export type ResearchEvent = AssistantEvent | RejectionEvent | ToolIntent | ToolResult;
export type FlowState =
  | { status: 'continue' }
  | { status: 'suspended'; hold: ResearchSuspension }
  | { status: 'done'; outcome: ResearchOutcome };

export interface SessionPorts {
  reader: ReaderPort;
  load(): Promise<ResearchEvent[]>;
  append<T extends ResearchEvent>(
    expectedLength: number, create: (tx: PoolClient) => Promise<T> | T,
  ): Promise<T>;
  call(input: {
    effectKey: string; request: ReturnType<typeof request>; inputRefs: string[];
    retryRejectedAttemptId?: string;
  }): Promise<ModelResult>;
}

function outcomeAfterLimit(task: ResearchTask): FlowState {
  return {
    status: 'suspended',
    hold: {
      reason: 'turn_limit',
      nextAction: `Продолжить назначенное место задания ${task.jobId} с увеличенным пределом ходов.`,
    },
  };
}

type State = ReturnType<typeof restore>;

function restore(task: ResearchTask, events: ResearchEvent[]) {
  const messages = initialMessages(task.job);
  const replies = new Map<string, ToolReply>();
  const delivered = new Set<string>();
  const observations: NonNullable<ToolReply['observation']>[] = [];
  let pending: { model: AssistantEvent; calls: FunctionCall[]; results: ToolResult[]; intent?: ToolIntent } | null = null;
  let latestModel = 0;
  let rejections: RejectionEvent[] = [];
  let outcome: ResearchOutcome | undefined;
  const appendContinuation = (reason: string) => {
    messages.push({ role: 'user', content: reason });
  };
  for (const event of events) {
    switch (event.kind) {
      case 'rejected':
        rejections.push(event);
        break;
      case 'model': {
        rejections = [];
        latestModel = event.turn;
        event.inputRefs.forEach((id) => delivered.add(id));
        if (event.message) messages.push(event.message);
        const calls = event.message?.tool_calls ?? [];
        if (calls.length > 0) {
          pending = { model: event, calls, results: [] };
        } else {
          appendContinuation(event.finishReason === 'length'
            ? 'Ответ усечён. Продолжите назначенный вопрос с последнего неподтверждённого места.'
            : 'Предыдущий ход не завершил назначение. Продолжите с помощью доступных инструментов.');
        }
        break;
      }
      case 'intent':
        if (!pending) throw new Error('Tool intent without an assistant turn');
        pending.intent = event;
        break;
      case 'tool': {
        if (!pending) throw new Error('Tool reply without an assistant turn');
        pending.results.push(event);
        pending.intent = undefined;
        const { evidence, observation } = event.reply;
        if (evidence) replies.set(evidence.evidenceId, event.reply);
        if (observation) observations.push(observation);
        outcome ??= event.outcome;
        if (pending.results.length === pending.calls.length) {
          const { model, calls, results } = pending;
          results.forEach((result, index) => messages.push(toolMessage(calls[index], result.reply)));
          results.forEach((result) => messages.push(...imageMessage(result.reply)));
          if (model.finishReason === 'length') {
            appendContinuation('Ответ усечён. Продолжите этот же вопрос по сохранённым квитанциям и неподтверждённым местам.');
          }
          pending = null;
        }
        break;
      }
    }
  }
  return { messages, replies, delivered, observations, pending, latestModel, rejections, outcome };
}

function branchOf(task: ResearchTask): Branch {
  return task.job.mode === 'lead' ? 'A' : task.job.branch;
}

function supportPlace(task: ResearchTask, support: Branch) {
  if (task.job.mode === 'primary') return task.job.place;
  return (support === 'A' ? task.job.dispute.a : task.job.dispute.b).place;
}

function sameSource(a: EvidenceRef['place']['source'], b: EvidenceRef['place']['source']) {
  return a.projectId === b.projectId && a.documentId === b.documentId
    && a.versionId === b.versionId && a.sha256 === b.sha256;
}

function samePlace(a: EvidenceRef['place'], b: EvidenceRef['place']) {
  return sameSource(a.source, b.source) && a.unitId === b.unitId && a.page === b.page;
}

const failedTool = (code: string, nextAction?: string): ToolReply => ({ body: { ok: false, code, nextAction } });

class WorkPaused extends Error {
  constructor(public readonly hold: ResearchSuspension) {
    super(hold.reason);
  }
}

function decodeArguments(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
}

async function executeTool(
  tx: PoolClient | undefined, task: ResearchTask, reader: ReaderPort, effectKey: string,
  call: FunctionCall, state: State,
): Promise<{ reply: ToolReply; outcome?: ResearchOutcome }> {
  if (state.outcome) return { reply: failedTool('already_finished') };
  const name = call.function.name;
  if (!permittedTool(task.job, name)) return { reply: failedTool('unknown_tool') };
  const parsed = commands[name].safeParse(decodeArguments(call.function.arguments));
  if (!parsed.success) return { reply: failedTool('invalid_arguments') };
  const context = { task, branch: branchOf(task), effectKey };
  const terminal = name === 'finish_reading' || name === 'propose_resolution' || name === 'verify_resolution';
  if (terminal && state.pending?.model.finishReason === 'length') {
    return { reply: failedTool('truncated_answer', 'Повторите исход по назначенному месту.' )};
  }

  switch (name) {
    case 'inventory':
      return { reply: { body: { ok: true, inventory: await reader.inventory(context) } } };
    case 'survey': case 'zoom': case 'extract': case 'ocr': case 'search': {
      // Parse by tool name to retain the argument type at the dispatch boundary.
      const input = commands[name].parse(parsed.data);
      if (task.job.mode === 'primary' && input.support !== undefined) {
        return { reply: failedTool('foreign_branch') };
      }
      if (task.job.mode !== 'primary' && input.support === undefined) {
        return { reply: failedTool('support_required') };
      }
      const place = supportPlace(task, input.support ?? context.branch);
      const view = await reader.read(context, name === 'search'
        ? { kind: name, ...commands.search.parse(input) }
        : { kind: name, ...input });
      const outside = place.box && (!view.place.box || !contains(place.box, view.place.box));
      const invalidText = !view.mediaType.startsWith('image/')
        && !Buffer.from(view.bytes.toString('utf8')).equals(view.bytes);
      if (!samePlace(place, view.place) || outside || invalidText || view.sha256 !== hashBytes(view.bytes)) {
        return { reply: failedTool('evidence_mismatch', 'Откройте исходник по назначенному адресу.') };
      }
      if (view.bytes.byteLength > 4 * 1024 * 1024) {
        return { reply: failedTool('representation_limit', 'Запросите меньшую рамку.') };
      }
      const { evidenceId, readerVersion, sha256 } = view;
      const evidence = { evidenceId, place: view.place, readerVersion, sha256 };
      const image = view.mediaType.startsWith('image/')
        ? { mediaType: view.mediaType, data: view.bytes.toString('base64') } : undefined;
      const content = image ? undefined : view.bytes.toString('utf8');
      return { reply: { body: { ok: true, evidence, content, transform: view.transform, limitations: view.limitations }, evidence, image, readKind: name, support: input.support } };
    }
    case 'save_observation': {
      if (!tx) throw new Error('Observation requires a fenced transaction');
      const { evidenceId, ...input } = commands.save_observation.parse(parsed.data);
      const prior = state.replies.get(evidenceId);
      if (!prior?.evidence || !state.delivered.has(evidenceId)) {
        return { reply: failedTool('evidence_not_delivered') };
      }
      if (task.job.mode !== 'primary') throw new Error('Observation from a non-primary job');
      if (input.deliveryStatement && task.job.observationProtocol !== 2) {
        return { reply: failedTool('unsupported_observation_protocol') };
      }
      const inventoryStatement = input.deliveryStatement && input.sourceRole && isInventoryRole(input.sourceRole);
      if (input.sourceRole && !inventoryStatement && !task.job.question?.sourceRoles?.includes(input.sourceRole)) {
        return { reply: failedTool('source_role_unassigned') };
      }
      if (prior.image && (input.value || input.quote) && !input.box) {
        return { reply: failedTool('visual_box_required') };
      }
      if (!input.limitation && input.value && input.quote) {
        const literal = input.value.trim();
        const numeric = /^[+-]?\d+(?:[.,]\d+)?$/.test(literal);
        const appears = numeric
          ? new RegExp(`(?<![\\d.,+-])${literal.replace(/[+.]/g, '\\$&')}(?![\\d]|[.,]\\d)`, 'u').test(input.quote)
          : input.quote.includes(literal);
        if (!appears) return { reply: failedTool('value_not_in_quote') };
      }
      if (input.alternatives && !input.limitation) {
        return { reply: failedTool('alphabet_ambiguity', 'Укажите ограничение и сохраните альтернативные написания.') };
      }
      const stored = await reader.record(tx, context, { ...input, evidence: prior.evidence });
      const qualified = !input.limitation && !input.alternatives;
      return { reply: {
        body: { ok: true, observationId: stored.observationId, qualified },
        observation: { id: stored.observationId, qualified },
      } };
    }
    case 'request_next': {
      const { reason } = commands.request_next.parse(parsed.data);
      const next = await reader.next?.(context);
      return { reply: { body: {
        ok: true, place: supportPlace(task, context.branch), accepted: state.observations.map(({ id }) => id),
        action: 'continue_assigned_place', reason, ...(next ? { nextScheduledPlace: next } : {}),
      } } };
    }
    case 'finish_reading': {
      const input = commands.finish_reading.parse(parsed.data);
      const observationIds = [...new Set(state.observations.filter(({ qualified }) => qualified).map(({ id }) => id))];
      if (input.status === 'partial') return { reply: failedTool('partial_coverage', 'Откройте оставшийся участок назначенного места.') };
      if (task.job.mode !== 'primary') throw new Error('Reading outcome from a non-primary job');
      const delivered = [...state.delivered].map((id) => state.replies.get(id));
      if (task.job.place.page && !delivered.some((reply) => reply?.readKind === 'survey' && reply.image)) {
        return { reply: failedTool('survey_required', 'Откройте и рассмотрите физическое окно.') };
      }
      if (input.status === 'no_match' && state.delivered.size && !state.observations.length) {
        return { reply: { body: { ok: true } }, outcome: {
          kind: 'reviewed_no_match', evidenceIds: [...state.delivered],
        } };
      }
      if (input.status === 'covered' && observationIds.length > 0) {
        return { reply: { body: { ok: true } }, outcome: { kind: 'covered', observationIds } };
      }
      if (input.status === 'unreadable' && state.observations.some(({ qualified }) => !qualified)) {
        return { reply: { body: { ok: true } }, outcome: {
          kind: 'final_refusal', reason: input.explanation, evidenceIds: [...state.delivered],
        } };
      }
      return { reply: failedTool('grounding_required', 'Сохраните подтверждённое наблюдение или адрес нечитаемого участка.') };
    }
    case 'propose_resolution': {
      if (task.job.mode !== 'lead') throw new Error('Proposal from a non-lead job');
      const proposal = commands.propose_resolution.parse(parsed.data);
      const { a, b } = task.job.dispute;
      if (proposal.aObservationId !== a.observationId || proposal.bObservationId !== b.observationId) {
        return { reply: failedTool('proposal_pair_mismatch') };
      }
      return { reply: { body: { ok: true } }, outcome: { kind: 'proposal', ...proposal } };
    }
    case 'verify_resolution': {
      if (task.job.mode !== 'verify') throw new Error('Verification from a non-verification job');
      const input = commands.verify_resolution.parse(parsed.data);
      const replies = input.evidenceIds.map((id) => state.delivered.has(id) ? state.replies.get(id) : undefined);
      if (replies.some((reply) => !reply?.evidence)) return { reply: failedTool('evidence_not_delivered') };
      const { a, b } = task.job.dispute;
      const corroborates = [a, b].every((citation) => replies.some((reply) =>
        reply?.support === citation.branch && reply.evidence && samePlace(citation.place, reply.evidence.place)));
      if (input.verdict === 'supported' && !corroborates) return { reply: failedTool('both_supports_required') };
      return { reply: { body: { ok: true } }, outcome: { kind: 'verification', ...input } };
    }
  }
}

export async function advance(task: ResearchTask, ports: SessionPorts): Promise<FlowState> {
  const events = await ports.load();
  const state = restore(task, events);
  if (state.outcome && !state.pending) return { status: 'done', outcome: state.outcome };
  if (state.pending) {
    const { model, calls, results, intent: prior } = state.pending;
    const index = results.length;
    const before = events.length;
    const call = calls[index];
    const intent = prior ?? await ports.append(events.length, () => ({
      kind: 'intent', turn: model.turn, index, callId: call.id,
      effectKey: `${task.jobId}:tool:${model.turn}:${index}`,
    }));
    const execute = async (tx?: PoolClient): Promise<ToolResult> => {
      try {
        const result = await executeTool(tx, task, ports.reader, intent.effectKey, call, state);
        return { kind: 'tool', turn: model.turn, index, ...result };
      } catch (error) {
        if (!(error instanceof ReaderRefusal)) throw error;
        if (error.recoverability === 'temporary') {
          throw new WorkPaused({
            reason: error.code, nextAction: `Вернуться к ${intent.effectKey}`,
            retryAt: new Date(Date.now() + 2_000),
          });
        }
        return { kind: 'tool', turn: model.turn, index, reply: failedTool(error.code) };
      }
    };
    const sequence = before + (prior ? 0 : 1);
    try {
      if (call.function.name === 'save_observation') await ports.append(sequence, execute);
      else {
        const receipt = await execute();
        await ports.append(sequence, () => receipt);
      }
    } catch (error) {
      if (error instanceof WorkPaused) return { status: 'suspended', hold: error.hold };
      throw error;
    }
    return { status: 'continue' };
  }

  if (state.latestModel >= task.job.settings.maxTurns) return outcomeAfterLimit(task);
  const rejected = state.rejections.at(-1);
  if (rejected && (!rejected.retryable || state.rejections.length > task.job.settings.maxKnownRejections)) {
    return {
      status: 'suspended',
      hold: { reason: rejected.code, nextAction: `Проверить отказ ${rejected.attemptId} и продолжить задание ${task.jobId}.` },
    };
  }
  if (rejected?.retryAt && Date.parse(rejected.retryAt) > Date.now()) {
    return {
      status: 'suspended',
      hold: { reason: rejected.code, nextAction: `Повторить установленный отказ ${rejected.attemptId}.`, retryAt: new Date(rejected.retryAt) },
    };
  }
  const turn = state.latestModel + 1;
  const modelRequest = request(task.job, state.messages);
  const serialized = JSON.stringify(modelRequest);
  if (Buffer.byteLength(serialized) > 16 * 1024 * 1024) {
    return {
      status: 'suspended',
      hold: { reason: 'input_size_limit', nextAction: `Проверить сохранённый вход ${task.jobId} и предел размера профиля.` },
    };
  }
  const inputRefs = [...state.replies.keys()];
  const result = await ports.call({
    effectKey: `${task.jobId}:model:${turn}`, request: modelRequest, inputRefs,
    ...(rejected ? { retryRejectedAttemptId: rejected.attemptId } : {}),
  });
  if (result.status === 'held') return {
    status: 'suspended', hold: {
      reason: result.code,
      nextAction: result.attemptId && !result.retryAt ? `${result.nextAction} ${result.attemptId}` : result.nextAction,
      retryAt: result.retryAt,
    },
  };
  if (result.status === 'rejected') {
    await ports.append(events.length, () => ({
      kind: 'rejected', turn, attemptId: result.attemptId, code: result.code, retryable: result.retryable,
      ...(result.retryAt ? { retryAt: result.retryAt.toISOString() } : {}),
    }));
    return { status: 'continue' };
  }
  const decoded = decodeCompletion(result.output);
  await ports.append(events.length, () => ({
    kind: 'model', turn, attemptId: result.attemptId, inputRefs, requestHash: hashBytes(serialized),
    finishReason: decoded?.finishReason ?? 'invalid_response',
    message: decoded?.message ?? null,
  }));
  return { status: 'continue' };
}
