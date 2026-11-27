import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { request as httpRequest } from 'node:http';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createMacTerraBridge } from '../infra/local-terra/transport/mac-bridge.mjs';
import { productionTerra } from '../infra/local-terra/transport/production.mjs';

const cutoffTime = '2026-11-26T11:55:00.123456Z';
const validRequest = {
  model:'gpt-6.1-terra',tool_choice:'required',
  messages:[{role:'system',content:'Synthetic transport fixture.'},{role:'user',content:'Synthetic value 100 mm.'}],
  tools:[{type:'function',function:{name:'submit_preliminary_review'}}],
};
const answer = effort => ({body:Buffer.from(JSON.stringify({model:'gpt-6.1-terra',local_effort:effort,choices:[]}))});
const code = (state,message) => error => error.state === state && error.message === message;

async function nativeWalk(toolChoice = 'required') {
  const native = await import('../dist/src/modules/harness/openrouter.js');
  const job = {mode:'primary',branch:'A',place:{source:{projectId:randomUUID(),versionId:randomUUID(),
    documentId:randomUUID(),sha256:'a'.repeat(64)},unitId:'1',page:1},
  settings:{routeId:'codex-subscription-terra',model:'gpt-6.1-terra',dataClass:'customer',maxTokens:2048,
    maxTurns:32,maxKnownRejections:1,toolChoice},observationProtocol:2,
  packageWindow:{id:randomUUID(),readerVersion:'fixture',routeRevision:'fixture',walkProtocol:1,packageReadingVersion:2}};
  const messages = native.initialMessages(job);
  return {...native,job,messages,next:()=>native.request(job,messages)};
}

function completion(message,finish_reason = 'tool_calls') {
  return {body:Buffer.from(JSON.stringify({id:randomUUID(),model:'gpt-6.1-terra',local_effort:'high',choices:[{message,finish_reason}]}))};
}

function postMac(socket,path,value) {
  const body = Buffer.from(JSON.stringify(value));
  return new Promise((resolve,reject)=>{
    const req = httpRequest({socketPath:socket,method:'POST',path,agent:false,
      headers:{'content-type':'application/json','content-length':body.length}},res=>{
      res.resume();
      res.on('end',()=>resolve({status:res.statusCode,error:res.headers['x-facade-terra-error']}));
      res.on('error',reject);
    });
    req.on('error',reject);
    req.end(body);
  });
}

async function fixture(t, run = async () => answer('high')) {
  const root = await mkdtemp(join('/tmp','fttera-'));
  t.after(()=>rm(root,{recursive:true,force:true}));
  const socket = join(root,'mac.sock'), limitFile = join(root,'limit.json'), admission = join(root,'admission.json');
  const pauseFile = join(root,'mac-paused');
  const armId = randomUUID();
  const setup = {pauseFile,limitFile,ledgerDir:root,run};
  const bridge = createMacTerraBridge(setup);
  bridge.listen(socket);
  await once(bridge,'listening');
  const close = server => new Promise(resolve=>server.close(resolve));
  t.after(()=>close(bridge));
  const stateDir = join(root,'state');
  await mkdir(stateDir);
  const config = {FACADE_TERRA_PRODUCTION_SOCKET:socket,FACADE_TERRA_PRODUCTION_ADMISSION:admission};
  const snapshot = {projectId:randomUUID(),receiptId:randomUUID(),preparationId:randomUUID()};
  const allow = () => writeFile(admission,JSON.stringify([snapshot]),{mode:0o600});
  const arm = (maxCalls = 1) => writeFile(limitFile,JSON.stringify({id:armId,maxCalls}),{mode:0o600});
  const pause = () => writeFile(pauseFile,'',{mode:0o600});
  const resume = () => rm(pauseFile,{force:true});
  const transport = productionTerra(config);
  await transport.activate({query:async()=>({rows:[{time:cutoffTime}]})},stateDir);
  return {root,setup,socket,admission,arm,pause,resume,allow,snapshot,transport,stateDir,config,bridge,close,
    ledger:join(root,'limit-'+armId+'.jsonl')};
}

