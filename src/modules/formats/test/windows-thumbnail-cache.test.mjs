import assert from "node:assert/strict";
import {createHash, randomUUID} from "node:crypto";
import {mkdtemp, readFile, readdir, rm, writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join, resolve} from "node:path";
import {Readable} from "node:stream";
import {test} from "node:test";
import {pathToFileURL} from "node:url";

import { thumbnailCacheFixture as cache } from "./fixtures/windows-thumbnail-cache.mjs";

const root=process.env.FACADE_STEP11_DIST??resolve("dist");
const load=file=>import(pathToFileURL(join(root,"src/modules",file)).href);
const [{createFormatAdapters,resolveFormat},{isWindowsThumbnailCache,windowsThumbnailCache}]=await Promise.all([
  load("formats/index.js"),load("formats/windows-thumbnail-cache.js"),
]);
const sha=bytes=>createHash("sha256").update(bytes).digest("hex");
const thumbs=createFormatAdapters().find(adapter=>adapter.format==="thumbsdb");

test("Thumbs.db requires the exact name and the Windows thumbnail stream layout",async(t)=>{
  for (const name of ["DWG/Thumbs.db","THUMBS.DB","dir\\thumbs.DB"]) assert.equal(resolveFormat(name),"thumbsdb");
  for (const name of ["foo.db","not-Thumbs.db","Thumbs.db.bak","any.thumbsdb"]) assert.equal(resolveFormat(name),"unknown");
  const good=cache();
  assert.equal(isWindowsThumbnailCache(good),true);
  assert.equal(isWindowsThumbnailCache(cache({legacy:true})),true);
  assert.equal(isWindowsThumbnailCache(cache({streamName:"WordDocument"})),false);
  assert.equal(isWindowsThumbnailCache(Buffer.from("SQLite format 3\0")),false);
  assert.equal(isWindowsThumbnailCache(good.subarray(0,good.length-16)),false);
  const broken=Buffer.from(good); broken.writeUInt32LE(2,520);
  assert.equal(isWindowsThumbnailCache(broken),false);
  const oldWord=await readFile(new URL("fixtures/schedule.doc",import.meta.url));
  assert.equal(isWindowsThumbnailCache(oldWord),false);
  const scratch=await mkdtemp(join(tmpdir(),"thumbs-fixture-"));
  t.after(()=>rm(scratch,{recursive:true,force:true}));
  const path=join(scratch,"Thumbs.db");
  await writeFile(path,good);
  const [unit]=await thumbs.inspect(path);
  assert.deepEqual([unit.id,unit.locator.coverage,unit.locator.limitations],["original","original_only",windowsThumbnailCache]);
  await writeFile(path,oldWord);
  assert.equal((await thumbs.inspect(path))[0].locator.limitations,"format_original_only");
});

