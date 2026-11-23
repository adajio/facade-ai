import { gzipSync } from 'node:zlib';
import { pngBase64Length, record, syntheticScope, validSyntheticScopes, verifySyntheticInputs, type SyntheticScope } from './admission.js';
import { BUDGET_USD_NANOS, GatewayError, hash, positiveInteger, type ModelTransport, type ProviderOutcome, type RoutePolicy } from './types.js';

export const terraModel = 'gpt-6.1-terra';
const endpoint = 'https://api.cheaperinference.com/v1/chat/completions';
const maxWireBytes = 4_500_000;
const maxInflatedBytes = 20_000_000;
const contextTokens = 1_050_000;
const requestIdPattern = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
const requestFields = new Set(['model', 'messages', 'tools', 'tool_choice', 'parallel_tool_calls', 'max_tokens', 'stream']);
const messageFields = new Set(['role', 'name', 'content', 'tool_call_id', 'tool_calls', 'reasoning', 'reasoning_details']);
const roles = new Set(['system', 'developer', 'user', 'assistant', 'tool']);
const functionFields = new Set(['name', 'description', 'parameters', 'strict']);
const noChargeErrors = new Map([
  [400, ['unsupported_parameter', 'unexpected_parameter', 'invalid_parameter']],
  [401, ['invalid_api_key']],
  [402, ['insufficient_balance']],
  [403, ['model_not_allowed']],
  [503, ['zdr_capacity_unavailable']],
]);

export type CheaperInferenceProfile = {
  transport: 'cheaperinference';
  routeId: string;
  revision: string;
  model: typeof terraModel;
  mode: 'strict-zdr';
  zdrEvidenceRef: string;
  syntheticScopes: readonly SyntheticScope[];
  boundEvidenceRef: string;
  validUntil: string;
  inputNanosPerToken: number;
  outputNanosPerToken: number;
  outputTokenLimit: number;
  maxImages: number;
  maxImageWidth: number;
  maxImageHeight: number;
  maxImagePixels: number;
  maxImageBytes: number;
};

type Approval = { apiKey: string; profiles: readonly CheaperInferenceProfile[] };

function hasText(value: unknown): value is string {
  return typeof value === 'string' && Boolean(value.trim());
}

function validProfile(profile: CheaperInferenceProfile) {
  return profile.transport === 'cheaperinference' && profile.model === terraModel && profile.mode === 'strict-zdr'
    && [profile.routeId, profile.revision, profile.zdrEvidenceRef, profile.boundEvidenceRef].every(hasText)
    && Number.isFinite(Date.parse(profile.validUntil)) && validSyntheticScopes(profile.syntheticScopes)
    // Use maker list prices for the largest context tier, including cache writes and reasoning output.
    && positiveInteger(profile.inputNanosPerToken, BUDGET_USD_NANOS) && profile.inputNanosPerToken >= 2_500
    && positiveInteger(profile.outputNanosPerToken, BUDGET_USD_NANOS) && profile.outputNanosPerToken >= 7_500
    && positiveInteger(profile.outputTokenLimit, 128_000)
    && Number.isSafeInteger(profile.maxImages) && profile.maxImages >= 0
    && [profile.maxImageWidth, profile.maxImageHeight, profile.maxImagePixels, profile.maxImageBytes]
      .every(bound => positiveInteger(bound, maxInflatedBytes));
}

function localFunction(value: unknown) {
  const tool = record(value);
  const fn = record(tool?.function);
  return tool && Object.keys(tool).length === 2 && tool.type === 'function' && fn
    && hasText(fn.name) && Object.keys(fn).every(key => functionFields.has(key));
}

function prepare(profile: CheaperInferenceProfile, route: RoutePolicy, request: unknown) {
  const body = record(request);
  const tokens = body?.max_tokens;
  if (!body || body.model !== profile.model || Date.parse(profile.validUntil) <= Date.now()
    || Object.keys(body).some(key => !requestFields.has(key)) || body.stream !== false || body.parallel_tool_calls !== false
    || (body.tool_choice !== 'required' && body.tool_choice !== 'auto')
    || !Array.isArray(body.tools) || !body.tools.length || !body.tools.every(localFunction)
    || !Array.isArray(body.messages) || !body.messages.length
    || typeof tokens !== 'number' || !positiveInteger(tokens, profile.outputTokenLimit)) return null;

  let images = 0;
  for (const candidate of body.messages) {
    const message = record(candidate);
    if (!message || typeof message.role !== 'string' || !roles.has(message.role)
      || Object.keys(message).some(key => !messageFields.has(key))) return null;
    const content = message.content;
    if (content === null || content === undefined || typeof content === 'string') continue;
    if (!Array.isArray(content)) return null;
    for (const value of content) {
      const part = record(value);
      if (!part || Object.keys(part).length !== 2) return null;
      if (part.type === 'text' && typeof part.text === 'string') continue;
      const image = record(part.image_url);
      if (message.role !== 'user' || part.type !== 'image_url' || !image || Object.keys(image).length !== 1
        || ++images > profile.maxImages || pngBase64Length(image.url, profile) === null) return null;
    }
  }
  // The service advertises tool_choice but not parallel_tool_calls. The harness handles returned tool calls sequentially.
  const { parallel_tool_calls: _sequential, ...approved } = body;
  const wire = JSON.stringify({ ...approved, zdr: true, min_discount_percent: 0 });
  const bytes = Buffer.byteLength(wire);
  if (bytes > route.maxRequestBytes || bytes > maxInflatedBytes) return null;
  const compressed = bytes > maxWireBytes ? gzipSync(wire) : null;
  if (compressed && compressed.length > maxWireBytes) return null;

  // Reserve the full possible prompt context, including vision, and the full requested output plus receipt rounding.
  const ceilingUsdNanos = contextTokens * profile.inputNanosPerToken + tokens * profile.outputNanosPerToken + 1_000;
  if (!positiveInteger(ceilingUsdNanos, Math.min(route.ceilingUsdNanos, BUDGET_USD_NANOS))) return null;
  return { wire, compressed, ceilingUsdNanos, tokens };
}

