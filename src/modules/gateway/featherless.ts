import { customerScope, pngBase64Length, record, requestHasImages, syntheticScope, validCustomerAccess,
  validSyntheticScopes, verifyApprovedResearchInputs, type CustomerAccess, type SyntheticScope } from './admission.js';
import { BUDGET_USD_NANOS, GatewayError, hash, positiveInteger,
  type ModelTransport, type ProviderOutcome, type RoutePolicy } from './types.js';

export const featherlessQwenModel = 'Qwen/Qwen3.8-2.4T-A95B';
export const featherlessQwenVisionModel = 'Qwen/Qwen3.8-Flash-Next';
const minimumRates = {
  [featherlessQwenModel]: { input: 1_000, output: 4_000 },
  [featherlessQwenVisionModel]: { input: 150, output: 500 },
} as const;

export function isFeatherlessQwen(model: string): model is keyof typeof minimumRates {
  return Object.hasOwn(minimumRates, model);
}

type ImageLimits = {
  count: number;
  maxImageWidth: number;
  maxImageHeight: number;
  maxImagePixels: number;
  maxImageBytes: number;
};
const endpoint = 'https://api.featherless.ai/v1/chat/completions';
const requestFields = new Set(['model', 'messages', 'tools', 'tool_choice', 'parallel_tool_calls', 'max_tokens', 'stream']);
const messageFields = new Set(['role', 'name', 'content', 'tool_call_id', 'tool_calls', 'reasoning', 'reasoning_details']);
const roles = new Set(['system', 'developer', 'user', 'assistant', 'tool']);
const functionFields = new Set(['name', 'description', 'parameters', 'strict']);
const receiptId = /^[a-zA-Z0-9_-]{1,120}$/;

export type FeatherlessProfile = {
  transport: 'featherless';
  routeId: string;
  revision: string;
  model: keyof typeof minimumRates;
  images?: ImageLimits;
  mode: 'synthetic-research' | 'customer';
  syntheticScopes?: readonly SyntheticScope[];
  customerAccess?: CustomerAccess;
  boundEvidenceRef: string;
  validUntil: string;
  contextTokens: number;
  outputTokenLimit: number;
  inputNanosPerToken: number;
  outputNanosPerToken: number;
};

function hasText(value: unknown): value is string {
  return typeof value === 'string' && Boolean(value.trim());
}

function validProfile(profile: FeatherlessProfile) {
  if (!isFeatherlessQwen(profile.model)) return false;
  const rates = minimumRates[profile.model];
  const images = profile.images;
  if (images && (profile.model !== featherlessQwenVisionModel
    || !positiveInteger(images.count, 32)
    || ![images.maxImageWidth, images.maxImageHeight, images.maxImagePixels, images.maxImageBytes]
      .every(bound => positiveInteger(bound, 20_000_000)))) return false;
  return profile.transport === 'featherless'
    && (profile.mode === 'synthetic-research'
      ? validSyntheticScopes(profile.syntheticScopes) && profile.customerAccess === undefined
      : profile.mode === 'customer' && profile.model === featherlessQwenVisionModel
        && profile.syntheticScopes === undefined && profile.customerAccess !== undefined)
    && [profile.routeId, profile.revision, profile.boundEvidenceRef].every(hasText)
    && Number.isFinite(Date.parse(profile.validUntil))
    && positiveInteger(profile.contextTokens, 262_144)
    && positiveInteger(profile.outputTokenLimit, 32_768) && profile.outputTokenLimit < profile.contextTokens
    && positiveInteger(profile.inputNanosPerToken, BUDGET_USD_NANOS) && profile.inputNanosPerToken >= rates.input
    && positiveInteger(profile.outputNanosPerToken, BUDGET_USD_NANOS) && profile.outputNanosPerToken >= rates.output;
}

function localFunction(value: unknown) {
  const tool = record(value);
  const fn = record(tool?.function);
  return tool?.type === 'function' && Object.keys(tool).length === 2 && fn
    && hasText(fn.name) && Object.keys(fn).every(key => functionFields.has(key));
}

