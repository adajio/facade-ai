import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const url = process.env.TERRA_LOCAL_TIMEOUT_TEST_DATABASE_URL;
const hash = bytes => createHash('sha256').update(bytes).digest('hex');

test('the local subscription queues an independent window after a timeout without replaying the uncertain turn', {
  skip: !url, timeout: 70_000,
}, async t => {
  assert.equal(new URL(url).hostname, '127.0.0.1');
  assert.equal(new URL(url).pathname, '/test_facade_terra_local_timeout');
  const sourceRoot = fileURLToPath(new URL('../', import.meta.url));
  const [{ WorkQueue }, { preparePackageMap }, { refreshReceiptPreparation }, { readDirectedReadingPlan },
    { createIntakeStorage }, { createRuntimePdfService }, { transaction }, { indexNextProjectMemory }] = await Promise.all([
    import('../dist/src/modules/gateway/queue.js'), import('../dist/src/modules/harness/package-dispatch.js'),
    import('../dist/src/modules/harness/package-preparation.js'), import('../dist/src/modules/harness/directed-reading.js'),
    import('../dist/src/modules/intake/blob.js'), import('../dist/src/modules/pdf/index.js'), import('../dist/src/modules/gateway/types.js'),
    import('../dist/src/modules/project-memory/index.js'),
  ]);
  const root = await mkdtemp('/tmp/facade-local-timeout-');
  const db = new pg.Pool({ connectionString:url });
  const queue = new WorkQueue(db);
  const objects = new Map();
  const s3 = createServer(async (request, response) => {
    const key = decodeURIComponent(new URL(request.url, 'http://127.0.0.1').pathname.slice('/fixtures/'.length));
    if (request.method === 'PUT') {
      objects.set(key, Buffer.concat(await Array.fromAsync(request)));
      return response.writeHead(200, { etag:'"fixture"' }).end();
    }
    const content = objects.get(key);
    if (!content) return response.writeHead(404).end();
    response.writeHead(200, { 'content-length':content.length, 'x-amz-meta-sha256':hash(content) });
    return response.end(request.method === 'HEAD' ? undefined : content);
  }).listen(0, '127.0.0.1');
  await once(s3, 'listening');

  const trace = join(root, 'calls.jsonl');
  const adapter = join(root, 'adapter.py');
  await writeFile(adapter, `import json, os, signal, sys, uuid
from pathlib import Path

request = json.load(sys.stdin)
messages = request["messages"]
version = json.loads(messages[1]["content"])["place"]["source"]["versionId"]
trace = Path(os.environ["TEST_TERRA_TRACE"])
origin = trace.read_text().splitlines() if trace.exists() else []
turn = len([call for message in messages if message["role"] == "assistant" for call in message.get("tool_calls", [])])
with trace.open("a") as file:
    file.write(json.dumps({"version": version, "turn": turn}) + "\\n")
args = {}
if turn == 0:
    name = "inspect_structure"
elif turn == 1:
    name = "survey"
elif turn == 2:
    name = "extract"
elif turn == 3:
    reply = [json.loads(message["content"]) for message in messages if message["role"] == "tool"][-1]
    line = next(line for line in json.loads(reply["content"])["lines"] if "Ведомость облицовки" in line["text"])
    name = "save_observation"
    args = {"evidenceId": reply["evidence"]["evidenceId"], "lineId": line["id"], "quote": line["text"],
            "package": {"attribute": "Ведомость облицовки"}}
elif turn == 4 and json.loads(origin[0])["version"] == version:
    signal.alarm(1)
    signal.pause()
elif turn == 4:
    name = "finish_reading"
    args = {"status": "covered", "explanation": "Ведомость подтверждена по адресной строке."}
else:
    raise RuntimeError("unexpected extra turn")
print(json.dumps({"model": "gpt-6.1-terra", "id": str(uuid.uuid4()), "choices": [
    {"finish_reason": "tool_calls", "message": {"role": "assistant", "content": None, "tool_calls": [
        {"id": str(uuid.uuid4()), "type": "function", "function": {"name": name, "arguments": json.dumps(args)}}
    ]}}
]}))
`);
  const storageEnv = {
    FACADE_S3_ENDPOINT:`http://127.0.0.1:${s3.address().port}`, FACADE_S3_BUCKET:'fixtures',
    AWS_ACCESS_KEY_ID:'fixture', AWS_SECRET_ACCESS_KEY:'fixture', AWS_EC2_METADATA_DISABLED:'true',
    AWS_REQUEST_CHECKSUM_CALCULATION:'WHEN_REQUIRED', FACADE_INTAKE_DISK_GUARD_BYTES:'0',
  };
  Object.assign(process.env, storageEnv);
  const env = {
    PATH:process.env.PATH, HOME:process.env.HOME, DATABASE_URL:url, NODE_ENV:'test', FACADE_DATA_DIR:root,
    FACADE_SOURCE_ROOT:sourceRoot, FACADE_CODEX_ADAPTER:adapter, TEST_TERRA_TRACE:trace, ...storageEnv,
  };
  const storage = createIntakeStorage(root);
  const reader = createRuntimePdfService(db, { dataDir:root }, { storage });
  let child, log = '';
  const startWorker = () => {
    child = spawn(process.execPath, [join(sourceRoot,'infra/local-terra/transport/worker.mjs')], { env });
    child.stdout.on('data', chunk => { log += chunk; });
    child.stderr.on('data', chunk => { log += chunk; });
  };
  const stopWorker = async () => {
    if (!child || child.exitCode !== null) return;
    const exited = once(child,'exit');
    child.kill('SIGTERM');
    await exited;
  };
  t.after(async () => {
    await stopWorker();
    storage.objects.close();
    await db.end();
    s3.closeAllConnections();
    await new Promise(resolve => s3.close(resolve));
    await rm(root, { recursive:true, force:true });
  });

  assert.equal((await db.query('SELECT count(*)::int AS count FROM projects')).rows[0].count, 0);
  const [org, user, catalog, projectId, receiptId] = Array.from({length:5}, randomUUID);
  const stage = 'Стадия 1';
  const requirements = [{ key:'R1', part:'Ведомость облицовки', completenessCriterion:'Листы облицовки', aliases:'cladding' }];
  await db.query("INSERT INTO organizations(id,name) VALUES($1,'Fixture')", [org]);
  await db.query('INSERT INTO users(id,organization_id,login) VALUES($1,$2,$3)', [user, org, user]);
  await db.query("INSERT INTO catalog_versions(id,organization_id,catalog_key,revision,name,requirements,created_by) VALUES($1,$2,'fixture',1,'fixture',$3,$4)",
    [catalog, org, JSON.stringify(requirements), user]);
  await db.query("INSERT INTO projects(id,organization_id,name,catalog_version_id,project_stage,intake_mode) VALUES($1,$2,'Fixture',$3,$4,true)",
    [projectId, org, catalog, stage]);
  await db.query("INSERT INTO intake_receipts(id,project_id,source,created_by,sealed_at) VALUES($1,$2,'upload',$3,clock_timestamp())",
    [receiptId, projectId, user]);
  const fixture = await readFile(new URL('../fixtures/recognition/facade-materials.pdf', import.meta.url));
  const inventory = [];
  for (const suffix of ['a', 'b', 'c']) {
    const [original, document, versionId] = Array.from({length:3}, randomUUID);
    const name = `cladding-${suffix}.pdf`;
    const key = projectId + '/' + name;
    const bytes = Buffer.concat([fixture,Buffer.from(`\n% fixture ${suffix}\n`)]);
    const digest = hash(bytes);
    objects.set(key, bytes);
    inventory.push({ versionId, originalSha256:digest });
    await db.query('INSERT INTO intake_originals(id,project_id,object_key,size,sha256) VALUES($1,$2,$3,$4,$5)',
      [original, projectId, key, bytes.length, digest]);
    await db.query('INSERT INTO intake_documents(id,project_id) VALUES($1,$2)', [document, projectId]);
    await db.query("INSERT INTO intake_document_versions(id,project_id,document_id,original_id,media_type) VALUES($1,$2,$3,$4,'application/pdf')",
      [versionId, projectId, document, original]);
    await db.query("INSERT INTO intake_occurrences(project_id,receipt_id,relative_path,declared_media_type,version_id,state) VALUES($1,$2,$3,'application/pdf',$4,'accepted')",
      [projectId, receiptId, name, versionId]);
    await db.query('INSERT INTO intake_reader_jobs(project_id,receipt_id,document_id,version_id,original_id) VALUES($1,$2,$3,$4,$5)',
      [projectId, receiptId, document, versionId, original]);
    assert.equal(await preparePackageMap(db, queue, reader, []), true);
  }
  const prepared = await transaction(db, tx => refreshReceiptPreparation(tx, { projectId, receiptId }, reader));
  assert.equal(prepared.state, 'ready', JSON.stringify(prepared.reasons));
  await db.query(`INSERT INTO preliminary_package_reviews(project_id,receipt_id,catalog_version_id,model,stage,input_generation,inventory,
    scope_note,rows,draft_text,content_hash,preparation_id) VALUES($1,$2,$3,'gpt-6.1-terra',$4,
    coalesce((SELECT generation FROM intake_project_generations WHERE project_id=$1),0),
    $5,'Опись синтетическая',$6,'Черновик',$7,$8)`,
  [projectId, receiptId, catalog, stage, JSON.stringify(inventory.sort((a,b) => a.versionId.localeCompare(b.versionId))),
    JSON.stringify([{ key:'R1', status:'unassessed', sources:[] }]), hash(prepared.manifestId), prepared.manifestId]);
  const signal = new AbortController().signal;
  for (let n = 0; await indexNextProjectMemory(db, reader, signal); n++) assert.ok(n < 20);
  const plan = await transaction(db, tx => readDirectedReadingPlan(tx, projectId));
  assert.equal(plan.windowIds.length, 2, JSON.stringify(plan));

  async function until(next, description, timeout = 9_000) {
    const end = Date.now() + timeout;
    do {
      assert.equal(child.exitCode, null, log);
      const state = await next();
      if (state) return state;
      await delay(200);
    } while (Date.now() < end);
    assert.fail(description + '\n' + log);
  }
  async function jobs() {
    const { rows } = await db.query(`SELECT id,subject_id AS version,state,reason,result FROM gateway_jobs
      WHERE kind='local_terra_research' AND project_id=$1 ORDER BY created_at,id`, [projectId]);
    return rows;
  }

  startWorker();
  const interrupted = await until(async () => (await jobs()).find(job => job.state === 'held'), 'first window must record the timeout', 25_000);
  assert.equal(interrupted.reason,'subscription_outcome_unknown');
  const completed = await until(async () => (await jobs()).find(job => job.state === 'done'), 'independent window must complete after the timeout');
  assert.equal(completed.result.kind, 'covered');
  assert.notEqual(completed.version, interrupted.version);

  await stopWorker();
  startWorker();
  // Exercise a retry of the interrupted assignment itself. It may read its
  // durable journal, but its uncertain turn must never reach the adapter again.
  assert.equal(await queue.resume(interrupted.id, ['subscription_outcome_unknown']), true);
  await until(async () => (await jobs()).find(job => job.id === interrupted.id && job.state === 'held'), 'unknown turn must stay held on replay');
  await delay(1_500);

  assert.equal((await jobs()).length, 2, 'the two-window budget includes the interrupted assignment');
  const calls = (await readFile(trace,'utf8')).trim().split('\n').map(line => JSON.parse(line));
  assert.deepEqual(calls, [interrupted.version, completed.version].flatMap(version =>
    [0,1,2,3,4].map(turn => ({ version, turn }))));
  const { rows:[ledger] } = await db.query(`SELECT count(*) FILTER (WHERE state='unknown')::int AS unknown,
    count(*) FILTER (WHERE state='completed' AND response IS NOT NULL)::int AS completed FROM local_terra_calls`);
  assert.deepEqual(ledger, { unknown:1, completed:9 });
  const { rows:facts } = await db.query(`SELECT job_id, count(*)::int AS count FROM harness_package_facts
    WHERE job_id=ANY($1::uuid[]) GROUP BY job_id`, [[interrupted.id, completed.id]]);
  assert.equal(facts.length, 2);
  assert.ok(facts.every(fact => fact.count === 1));
  t.diagnostic('One outcome stayed unknown; the second window finished, and both saved one source-backed observation.');
});
