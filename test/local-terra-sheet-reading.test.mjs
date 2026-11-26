import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createFormatAdapters } from '../dist/src/modules/formats/index.js';
import { readSheetEvidence, sheetHeading } from '../infra/local-terra/sheet-reading.mjs';

const uuid = n => `9d66e74c-21a0-4342-90ac-${String(n).padStart(12,'0')}`;
const sha = bytes => createHash('sha256').update(bytes).digest('hex');

test('sheet headings distinguish named layouts, dimensioned views, literal legends and references',()=>{
  assert.equal(sheetHeading('12_фасады 1-8',{layout:true}).kind,'facade');
  assert.equal(sheetHeading('План подвала').kind,'plan');
  assert.equal(sheetHeading('Колористическое решение фасадов').kind,'facade');
  assert.equal(sheetHeading('Узел примыкания').kind,'detail');
  assert.equal(sheetHeading('\\pxi-1;Условные обозначения:\nКладка кирпичная').relevantLegend,true);
  assert.equal(sheetHeading('Условные обозначения см. на листе 5'),undefined);
  assert.equal(sheetHeading('Уточнить план первого этажа'),undefined);
  assert.equal(sheetHeading('Фасад необходимо показать на чертеже'),undefined);
});

function dxf(layout, withDrawing) {
  let next = 16;
  const handle = () => (next++).toString(16).toUpperCase();
  const line = (x,y,x2,y2) => [0,'LINE',5,handle(),8,'A',67,1,410,layout,10,x,20,y,11,x2,21,y2];
  const records = [
    0,'SECTION',2,'ENTITIES',
    ...line(0,0,300,0), ...line(300,0,300,220), ...line(300,220,0,220), ...line(0,220,0,0),
    0,'TEXT',5,handle(),8,'A',67,1,410,layout,10,25,20,190,40,8,1,'Elevation 1-8',
  ];
  if (withDrawing) {
    for (let i=1;i<=9;i++) {
      records.push(...line(20+i*25,50,20+i*25,170), ...line(20,47+i*12,270,47+i*12));
    }
  }
  records.push(0,'ENDSEC',0,'EOF');
  return Buffer.from(records.join('\n')+'\n');
}

test('bounded sheet preparation rejects changed originals and title-only graphics, then returns pinned PNG',async t=>{
  const folder = await mkdtemp(join(tmpdir(),'facade-sheet-reading-test-'));
  t.after(()=>rm(folder,{recursive:true,force:true}));
  const facade = dxf('Elevation',true), frame = dxf('Elevation',false);
  const wrong = Buffer.from(facade); wrong[8] ^= 1;
  const reader = createFormatAdapters().find(adapter=>adapter.format==='dxf');
  const readerVersion = await reader.version();
  const objects = new Map();
  const records = [];
  const snapshot = {projectId:uuid(1),receiptId:uuid(2),preparationId:uuid(3),indexCursor:[],lines:[],files:[]};
  const expectedBytes = [facade,frame,facade];
  for (const [i,bytes] of expectedBytes.entries()) {
    const versionId = uuid(10+i), documentId = uuid(100+i);
    const path = join(folder,`original-${i}.dxf`);
    await writeFile(path,bytes);
    const units = await reader.inspect(path);
    const unit = units.find(item=>item.locator?.space==='Elevation');
    assert.ok(unit, JSON.stringify(units));
    const objectKey = `original-${i}`;
    const originalSha256 = sha(bytes);
    objects.set(objectKey,{expected:bytes,actual:i===0 ? wrong : bytes});
    const native = await reader.read(path,{representation:'native',address:{unitId:unit.id}},unit);
    const line = native.lines.find(entry=>entry.text==='Elevation 1-8');
    assert.ok(line);
    const address = {unitId:unit.id,locator:line.locator};
    snapshot.files.push({versionId,originalSha256,path:`${objectKey}.dxf`});
    snapshot.indexCursor.push({versionId,readerVersion,contract:2,processedUnits:1});
    snapshot.lines.push({id:`L${i+1}`,versionId,originalSha256,text:line.text,
      anchor:JSON.stringify({unitId:unit.id,lineId:line.id,address,readerVersion,blockId:`block-${i}`,blockOrdinal:0,ordinal:0})});
    records.push({versionId,documentId,originalSha256,readerVersion,format:'dxf',unit,
      originalObjectKey:objectKey,originalSize:bytes.length,totalSources:3,totalUnits:1});
  }
  const retrieved = [];
  const server = createServer((request,reply)=>{
    const key = new URL(request.url,'http://localhost').pathname.split('/').at(-1);
    const object = objects.get(key);
    if (!object) { reply.writeHead(404).end(); return; }
    reply.setHeader('x-amz-meta-sha256',sha(object.expected));
    reply.setHeader('content-length',object.expected.length);
    if (request.method==='HEAD') { reply.end(); return; }
    assert.equal(request.method,'GET');
    retrieved.push(key);
    reply.end(object.actual);
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(()=>new Promise(resolve=>{ server.close(resolve); server.closeAllConnections(); }));
  const vars = {FACADE_DATA_DIR:folder,FACADE_S3_ENDPOINT:`http://127.0.0.1:${server.address().port}`,
    FACADE_S3_BUCKET:'fixtures',AWS_ACCESS_KEY_ID:'synthetic',AWS_SECRET_ACCESS_KEY:'synthetic'};
  for (const [name,value] of Object.entries(vars)) {
    const before = process.env[name];
    process.env[name] = value;
    t.after(()=>{ if (before===undefined) delete process.env[name]; else process.env[name]=before; });
  }
  const db = { async connect() { return { async query(sql,params) {
    if (sql.startsWith('WITH scoped')) {
      assert.deepEqual(params.slice(0,3),[snapshot.projectId,snapshot.receiptId,snapshot.preparationId]);
      assert.match(sql,/intake_package_preparation_current/u);
      assert.match(sql,/hm.active/u);
      assert.match(sql,/occ.receipt_id=\$2/u);
      return {rows:records};
    }
    assert.match(sql,/^(?:BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY|SELECT set_config|COMMIT|ROLLBACK)/u);
    return {rows:[]};
  }, release() {} }; } };
  const result = await readSheetEvidence(db,snapshot,{maxImages:1,elementTimeoutMs:8000,timeoutMs:30000});
  assert.deepEqual(retrieved,['original-0','original-1','original-2'],JSON.stringify(result.limitations));
  assert.deepEqual(result.limitations.map(({reason})=>reason),['sheet_original_mismatch','sheet_graphics_not_visible']);
  assert.equal(result.candidates.length,3);
  assert.equal(result.images.length,1);
  const [image] = result.images;
  assert.equal(image.versionId,records[2].versionId);
  assert.equal(image.originalSha256,records[2].originalSha256);
  assert.equal(image.preparationId,snapshot.preparationId);
  assert.equal(image.readerVersion,readerVersion);
  assert.equal(image.address.unitId,records[2].unit.id);
  assert.equal(image.request.renderProfile,'sheet-reading-v1');
  assert.deepEqual(image.lineIds,['L3']);
  assert.ok(image.address.box.width>0);
  assert.ok(image.transform.width*image.transform.height<=1_000_000);
  const bytes = Buffer.from(image.pngBase64,'base64');
  assert.equal(bytes.length,image.byteSize);
  assert.equal(sha(bytes),image.sha256);
  assert.equal(bytes.subarray(1,4).toString(),'PNG');
  assert.equal(result.candidates[2].imageId,image.id);
});