test('a historical receipt needs exact approval, no old provider effect, and a ready Mac before reservation', async t=>{
  const {pause,resume,allow,snapshot,transport,stateDir} = await fixture(t);
  const native = {query:async (sql,params)=>{
    assert.match(sql,/reserved.*prepared.*sending.*unknown/);
    assert.match(sql,/a\.created_at>=r\.created_at/);
    assert.deepEqual(params,[snapshot.projectId,snapshot.receiptId,cutoffTime]);
    return {rows:[{held:false,automatic:false}]};
  }};
  assert.equal(productionTerra({}),null);
  assert.throws(()=>productionTerra({FACADE_TERRA_PRODUCTION_SOCKET:'/tmp/model.sock'}),/invalid_production_terra_config/);
  assert.equal(await transport.hold({query:async()=>({rows:[{held:false,automatic:false}]})},snapshot),'held_terra_production_admission');
  assert.deepEqual(await transport.receipts([{id:snapshot.receiptId}],stateDir),[]);
  await allow();
  assert.deepEqual(await transport.receipts([{id:snapshot.receiptId}],stateDir),[{id:snapshot.receiptId}]);
  assert.equal(await transport.hold(native,{...snapshot,preparationId:randomUUID()}),'held_terra_production_admission');
  await pause();
  assert.equal(await transport.hold(native,snapshot),'held_terra_mac_unavailable');
  await resume();
  assert.equal(await transport.hold({query:async()=>({rows:[{held:true}]})},snapshot),'held_terra_prior_provider_attempt');
  assert.equal(await transport.hold(native,snapshot),null);
});

test('closing a receipt grant continues saved response recovery without new provider dispatch', async t=>{
  const {transport,stateDir,snapshot} = await fixture(t);
  const unrelated = randomUUID(), addressed = randomUUID();
  await writeFile(join(stateDir,snapshot.receiptId+'-'+'a'.repeat(64)+'.json'),'{}');
  await mkdir(join(stateDir,'addressed',addressed),{recursive:true});
  const rows = [snapshot.receiptId,unrelated,addressed].map(id=>({id}));
  assert.deepEqual(await transport.receipts(rows,stateDir),[rows[0],rows[2]]);
  assert.equal(await transport.hold({query:async()=>({rows:[{held:false,automatic:false}]})},snapshot),'held_terra_production_admission');
});

test('private socket drains one in-flight call, blocks concurrent calls, and preserves its call limit across restart', async t=>{
  let finish;
  const released = new Promise(resolve=>{finish=resolve;});
  let started;
  const reached = new Promise(resolve=>{started=resolve;});
  let observed = 0;
  const runtime = await fixture(t,async body=>{
    observed++;
    assert.deepEqual(JSON.parse(body),validRequest);
    started();
    await released;
    return answer('high');
  });
  const {arm,pause,resume,transport,setup,ledger,socket,bridge,close} = runtime;
  await pause();
  await assert.rejects(transport.call(validRequest),code('rejected','mac_terra_paused'));
  await arm();
  await resume();
  const inFlight = transport.call(validRequest);
  await reached;
  try {
    await pause();
    await assert.rejects(transport.call(validRequest),code('rejected','mac_terra_busy'));
  } finally { finish(); }
  assert.equal((await inFlight).local_effort,'high');
  assert.equal(observed,1);
  const [record] = (await readFile(ledger,'utf8')).trim().split('\n').map(JSON.parse);
  assert.match(record.requestSha256,/^[0-9a-f]{64}$/);
  assert.doesNotMatch(JSON.stringify(record),/Synthetic/);
  await close(bridge);
  await arm();
  await resume();
  const restarted = createMacTerraBridge(setup);
  restarted.listen(socket);
  t.after(()=>close(restarted));
  await once(restarted,'listening');
  await assert.rejects(transport.call(validRequest),code('rejected','mac_terra_budget_exhausted'));
  assert.equal(observed,1);
});

test('an unavailable socket is known before dispatch; failure after delivery remains unknown', async t=>{
  let calls = 0;
  const {root,config,arm,transport} = await fixture(t,async()=>{calls++;throw Error('synthetic disconnect');});
  const unavailable = productionTerra({...config,FACADE_TERRA_PRODUCTION_SOCKET:join(root,'absent.sock')});
  await assert.rejects(unavailable.call(validRequest),code('rejected','mac_terra_not_started'));
  await arm(2);
  await assert.rejects(transport.call({...validRequest,model:'another-provider'}),code('rejected','invalid_mac_terra_request'));
  assert.equal(calls,0);
  await assert.rejects(transport.call(validRequest),code('unknown','mac_terra_outcome_unknown'));
  assert.equal(calls,1);
});

