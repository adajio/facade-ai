import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { pathToFileURL } from 'node:url';

const fail = code => { throw Object.assign(new Error(code), { code }); };
const pngSignature = Buffer.from([137,80,78,71,13,10,26,10]);
const rendererSide = 1000;
const maxPngBytes = 4 * 1024 ** 2;
const materialText = /(?:ral|ncs|лицев|цвет|утепл|кладк|облицов|отделк|кирпич|плит|штукатур|панел|гибк|анкер)/iu;
const maxInputBytes = { pdf: 128 * 1024 ** 2, dxf: 16 * 1024 ** 2, dwg: 512 * 1024 ** 2 };
const number = value => typeof value === 'number' && Number.isFinite(value);

export const renderProfile = 'sheet-reading-v1';

function contains(outer, inner) {
  return inner && [inner.x, inner.y, inner.width, inner.height].every(number)
    && inner.x >= 0 && inner.y >= 0 && inner.width > 0 && inner.height > 0
    && inner.x + inner.width <= outer.width + 1e-7 && inner.y + inner.height <= outer.height + 1e-7;
}

function focusedBox(frame, target, kind, anchor) {
  const w = target.right - target.left;
  const h = target.bottom - target.top;
  const anchorHeight = anchor.textSpans?.find(span=>span.text.trim())?.height ?? anchor.height;
  if (kind==='legend' && anchorHeight > 0) {
    // A multiline note may contain a short legend and a long instructions section.
    // The first baseline and text scale locate the swatches and the first legend rows.
    const first = target.left - frame.x;
    const baseline = -anchor.y - frame.y;
    const x = Math.max(0,first - anchorHeight * 15);
    const y = Math.max(0,baseline - anchorHeight * 5);
    const right = Math.min(frame.width,first + anchorHeight * 65);
    const bottom = Math.min(frame.height,baseline + anchorHeight * 48);
    return { x,y,width:right-x,height:bottom-y };
  }
  const horizontal = Math.max(w * 1.25,h * 4);
  const descent = Math.max(w * .6,h * 4);
  const x = Math.max(0,target.left - frame.x - horizontal);
  const y = Math.max(0,target.top - frame.y - Math.max(h * 2,w * 1.4));
  const right = Math.min(frame.width,target.right - frame.x + horizontal);
  const bottom = Math.min(frame.height,target.bottom - frame.y + descent);
  return { x,y,width:right-x,height:bottom-y };
}

function focusHandle(locator) {
  return locator?.derivativeHandle ?? locator?.handle
    ?? (locator?.entityOrdinal === undefined ? undefined : `ordinal:${locator.entityOrdinal}`);
}

function vectorShapes(shapes) {
  return (shapes ?? []).flatMap(shape => {
    if (shape.pieces) {
      const pieces = vectorShapes(shape.pieces);
      return pieces.length ? [{...shape,pieces}] : [];
    }
    if (shape.area || shape.block || shape.radius || shape.path || shape.x2 !== undefined && shape.y2 !== undefined) {
      return [shape];
    }
    return [];
  });
}

async function hasDistributedInk(sharp, bytes) {
  const {data,info:{width,height}} = await sharp(bytes).flatten({background:'#fff'}).raw().toBuffer({resolveWithObject:true});
  const x0 = Math.floor(width*.12), x1 = Math.ceil(width*.88);
  const y0 = Math.floor(height*.12), y1 = Math.ceil(height*.88);
  const cells = new Uint32Array(100);
  let marked = 0;
  for (let y=y0; y<y1; y++) for (let x=x0; x<x1; x++) {
    const offset = 3*(y*width+x);
    if (Math.min(data[offset],data[offset+1],data[offset+2])>=205) continue;
    marked++;
    const column = Math.floor(10*(x-x0)/(x1-x0)), row = Math.floor(10*(y-y0)/(y1-y0));
    cells[10*row+column]++;
  }
  const rows = new Set(), columns = new Set();
  let occupied = 0;
  for (const [i,ink] of cells.entries()) if (ink>=3) {
    rows.add(Math.floor(i/10));
    columns.add(i%10);
    occupied++;
  }
  return marked >= Math.max(45,(x1-x0)*(y1-y0)*.007)
    && rows.size >= 4 && columns.size >= 4 && occupied >= 12;
}