function tokenCount(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

async function readOutcome(response: Response, maxOutput: number, ceiling: number): Promise<ProviderOutcome> {
  const headers = ['x-ci-request-id', 'x-cheaper-inference-request-id']
    .map(name => response.headers.get(name)).filter(id => id !== null);
  const result = record(await response.json().catch(() => null));
  const id = result?.request_id ?? headers[0] ?? response.headers.get('x-request-id');
  const matchedId = typeof id === 'string' && requestIdPattern.test(id) && headers.every(value => value === id)
    ? 'cheaperinference:' + id : undefined;

  if (!response.ok) {
    const code = record(result?.error)?.code;
    // These documented errors are refused before dispatch. Ambiguous responses retain their reserves.
    if (typeof code === 'string' && noChargeErrors.get(response.status)?.includes(code)) {
      return { receipt: { state: 'rejected', code, evidenceRef: matchedId ?? 'cheaperinference:preflight:' + code } };
    }
    return { receipt: { state: 'unknown', code: 'cheaperinference_http_' + response.status, providerId: matchedId } };
  }
  const billing = record(result?.billing);
  const amount = typeof billing?.billed_cost_usd === 'string' ? /^(\d{1,5})\.(\d{6})$/.exec(billing.billed_cost_usd) : null;
  if (!matchedId || !amount || billing?.status !== 'settled' || billing.currency !== 'USD') {
    return { receipt: { state: 'unknown', code: 'cheaperinference_billing_unconfirmed', providerId: matchedId } };
  }
  const costUsdNanos = Number(amount[1]) * 1_000_000_000 + Number(amount[2]) * 1_000;
  const usage = record(result?.usage);
  const promptTokens = tokenCount(usage?.prompt_tokens);
  const completionTokens = tokenCount(usage?.completion_tokens);
  const model = typeof result?.model === 'string' ? result.model : undefined;
  const routeVerified = model === terraModel && !response.headers.has('x-ci-warning')
    && promptTokens !== undefined && promptTokens <= contextTokens
    && completionTokens !== undefined && completionTokens <= maxOutput && costUsdNanos <= ceiling;
  return {
    receipt: { state: 'paid', costUsdNanos, providerId: matchedId, evidenceRef: matchedId, model,
      provider: 'CheaperInference', routeVerified, promptTokens, completionTokens },
    ...(routeVerified && Array.isArray(result?.choices) ? { output: { choices: result.choices } } : {}),
  };
}

export function cheaperInferenceTransport(approval: Approval): ModelTransport {
  const { apiKey } = approval;
  if (!/^ci_live_[A-Za-z0-9_-]+$/.test(apiKey)) throw new GatewayError('cheaperinference_key_required');
  const profiles = new Map<string, { profile: CheaperInferenceProfile; fingerprint: string }>();
  const key = (id: string, revision: string) => JSON.stringify([id, revision]);
  for (const profile of structuredClone(approval.profiles)) {
    const id = key(profile.routeId, profile.revision);
    if (!validProfile(profile) || profiles.has(id)) throw new GatewayError('invalid_cheaperinference_profile');
    profiles.set(id, { profile, fingerprint: hash([endpoint, profile]) });
  }
  if (!profiles.size) throw new GatewayError('cheaperinference_profile_required');
  const selected = (route: RoutePolicy) => route.transport === 'cheaperinference' && profiles.get(key(route.id, route.revision));
  return {
    kind: 'cheaperinference',
    quote(route, request) {
      const configuration = selected(route);
      if (!configuration) return null;
      const body = prepare(configuration.profile, route, request);
      return body ? { ceilingUsdNanos: body.ceilingUsdNanos, pricingFingerprint: configuration.fingerprint } : null;
    },
    async authorize(tx, route, context) {
      const configuration = selected(route);
      const scope = configuration && syntheticScope(configuration.profile.syntheticScopes, context.projectId, context.scopeId);
      const job = record(context.payload);
      if (!scope || context.dataClass !== 'synthetic'
        || (job?.mode !== 'primary' && job?.mode !== 'verify') || job.branch !== 'A') return false;
      return verifySyntheticInputs(tx, context, scope);
    },
    async send(attempt, route, request, signal) {
      const configuration = selected(route);
      const body = configuration && prepare(configuration.profile, route, request);
      if (!configuration || !body || attempt.routeId !== route.id || attempt.revision !== route.revision
        || attempt.purpose === 'primary_b' || attempt.dataClass !== 'synthetic'
        || !syntheticScope(configuration.profile.syntheticScopes, attempt.projectId, attempt.scopeId)
        || attempt.pricingFingerprint !== configuration.fingerprint || attempt.ceilingUsdNanos !== body.ceilingUsdNanos) {
        return { receipt: { state: 'rejected', code: 'invalid_request', evidenceRef: 'gateway:no-network' } };
      }
      const response = await fetch(endpoint, {
        method: 'POST', redirect: 'error', signal,
        headers: { authorization: 'Bearer ' + apiKey, 'content-type': 'application/json',
          'x-ci-model-lock': '1', 'x-ci-techniques': 'off', ...(body.compressed && { 'content-encoding': 'gzip' }) },
        body: body.compressed ? new Uint8Array(body.compressed) : body.wire,
      });
      return readOutcome(response, body.tokens, body.ceilingUsdNanos);
    },
  };
}