test('the VPS adapter requires the high profile recorded by the single Mac adapter', async t=>{
  const {arm,transport} = await fixture(t,async()=>answer('medium'));
  await arm();
  await assert.rejects(transport.call(validRequest),code('unknown','mac_terra_profile_unconfirmed'));
});

test('the Mac entry point uses one local adapter in high even if a caller sets another effort', async t=>{
  const root = await mkdtemp(join('/tmp','fttera-cli-'));
  const limitFile = join(root,'limit.json'), socket = join(root,'mac.sock'), script = join(root,'synthetic.py');
  const admission = join(root,'admission.json');
  const cli = fileURLToPath(new URL('../infra/local-terra/transport/mac-bridge.mjs',import.meta.url));
  await writeFile(limitFile,JSON.stringify({id:randomUUID(),maxCalls:1}),{mode:0o600});
  await writeFile(script,`import json, os, sys
r=json.load(sys.stdin)
print(json.dumps(dict(model=r['model'],local_effort=os.environ['FACADE_TERRA_REASONING_EFFORT'])))
`,{mode:0o600});
  const mac = spawn(process.execPath,[cli],{env:{...process.env,
    FACADE_TERRA_MAC_SOCKET:socket,FACADE_TERRA_MAC_PAUSE:join(root,'paused'),FACADE_TERRA_MAC_LIMIT:limitFile,FACADE_TERRA_MAC_LEDGER:root,
    FACADE_TERRA_MAC_ADAPTER:script,FACADE_TERRA_REASONING_EFFORT:'medium',
  },stdio:['ignore','pipe','pipe']});
  const exit = once(mac,'exit');
  t.after(async()=>{
    mac.kill('SIGTERM');
    await exit;
    await rm(root,{recursive:true,force:true});
  });
  await Promise.race([once(mac.stdout,'data'),exit.then(()=>assert.fail('Mac bridge did not start'))]);
  const transport = productionTerra({FACADE_TERRA_PRODUCTION_SOCKET:socket,FACADE_TERRA_PRODUCTION_ADMISSION:admission});
  assert.deepEqual(await transport.call(validRequest),{model:'gpt-6.1-terra',local_effort:'high'});
  await assert.rejects(transport.call(validRequest),code('rejected','mac_terra_budget_exhausted'));
});

test('production bridge carries the real structured producer request and accepts the verified result', async t=>{
  const { makeRequest, parseModelResponse, validate } = await import('../infra/local-terra/producer.mjs');
  const literal = 'Фасад А. Кирпич 60 мм.';
  const source = {id:'L1',text:literal,versionId:randomUUID(),originalSha256:'a'.repeat(64),anchor:'synthetic-sheet'};
  const snapshot = {reviewContract:2,factScopeVersion:1,requirements:[{key:'material',part:'Облицовка'}],
    lines:[source],promptData:{scope:'synthetic only'},inventory:[source]};
  const cite = {id:source.id,quote:literal};
  const row = {key:'material',status:'present',finding:'Кирпич',citations:[cite],analysis:{
    applicability:{kind:'included',reason:'Требование применимо.',citations:[cite]},
    properties:[{key:'material',label:'Материал',status:'confirmed',finding:'Кирпич 60 мм.',citations:[cite],
      scope:{kind:'applicable',target:{element:'кирпич'},observed:{element:'кирпич'},
        reason:'Прямая запись из листа.',citations:[cite]},letter:{kind:'omit',text:'Сведения найдены.'}}],
    tensions:[],
  }};
  const runtime = await fixture(t,async body=>{
    const request = JSON.parse(body);
    assert.match(request.messages[0].content,/scope\.target/);
    const name = request.tools[0].function.name;
    return {body:Buffer.from(JSON.stringify({model:request.model,local_effort:'high',choices:[{
      finish_reason:'tool_calls',message:{tool_calls:[{type:'function',function:{name,arguments:JSON.stringify({rows:[row]})}}]},
    }]}))};
  });
  const raw = await runtime.transport.call(makeRequest(snapshot));
  const input = validate(snapshot,parseModelResponse(raw));
  assert.equal(input.rows[0].analysis.properties[0].scope.sources[0].anchor,source.anchor);
  assert.match(input.rows[0].finding,/Кирпич 60 мм/);
});

