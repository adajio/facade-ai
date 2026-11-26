import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { chmod, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
const dist = process.env.FACADE_STEP11_DIST ?? resolve('dist');
const load = name => import(pathToFileURL(join(dist,'src/modules',name)));
const sha = bytes => createHash('sha256').update(bytes).digest('hex');

test('DWG derivative and pinned parts survive a restarted reader without converter; corruption is rejected', async () => {
  const {createFormatAdapters} = await load('formats/index.js');
  const {verifyDwgFile} = await load('formats/dwg-durable.js');
  const root=await mkdtemp(join(tmpdir(),'dwg-durable-'));
  const oldDir=process.env.FACADE_DATA_DIR, oldSocket=process.env.FACADE_CONVERTER_SOCKET;
  const socket=join(root,'converter.sock'), original=join(root,'original.dwg');
  const image='sha256:'+'a'.repeat(64);
  const bytes=Buffer.from('0\nSECTION\n2\nENTITIES\n0\nLINE\n5\nA\n10\n1\n20\n2\n11\n3\n21\n4\n0\nENDSEC\n0\nEOF\n');
  const source={projectId:randomUUID(),documentId:randomUUID(),versionId:randomUUID(),sha256:'b'.repeat(64)};
  await writeFile(original,'AC1015A'); process.env.FACADE_DATA_DIR=root; process.env.FACADE_CONVERTER_SOCKET=socket;
  let conversions=0, payload=bytes;
  const server=createServer((_req,res)=>res.end(JSON.stringify({dwgEngine:'libredwg',dwg:image,dwgIdentity:image,dwgClientTimeoutMs:4000,dwgReserveBytes:1})));
  server.on('checkContinue',(req,res)=>{conversions++;res.writeContinue();req.on('end',()=>{
    res.writeHead(200,{'x-converter-bytes':String(payload.length),trailer:'x-converter-result, x-converter-bytes, x-converter-sha256'});
    res.write(payload);res.addTrailers({'x-converter-result':'ok','x-converter-sha256':sha(payload),'x-converter-bytes':String(payload.length)});res.end();});req.resume();});
  let stopped=false;
  try {
    server.listen(socket); await once(server,'listening');
    const adapter=createFormatAdapters().find(x=>x.format==='dwg');
    const version=await adapter.version();
    const units=await adapter.inspect(original,source);
    assert.equal(conversions,1);
    const meta=await adapter.durableInfo(source,units,version);
    assert.equal(meta.sha256,sha(bytes)); assert.equal(meta.size,bytes.length); assert.equal(meta.format,'dxf');
    payload=Buffer.from(JSON.stringify({created_by:'LibreDWG fixture',OBJECTS:[{entity:'TEXT',entmode:2,text_value:'Detail',ins_pt:[0,0],height:1}]}));
    const jsonSource={...source,versionId:randomUUID(),sha256:'c'.repeat(64)};
    const jsonUnits=await adapter.inspect(original,jsonSource);
    const jsonMeta=await adapter.durableInfo(jsonSource,jsonUnits,version);
    assert.equal(jsonMeta.format,'dwg-json'); assert.equal(jsonMeta.sha256,sha(payload));
    payload=bytes;
    const blocked=join(root,'blocked'); await writeFile(blocked,'x'); process.env.FACADE_DATA_DIR=blocked;
    await assert.rejects(adapter.inspect(original,{...source,projectId:randomUUID()}));
    process.env.FACADE_DATA_DIR=root;
    server.closeAllConnections(); await new Promise(ok=>server.close(ok)); stopped=true;
    const after=createFormatAdapters().find(x=>x.format==='dwg');
    const result=await after.readCached(source,{representation:'native',address:{unitId:units[0].id}},units[0],version);
    assert.equal(result.address.unitId,units[0].id);
    const indexDir=join(root,'dwg-index');
    for (const name of await readdir(indexDir)) await rm(join(indexDir,name));
    const rebuilt=await after.readCached(source,{representation:'native',address:{unitId:units[0].id}},units[0],version);
    assert.equal(rebuilt.address.unitId,units[0].id);
    const saved=await verifyDwgFile(source,meta.sha256,meta.size);
    await chmod(saved.path,0o600); await writeFile(saved.path,Buffer.from('tampered'));
    await assert.rejects(verifyDwgFile(source,meta.sha256,meta.size),{code:'dwg_derivative_invalid'});
    const missingRoot=join(root,'not-a-directory'); await writeFile(missingRoot,'x'); process.env.FACADE_DATA_DIR=missingRoot;
    assert.equal((await after.inspect(original,source))[0].locator.coverage,'held');
  } finally {
    if(!stopped){server.closeAllConnections(); await new Promise(ok=>server.close(ok));}
    if(oldDir===undefined) delete process.env.FACADE_DATA_DIR; else process.env.FACADE_DATA_DIR=oldDir;
    if(oldSocket===undefined) delete process.env.FACADE_CONVERTER_SOCKET; else process.env.FACADE_CONVERTER_SOCKET=oldSocket;
    await rm(root,{recursive:true,force:true});
  }
});
