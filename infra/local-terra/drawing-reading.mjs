import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { performance } from 'node:perf_hooks';
import { sheetHeading } from './sheet-reading.mjs';

const sharp=createRequire(new URL('../../src/modules/formats/package.json',import.meta.url))('sharp');
const stamp = /^(?:лист(?:ов)?|стадия|изм\.?|разработал|проверил|н\.?\s*контр\.?|гип|проектировал|\S{2,}[-.]\s*(?:ар|кж|км|нвф))(?=$|[^\p{L}])/iu;
const legend = /^(?:условные обозначения|легенда|экспликация|ведомость|спецификация|примечания|общие указания)/iu;
const meaningful = /фасад|разрез|сечени|план|отметк|уз(?:ел|лы)|стык|размер|толщин|креплен|направляющ|кронштейн|анк[её]р|облицов|состав|утепл|мембран|противопожар|бетон|арматур|профил|алюмини|кирпич|панел|материал|цвет|\bRAL\b/iu;
const permissions = /^([a-z][a-z0-9_]{0,80})$/u;
const sha = data => createHash('sha256').update(data).digest('hex');
const stableId = (prefix, parts) => prefix+sha(JSON.stringify(parts)).slice(0,24);
const reason = (error, fallback) => typeof error?.code==='string' && permissions.test(error.code) ? error.code : fallback;
const listedSpace = unit => unit.locator?.space;
const isPaper = unit => Boolean(listedSpace(unit)) && !/^model$/iu.test(listedSpace(unit));
const usable = unit => Number.isFinite(unit.width) && unit.width>0 && Number.isFinite(unit.height) && unit.height>0
  && !['held','original_only'].includes(unit.locator?.coverage);
