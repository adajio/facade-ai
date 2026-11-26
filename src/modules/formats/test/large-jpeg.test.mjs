import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, truncate, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import sharp from 'sharp';

const {createRasterAdapter} = await import('../../../../dist/src/modules/formats/raster.js');
const {buildMap} = await import('../../../../dist/src/modules/harness/dispatch.js');
const raster = createRasterAdapter();
const sha = value => createHash('sha256').update(value).digest('hex');

function resizedHeader(bytes,width,height,{progressive=false}={}) {
  const changed = Buffer.from(bytes);
  let start=2;
  while (start<bytes.length && bytes[start]===0xff) {
    const marker=bytes[start+1];
    if (marker===0xc0) {
      if (progressive) changed[start+1]=0xc2;
      changed.writeUInt16BE(height,start+5);
      changed.writeUInt16BE(width,start+7);
      return changed;
    }
    start+=2+bytes.readUInt16BE(start+2);
  }
  throw Error('baseline JPEG header was not found');
}

test('oversized baseline JPEG keeps full original geometry, renders a pixel-identical crop and supports OCR', async t => {
  const dir=await mkdtemp(join(tmpdir(),'facade-large-jpeg-'));
  t.after(()=>rm(dir,{recursive:true,force:true}));
  const path=join(dir,'large.jpg');
  const width=8500,height=7600;
  const label=Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="480" height="160"><rect x="0" y="0" width="20" height="160" fill="red"/><text x="50" y="108" font-size="65" font-family="sans-serif" fill="black">FACADE 427</text></svg>');
  await sharp({create:{width,height,channels:3,background:'white'}})
    .composite([{input:label,left:width-480,top:height-160}]).jpeg({quality:93}).toFile(path);
  const source={projectId:randomUUID(),documentId:randomUUID(),versionId:randomUUID(),sha256:sha(await readFile(path))};
  const [unit]=await raster.inspect(path,source);
  assert.deepEqual([unit.width,unit.height,unit.locator.page,unit.locator.rasterFormat],[width,height,1,'jpeg']);
  const map=await buildMap({...source,format:'image'},async()=>({source,units:[unit],format:'image',readerVersion:await raster.version()}));
  assert.match(map.readerVersion,/^raster-v1:/);
  assert.match(map.physical.basisId,/^inventory-v1:/);
  assert.ok(map.units.length>1 && map.units.some(({box})=>box.x+box.width===width && box.y+box.height===height));
  const preview=await raster.read(path,{address:{unitId:'1'},representation:'render'},unit);
  assert.deepEqual([preview.transform.width,preview.transform.pixelOriginX,preview.transform.pixelOriginY],[2048,0,0]);
  const box={x:width-480,y:height-160,width:480,height:160};
  const address={unitId:'1',box};
  const crop=await raster.read(path,{address,representation:'render'},unit);
  assert.deepEqual(crop.transform,{width:480,height:160,pixelsPerPoint:1,pixelOriginX:box.x,pixelOriginY:box.y});
  const independentPixels=await sharp(path,{limitInputPixels:144_000_000})
    .extract({left:box.x,top:box.y,width:box.width,height:box.height}).raw().toBuffer();
  assert.deepEqual(await sharp(crop.bytes).raw().toBuffer(),independentPixels);
  await assert.rejects(raster.read(path,{address:{unitId:'1',box:{...box,x:box.x+1}},representation:'render'},unit),
    {code:'reader_address_invalid'});
  await assert.rejects(raster.read(path,{address:{unitId:'1'},representation:'render'},{...unit,width:width-1}),
    {code:'raster_geometry_unavailable'});
  if ((await raster.version()).includes('ocr=unavailable')) return t.diagnostic('OCR check requires Tesseract rus+eng');
  const native=await raster.read(path,{address:{unitId:'1'},representation:'native'},unit);
  assert.equal(native.inputImage.transform.width,2200);
  assert.ok(native.limitations.includes('raster_ocr_large_sheet_overview'));
  const ocr=await raster.read(path,{address,representation:'ocr'},unit);
  const line=ocr.lines.find(({text})=>/FACADE\s+427/u.test(text));
  assert.ok(line);
  assert.ok(line.box.x>=box.x && line.box.y>=box.y && line.box.x+line.box.width<=width && line.box.y+line.box.height<=height);
});

test('oversized JPEG policy rejects invalid dimensions, progressive frames, corrupt bytes and excessive files', async t => {
  const dir=await mkdtemp(join(tmpdir(),'facade-large-jpeg-rejection-'));
  t.after(()=>rm(dir,{recursive:true,force:true}));
  const path=join(dir,'rejected.jpg');
  const sample=await sharp({create:{width:64,height:40,channels:3,background:'white'}}).jpeg().toBuffer();
  for (const [bytes,code] of [
    [resizedHeader(sample,16_385,160),'raster_dimension_limit'],
    [resizedHeader(sample,12_000,13_000),'raster_dimension_limit'],
    [resizedHeader(sample,8500,7600,{progressive:true}),'raster_large_jpeg_profile'],
    [resizedHeader(sample,8500,7600).subarray(0,-5),'raster_invalid_or_unreadable'],
  ]) {
    await writeFile(path,bytes);
    await assert.rejects(raster.inspect(path),{code});
  }
  await truncate(path,128*1024**2+1);
  await assert.rejects(raster.inspect(path),{code:'raster_byte_limit'});
});
