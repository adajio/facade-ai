import { readFileSync } from 'node:fs';
import { parseEnv } from 'node:util';

const env = parseEnv(readFileSync(process.argv[2], 'utf8'));
const profiles = ['FACADE_GATEWAY_STEP15_PROFILES', 'FACADE_HARNESS_PROFILE'];
const required = ['FACADE_GATEWAY_OPENROUTER_KEY', ...profiles];
const permitted = [...required, 'FACADE_GATEWAY_OPENROUTER_ENDPOINT', 'FACADE_HARNESS_LIVE_POLICY'];
if (Object.keys(env).some(key => !permitted.includes(key)) || required.some(key => !env[key]?.trim())) {
  throw new Error('Invalid step 15 configuration keys');
}
for (const key of profiles) {
  try { JSON.parse(env[key]); } catch { throw new Error('Invalid step 15 profile JSON'); }
}
const endpoint = env.FACADE_GATEWAY_OPENROUTER_ENDPOINT ?? 'https://openrouter.ai';
if (!['https://openrouter.ai', 'https://eu.openrouter.ai', 'https://us.openrouter.ai'].includes(endpoint)) {
  throw new Error('OpenRouter endpoint is outside the allowlist');
}
const policy = env.FACADE_HARNESS_LIVE_POLICY ?? 'strict-zdr';
if (!['strict-zdr', 'synthetic-research'].includes(policy)) throw new Error('Invalid step 15 harness policy');
