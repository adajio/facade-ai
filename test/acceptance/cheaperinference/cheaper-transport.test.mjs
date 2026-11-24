import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtemp,readdir,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {test} from 'node:test';
import {createTransport,prepareRequest,parseReceipt} from './cheaper-transport.mjs';

const model='gpt-6.2-sol';
const projectId=randomUUID();
const original='a'.repeat(64);
const revision='ci-test';
const profile={id:'ci-a',wireModel:model,localModel:'managed/'+model,toolChoice:'required',maxTokens:4096,
  maxImages:0,supplier:'network_a',sourceSha256:original,ceilingUsdNanos:2_700_000_000};
const route={id:profile.id,revision};
const tools=[{type:'function',function:{name:'open_region',parameters:{type:'object'}}}];
const request={model:profile.localModel,stream:false,tool_choice:profile.toolChoice,parallel_tool_calls:false,
  max_tokens:profile.maxTokens,tools,messages:[{role:'user',content:'synthetic control'}]};
const providerId=randomUUID();
const result={model,request_id:providerId,billing:{status:'settled',currency:'USD',billed_cost_usd:'0.001234'},
  usage:{prompt_tokens:100,completion_tokens:50},choices:[{message:{role:'assistant',tool_calls:[]}}]};

test('request retains tool schemas and history, and rejects mismatched model or modality',()=>{
  const wire=JSON.parse(prepareRequest(profile,request));
  assert.equal(wire.model,model);
  assert.equal(wire.zdr,true);
  assert.deepEqual(wire.messages,request.messages);
  assert.deepEqual(wire.tools,tools);
  assert.equal(prepareRequest(profile,{...request,model:'managed/foreign'}),null);
  assert.equal(prepareRequest(profile,{...request,messages:[{role:'user',content:[{type:'image_url',
    image_url:{url:'https://unapproved.invalid/source.png'}}]}]}),null);
});

test('settled mismatch remains charged but quarantined and absent billing retains reserve',()=>{
  const parse=(overrides={})=>parseReceipt({result,headers:new Headers(),model,
    ceilingUsdNanos:profile.ceilingUsdNanos,evidenceRef:'offline',...overrides});
  assert.equal(parse().receipt.costUsdNanos,1_234_000);
  for (const data of [{result:{...result,model:model+'-fast'}},{ceilingUsdNanos:1},
    {headers:new Headers({'x-ci-warning':'changed parameter'})}]) {
    const outcome=parse(data);
    assert.equal(outcome.receipt.state,'paid');
    assert.equal(outcome.receipt.routeVerified,false);
    assert.equal(outcome.output,undefined);
  }
  assert.equal(parse({result:{...result,billing:null}}).receipt.state,'unknown');
});

test('frozen hashes and same-job evidence are required for authorization',async()=>{
  const traceDir=await mkdtemp(join(tmpdir(),'ci-private-'));
  try {
    const transport=await createTransport({routes:[profile],traceDir,projectId,revision,apiKey:'offline',
      allowedSha256s:[original],fetcher:async()=>assert.fail('unexpected network')});
    const id=randomUUID();
    const input={projectId,scopeId:null,dataClass:'synthetic',jobId:randomUUID(),inputRefs:[id,id]};
    let checked=false;
    const tx={query:async(sql,args)=>{
      checked=true;
      assert.match(sql,/m.original_sha256=ANY/);
      assert.deepEqual(args,[projectId,[original],input.jobId,[id],1]);
      return {rows:[{allowed:true}]};
    }};
    assert.equal(await transport.authorize(tx,route,{...input,projectId:randomUUID()}),false);
    assert.equal(checked,false);
    assert.equal(await transport.authorize(tx,route,input),true);
    assert.equal(checked,true);
  } finally {await rm(traceDir,{recursive:true,force:true});}
});

test('durable intent prevents a second HTTP call and hard-locks model',async()=>{
  const traceDir=await mkdtemp(join(tmpdir(),'ci-private-'));
  const attempt={id:randomUUID(),jobId:randomUUID(),requestHash:original,effectKey:'offline',
    dataClass:'synthetic',projectId,routeId:route.id,revision,ceilingUsdNanos:profile.ceilingUsdNanos};
  let posts=0;
  try {
    const transport=await createTransport({routes:[profile],traceDir,projectId,revision,apiKey:'offline',
      allowedSha256s:[original],networkEnabled:true,
      fetcher:async(url,options)=>{
        posts++;
        assert.equal(url,'https://api.cheaperinference.com/v1/chat/completions');
        assert.equal(options.redirect,'error');
        assert.equal(options.headers['x-ci-model-lock'],'1');
        assert.equal(options.headers['x-ci-techniques'],'off');
        assert.ok((await readdir(traceDir)).includes(attempt.id+'.intent.json'));
        return new Response(JSON.stringify(result),{headers:{'x-ci-request-id':providerId}});
      }});
    const send=()=>transport.send(attempt,route,request,new AbortController().signal);
    const accepted=await send();
    assert.equal(accepted.receipt.routeVerified,true);
    assert.deepEqual(accepted.output,result);
    assert.ok((await readdir(traceDir)).includes(attempt.id+'.completion.json'));
    assert.deepEqual(await transport.lookup(attempt), {
      receipt: accepted.receipt,
      output: { choices: result.choices },
    });
    assert.equal(await transport.lookup({ ...attempt, requestHash: 'b'.repeat(64) }), null);
    assert.equal(await transport.lookup({ ...attempt, ceilingUsdNanos: 1 }), null);
    assert.equal((await send()).receipt.code,'cheaper_duplicate_attempt');
    assert.equal(posts,1);
  } finally {await rm(traceDir,{recursive:true,force:true});}
});
