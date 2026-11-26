import { fork } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';

const root = fileURLToPath(new URL('../../', import.meta.url));
const rasterProcess = fileURLToPath(new URL('./sheet-reading-raster.mjs', import.meta.url));
const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/u;
const digest = /^[a-f0-9]{64}$/u;
const maxSources = 96;
const maxUnitsPerSource = 40;
const maxCandidates = 24;
const maxNearbyLabels = 6;
const maxRenderAttempts = 16;
const maxPngBytes = 4 * 1024 ** 2;
// An approximate first pass for bounded DB retrieval; heading tests below make the final selection.
const titleTerms = 'условн.{0,4} обозначен|легенда|план|подвал|этаж|кровл|чердак|фасад|разрез|сечени|узел|узлы|детал|примыкан|legend|elevation|floor plan|section|detail';
const manualTitles = [
  ['legend', /^(?:условные\s+обозначения|легенда|экспликация\s+(?:материалов|отделки)|legend)(?=$|[^\p{L}])/iu],
  ['plan', /^(?:планы?(?:\s+(?:этажа|этажей|подвала|кровли|покрытия|чердака|секци|техническ|подземн|первого|второго|\d|на\s+отм|с\s+перемыч))?|подвал|кровля|чердак|\d+\s*(?:-\s*\d+\s*)?этаж\p{L}*|floor\s+plan)(?=$|[^\p{L}])/iu],
  ['facade', /^(?:(?:кладочные?\s+|кладочный\s+)?фасад[ыа]?|развертка\s+фасада|визуализация\s+фасадов|колористическое\s+решение\s+фасадов|цветовое\s+решение\s+фасадов|elevation)(?=$|[^\p{L}])/iu],
  ['section', /^(?:разрез[ы]?|сечени[ея]|sections?)(?=$|[^\p{L}])/iu],
  ['detail', /^(?:узел|узлы|детал[ьи]|примыкание|монтажный\s+узел|details?)(?=$|[^\p{L}])/iu],
];
const preferences = new Map([['legend',22],['facade',20],['plan',19],['detail',18],['section',17],['sheet',4]]);

const displayLine = literal => String(literal ?? '').normalize('NFKC')
  .replace(/\\(?:[HhWwTtQqAaCcFfSs]|p[ilrtxq])[^;\n]*;|\\P(?!\p{L})/gu,' ')
  .replace(/[{}]/gu,'').replaceAll('ё','е').trim();

export function sheetHeading(literal, {layout = false} = {}) {
  const value = displayLine(literal);
  if (!value || value.length > 1200 || /^(?:см\.|смотри)\b/iu.test(value)) return;
  const title = (layout ? value.replace(/^\d+\s*[._ -]*\s*(?=\p{L})/u,'').replaceAll('_',' ') : value)
    .split(/\r?\n/u,1)[0].trim();
  if (!title || title.length > 180) return;
  const match = manualTitles.find(([,pattern]) => pattern.test(title));
  if (!match || /(?:^|\s)(?:см\.?|смотри)\s*(?:на\s+)?лист/iu.test(title)
    || /^(?:фасад[а]?\s|план\s).{0,40}(?:должен|необходимо|выполнить|следует)/iu.test(title)) return;
  return { kind: match[0], title, relevantLegend:match[0]==='legend'
    && /стен[ауы]|кладк|утепл|фасад|облицов|отделк|керам|кирпич|плит/iu.test(value) };
}

function contentAddress(line, readerVersion) {
  try {
    const { address, readerVersion: lineReaderVersion } = JSON.parse(line.anchor);
    return lineReaderVersion === readerVersion && address?.unitId ? address : undefined;
  } catch {
    return undefined;
  }
}