test('the native multi-turn request carries original scope, tool history, a verbatim quote and its PNG', async t=>{
  const native = await nativeWalk('auto');
  const quote = 'Ось Б. Облицовка 60 мм, зона Ф-1.';
  const evidenceId = randomUUID(), lineId = randomUUID();
  const data = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/nfoAAAAASUVORK5CYII=';
  const sha256 = native.hashBytes(Buffer.from(data,'base64'));
  const turn = (name,args) => ({role:'assistant',content:null,tool_calls:[{id:randomUUID(),type:'function',
    function:{name,arguments:JSON.stringify(args)}}]});
  const actions = [turn('extract',{}),turn('save_observation',{evidenceId,lineId,quote}),
    {role:'assistant',content:'Сведения о зоне Ф-1 сохранены.'}];
  let count = 0;
  const {transport,arm,ledger} = await fixture(t,async body=>{
    assert.deepEqual(JSON.parse(body),native.next());
    const action = actions[count++];
    return completion(action,action.tool_calls ? 'tool_calls' : 'stop');
  });
  await arm(actions.length);
  const call = async () => native.decodeCompletion(await transport.call(native.next())).message;
  const first = await call();
  native.messages.push(first,native.toolMessage(first.tool_calls[0],{body:{evidenceId,scope:native.job.place,
    lines:[{id:lineId,text:quote}]}}),...native.imageMessage({evidence:{evidenceId,sha256},image:{mediaType:'image/png',data}}));
  const second = await call();
  native.messages.push(second,native.toolMessage(second.tool_calls[0],{body:{saved:true,evidenceId,lineId}}));
  assert.deepEqual(JSON.parse(second.tool_calls[0].function.arguments),{evidenceId,lineId,quote});
  assert.deepEqual(await call(),actions[2]);
  assert.equal(count,3);
  const entries = (await readFile(ledger,'utf8')).trim().split('\n').map(JSON.parse);
  assert.equal(entries.length,3);
  entries.forEach(entry=>assert.deepEqual(Object.keys(entry).sort(),['at','requestSha256']));
});

test('both endpoints enforce the native request boundary before counting or executing a dispatch', async t=>{
  const {next} = await nativeWalk();
  const {transport,socket,arm,ledger} = await fixture(t,async()=>assert.fail('denied input reached adapter'));
  await arm();
  const wrongReply = {role:'tool',tool_call_id:'unmatched',content:'{}'};
  const set = [
    {...next(),model:'qwen'},
    {...next(),parallel_tool_calls:true},
    {...next(),stream:true},
    {...next(),reasoning_effort:'medium'},
    {...next(),tools:next().tools.slice(0,-1)},
    {...next(),tools:[...next().tools.slice(0,-1),next().tools[0]]},
    {...next(),tools:[...next().tools.slice(0,-1),{type:'web_search'}]},
    {...next(),tools:[...next().tools.slice(0,-1),{type:'function',function:{name:'shell',description:'shell',parameters:{}}}]},
    {...next(),messages:[...next().messages,wrongReply]},
    {...next(),messages:[...next().messages,{role:'assistant',content:null,tool_calls:[{id:'call',type:'function',
      function:{name:'extract',arguments:'{}'}}]},wrongReply]},
    {...next(),messages:[...next().messages,{role:'tool',tool_call_id:'call',content:[{type:'image_url',image_url:{url:'file:///tmp/source.png'}}]}]},
    {...next(),messages:[...next().messages,{role:'user',content:[{type:'image_url',image_url:{url:'https://fixture.invalid/source.png'}}]}]},
    {...next(),messages:[...next().messages,{role:'user',content:[{type:'image_url',image_url:{url:'data:image/png;base64,YWJj'}}]}]},
  ];
  for (const value of set) {
    await assert.rejects(transport.call(value),code('rejected','invalid_mac_terra_request'));
    assert.deepEqual(await postMac(socket,'/v1/research',value),{status:400,error:'request'});
  }
  assert.deepEqual(await postMac(socket,'/v1/review',next()),{status:400,error:'request'});
  assert.deepEqual(await postMac(socket,'/v1/research',validRequest),{status:400,error:'request'});
  await assert.rejects(readFile(ledger),{code:'ENOENT'});
});

