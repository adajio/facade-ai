import assert from 'node:assert/strict';
import {createHash,randomBytes,randomUUID} from 'node:crypto';
import {once} from 'node:events';
import {createServer} from 'node:http';
import {chmod,mkdir,mkdtemp,readdir,readFile,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {Readable} from 'node:stream';
import {pathToFileURL} from 'node:url';
import test from 'node:test';
import Fastify from 'fastify';
import pg from 'pg';
const url=process.env.DWG_TEST_DATABASE_URL;
const dist=process.env.FACADE_STEP11_DIST ?? resolve('dist');
const load=(path)=>import(pathToFileURL(join(dist,'src/modules',path)));
const hash=(bytes)=>createHash('sha256').update(bytes).digest('hex');

test('DWG durable derivative: historical map recovery, restart, permissions and integrity',{skip:!url,timeout:120000},async()=>{
  const parsed=new URL(url);
  assert.ok(['localhost','127.0.0.1','::1','[::1]'].includes(parsed.hostname) && /^\/facade_test_[a-z0-9_]+$/.test(parsed.pathname));
  const schema=`dwg_${randomUUID().replaceAll('-','')}`, root=await mkdtemp(join(tmpdir(),'dwg-integration-'));
  const admin=new pg.Pool({connectionString:url}); let db,app,reader; let stopped=false;
  const oldDir=process.env.FACADE_DATA_DIR, oldSocket=process.env.FACADE_CONVERTER_SOCKET;
  process.env.FACADE_DATA_DIR=root; process.env.FACADE_CONVERTER_SOCKET=join(root,'broker.sock');
  const original=Buffer.from('AC1015A'), image='sha256:'+'a'.repeat(64), identity='sha256:'+'d'.repeat(64);
  let output=Buffer.from('0\nSECTION\n2\nENTITIES\n0\nLINE\n5\nA\n10\n1\n20\n2\n11\n3\n21\n4\n0\nENDSEC\n0\nEOF\n'), calls=0;
  const expected=Buffer.from(output);
  const broker=createServer((_req,res)=>res.end(JSON.stringify({dwgEngine:'oda',dwg:image,dwgIdentity:identity,dwgClientTimeoutMs:4000,dwgReserveBytes:1})));
  broker.on('checkContinue',(req,res)=>{calls++;res.writeContinue();req.on('end',()=>{res.writeHead(200,{'x-converter-bytes':String(output.length),trailer:'x-converter-result, x-converter-bytes, x-converter-sha256'});res.write(output);res.addTrailers({'x-converter-result':'ok','x-converter-sha256':hash(output),'x-converter-bytes':String(output.length)});res.end();});req.resume();});
  try {
    await admin.query(`CREATE SCHEMA "${schema}"`);
    db=new pg.Pool({connectionString:url,options:`-c search_path=${schema},public`});
    for(const name of (await readdir('db/migrations')).filter(n=>n.endsWith('.sql')&&!n.startsWith('01_')).sort()) await db.query(await readFile(join('db/migrations',name),'utf8'));
    const [org,user,scoped,scope,cat,project,receipt,orig,doc,version,occ]=Array.from({length:11},randomUUID);
    const session=randomBytes(32).toString('base64url'), scopedSession=randomBytes(32).toString('base64url');
    await db.query("INSERT INTO organizations(id,name) VALUES($1,'fixture')",[org]);
    await db.query("INSERT INTO users(id,organization_id,login,state,password_hash) VALUES($1,$3,$4,'active','$argon2id$fixture'),($2,$3,$5,'active','$argon2id$fixture')",[user,scoped,org,`${user}@test`,`${scoped}@test`]);
    await db.query("INSERT INTO access_sessions(user_id,token_hash,expires_at) VALUES($1,$3,now()+interval '1 hour'),($2,$4,now()+interval '1 hour')",[user,scoped,Buffer.from(hash(session),'hex'),Buffer.from(hash(scopedSession),'hex')]);
    await db.query("INSERT INTO catalog_versions(id,organization_id,catalog_key,revision,name,requirements,created_by) VALUES($1,$2,'test',1,'test','[]',$3)",[cat,org,user]);
    await db.query("INSERT INTO projects(id,organization_id,name,catalog_version_id) VALUES($1,$2,'test',$3)",[project,org,cat]);
    await db.query("INSERT INTO project_scopes(id,project_id,stage,name) VALUES($1,$2,'fixture','fixture')",[scope,project]);
    await db.query("INSERT INTO project_memberships(organization_id,project_id,user_id,role) VALUES($1,$2,$3,'project_manager')",[org,project,user]);
    await db.query("INSERT INTO project_memberships(organization_id,project_id,user_id,role,scope_id,expires_at,reason) VALUES($1,$2,$3,'viewer',$4,now()+interval '1 hour','fixture')",[org,project,scoped,scope]);
    await db.query("INSERT INTO intake_receipts(id,project_id,source,created_by,sealed_at) VALUES($1,$2,'upload',$3,now())",[receipt,project,user]);
    await db.query("INSERT INTO intake_originals(id,project_id,object_key,size,sha256) VALUES($1,$2,'fixture',$3,$4)",[orig,project,original.length,hash(original)]);
    await db.query("INSERT INTO intake_documents(id,project_id) VALUES($1,$2)",[doc,project]);
    await db.query("INSERT INTO intake_document_versions(id,project_id,document_id,original_id,media_type) VALUES($1,$2,$3,$4,'application/octet-stream')",[version,project,doc,orig]);
    await db.query("INSERT INTO intake_occurrences(id,project_id,receipt_id,relative_path,declared_media_type,version_id,state) VALUES($1,$2,$3,'fixture.dwg','application/octet-stream',$4,'accepted')",[occ,project,receipt,version]);
    await db.query("INSERT INTO intake_reader_jobs(project_id,receipt_id,document_id,version_id,original_id) VALUES($1,$2,$3,$4,$5)",[project,receipt,doc,version,orig]);
    const storedObjects=new Map([['fixture',{bytes:original,sha256:hash(original)}]]);
    const objects={async head(key){const item=storedObjects.get(key);return item && {size:item.bytes.length,sha256:item.sha256}},
      async get(key){return Readable.from([storedObjects.get(key).bytes])},
      async put(key,identity,stream){const chunks=[];for await (const chunk of stream) chunks.push(chunk);storedObjects.set(key,{bytes:Buffer.concat(chunks),sha256:identity.sha256})},
      async remove(key){storedObjects.delete(key)},close(){}};
    const storage={objects,stagingDir:root,partSize:8388608,ttlSeconds:3600,diskGuardBytes:0};
    const pdf=await load('pdf/index.js');
    broker.listen(process.env.FACADE_CONVERTER_SOCKET); await once(broker,'listening');
    reader=pdf.createRuntimePdfService(db,{dataDir:root},{storage});
    const source={projectId:project,documentId:doc,versionId:version,sha256:hash(original)};
    const map=await reader.map(source); assert.equal(calls,1);
    const proof=await pdf.verifyStoredDwgDerivative(db,source,map.readerVersion);
    assert.equal(proof.derivativeSha256,hash(expected)); assert.equal(proof.byteSize,expected.length);
    const {dwgReaderProfile,historicalDwgReaderProfile}=await load('formats/dwg-profile.js');
    const oldIdentity='sha256:'+'b'.repeat(64);
    const oldVersion=map.readerVersion.replace(dwgReaderProfile,historicalDwgReaderProfile).replace(identity,oldIdentity);
    const untrackedVersion=oldVersion.replace(oldIdentity,'sha256:'+'c'.repeat(64));
    await assert.rejects(reader.open(source,{runId:randomUUID(),branch:'A',operationKey:'historical-missing'}, {
      readerVersion:untrackedVersion,representation:'native',address:{unitId:map.units[0].id},
    }),{code:'reader_map_unavailable'});
    assert.equal(calls,1);
    // Simulate a pre-upgrade map/index with no full derivative: changed conversion must not be accepted.
    const {findStoredDwgDerivative}=await load('pdf/dwg-derivative.js');
    const existing=await findStoredDwgDerivative(db,source,map.readerVersion);
    await db.query('DELETE FROM dwg_derivatives WHERE version_id=$1',[version]); await rm(existing.path);
    await db.query(`UPDATE reader_maps SET units=(SELECT jsonb_agg(jsonb_set(item,'{locator}',(item->'locator') - 'derivativeFormat' - 'converterIdentity')) FROM jsonb_array_elements(units) item) WHERE version_id=$1`, [version]);
    output=Buffer.concat([expected,Buffer.from('\n')]);
    await assert.rejects(reader.map(source),{code:'dwg_index_identity_changed'});
    assert.equal((await db.query('SELECT count(*)::int AS n FROM dwg_derivatives')).rows[0].n,0);
    output=expected; await reader.map(source); assert.equal(calls,3);
    // A database failure cannot publish a ready map without its derivative metadata.
    const [orig2,doc2,version2,occ2]=Array.from({length:4},randomUUID);
    const original2=Buffer.from('AC1015B'); storedObjects.set('fixture2',{bytes:original2,sha256:hash(original2)});
    await db.query("INSERT INTO intake_originals(id,project_id,object_key,size,sha256) VALUES($1,$2,'fixture2',$3,$4)",[orig2,project,original2.length,hash(original2)]);
    await db.query("INSERT INTO intake_documents(id,project_id) VALUES($1,$2)",[doc2,project]);
    await db.query("INSERT INTO intake_document_versions(id,project_id,document_id,original_id,media_type) VALUES($1,$2,$3,$4,'application/octet-stream')",[version2,project,doc2,orig2]);
    await db.query("INSERT INTO intake_occurrences(id,project_id,receipt_id,relative_path,declared_media_type,version_id,state) VALUES($1,$2,$3,'other.dwg','application/octet-stream',$4,'accepted')",[occ2,project,receipt,version2]);
    await db.query("INSERT INTO intake_reader_jobs(project_id,receipt_id,document_id,version_id,original_id) VALUES($1,$2,$3,$4,$5)",[project,receipt,doc2,version2,orig2]);
    await db.query(`CREATE FUNCTION reject_derivative_fixture() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN RAISE EXCEPTION 'fixture'; END$$;
      CREATE TRIGGER reject_derivative_fixture BEFORE INSERT ON dwg_derivatives FOR EACH ROW EXECUTE FUNCTION reject_derivative_fixture()`);
    await assert.rejects(reader.map({projectId:project,documentId:doc2,versionId:version2,sha256:hash(original2)}));
    assert.equal((await db.query('SELECT count(*)::int AS n FROM reader_maps WHERE version_id=$1',[version2])).rows[0].n,0);
    await db.query('DROP TRIGGER reject_derivative_fixture ON dwg_derivatives; DROP FUNCTION reject_derivative_fixture()');
    broker.closeAllConnections(); await new Promise(ok=>broker.close(ok)); stopped=true;
    reader.close(); reader=pdf.createRuntimePdfService(db,{dataDir:root},{storage});
    await db.query(`INSERT INTO reader_maps(project_id,document_id,version_id,reader_version,receipt_id,original_sha256,format,units)
      VALUES($1,$2,$3,'held-version',$4,$5,'dwg','[{"id":"original","locator":{"coverage":"held"}}]')`,[project,doc,version,receipt,source.sha256]);
    assert.equal((await reader.map(source)).readerVersion,map.readerVersion);
    assert.equal((await reader.latestMap(source)).readerVersion,map.readerVersion);
    const preview=await reader.previewDwg(source,{readerVersion:map.readerVersion,representation:'native',address:{unitId:map.units[0].id}});
    assert.equal(preview.address.unitId,map.units[0].id);
    const modelRead=await reader.open(source,{runId:randomUUID(),branch:'A',operationKey:'offline-read'},
      {readerVersion:map.readerVersion,representation:'native',address:{unitId:map.units[0].id}});
    assert.equal(modelRead.evidence.readerVersion,map.readerVersion);
    assert.ok(modelRead.bytes.length>0);
    app=Fastify(); app.decorate('db',db); app.decorate('config',{dataDir:root}); await app.register(pdf.register,{storage});
    const path=`/api/v1/documents/${doc}/versions/${version}/dwg-derivative`, cookie=`facade_session=${session}`;
    assert.equal((await app.inject({method:'GET',url:path})).statusCode,401);
    assert.equal((await app.inject({method:'GET',url:path,headers:{cookie:`facade_session=${scopedSession}`}})).statusCode,404);
    const result=await app.inject({method:'GET',url:path,headers:{cookie}}); assert.equal(result.statusCode,200); assert.deepEqual(result.rawPayload,expected); assert.match(result.headers['content-disposition'],/filename\*=UTF-8''fixture\.dxf/);
    const head=await app.inject({method:'HEAD',url:path,headers:{cookie}}); assert.equal(head.statusCode,200); assert.equal(head.rawPayload.length,0); assert.equal(Number(head.headers['content-length']),expected.length); assert.equal(head.headers.etag, `"sha256-${hash(expected)}"`);
    const archived=Buffer.from('{"OBJECTS":[]}');
    const archivedHash=hash(archived), archivedKey=join('dwg-derivatives',project,doc,version,archivedHash);
    const archivedPath=join(root,archivedKey);
    await mkdir(join(archivedPath,'..'),{recursive:true});
    await writeFile(archivedPath,archived);
    await db.query(`INSERT INTO dwg_derivatives(project_id,document_id,version_id,original_sha256,reader_version,
      converter_identity,derivative_sha256,byte_size,format,storage_key,created_at)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,'dwg-json',$9,clock_timestamp()-interval '1 hour')`,
    [project,doc,version,source.sha256,oldVersion,oldIdentity,archivedHash,archived.length,archivedKey]);
    const pinned=await app.inject({method:'GET',url:path+'?readerVersion='+encodeURIComponent(oldVersion),headers:{cookie}});
    assert.equal(pinned.statusCode,200);
    assert.deepEqual(pinned.rawPayload,archived);
    assert.equal(pinned.headers.etag,`"sha256-${archivedHash}"`);
    assert.match(pinned.headers['content-disposition'],/fixture\.json/u);
    const unknown=await app.inject({method:'GET',url:path+'?readerVersion='+encodeURIComponent(untrackedVersion),headers:{cookie}});
    assert.equal(unknown.statusCode,404);
    const falseOdaVersion=map.readerVersion.replace(identity,oldIdentity);
    await db.query('UPDATE dwg_derivatives SET reader_version=$2 WHERE reader_version=$1',[oldVersion,falseOdaVersion]);
    const incompatible=await app.inject({method:'GET',url:path+'?readerVersion='+encodeURIComponent(falseOdaVersion),headers:{cookie}});
    assert.equal(incompatible.statusCode,424);
    const alias=await app.inject({method:'GET',url:path.replace('/api/v1/','/api/'),headers:{cookie}}); assert.equal(alias.statusCode,200); assert.deepEqual(alias.rawPayload,expected);
    const saved=await findStoredDwgDerivative(db,source,map.readerVersion); await chmod(saved.path,0o600);
    await writeFile(saved.path,Buffer.alloc(expected.length, 1));
    assert.equal((await app.inject({method:'HEAD',url:path,headers:{cookie}})).statusCode,424);
    await rm(saved.path);
    assert.equal((await app.inject({method:'HEAD',url:path,headers:{cookie}})).statusCode,404);
  } finally {
    if(app) await app.close(); reader?.close();
    if(!stopped){broker.closeAllConnections();await new Promise(ok=>broker.close(ok));}
    if(db) await db.end(); await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`); await admin.end();
    if(oldDir===undefined) delete process.env.FACADE_DATA_DIR; else process.env.FACADE_DATA_DIR=oldDir;
    if(oldSocket===undefined) delete process.env.FACADE_CONVERTER_SOCKET; else process.env.FACADE_CONVERTER_SOCKET=oldSocket;
    await rm(root,{recursive:true,force:true});
  }
});
