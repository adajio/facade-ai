import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { chmod, mkdtemp, open, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
const dist = process.env.FACADE_STEP11_DIST ?? resolve('dist');
const load = name => import(pathToFileURL(join(dist,'src/modules',name)));
const sha = bytes => createHash('sha256').update(bytes).digest('hex');

test('DWG derivative and pinned parts survive a restarted reader without converter; corruption is rejected', async () => {
  const {createFormatAdapters} = await load('formats/index.js');
  const {verifyDwgFile,persistDwgFile} = await load('formats/dwg-durable.js');
  const {buildDwgIndex} = await load('formats/dwg-index.js');
  const {dwgReaderProfile,historicalDwgReaderProfile} = await load('formats/dwg-profile.js');
  const root=await mkdtemp(join(tmpdir(),'dwg-durable-'));
  const oldDir=process.env.FACADE_DATA_DIR, oldSocket=process.env.FACADE_CONVERTER_SOCKET;
  const oldFontDir=process.env.FACADE_DWG_FONT_DIR;
  delete process.env.FACADE_DWG_FONT_DIR;
  const socket=join(root,'converter.sock'), original=join(root,'original.dwg');
  const image='sha256:'+'a'.repeat(64), identity='sha256:'+'d'.repeat(64);
  const bytes=Buffer.from('0\nSECTION\n2\nENTITIES\n0\nLINE\n5\nA\n10\n1\n20\n2\n11\n3\n21\n4\n0\nENDSEC\n0\nEOF\n');
  const source={projectId:randomUUID(),documentId:randomUUID(),versionId:randomUUID(),sha256:'b'.repeat(64)};
  await writeFile(original,'AC1015A'); process.env.FACADE_DATA_DIR=root; process.env.FACADE_CONVERTER_SOCKET=socket;
  let conversions=0, payload=bytes;
  const server=createServer((_req,res)=>res.end(JSON.stringify({dwgEngine:'oda',dwg:image,dwgIdentity:identity,dwgClientTimeoutMs:4000,dwgReserveBytes:1})));
  server.on('checkContinue',(req,res)=>{conversions++;res.writeContinue();req.on('end',()=>{
    res.writeHead(200,{'x-converter-bytes':String(payload.length),trailer:'x-converter-result, x-converter-bytes, x-converter-sha256'});
    res.write(payload);res.addTrailers({'x-converter-result':'ok','x-converter-sha256':sha(payload),'x-converter-bytes':String(payload.length)});res.end();});req.resume();});
  let stopped=false;
  try {
    server.listen(socket); await once(server,'listening');
    const adapter=createFormatAdapters().find(x=>x.format==='dwg');
    const version=await adapter.version();
    assert.ok(version.startsWith(dwgReaderProfile+':dwg:'));
    const units=await adapter.inspect(original,source);
    assert.equal(conversions,1);
    const meta=await adapter.durableInfo(source,units,version);
    assert.equal(meta.sha256,sha(bytes)); assert.equal(meta.size,bytes.length); assert.equal(meta.format,'dxf');
    payload=Buffer.from(JSON.stringify({created_by:'archived fixture',OBJECTS:[{entity:'TEXT',entmode:2,text_value:'Detail',ins_pt:[0,0],height:1}]}));
    const jsonSource={...source,versionId:randomUUID(),sha256:'c'.repeat(64)};
    const refused=await adapter.inspect(original,jsonSource);
    assert.equal(refused[0].locator.limitations,'dwg_derivative_format_invalid');
    assert.equal(await adapter.durableInfo(jsonSource,refused,version),undefined);
    assert.equal(await verifyDwgFile(jsonSource,sha(payload)),undefined);
    // Install byte-identical historical evidence in its original profile and index namespace.
    const oldVersion=version.replace(dwgReaderProfile,historicalDwgReaderProfile);
    const oldHash=sha(payload);
    const fixture=join(root,'archived.json');
    await writeFile(fixture,payload);
    const json=await open(fixture);
    let oldUnit;
    try {
      const oldIndex=await buildDwgIndex(json,oldHash,identity,
        {source:jsonSource,converter:identity,reserve:0,profile:historicalDwgReaderProfile});
      try {
        const [{unit,digest}]=[...oldIndex.units()];
        oldUnit={id:unit.id,label:unit.label,locator:{...unit.locator,derivativeSha256:oldHash,
          derivativeFormat:'dwg-json',converterIdentity:identity,partSha256:digest}};
        await persistDwgFile(jsonSource,json,oldHash);
      } finally { await oldIndex.close(); }
    } finally { await json.close(); }
    assert.equal(await adapter.durableInfo(jsonSource,[oldUnit],version),undefined);
    payload=bytes;
    const blocked=join(root,'blocked'); await writeFile(blocked,'x'); process.env.FACADE_DATA_DIR=blocked;
    await assert.rejects(adapter.inspect(original,{...source,projectId:randomUUID()}));
    process.env.FACADE_DATA_DIR=root;
    server.closeAllConnections(); await new Promise(ok=>server.close(ok)); stopped=true;
    const after=createFormatAdapters().find(x=>x.format==='dwg');
    const result=await after.readCached(source,{representation:'native',address:{unitId:units[0].id}},units[0],version);
    assert.equal(result.address.unitId,units[0].id);
    const archivedRead=() => after.readCached(jsonSource,{representation:'native',address:{unitId:oldUnit.id}},oldUnit,oldVersion);
    const historic=await archivedRead();
    assert.ok(JSON.parse(historic.bytes).lines.some(line=>line.text==='Detail'));
    assert.equal(await after.readCached(jsonSource,{representation:'native',address:{unitId:oldUnit.id}},oldUnit,version),undefined);
    const indexDir=join(root,'dwg-index');
    for (const name of await readdir(indexDir)) await rm(join(indexDir,name));
    const rebuilt=await after.readCached(source,{representation:'native',address:{unitId:units[0].id}},units[0],version);
    assert.equal(rebuilt.address.unitId,units[0].id);
    assert.deepEqual((await archivedRead()).bytes,historic.bytes);
    process.env.FACADE_DWG_FONT_DIR=join(root,'different-fonts');
    const changedFonts=createFormatAdapters().find(x=>x.format==='dwg');
    assert.notEqual((await changedFonts.version()).split(':').at(-1),oldVersion.split(':').at(-1));
    assert.deepEqual((await changedFonts.readCached(jsonSource,
      {representation:'native',address:{unitId:oldUnit.id}},oldUnit,oldVersion)).bytes,historic.bytes);
    const oldSaved=await verifyDwgFile(jsonSource,oldHash);
    await rm(oldSaved.path);
    for (const name of await readdir(indexDir)) await rm(join(indexDir,name));
    assert.equal(await archivedRead(),undefined);
    assert.equal(conversions,3);
    const saved=await verifyDwgFile(source,meta.sha256,meta.size);
    await chmod(saved.path,0o600); await writeFile(saved.path,Buffer.from('tampered'));
    await assert.rejects(verifyDwgFile(source,meta.sha256,meta.size),{code:'dwg_derivative_invalid'});
    const missingRoot=join(root,'not-a-directory'); await writeFile(missingRoot,'x'); process.env.FACADE_DATA_DIR=missingRoot;
    assert.equal((await after.inspect(original,source))[0].locator.coverage,'held');
  } finally {
    if(!stopped){server.closeAllConnections(); await new Promise(ok=>server.close(ok));}
    if(oldDir===undefined) delete process.env.FACADE_DATA_DIR; else process.env.FACADE_DATA_DIR=oldDir;
    if(oldSocket===undefined) delete process.env.FACADE_CONVERTER_SOCKET; else process.env.FACADE_CONVERTER_SOCKET=oldSocket;
    if(oldFontDir===undefined) delete process.env.FACADE_DWG_FONT_DIR; else process.env.FACADE_DWG_FONT_DIR=oldFontDir;
    await rm(root,{recursive:true,force:true});
  }
});

test('same DWG bytes get separate durable version addresses and keep legacy and new derivative pins readable',async t=>{
  const {createFormatAdapters}=await load('formats/index.js');
  const {openDwgIndex,buildDwgIndex}=await load('formats/dwg-index.js');
  const {verifyDwgFile}=await load('formats/dwg-durable.js');
  const {reuseStoredDwgDerivative}=await load('pdf/dwg-derivative.js');
  const root=await mkdtemp(join(tmpdir(),'dwg-version-reuse-'));
  const priorDir=process.env.FACADE_DATA_DIR, priorSocket=process.env.FACADE_CONVERTER_SOCKET;
  const socket=join(root,'convert.sock'), original=join(root,'same.dwg');
  process.env.FACADE_DATA_DIR=root;
  process.env.FACADE_CONVERTER_SOCKET=socket;
  t.after(async()=>{
    if (priorDir===undefined) delete process.env.FACADE_DATA_DIR; else process.env.FACADE_DATA_DIR=priorDir;
    if (priorSocket===undefined) delete process.env.FACADE_CONVERTER_SOCKET; else process.env.FACADE_CONVERTER_SOCKET=priorSocket;
    await rm(root,{recursive:true,force:true});
  });
  const originalBytes=Buffer.from('AC1015 same DWG');
  await writeFile(original,originalBytes);
  const dxf=text=>Buffer.from(`0\nSECTION\n2\nENTITIES\n0\nTEXT\n5\nA\n10\n1\n20\n2\n40\n5\n1\n${text}\n0\nENDSEC\n0\nEOF\n`);
  const first=dxf('Prior pinned note'), changed=dxf('Nondeterministic new conversion');
  const identity='sha256:'+'9'.repeat(64);
  let payload=first, calls=0;
  const server=createServer((_req,res)=>res.end(JSON.stringify({dwgEngine:'oda',dwg:'sha256:'+'8'.repeat(64),
    dwgIdentity:identity,dwgClientTimeoutMs:4000,dwgReserveBytes:1})));
  server.on('checkContinue',(req,res)=>{
    calls++;
    res.writeContinue();
    req.on('end',()=>{
      res.writeHead(200,{'x-converter-bytes':String(payload.length),trailer:'x-converter-result, x-converter-bytes, x-converter-sha256'});
      res.write(payload);
      res.addTrailers({'x-converter-result':'ok','x-converter-sha256':sha(payload),'x-converter-bytes':String(payload.length)});
      res.end();
    });
    req.resume();
  });
  server.listen(socket);
  await once(server,'listening');
  try {
    const adapter=createFormatAdapters().find(item=>item.format==='dwg'), version=await adapter.version();
    const duplicate=source=>({...source,versionId:randomUUID(),documentId:randomUUID()});
    const source={projectId:randomUUID(),documentId:randomUUID(),versionId:randomUUID(),sha256:sha(originalBytes)};
    const copy=duplicate(source), fallback=duplicate(source), missing=duplicate(source);
    const map=await adapter.inspect(original,source);
    const stored=await adapter.durableInfo(source,map,version);
    assert.equal(calls,1);
    // Move the test index to the namespace used before the derivative became part of its key.
    const indexDir=join(root,'dwg-index');
    for (const name of await readdir(indexDir)) await rm(join(indexDir,name));
    const legacyPin={source,converter:identity,reserve:0};
    const handle=await open(join(root,stored.storageKey),'r');
    try { await (await buildDwgIndex(handle,stored.sha256,identity,legacyPin)).close(); } finally { await handle.close(); }
    const request=units=>({representation:'native',address:{unitId:units[0].id}});
    const old=await adapter.readCached(source,request(map),map[0],version);
    const db={async query(sql,[projectId,originalSha,profile,converter,versionId,expected]){
      assert.match(sql,/m.original_sha256=d.original_sha256/u);
      assert.match(sql,/d.project_id=\$1 AND d.original_sha256=\$2 AND d.reader_version=\$3 AND d.converter_identity=\$4/u);
      assert.equal(projectId,source.projectId);
      assert.equal(originalSha,source.sha256);
      assert.equal(profile,version);
      assert.equal(converter,identity);
      assert.notEqual(versionId,source.versionId);
      return {rows:[{documentId:source.documentId,versionId:source.versionId,derivative:stored.sha256,
        byteSize:stored.size,storageKey:stored.storageKey,units:map}].filter(row=>!expected || expected===row.derivative)};
    }};
    payload=changed;
    // The original revision can restore its metadata from verified bytes without a sibling.
    assert.deepEqual(await adapter.inspect(original,source,stored.sha256),map);
    assert.equal(calls,1);
    const reused=await reuseStoredDwgDerivative(db,copy,version);
    assert.deepEqual(reused,map);
    assert.equal(calls,1);
    const copied=await adapter.durableInfo(copy,reused,version);
    assert.equal(copied.sha256,stored.sha256);
    assert.notEqual(copied.storageKey,stored.storageKey);
    assert.deepEqual((await adapter.readCached(copy,request(reused),reused[0],version)).bytes,old.bytes);

    const saved=await verifyDwgFile(source,stored.sha256,stored.size);
    await rm(saved.path);
    assert.equal(await reuseStoredDwgDerivative(db,missing,version),undefined);
    const fresh=await adapter.inspect(original,fallback);
    assert.equal(calls,2);
    assert.equal((await adapter.durableInfo(fallback,fresh,version)).sha256,sha(changed));
    assert.deepEqual((await adapter.readCached(source,request(map),map[0],version)).bytes,old.bytes);
    assert.notDeepEqual((await adapter.readCached(fallback,request(fresh),fresh[0],version)).bytes,old.bytes);
    const separate=await openDwgIndex({...legacyPin,source:fallback,derivative:sha(changed)});
    assert.equal(separate.identity.derivative,sha(changed));
    await separate.close();
    await assert.rejects(adapter.inspect(original,source,stored.sha256),{code:'dwg_index_identity_changed'});
    assert.equal(await verifyDwgFile(source,sha(changed)),undefined);
  } finally {
    server.closeAllConnections();
    await new Promise(resolveClose=>server.close(resolveClose));
  }
});
