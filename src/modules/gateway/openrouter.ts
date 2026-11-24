import { pngBase64Length, record, syntheticScope, validSyntheticScopes, verifySyntheticInputs, type SyntheticScope } from './admission.js';
import { verifyCopilotInputs } from '../copilot/admission.js';
import { BUDGET_USD_NANOS, GatewayError, hash, positiveInteger, type ModelTransport, type RoutePolicy, type RouterDiagnostic } from './types.js';

type OpenRouterPricingQualification = {
  maxImageWidth: number;
  maxImageHeight: number;
  maxImageBytes: number;
  cacheReadNanosPerToken: number;
  cacheWriteNanosPerToken: number;
  cacheBilling: 'replaces-input' | 'supplement';
  reasoningNanosPerToken: number;
  reasoningBilling: 'replaces-output' | 'supplement';
  completionCapIncludesReasoning: boolean;
  completionParameter: 'max_tokens' | 'max_completion_tokens';
};

export type OpenRouterInputEnvelope = {
  evidenceRef: string;
  maxWireBytes: number;
  maxTextWireBytes?: number;
  maxMessages: number;
  maxTools: number;
  tokensPerWireByte: number;
  templateOverheadTokens: number;
  maxTokensPerImage?: number;
};

export type OpenRouterProfile = {
  routeId: string;
  revision: string;
  model: string;
  provider: string;
  expectedResponseProvider: string;
  mode: 'synthetic-research' | 'strict-zdr';
  zdrEvidenceRef?: string;
  syntheticScopes?: readonly SyntheticScope[];
  boundEvidenceRef: string;
  validUntil: string;
  reasoningEffort?: 'low';
  inputTokenUpperBound: number;
  inputEnvelope?: OpenRouterInputEnvelope;
  outputTokenLimit: number;
  maxImages: number;
  maxImagePixels: number;
  promptNanosPerToken: number;
  completionNanosPerToken: number;
  requestNanos: number;
  imageNanos: number;
  additionalNanos: number;
  knownNoChargeStatuses: readonly number[];
} & Partial<OpenRouterPricingQualification>;

export type QualifiedOpenRouterProfile = OpenRouterProfile & OpenRouterPricingQualification;

export type Step15Approval = {
  qualification: 'step-15';
  apiKey: string;
  endpoint: 'https://openrouter.ai' | 'https://eu.openrouter.ai' | 'https://us.openrouter.ai';
  profiles: readonly OpenRouterProfile[];
};

const requestFields = new Set(['model','messages','tools','tool_choice','parallel_tool_calls','max_tokens','max_completion_tokens','stream']);
const messageFields = new Set(['role','name','content','tool_call_id','tool_calls','reasoning','reasoning_details']);
const functionFields = new Set(['name','description','parameters','strict']);
const endpoints = ['https://openrouter.ai','https://eu.openrouter.ai','https://us.openrouter.ai'];
export const qwen38Max = 'qwen/qwen3.8-max-0902';
const qwen38LowReasoningTokens = 4_096;
const alibabaTokenTolerance = 10;
const allowedModel = /^[a-z0-9._-]+\/[a-z0-9._-]+$/;
const allowedProvider = /^[a-z0-9._-]+(?:\/[a-z0-9._-]+)*$/;
const tracePlaceholder = '00000000-0000-0000-0000-000000000000';
const disabledPlugins = ['web', 'file-parser', 'response-healing', 'auto-router', 'pareto-router', 'armor']
  .map(id => ({ id, enabled: false }));

export type OpenRouterCostBound = {
  input: number;
  inputEnvelope?: { wireBytes: number; textWireBytes?: number; messages: number; tools: number; images: number; inputTokens: number };
  outputAndReasoning: number;
  images: number;
  request: number;
  additional: number;
  ceilingUsdNanos: number;
};