function normalizedOptions(options) {
  const within = (x,fallback,max) => Number.isSafeInteger(x) && x >= 0 ? Math.min(x,max) : fallback;
  return { sourceRoot:options.sourceRoot ?? root, maxImages:within(options.maxImages,4,4),
    maxBytes:within(options.maxBytes,maxPngBytes,maxPngBytes), timeoutMs:within(options.timeoutMs,18_000,30_000),
    elementTimeoutMs:within(options.elementTimeoutMs,5_000,8_000) };
}

async function readScopedMaps(client,snapshot,seeds) {
  const sql = `WITH scoped AS (
    SELECT prep.manifest,cur.manifest_id FROM intake_package_preparation_current cur
    JOIN intake_package_preparations prep ON prep.project_id=cur.project_id AND prep.receipt_id=cur.receipt_id AND prep.id=cur.manifest_id
    WHERE cur.project_id=$1 AND cur.receipt_id=$2 AND cur.manifest_id=$3
  ), assigned AS (
    SELECT DISTINCT ON (rm.version_id) rm.version_id,rm.document_id,rm.original_sha256,rm.reader_version,rm.format,rm.units,
      o.object_key,o.size, item->'derivative' AS derivative
    FROM scoped s CROSS JOIN LATERAL jsonb_array_elements(s.manifest->'items') item
    JOIN intake_package_preparation_items pi ON pi.manifest_id=s.manifest_id AND pi.project_id=$1
      AND pi.version_id=(item->>'versionId')::uuid AND pi.map_fingerprint=item->>'mapFingerprint'
    JOIN harness_package_maps hm ON hm.project_id=pi.project_id AND hm.version_id=pi.version_id
      AND hm.fingerprint=pi.map_fingerprint AND hm.active
    JOIN reader_maps rm ON rm.project_id=hm.project_id AND rm.version_id=hm.version_id AND rm.reader_version=hm.reader_version
      AND rm.reader_version=item->>'readerVersion' AND rm.document_id=(item->>'documentId')::uuid
      AND rm.original_sha256=item->>'originalSha256' AND rm.format=item->>'format'
    JOIN intake_document_versions v ON v.project_id=rm.project_id AND v.document_id=rm.document_id AND v.id=rm.version_id
    JOIN intake_originals o ON o.project_id=v.project_id AND o.id=v.original_id AND o.sha256=rm.original_sha256
    WHERE item->>'kind'='document' AND item->>'state'='available' AND rm.format IN ('pdf','dxf','dwg')
      AND EXISTS (SELECT FROM intake_occurrences occ WHERE occ.project_id=v.project_id AND occ.receipt_id=$2
        AND occ.version_id=v.id AND occ.state='accepted')
    ORDER BY rm.version_id
  ), versions AS (
    SELECT assigned.*, count(*) OVER () AS "totalSources"
    FROM assigned
    ORDER BY (CASE WHEN $4::jsonb ? version_id::text THEN 0 ELSE 1 END),version_id
    LIMIT ${maxSources}
  )
  SELECT v.version_id AS "versionId",v.document_id AS "documentId",v.original_sha256 AS "originalSha256",
    v.reader_version AS "readerVersion",v.format,v.object_key AS "originalObjectKey",v.size AS "originalSize",
    v.derivative, v."totalSources", candidate.u AS unit, candidate."totalUnits",
    CASE WHEN v.format='dwg' AND candidate.u#>'{locator,part}' IS NOT NULL
      THEN jsonb_build_array(
        CASE WHEN candidate.n>2 THEN v.units->(candidate.n::int-3) END,
        CASE WHEN candidate.n>1 THEN v.units->(candidate.n::int-2) END,
        v.units->candidate.n::int,v.units->(candidate.n::int+1))
      ELSE '[]'::jsonb END AS neighbours
  FROM versions v LEFT JOIN LATERAL (
    SELECT u,n,count(*) OVER () AS "totalUnits"
    FROM jsonb_array_elements(v.units) WITH ORDINALITY parts(u,n)
    WHERE jsonb_typeof(u->'width')='number' AND jsonb_typeof(u->'height')='number' AND (
      coalesce($4::jsonb->v.version_id::text ? (u->>'id'),false)
      OR (v.format='pdf' AND n=1)
      OR (v.format IN ('dwg','dxf') AND coalesce(u#>>'{locator,space}','') !~* '^(model|paper)$'
        AND coalesce(u->>'label','') ~* $5)
      OR (v.format='dxf' AND n=1))
    ORDER BY coalesce($4::jsonb->v.version_id::text ? (u->>'id'),false) DESC,n
    LIMIT ${maxUnitsPerSource}
  ) candidate ON true ORDER BY v.version_id,candidate.n`;
  return (await client.query(sql,[snapshot.projectId,snapshot.receiptId,snapshot.preparationId,JSON.stringify(seeds),titleTerms])).rows;
}

