import { randomUUID, createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { callCodex } from './codex-client.mjs';

// Separate, single-reader subscription workflow. No USD ledger entries.
const root = process.env.FACADE_SOURCE_ROOT;
const script = process.env.FACADE_CODEX_ADAPTER;
if (!root || !script || !process.env.FACADE_DATA_DIR || !process.env.DATABASE_URL) throw Error('Set FACADE_SOURCE_ROOT, FACADE_CODEX_ADAPTER, FACADE_DATA_DIR, DATABASE_URL');
const load = path => import(pathToFileURL(`${root}/dist/${path}`).href);
const [{ readConfig }, { openPool }, { WorkQueue }, { transaction, hash }, { createIntakeStorage },
  { createFormatAdapters }, { createRuntimePdfService }, { startImports }, { preparePackageMap, authorizedPackageWindow },
  { connectReader }, { publication }, { executeResearch }, { lockIntakeProject }, { scanPackageStructure },
  { indexNextProjectMemory }, { reconcileNextFacadeDiscovery }] = await Promise.all([
  load('src/platform/config.js'), load('src/platform/db.js'), load('src/modules/gateway/queue.js'),
  load('src/modules/gateway/types.js'), load('src/modules/intake/blob.js'), load('src/modules/formats/index.js'),
  load('src/modules/pdf/index.js'), load('src/modules/imports/index.js'), load('src/modules/harness/package-dispatch.js'),
  load('src/modules/harness/reader.js'), load('src/modules/harness/publication.js'), load('src/modules/harness/runner.js'),
  load('src/modules/intake/gate.js'),
  load('src/modules/harness/package-walk.js'), load('src/modules/project-memory/index.js'),
  load('src/modules/harness/facade-discovery.js'),
]);

const { packagePreparationSweep, preparedPackageWindow, preparedManifestForWindow, preflightPackageWindow, packagePreparationInput, verifyCurrentPreparation } =
  await load('src/modules/harness/package-preparation.js');
const { readDirectedReadingPlans, currentDirectedWindow } = await load('src/modules/harness/directed-reading.js');
const config = readConfig();
const db = openPool(config.databaseUrl);
const queue = new WorkQueue(db);
const controller = new AbortController();
const { signal } = controller;
process.once('SIGINT', () => controller.abort());
process.once('SIGTERM', () => controller.abort());
const routeId = 'codex-subscription-terra';
const revision = 'codex-subscription-v1';
const localKind = 'local_terra_research';
const settings = { routeId, model:'gpt-6.1-terra', dataClass:'customer', maxTokens:2048, maxTurns:32, maxKnownRejections:1 };
const profile = { A:settings, B:null, lead:null };
const profileHash = hash([revision, settings]);
const sha = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const lock = await db.connect();
let storage;
try {
  const acquired = await lock.query("SELECT pg_try_advisory_lock(hashtextextended('facade/local-terra-subscription-worker',0)) AS ok");
  if (!acquired.rows[0].ok) throw Error('Another subscription worker is running');
  await db.query(`CREATE TABLE IF NOT EXISTS local_terra_calls (
    id uuid PRIMARY KEY, effect_key text NOT NULL UNIQUE, job_id uuid NOT NULL REFERENCES gateway_jobs(id),
    project_id uuid NOT NULL, request_hash text NOT NULL, model text NOT NULL,
    state text NOT NULL CHECK (state IN ('sending','completed','unknown')),
    response jsonb, created_at timestamptz NOT NULL DEFAULT clock_timestamp(), finished_at timestamptz,
    CHECK ((state='completed')=(response IS NOT NULL)))`);
  storage = createIntakeStorage(config.dataDir);
  const {withSharedReaderSlot}=await load('src/modules/harness/index.js');
  const service = withSharedReaderSlot(db,createRuntimePdfService(db, config, { storage, adapters:createFormatAdapters() }));
  const publish = publication(db, queue, profile);
  const reader = connectReader(db, service, publish.observation);
  const workGateway = Object.create(queue);
  workGateway.call = async input => {
    const hold = (code, id) => ({ status:'held', code, nextAction:'Проверить и разрешить сохранённую попытку локальной подписки.', ...(id ? {attemptId:id} : {}) });
    if (input.routeId !== routeId || input.dataClass !== 'customer' || input.request?.model !== settings.model) return hold('local_route_denied');
    const requestHash = sha(input.request);
    const id = randomUUID();
    // Never initiate a new external effect from an obsolete prepared package. Existing
    // effect keys retain their original response or uncertain outcome for reconciliation.
    const {rows:[pending]} = await db.query(`SELECT m.project_id AS "projectId",m.receipt_id AS "receiptId"
      FROM gateway_jobs j JOIN intake_package_preparations m
        ON m.project_id=j.project_id AND m.id::text=j.payload#>>'{packageWindow,preparationId}'
      WHERE j.id=$1 AND NOT EXISTS (SELECT 1 FROM local_terra_calls c WHERE c.effect_key=$2)`,
      [input.lease.jobId,input.effectKey]);
    const preparation = pending ? await transaction(db,tx=>packagePreparationInput(tx,pending,service)) : null;
    const decision = await transaction(db, async tx => {
      const found = await tx.query(`SELECT j.project_id,j.generation_id,j.payload,j.lease_epoch,j.worker_id,j.lease_until,j.state,
          g.current FROM gateway_jobs j JOIN gateway_generations g USING(generation_id)
        WHERE j.id=$1 FOR UPDATE OF j`, [input.lease.jobId]);
      const j = found.rows[0];
      if (!j || !j.current || j.state !== 'leased' || j.worker_id !== input.lease.workerId || j.lease_epoch !== input.lease.epoch ||
          new Date(j.lease_until) <= new Date() || j.payload?.mode !== 'primary' || j.payload.branch !== 'A' ||
          j.payload.settings?.routeId !== routeId || !j.payload.packageWindow || j.payload.packageWindow.routeRevision !== revision) return {denied:true};
      const enabled = await tx.query('SELECT 1 FROM projects WHERE id=$1 AND intake_mode', [j.project_id]);
      if (!enabled.rowCount) return {denied:true};
      const p = j.payload;
      const previous = await tx.query('SELECT * FROM local_terra_calls WHERE effect_key=$1', [input.effectKey]);
      if (previous.rowCount) return {previous:previous.rows[0]};
      if (!await authorizedPackageWindow(tx, { id:input.lease.jobId, projectId:j.project_id, generationId:j.generation_id,
        branch:'A', place:p.place, windowId:p.packageWindow.id, readerVersion:p.packageWindow.readerVersion })) return {denied:true};
      const refs = [...new Set(input.inputRefs)];
      if (refs.length) {
        const evidence = await tx.query(`SELECT id FROM reader_evidence WHERE project_id=$1 AND version_id=$2 AND reader_version=$3
          AND run_id=$4 AND branch='A' AND id::text=ANY($5::text[])`,
          [j.project_id,p.place.source.versionId,p.packageWindow.readerVersion,input.lease.jobId,refs]);
        if (evidence.rowCount !== refs.length) return {denied:true};
      }
      if (p.packageWindow.preparationId && (!preparation || !await verifyCurrentPreparation(
        tx,preparation,p.packageWindow.preparationId,p.packageWindow.id))) return {denied:true};
      const unsettled = await tx.query("SELECT id FROM local_terra_calls WHERE project_id=$1 AND state IN ('sending','unknown') LIMIT 1",[j.project_id]);
      if (unsettled.rowCount) return {unsettled:unsettled.rows[0].id};
      await tx.query(`INSERT INTO local_terra_calls(id,effect_key,job_id,project_id,request_hash,model,state)
        VALUES($1,$2,$3,$4,$5,$6,'sending')`, [id,input.effectKey,input.lease.jobId,j.project_id,requestHash,settings.model]);
      return {created:true};
    });
    if (decision.denied) return hold('local_assignment_denied');
    if (decision.unsettled) return hold('subscription_outcome_unknown',decision.unsettled);
    if (decision.previous) {
      const prev = decision.previous;
      if (prev.job_id !== input.lease.jobId || prev.request_hash !== requestHash) return hold('effect_conflict',prev.id);
      if (prev.state !== 'completed') return hold('subscription_outcome_unknown',prev.id);
      return {status:'subscription_completed',attemptId:prev.id,output:prev.response};
    }
    try {
      const output = await callCodex(input.request, {script,signal});
      await db.query("UPDATE local_terra_calls SET state='completed',response=$2,finished_at=clock_timestamp() WHERE id=$1 AND state='sending'",[id,JSON.stringify(output)]);
      return {status:'subscription_completed',attemptId:id,output};
    } catch {
      await db.query("UPDATE local_terra_calls SET state='unknown',finished_at=clock_timestamp() WHERE id=$1 AND state='sending'",[id]);
      return hold('subscription_outcome_unknown',id);
    }
  };
  async function schedule() {
    return transaction(db, async tx => {
      const plans=await readDirectedReadingPlans(tx,true,db);
      const { rows:[w] } = await tx.query(`SELECT w.id,w.project_id,w.version_id,w.place,m.reader_version,p.generation_id,directed."receiptId" AS "directedReceiptId"
        FROM harness_package_windows w JOIN harness_package_maps m ON m.version_id=w.version_id AND m.fingerprint=w.map_fingerprint AND m.active
        JOIN harness_package_projects p ON p.project_id=w.project_id JOIN projects project ON project.id=p.project_id
        JOIN jsonb_to_recordset($2::jsonb) AS directed("projectId" uuid,mode text,"receiptId" uuid,"windowIds" uuid[],"requirementsByWindow" jsonb) ON directed."projectId"=w.project_id AND w.id=ANY(directed."windowIds")
        JOIN gateway_generations g ON g.generation_id=p.generation_id AND g.current
        LEFT JOIN (SELECT project_id,max(created_at) AS latest FROM gateway_jobs WHERE kind=$1 GROUP BY project_id) turns
          ON turns.project_id=w.project_id
        WHERE project.intake_mode AND (m.refusal IS NULL OR m.refusal='physical_inventory_unverified') AND ${preparedPackageWindow}
        AND NOT EXISTS (SELECT 1 FROM local_terra_calls attempt WHERE attempt.project_id=w.project_id AND attempt.state='unknown')
        AND NOT EXISTS
          (SELECT 1 FROM harness_package_branches b WHERE b.window_id=w.id AND b.branch='A' AND b.active)
        AND EXISTS (SELECT 1 FROM intake_occurrences o WHERE o.project_id=w.project_id AND o.version_id=w.version_id AND o.state='accepted')
        AND NOT EXISTS (SELECT 1 FROM intake_document_versions v JOIN intake_occurrences o ON o.project_id=v.project_id
          AND o.version_id=v.id AND o.state='accepted' WHERE v.project_id=w.project_id AND v.replaces_version_id=w.version_id)
        AND NOT EXISTS (SELECT 1 FROM gateway_jobs active WHERE active.kind=$1 AND active.state IN ('ready','leased'))
        ORDER BY turns.latest NULLS FIRST,w.project_id,array_position(directed."windowIds",w.id),w.ordinal,w.version_id LIMIT 1 FOR UPDATE OF w SKIP LOCKED`,[localKind,JSON.stringify(plans)]);
      if (!w) return false;
      const inputs=await preflightPackageWindow(tx,service,w.project_id,w.id);
      await lockIntakeProject(tx,w.project_id);
      const selected=await currentDirectedWindow(tx,w.project_id,w.id,true,w.directedReceiptId);
      if (!selected.allowed) return false;
      const preparationId = await preparedManifestForWindow(tx,w.project_id,w.id,inputs.filter(item=>item.receiptId===w.directedReceiptId));
      if (!preparationId || preparationId !== selected.preparationId) return false;
      const ref = {projectId:w.project_id,scopeId:null,generationId:w.generation_id};
      const key = hash([w.id,profileHash]);
      await queue.declarePrimary(ref,{id:key+':A',branch:'A',place:key},tx);
      const payload = {mode:'primary',branch:'A',settings,place:w.place,observationProtocol:2,
        packageWindow:{id:w.id,directedRequirements:selected.requirements,readerVersion:w.reader_version,preparationId,routeRevision:revision,packageReadingVersion:2,walkProtocol:1,profileInspection:{lineIds:[]}}};
      const jobId = await queue.enqueue({...ref,key:'local-terra:'+key,kind:localKind,subjectId:w.version_id,
        obligationId:key+':A',purpose:'primary_a',payload},tx);
      await tx.query(`INSERT INTO harness_package_branches(window_id,branch,profile_hash,route_revision,settings,job_id)
        VALUES($1,'A',$2,$3,$4,$5)`,[w.id,profileHash,revision,JSON.stringify(settings),jobId]);
      return true;
    });
  }
  async function poll(name, next) {
    while (!signal.aborted) {
      try { if (await next()) continue; }
      catch (error) { console.error(`local-terra ${name} failed:`,error?.code ?? error?.message); }
      await delay(1000,undefined,{signal}).catch(()=>{});
    }
  }
  const workerId = randomUUID();
  console.info('local-terra: single reader A; independent reader B and review are pending; subscription cost per call unknown');
  await Promise.all([
    startImports({db,config,signal,logger:console},{storage}),
    poll('map',()=>preparePackageMap(db,queue,service,[])),
    poll('preparation',packagePreparationSweep(db,service)),
    poll('structure',()=>scanPackageStructure(db,service)),
    poll('index',()=>indexNextProjectMemory(db,service,signal)),
    poll('facade-discovery',()=>reconcileNextFacadeDiscovery(db)),
    poll('schedule',schedule),
    poll('research',async()=>{
      const work = await queue.claim({workerId,kinds:[localKind],leaseMs:30000});
      if (!work) return false;
      if (work.payload?.settings?.routeId !== routeId || work.scopeId !== null || work.payload?.branch !== 'A') {
        await queue.suspend(work.lease,{reason:'local_route_denied',nextAction:'Использовать назначенный штатный worker.'}); return true;
      }
      const structure = await db.query('SELECT 1 FROM harness_package_structures WHERE window_id=$1',[work.payload.packageWindow.id]);
      if (!structure.rowCount) {
        await queue.suspend(work.lease,{reason:'package_structure_pending',nextAction:'Дождаться структурного чтения окна.',retryAt:new Date(Date.now()+3000)});
        return true;
      }
      await executeResearch(work,{db,gateway:workGateway,reader,configured:slot=>profile[slot],
        publishOutcome:publish.outcome,loadPriorOutcome:publish.loadPriorOutcome,unsettledPrior:publish.unsettledPrior},signal);
      return true;
    }),
  ]);
} finally {
  controller.abort();
  storage?.objects.close();
  lock.release();
  await db.end();
}
