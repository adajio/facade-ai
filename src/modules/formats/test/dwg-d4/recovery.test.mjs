import assert from "node:assert/strict";
import {createHash,randomUUID} from "node:crypto";
import {mkdir,mkdtemp,open,readFile,readdir,rm,writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join,resolve} from "node:path";
import {Readable} from "node:stream";
import {test} from "node:test";
import {pathToFileURL} from "node:url";

const root = process.env.FACADE_STEP11_DIST ?? resolve("dist");
const load = (file) => import(pathToFileURL(join(root,"src/modules",file)).href);
const [{buildDwgIndex},{derivativeLines},{parseDxf,convertedDxfRecords},{dxfEncodingRecoveryVersion,dxfEncodingRevision,dxfGroupRecoveryVersion,dxfFramingRevision,legacyDxfEncodingHold,legacyDxfGroupHold}] = await Promise.all([
  load("formats/dwg-index.js"),load("formats/dwg-text.js"),load("formats/spatial.js"),load("formats/dwg-profile.js"),
]);
const sha = value => createHash("sha256").update(value).digest("hex");
const converter = `sha256:${"b".repeat(64)}`;
const readerVersion = `formats-1.1.8:dwg:${converter}:fonts:sha256:${"c".repeat(64)}`;

function dxf(type, label, ending, invalidCode="20") {
  return ["0","SECTION","2","ENTITIES","0",type,"5","AB","10","1",invalidCode,"2","40","3",
    "3","ДО ", "1",label,"0","ENDSEC","0","EOF",""].join(ending);
}

async function* chunks(text) {
  for (const value of text) yield value;
}

test("DXF framing preserves raw LF only inside CRLF MTEXT and survives split CRLF and UTF-16", async (t) => {
  const scratch=await mkdtemp(join(tmpdir(),"dwg-framing-"));
  t.after(()=>rm(scratch,{recursive:true,force:true}));
  const embedded=dxf("MTEXT","Первая\n42 вторая","\r\n");
  for (const [idx,bytes] of [Buffer.from(embedded), Buffer.concat([Buffer.from([0xff,0xfe]),Buffer.from(embedded,"utf16le")])].entries()) {
    const path=join(scratch,String(idx));
    await writeFile(path,bytes);
    const file=await open(path);
    try {
      const index=await buildDwgIndex(file,sha(bytes),converter);
      try {
        const rows=[...index.units()].flatMap(({unit})=>unit.rows);
        assert.deepEqual(rows.map(({text})=>text),["ДО Первая\n42 вторая"]);
      } finally {await index.close();}
    } finally {await file.close();}
  }
  for (const ending of ["\r\n","\n","\r"]) {
    const wellFormed=dxf("MTEXT","Первая\\PВторая",ending);
    const records=[];
    for await (const value of convertedDxfRecords(derivativeLines(chunks(wellFormed)))) records.push(value);
    assert.equal(records.filter(({entity})=>entity).length,1);
    assert.equal(parseDxf(Buffer.from(wellFormed)).units[0].rows[0].text,"ДО Первая\nВторая");
  }
  const withControl=Buffer.from(dxf("MTEXT","Фрагмент\n\x1cне подтверждён","\r\n"));
  const path=join(scratch,"control");
  await writeFile(path,withControl);
  const file=await open(path);
  try {
    const index=await buildDwgIndex(file,sha(withControl),converter);
    try {
      const [{unit}]=[...index.units()];
      assert.equal(unit.rows[0].text,"");
      assert.ok(unit.limitations.includes("text_encoding_unconfirmed"));
    } finally {await index.close();}
  } finally {await file.close();}
  for (const [source,code] of [
    [dxf("TEXT","Первая\nвторая","\r\n"),"dxf_group_invalid"],
    [dxf("MTEXT","Первая\nвторая","\r\n","XX"),"dxf_group_invalid"],
    [embedded.replace("EOF\r\n",""),"dxf_group_limit_or_invalid"],
  ]) {
    assert.throws(()=>parseDxf(Buffer.from(source)),{code});
    await assert.rejects(async()=>{for await (const _ of convertedDxfRecords(derivativeLines(chunks(source)))) void _;},{code});
  }
});

