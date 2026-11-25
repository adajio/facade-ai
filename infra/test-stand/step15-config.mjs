import { readFileSync } from 'node:fs';
import { parseEnv } from 'node:util';

const env = parseEnv(readFileSync(process.argv[2], 'utf8'));
const namespaces = {
  openrouter: ['FACADE_GATEWAY_OPENROUTER_KEY', 'FACADE_GATEWAY_STEP15_PROFILES'],
  cheaperinference: ['FACADE_GATEWAY_CHEAPERINFERENCE_KEY', 'FACADE_GATEWAY_CHEAPERINFERENCE_PROFILES'],
  featherless: ['FACADE_GATEWAY_FEATHERLESS_KEY', 'FACADE_GATEWAY_FEATHERLESS_PROFILES'],
};
const permitted = [...Object.values(namespaces).flat(), 'FACADE_HARNESS_PROFILE',
  'FACADE_GATEWAY_OPENROUTER_ENDPOINT', 'FACADE_HARNESS_LIVE_POLICY'];
if (Object.keys(env).some(key => !permitted.includes(key))) throw new Error('Invalid step 15 configuration keys');

function readJson(key) {
  try { return JSON.parse(env[key]); } catch { throw new Error('Invalid step 15 profile JSON'); }
}

const providers = Object.entries(namespaces).filter(([, [key, profiles]]) => {
  const routes = env[profiles]?.trim() ? readJson(profiles) : [];
  if (!Array.isArray(routes) || Boolean(routes.length) !== Boolean(env[key]?.trim())) {
    throw new Error('A step 15 transport needs its own key and route profiles');
  }
  return routes.length > 0;
}).map(([provider]) => provider);
if (!providers.length) throw new Error('At least one step 15 transport is required');
if (providers.includes('cheaperinference') && !/^ci_live_[A-Za-z0-9_-]+$/.test(env.FACADE_GATEWAY_CHEAPERINFERENCE_KEY)
  || env.FACADE_GATEWAY_OPENROUTER_KEY?.trim().startsWith('ci_live_')) {
  throw new Error('Invalid step 15 credential namespace');
}
if (env.FACADE_HARNESS_PROFILE !== undefined) {
  const profile = readJson('FACADE_HARNESS_PROFILE');
  if (!profile || typeof profile !== 'object' || Array.isArray(profile)) throw new Error('Invalid step 15 harness profile');
}
const endpoint = env.FACADE_GATEWAY_OPENROUTER_ENDPOINT ?? 'https://openrouter.ai';
if (!['https://openrouter.ai', 'https://eu.openrouter.ai', 'https://us.openrouter.ai'].includes(endpoint)) {
  throw new Error('OpenRouter endpoint is outside the allowlist');
}
const policy = env.FACADE_HARNESS_LIVE_POLICY ?? 'strict-zdr';
if (!['strict-zdr', 'synthetic-research'].includes(policy)) throw new Error('Invalid step 15 harness policy');
console.log(providers.join('+') === 'openrouter+cheaperinference' ? 'mixed' : providers.join('+'));
