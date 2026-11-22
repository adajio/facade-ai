import type { PoolClient } from 'pg';
import type {
  Branch, EvidenceRef, ModelResult, ObservationInput, ReaderPort, ResearchOutcome, ResearchSuspension, ResearchTask,
} from './contracts.js';
import { ReaderRefusal } from './contracts.js';
import { contains } from '../pdf/types.js';
import { isInventoryRole } from '../assessment/domain.js';
import { deliveredLines } from '../questions/attribute-aliases.js';
import { escapeRegex } from '../questions/domain.js';
import {
  checkToolArguments, commands, decodeCompletion, hashBytes, imageMessage, initialMessages, observationArguments, permittedTool, request,
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
  const corrections = new Map<number, ReturnType<typeof toolMessage>>();
  const legacyCorrections = new Map<number, ReturnType<typeof toolMessage>>();
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
          results.forEach(({ reply }, index) => {
            const call = calls[index];
            const { body } = reply;
            if (body && typeof body === 'object' && 'code' in body) {
              const prior = !('nextAction' in body) && argumentCorrection(call.function.name, body.code);
              if (prior) legacyCorrections.set(messages.length, toolMessage(call, { body: { ...body, nextAction: prior } }));
              const nextAction = recordedCorrection(call, body.code, task)
                ?? (!('nextAction' in body) && typeof body.code === 'string' ? readerCorrections[body.code] : undefined);
              if (nextAction) corrections.set(messages.length, toolMessage(call, { body: { ...body, nextAction } }));
            }
            messages.push(toolMessage(call, reply));
          });
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
  const render = (replacements: typeof corrections) => messages.map((message, index) => replacements.get(index) ?? message);
  return { messages, currentMessages: render(new Map([...legacyCorrections, ...corrections])),
    roleMessages: render(legacyCorrections), replies, delivered, observations, pending, latestModel, rejections, outcome };
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

function argumentCorrection(name: string, code: unknown): string | undefined {
  if (code === 'foreign_branch') return name === 'survey'
    ? 'Повторите survey с {}. Страница уже закреплена за вашим заданием.'
    : `Повторите ${name} без support. Место уже закреплено за вашим заданием.`;
  if (code === 'support_required') return `Повторите ${name} с support A или B для назначенной опоры.`;
}

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

function observationCorrection(args: unknown): string {
  const input = args && typeof args === 'object' ? args : {};
  if (!('evidenceId' in input)) return 'Укажите evidenceId из уже полученной вами выдачи инструмента чтения.';
  if ('deliveryStatement' in input) return 'Для утверждения о передаче укажите quote, sourceRole и deliveryStatement. Уберите value, unit, normalizedValue, limitation и alternatives.';
  if ('value' in input && !('unit' in input)) return 'Добавьте unit только из источника и проверьте, что value входит в дословную quote одной строки. Если единица или значение не подтверждаются, сохраните limitation без value, unit и normalizedValue.';
  if ('value' in input && !('quote' in input)) return 'Укажите дословную quote одной строки с указанным value.';
  if (('unit' in input || 'normalizedValue' in input) && !('value' in input)) return 'Передайте quote, value и unit вместе либо уберите числовые поля и сохраните limitation.';
  if ('alternatives' in input && !('limitation' in input)) return 'Для alternatives обязательно укажите limitation.';
  if ('lineId' in input && !('quote' in input)) return 'Укажите дословную quote из строки lineId либо уберите lineId.';
  return 'Заполните одну из форм save_observation: измерение с quote, value и unit, ограничение с limitation или разрешённое утверждение о передаче. Используйте только поля из схемы.';
}

const evidenceCorrection = 'Откройте нужную выдачу своим инструментом и повторите вызов с полученным evidenceId.';
const groundingCorrection: Record<string, string> = {
  covered: 'Сохраните подтверждённое наблюдение из ранее полученной выдачи и повторите covered.',
  unreadable: 'Сохраните адресное limitation с evidenceId и повторите unreadable.',
  no_match: 'Для no_match нужна хотя бы одна полученная выдача и ни одного наблюдения. При сохранённом ограничении используйте unreadable, если место полностью недоступно для ответа.',
  partial: 'Откройте оставшийся участок этого места. Если прочитать его нельзя, сохраните адресное limitation и укажите соответствующий исход.',
};
const readerCorrections: Record<string, string> = {
  reader_quote_mismatch: 'Для текста скопируйте дословную цитату одной полученной строки и её lineId. Можно убрать box, чтобы reader закрепил рамку строки. Для изображения используйте box вместо lineId.',
  reader_statement_invalid: 'Укажите дословное утверждение о передаче. Предмет должен входить в quote или в дословный context той же выдачи.',
  reader_address_invalid: 'Укажите рамку внутри назначенного окна и полученного представления. Для текста рамка должна включать цитируемую строку.',
  outside_assigned_window: 'Выберите рамку внутри назначенного окна.',
  reader_evidence_scope_mismatch: evidenceCorrection,
};

function recordedCorrection(call: FunctionCall, code: unknown, task: ResearchTask): string | undefined {
  if (code === 'evidence_not_delivered') return evidenceCorrection;
  if (call.function.name === 'save_observation' && code === 'invalid_arguments') {
    const args = decodeArguments(call.function.arguments);
    if (!observationArguments(task.job).safeParse(args).success) return observationCorrection(args);
  }
  if (call.function.name === 'finish_reading' && (code === 'grounding_required' || code === 'partial_coverage')) {
    const parsed = commands.finish_reading.safeParse(decodeArguments(call.function.arguments));
    if (parsed.success) return groundingCorrection[parsed.data.status];
  }
}

function groundedUnit(prior: ToolReply, observation: { quote: string; value: string; unit: string; lineId?: string }) {
  const { quote, value, unit, lineId } = observation;
  const literal = escapeRegex(value);
  const suffix = escapeRegex(unit);
  const marker = `(?:\\(${suffix}\\)|\\[${suffix}\\])`;
  const measure = new RegExp(`(?:(?<![\\d.,+-])${literal}\\s*${suffix}(?![\\p{L}\\p{N}])|${marker}\\s*${literal}(?![\\d.,]))`, 'u');
  if (measure.test(quote)) return true;
  if (prior.image) return false;
  const body = prior.body;
  if (!body || typeof body !== 'object' || !('content' in body) || typeof body.content !== 'string') return false;
  const lines = deliveredLines(body.content);
  const matches = lines.filter((line) => (!lineId || line.id === lineId) && line.text.includes(quote));
  if (matches.length !== 1) return false;
  const [valueLine] = matches;
  if (measure.test(valueLine.text)) return true;
  const { row, column } = valueLine.locator ?? {};
  if (typeof row === 'number' && typeof column === 'number') {
    return lines.some((line) => line.text.trim() === unit
      && ['sheet', 'table', 'section'].every((key) => line.locator?.[key] === valueLine.locator?.[key])
      && (line.locator?.row === row && line.locator?.column === column + 1
        || row > 1 && line.locator?.row === 1 && line.locator?.column === column));
  }
  const valueBox = valueLine.box;
  if (!valueBox) return false;
  const rowCells = lines.flatMap(({ box, text }) => box
    && Math.abs(box.y + box.height / 2 - valueBox.y - valueBox.height / 2) < Math.min(box.height, valueBox.height) / 2
    ? [{ box, text }] : []);
  const adjacent = rowCells.filter(({ box }) => box.x >= valueBox.x + valueBox.width).sort((a, b) => a.box.x - b.box.x);
  if (adjacent[0]?.text.trim() === unit && (adjacent[1] === undefined || adjacent[0].box.x < adjacent[1].box.x)) return true;
  const label = rowCells.filter(({ box }) => box.x + box.width <= valueBox.x)
    .map(({ box, text }) => ({ end: box.x + box.width, text })).sort((a, b) => b.end - a.end);
  if (label[0] && new RegExp(`${marker}\\s*$`, 'u').test(label[0].text)
    && (label[1] === undefined || label[0].end > label[1].end)) return true;
  const heading = lines.flatMap(({ box, text }) => {
    const gap = box ? valueBox.y - (box.y + box.height) : -1;
    return box && gap >= 0 && gap < 4 * valueBox.height && box.x < valueBox.x + valueBox.width
      && box.x + box.width > valueBox.x ? [{ gap, text }] : [];
  }).sort((a, b) => a.gap - b.gap);
  return heading[0]?.text.trim() === unit && (heading[1] === undefined || heading[0].gap < heading[1].gap);
}

async function executeTool(
  tx: PoolClient | undefined, task: ResearchTask, reader: ReaderPort, effectKey: string,
  call: FunctionCall, state: State,
): Promise<{ reply: ToolReply; outcome?: ResearchOutcome }> {
  if (state.outcome) return { reply: failedTool('already_finished') };
  const name = call.function.name;
  if (!permittedTool(task.job, name)) return { reply: failedTool('unknown_tool', 'Выберите инструмент из списка для вашей роли.') };
  const args = decodeArguments(call.function.arguments);
  const parsed = checkToolArguments(task.job, name, args);
  if (!parsed.success) {
    const nextAction = name === 'save_observation' ? observationCorrection(args) : name === 'verify_resolution'
      ? 'Передайте verdict, explanation и evidenceIds. Для supported нужны IDs обеих открытых опор.'
      : `Повторите ${name} с аргументами из схемы инструмента.`;
    return { reply: failedTool('invalid_arguments', nextAction) };
  }
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
        return { reply: failedTool('foreign_branch', argumentCorrection(name, 'foreign_branch')) };
      }
      if (task.job.mode !== 'primary' && input.support === undefined) {
        return { reply: failedTool('support_required', argumentCorrection(name, 'support_required')) };
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
      const { evidenceId, ...fields } = observationArguments(task.job).parse(parsed.data);
      const input: Omit<ObservationInput, 'evidence'> = fields;
      const prior = state.replies.get(evidenceId);
      if (!prior?.evidence || !state.delivered.has(evidenceId)) {
        return { reply: failedTool('evidence_not_delivered', evidenceCorrection) };
      }
      if (task.job.mode !== 'primary') throw new Error('Observation from a non-primary job');
      const inventoryStatement = input.deliveryStatement && input.sourceRole && isInventoryRole(input.sourceRole);
      if (input.sourceRole && !inventoryStatement && !task.job.question?.sourceRoles?.includes(input.sourceRole)) {
        return { reply: failedTool('source_role_unassigned', 'Используйте роль из назначения или опустите sourceRole, если она не подтверждается. Для утверждения о передаче роль обязательна.') };
      }
      if (prior.image && input.quote && !input.box) {
        return { reply: failedTool('visual_box_required', 'Укажите box вокруг цитаты внутри полученного изображения.') };
      }
      if (prior.image && (input.lineId || input.deliveryStatement?.context)) {
        return { reply: failedTool('reader_quote_mismatch', 'Для изображения используйте box без lineId и контекста строки. Для привязки к строкам откройте extract или ocr.') };
      }
      if (input.value && input.quote && input.unit) {
        const literal = input.value;
        const numeric = /^[+-]?\d+(?:[.,]\d+)?$/.test(literal);
        const appears = numeric
          ? new RegExp(`(?<![\\d.,+-])${escapeRegex(literal)}(?![\\d]|[.,]\\d)`, 'u').test(input.quote)
          : input.quote.includes(literal);
        if (!appears) return { reply: failedTool('value_not_in_quote', 'Выберите дословную цитату одной строки с указанным value. Соседнюю подпись не объединяйте с числом в quote.') };
        if (!groundedUnit(prior, { ...input, quote: input.quote, value: input.value, unit: input.unit })) {
          return { reply: failedTool('unit_not_in_evidence', 'Подтвердите исходную unit в строке значения, соседней ячейке или заголовке его столбца. Иначе сохраните limitation без числовых полей.') };
        }
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
      if (input.status === 'partial') return { reply: failedTool('partial_coverage', groundingCorrection.partial) };
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
      return { reply: failedTool('grounding_required', groundingCorrection[input.status]) };
    }
    case 'propose_resolution': {
      if (task.job.mode !== 'lead') throw new Error('Proposal from a non-lead job');
      const proposal = commands.propose_resolution.parse(parsed.data);
      const { a, b } = task.job.dispute;
      if (proposal.aObservationId !== a.observationId || proposal.bObservationId !== b.observationId) {
        return { reply: failedTool('proposal_pair_mismatch', 'Возьмите aObservationId и bObservationId из закреплённой пары в задании.') };
      }
      return { reply: { body: { ok: true } }, outcome: { kind: 'proposal', ...proposal } };
    }
    case 'verify_resolution': {
      if (task.job.mode !== 'verify') throw new Error('Verification from a non-verification job');
      const input = commands.verify_resolution.parse(parsed.data);
      const replies = input.evidenceIds.map((id) => state.delivered.has(id) ? state.replies.get(id) : undefined);
      if (replies.some((reply) => !reply?.evidence)) return { reply: failedTool('evidence_not_delivered', evidenceCorrection) };
      const { a, b } = task.job.dispute;
      const corroborates = [a, b].every((citation) => replies.some((reply) =>
        reply?.support === citation.branch && reply.evidence && samePlace(citation.place, reply.evidence.place)));
      if (input.verdict === 'supported' && !corroborates) return { reply: failedTool('both_supports_required', 'Откройте обе назначенные опоры с support A и B и укажите их evidenceIds. Если проверить пару не удалось, используйте unclear.') };
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
        const nextAction = readerCorrections[error.code];
        return { kind: 'tool', turn: model.turn, index, reply: failedTool(error.code, nextAction) };
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
  const modelRequest = request(task.job, state.currentMessages);
  let serialized = JSON.stringify(modelRequest);
  if (Buffer.byteLength(serialized) > 16 * 1024 * 1024) {
    return {
      status: 'suspended',
      hold: { reason: 'input_size_limit', nextAction: `Проверить сохранённый вход ${task.jobId} и предел размера профиля.` },
    };
  }
  const inputRefs = [...state.replies.keys()];
  const send = (request: typeof modelRequest) => ports.call({
    effectKey: `${task.jobId}:model:${turn}`, request, inputRefs,
    ...(rejected ? { retryRejectedAttemptId: rejected.attemptId } : {}),
  });
  let result = await send(modelRequest);
  for (const [wire, messages] of [['role-v1', state.roleMessages], ['shared-v1', state.messages]] as const) {
    if (result.status !== 'held' || result.code !== 'effect_conflict' || !result.attemptId) break;
    // An existing attempt can only be recovered with its original request hash.
    // The gateway checks that identity before returning a receipt or authorizing a retry.
    const legacy = request(task.job, messages, wire);
    const legacyWire = JSON.stringify(legacy);
    if (Buffer.byteLength(legacyWire) <= 16 * 1024 * 1024) {
      result = await send(legacy);
      serialized = legacyWire;
    }
  }
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