export async function createRasterSession(sourceRoot, scratch) {
  const built = path => import(pathToFileURL(join(sourceRoot,'dist/src/modules',path)).href);
  const [{ createIntakeStorage }, { createPdfAdapter }, { createFormatAdapters }, { openDwgIndex },
    { verifyDwgFile }, { parseDwgVersion }, { dwgFontAssets, emptyDwgFontAssets },
    { cadFrame, cadShapeBounds, envelopeOf }, { renderCad }, { parseDxf }] = await Promise.all([
    built('intake/blob.js'), built('pdf/pdf-adapter.js'), built('formats/index.js'), built('formats/dwg-index.js'),
    built('formats/dwg-durable.js'), built('formats/dwg-profile.js'), built('formats/cad-font-assets.js'),
    built('formats/cad-bounds.js'), built('formats/cad-render.js'), built('formats/spatial.js'),
  ]);
  const sharp = createRequire(join(sourceRoot,'src/modules/formats/package.json'))('sharp');
  const storage = createIntakeStorage(process.env.FACADE_DATA_DIR);
  const pdf = createPdfAdapter({ ocrLanguages:process.env.FACADE_PDF_OCR_LANGUAGES,
    profile:process.env.FACADE_READER_PROFILE });
  const dxf = createFormatAdapters().find(adapter => adapter.format === 'dxf');
  const originals = new Map();
  const fonts = dwgFontAssets();

  async function openOriginal(source) {
    if (!Number.isSafeInteger(source.originalSize) || source.originalSize < 1
      || source.originalSize > maxInputBytes[source.format]) fail('sheet_original_limit');
    const key = source.versionId;
    const metadata = await storage.objects.head(source.originalObjectKey);
    if (metadata?.sha256 !== source.originalSha256 || metadata.size !== source.originalSize) {
      fail('sheet_original_unavailable');
    }
    if (source.format === 'dwg') return;
    if (originals.has(key)) return originals.get(key);
    const path = join(scratch, key);
    let size = 0;
    const hash = createHash('sha256');
    await pipeline(await storage.objects.get(source.originalObjectKey), async function* (stream) {
      for await (const chunk of stream) {
        size += chunk.length;
        if (size > source.originalSize) fail('sheet_original_mismatch');
        hash.update(chunk);
        yield chunk;
      }
      if (size !== source.originalSize || hash.digest('hex') !== source.originalSha256) fail('sheet_original_mismatch');
    }, createWriteStream(path, { flags:'w', mode:0o600 }));
    originals.set(key,path);
    return path;
  }

  async function drawCad(candidate, path) {
    const { documentId, versionId, projectId, originalSha256, readerVersion, format, unit } = candidate;
    const source = { documentId, versionId, projectId, sha256:originalSha256 };
    let index, cadUnit, selectedFonts;
    try {
      if (format === 'dwg') {
        const { derivativeSha256, derivativeFormat, converterIdentity } = unit.locator ?? {};
        const pin = parseDwgVersion(readerVersion);
        const derivative = candidate.derivative;
        if (!pin || pin.converter !== converterIdentity || !derivative
          || derivative.readerVersion !== readerVersion || derivative.derivativeSha256 !== derivativeSha256
          || derivative.format !== derivativeFormat || !Number.isSafeInteger(derivative.byteSize)
          || derivative.byteSize < 1 || derivative.byteSize > maxInputBytes.dwg) fail('sheet_derivative_unpinned');
        if (!await verifyDwgFile(source, derivativeSha256, derivative.byteSize, true)) fail('sheet_derivative_unavailable');
        selectedFonts = pin.fonts === emptyDwgFontAssets.identity ? emptyDwgFontAssets : fonts;
        if (pin.fonts !== selectedFonts.identity) fail('sheet_reader_profile_changed');
        index = await openDwgIndex({ source, converter:pin.converter, profile:pin.profile, reserve:0 }, selectedFonts);
        if (!index) fail('sheet_dwg_index_unavailable');
        if (index.identity.derivative !== derivativeSha256 || index.identity.kind !== derivativeFormat) {
          fail('sheet_derivative_mismatch');
        }
        cadUnit = index.read(unit).unit;
      } else {
        if (await dxf.version() !== readerVersion) fail('sheet_reader_profile_changed');
        const parsed = await parseDxf(await readFile(path));
        cadUnit = parsed.units.find(item => item.id === unit.id);
      }
      const frame = cadUnit && cadFrame(cadUnit);
      if (!frame || frame.width !== unit.width || frame.height !== unit.height) fail('sheet_address_mismatch');
      if (!cadUnit.cad?.length) fail('sheet_no_geometry');
      const handle = candidate.focus ? focusHandle(candidate.address.locator) : undefined;
      const selected = handle && cadUnit.cad.filter(shape => shape.handle === handle);
      if (candidate.focus && !selected?.length) fail('sheet_entity_geometry_unavailable');
      const box = selected ? focusedBox(frame,envelopeOf(selected),candidate.kind,selected[0]) : undefined;
      if (box && !contains(frame,box)) fail('sheet_address_mismatch');
      const contributors = [];
      const nearby = [{unitId:unit.id,shapes:cadUnit.cad}];
      let adjacentUnavailable = false;
      if (index && box && unit.locator?.part) {
        const seen = new Set([...cadUnit.cad,...cadUnit.cadContext ?? []].map(shape=>`${shape.handle}:${shape.order}`));
        const context = [...cadUnit.cadContext ?? []];
        const x0 = frame.x+box.x, y0 = frame.y+box.y;
        const x1 = x0+box.width, y1 = y0+box.height;
        for (const neighbour of candidate.neighbours ?? []) {
          if (!neighbour || neighbour.locator?.space!==unit.locator.space || neighbour.locator?.view!==unit.locator.view
            || typeof neighbour.locator.part !== 'number' || Math.abs(neighbour.locator.part-unit.locator.part)>2 || neighbour.id===unit.id) continue;
          try {
            const {unit:adjacent} = index.read(neighbour);
            const intersections = (adjacent.cad ?? []).filter(shape=>{
              const {left,top,right,bottom} = cadShapeBounds(shape);
              return x1>=left && x0<=right && y1>=top && y0<=bottom;
            });
            let used = false;
            for (const shape of intersections) {
              const key = `${shape.handle}:${shape.order}`;
              if (seen.has(key)) continue;
              context.push(shape);
              seen.add(key);
              used = true;
            }
            if (used) {
              contributors.push({unitId:neighbour.id,locator:neighbour.locator});
              nearby.push({unitId:neighbour.id,shapes:intersections});
            }
          } catch { adjacentUnavailable = true; }
        }
        cadUnit = {...cadUnit,cadView:frame,cadContext:context};
      }
      const address = { unitId:unit.id, locator:handle ? candidate.address.locator : unit.locator, ...(box && {box}) };
      const load = index && (digest => index.definition(digest));
      const geometry = { ...cadUnit,cadView:frame,cad:vectorShapes(cadUnit.cad),cadContext:vectorShapes(cadUnit.cadContext) };
      const probeLoad = load && (digest => ({shapes:vectorShapes(load(digest).shapes)}));
      let probe;
      try { probe = renderCad(geometry,{unitId:unit.id,box},undefined,probeLoad,selectedFonts,undefined,300); }
      catch (error) {
        if (error?.code !== 'cad_entity_geometry_unavailable') throw error;
      }
      if (!probe || !await hasDistributedInk(sharp,probe.bytes)) fail('sheet_graphics_not_visible');
      const highlight = candidate.kind==='legend' ? undefined : handle;
      const image = renderCad(cadUnit,address,highlight,load,selectedFonts,undefined,rendererSide);
      if (!image) fail('sheet_no_geometry');
      const inside = [];
      if (candidate.kind==='legend' || candidate.kind==='detail') {
        for (const {unitId,shapes} of nearby) for (const shape of shapes) {
          if (!shape.text || shape.handle===handle || !materialText.test(shape.text)) continue;
          const {left,top,right,bottom} = cadShapeBounds(shape);
          if (!contains(image.crop,{x:left-frame.x-image.crop.x,y:top-frame.y-image.crop.y,
            width:right-left,height:bottom-top})) continue;
          inside.push({unitId,handle:shape.handle});
        }
      }
      return { bytes:image.bytes, transform:image.transform, address:{...address, box:image.crop}, inside:inside.slice(0,10),
        request:{ representation:'render', address, readerVersion, renderProfile, maxSide:rendererSide,
          ...(contributors.length && {contributors}) },
        limitations:[...new Set([...cadUnit.limitations,'cad_preview_schematic',
          ...(adjacentUnavailable ? ['sheet_adjacent_part_unavailable'] : [])])] };
    } finally {
      await index?.close();
    }
  }

  async function drawPdf(candidate, path) {
    if (await pdf.version() !== candidate.readerVersion) fail('sheet_reader_profile_changed');
    const { unit } = candidate;
    const anchorBox = candidate.focus ? candidate.address.box : undefined;
    const limited = Math.max(unit.width,unit.height);
    let box = { x:0,y:0,width:unit.width,height:unit.height };
    if (contains(unit, anchorBox)) {
      const margin = Math.max(12,Math.min(limited * .16,Math.max(anchorBox.width*.5, anchorBox.height*3)));
      const x = Math.max(0, anchorBox.x-margin), y = Math.max(0, anchorBox.y-margin/2);
      const right = Math.min(unit.width, anchorBox.x+anchorBox.width+margin);
      const bottom = Math.min(unit.height, anchorBox.y+anchorBox.height+margin*1.5);
      box = { x,y,width:right-x,height:bottom-y };
    }
    const dpi = Math.max(1,Math.min(216,Math.floor(72 * (rendererSide - 2) / Math.max(box.width,box.height))));
    const address = { unitId:unit.id, locator:unit.locator, box };
    const request = { representation:'render', address, readerVersion:candidate.readerVersion, renderProfile, dpi };
    const image = await pdf.read(path, request, unit);
    if (image.mediaType !== 'image/png' || image.address.unitId !== unit.id) fail('sheet_address_mismatch');
    return { ...image, request, limitations:[] };
  }

  return {
    close() { storage.objects.close(); },
    async draw(candidate) {
      const path = await openOriginal(candidate);
      const image = await (candidate.format === 'pdf' ? drawPdf(candidate,path) : drawCad(candidate,path));
      const { bytes, transform, address } = image;
      if (!Buffer.isBuffer(bytes) || bytes.length < 24 || bytes.length > maxPngBytes || !bytes.subarray(0,8).equals(pngSignature)
        || !contains(candidate.unit,address?.box) || !transform
        || transform.width !== bytes.readUInt32BE(16) || transform.height !== bytes.readUInt32BE(20)
        || !Number.isSafeInteger(transform.width) || !Number.isSafeInteger(transform.height)
        || transform.width <= 0 || transform.height <= 0 || transform.width * transform.height > rendererSide ** 2
        || ![transform.pixelOriginX, transform.pixelOriginY, transform.pixelsPerPoint].every(number)
        || transform.pixelsPerPoint <= 0) fail('sheet_png_invalid');
      const pixels = await sharp(bytes,{limitInputPixels:rendererSide ** 2}).flatten({background:'#fff'}).raw().toBuffer();
      let marked = 0;
      for (let i = 0; i < pixels.length && marked < 24; i += 3) {
        if (Math.min(pixels[i],pixels[i+1],pixels[i+2]) < 230) marked++;
      }
      if (marked < 24) fail('sheet_png_blank');
      return image;
    },
  };
}

let session;
if (process.send) {
  process.on('message', async ({ candidate, sourceRoot, scratch }) => {
    try {
      session ??= await createRasterSession(sourceRoot,scratch);
      process.send({ output:await session.draw(candidate) });
    } catch (error) {
      const code = /^[a-z][a-z0-9_]{0,80}$/.test(error?.code) ? error.code : 'sheet_render_failed';
      process.send({ reason:code });
    }
  });
  process.on('disconnect', () => session?.close());
}