async function findMoreTitles(client,snapshot,candidates) {
  const request = candidates.map(({versionId,readerVersion,unit}) => ({versionId,readerVersion,unitId:unit.id}));
  if (!request.length) return [];
  return (await client.query(`WITH requested AS (
    SELECT * FROM jsonb_to_recordset($2::jsonb) AS t ("versionId" uuid,"readerVersion" text,"unitId" text)
  ), covered AS (
    SELECT * FROM jsonb_to_recordset($3::jsonb) AS t ("versionId" uuid,"readerVersion" text,contract int,"processedUnits" int)
  )
  SELECT b.id AS "blockId",b.reader_version AS "readerVersion",b.ordinal AS "blockOrdinal",
    b.unit_id AS "unitId",b.version_id AS "versionId",l.ordinal,l.line_id AS "lineId",l.address,l.literal
  FROM requested r JOIN covered c ON c."versionId"=r."versionId" AND c."readerVersion"=r."readerVersion"
  JOIN project_memory_blocks_all b ON b.project_id=$1 AND b.version_id=r."versionId"
    AND b.reader_version=r."readerVersion" AND b.unit_id=r."unitId" AND b.contract=c.contract AND b.ordinal<c."processedUnits"
  JOIN LATERAL (
    SELECT ordinal,line_id,address,literal
    FROM project_memory_lines WHERE block_id=b.id AND length(literal) BETWEEN 3 AND 1200 AND folded ~* $4
    ORDER BY CASE WHEN folded ~* $5 THEN 0 ELSE 1 END,length(literal),ordinal LIMIT 10
  ) l ON true
  ORDER BY b.version_id,b.ordinal,l.ordinal`,
  [snapshot.projectId,JSON.stringify(request),JSON.stringify(snapshot.indexCursor ?? []),titleTerms,
    '^\\s*(?:условн|легенда|план|фасад|разрез|узел|elevation|floor plan|section|detail)'])).rows;
}

function groupHeadings(lines, cursor) {
  const versions = new Map(cursor.map(item=>[item.versionId,item.readerVersion]));
  const seeds = {};
  const titles = new Map();
  for (const line of lines) {
    const heading = sheetHeading(line.text);
    const address = heading && contentAddress(line,versions.get(line.versionId));
    if (!address || !uuid.test(line.versionId)) continue;
    const ids = (seeds[line.versionId] ??= []);
    if (!ids.includes(address.unitId) && ids.length < maxUnitsPerSource) ids.push(address.unitId);
    const key = line.versionId + ':' + address.unitId;
    const group = titles.get(key) ?? [];
    group.push({ ...heading, address, line });
    titles.set(key,group);
  }
  return {seeds,titles};
}

function isPaperUnit(record) {
  const name = record.unit.locator?.space;
  return !!name && !/^(model|paper)$/iu.test(name);
}

function titleRank(title, key) {
  const lengthPenalty = Math.max(0,title.length - 80) / 8;
  const qualification = key==='facade' && /(?:\sос[яи]|\d\s*[-–]\s*\d)/iu.test(title) ? 5 : 0;
  return qualification - lengthPenalty;
}