function prepare(profile: FeatherlessProfile, route: RoutePolicy, request: unknown) {
  const body = record(request);
  const tokens = body?.max_tokens;
  if (!body || body.model !== profile.model || Date.parse(profile.validUntil) <= Date.now()
    || Object.keys(body).some(key => !requestFields.has(key)) || body.stream !== false || body.parallel_tool_calls !== false
    || body.tool_choice !== 'auto' || !Array.isArray(body.tools) || !body.tools.length || !body.tools.every(localFunction)
    || !Array.isArray(body.messages) || !body.messages.length
    || typeof tokens !== 'number' || !positiveInteger(tokens, profile.outputTokenLimit)) return null;

  const messages = [];
  let imageCount = 0;
  for (const value of body.messages) {
    const message = record(value);
    if (!message || typeof message.role !== 'string' || !roles.has(message.role)
      || Object.keys(message).some(key => !messageFields.has(key))) return null;
    const content = message.content;
    if (!Array.isArray(content)) {
      if (content != null && typeof content !== 'string') return null;
      messages.push(message);
      continue;
    }
    const text: string[] = [];
    let hasImage = false;
    for (const value of content) {
      const part = record(value);
      if (!part || Object.keys(part).length !== 2) return null;
      if (part.type === 'text' && typeof part.text === 'string') {
        text.push(part.text);
        continue;
      }
      const image = record(part.image_url);
      const limits = profile.images;
      if (message.role !== 'user' || part.type !== 'image_url' || !image || Object.keys(image).length !== 1
        || !limits || ++imageCount > limits.count || pngBase64Length(image.url, limits) === null) return null;
      hasImage = true;
    }
    messages.push({ ...message, content: hasImage ? content : text.join('\n') });
  }

  const { parallel_tool_calls: _sequential, ...approved } = body;
  const wire = JSON.stringify({ ...approved, messages });
  const ceilingUsdNanos = profile.contextTokens * profile.inputNanosPerToken + tokens * profile.outputNanosPerToken + 1_000;
  if (Buffer.byteLength(wire) > route.maxRequestBytes
    || !positiveInteger(ceilingUsdNanos, Math.min(route.ceilingUsdNanos, BUDGET_USD_NANOS))) return null;
  return { wire, tokens, ceilingUsdNanos };
}

async function readOutcome(response: Response, profile: FeatherlessProfile, maxOutput: number, ceiling: number): Promise<ProviderOutcome> {
  const result = record(await response.json().catch(() => null));
  const rawId = result?.id ?? response.headers.get('x-request-id');
  const providerId = typeof rawId === 'string' && receiptId.test(rawId) ? 'featherless:' + rawId : undefined;
  const errorCode = record(result?.error)?.code;
  if (response.status === 403 && errorCode === 'model_gated_needs_oauth') {
    // Model access is refused before inference. Featherless bills only successful requests.
    return { receipt: { state: 'rejected', code: errorCode, evidenceRef: providerId ?? 'featherless:preflight:' + errorCode } };
  }
  const usage = record(result?.usage);
  const cost = typeof usage?.cost === 'number' ? Math.ceil(usage.cost * 1_000_000_000) : NaN;
  if (!response.ok || !providerId || !Number.isSafeInteger(cost) || cost < 0 || cost > BUDGET_USD_NANOS) {
    return { receipt: { state: 'unknown', code: response.ok ? 'featherless_billing_unconfirmed' : 'featherless_http_' + response.status,
      providerId } };
  }
  const model = typeof result?.model === 'string' ? result.model : undefined;
  const promptTokens = Number.isSafeInteger(usage?.prompt_tokens) && Number(usage?.prompt_tokens) >= 0
    ? Number(usage?.prompt_tokens) : undefined;
  const completionTokens = Number.isSafeInteger(usage?.completion_tokens) && Number(usage?.completion_tokens) >= 0
    ? Number(usage?.completion_tokens) : undefined;
  const routeVerified = model === profile.model && promptTokens !== undefined && promptTokens <= profile.contextTokens
    && completionTokens !== undefined && completionTokens <= maxOutput && cost <= ceiling;
  return {
    receipt: { state: 'paid', costUsdNanos: cost, providerId, evidenceRef: providerId, model,
      provider: 'Featherless', routeVerified, promptTokens, completionTokens },
    ...(routeVerified && Array.isArray(result?.choices) ? { output: { choices: result.choices } } : {}),
  };
}