const errorTypes = new Set([
  'context_length_exceeded','max_tokens_exceeded','token_limit_exceeded','string_too_long',
  'authentication','permission_denied','payment_required','rate_limit_exceeded','provider_overloaded',
  'provider_unavailable','invalid_request','invalid_prompt','not_found','precondition_failed','payload_too_large',
  'unprocessable','content_policy_violation','refusal','invalid_image','image_too_large','image_too_small',
  'unsupported_image_format','image_not_found','image_download_failed','server','timeout','unmapped',
]);
const routingSteps = new Map([
  ['Filter by Max Price', 'max_price'],
  ['Filter by Quantization', 'quantization'],
]);
const requestIdPattern = /^req-[0-9]{10,16}-[A-Za-z0-9_-]{1,64}$/;
const generationIdPattern = /^gen-[A-Za-z0-9_-]{1,128}$/;
const errorBodyLimit = 64 * 1024;

async function readErrorBody(response: Response): Promise<unknown> {
  const reader = response.body?.getReader();
  if (!reader) return null;
  const decoder = new TextDecoder();
  let bytes = 0;
  let body = '';
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) return JSON.parse(body + decoder.decode()) as unknown;
      bytes += value.byteLength;
      if (bytes > errorBodyLimit) {
        void reader.cancel().catch(() => undefined);
        return null;
      }
      body += decoder.decode(value, { stream: true });
    }
  } catch {
    return null;
  } finally {
    reader.releaseLock();
  }
}

function routerDiagnostic(response: Response, result: Record<string, unknown> | null, traceId: string,
  generationId: string | undefined): RouterDiagnostic {
  const choice = Array.isArray(result?.choices) ? record(result.choices[0]) : null;
  const error = record(result?.error) ?? record(choice?.error);
  const metadata = record(error?.metadata);
  const router = record(result?.openrouter_metadata);
  const errorCode = typeof error?.code === 'number' && positiveInteger(error.code, 599) && error.code >= 400
    ? error.code : undefined;
  const errorType = typeof metadata?.error_type === 'string' && errorTypes.has(metadata.error_type)
    ? metadata.error_type : undefined;
  const failedRoutingStep = typeof metadata?.failed_routing_step === 'string'
    ? routingSteps.get(metadata.failed_routing_step) : undefined;
  const routerAttempt = typeof router?.attempt === 'number' && Number.isSafeInteger(router.attempt) && router.attempt >= 0
    ? router.attempt : undefined;
  const requestId = [response.headers.get('x-request-id'), result?.request_id]
    .find((value): value is string => typeof value === 'string' && requestIdPattern.test(value));
  const endpoints = record(router?.endpoints);
  const providerAttempted = (routerAttempt ?? 0) > 0 || (Array.isArray(router?.attempts) && router.attempts.length > 0)
    || (Array.isArray(endpoints?.available) && endpoints.available.some(candidate => record(candidate)?.selected === true))
    || typeof metadata?.provider_name === 'string';
  const stage = providerAttempted ? 'provider_attempted'
    : response.status === 404 && errorCode === 404 && routerAttempt === 0 && !generationId
      ? 'before_provider' : 'undetermined';

  return { traceId, httpStatus: response.status, stage,
    ...(errorCode !== undefined ? { errorCode } : {}), ...(errorType ? { errorType } : {}),
    ...(failedRoutingStep ? { failedRoutingStep } : {}), ...(routerAttempt !== undefined ? { routerAttempt } : {}),
    ...(requestId ? { requestId } : {}) };
}

function nonnegative(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= BUDGET_USD_NANOS;
}