function buildCandidates(records,titles,fileByVersion) {
  const result = [];
  for (const record of records) {
    const { unit,versionId,originalSha256,readerVersion } = record;
    if (!digest.test(originalSha256 ?? '') || !unit || typeof unit.id !== 'string' || !Number.isFinite(unit.width) || !Number.isFinite(unit.height)
      || unit.width <= 0 || unit.height <= 0 || /^(?:held|original_only)$/u.test(unit.locator?.coverage ?? '')
      || fileByVersion.get(versionId)?.originalSha256 !== originalSha256) continue;
    const key = versionId + ':' + unit.id;
    const paper = isPaperUnit(record);
    const label = sheetHeading(unit.locator?.space ?? unit.label,{layout:true});
    const byKind = new Map();
    const base = { ...record, originalSize:Number(record.originalSize) };
    const address = { unitId:unit.id, locator:unit.locator };
    function offer({kind,title,relevantLegend,address:lineAddress,line}) {
      const prior = byKind.get(kind);
      const indexed = Boolean(line);
      const focus = indexed && (record.format==='pdf' ? ['legend','detail'].includes(kind) && Boolean(lineAddress.box)
        : ['legend','detail'].includes(kind) || !paper);
      if (focus && record.format!=='pdf' && !(lineAddress.locator?.derivativeHandle || lineAddress.locator?.handle
        || lineAddress.locator?.entityOrdinal !== undefined)) return;
      // Layout names describe scope. Indexed headings give a citable locator.
      const score = (preferences.get(kind) ?? 0) + (indexed ? 8 : 0) + (paper ? 8 : 0)
        + (focus && kind==='legend' ? 6 : 0) + (relevantLegend ? 9 : 0) + titleRank(title,kind);
      if (!prior || score>prior.score) byKind.set(kind,{ ...base,address:lineAddress ?? address,kind,title,
        source:indexed ? 'indexed_title' : kind==='sheet' ? 'page' : 'map_label',focus,score,line });

    }
    if (label) offer(label);
    for (const heading of titles.get(key) ?? []) if (contentAddress(heading.line,readerVersion)) offer(heading);
    if (!byKind.size && record.format==='pdf') offer({ kind:'sheet',title:`Страница PDF ${unit.id}` });
    result.push(...byKind.values());
  }
  return result;
}

function diverseOrder(candidates,limit) {
  const remaining = [...candidates];
  const result = [];
  const seenVersions = new Map(), seenKinds = new Map(), seenUnits = new Map();
  const increment = (map,key) => map.set(key,(map.get(key) ?? 0)+1);
  const unit = x => `${x.versionId}:${x.unit.id}`;
  const score = x => x.score - 18 * (seenVersions.get(x.versionId) ?? 0)
    - 12 * (seenKinds.get(x.kind) ?? 0) - 22 * (seenUnits.get(unit(x)) ?? 0);
  while (remaining.length && result.length < limit) {
    let best = 0;
    for (let i=1; i<remaining.length; i++) {
      if (score(remaining[i])>score(remaining[best])) best=i;
    }
    const [selected] = remaining.splice(best,1);
    result.push(selected);
    increment(seenVersions,selected.versionId);
    increment(seenKinds,selected.kind);
    increment(seenUnits,unit(selected));
  }
  return result;
}

function spawnRaster(sourceRoot,scratch) {
  let child;
  function stop(active = child) {
    if (active===child) child = undefined;
    if (!active || active.exitCode!==null || active.signalCode!==null) return;
    try {
      if (process.platform==='win32') active.kill();
      else process.kill(-active.pid,'SIGKILL');
    } catch {}
  }
  return { stop, draw(candidate,ms) {
    child ??= fork(rasterProcess, [], { stdio:['ignore','ignore','ignore','ipc'],
      detached:process.platform!=='win32', serialization:'advanced',execArgv:[] });
    const active = child;
    return new Promise(resolve=>{
      const done = result => {
        clearTimeout(timer);
        active.off('message',done);
        active.off('exit',onExit);
        active.off('error',onExit);
        resolve(result);
      };
      const onExit = () => { done({reason:'sheet_renderer_unavailable'}); stop(active); };
      const timer = setTimeout(()=>{ done({reason:'sheet_render_timeout'}); stop(active); },ms);
      active.once('message',done);
      active.once('exit',onExit);
      active.once('error',onExit);
      active.send({candidate,sourceRoot,scratch},error=>{ if (error) onExit(); });
    });
  } };
}

