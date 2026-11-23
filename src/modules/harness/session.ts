import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import type {
  Branch, EvidenceRef, ModelResult, ObservationInput, Place, ReaderPort, ResearchOutcome, ResearchSuspension, ResearchTask,
} from './contracts.js';
import { pairConfirmed, pairCriteria, ReaderRefusal, type PairChecks } from './contracts.js';
import { contains } from '../pdf/types.js';
import { canonicalJson, isInventoryRole } from '../assessment/domain.js';
import { deliveredLines } from '../questions/attribute-aliases.js';
import { currentRevision, hasPrintedPairScope, locatePairQuote, pairSourceEvidence, type PairQuote } from './pair-evidence.js';
import { canonicalDeliveryContradicts, packageCommonGrounded, packageNonDeliveryGrounded, verifiedNativeInventoryRole } from './package-observation.js';
import { escapeRegex } from '../questions/domain.js';
import {
  checkToolArguments, commands, parseCompound, parseContext, decodeCompletion, hashBytes, imageMessage, initialMessages, observationArguments, permittedTool, request,
  reviewCommands, toolMessage, walkJob, type AssistantMessage, type FunctionCall, type ToolReply,
} from './openrouter.js';

type AssistantEvent = {
  kind: 'model'; turn: number; attemptId: string; finishReason: string;
  message: AssistantMessage | null; inputRefs: string[]; requestHash: string;
  compoundContract?: true;
  pairContract?: true;
};
type RejectionEvent = {
  kind: 'rejected'; turn: number; attemptId: string; code: string; retryable: boolean; retryAt?: string;
};
type ToolIntent = { kind: 'intent'; turn: number; index: number; callId: string; effectKey: string };
type ToolResult = {
  kind: 'tool'; turn: number; index: number; reply: ToolReply; outcome?: ResearchOutcome; stop?: ResearchStop;
};

export interface ResearchStop {
  id: string;
  reason: 'repeated_rejected_action' | 'turn_limit';
  refusalCode: string;
  nextAction: string;
  evidence: (EvidenceRef & { href: string })[];
  lastRequest: { turn: number; attemptId: string; requestHash: string; toolCallId: string; tool: string; arguments: string };
}

export type ResearchEvent = AssistantEvent | RejectionEvent | ToolIntent | ToolResult | {kind:'checkpoint_stop';stop:ResearchStop};
export type FlowState =
  | { status: 'continue' }
  | { status: 'suspended'; hold: ResearchSuspension }
  | { status: 'done'; outcome: ResearchOutcome };