function tokenCount(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

function requireZdr(profile: OpenRouterProfile): boolean {
  return profile.mode === 'strict-zdr' || profile.model.startsWith('moonshotai/kimi-');
}

function approvedProfile(profile: OpenRouterProfile): boolean {
  if (profile.model === qwen38Max && !isAlibabaQwenMax(profile)) return false;
  const kimi = profile.model.startsWith('moonshotai/kimi-');
  const qwen = profile.model.startsWith('qwen/');
  if ((kimi && !matchesKimiEndpoint(profile.model, profile.provider, profile.mode))
    || (requireZdr(profile) && !profile.zdrEvidenceRef?.trim())) return false;
  if (profile.mode === 'strict-zdr') return profile.syntheticScopes === undefined || validSyntheticScopes(profile.syntheticScopes);
  if (profile.mode !== 'synthetic-research' || (!kimi && !qwen)
    || (qwen && !/^alibaba(?:\/|$)/.test(profile.provider))
    || !Array.isArray(profile.syntheticScopes) || !profile.syntheticScopes.length) return false;
  return validSyntheticScopes(profile.syntheticScopes);
}

function isAlibabaQwenMax(profile: OpenRouterProfile): boolean {
  return (profile.model === 'qwen/qwen4-max' || profile.model === qwen38Max) && profile.provider === 'alibaba';
}

function isWaferKimiK31Pro(profile: OpenRouterProfile): boolean {
  return profile.model === 'moonshotai/kimi-k3.1-pro' && profile.provider === 'wafer/us';
}

function isDecartKimiK31Pro(model: string, provider: string): boolean {
  return model === 'moonshotai/kimi-k3.1-pro' && provider === 'decart/mxfp4';
}

export function matchesKimiEndpoint(model: string, provider: string, mode: OpenRouterProfile['mode']): boolean {
  return model.startsWith('moonshotai/kimi-') && (provider === 'wafer/us'
    || (mode === 'synthetic-research' && isDecartKimiK31Pro(model, provider)));
}

function retentionBlock(scope: SyntheticScope): string | null {
  const approval = scope.retentionApproval;
  if (!approval || typeof approval.approvalRef !== 'string' || !approval.approvalRef.trim()
    || typeof approval.validUntil !== 'string' || !(Date.parse(approval.validUntil) > Date.now())) {
    return 'synthetic_retention_not_approved';
  }
  if (typeof approval.noTrainingEvidenceRef !== 'string' || !approval.noTrainingEvidenceRef.trim()) {
    return 'route_training_policy_unverified';
  }
  return null;
}

function endpointBlock(profile: QualifiedOpenRouterProfile, request: unknown, endpoint: Step15Approval['endpoint']): string | null {
  const alibaba = isAlibabaQwenMax(profile);
  const decart = isDecartKimiK31Pro(profile.model, profile.provider);
  if (!alibaba && !decart && !isWaferKimiK31Pro(profile)) return null;
  if (alibaba && requireZdr(profile)) return 'route_zdr_unavailable';
  if (alibaba && endpoint !== 'https://openrouter.ai') return 'route_endpoint_unverified';

  const body = record(request);
  const choice = body?.tool_choice;
  const named = record(choice);
  const lowReasoning = profile.reasoningEffort === 'low';
  const choiceSupported = choice === undefined || choice === 'none' || choice === 'auto'
    || (!lowReasoning && ((!decart && choice === 'required')
      || (named?.type === 'function' && typeof record(named.function)?.name === 'string')));
  const tokens = body?.max_completion_tokens ?? body?.max_tokens;
  if (profile.completionParameter !== 'max_tokens' || !choiceSupported
    || (lowReasoning && typeof tokens === 'number' && tokens <= qwen38LowReasoningTokens + alibabaTokenTolerance)
    || (body?.parallel_tool_calls !== undefined && body.parallel_tool_calls !== false)) {
    return 'route_parameters_unsupported';
  }
  return null;
}

function validInputEnvelope(profile: OpenRouterProfile): boolean {
  const envelope = profile.inputEnvelope;
  if (envelope === undefined) return true;
  return Boolean(envelope && (isAlibabaQwenMax(profile) || isWaferKimiK31Pro(profile) || isDecartKimiK31Pro(profile.model, profile.provider))
    && typeof envelope.evidenceRef === 'string' && envelope.evidenceRef.trim()
    && positiveInteger(envelope.maxWireBytes, 32 * 1024 * 1024)
    && positiveInteger(envelope.maxMessages, 1024)
    && nonnegative(envelope.maxTools) && envelope.maxTools <= 1024
    && positiveInteger(envelope.tokensPerWireByte, 128)
    && nonnegative(envelope.templateOverheadTokens)
    && (envelope.maxTokensPerImage === undefined || positiveInteger(envelope.maxTokensPerImage, 10_000_000))
    && (envelope.maxTextWireBytes === undefined || (envelope.maxTokensPerImage !== undefined
      && positiveInteger(envelope.maxTextWireBytes, envelope.maxWireBytes))));
}

function boundedInput(profile: OpenRouterProfile, wireBytes: number, pngBase64Bytes: number,
  messages: number, tools: number, images: number) {
  const envelope = profile.inputEnvelope;
  if (!envelope || wireBytes > envelope.maxWireBytes || messages > envelope.maxMessages || tools > envelope.maxTools
    || (images > 0 && envelope.maxTokensPerImage === undefined)) return undefined;
  const maxTextWireBytes = envelope.maxTextWireBytes;
  const textWireBytes = wireBytes - pngBase64Bytes;
  if (maxTextWireBytes !== undefined && textWireBytes > maxTextWireBytes) return undefined;
  const inputs = envelope.templateOverheadTokens + (maxTextWireBytes === undefined ? wireBytes : textWireBytes) * envelope.tokensPerWireByte
    + images * (envelope.maxTokensPerImage ?? 0);
  return { wireBytes, ...(maxTextWireBytes === undefined ? {} : { textWireBytes }), messages, tools, images,
    inputTokens: Math.min(inputs, profile.inputTokenUpperBound) };
}

function localFunction(value: unknown): boolean {
  const tool = record(value);
  const fn = record(tool?.function);
  return Boolean(tool && Object.keys(tool).length === 2 && tool.type === 'function' && fn
    && typeof fn.name === 'string' && Object.keys(fn).every(key => functionFields.has(key)));
}

function requestBody(profile: QualifiedOpenRouterProfile, value: unknown, route: RoutePolicy): {
  wire: object; cost: OpenRouterCostBound;
} | null {
  const body = record(value);
  if (!body || Object.keys(body).some(key => !requestFields.has(key))
    || body.model !== profile.model || (body.stream !== false && body.stream !== undefined)
    || !Array.isArray(body.messages) || !body.messages.length || Date.parse(profile.validUntil) <= Date.now()
    || (body.tools !== undefined && (!Array.isArray(body.tools) || !body.tools.every(localFunction)))) return null;
  const tokens = body.max_completion_tokens ?? body.max_tokens;
  if (typeof tokens !== 'number' || !positiveInteger(tokens, profile.outputTokenLimit)
    || (body.max_completion_tokens !== undefined && body.max_tokens !== undefined)) return null;
  let images = 0;
  let pngBase64Bytes = 0;
  const messages: Record<string, unknown>[] = [];
  for (const candidate of body.messages) {
    const message = record(candidate);
    if (!message || !['system','user','assistant','tool','developer'].includes(String(message.role))) return null;
    messages.push(Object.fromEntries(Object.entries(message).filter(([key]) => messageFields.has(key))));
    const content = message.content;
    if (content === null || content === undefined || typeof content === 'string') continue;
    if (!Array.isArray(content)) return null;
    for (const candidatePart of content) {
      const part = record(candidatePart);
      if (!part || Object.keys(part).length !== 2) return null;
      if (part.type === 'text' && typeof part.text === 'string') continue;
      const image = record(part.image_url);
      if (part.type !== 'image_url' || !image || Object.keys(image).length !== 1) return null;
      const base64Bytes = pngBase64Length(image.url, profile);
      if (base64Bytes === null) return null;
      images++;
      // The qualified vision input is a user content part.
      if (message.role === 'user') pngBase64Bytes += base64Bytes;
    }
  }
  if (images > profile.maxImages) return null;
  const inputRate = profile.cacheBilling === 'replaces-input'
    ? Math.max(profile.promptNanosPerToken, profile.cacheReadNanosPerToken, profile.cacheWriteNanosPerToken)
    : profile.promptNanosPerToken + profile.cacheReadNanosPerToken + profile.cacheWriteNanosPerToken;
  const outputRate = profile.reasoningBilling === 'replaces-output'
    ? Math.max(profile.completionNanosPerToken, profile.reasoningNanosPerToken)
    : profile.completionNanosPerToken + profile.reasoningNanosPerToken;
  const { max_tokens: _legacy, max_completion_tokens: _completion, parallel_tool_calls: parallelTools, ...approved } = body;
  const alibaba = isAlibabaQwenMax(profile);
  const wafer = isWaferKimiK31Pro(profile);
  const decart = isDecartKimiK31Pro(profile.model, profile.provider);
  const wire = {
    ...approved, messages, [profile.completionParameter]: tokens, stream: false, usage: { include: true },
    ...(profile.reasoningEffort === 'low' ? { reasoning_effort: profile.reasoningEffort } : {}),
    plugins: disabledPlugins,
    ...(!alibaba && !wafer && !decart && parallelTools !== undefined ? { parallel_tool_calls: parallelTools } : {}),
    provider: {
      only: [profile.provider], order: [profile.provider], allow_fallbacks: false,
      require_parameters: true, data_collection: alibaba && !requireZdr(profile) ? 'allow' : 'deny', zdr: requireZdr(profile),
      max_price: {
        prompt: profile.promptNanosPerToken / 1_000, completion: profile.completionNanosPerToken / 1_000,
        request: profile.requestNanos / 1_000_000_000, image: profile.imageNanos / 1_000_000_000,
      },
    },
  };
  const wireBytes = Buffer.byteLength(JSON.stringify({ ...wire, trace: { trace_id: tracePlaceholder } }));
  if (wireBytes > route.maxRequestBytes) return null;
  const inputEnvelope = boundedInput(profile, wireBytes, pngBase64Bytes, messages.length, Array.isArray(body.tools) ? body.tools.length : 0, images);
  const inputTokens = inputEnvelope?.inputTokens ?? profile.inputTokenUpperBound;
  // Wafer Chat Completions may retry without max_tokens if the requested context cannot fit.
  if (wafer && inputTokens + tokens > 1_048_576) {
    const extraOutputTokens = Math.max(0, 943_718 - tokens);
    const fallbackCost = BigInt(extraOutputTokens) * BigInt(outputRate);
    if (BigInt(profile.additionalNanos) < fallbackCost) return null;
  }
  // Cover both combined and separate output caps on the opted-in Qwen3.8 route.
  const separateReasoning = profile.reasoningEffort === 'low' ? qwen38LowReasoningTokens + alibabaTokenTolerance : 0;
  const billedOutputTokens = tokens + (alibaba ? alibabaTokenTolerance : 0) + separateReasoning;
  const input = BigInt(inputTokens) * BigInt(inputRate);
  const outputAndReasoning = BigInt(billedOutputTokens) * BigInt(outputRate);
  const imageCharge = BigInt(images) * BigInt(profile.imageNanos);
  const total = input + outputAndReasoning + imageCharge + BigInt(profile.requestNanos) + BigInt(profile.additionalNanos);
  const ceilingUsdNanos = Math.max(1, Number(total));
  if (!positiveInteger(ceilingUsdNanos, route.ceilingUsdNanos)) return null;

  return {
    wire,
    cost: { input: Number(input), ...(inputEnvelope ? { inputEnvelope } : {}), outputAndReasoning: Number(outputAndReasoning), images: Number(imageCharge),
      request: profile.requestNanos, additional: profile.additionalNanos, ceilingUsdNanos },
  };
}

function validReasoningProfile(profile: OpenRouterProfile): boolean {
  if (profile.reasoningEffort === undefined) return profile.completionCapIncludesReasoning === true;
  return profile.reasoningEffort === 'low' && profile.model === qwen38Max && profile.provider === 'alibaba'
    && profile.expectedResponseProvider === 'Alibaba' && profile.mode === 'synthetic-research'
    && profile.completionParameter === 'max_tokens' && typeof profile.completionCapIncludesReasoning === 'boolean'
    && profile.outputTokenLimit > qwen38LowReasoningTokens + alibabaTokenTolerance && profile.outputTokenLimit <= 131_072
    // Public list rates in USD nanos/token for the two eligible Alibaba endpoints.
    && profile.promptNanosPerToken >= 2_000 && profile.completionNanosPerToken >= 6_000
    && (profile.reasoningNanosPerToken ?? -1) >= 6_000 && (profile.cacheReadNanosPerToken ?? -1) >= 250
    && (profile.cacheWriteNanosPerToken ?? -1) >= 2_500;
}

function validProfile(profile: OpenRouterProfile): profile is QualifiedOpenRouterProfile {
  return Boolean(profile.routeId && profile.revision && allowedModel.test(profile.model) && allowedProvider.test(profile.provider)
    && profile.expectedResponseProvider?.trim() && approvedProfile(profile) && validInputEnvelope(profile)
    && profile.boundEvidenceRef?.trim() && Number.isFinite(Date.parse(profile.validUntil))
    && positiveInteger(profile.inputTokenUpperBound, 10_000_000) && positiveInteger(profile.outputTokenLimit, 1_000_000)
    && validReasoningProfile(profile)
    && (profile.completionParameter === 'max_tokens' || profile.completionParameter === 'max_completion_tokens')
    && (profile.cacheBilling === 'replaces-input' || profile.cacheBilling === 'supplement')
    && (profile.reasoningBilling === 'replaces-output' || profile.reasoningBilling === 'supplement')
    && [profile.maxImages, profile.maxImagePixels, profile.maxImageWidth, profile.maxImageHeight, profile.maxImageBytes,
      profile.promptNanosPerToken, profile.completionNanosPerToken, profile.cacheReadNanosPerToken,
      profile.cacheWriteNanosPerToken, profile.reasoningNanosPerToken, profile.requestNanos,
      profile.imageNanos, profile.additionalNanos].every(nonnegative)
    && (profile.maxImages === 0 || [profile.maxImagePixels, profile.maxImageWidth,
      profile.maxImageHeight, profile.maxImageBytes].every(bound => nonnegative(bound) && bound > 0))
    && Array.isArray(profile.knownNoChargeStatuses)
    && profile.knownNoChargeStatuses.every(code => Number.isInteger(code) && code >= 400 && code < 500));
}

export function estimateOpenRouterRequest(profile: OpenRouterProfile, route: RoutePolicy, request: unknown): OpenRouterCostBound | null {
  if (route.transport !== 'openrouter' || profile.routeId !== route.id || profile.revision !== route.revision || !validProfile(profile)) return null;
  if (endpointBlock(profile, request, 'https://openrouter.ai')) return null;
  return requestBody(profile, request, route)?.cost ?? null;
}

export function openRouterTransport(approval: Step15Approval): ModelTransport {
  if (approval.qualification !== 'step-15' || !approval.apiKey.trim()
    || approval.apiKey.trim().startsWith('ci_live_') || !endpoints.includes(approval.endpoint)) {
    throw new GatewayError('step15_approval_required');
  }
  const profiles = new Map<string, { profile: QualifiedOpenRouterProfile; fingerprint: string }>();
  for (const profile of structuredClone(approval.profiles)) {
    const key = profile.routeId + '/' + profile.revision;
    if (profiles.has(key) || !validProfile(profile)) throw new GatewayError('invalid_openrouter_profile');
    profiles.set(key, { profile, fingerprint: hash([approval.endpoint, profile]) });
  }
  if (!profiles.size) throw new GatewayError('step15_profile_required');
  const apiKey = approval.apiKey;
  const url = approval.endpoint + '/api/v1/chat/completions';
  const profileFor = (route: RoutePolicy) => profiles.get(route.id + '/' + route.revision);
  return {
    kind: 'openrouter',
    requestBlock(route, request) {
      const selected = profileFor(route);
      return selected ? endpointBlock(selected.profile, request, approval.endpoint) : null;
    },
    validate(route, request) {
      const selected = profileFor(route);
      return Boolean(selected && !endpointBlock(selected.profile, request, approval.endpoint)
        && requestBody(selected.profile, request, route));
    },
    quote(route, request) {
      const selected = profileFor(route);
      const bound = selected && !endpointBlock(selected.profile, request, approval.endpoint)
        && requestBody(selected.profile, request, route)?.cost;
      return bound && selected
        ? { ceilingUsdNanos: bound.ceilingUsdNanos, pricingFingerprint: selected.fingerprint }
        : null;
    },
    async authorize(tx, route, context) {
      const profile = profileFor(route)?.profile;
      if (!profile) return false;
      if (profile.mode === 'strict-zdr' && profile.syntheticScopes === undefined) return true;
      const scope = syntheticScope(profile.syntheticScopes, context.projectId, context.scopeId);
      if (context.dataClass !== 'synthetic' || !scope) return false;
      if (record(context.payload)?.mode === 'copilot') {
        if (isAlibabaQwenMax(profile)) {
          const block = retentionBlock(scope);
          if (block) return block;
        }
        return verifyCopilotInputs(tx, context, scope.originalSha256s);
      }
      return verifySyntheticInputs(tx, context, scope, isAlibabaQwenMax(profile) ? retentionBlock : undefined);
    },
    async send(attempt, route, request, signal) {
      const selected = profileFor(route);
      const profile = selected?.profile;
      const body = profile && requestBody(profile, request, route);
      if (!selected || !profile || !body || endpointBlock(profile, request, approval.endpoint)
        || selected.fingerprint !== attempt.pricingFingerprint || body.cost.ceilingUsdNanos !== attempt.ceilingUsdNanos) {
        return { receipt: { state: 'rejected', code: 'invalid_request', evidenceRef: 'gateway:no-network' } };
      }
      const alibaba = isAlibabaQwenMax(profile);
      if (alibaba || isDecartKimiK31Pro(profile.model, profile.provider)) {
        const scope = syntheticScope(profile.syntheticScopes, attempt.projectId, attempt.scopeId);
        const block = attempt.dataClass === 'synthetic' && scope
          ? (alibaba ? retentionBlock(scope) : null) : 'route_data_unapproved';
        if (block) return { receipt: { state: 'rejected', code: block, evidenceRef: 'gateway:no-network' } };
      }
      const response = await fetch(url, {
        method: 'POST', redirect: 'error', signal,
        headers: {
          authorization: 'Bearer ' + apiKey, 'content-type': 'application/json', 'X-OpenRouter-Metadata': 'enabled',
        },
        body: JSON.stringify({ ...body.wire, trace: { trace_id: attempt.id } }),
      });
      const output: unknown = response.ok ? await response.json().catch(() => null) : await readErrorBody(response);
      const result = record(output);
      const id = typeof result?.id === 'string' && generationIdPattern.test(result.id) ? 'openrouter:' + result.id : undefined;
      const usage = record(result?.usage);
      const cost = typeof usage?.cost === 'number' && usage.cost >= 0
        ? Math.ceil(usage.cost * 1_000_000_000) : NaN;
      if (!response.ok || !id || !Number.isSafeInteger(cost)) {
        const headerId = response.headers.get('x-generation-id');
        const providerId = id ?? (headerId && generationIdPattern.test(headerId) ? 'openrouter:' + headerId : undefined);
        const diagnostic = routerDiagnostic(response, result, attempt.id, providerId);
        const code = response.ok ? 'usage_unconfirmed' : 'http_' + response.status;
        if (!response.ok && selected.profile.knownNoChargeStatuses.includes(response.status)) {
          return { receipt: { state: 'rejected', code, evidenceRef: 'openrouter:qualified-no-charge:' + response.status,
            routerDiagnostic: diagnostic } };
        }
        return { receipt: { state: 'unknown', code, providerId, routerDiagnostic: diagnostic } };
      }
      const model = typeof result?.model === 'string' ? result.model : undefined;
      const provider = typeof result?.provider === 'string' ? result.provider : undefined;
      const routeVerified = model === selected.profile.model && provider === selected.profile.expectedResponseProvider;
      return {
        receipt: { state: 'paid', costUsdNanos: cost, providerId: id, evidenceRef: id, model, provider, routeVerified,
          promptTokens: tokenCount(usage?.prompt_tokens), completionTokens: tokenCount(usage?.completion_tokens) },
        ...(routeVerified ? { output } : {}),
      };
    },
  };
}
