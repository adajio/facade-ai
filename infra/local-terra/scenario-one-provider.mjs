import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';

export const classificationModel = 'gemini-3.5-flash-lite';
export const extractionModel = 'gemini-3.8-flash';
export const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const endpoint = 'https://api.cheaperinference.com/v1/chat/completions';

export async function cheaperInferenceScenario(env = process.env, fetchCall = fetch) {
  if (env.FACADE_SCENARIO_ONE_ENABLED !== '1') return null;
  const apiKey = env.FACADE_SCENARIO_ONE_KEY_FILE
    ? (await readFile(env.FACADE_SCENARIO_ONE_KEY_FILE, 'utf8')).trim()
    : env.CHEAPER_INFERENCE_API_KEY?.trim();
  if (!apiKey) return null;
  return async ({ model, instruction, content, requestId = randomUUID() }) => {
    const result = await fetchCall(endpoint, {
      method:'POST', redirect:'error', signal:AbortSignal.timeout(120000),
      headers:{ authorization:'Bearer ' + apiKey, 'content-type':'application/json', 'x-client-request-id':requestId },
      body:JSON.stringify({model,zdr:true,stream:false,max_tokens:4096,
        response_format:{type:'json_object'},
        messages:[{role:'system',content:instruction},{role:'user',content}]}),
    });
    if (!result.ok) {
      await result.body?.cancel();
      if ([400,401,402,403,404,422].includes(result.status)) return null;
      throw Error('scenario_one_provider_outcome_unknown');
    }
    const wire = await result.text();
    if (wire.length > 262144) throw Error('scenario_one_response_too_large');
    const response = JSON.parse(wire);
    const answer = response.choices?.[0];
    if (response.model && response.model.replace(/^google\//u,'') !== model)
      throw Error('scenario_one_provider_model_mismatch');
    if (response.choices?.length !== 1 || answer?.finish_reason !== 'stop' || typeof answer.message?.content !== 'string') return null;
    try { return JSON.parse(answer.message.content); }
    catch { return null; }
  };
}
