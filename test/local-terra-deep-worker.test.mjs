import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { PNG } from 'pngjs';
import { deepCallFailure, retryableDeepReason } from '../infra/local-terra/transport/deep-reading.mjs';
import { ModelTransportError } from '../infra/local-terra/request-budget.mjs';

const url = process.env.TERRA_DEEP_TEST_DATABASE_URL;
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
test('only a known pre-dispatch transport rejection permits an exact deep retry', () => {
  const busy = deepCallFailure(new ModelTransportError('rejected','mac_terra_busy'));
  assert.deepEqual(busy,{state:'rejected',reason:'mac_terra_busy'});
  assert.equal(retryableDeepReason(busy.reason),true);
  const unknown = deepCallFailure(new ModelTransportError('unknown','mac_terra_outcome_unknown'));
  assert.deepEqual(unknown,{state:'unknown',reason:'subscription_outcome_unknown'});
  assert.equal(retryableDeepReason(unknown.reason),false);
  assert.equal(retryableDeepReason('invalid_model_arguments'),false);
});

test('production worker opens the real PDF, keeps immutable source pins and stops the new receipt', {
  skip: !url, timeout: 120_000,
}, async t => {
  assert.equal(new URL(url).hostname,'127.0.0.1');
  assert.equal(new URL(url).pathname,'/test_facade_terra_deep_works');
  const sourceRoot = fileURLToPath(new URL('../',import.meta.url));
  const [{ WorkQueue }, { preparePackageMap }, { refreshReceiptPreparation }, { scanPackageStructure },
    { createIntakeStorage }, { createRuntimePdfService }, { transaction }, { indexNextProjectMemory }] = await Promise.all([
    import('../dist/src/modules/gateway/queue.js'),import('../dist/src/modules/harness/package-dispatch.js'),
    import('../dist/src/modules/harness/package-preparation.js'),import('../dist/src/modules/harness/package-walk.js'),
    import('../dist/src/modules/intake/blob.js'),import('../dist/src/modules/pdf/index.js'),import('../dist/src/modules/gateway/types.js'),
    import('../dist/src/modules/project-memory/index.js'),
  ]);
  const root = await mkdtemp('/tmp/facade-deep-worker-');
  const db = new pg.Pool({connectionString:url});
  const bytes = await readFile(new URL('../fixtures/recognition/facade-materials.pdf',import.meta.url));
  const digest = hash(bytes);
  const objects = new Map();
  const s3 = createServer(async (inbound,response) => {
    const key = decodeURIComponent(new URL(inbound.url,'http://127.0.0.1').pathname.slice('/fixtures/'.length));
    if (inbound.method === 'PUT') {
      const content = Buffer.concat(await Array.fromAsync(inbound));
      objects.set(key,content);
      return response.writeHead(200,{etag:'"fixture"'}).end();
    }
    const content = objects.get(key);
    if (!content) return response.writeHead(404).end();
    response.writeHead(200,{'content-length':content.length,'x-amz-meta-sha256':hash(content)});
    return response.end(inbound.method === 'HEAD' ? undefined : content);
  }).listen(0,'127.0.0.1');
  await once(s3,'listening');
  const seen = [];
  let historicalProject, freshProject, sentImage = false, transportError, loseResponse = false;
  const mac = createServer(async (inbound,response) => {
    try {
      if (inbound.url === '/health/research') return response.end(JSON.stringify({ready:true}));
      assert.equal(inbound.url,'/v1/research');
      const request = JSON.parse(Buffer.concat(await Array.fromAsync(inbound)));
      const assigned = JSON.parse(request.messages[1].content);
      assert.equal(assigned.place.source.projectId,freshProject);
      assert.notEqual(assigned.place.source.projectId,historicalProject);
      assert.equal(assigned.place.source.sha256,digest);
      const serialized = JSON.stringify(request);
      seen.push(serialized);
      if (loseResponse) return inbound.socket.destroy();
      if (seen.length === 1) return response.writeHead(409,{'x-facade-terra-error':'busy'}).end();
      const calls = request.messages.filter(m=>m.role==='assistant').flatMap(m=>m.tool_calls);
      const replies = request.messages.filter(m=>m.role==='tool').map(m=>JSON.parse(m.content));
      let name, args = {};
      switch(calls.length) {
        case 0: name='inspect_structure'; break;
        case 1: name='survey'; break;
        case 2: {
          assert.deepEqual(replies[0].directedFocus.map(goal=>goal.key),['R1']);
          const inputs = request.messages.flatMap(m=>Array.isArray(m.content)?m.content:[]);
          const picture = inputs.find(part=>part.type==='image_url');
          assert.ok(picture && picture.image_url.url.startsWith('data:image/png;base64,'));
          const png = PNG.sync.read(Buffer.from(picture.image_url.url.split(',')[1],'base64'));
          assert.ok(png.width > 20 && png.height > 20 && new Set(png.data).size > 4);
          sentImage=true;
          name='extract'; break;
        }
        case 3: {
          const line = JSON.parse(replies[2].content).lines.find(item=>item.text.includes('Ведомость облицовки'));
          assert.ok(line);
          name='save_observation';
          args={evidenceId:replies[2].evidence.evidenceId,lineId:line.id,quote:line.text,
            package:{attribute:'Ведомость облицовки'}};
          break;
        }
        case 4: name='finish_reading'; args={status:'covered',explanation:'Найдена адресная строка ведомости.'}; break;
        default: assert.fail('Unexpected extra dispatch');
      }
      response.end(JSON.stringify({id:randomUUID(),model:'gpt-6.1-terra',local_effort:'high',choices:[
        {finish_reason:'tool_calls',message:{role:'assistant',content:null,
          tool_calls:[{id:randomUUID(),type:'function',function:{name,arguments:JSON.stringify(args)}}]}},
      ]}));
    } catch (error) {
      transportError = error;
      response.writeHead(500).end();
    }
  });
  const socket = join(root,'mac.sock');
  mac.listen(socket);
  await once(mac,'listening');
  const env = {
    PATH:process.env.PATH,HOME:process.env.HOME,DATABASE_URL:url,NODE_ENV:'test',FACADE_DATA_DIR:root,
    FACADE_SOURCE_ROOT:sourceRoot,FACADE_PRELIMINARY_BASE:root,
    FACADE_TERRA_PRODUCTION_SOCKET:socket,FACADE_TERRA_PRODUCTION_ADMISSION:join(root,'admission.json'),
    FACADE_S3_ENDPOINT:`http://127.0.0.1:${s3.address().port}`,FACADE_S3_BUCKET:'fixtures',
    AWS_ACCESS_KEY_ID:'fixture',AWS_SECRET_ACCESS_KEY:'fixture',AWS_EC2_METADATA_DISABLED:'true',
    AWS_REQUEST_CHECKSUM_CALCULATION:'WHEN_REQUIRED',FACADE_INTAKE_DISK_GUARD_BYTES:'0',
  };
  Object.assign(process.env,{
    FACADE_S3_ENDPOINT:env.FACADE_S3_ENDPOINT,FACADE_S3_BUCKET:env.FACADE_S3_BUCKET,
    AWS_ACCESS_KEY_ID:env.AWS_ACCESS_KEY_ID,AWS_SECRET_ACCESS_KEY:env.AWS_SECRET_ACCESS_KEY,
    AWS_EC2_METADATA_DISABLED:env.AWS_EC2_METADATA_DISABLED,FACADE_INTAKE_DISK_GUARD_BYTES:'0',
    AWS_REQUEST_CHECKSUM_CALCULATION:env.AWS_REQUEST_CHECKSUM_CALCULATION,
  });
  const storage = createIntakeStorage(root);
  const reader = createRuntimePdfService(db,{dataDir:root},{storage});
  let child, log = '';
  function startWorker() {
    child = spawn(process.execPath,[join(sourceRoot,'infra/local-terra/transport/worker.mjs')],{env});
    child.stdout.on('data',chunk=>{log+=chunk;});
    child.stderr.on('data',chunk=>{log+=chunk;});
  }
  async function stopWorker() {
    if (child.exitCode !== null) return;
    const exited = once(child,'exit');
    child.kill('SIGTERM');
    await exited;
  }
  startWorker();
  t.after(async () => {
    await stopWorker();
    storage.objects.close();
    await db.end();
    for (const server of [s3,mac]) {server.closeAllConnections(); await new Promise(resolve=>server.close(resolve));}
    await rm(root,{recursive:true,force:true});
  });
  async function until(next,description,ms=55_000) {
    const end=Date.now()+ms;
    do {
      if (transportError) throw transportError;
      assert.equal(child.exitCode,null,log);
      const state=await next();
      if (state) return state;
      await delay(200);
    } while (Date.now()<end);
    assert.fail(description+'\n'+log);
  }
  const cutoff = await until(()=>readFile(join(root,'state','production-research-activation'),'utf8').catch(()=>null),'activation');
  assert.match(cutoff,/\d{6}Z/u);
  assert.equal((await db.query('SELECT count(*)::int AS count FROM projects')).rows[0].count,0);
  const [org,user,catalog]=Array.from({length:3},randomUUID);
  const stage = 'Стадия 1';
  const requirements = [{key:'R1',part:'Ведомость облицовки',completenessCriterion:'Листы облицовки'}];
  await db.query("INSERT INTO organizations(id,name) VALUES($1,'Fixture')",[org]);
  await db.query("INSERT INTO users(id,organization_id,login) VALUES($1,$2,$3)",[user,org,user]);
  await db.query("INSERT INTO catalog_versions(id,organization_id,catalog_key,revision,name,requirements,created_by) VALUES($1,$2,'fixture',1,'fixture',$3,$4)",
    [catalog,org,JSON.stringify(requirements),user]);
  async function prepare(historical) {
    const [projectId,receiptId,original,document,versionId]=Array.from({length:5},randomUUID);
    if (historical) historicalProject=projectId;
    else freshProject=projectId;
    await db.query("INSERT INTO projects(id,organization_id,name,catalog_version_id,project_stage,intake_mode) VALUES($1,$2,'Fixture',$3,$4,true)",[projectId,org,catalog,stage]);
    await db.query(`INSERT INTO intake_receipts(id,project_id,source,created_by,created_at,sealed_at)
      VALUES($1,$2,'upload',$3,coalesce($4,clock_timestamp()),now())`,[receiptId,projectId,user,historical?'2000-01-01':null]);
    const key = projectId+'/fixture.pdf';
    objects.set(key,bytes);
    await db.query("INSERT INTO intake_originals(id,project_id,object_key,size,sha256) VALUES($1,$2,$3,$4,$5)",[original,projectId,key,bytes.length,digest]);
    await db.query('INSERT INTO intake_documents(id,project_id) VALUES($1,$2)',[document,projectId]);
    await db.query("INSERT INTO intake_document_versions(id,project_id,document_id,original_id,media_type) VALUES($1,$2,$3,$4,'application/pdf')",[versionId,projectId,document,original]);
    await db.query("INSERT INTO intake_occurrences(project_id,receipt_id,relative_path,declared_media_type,version_id,state) VALUES($1,$2,'fixture.pdf','application/pdf',$3,'accepted')",[projectId,receiptId,versionId]);
    await db.query('INSERT INTO intake_reader_jobs(project_id,receipt_id,document_id,version_id,original_id) VALUES($1,$2,$3,$4,$5)',[projectId,receiptId,document,versionId,original]);
    assert.equal(await preparePackageMap(db,new WorkQueue(db),reader,[]),true);
    const target={projectId,receiptId};
    const prepared=await transaction(db,tx=>refreshReceiptPreparation(tx,target,reader));
    assert.equal(prepared.state,'ready',JSON.stringify(prepared.reasons));
    const {manifestId}=prepared;
    await db.query(`INSERT INTO preliminary_package_reviews(project_id,receipt_id,catalog_version_id,model,stage,input_generation,inventory,scope_note,rows,draft_text,content_hash,preparation_id)
      VALUES($1,$2,$3,'gpt-6.1-terra',$4,coalesce((SELECT generation FROM intake_project_generations WHERE project_id=$1),0),
      $5,'Опись синтетическая',$6,'Черновик',$7,$8)`,[projectId,receiptId,catalog,stage,JSON.stringify([{versionId,originalSha256:digest}]),
      JSON.stringify([{key:'R1',status:'unassessed',sources:[]}]),hash(manifestId),manifestId]);
    return {...target,manifestId,versionId};
  }
  const old = await prepare(true);
  const fresh = await prepare(false);
  const receiptStart = Date.now();
  const job = await until(async()=> (await db.query(`SELECT id,payload FROM gateway_jobs
    WHERE kind='local_terra_production_research' AND project_id=$1`,[fresh.projectId])).rows[0],'new receipt assignment');
  assert.equal(job.payload.packageWindow.preparationId,fresh.manifestId);
  assert.equal(job.payload.settings.maxTurns,8);
  assert.equal(await scanPackageStructure(db,reader),true);
  const done = await until(async()=> (await db.query("SELECT result FROM gateway_jobs WHERE id=$1 AND state='done'",[job.id])).rows[0],'addressed partial outcome');
  assert.equal(done.result.kind,'covered');
  assert.equal(sentImage,true);
  assert.equal(seen[0],seen[1]);
  assert.equal(seen.length,6);
  t.diagnostic(`Synthetic scheduled deep reading reached saved PDF evidence in ${Date.now()-receiptStart} ms.`);
  const {rows:[observation]} = await db.query(`SELECT o.payload FROM reader_observations o JOIN harness_package_facts f ON f.id=o.id
    WHERE o.project_id=$1 AND o.run_id=$2 AND o.version_id=$3`,[fresh.projectId,job.id,fresh.versionId]);
  assert.equal(observation.payload.source.sha256,digest);
  assert.match(observation.payload.quote,/Ведомость облицовки/u);
  await delay(36_000);
  assert.equal((await db.query(`SELECT 1 FROM project_reading_activity
    WHERE project_id=$1 AND stage='deep_reading' AND status='partial'`,[fresh.projectId])).rowCount,0,
  'an opened window does not replace an unsettled index');
  let indexJobs=0;
  while(await indexNextProjectMemory(db,reader,new AbortController().signal)) {
    assert.ok(++indexJobs<=20,'bounded fixture index');
  }
  const terminal = await until(async()=> (await db.query(`SELECT status,reason,fields FROM project_reading_activity
    WHERE project_id=$1 AND receipt_id=$2 AND preparation_id=$3 AND stage='deep_reading' AND status='partial'`,
  [fresh.projectId,fresh.receiptId,fresh.manifestId])).rows[0],'receipt terminal');
  assert.equal(terminal.reason,'no_new_targets');
  assert.equal(terminal.fields.started,1);
  assert.equal(terminal.fields.openRequirements,1);
  assert.equal((await db.query("SELECT count(*)::int AS count FROM gateway_jobs WHERE kind='local_terra_production_research' AND project_id=$1",[old.projectId])).rows[0].count,0);
  assert.equal((await db.query('SELECT count(*)::int AS count FROM local_terra_calls WHERE job_id=$1',[job.id])).rows[0].count,5);
  assert.equal(seen.length,6);
  loseResponse = true;
  const interrupted = await prepare(false);
  await until(()=>scanPackageStructure(db,reader),'interrupted receipt structure');
  const lost = await until(async()=> (await db.query(`SELECT a.state,j.reason FROM local_terra_calls a JOIN gateway_jobs j ON j.id=a.job_id
    WHERE a.project_id=$1 AND j.state='held'`,[interrupted.projectId])).rows[0],'unknown reply');
  assert.deepEqual(lost,{state:'unknown',reason:'subscription_outcome_unknown'});
  assert.equal(seen.length,7);
  await stopWorker();
  startWorker();
  await delay(4_000);
  assert.equal(child.exitCode,null,log);
  assert.equal(await readFile(join(root,'state','production-research-activation'),'utf8'),cutoff);
  assert.equal(seen.length,7);
});