test('research shares the same Mac slot and rejects unexpected model output as an unknown effect', async t=>{
  const {next} = await nativeWalk();
  let finish, started;
  const released = new Promise(resolve=>{finish=resolve;});
  const reached = new Promise(resolve=>{started=resolve;});
  const {stateDir,snapshot,transport,arm} = await fixture(t,async()=>{
    started();
    await released;
    return completion({role:'assistant',content:'unpermitted plain answer'},'stop');
  });
  await transport.activate({query:async()=>({rows:[{time:cutoffTime}]})},stateDir,{research:true});
  await arm(2);
  const inFlight = assert.rejects(transport.call(next()),code('unknown','mac_terra_outcome_unknown'));
  await reached;
  try {
    const tx = {query:async()=>({rows:[{held:false,automatic:true}]})};
    assert.equal(await transport.hold(tx,snapshot,{research:true}),'held_terra_mac_busy');
    await assert.rejects(transport.call(validRequest),code('rejected','mac_terra_busy'));
    await assert.rejects(transport.call(next()),code('rejected','mac_terra_busy'));
  } finally { finish(); }
  await inFlight;
});

test('deep admission has its own lasting cutoff and does not inherit old review grants', async t=>{
  const {root,config,transport,stateDir,snapshot,allow} = await fixture(t);
  const researchTime = '2026-11-26T12:15:00.654321Z';
  await allow();
  await transport.activate({query:async()=>({rows:[{time:researchTime}]})},stateDir,{research:true});
  const restart = productionTerra(config);
  assert.equal(await restart.activate({query:assert.fail},stateDir,{research:true}),researchTime);
  assert.deepEqual(await restart.admissions({research:true}),{activatedAt:researchTime,grants:[]});
  const tx = {query:async(sql,params)=>{
    assert.deepEqual(params,[snapshot.projectId,snapshot.receiptId,researchTime]);
    assert.match(sql,/sealed_at IS NOT NULL AND created_at > \$3::timestamptz/);
    return {rows:[{held:false,automatic:false}]};
  }};
  assert.equal(await restart.hold(tx,snapshot,{research:true}),'held_terra_production_admission');
  await writeFile(join(root,'paused'),'');
  assert.equal(await restart.admissions({research:true}),null);
  assert.equal(await restart.hold({query:assert.fail},snapshot,{research:true}),'held_terra_production_paused');
});