const ascii = part => part.replace(/\\[fFhHwWqQcCaAtT][^;]*;/gu,'')
  .replace(/\\S([^;]*);/gu,(_sequence,stack)=>stack.replace(/[\^#]/gu,'/'))
  .replace(/\\P|\\~/gu,' ').replace(/\\[LlOoKk]/gu,'')
  .replace(/%%d/giu,'°').replace(/%%p/giu,'±').replace(/%%c/giu,'⌀')
  .replace(/[{}]/gu,'').replace(/\s+/gu,' ');
const fold = value => value.normalize('NFKC').toLowerCase().replaceAll('ё','е').trim();
const clean = value => value.replace(/\s+/gu,' ').trim();
const textRank = text => (legend.test(text) ? 18 : 0)+(stamp.test(text) ? 9 : 0)
  +(sheetHeading(text) ? 12 : 0)+(meaningful.test(text) ? 8 : 0)+Math.min(6,text.length/12);
const unitRank = (a,b) => Number(b.locator?.candidateCount ?? 0)-Number(a.locator?.candidateCount ?? 0)
  || Number(b.locator?.entityCount ?? 0)-Number(a.locator?.entityCount ?? 0);

export function groupDrawingPhrases(lines) {
  const parts = [];
  for (const line of lines) {
    const box = line.drawingBounds;
    const handle = line.locator?.derivativeHandle ?? line.locator?.handle;
    if (!handle || typeof line.text!=='string' || line.text.length>1120 || !box || ![box.x,box.y,box.width,box.height].every(Number.isFinite) || box.width<=0 || box.height<=0) continue;
    const display = ascii(line.text);
    if (!display.trim() || /\\[a-z0-9]+;/iu.test(display)) continue;
    const advance = Math.min(box.width,box.height * .69 * Math.max(1,[...display].length));
    parts.push({line,handle,box,display,advance,layer:line.details?.layer ?? null});
  }
  parts.sort((a,b)=>a.box.y-b.box.y||a.box.x-b.box.x);
  const rows = [];
  const active = new Map();
  for (const part of parts) {
    const {y,height} = part.box;
    const nearby = (active.get(part.layer) ?? []).filter(row=>y-row.y <= row.height*.31);
    let row = nearby.find(row=>Math.abs(y-row.y) <= Math.min(height,row.height)*.30
      && height/row.height>.72 && height/row.height<1.39);
    if (!row) {
      row={y,height,parts:[]};
      nearby.push(row);
      rows.push(row);
    }
    active.set(part.layer,nearby);
    row.parts.push(part);
  }
  const phrases = [];
  for (const row of rows) {
    row.parts.sort((a,b)=>a.box.x-b.box.x);
    let group=[], display='';
    function flush() {
      const text=clean(display);
      if (text.length>=5 && /[а-яa-z]{2}/iu.test(text) && textRank(text)>=4) {
        const x=group[0].box.x, y=Math.min(...group.map(part=>part.box.y));
        const right=Math.max(...group.map(part=>part.box.x+part.advance));
        const bottom=Math.max(...group.map(part=>part.box.y+part.box.height));
        phrases.push({display:text.slice(0,240),box:{x,y,width:right-x,height:bottom-y},parts:group,score:textRank(text)});
      }
      group=[];
      display='';
    }
    for (const part of row.parts) {
      const previous=group.at(-1), height=Math.min(part.box.height,previous?.box.height ?? part.box.height);
      const gap=previous ? part.box.x-previous.box.x-previous.advance : 0;
      if (previous?.display===part.display && Math.abs(part.box.x-previous.box.x)<height*.16) continue;
      if (previous && (gap>height*1.04 || gap< -height*.32 || group.length>=90)) flush();
      if (group.length && gap>height*.36) display+=' ';
      group.push(part);
      display+=part.display;
    }
    flush();
  }
  const unique = new Map();
  for (const phrase of phrases.sort((a,b)=>b.score-a.score||a.box.y-b.box.y||a.box.x-b.box.x)) {
    if (!unique.has(fold(phrase.display))) unique.set(fold(phrase.display),phrase);
  }
  return [...unique.values()];
}

export async function readDrawingMaps(db,snapshot,versionIds) {
  const result=await db.query(`SELECT DISTINCT ON (rm.version_id) rm.version_id AS "versionId",
    rm.document_id AS "documentId",rm.original_sha256 AS "originalSha256",rm.reader_version AS "readerVersion",rm.units,
    pi.map_fingerprint AS "mapFingerprint"
  FROM intake_package_preparation_current cur
  JOIN intake_package_preparations prep ON prep.project_id=cur.project_id AND prep.receipt_id=cur.receipt_id AND prep.id=cur.manifest_id
  JOIN intake_package_preparation_items pi ON pi.project_id=cur.project_id AND pi.manifest_id=cur.manifest_id
  JOIN harness_package_maps hm ON hm.project_id=pi.project_id AND hm.version_id=pi.version_id
    AND hm.fingerprint=pi.map_fingerprint AND hm.active
  JOIN reader_maps rm ON rm.project_id=hm.project_id AND rm.version_id=hm.version_id AND rm.reader_version=hm.reader_version
  JOIN LATERAL jsonb_array_elements(prep.manifest->'items') i ON i->>'versionId'=rm.version_id::text
    AND i->>'readerVersion'=rm.reader_version AND i->>'originalSha256'=rm.original_sha256
    AND i->>'documentId'=rm.document_id::text AND i->>'mapFingerprint'=pi.map_fingerprint
  WHERE cur.project_id=$1 AND cur.receipt_id=$2 AND cur.manifest_id=$3 AND rm.format='dwg'
    AND i->>'kind'='document' AND i->>'state'='available' AND rm.version_id=ANY($4::uuid[])
    AND EXISTS (SELECT FROM intake_occurrences o WHERE o.project_id=cur.project_id AND o.receipt_id=cur.receipt_id
      AND o.version_id=rm.version_id AND o.state='accepted') ORDER BY rm.version_id`,
  [snapshot.projectId,snapshot.receiptId,snapshot.preparationId,versionIds]);
  return result.rows;
}

export async function readDrawingIndexLines(db,snapshot,targets) {
  if (!targets.length) return [];
  const {rows}=await db.query(`WITH targets AS (
    SELECT * FROM jsonb_to_recordset($4::jsonb) AS t("versionId" uuid,"unitId" text,"lineId" text)
  ), covered AS (
    SELECT * FROM jsonb_to_recordset($5::jsonb)
    AS c("versionId" uuid,"readerVersion" text,contract int,"processedUnits" int)
  )
  SELECT b.version_id AS "versionId",b.reader_version AS "readerVersion",b.unit_id AS "unitId",b.id AS "blockId",
    b.ordinal AS "blockOrdinal",l.ordinal,l.line_id AS "lineId",l.address,l.literal AS text
  FROM intake_package_preparation_current cur JOIN intake_package_preparation_items pi
    ON pi.project_id=cur.project_id AND pi.manifest_id=cur.manifest_id
  JOIN targets t ON t."versionId"=pi.version_id
  JOIN covered c ON c."versionId"=t."versionId"
  JOIN harness_package_maps hm ON hm.project_id=pi.project_id AND hm.version_id=pi.version_id AND hm.fingerprint=pi.map_fingerprint
    AND hm.active AND hm.reader_version=c."readerVersion"
  JOIN project_memory_blocks_all b ON b.project_id=cur.project_id AND b.version_id=t."versionId" AND b.reader_version=c."readerVersion"
    AND b.unit_id=t."unitId" AND b.contract=c.contract AND b.ordinal<c."processedUnits"
  JOIN project_memory_lines l ON l.block_id=b.id AND l.line_id=t."lineId"
  WHERE cur.project_id=$1 AND cur.receipt_id=$2 AND cur.manifest_id=$3`,
  [snapshot.projectId,snapshot.receiptId,snapshot.preparationId,JSON.stringify(targets),JSON.stringify(snapshot.indexCursor ?? [])]);
  return rows;
}

async function hasVisibleInk(bytes, requireInterior) {
  const {data,info}=await sharp(bytes,{limitInputPixels:1600**2}).flatten({background:'#fff'})
    .toColourspace('srgb').raw().toBuffer({resolveWithObject:true});
  const {width,height,channels}=info;
  let ink=0;
  const occupied=new Set();
  for (let y=0;y<height;y++) for (let x=0;x<width;x++) {
    const offset=(y*width+x)*channels;
    if (Math.min(data[offset],data[offset+1],data[offset+2])>=220) continue;
    ink++;
    const column=Math.floor(x*10/width), row=Math.floor(y*10/height);
    if (column>1 && column<8 && row>1 && row<8) occupied.add(row*10+column);
  }
  return ink>=48 && (!requireInterior || occupied.size>=4);
}

function detailKind(phrase) {
  if (legend.test(phrase.display)) return 'legend';
  if (stamp.test(phrase.display)) return 'title_block';
  return sheetHeading(phrase.display)?.kind ?? 'detail';
}

function cropBox(unit) {
  const {width,height} = unit;
  return {x:width*.53,y:height*.68,width:width*.47,height:height*.32};
}

function phraseCrop(phrase,kind) {
  const {frame,box,unit}=phrase;
  if (!frame || frame.width!==unit.width || frame.height!==unit.height || ![frame.x,frame.y].every(Number.isFinite)) return;
  const left=box.x-frame.x, top=box.y-frame.y;
  if (left<0 || top<0 || left+box.width>frame.width || top+box.height>frame.height) return;
  const margin=Math.max(box.width*.30,box.height*6);
  const x=Math.max(0,left-margin), y=Math.max(0,top-box.height*4);
  const right=Math.min(frame.width,left+box.width+margin*(kind==='legend' ? 2.2 : 1));
  const bottom=Math.min(frame.height,top+box.height*(kind==='legend' ? 15 : 8));
  if (right>x && bottom>y) return {x,y,width:right-x,height:bottom-y};
}

async function readDrawing(reader,snapshot,map,deadline) {
  const {versionId,documentId,originalSha256,readerVersion,mapFingerprint,units} = map;
  const source = {projectId:snapshot.projectId,documentId,versionId};
  const scope={...source,receiptId:snapshot.receiptId,preparationId:snapshot.preparationId,
    originalSha256,readerVersion,format:'dwg'};
  const coverage={versionId,mapFingerprint,readerVersion,totalUnits:units.length,attemptedUnits:[],nativeUnits:[],
    overviewIds:[],detailIds:[],phrases:[],limitations:[]};
  const images=[];
  const note=(reason,unitId)=>coverage.limitations.push({reason,...(unitId && {unitId})});
  const ranked=units.filter(usable).sort(unitRank);
  const paper=ranked.filter(isPaper), model=ranked.filter(unit=>!isPaper(unit));
  const tries=[paper[0],model[0],paper[1],model[1],model[2]].filter(Boolean);
  const withinTime=()=>performance.now()<deadline;
  const preview=(unit,representation,address={})=>reader.previewDwg(source,
    {readerVersion,representation,address:{unitId:unit.id,...address}});
  async function render(unit,kind,title,address={},allowPlain=false) {
    const output=await preview(unit,'render',address);
    const {bytes,transform,limitations}=output;
    if (output.address?.unitId!==unit.id || output.mediaType!=='image/png' || !transform
      || bytes.length>4*1024**2 || !await hasVisibleInk(bytes,!allowPlain)) throw Error('sheet_graphics_not_visible');
    const hash=sha(bytes);
    const id=stableId('I',[versionId,originalSha256,readerVersion,output.address,hash]);
    return {...scope,id,kind,title,lineIds:[],address:output.address,transform,sha256:hash,
      mediaType:'image/png',byteSize:bytes.length,pngBase64:bytes.toString('base64'),limitations};
  }
  let overviewUnit;
  for (const unit of tries) {
    if (!withinTime()) break;
    coverage.attemptedUnits.push(unit.id);
    try {
      const kind=isPaper(unit) ? 'drawing_sheet' : 'drawing_model';
      const image=await render(unit,kind,unit.label || (isPaper(unit) ? 'Лист DWG' : 'Вид Model DWG'));
      overviewUnit=unit;
      images.push(image);
      coverage.overviewIds.push(image.id);
      if (!isPaper(unit)) note('dwg_model_fallback',unit.id);
      break;
    } catch (error) { note(reason(error, error.message==='sheet_graphics_not_visible' ? error.message : 'dwg_render_unavailable'),unit.id); }
  }
  if (!overviewUnit) note('dwg_overview_unavailable');

  const opened=[];
  const nativeUnits=[...new Set([overviewUnit,paper[0],model[0],model[1]].filter(Boolean))].slice(0,3);
  for (const unit of nativeUnits) {
    if (!withinTime()) break;
    try {
      const {address,lines,limitations,drawingFrame}=await preview(unit,'native');
      if (address?.unitId!==unit.id || !Array.isArray(lines)) throw Error('dwg_native_address_mismatch');
      coverage.nativeUnits.push(unit.id);
      for (const limitation of limitations ?? []) if (limitation) note(limitation,unit.id);
      opened.push(...groupDrawingPhrases(lines).slice(0,5).map(phrase=>({...phrase,unit,frame:drawingFrame})));
    } catch(error) { note(reason(error,'dwg_native_unavailable'),unit.id); }
  }
  if (!opened.length) note('dwg_no_spatial_text');
  const candidates=opened.sort((a,b)=>b.score-a.score || Number(b.unit===overviewUnit)-Number(a.unit===overviewUnit));
  for (const phrase of candidates.slice(0,6)) {
    coverage.phrases.push({id:stableId('P',[versionId,originalSha256,readerVersion,phrase.unit.id,phrase.parts.map(part=>part.line.id)]),
      unitId:phrase.unit.id,display:phrase.display,box:phrase.box,kind:detailKind(phrase),parts:phrase.parts.map(part=>part.line)});
  }

  const detail = new Set();
  for (const phrase of candidates.slice(0,8)) {
    const kind=detailKind(phrase);
    if (detail.size>=2 || !withinTime()) break;
    if (detail.has(kind)) continue;
    const {line}=phrase.parts[Math.floor(phrase.parts.length/2)];
    const locator=line.locator?.derivativeHandle ? {derivativeHandle:line.locator.derivativeHandle} : {handle:line.locator.handle};
    const box=phraseCrop(phrase,kind);
    try {
      const image=await render(phrase.unit,kind,phrase.display,box ? {box} : {locator},true);
      if (!images.some(item=>item.id===image.id)) {
        images.push(image);
        coverage.detailIds.push(image.id);
        detail.add(kind);
      }
    } catch(error) { note(reason(error,'dwg_detail_unavailable'),phrase.unit.id); }
  }
  if (overviewUnit && isPaper(overviewUnit) && !detail.has('title_block') && withinTime()) {
    try {
      const image=await render(overviewUnit,'title_block_region','Нижняя правая область листа',{box:cropBox(overviewUnit)},true);
      images.push(image);
      coverage.detailIds.push(image.id);
    } catch(error) { note(reason(error,'dwg_title_block_region_unavailable'),overviewUnit.id); }
  }
  if (!coverage.detailIds.length) note('dwg_detail_unavailable');
  if (!withinTime()) note('dwg_reading_timeout');
  return {coverage,images};
}

export async function readDrawingEvidence(db,reader,snapshot) {
  const files=snapshot.files.filter(file=>file.format==='dwg' || /\.dwg$/iu.test(file.path));
  if (!files.length) return {drawings:[],images:[],lines:[]};
  const result={drawings:[],images:[],lines:[]};
  let maps;
  try { maps=new Map((await readDrawingMaps(db,snapshot,files.map(file=>file.versionId))).map(map=>[map.versionId,map])); }
  catch { maps=new Map(); }
  const deadline=performance.now()+90_000;
  // Fixed concurrency keeps separate originals independent while bounding CAD raster work.
  for (let i=0;i<files.length;i+=3) {
    const readings=await Promise.all(files.slice(i,i+3).map(async file=>{
      const map=maps.get(file.versionId);
      if (map?.originalSha256===file.originalSha256 && Array.isArray(map.units)) return readDrawing(reader,snapshot,map,deadline);
      return {coverage:{versionId:file.versionId,totalUnits:0,attemptedUnits:[],nativeUnits:[],overviewIds:[],detailIds:[],phrases:[],
        limitations:[{reason:'dwg_pinned_map_unavailable'}]},images:[]};
    }));
    for (const {coverage,images} of readings) {
      result.drawings.push(coverage);
      result.images.push(...images);
    }
  }
  const key=(versionId,unitId,lineId)=>JSON.stringify([versionId,unitId,lineId]);
  const targets=new Map();
  for (const drawing of result.drawings) for (const phrase of drawing.phrases) for (const part of phrase.parts) {
    targets.set(key(drawing.versionId,phrase.unitId,part.id),{versionId:drawing.versionId,unitId:phrase.unitId,lineId:part.id});
  }
  let indexed=new Map();
  try {
    indexed=new Map((await readDrawingIndexLines(db,snapshot,[...targets.values()]))
      .map(row=>[key(row.versionId,row.unitId,row.lineId),row]));
  } catch {
    for (const drawing of result.drawings) drawing.limitations.push({reason:'dwg_index_source_lookup_unavailable'});
  }
  const existing=new Map(snapshot.lines.map(line=>{
    const {unitId,lineId}=JSON.parse(line.anchor);
    return [key(line.versionId,unitId,lineId),line];
  }));
  for (const drawing of result.drawings) {
    const source=files.find(file=>file.versionId===drawing.versionId);
    drawing.phrases=drawing.phrases.flatMap(({parts,...phrase})=>{
      const rows=parts.map(part=>indexed.get(key(drawing.versionId,phrase.unitId,part.id)));
      if (!rows.every((row,i)=>row?.text===parts[i].text && row.address?.unitId===phrase.unitId
        && row.readerVersion===drawing.readerVersion)) return [];
      const lineIds=[], indexedParts=[];
      for (const row of rows) {
        const lineKey=key(row.versionId,row.unitId,row.lineId);
        const {unitId,lineId,address,readerVersion,blockId,blockOrdinal,ordinal,versionId,text}=row;
        const id=stableId('D',[source.originalSha256,versionId,readerVersion,unitId,lineId]);
        const line={id,versionId,originalSha256:source.originalSha256,text,
          anchor:JSON.stringify({unitId,lineId,address,readerVersion,blockId,blockOrdinal,ordinal})};
        indexedParts.push(line);
        if (!existing.has(lineKey) || existing.get(lineKey).text!==row.text) {
          existing.set(lineKey,line);
          result.lines.push(line);
        }
        lineIds.push(existing.get(lineKey).id);
      }
      return [{...phrase,lineIds:[...new Set(lineIds)],indexedParts}];
    });
    if (!drawing.phrases.length && drawing.nativeUnits.length) drawing.limitations.push({reason:'dwg_spatial_text_unavailable_in_index'});
  }
  return result;
}