const databaseUrl=process.env.THUMBS_TEST_DATABASE_URL;
test("ordinary preparation reclassifies already accepted Thumbs.db without new research windows",{skip:!databaseUrl},async(t)=>{
  const parsed=new URL(databaseUrl);
  assert.ok(["localhost","127.0.0.1","::1","[::1]"].includes(parsed.hostname)&&/^\/facade_test_[a-z0-9_]+$/.test(parsed.pathname));
  const {Pool}=(await import("pg")).default;
  const schema="thumbs_"+randomUUID().replaceAll("-","");
  const admin=new Pool({connectionString:databaseUrl});
  await admin.query(`CREATE SCHEMA "${schema}"`);
  const db=new Pool({connectionString:databaseUrl,options:`-c search_path=${schema},public`});
  const scratch=await mkdtemp(join(tmpdir(),"thumbs-reclassification-"));
  t.after(async()=>{
    await db.end();
    await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
    await admin.end();
    await rm(scratch,{recursive:true,force:true});
  });
  const migrations=resolve("db/migrations");
  for(const file of (await readdir(migrations)).filter(file=>!file.startsWith("01_")&&file.endsWith(".sql")).sort()){
    await db.query(await readFile(join(migrations,file),"utf8"));
  }
  const [{createReaderService},{WorkQueue},{activatePackageProjects,preparePackageMap},{packagePreparationInput},
    {readPackagePreparation}]=await Promise.all([
      load("pdf/service.js"),load("gateway/queue.js"),load("harness/package-dispatch.js"),
      load("harness/package-preparation.js"),load("intake/package-preparation.js"),
    ]);
  const org=randomUUID(),user=randomUUID(),projectId=randomUUID(),receiptId=randomUUID();
  await db.query("INSERT INTO organizations(id,name) VALUES($1,'Fixture')",[org]);
  await db.query("INSERT INTO users(id,organization_id,login) VALUES($1,$2,'fixture')",[user,org]);
  await db.query("INSERT INTO projects(id,organization_id,name,intake_mode) VALUES($1,$2,'Fixture',true)",[projectId,org]);
  await db.query("INSERT INTO intake_receipts(id,project_id,source,created_by,sealed_at) VALUES($1,$2,'upload',$3,now())",[receiptId,projectId,user]);
  const queue=new WorkQueue(db);
  await activatePackageProjects(db,queue,[projectId]);
  const sources=new Map();
  const unknownVersion="formats-1.1.0:unknown";
  const oldUnits=[{id:"original",label:"Оригинал",locator:{coverage:"original_only",limitations:"format_original_only"}}];
  async function historical(path,bytes){
    const [originalId,documentId,versionId]=Array.from({length:3},randomUUID), digest=sha(bytes);
    const source={projectId,documentId,versionId,sha256:digest,size:bytes.length,format:resolveFormat(path),
      open:async()=>Readable.from([bytes]),receiptId,relativePath:path};
    sources.set(versionId,source);
    await db.query("INSERT INTO intake_originals(id,project_id,object_key,size,sha256) VALUES($1,$2,$3,$4,$5)",
      [originalId,projectId,path,bytes.length,digest]);
    await db.query("INSERT INTO intake_documents(id,project_id) VALUES($1,$2)",[documentId,projectId]);
    await db.query("INSERT INTO intake_document_versions(id,project_id,document_id,original_id,media_type) VALUES($1,$2,$3,$4,'application/octet-stream')",
      [versionId,projectId,documentId,originalId]);
    await db.query("INSERT INTO intake_occurrences(project_id,receipt_id,relative_path,declared_media_type,version_id,state) VALUES($1,$2,$3,'application/octet-stream',$4,'accepted')",[projectId,receiptId,path,versionId]);
    await db.query("INSERT INTO intake_reader_jobs(project_id,receipt_id,document_id,version_id,original_id,dispatched_at) VALUES($1,$2,$3,$4,$5,now())",[projectId,receiptId,documentId,versionId,originalId]);
    await db.query(`INSERT INTO reader_maps(project_id,document_id,version_id,reader_version,receipt_id,original_sha256,format,units)
      VALUES($1,$2,$3,$4,$5,$6,'unknown',$7)`,[projectId,documentId,versionId,unknownVersion,receiptId,digest,JSON.stringify(oldUnits)]);
    await db.query(`INSERT INTO harness_package_maps(project_id,version_id,fingerprint,reader_version,requested_reader_version,format,physical_limitation)
      VALUES($1,$2,'old',$3,$3,'unknown','format_original_only')`,[projectId,versionId,unknownVersion]);
    await db.query(`INSERT INTO harness_package_windows(id,project_id,version_id,map_fingerprint,ordinal,place)
      VALUES(gen_random_uuid(),$1,$2,'old',1,'{"unitId":"original"}')`,[projectId,versionId]);
    return {versionId,documentId,originalId};
  }
  const confirmed=await historical("DWG/ThUmBs.Db",cache());
  const otherName=await historical("DWG/other.db",cache({legacy:true}));
  const otherContent=await historical("foo/Thumbs.db",Buffer.from("SQLite format 3\0"));
  const service=createReaderService(db,{resolveOriginal:async ref=>sources.get(ref.versionId),artifacts:{},scratchDir:scratch},createFormatAdapters());
  const reader={...service,formatFor:(_media,path)=>resolveFormat(path)};
  assert.equal(await preparePackageMap(db,queue,reader,[projectId]),true);
  assert.equal(await preparePackageMap(db,queue,reader,[projectId]),true);
  assert.equal(await preparePackageMap(db,queue,reader,[projectId]),false);
  const input=await packagePreparationInput(db,{projectId,receiptId},reader);
  const view=await readPackagePreparation(db,input);
  assert.equal(view.state,"ready");
  assert.deepEqual([view.counts.total,view.counts.technical,view.counts.unavailable],[2,1,2]);
  const byId=new Map(view.items.map(item=>[item.versionId,item]));
  const item=byId.get(confirmed.versionId);
  assert.deepEqual([item.kind,item.state,item.reason,item.documentId,item.originalId],
    ["technical","excluded",windowsThumbnailCache,confirmed.documentId,confirmed.originalId]);
  assert.deepEqual([byId.get(otherName.versionId).kind,byId.get(otherContent.versionId).kind],["document","document"]);
  const {rows:[proof]}=await db.query(`SELECT count(*) FILTER (WHERE m.active)::int AS active,count(*)::int AS history
    FROM harness_package_windows w JOIN harness_package_maps m ON m.fingerprint=w.map_fingerprint AND m.version_id=w.version_id
    WHERE w.version_id=$1`,[confirmed.versionId]);
  assert.deepEqual(proof,{active:0,history:1});
  assert.equal((await db.query("SELECT count(*)::int AS count FROM gateway_jobs")).rows[0].count,0);
});