async function collect(db,snapshot,limits) {
  const {seeds,titles} = groupHeadings(snapshot.lines ?? [],snapshot.indexCursor ?? []);
  const fileByVersion = new Map((snapshot.files ?? []).map(file=>[file.versionId,file]));
  const client = await db.connect();
  try {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    await client.query("SELECT set_config('statement_timeout',$1,true)",[String(Math.max(1,Math.min(2500,limits.timeoutMs)))]);
    const records = await readScopedMaps(client,snapshot,seeds);
    const prepared = buildCandidates(records,titles,fileByVersion);
    const preliminary = diverseOrder(prepared,maxCandidates);
    const pending = [...new Map(preliminary.filter(candidate=>candidate.source==='map_label' || candidate.source==='page')
      .map(candidate=>[`${candidate.versionId}:${candidate.unit.id}`,candidate])).values()];
    for (const row of await findMoreTitles(client,snapshot,pending)) {
      const key = row.versionId + ':' + row.unitId;
      const heading = sheetHeading(row.literal);
      if (!heading || row.address?.unitId!==row.unitId) continue;
      const {unitId,lineId,address,readerVersion,blockId,blockOrdinal,ordinal,versionId,literal} = row;
      const file = fileByVersion.get(versionId);
      const line = {versionId,originalSha256:file.originalSha256,
        anchor:JSON.stringify({unitId,lineId,address,readerVersion,blockId,blockOrdinal,ordinal}),text:literal};
      const group = titles.get(key) ?? [];
      group.push({ ...heading,address,line });
      titles.set(key,group);
    }
    await client.query('COMMIT');
    return { records, candidates:pending.length ? buildCandidates(records,titles,fileByVersion) : prepared };
  } catch (error) {
    await client.query('ROLLBACK').catch(()=>{});
    throw error;
  } finally {
    client.release();
  }
}

async function readVisibleLabels(db,snapshot,search,timeoutMs) {
  const client = await db.connect();
  try {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    await client.query("SELECT set_config('statement_timeout',$1,true)",[String(Math.max(1,Math.min(1200,timeoutMs)))]);
    const {rows} = await client.query(`WITH targets AS (
      SELECT * FROM jsonb_to_recordset($4::jsonb)
      AS t ("imageId" text,"versionId" uuid,"readerVersion" text,"unitId" text,handle text)
    ), covered AS (
      SELECT * FROM jsonb_to_recordset($5::jsonb)
      AS t ("versionId" uuid,"readerVersion" text,contract int,"processedUnits" int)
    )
    SELECT DISTINCT t."imageId",b.version_id AS "versionId",b.reader_version AS "readerVersion", b.unit_id AS "unitId",
      b.id AS "blockId",b.ordinal AS "blockOrdinal",l.ordinal,l.line_id AS "lineId", l.address,
      l.literal AS text
    FROM intake_package_preparation_current cur JOIN intake_package_preparation_items m
      ON m.project_id=cur.project_id AND m.manifest_id=cur.manifest_id
    JOIN targets t ON t."versionId"=m.version_id
    JOIN harness_package_maps hm ON hm.project_id=m.project_id AND hm.version_id=m.version_id
      AND hm.fingerprint=m.map_fingerprint AND hm.active AND hm.reader_version=t."readerVersion"
    JOIN covered c ON c."versionId"=t."versionId" AND c."readerVersion"=t."readerVersion"
    JOIN project_memory_blocks_all b ON b.project_id=m.project_id AND b.version_id=t."versionId"
      AND b.reader_version=t."readerVersion" AND b.unit_id=t."unitId" AND b.contract=c.contract AND b.ordinal<c."processedUnits"
    JOIN project_memory_lines l ON l.block_id=b.id
      AND coalesce(l.address#>>'{locator,derivativeHandle}',l.address#>>'{locator,handle}',
        'ordinal:'||(l.address#>>'{locator,entityOrdinal}'))=t.handle
    WHERE cur.project_id=$1 AND cur.receipt_id=$2 AND cur.manifest_id=$3 AND length(l.literal) BETWEEN 5 AND 1120
    ORDER BY t."imageId","blockOrdinal",l.ordinal LIMIT 40`,[snapshot.projectId,snapshot.receiptId,snapshot.preparationId,
      JSON.stringify(search),JSON.stringify(snapshot.indexCursor ?? [])]);
    await client.query('COMMIT');
    return rows;
  } catch (error) {
    await client.query('ROLLBACK').catch(()=>{});
    throw error;
  } finally {
    client.release();
  }
}

