import { ModelTransportError } from '../request-budget.mjs';

export const openRouterTerraModel = 'openai/gpt-6.1-terra';
export const openRouterTerraRoute = 'openrouter-azure-terra';
export const openRouterTerraRevision = 'openrouter-azure-terra-v1';
const snapshot = 'openai/gpt-6.1-terra-20261026';
const endpoint = 'https://openrouter.ai/api/v1/chat/completions';
const maximumResponseBytes = 8 * 1024 * 1024;

async function readAnswer(response) {
  const chunks = [];
  let size = 0;
  if (!response.body) throw Error('missing_response_body');
  for await (const chunk of response.body) {
    size += chunk.length;
    if (size > maximumResponseBytes) throw Error('response_too_large');
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

function validUsage(usage) {
  if (!usage || typeof usage !== 'object') return undefined;
  return Object.fromEntries(Object.entries(usage).filter(([name,value]) =>
    (['prompt_tokens','completion_tokens','total_tokens'].includes(name) && Number.isSafeInteger(value) && value >= 0) ||
    (name === 'cost' && Number.isFinite(value) && value >= 0)));
}

export function openRouterTerraRequest(request, kind) {
  return {
    model:openRouterTerraModel,
    messages:request.messages,
    tools:request.tools,
    tool_choice:request.tool_choice,
    stream:false,
    // OpenRouter counts reasoning inside this limit. Leave room for the visible tool output.
    max_completion_tokens:kind === 'research' ? request.max_tokens + 4096 : 32768,
    reasoning:{effort:'high',exclude:true},
    provider:{
      only:['azure'],allow_fallbacks:false,require_parameters:true,data_collection:'deny',zdr:true,
      max_price:{prompt:2,completion:7.5},
    },
  };
}

export async function sendOpenRouterTerra(apiKey, request, kind, fetchCall = fetch) {
  if (!apiKey) throw new ModelTransportError('rejected','openrouter_terra_key_unavailable');
  let answer;
  try {
    const response = await fetchCall(endpoint,{
      method:'POST',redirect:'error',signal:AbortSignal.timeout(140000),
      headers:{authorization:'Bearer '+apiKey,'content-type':'application/json','X-OpenRouter-Title':'Facade AI Scenario 2'},
      body:JSON.stringify(openRouterTerraRequest(request,kind)),
    });
    if (!response.ok) {
      await response.body?.cancel();
      if ([400,401,402,403,404,422].includes(response.status))
        throw new ModelTransportError('rejected','openrouter_terra_rejected_'+response.status);
      throw Error('provider_outcome_unknown');
    }
    answer = await readAnswer(response);
  } catch (error) {
    if (error instanceof ModelTransportError) throw error;
    throw new ModelTransportError('unknown','openrouter_terra_outcome_unknown');
  }
  const [choice] = Array.isArray(answer?.choices) ? answer.choices : [];
  const message = choice?.message;
  if (typeof answer?.id !== 'string' || !answer.id || answer.provider !== 'Azure' ||
      ![openRouterTerraModel,snapshot].includes(answer.model) || answer.choices?.length !== 1 ||
      message?.role !== 'assistant' || message.refusal) {
    throw new ModelTransportError('unknown','openrouter_terra_receipt_unconfirmed');
  }
  const usage = validUsage(answer.usage);
  const calls = message.tool_calls;
  const normalized = calls?.length === 1 ? {
    role:'assistant',content:null,tool_calls:[{
      id:calls[0]?.id,type:calls[0]?.type,
      function:{name:calls[0]?.function?.name,arguments:calls[0]?.function?.arguments},
    }],
  } : {role:'assistant',content:message.content,...(calls !== undefined && {tool_calls:calls})};
  const finishReason = choice.finish_reason;
  if ((finishReason === 'tool_calls' && (!Array.isArray(normalized.tool_calls) || normalized.tool_calls.length !== 1)) ||
      !['stop','tool_calls'].includes(finishReason)) {
    throw new ModelTransportError('rejected','openrouter_terra_incomplete_response');
  }
  return {id:answer.id,model:request.model,local_effort:'high',transport:'openrouter',upstreamModel:answer.model,
    upstreamProvider:answer.provider,...(usage && {usage}),choices:[{finish_reason:finishReason,message:normalized}]};
}