export function featherlessTransport(approval: { apiKey: string; profiles: readonly FeatherlessProfile[] }): ModelTransport {
  const apiKey = approval.apiKey.trim();
  if (!apiKey || /\s/.test(apiKey) || /^(ci_live_|sk-or-)/.test(apiKey)) throw new GatewayError('featherless_key_required');
  const revisionKey = (routeId: string, revision: string) => JSON.stringify([routeId, revision]);
  const profiles = new Map<string, { profile: FeatherlessProfile; fingerprint: string }>();
  for (const profile of structuredClone(approval.profiles)) {
    const id = revisionKey(profile.routeId, profile.revision);
    if (!validProfile(profile) || profiles.has(id)
      || (profile.customerAccess !== undefined && !validCustomerAccess(profile.customerAccess, apiKey))) throw new GatewayError('invalid_featherless_profile');
    profiles.set(id, { profile, fingerprint: hash([endpoint, profile]) });
  }
  if (!profiles.size) throw new GatewayError('featherless_profile_required');
  const selected = (route: RoutePolicy) => route.transport === 'featherless' ? profiles.get(revisionKey(route.id, route.revision)) : undefined;
  return {
    kind: 'featherless',
    quote(route, request) {
      const configuration = selected(route);
      const body = configuration && prepare(configuration.profile, route, request);
      return body && configuration ? { ceilingUsdNanos: body.ceilingUsdNanos, pricingFingerprint: configuration.fingerprint } : null;
    },
    async authorize(tx, route, context) {
      const configuration = selected(route);
      const profile = configuration?.profile;
      const scope = context.dataClass === 'customer'
        ? customerScope(profile?.customerAccess, context.projectId, context.scopeId)
        : context.dataClass === 'synthetic' ? syntheticScope(profile?.syntheticScopes, context.projectId, context.scopeId) : undefined;
      const job = record(context.payload);
      return Boolean(scope && (job?.mode === 'primary' || job?.mode === 'verify') && job.branch === 'B'
        && await verifyApprovedResearchInputs(tx, context, scope));
    },
    async send(attempt, route, request, signal) {
      const configuration = selected(route);
      const body = configuration && prepare(configuration.profile, route, request);
      const customer = customerScope(configuration?.profile.customerAccess, attempt.projectId, attempt.scopeId);
      const permitted = attempt.dataClass === 'customer'
        ? customer && (customer.allowImages || !requestHasImages(request))
        : attempt.dataClass === 'synthetic' && syntheticScope(configuration?.profile.syntheticScopes, attempt.projectId, attempt.scopeId);
      if (!configuration || !body || !permitted || attempt.routeId !== route.id || attempt.revision !== route.revision
        || (attempt.purpose !== 'primary_b' && attempt.purpose !== 'review')
        || attempt.pricingFingerprint !== configuration.fingerprint || attempt.ceilingUsdNanos !== body.ceilingUsdNanos) {
        return { receipt: { state: 'rejected', code: 'invalid_request', evidenceRef: 'gateway:no-network' } };
      }
      const response = await fetch(endpoint, {
        method: 'POST', redirect: 'error', signal, body: body.wire,
        headers: { authorization: 'Bearer ' + apiKey, 'content-type': 'application/json', 'X-Title': 'Facade AI' },
      });
      return readOutcome(response, configuration.profile, body.tokens, body.ceilingUsdNanos);
    },
  };
}