function publicCandidate(candidate,lines) {
  const { versionId,documentId,originalSha256,readerVersion,format,address,kind,title,source } = candidate;
  return {versionId,documentId,originalSha256,readerVersion,format,address,kind,title,source,lineIds:lines};
}

/** Attach bounded, addressable text and actual PNG bytes to one current package snapshot. */
export async function readSheetEvidence(db,snapshot,options = {}) {
  const limits = normalizedOptions(options);
  const started = performance.now();
  const result = { lines:[], images:[], candidates:[], limitations:[] };
  const note = (reason,candidate) => result.limitations.push({reason,
    ...(candidate && {versionId:candidate.versionId,unitId:candidate.unit?.id})});
  if (![snapshot.projectId,snapshot.receiptId,snapshot.preparationId].every(id=>uuid.test(id ?? ''))) {
    note('sheet_scope_invalid');
    return result;
  }
  let collected;
  try { collected = await collect(db,snapshot,limits); }
  catch { note('sheet_candidate_search_unavailable'); return result; }
  if (!collected.records.length) return result;
  const ordered = diverseOrder(collected.candidates,maxCandidates);
  if (Number(collected.records[0].totalSources)>maxSources) note('sheet_source_limit');
  if (collected.records.some(row=>Number(row.totalUnits)>maxUnitsPerSource)) note('sheet_unit_limit');
  if (collected.candidates.length>maxCandidates) note('sheet_candidate_limit');
  const existing = new Map((snapshot.lines ?? []).map(line=>[`${line.versionId}:${line.anchor}`,line.id]));
  let lineNumber = (snapshot.lines ?? []).reduce((max,line)=>Math.max(max,Number(/^L(\d+)$/u.exec(line.id)?.[1]) || 0),0);
  const selectedLines = new Set();
  const titleLimit = limits.maxImages ? maxCandidates-maxNearbyLabels : maxCandidates;
  const admitLine = (line,limit) => {
    const key = `${line.versionId}:${line.anchor}`;
    if (!selectedLines.has(key) && selectedLines.size>=limit) return;
    if (!existing.has(key)) {
      const id = `L${++lineNumber}`;
      existing.set(key,id);
      result.lines.push({...line,id});
    }
    selectedLines.add(key);
    return existing.get(key);
  };
  for (const candidate of ordered) {
    const { versionId,originalSha256,readerVersion,unit } = candidate;
    const lineIds = [];
    const line = candidate.line;
    if (line?.versionId===versionId && line.originalSha256===originalSha256
      && contentAddress(line,readerVersion)?.unitId===unit.id) {
      const id = admitLine(line,titleLimit);
      if (id) lineIds.push(id);
    }
    result.candidates.push(publicCandidate(candidate,lineIds));
  }

  if (!ordered.length) { note('sheet_no_candidate'); return result; }
  if (!limits.maxImages || !limits.maxBytes) { note('sheet_graphics_budget'); return result; }
  let scratch;
  let raster;
  const search = [];
  try {
    scratch = await mkdtemp(join(tmpdir(),'facade-sheet-reading-'));
    raster = spawnRaster(limits.sourceRoot,scratch);
    let totalBytes = 0;
    const triedDXF = new Set();
    const drawn = new Set();
    let attempts = 0;
    for (const [i,candidate] of ordered.entries()) {
      const remaining = limits.timeoutMs-(performance.now()-started);
      if (remaining<1) { note('sheet_total_timeout'); break; }
      if (result.images.length>=limits.maxImages) { note('sheet_image_limit'); break; }
      if (attempts>=maxRenderAttempts) { note('sheet_attempt_limit'); break; }
      const { versionId, originalSha256, documentId, readerVersion, format, unit } = candidate;
      const locator = candidate.address.locator;
      const frame = versionId+':'+unit.id+':'+(candidate.focus
        ? JSON.stringify([candidate.address.box,locator?.derivativeHandle,locator?.handle,locator?.entityOrdinal]) : '');
      if (drawn.has(frame)) continue;
      if (format==='dxf' && triedDXF.has(versionId)) continue;
      if (format==='dxf') triedDXF.add(versionId);
      drawn.add(frame);
      attempts++;
      const {output,reason} = await raster.draw({...candidate,projectId:snapshot.projectId},
        Math.floor(Math.min(remaining,limits.elementTimeoutMs)));
      if (!output) { note(reason ?? 'sheet_render_failed',candidate); continue; }
      const {bytes,address,request,transform,limitations,inside} = output;
      if (bytes.length+totalBytes>limits.maxBytes) { note('sheet_graphics_budget',candidate); continue; }
      const id = `I${result.images.length+1}`;
      totalBytes += bytes.length;
      const {kind,title,lineIds} = result.candidates[i];
      result.candidates[i].imageId = id;
      for (const item of inside ?? []) search.push({imageId:id,versionId,readerVersion,...item});
      result.images.push({ id,kind,title,lineIds,projectId:snapshot.projectId,receiptId:snapshot.receiptId,
        preparationId:snapshot.preparationId,versionId,documentId,originalSha256,readerVersion,format,address,request,
        transform,sha256:createHash('sha256').update(bytes).digest('hex'),mediaType:'image/png',byteSize:bytes.length,
        pngBase64:bytes.toString('base64'),limitations });
    }
  } catch {
    note('sheet_renderer_unavailable');
  } finally {
    raster?.stop();
    if (scratch) await rm(scratch,{recursive:true,force:true});
  }
  const timeLeft = limits.timeoutMs-(performance.now()-started);
  if (!search.length) return result;
  if (timeLeft<1) { note('sheet_label_search_timeout'); return result; }
  try {
    const images = new Map(result.images.map(image=>[image.id,image]));
    const counts = new Map();
    for (const row of await readVisibleLabels(db,snapshot,search,timeLeft)) {
      const {imageId,versionId,unitId,lineId,address,readerVersion,blockId,blockOrdinal,ordinal,text} = row;
      const image = images.get(imageId);
      if (!image || image.versionId!==versionId || image.readerVersion!==readerVersion || address?.unitId!==unitId
        || (counts.get(imageId) ?? 0)>=3) continue;
      const line = {versionId,originalSha256:image.originalSha256,
        anchor:JSON.stringify({unitId,lineId,address,readerVersion,blockId,blockOrdinal,ordinal}),text };
      const lineKey = `${line.versionId}:${line.anchor}`;
      if (image.lineIds.includes(existing.get(lineKey))) continue;
      const id = admitLine(line,maxCandidates);
      if (!id) break;
      image.lineIds.push(id);
      counts.set(imageId,(counts.get(imageId) ?? 0)+1);
    }
  } catch { note('sheet_label_search_unavailable'); }
  return result;
}