test("DXF preserves geometry with a declared legacy code page and isolates opaque metadata", async (t) => {
  const scratch = await mkdtemp(join(tmpdir(), "dwg-legacy-encoding-"));
  t.after(() => rm(scratch, { recursive: true, force: true }));
  const layer = Buffer.from([0xd1, 0xeb, 0xee, 0xe9]); // CP1251: Слой
  const prepare = (version, codePage, field = "XRECORD") => Buffer.from([
    "0", "SECTION", "2", "HEADER", "9", "$ACADVER", "1", version, "9", "$DWGCODEPAGE", "3", codePage, "0", "ENDSEC",
    "0", "SECTION", "2", "TABLES", "0", "LAYER", "2", layer.toString("latin1"), "5", "1", "62", "7", "0", "ENDSEC",
    "0", "SECTION", "2", "ENTITIES",
    "0", "LINE", "5", "AA", "8", layer.toString("latin1"), "10", "1", "20", "2", "11", "3", "21", "4",
    "0", "TEXT", "5", "BB", "8", layer.toString("latin1"), "10", "1", "20", "2", "40", "3", "1", layer.toString("latin1"),
    "0", "MTEXT", "5", "CC", "8", layer.toString("latin1"), "10", "2", "20", "2", "40", "3", "1", "bad\x04text",
    "0", "ENDSEC", "0", "SECTION", "2", "OBJECTS",
    "0", field, "1", "opaque\nmetadata", "0", "ENDSEC", "0", "EOF", "",
  ].join("\r\n"), "latin1");
  async function inspect(name, data) {
    const path = join(scratch, name);
    await writeFile(path, data);
    const file = await open(path);
    try {
      const index = await buildDwgIndex(file, sha(data), converter);
      try { return [...index.units()].map(({unit}) => unit); }
      finally { await index.close(); }
    } finally { await file.close(); }
  }
  const [model] = await inspect("declared", prepare("AC1018", "ANSI_1251"));
  assert.equal(model.rows.find((row) => row.locator.derivativeHandle === "BB").text, "Слой");
  assert.equal(model.rows.find((row) => row.locator.derivativeHandle === "CC").text, "");
  assert.ok(model.cad.some(({ kind }) => kind === "LINE"));
  assert.ok(model.limitations.includes("text_encoding_unconfirmed"));
  assert.ok(model.limitations.includes("cad_dxf_opaque_metadata_ignored"));
  await assert.rejects(inspect("no-declaration", prepare("AC1018", "UNKNOWN")), { code: "text_encoding_unconfirmed" });
  await assert.rejects(inspect("modern", prepare("AC1032", "ANSI_1251")), { code: "text_encoding_unconfirmed" });
  await assert.rejects(inspect("wrong-group", prepare("AC1018", "ANSI_1251", "VIEW")), { code: "dxf_group_invalid" });
});

