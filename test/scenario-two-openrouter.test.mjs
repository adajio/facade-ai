import assert from 'node:assert/strict';
import test from 'node:test';
import { preDispatchReviewRejection } from '../infra/local-terra/review-admission.mjs';
import { deepCallFailure, retryableDeepReason } from '../infra/local-terra/transport/deep-reading.mjs';
import { productionTerra } from '../infra/local-terra/transport/production.mjs';
import { openRouterTerraRequest, sendOpenRouterTerra } from '../infra/local-terra/transport/openrouter-terra.mjs';

const request = {
  model:'gpt-6.1-terra', messages:[{role:'system',content:'Use the tool'},{role:'user',content:'Synthetic data'}],
  tools:[{type:'function',function:{name:'submit_preliminary_review',parameters:{type:'object'}}}],tool_choice:'required',
};
const answer = {
  id:'gen-fixture',provider:'Azure',model:'openai/gpt-6.1-terra',usage:{prompt_tokens:60,completion_tokens:12,cost:0.00012},
  choices:[{finish_reason:'tool_calls',message:{role:'assistant',content:'',refusal:null,reasoning:'ignored',
    tool_calls:[{id:'tool_call',type:'function',function:{name:'submit_preliminary_review',arguments:'{}'},index:0}]}}],
};

test('production routes the same semantic model to Azure under OpenRouter ZDR without a Mac socket',async()=>{
  const transport=productionTerra({FACADE_TERRA_PRODUCTION_ADMISSION:'/fixture/admission.json',
    FACADE_TERRA_PRODUCTION_TRANSPORT:'openrouter',FACADE_TERRA_OPENROUTER_KEY:'fixture-key'},async(url,init)=>{
    assert.equal(url,'https://openrouter.ai/api/v1/chat/completions');
    assert.equal(init.redirect,'error');
    const body=JSON.parse(init.body);
    assert.equal(body.model,'openai/gpt-6.1-terra');
    assert.deepEqual(body.provider,{only:['azure'],allow_fallbacks:false,require_parameters:true,
      data_collection:'deny',zdr:true,max_price:{prompt:2,completion:7.5}});
    assert.deepEqual(body.reasoning,{effort:'high',exclude:true});
    assert.equal(body.tool_choice,'required');
    return Response.json(answer);
  });
  assert.equal(transport.revision,'openrouter-azure-terra-v1');
  const result=await transport.call(request);
  assert.equal(result.model,request.model);
  assert.equal(result.transport,'openrouter');
  assert.equal(result.upstreamProvider,'Azure');
  assert.equal(result.usage.cost,answer.usage.cost);
  assert.deepEqual(result.choices[0].message,{role:'assistant',content:null,
    tool_calls:[{id:'tool_call',type:'function',function:{name:'submit_preliminary_review',arguments:'{}'}}]});
});

test('addressed reading preserves the transcript and does not request the unsupported parallel-tool parameter',()=>{
  const messages=[...request.messages,{role:'assistant',content:null,tool_calls:[{
    id:'tool_call',type:'function',function:{name:'inventory',arguments:'{}'},
  }]},{role:'tool',tool_call_id:'tool_call',content:'Synthetic observation'}];
  const payload=openRouterTerraRequest({...request,messages,max_tokens:2048,parallel_tool_calls:false},'research');
  assert.deepEqual(payload.messages,messages);
  assert.equal(payload.max_completion_tokens,6144);
  assert.equal(payload.parallel_tool_calls,undefined);
});

test('network errors and missing provider identity are retained as uncertain without a second attempt',async()=>{
  let attempts=0;
  await assert.rejects(sendOpenRouterTerra('fixture-key',request,'review',async()=>{
    attempts++;
    throw Error('disconnect');
  }),{state:'unknown',message:'openrouter_terra_outcome_unknown'});
  assert.equal(attempts,1);
  await assert.rejects(sendOpenRouterTerra('fixture-key',request,'review',async()=>Response.json({...answer,provider:'OpenAI'})),
    {state:'unknown',message:'openrouter_terra_receipt_unconfirmed'});
  await assert.rejects(sendOpenRouterTerra('',request,'review',async()=>assert.fail('external call without a key')),
    {state:'rejected',message:'openrouter_terra_key_unavailable'});
});


test('a billing rejection leaves the exact attempt retryable and pauses new dispatches',async()=>{
  let fetches=0;
  const transport=productionTerra({FACADE_TERRA_PRODUCTION_ADMISSION:'/fixture/admission.json',
    FACADE_TERRA_PRODUCTION_TRANSPORT:'openrouter',FACADE_TERRA_OPENROUTER_KEY:'fixture-key'},async()=>{
    fetches++;
    return Response.json({error:{code:402}},{status:402});
  });
  for (const attempt of [1,2]) {
    await assert.rejects(transport.call(request),error=>{
      const failure=deepCallFailure(error);
      assert.deepEqual(failure,{state:'rejected',reason:'openrouter_terra_rejected_402'});
      assert.equal(preDispatchReviewRejection(failure),true);
      assert.equal(retryableDeepReason(failure.reason),true);
      assert.equal(fetches,1, `provider called again on attempt ${attempt}`);
      return true;
    });
  }
});