export interface SessionPorts {
  reader: ReaderPort;
  load(): Promise<ResearchEvent[]>;
  continued?(stopId: string): Promise<boolean>;
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
  const emptyTruncations = new Set<number>();
  const replies = new Map<string, ToolReply>();
  const delivered = new Set<string>();
  const observations: NonNullable<ToolReply['observation']>[] = [];
  const failedActions = new Map<string, { turn: number; code: string; nextAction: string; progress: string }>();
  let stop: ResearchStop | undefined;
  let limitStop: ResearchStop | undefined;
  let pending: { model: AssistantEvent; calls: FunctionCall[]; results: ToolResult[]; intent?: ToolIntent } | null = null;
  let latestModel = 0;
  let rejections: RejectionEvent[] = [];
  let outcome: ResearchOutcome | undefined;
  const appendContinuation = (reason: string) => {
    messages.push({ role: 'user', content: reason });
  };
  for (const event of events) {
    switch (event.kind) {
      case 'checkpoint_stop':
        stop=limitStop=event.stop;
        break;
      case 'rejected':
        rejections.push(event);
        break;
      case 'model': {
        rejections = [];
        latestModel = event.turn;
        event.inputRefs.forEach((id) => delivered.add(id));
        const calls = event.message?.tool_calls ?? [];
        if (event.message) {
          const { content, refusal } = event.message;
          // An unfinished reasoning-only response has no assistant answer or tool turn to replay.
          if (event.finishReason === 'length' && content == null && !calls.length && !refusal) {
            emptyTruncations.add(messages.length);
          }
          messages.push(event.message);
        }
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
        stop = event.stop ?? stop;
        const call = pending.calls[event.index];
        const correction = usefulRefusal(task, event, call);
        const key = actionKey(call);
        if (correction) failedActions.set(key, { turn: event.turn, ...correction, progress: progressKey(delivered, observations) });
        else if (!event.stop) failedActions.delete(key);
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
  const previousCurrentMessages = render(new Map([...legacyCorrections, ...corrections]));
  const currentMessages = emptyTruncations.size
    ? previousCurrentMessages.filter((_, index) => !emptyTruncations.has(index)) : previousCurrentMessages;
  return { messages, currentMessages, previousCurrentMessages,
    roleMessages: render(legacyCorrections), replies, delivered, observations, pending, latestModel, rejections, outcome,
    failedActions, stop, limitStop };
}

function branchOf(task: ResearchTask): Branch {
  return task.job.mode === 'lead' ? 'A' : task.job.branch;
}

function reviewEvidence(state: State, evidenceIds: readonly string[], citations: readonly { branch: Branch; place: Place }[]) {
  const replies = evidenceIds.map((id) => state.delivered.has(id) ? state.replies.get(id) : undefined);
  return {
    delivered: replies.every((reply) => reply?.evidence),
    both: citations.every((citation) => replies.some((reply) =>
      reply?.support === citation.branch && reply.readKind !== 'open_context' &&
      reply.evidence && samePlace(citation.place, reply.evidence.place))),
  };
}

function checkPairEvidence(
  task: ResearchTask, state: State, checks: PairChecks, evidenceIds: readonly string[],
) {
  if (task.job.mode === 'primary') throw Error('Pair evidence from a primary job');
  const addressed = new Map<typeof pairCriteria[number], PairQuote[]>();
  for (const criterion of pairCriteria) {
    const check = checks[criterion];
    const quotes: PairQuote[] = [];
    for (const { evidenceId, quote, lineId } of check.sources) {
      const reply = state.delivered.has(evidenceId) ? state.replies.get(evidenceId) : undefined;
      if (!reply?.evidence || !reply.support) return { refusal: failedTool('evidence_not_delivered', evidenceCorrection) };
      const body = reply.body as { content?: unknown };
      const lines = typeof body.content === 'string' ? deliveredLines(body.content) : [];
      const matched = locatePairQuote(lines, quote, lineId);
      if (matched.length !== 1) return { refusal: failedTool(matched.length ? 'pair_quote_ambiguous' : 'pair_quote_not_found',
        task.job.packageReview ? 'Укажите дословную цитату с единственным физическим адресом или передайте lineId из открытого места.'
          : 'Откройте место точнее и укажите дословную цитату с единственным физическим адресом.') };
      quotes.push({ support: reply.support, evidenceId, quote, line: matched[0].text });
    }
    if (check.status === 'confirmed' && new Set(quotes.map(({ support }) => support)).size !== 2) {
      return { refusal: failedTool('pair_check_evidence_required',
        `Для проверки ${criterion} укажите открытые опоры обеих сторон или оставьте результат неопределённым.`) };
    }
    addressed.set(criterion, quotes);
  }
  const { a, b, question } = task.job.dispute;
  const anchors = { A: [a.quote], B: [b.quote] };
  for (const id of evidenceIds) {
    const reply = state.replies.get(id);
    if (reply?.support && reply.readKind !== 'open_context') {
      const { content } = reply.body as { content?: unknown };
      const quote = reply.support === 'A' ? a.quote : b.quote;
      if (typeof content === 'string') anchors[reply.support].push(
        ...deliveredLines(content).filter(({ text }) => text.includes(quote)).map(({ text }) => text));
    }
  }
  if (!task.pairScopeName) return { refusal: failedTool('review_pair_stale', 'Откройте актуальную область вопроса.') };
  const result = pairSourceEvidence({ variants: addressed.get('variant')!, revisions: addressed.get('revision')!,
    applicability: addressed.get('applicability')!, anchors, scopeName: task.pairScopeName,
    scopeAcrossVersion: Boolean(task.job.packageReview),
    assignedVariant: question.variant, confirmVariant: checks.variant.status === 'confirmed',
    confirmRevision: checks.revision.status === 'confirmed', confirmApplicability: checks.applicability.status === 'confirmed',
  });
  if ('failure' in result) return { refusal: failedTool(result.failure.code, result.failure.nextAction) };
  if (task.job.packageReview && pairConfirmed(checks) && result.proof) {
    const { scopeLabel, scopeId } = task.job.packageReview;
    const applicability = addressed.get('applicability')!;
    const revisions = addressed.get('revision')!;
    const comparability = addressed.get('comparability')!;
    for (const support of ['A', 'B'] as const) {
      const revision = support === 'A' ? result.proof.revisionA : result.proof.revisionB;
      const citation = support === 'A' ? a : b;
      if (!comparability.some((quote) => quote.support === support && quote.line.includes(citation.quote) &&
        state.replies.get(quote.evidenceId)?.readKind !== 'open_context')) {
        return { refusal: failedTool('package_pair_measurement_unproven',
          'Для сопоставимости процитируйте само исходное значение из заново открытого адреса каждой опоры.') };
      }
      if (!applicability.some((quote) => quote.support === support &&
        (hasPrintedPairScope(quote.quote, scopeLabel) || scopeId === 'common' && packageCommonGrounded(quote.quote))) ||
        !revisions.some((quote) => quote.support === support && currentRevision(quote.quote, revision))) {
        return { refusal: failedTool('package_pair_applicability_unproven',
          'Нужна действующая редакция и явно указанная область на каждой опоре. Откройте титул или оставьте сверку неопределённой.') };
      }
    }
  }
  return { proof: pairConfirmed(checks) ? result.proof : undefined };
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
  context_window_unavailable: 'Выберите существующий contextId из описи текущей ветви и задания.',
  reader_component_quote_mismatch: 'Укажите дословную цитату и lineId каждого компонента из его собственной выдачи.',
  reader_component_link_invalid: 'Свяжите компоненты по подтверждённой строке, столбцу, идентификатору или ссылке IFC. Не подставляйте недоказуемую связь.',
  reader_component_anchor_mismatch: 'Начните со значения в назначенном месте и укажите его дословный адрес.',
  reader_ifc_unit_unproven: 'Откройте локальную единицу свойства IFC либо проект, назначение и единственную проектную единицу длины. Если связь недоказуема, сохраните адресное limitation без числовых полей.',
  reader_component_unit_required: 'Для числового значения предъявите отдельную опору единицы. Если единица не доказана, сохраните адресное limitation.',
  reader_component_measure_ambiguous: 'Сузьте quote до одного значения и его подписи в этой строке. Не включайте соседнее измерение.',
  reader_component_unit_unbound: 'Возьмите единицу, относящуюся к этому числу. Откройте его подпись, соседнюю ячейку единицы или заголовок того же столбца.',
  reader_component_identifier_unbound: 'Используйте обозначение строки или ячейку из явно названного столбца обозначений. Не берите обозначение из соседнего измерения.',
  reader_component_variant_unbound: 'Используйте явно подписанное исполнение или его ячейку под заголовком исполнения той же таблицы.',
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

const preconditionRefusals = new Set(['evidence_not_delivered', 'survey_required', 'grounding_required',
  'partial_coverage', 'both_supports_required']);
const stableRefusals = new Set(['invalid_arguments', 'unknown_tool', 'foreign_branch', 'support_required',
  'value_not_in_quote', 'unit_not_in_evidence', 'visual_box_required', 'source_role_unassigned',
  'package_non_delivery_unproven',
  'proposal_pair_mismatch', ...Object.keys(readerCorrections).filter((code) => code !== 'reader_evidence_scope_mismatch')]);

function actionKey(call: FunctionCall) {
  const args = decodeArguments(call.function.arguments);
  return canonicalJson([call.function.name, args === undefined ? ['raw', call.function.arguments] : ['json', args]]);
}

function progressKey(delivered: ReadonlySet<string>, observations: readonly { id: string }[]) {
  return canonicalJson([[...delivered].sort(), observations.map(({ id }) => id).sort()]);
}

function usefulRefusal(task: ResearchTask, event: ToolResult, call: FunctionCall) {
  const body = event.reply.body;
  if (!body || typeof body !== 'object' || !('code' in body) || typeof body.code !== 'string' ||
    (!stableRefusals.has(body.code) && !preconditionRefusals.has(body.code))) return undefined;
  const hint = 'nextAction' in body && typeof body.nextAction === 'string' ? body.nextAction : undefined;
  const nextAction = hint ?? recordedCorrection(call, body.code, task) ?? readerCorrections[body.code];
  return nextAction ? { code: body.code, nextAction } : undefined;
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
  const earlyPair = state.pending?.model.pairContract === true;
  if (!permittedTool(task.job, name, earlyPair)) return { reply: failedTool('unknown_tool', 'Выберите инструмент из списка для вашей роли.') };
  const args = decodeArguments(call.function.arguments);
  const parsed = checkToolArguments(task.job, name, args, earlyPair);
  if (!parsed.success) {
    const nextAction = name === 'save_observation' ? observationCorrection(args) :
      earlyPair && (name === 'verify_resolution' || name === 'propose_resolution')
        ? 'Укажите checks по исполнению, ревизии, применимости и сопоставимости и evidenceIds открытых опор.' : name === 'verify_resolution'
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
    case 'context_inventory': {
      const { offset } = commands.context_inventory.parse(parsed.data);
      if (!reader.contexts) return { reply: failedTool('context_window_unavailable', readerCorrections.context_window_unavailable) };
      return { reply: { body: { ok: true, ...await reader.contexts(context, offset ?? 0) } } };
    }
    case 'open_context': {
      const selection=parseContext(task.job,parsed.data);
      const { contextId, representation }=selection;
      if (!reader.openContext) return { reply: failedTool('context_window_unavailable', readerCorrections.context_window_unavailable) };
      const view = await reader.openContext(context, contextId, representation ?? 'native',selection.box);
      if (view.bytes.byteLength > 4 * 1024 * 1024) return { reply: failedTool('representation_limit', 'Откройте более узкое назначенное окно.') };
      const image=walkJob(task.job)&&view.mediaType.startsWith('image/')?
        {mediaType:view.mediaType,data:view.bytes.toString('base64')}:undefined;
      if (view.place.source.projectId !== task.projectId || (!image&&view.mediaType !== 'application/json') || hashBytes(view.bytes) !== view.sha256) {
        return { reply: failedTool('evidence_mismatch') };
      }
      const { evidenceId, place, readerVersion, sha256 } = view;
      const evidence = { evidenceId, place, readerVersion, sha256 };
      return { reply: { body: { ok: true, evidence, content:image?undefined:view.bytes.toString('utf8'), limitations: view.limitations,
        ...(image?{transform:view.transform}:{}) }, evidence,image,readKind:name, ...(view.support ? { support: view.support } : {}) } };
    }
    case 'inspect_structure': {
      if(!reader.structure) return {reply:failedTool('package_walk_unavailable')};
      const {offset=0}=commands.inspect_structure.parse(parsed.data);
      const structure=await reader.structure(context);
      return {reply:{body:{ok:true,...structure,blocks:structure.blocks.slice(offset,offset+24),
        ...(offset+24<structure.blocks.length?{nextOffset:offset+24}:{})}}};
    }
    case 'record_blocks': {
      if(!tx||!reader.structure||!reader.checkBlocks||task.job.mode!=='primary') throw new Error('Block checks require a fenced package assignment');
      const { checks }=commands.record_blocks.parse(parsed.data);
      const { blocks }=await reader.structure(context,tx);
      const seen=new Set<string>();
      for(const check of checks) {
        const block=blocks.find(({id})=>id===check.blockId);
        const support=state.replies.get(check.evidenceId);
        if(!block||seen.has(check.blockId)) return {reply:failedTool('package_block_unassigned','Укажите один из назначенных блоков один раз.')};
        seen.add(check.blockId);
        if(!support?.evidence||!state.delivered.has(check.evidenceId)||!samePlace(support.evidence.place,task.job.place)) {
          return {reply:failedTool('evidence_not_delivered','Откройте представление текущего окна и укажите выданный evidenceId.')};
        }
        if(check.status==='limited') continue;
        const body=support.body as {content?:string;limitations?:string[];transform?:{pixelsPerPoint:number}};
        const lines=new Set(deliveredLines(body.content??null).map(({id})=>id));
        const fullNative=support.readKind==='extract' && !body.limitations?.length && block.lineIds?.every((id)=>lines.has(id));
        const frame=support.evidence.place.box??(support.readKind==='survey'&&!task.job.place.box?block.box:undefined);
        const fullVisual=(support.readKind==='zoom'||support.readKind==='survey')&&
          Boolean(support.image&&block.box&&frame&&contains(frame,block.box)&&
            (support.readKind==='zoom'||(body.transform?.pixelsPerPoint??0)>=1.5));
        if(!(block.kind==='native'?fullNative:fullVisual)) return {reply:failedTool('package_block_evidence_incomplete',
          'Откройте все строки блока или подробно рассмотрите его полную рамку. При ограничении сохраните limited и причину.')};
      }
      await reader.checkBlocks(tx,context,checks.map(({status,...check})=>({...check,reviewed:status==='reviewed'})));
      return {reply:{body:{ok:true,reviewed:checks.filter(({status})=>status==='reviewed').length}}};
    }
    case 'record_semantic_check': {
      if(!tx||!reader.checkSemantics) throw new Error('Semantic checks require a fenced package assignment');
      const check=commands.record_semantic_check.parse(parsed.data);
      if(check.disposition==='alternatives_checked'?!check.reason:
        check.basisIds.some((id)=>!state.observations.some((entry)=>entry.id===id&&entry.qualified))) {
        return {reply:failedTool('package_semantic_basis_unproven','Укажите квалифицированные наблюдения этой ветви.')};
      }
      await reader.checkSemantics(tx,context,check);
      return {reply:{body:{ok:true}}};
    }
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
    case 'save_compound_observation': {
      if (!tx || task.job.mode !== 'primary') throw new Error('Compound observation requires a fenced primary transaction');
      const {components,sourceRole,package:metadata}=parseCompound(task.job,parsed.data);
      const [anchor] = components;
      if (components.some(({ evidenceId }) => !state.delivered.has(evidenceId) || !state.replies.get(evidenceId)?.evidence)) {
        return { reply: failedTool('evidence_not_delivered', evidenceCorrection) };
      }
      const prior = state.replies.get(anchor.evidenceId)!;
      if (anchor.role !== 'value' || prior.readKind === 'open_context' || !samePlace(prior.evidence!.place, task.job.place)) {
        return { reply: failedTool('reader_component_anchor_mismatch', readerCorrections.reader_component_anchor_mismatch) };
      }
      if (sourceRole && !walkJob(task.job) && !task.job.question?.sourceRoles?.includes(sourceRole)) {
        return { reply: failedTool('source_role_unassigned', 'Используйте подтверждённую роль из назначения либо опустите её.') };
      }
      const stored = await reader.record(tx, context, { evidence: prior.evidence!, quote: anchor.quote,
        lineId: anchor.lineId, value: anchor.literal, unit: components.find(({ role }) => role === 'unit')?.literal,
        sourceRole, components, package:metadata });
      return { reply: { body: { ok: true, ...stored, qualified: true },
        observation: { id: stored.observationId, qualified: true } } };
    }
    case 'save_observation': {
      if (!tx) throw new Error('Observation requires a fenced transaction');
      const { evidenceId, ...fields } = observationArguments(task.job).parse(parsed.data);
      const input: Omit<ObservationInput, 'evidence'> = fields;
      const prior = state.replies.get(evidenceId);
      if (!prior?.evidence || !state.delivered.has(evidenceId)) {
        return { reply: failedTool('evidence_not_delivered', evidenceCorrection) };
      }
      if (prior.readKind === 'open_context') {
        return { reply: failedTool('reader_component_anchor_mismatch', 'Сохраните значение в назначенном месте. Для отдельных контекстных фрагментов используйте save_compound_observation.') };
      }
      if (task.job.mode !== 'primary') throw new Error('Observation from a non-primary job');
      const representation = prior.body as { content?: string };
      const matchingLines = input.deliveryStatement && input.quote ? deliveredLines(representation.content ?? null)
        .filter(({ id, text }) => (!input.lineId || id === input.lineId) && text.includes(input.quote!)) : [];
      const literal = matchingLines.length === 1 ? matchingLines[0] : undefined;
      let evidence = prior.evidence;
      let verifiedDelivery: ObservationInput['verifiedDelivery'];
      const needsCanonical = input.deliveryStatement?.status === 'not_delivered' && Boolean(evidence.place.box)
        && Boolean(evidence.place.page ?? task.job.place.page);
      if (needsCanonical || task.job.packageWindow && !packageNonDeliveryGrounded(input, Boolean(prior.image), literal?.text)) {
        let nextAction = 'Не удалось подтвердить непередачу по канонической строке. Дождитесь готовности нативного индекса либо откройте целую строку без обрезки в допущенном адресе. Укажите дословную роль описи в package.role и однозначное отрицание по этой позиции.';
        const lineId = input.lineId ?? literal?.id;
        if (reader.verifyDeliveryLine && !prior.image && evidence.place.box && lineId && input.quote &&
          (input.sourceRole ?? input.package?.role?.value) === 'inventory' && input.deliveryStatement?.status === 'not_delivered') {
          const issued = [evidence, ...[...state.delivered].flatMap((id) => {
            const view = state.replies.get(id);
            const candidate = view?.evidence;
            const body = view?.body as { content?: string } | undefined;
            return id !== evidenceId && candidate?.place.box && !view?.image && samePlace(prior.evidence!.place, candidate.place)
              && candidate.readerVersion === prior.evidence!.readerVersion
              && deliveredLines(body?.content ?? null).some((line) => line.id === lineId) ? [candidate] : [];
          })].slice(0, 16);
          const proof = await reader.verifyDeliveryLine(tx, context, { ...input, evidence, lineId }, issued);
          if (proof && canonicalDeliveryContradicts(proof.line.text, input.deliveryStatement.item)) {
            nextAction = 'В канонической строке указаны оба статуса этой позиции. Сверьте противоречие по оригиналу и оставьте непередачу на уточнении.';
          } else if (proof) {
            const role = verifiedNativeInventoryRole(input, proof);
            const anchor = issued.find(({ evidenceId: id }) => id === proof.anchorEvidenceId);
            if (role && anchor) {
              evidence = anchor;
              verifiedDelivery = { ...proof, role };
            }
          }
        }
        if (!verifiedDelivery) return { reply: failedTool('package_non_delivery_unproven', nextAction) };
      }
      const inventoryStatement = input.deliveryStatement && input.sourceRole && isInventoryRole(input.sourceRole);
      if (input.sourceRole && !inventoryStatement && !task.job.packageWindow && !task.job.question?.sourceRoles?.includes(input.sourceRole)) {
        return { reply: failedTool('source_role_unassigned', 'Используйте роль из назначения или опустите sourceRole, если она не подтверждается. Для утверждения о передаче роль обязательна.') };
      }
      if (prior.image && input.quote && !input.box) {
        return { reply: failedTool('visual_box_required', 'Укажите box вокруг цитаты внутри полученного изображения.') };
      }
      if (prior.image && (input.lineId || input.deliveryStatement?.context)) {
        return { reply: failedTool('reader_quote_mismatch', 'Для изображения используйте box без lineId и контекста строки. Для привязки к строкам откройте extract или ocr.') };
      }
      if (input.value && input.quote) {
        const literal = input.value;
        const numeric = /^[+-]?\d+(?:[.,]\d+)?$/.test(literal);
        const appears = numeric
          ? new RegExp(`(?<![\\d.,+-])${escapeRegex(literal)}(?![\\d]|[.,]\\d)`, 'u').test(input.quote)
          : input.quote.includes(literal);
        if (!appears) return { reply: failedTool('value_not_in_quote', 'Выберите дословную цитату одной строки с указанным value. Соседнюю подпись не объединяйте с числом в quote.') };
        if (input.unit && !groundedUnit(prior, { ...input, quote: input.quote, value: input.value, unit: input.unit })) {
          return { reply: failedTool('unit_not_in_evidence', 'Подтвердите исходную unit в строке значения, соседней ячейке или заголовке его столбца. Иначе сохраните limitation без числовых полей.') };
        }
      }
      const stored = await reader.record(tx, context, { ...input, evidence, ...(verifiedDelivery ? { verifiedDelivery } : {}) });
      const qualified = !input.limitation && !input.alternatives;
      return { reply: {
        body: { ok: true, ...stored, qualified },
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
      const evidenceIds = [...state.delivered].filter((id) => state.replies.get(id)?.readKind !== 'open_context');
      const delivered = evidenceIds.map((id) => state.replies.get(id));
      if (task.job.place.page && !delivered.some((reply) => reply?.readKind === 'survey' && reply.image)) {
        return { reply: failedTool('survey_required', 'Откройте и рассмотрите физическое окно.') };
      }
      if (input.status === 'no_match' && evidenceIds.length && !state.observations.length) {
        return { reply: { body: { ok: true } }, outcome: {
          kind: 'reviewed_no_match', evidenceIds,
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
      const proposal: Omit<Extract<ResearchOutcome, { kind: 'proposal' }>, 'kind'> = earlyPair
        ? reviewCommands(task.job).propose_resolution.parse(parsed.data) : commands.propose_resolution.parse(parsed.data);
      const { a, b } = task.job.dispute;
      if (proposal.aObservationId !== a.observationId || proposal.bObservationId !== b.observationId) {
        return { reply: failedTool('proposal_pair_mismatch', 'Возьмите aObservationId и bObservationId из закреплённой пары в задании.') };
      }
      if (proposal.checks && proposal.evidenceIds) {
        const evidence = reviewEvidence(state, proposal.evidenceIds, [a, b]);
        if (!evidence.delivered) return { reply: failedTool('evidence_not_delivered', evidenceCorrection) };
        if (pairConfirmed(proposal.checks) && !evidence.both) {
          return { reply: failedTool('both_supports_required', 'Сначала откройте обе опоры с support A и B.') };
        }
        const verified = checkPairEvidence(task, state, proposal.checks, proposal.evidenceIds);
        if (verified.refusal) return { reply: verified.refusal };
        if (verified.proof) proposal.verifiedPair = verified.proof;
      }
      return { reply: { body: { ok: true } }, outcome: { kind: 'proposal', ...proposal } };
    }
    case 'verify_resolution': {
      if (task.job.mode !== 'verify') throw new Error('Verification from a non-verification job');
      const input: Omit<Extract<ResearchOutcome, { kind: 'verification' }>, 'kind'> = earlyPair
        ? reviewCommands(task.job).verify_resolution.parse(parsed.data) : commands.verify_resolution.parse(parsed.data);
      const { a, b } = task.job.dispute;
      const evidence = reviewEvidence(state, input.evidenceIds, [a, b]);
      if (!evidence.delivered) return { reply: failedTool('evidence_not_delivered', evidenceCorrection) };
      if (input.verdict === 'supported' && !evidence.both) return { reply: failedTool('both_supports_required', 'Откройте обе назначенные опоры с support A и B и укажите их evidenceIds. Если проверить пару не удалось, используйте unclear.') };
      if (input.verdict === 'supported' && earlyPair && !pairConfirmed(input.checks)) {
        return { reply: failedTool('pair_check_unresolved', 'Если хотя бы одна проверка остаётся открытой или несовместимой, выберите unclear.') };
      }
      if (input.checks) {
        const verified = checkPairEvidence(task, state, input.checks, input.evidenceIds);
        if (verified.refusal) return { reply: verified.refusal };
        if (input.verdict === 'supported' && verified.proof) input.verifiedPair = verified.proof;
      }
      return { reply: { body: { ok: true } }, outcome: { kind: 'verification', ...input } };
    }
  }
}

export async function advance(task: ResearchTask, ports: SessionPorts): Promise<FlowState> {
  const events = await ports.load();
  const state = restore(task, events);
  if (state.stop && !await ports.continued?.(state.stop.id)) {
    return { status: 'suspended', hold: { reason: state.stop.reason, nextAction: state.stop.nextAction } };
  }
  if (state.outcome && !state.pending) return { status: 'done', outcome: state.outcome };
  if (state.pending) {
    const { model, calls, results, intent: prior } = state.pending;
    const index = results.length;
    const before = events.length;
    const call = calls[index];
    const refused = state.failedActions.get(actionKey(call));
    if (model.compoundContract && refused && refused.turn < model.turn && (stableRefusals.has(refused.code)
      || refused.progress === progressKey(state.delivered, state.observations))) {
      const reason = 'repeated_rejected_action' as const;
      const nextAction = `Измените отклонённое действие ${call.function.name}. ${refused.nextAction}`;
      const stop: ResearchStop = { id: randomUUID(), reason, refusalCode: refused.code, nextAction,
        evidence: [...state.delivered].flatMap((id) => {
          const evidence = state.replies.get(id)?.evidence;
          return evidence ? [{ ...evidence, href: `/api/v1/evidence/${evidence.evidenceId}` }] : [];
        }), lastRequest: { turn: model.turn, attemptId: model.attemptId, requestHash: model.requestHash,
          toolCallId: call.id, tool: call.function.name, arguments: call.function.arguments } };
      await ports.append(before, () => ({ kind: 'tool', turn: model.turn, index, reply: failedTool(reason, nextAction), stop }));
      return { status: 'suspended', hold: { reason, nextAction } };
    }
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
      if (['save_observation','save_compound_observation','record_blocks','record_semantic_check'].includes(call.function.name)) await ports.append(sequence, execute);
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

  const baseLimit=task.job.settings.maxTurns;
  const extension=state.limitStop && await ports.continued?.(state.limitStop.id)?Math.min(4,baseLimit):0;
  if(state.latestModel>=baseLimit+extension) {
    if(!walkJob(task.job)) return outcomeAfterLimit(task);
    if(state.limitStop || (task.job.mode==='primary'&&task.job.packageWindow?.followup)) return {
      status:'suspended',hold:{reason:'turn_limit_final',nextAction:'Предел продолжения достигнут. Непроверенные блоки сохранены.'},
    };
    const last=events.findLast((event)=>event.kind==='model');
    if(!last) return outcomeAfterLimit(task);
    const call=last.message?.tool_calls?.at(-1);
    const stop:ResearchStop={id:randomUUID(),reason:'turn_limit',refusalCode:'turn_limit',
      nextAction:'Разрешить одно ограниченное продолжение с сохранённого места.',
      evidence:[...state.delivered].flatMap((id)=>{
        const evidence=state.replies.get(id)?.evidence;
        return evidence?[{...evidence,href:`/api/v1/evidence/${id}`}]:[];
      }),lastRequest:{turn:last.turn,attemptId:last.attemptId,requestHash:last.requestHash,toolCallId:call?.id??'',
        tool:call?.function.name??'',arguments:call?.function.arguments??''}};
    await ports.append(events.length,()=>({kind:'checkpoint_stop',stop}));
    return {status:'suspended',hold:{reason:stop.reason,nextAction:stop.nextAction}};
  }
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
  const modelRequest = request(task.job, state.currentMessages, 'current',
    task.earlyPair && task.pairScopeName ? { scopeName: task.pairScopeName } : undefined);
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
  let compoundContract = true;
  let pairContract = task.earlyPair;
  if (task.scopeId !== null && task.earlyPair && result.status === 'held' && result.code === 'effect_conflict' && result.attemptId) {
    const previous = request(task.job, state.currentMessages, 'current', { legacy: true });
    const wire = JSON.stringify(previous);
    if (Buffer.byteLength(wire) <= 16 * 1024 * 1024) {
      result = await send(previous);
      serialized = wire;
    }
  }
  // The unfiltered history is still needed to identify requests already recorded in the gateway.
  const previouslySent = state.currentMessages === state.previousCurrentMessages ? []
    : [['current', state.previousCurrentMessages] as const];
  const prePair = task.earlyPair ? [['current', state.currentMessages] as const] : [];
  for (const [wire, messages] of [...prePair, ...previouslySent, ['compound-v1', state.previousCurrentMessages],
    ['observation-v1', state.previousCurrentMessages], ['role-v1', state.roleMessages], ['shared-v1', state.messages]] as const) {
    if (task.scopeId === null || result.status !== 'held' || result.code !== 'effect_conflict' || !result.attemptId) break;
    // An existing attempt can only be recovered with its original request hash.
    // The gateway checks that identity before returning a receipt or authorizing a retry.
    const legacy = request(task.job, messages, wire);
    const legacyWire = JSON.stringify(legacy);
    if (Buffer.byteLength(legacyWire) <= 16 * 1024 * 1024) {
      result = await send(legacy);
      serialized = legacyWire;
      compoundContract = wire === 'current' || wire === 'compound-v1';
      pairContract = undefined;
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
    ...(compoundContract ? { compoundContract: true as const } : {}),
    ...(pairContract ? { pairContract } : {}),
    finishReason: decoded?.finishReason ?? 'invalid_response',
    message: decoded?.message ?? null,
  }));
  return { status: 'continue' };
}