test('the launchd relay reconnects after SSH exits without opening public ports', async t=>{
  const runtime = await fixture(t);
  const relay = fileURLToPath(new URL('../infra/local-terra/production/mac-relay',import.meta.url));
  const profile = new URL('../infra/local-terra/production/deploy-profile',import.meta.url);
  const stub = join(runtime.root,'ssh'), calls = join(runtime.root,'calls'), staged = join(runtime.root,'relay');
  const fixtureKey = join(runtime.root,'fixture-key');
  await writeFile(fixtureKey,'fixture',{mode:0o600});
  await writeFile(join(runtime.root,'deploy-profile'),await readFile(profile));
  await writeFile(stub,`#!/bin/bash
set -eu
if [[ $* == *' -R '* ]]; then
  IFS= read -r pulse
  test "$pulse" = terra-relay
  printf 'reverse: %s\\n' "$*" >> "$FACADE_RELAY_TEST_CALLS"
  exit 255
fi
cat >/dev/null
printf 'prepare\\n' >> "$FACADE_RELAY_TEST_CALLS"
`,{mode:0o700});
  const testRelay = (await readFile(relay,'utf8')).replace('/usr/bin/ssh',stub)
    .replace('/tmp/facade-terra-$(id -u)',runtime.root).replace('model.sock','mac.sock')
    .replace('sleep 10','sleep 0.01').replace('sleep 5','sleep 0.01');
  await writeFile(staged,testRelay,{mode:0o700});
  const child = spawn('/bin/bash',[staged,'tunnel',runtime.root,runtime.root,process.execPath],{
    env:{...process.env,FACADE_RELAY_TEST_CALLS:calls,FACADE_TERRA_DEPLOY_HOST:'fixture.example',
      FACADE_TERRA_DEPLOY_HOSTNAME:'fixture-node',FACADE_TERRA_DEPLOY_APP_DIR:'/srv/fixture/app',
      FACADE_TERRA_DEPLOY_USER:'fixture-user',FACADE_TERRA_DEPLOY_KEY:fixtureKey},
    detached:true,stdio:'ignore',
  });
  const exit = once(child,'exit');
  t.after(async()=>{
    if (child.exitCode===null && child.signalCode===null) process.kill(-child.pid,'SIGTERM');
    await exit;
  });
  let logged = '';
  for (let i=0; i<60; i++) {
    logged = await readFile(calls,'utf8').catch(()=> '');
    if ((logged.match(/^reverse:/gm) ?? []).length>=2) break;
    await new Promise(resolve=>setTimeout(resolve,20));
  }
  assert.ok((logged.match(/^reverse:/gm) ?? []).length>=2,logged);
  assert.match(logged,/StrictHostKeyChecking=yes/);
  assert.match(logged,/GlobalKnownHostsFile=\/dev\/null/);
  assert.match(logged,/ExitOnForwardFailure=yes/);
  assert.match(logged,/ -R \/srv\/fixture\/app\/terra\/transport\/model\.sock:\/tmp\//);
  assert.match(logged,/fixture-user@fixture\.example bash -c /);
  assert.match(logged,/terra-attach fixture-node \/srv\/fixture\/app\/terra\/transport\/model\.sock/);
  assert.ok(logged.includes(' -i '+fixtureKey+' '),logged);
  for (const line of logged.split('\n').filter(line=>line.startsWith('reverse:')))
    assert.doesNotMatch(line.split(' fixture-user@')[0],/ -[LD] /);
  assert.match(logged,/read -r -t 35 pulse/);
});

test('automatic admission resumes after restart with the first exact PostgreSQL cutoff and no Mac limit file', async t=>{
  const { root,config,transport,stateDir,snapshot } = await fixture(t);
  const historical = {id:randomUUID(),createdAt:'2026-11-26T11:55:00.123455Z'};
  const exactly = {id:randomUUID(),createdAt:cutoffTime};
  const fresh = {id:randomUUID(),createdAt:'2026-11-26T11:55:00.123457Z'};
  const rows = [historical,exactly,fresh];
  assert.equal((await readFile(join(stateDir,'production-activation'),'utf8')).trim(),cutoffTime);
  assert.deepEqual(await transport.receipts(rows,stateDir),[fresh]);
  const restart = productionTerra(config);
  assert.equal(await restart.activate({query:assert.fail},stateDir),cutoffTime);
  assert.deepEqual(await restart.receipts(rows,stateDir),[fresh]);
  const tx = {query:async(sql,params)=>{
    assert.match(sql,/sealed_at IS NOT NULL AND created_at > \$3::timestamptz/);
    assert.equal(params[2],cutoffTime);
    return {rows:[{held:false,automatic:params[1]===fresh.id}]};
  }};
  assert.equal(await restart.hold(tx,{...snapshot,receiptId:historical.id}),'held_terra_production_admission');
  assert.equal(await restart.hold(tx,{...snapshot,receiptId:fresh.id}),null);
  const restored = {query:async (sql,params)=>{
    assert.match(sql,/restored\.project_id=\$1 AND restored\.receipt_id=\$2/);
    assert.deepEqual(params.slice(0,2),[snapshot.projectId,fresh.id]);
    return {rows:[{automatic:true,held:false,restored:true}]};
  }};
  assert.equal(await restart.hold(restored,{...snapshot,receiptId:fresh.id}),'held_terra_saved_review');
  await restart.activate({query:async()=>({rows:[{time:cutoffTime}]})},stateDir,{research:true});
  assert.equal(await restart.hold(restored,{...snapshot,receiptId:fresh.id},{research:true}),'held_terra_saved_review');

  await writeFile(join(root,'paused'),'');
  assert.deepEqual(await restart.receipts(rows,stateDir),[]);
  assert.equal(await restart.hold({query:assert.fail},{...snapshot,receiptId:fresh.id}),'held_terra_production_paused');
  await rm(join(root,'paused'));
  assert.deepEqual(await restart.receipts(rows,stateDir),[fresh]);
  assert.equal((await restart.call(validRequest)).local_effort,'high');
});