const databaseUrl=process.env.DWG_RECOVERY_TEST_DATABASE_URL;
test("reader and package dispatcher recover only historical DXF framing and encoding refusals once", {skip:!databaseUrl}, async (t)=>{
  const parsed=new URL(databaseUrl);
  assert.ok(["localhost","127.0.0.1","::1","[::1]"].includes(parsed.hostname)&&/^\/facade_test_[a-z0-9_]+$/.test(parsed.pathname));
  const {Pool}=(await import("pg")).default;
  const schema="dwg_recovery_"+randomUUID().replaceAll("-","");
  const admin=new Pool({connectionString:databaseUrl});
  await admin.query(`CREATE SCHEMA "${schema}"`);
  const db=new Pool({connectionString:databaseUrl,options:`-c search_path=${schema},public`});
  const scratch=await mkdtemp(join(tmpdir(),"dwg-recovery-"));
  const originalEnv=process.env.FACADE_DATA_DIR;
  process.env.FACADE_DATA_DIR=scratch;
  t.after(async()=>{
    if(originalEnv===undefined) delete process.env.FACADE_DATA_DIR;
    else process.env.FACADE_DATA_DIR=originalEnv;
    await db.end();
    await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
    await admin.end();
    await rm(scratch,{recursive:true,force:true});
  });
  const migrations=resolve("db/migrations");
  for(const file of (await readdir(migrations)).filter(file=>!file.startsWith("01_")&&file.endsWith(".sql")).sort()){
    await db.query(await readFile(join(migrations,file),"utf8"));
  }
  const [{createReaderService},{WorkQueue},{activatePackageProjects,preparePackageMap},{packagePreparationInput}]=await Promise.all([
    load("pdf/service.js"),load("gateway/queue.js"),load("harness/package-dispatch.js"),load("harness/package-preparation.js"),
  ]);
  const org=randomUUID(),user=randomUUID(),projectId=randomUUID(),receiptId=randomUUID();
  await db.query("INSERT INTO organizations(id,name) VALUES($1,'Fixture')",[org]);
  await db.query("INSERT INTO users(id,organization_id,login) VALUES($1,$2,'fixture')",[user,org]);
  await db.query("INSERT INTO projects(id,organization_id,name,intake_mode) VALUES($1,$2,'Fixture',true)",[projectId,org]);
  await db.query("INSERT INTO intake_receipts(id,project_id,source,created_by,sealed_at) VALUES($1,$2,'upload',$3,now())",[receiptId,projectId,user]);
  const queue=new WorkQueue(db);
  await activatePackageProjects(db,queue,[projectId]);
  const sources=new Map(), inspected=[];
  const bad=legacyDxfGroupHold.map(unit=>({...unit,label:"Оригинал"}));
  const marked=bad.map(unit=>({...unit,locator:{...unit.locator,dxfFraming:dxfFramingRevision}}));
  const badEncoding=legacyDxfEncodingHold.map(unit=>({...unit,label:"Оригинал"}));
  const markedEncoding=badEncoding.map(unit=>({...unit,locator:{...unit.locator,dxfEncoding:dxfEncodingRevision}}));
  const bytes=Buffer.from(dxf("MTEXT","Прочитано","\r\n"));
  const derivative=sha(bytes);
  const usable=[{id:"part-1",label:"Part",locator:{derivativeSha256:derivative,coverage:"addressable"}}];
  async function durable(source, identity=converter) {
    const key=join("dwg-derivatives",source.projectId,source.documentId,source.versionId,derivative);
    const path=join(scratch,key);
    await mkdir(join(path,".."),{recursive:true});
    await writeFile(path,bytes);
    return {storageKey:key,sha256:derivative,size:bytes.length,format:"dxf",converter:identity};
  }
  async function fixture(name, units, healthy=false) {
    const [original,documentId,versionId]=Array.from({length:3},randomUUID);
    const contents=Buffer.from("AC1032 "+name), originalSha=sha(contents), relativePath=name+".dwg";
    const source={projectId,documentId,versionId,sha256:originalSha,size:contents.length,format:"dwg",
      open:async()=>Readable.from([contents]),receiptId,name};
    sources.set(versionId,source);
    await db.query("INSERT INTO intake_originals(id,project_id,object_key,size,sha256) VALUES($1,$2,$3,$4,$5)",
      [original,projectId,relativePath,contents.length,originalSha]);
    await db.query("INSERT INTO intake_documents(id,project_id) VALUES($1,$2)",[documentId,projectId]);
    await db.query("INSERT INTO intake_document_versions(id,project_id,document_id,original_id,media_type) VALUES($1,$2,$3,$4,'application/acad')",[versionId,projectId,documentId,original]);
    await db.query("INSERT INTO intake_occurrences(project_id,receipt_id,relative_path,declared_media_type,version_id,state) VALUES($1,$2,$3,'application/acad',$4,'accepted')",[projectId,receiptId,relativePath,versionId]);
    await db.query("INSERT INTO intake_reader_jobs(project_id,receipt_id,document_id,version_id,original_id) VALUES($1,$2,$3,$4,$5)",[projectId,receiptId,documentId,versionId,original]);
    if (!units) return source;
    await db.query(`INSERT INTO reader_maps(project_id,document_id,version_id,reader_version,receipt_id,original_sha256,format,units)
      VALUES($1,$2,$3,$4,$5,$6,'dwg',$7)`,[projectId,documentId,versionId,readerVersion,receiptId,originalSha,JSON.stringify(units)]);
    await db.query(`INSERT INTO harness_package_maps(project_id,version_id,fingerprint,reader_version,requested_reader_version,format,physical_limitation)
      VALUES($1,$2,$3,$4,$4,'dwg','dwg_original_inventory_unverified')`,[projectId,versionId,name,readerVersion]);
    await db.query(`INSERT INTO harness_package_windows(id,project_id,version_id,map_fingerprint,ordinal,place)
      VALUES(gen_random_uuid(),$1,$2,$3,1,$4)`,[projectId,versionId,name,JSON.stringify({unitId:units[0].id})]);
    if(healthy){
      const saved=await durable(source);
      await db.query(`INSERT INTO dwg_derivatives(project_id,document_id,version_id,original_sha256,reader_version,converter_identity,derivative_sha256,byte_size,format,storage_key)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,'dxf',$9)`,[projectId,documentId,versionId,originalSha,readerVersion,converter,derivative,saved.size,saved.storageKey]);
    }
    return source;
  }
  const recoverable=await fixture("repair",bad), malformed=await fixture("invalid",bad);
  const healthy=await fixture("healthy",usable,true), current=await fixture("new-invalid",marked);
  const repairEncoding=await fixture("repair-encoding",badEncoding), invalidEncoding=await fixture("invalid-encoding",badEncoding);
  const currentEncoding=await fixture("new-encoding",markedEncoding);
  const deps={resolveOriginal:async ref=>sources.get(ref.versionId),artifacts:{},scratchDir:scratch};
  const service=createReaderService(db,deps,[{
    format:"dwg",version:async()=>readerVersion,
    async inspect(_path,source){
      const name=sources.get(source.versionId).name;
      inspected.push(name);
      if (name==="repair" || name==="repair-encoding") return usable;
      return name==="invalid-encoding" ? markedEncoding : marked;
    },
    async durableInfo(source,units){
      if(units[0].id==="part-1") return durable(source);
    },
  }]);
  const reader={...service,formatFor:()=>"dwg"};
  for (let i=0;i<4;i++) assert.equal(await preparePackageMap(db,queue,reader,[projectId]),true);
  assert.equal(await preparePackageMap(db,queue,reader,[projectId]),false);
  assert.deepEqual(inspected.sort(),["invalid","invalid-encoding","repair","repair-encoding"]);
  const retry=dxfGroupRecoveryVersion(readerVersion);
  const encodingRetry=dxfEncodingRecoveryVersion(readerVersion);
  assert.equal((await service.map(recoverable)).readerVersion,retry);
  assert.equal((await service.map(malformed)).units[0].locator.dxfFraming,dxfFramingRevision);
  assert.equal((await service.map(current)).readerVersion,readerVersion);
  assert.equal((await service.map(repairEncoding)).readerVersion,encodingRetry);
  assert.equal((await service.map(invalidEncoding)).units[0].locator.dxfEncoding,dxfEncodingRevision);
  assert.equal((await service.map(currentEncoding)).readerVersion,readerVersion);
  assert.equal(inspected.length,4);
  const history=await db.query("SELECT version_id,reader_version FROM reader_maps ORDER BY version_id,reader_version");
  assert.equal(history.rowCount,11);
  const active=await db.query("SELECT version_id,reader_version,fingerprint FROM harness_package_maps WHERE active");
  for(const {version_id,reader_version,fingerprint} of active.rows){
    if(version_id===healthy.versionId) assert.deepEqual([reader_version,fingerprint],[readerVersion,"healthy"]);
    else if(version_id===current.versionId) assert.deepEqual([reader_version,fingerprint],[readerVersion,"new-invalid"]);
    else if(version_id===currentEncoding.versionId) assert.deepEqual([reader_version,fingerprint],[readerVersion,"new-encoding"]);
    else if([repairEncoding.versionId,invalidEncoding.versionId].includes(version_id)) assert.equal(reader_version,encodingRetry);
    else assert.equal(reader_version,retry);
  }
  const input=await packagePreparationInput(db,{projectId,receiptId},reader);
  assert.equal(input.expectedReaderVersions[malformed.versionId],retry);
  assert.equal(input.expectedReaderVersions[recoverable.versionId],retry);
  assert.equal(input.expectedReaderVersions[invalidEncoding.versionId],encodingRetry);
  assert.equal(input.expectedReaderVersions[repairEncoding.versionId],encodingRetry);
  assert.equal(input.expectedReaderVersions[healthy.versionId],readerVersion);
  assert.equal(input.verifiedDerivatives[recoverable.versionId].derivativeSha256,derivative);
  assert.equal(input.verifiedDerivatives[repairEncoding.versionId].derivativeSha256,derivative);

  await t.test("one admitted predecessor retains old successes and holds and sends new versions to the new converter",async()=>{
    const [{capturePackagePreparation,readPackagePreparation},{transaction}]=await Promise.all([
      load("intake/package-preparation.js"),load("gateway/types.js"),
    ]);
    const old=await transaction(db,tx=>capturePackagePreparation(tx,input));
    assert.equal(old.state,"ready");
    const backup=process.env.FACADE_DWG_PREDECESSOR_ID, backupTime=process.env.FACADE_DWG_PREDECESSOR_BEFORE;
    try {
      process.env.FACADE_DWG_PREDECESSOR_ID=converter;
      process.env.FACADE_DWG_PREDECESSOR_BEFORE=(await db.query("SELECT clock_timestamp() AS ts")).rows[0].ts.toISOString();
      const nextConverter=`sha256:${"d".repeat(64)}`;
      const nextVersion=readerVersion.replace(converter,nextConverter);
      const readCalls=[];
      const nextService=createReaderService(db,deps,[{
        format:"dwg",version:async()=>nextVersion,
        async inspect(_path,source){ readCalls.push(source.versionId);return usable; },
        async durableInfo(source){ return durable(source,nextConverter); },
      }]);
      const nextReader={...nextService,formatFor:()=>"dwg"};
      const view=()=>transaction(db,async tx=>readPackagePreparation(tx,await packagePreparationInput(tx,{projectId,receiptId},nextReader)));
      const archived=await view();
      assert.equal(archived.manifestId,old.manifestId);
      assert.equal(archived.items.find(item=>item.versionId===healthy.versionId).state,"available");
      assert.equal(archived.items.find(item=>item.versionId===invalidEncoding.versionId).reason,"text_encoding_unconfirmed");
      assert.equal((await nextService.map(healthy)).readerVersion,readerVersion);
      assert.equal((await nextService.map(invalidEncoding)).readerVersion,encodingRetry);
      assert.equal(await preparePackageMap(db,queue,nextReader,[projectId]),false);
      assert.deepEqual(readCalls,[]);

      const fresh=await fixture("after-cutover",undefined);
      assert.equal(await preparePackageMap(db,queue,nextReader,[projectId]),true);
      const freshMap=await nextService.map(fresh);
      assert.equal(freshMap.readerVersion,nextVersion);
      assert.deepEqual(readCalls,[fresh.versionId]);
      assert.equal(await preparePackageMap(db,queue,nextReader,[projectId]),false);

      await rm(join(scratch,"dwg-derivatives",healthy.projectId,healthy.documentId,healthy.versionId,derivative));
      assert.equal((await view()).items.find(item=>item.versionId===healthy.versionId).reason,"derivative_unverified");
      await assert.rejects(nextService.map(healthy),{code:"dwg_predecessor_derivative_unavailable"});
      assert.equal(await preparePackageMap(db,queue,nextReader,[projectId]),false);
      assert.deepEqual(readCalls,[fresh.versionId]);
    } finally {
      if (backup===undefined) delete process.env.FACADE_DWG_PREDECESSOR_ID;
      else process.env.FACADE_DWG_PREDECESSOR_ID=backup;
      if (backupTime===undefined) delete process.env.FACADE_DWG_PREDECESSOR_BEFORE;
      else process.env.FACADE_DWG_PREDECESSOR_BEFORE=backupTime;
    }
  });
});
