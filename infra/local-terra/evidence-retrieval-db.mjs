import { buildEvidenceRanking, createEvidenceCollector } from './evidence-retrieval.mjs';

const scopes = `SELECT * FROM jsonb_to_recordset($2::jsonb)
  AS s("versionId" uuid,"readerVersion" text,contract integer,"processedUnits" integer)`;
const scopedBlock = `b.project_id=$1 AND b.version_id=s."versionId" AND b.reader_version=s."readerVersion"
  AND b.contract=s.contract AND b.ordinal<s."processedUnits"`;
const byAddress = `b.id AS "blockId",b.version_id AS "versionId",b.reader_version AS "readerVersion",
  b.ordinal AS "blockOrdinal",b.unit_id AS "unitId",b.address AS "blockAddress"`;
const lineAddress = `l.ordinal,l.line_id AS "lineId",l.literal AS text,l.address`;

async function discover(client,projectId,indexCursor,requirements,files) {
  const collector = createEvidenceCollector(requirements,files);
  if (!indexCursor.length) return collector.finish();
  await client.query(`DECLARE preliminary_evidence NO SCROLL CURSOR FOR
    WITH scoped AS (${scopes})
    SELECT b.id AS "blockId",b.version_id AS "versionId",l.ordinal,l.folded
    FROM scoped s JOIN project_memory_blocks_all b ON ${scopedBlock}
    JOIN project_memory_lines l ON l.block_id=b.id
    ORDER BY b.version_id,b.ordinal,l.ordinal`,[projectId,JSON.stringify(indexCursor)]);
  const batchSize = 4096;
  for (;;) {
    const {rows} = await client.query(`FETCH FORWARD ${batchSize} FROM preliminary_evidence`);
    for (const row of rows) collector.add(row);
    if (rows.length < batchSize) break;
  }
  await client.query('CLOSE preliminary_evidence');
  return collector.finish();
}

async function openCandidates(client,projectId,indexCursor,pins) {
  const {rows} = await client.query(`WITH scoped AS (${scopes}), pins AS (
    SELECT * FROM jsonb_to_recordset($3::jsonb)
      AS pin("blockId" text,ordinal integer,"position" integer)
  )
  SELECT pin.position,${byAddress},${lineAddress}
  FROM pins pin JOIN project_memory_blocks_all b ON b.id=pin."blockId"
  JOIN scoped s ON ${scopedBlock}
  JOIN LATERAL (
    (SELECT * FROM project_memory_lines WHERE block_id=b.id AND ordinal<=pin.ordinal
      ORDER BY ordinal DESC LIMIT 5)
    UNION ALL
    (SELECT * FROM project_memory_lines WHERE block_id=b.id AND ordinal>pin.ordinal
      ORDER BY ordinal LIMIT 4)
  ) l ON true
  UNION ALL
  SELECT pin.position,${byAddress},${lineAddress}
  FROM pins pin JOIN project_memory_blocks_all original ON original.id=pin."blockId"
  JOIN scoped s ON original.version_id=s."versionId"
  JOIN project_memory_blocks_all b ON ${scopedBlock} AND abs(b.ordinal-original.ordinal)=1
  JOIN LATERAL (
    (SELECT * FROM project_memory_lines WHERE block_id=b.id AND b.ordinal<original.ordinal
      ORDER BY ordinal DESC LIMIT 2)
    UNION ALL
    (SELECT * FROM project_memory_lines WHERE block_id=b.id AND b.ordinal>original.ordinal
      ORDER BY ordinal LIMIT 2)
  ) l ON true
  ORDER BY position,"blockOrdinal",ordinal`,[projectId,JSON.stringify(indexCursor),JSON.stringify(pins)]);
  return rows;
}

function pdfTextBlock(id) {
  return /^\d+\.\d+(?=\.\d+\.\d+$)/u.exec(id)?.[0];
}

export function contextRelation(primary, secondary) {
  const {locator:a = {}} = primary.address, {locator:b = {}} = secondary.address;
  if (primary.versionId !== secondary.versionId || primary.readerVersion !== secondary.readerVersion) return;
  if ((a.page !== undefined || b.page !== undefined) && a.page !== b.page) return;
  const grid = a.sheetId ?? a.table;
  if ((grid !== undefined || b.sheetId !== undefined || b.table !== undefined) && grid !== (b.sheetId ?? b.table)) return;
  if (grid !== undefined && a.row !== undefined && a.row === b.row) return 'same_row';
  if (a.page !== undefined) {
    const textBlock = pdfTextBlock(primary.lineId);
    if (textBlock && textBlock === pdfTextBlock(secondary.lineId)) return 'pdf_text_block';
  }
  if ((a.space !== undefined || b.space !== undefined) && (a.space !== b.space || a.view !== b.view)) return;
  if ((a.section || b.section) && a.section !== b.section) return;
  if (a.section && a.section === b.section) return 'same_section';
  if (primary.blockId === secondary.blockId) return 'reader_order';
  if (a.space !== undefined || typeof a.line === 'number') return 'adjacent_reader_block';
}

export function referencesIn(text) {
  const refs = [];
  const pattern = /(?:\bPDF\s*[-–]\s*страниц[аеыу]|физическ[а-я]+\s+страниц[аеыу])\s*(?:№\s*)?(\d{1,5})|(?:см\.?|смотри|см\s*\.)\s*(?:на\s+)?(?:листе?|л\.)\s*(?:№\s*)?([\p{L}\p{N}]+(?:[.-][\p{L}\p{N}]+)*)/giu;
  for (const match of text.matchAll(pattern)) {
    refs.push(match[1] ? {kind:'pdf_page',target:match[1],literal:match[0]}
      : {kind:'named_sheet',target:match[2],literal:match[0]});
    if (refs.length === 3) break;
  }
  return refs;
}

async function openReferences(client,projectId,indexCursor,requests) {
  if (!requests.length) return [];
  const {rows} = await client.query(`WITH scoped AS (${scopes}), requested AS (
    SELECT * FROM jsonb_to_recordset($3::jsonb)
      AS ref(id integer,"versionId" uuid,kind text,target text,"fromUnit" text)
  ), targets AS (
    SELECT ref.id,${byAddress},b.remaining,b.limitations,
      count(*) OVER (PARTITION BY ref.id) AS matches
    FROM requested ref JOIN scoped s ON s."versionId"=ref."versionId"
    JOIN project_memory_blocks_all b ON ${scopedBlock}
    JOIN reader_maps rm ON rm.project_id=b.project_id AND rm.version_id=b.version_id AND rm.reader_version=b.reader_version
    WHERE b.unit_id<>ref."fromUnit" AND (
      (ref.kind='pdf_page' AND rm.format='pdf' AND b.address#>>'{locator,page}'=ref.target)
      OR (ref.kind='named_sheet' AND rm.format IN ('dwg','dxf') AND b.address#>>'{locator,space}'=ref.target
        AND b.address#>>'{locator,space}'<>'Model'
        AND b.address#>'{locator,view}' IS NULL))
  )
  SELECT id,"blockId","versionId","readerVersion","blockOrdinal","unitId","blockAddress",remaining,limitations,
    ${lineAddress}
  FROM targets t LEFT JOIN LATERAL (SELECT * FROM project_memory_lines
    WHERE block_id=t."blockId" ORDER BY ordinal LIMIT 2) l ON true
  WHERE matches=1 ORDER BY id,ordinal`,[projectId,JSON.stringify(indexCursor),JSON.stringify(requests)]);
  return rows;
}

function excerpt(text, ranking, matches, limit = 1120) {
  if (text.length <= limit) return {text};
  let start = 0, best = 0;
  if (matches?.length) {
    const labels = new Set(matches.map(({label})=>label));
    const expected = ranking.lanes.flatMap((lane,i)=>labels.has(lane.label) ? [i] : []);
    for (let offset=0; offset<text.length; offset+=Math.floor(limit/2)) {
      const candidate = Math.min(offset,text.length-limit);
      const scores = ranking.score(text.slice(candidate,candidate+limit));
      const score = Math.max(0,...expected.map(lane=>scores.get(lane) ?? 0));
      if (score>best) { best = score; start = candidate; }
      if (candidate+limit===text.length) break;
    }
  }
  if (/[\uDC00-\uDFFF]/u.test(text[start])) start--;
  let stop = start+limit;
  if (/[\uD800-\uDBFF]/u.test(text[stop-1])) stop--;
  return {text:text.slice(start,stop),excerpt:[start,stop,text.length]};
}

export async function readEvidence(client,projectId,indexCursor,requirements,files) {
  const {candidates,requirements:searched,totalLines,completeCandidatePool} = await discover(client,projectId,indexCursor,requirements,files);
  const pins = candidates.map(({blockId,ordinal},position) => ({blockId,ordinal,position}));
  const rows = pins.length ? await openCandidates(client,projectId,indexCursor,pins) : [];
  const rowsByCandidate = new Map();
  for (const row of rows) {
    if (!rowsByCandidate.has(row.position)) rowsByCandidate.set(row.position,[]);
    rowsByCandidate.get(row.position).push(row);
  }
  const fileByVersion = new Map(files.map(file=>[file.versionId,file]));
  const ranking = buildEvidenceRanking(requirements);
  const lines = [];
  const indexed = new Map();
  function add(row,matches) {
    const key = row.blockId + ':' + row.ordinal;
    if (!indexed.has(key)) {
      const {unitId,lineId,address,readerVersion,blockId,blockOrdinal,ordinal,versionId,text} = row;
      const line = {id:`L${lines.length+1}`,versionId,originalSha256:fileByVersion.get(versionId).originalSha256,
        anchor:JSON.stringify({unitId,lineId,address,readerVersion,blockId,blockOrdinal,ordinal}),...excerpt(text,ranking,matches)};
      indexed.set(key,line);
      lines.push(line);
    }
    return indexed.get(key);
  }
  const primary = pins.map(pin => rowsByCandidate.get(pin.position)?.find(row =>
    row.blockId === pin.blockId && row.ordinal === pin.ordinal)).map((row,position) => row ? add(row,candidates[position].matches) : null);
  const references = [];
  const evidence = candidates.flatMap((candidate,position) => {
    const line = primary[position];
    if (!line) return [];
    const rows = rowsByCandidate.get(position);
    const anchor = rows.find(row => row.blockId === candidate.blockId && row.ordinal === candidate.ordinal);
    const neighbours = rows.filter(row => row !== anchor).flatMap(row => {
      const relation = contextRelation(anchor,row);
      return relation ? [{row,relation}] : [];
    }).sort((a,b) => {
      const rank = {same_row:0,pdf_text_block:1,same_section:2,reader_order:3,adjacent_reader_block:4};
      return rank[a.relation]-rank[b.relation] || Math.abs(a.row.blockOrdinal-anchor.blockOrdinal)-Math.abs(b.row.blockOrdinal-anchor.blockOrdinal)
        || Math.abs(a.row.ordinal-anchor.ordinal)-Math.abs(b.row.ordinal-anchor.ordinal);
    }).slice(0,4).map(({row,relation})=>({id:add(row).id,relation}));
    const refs = referencesIn(line.text).map(ref => {
      const link = {...ref,status:'reference_candidate',id:references.length+1};
      references.push({link,kind:ref.kind,target:ref.target,versionId:line.versionId,fromUnit:anchor.unitId,id:link.id});
      return link;
    });
    return [{id:line.id,matches:candidate.matches,rank:candidate.rank,neighbours,refs}];
  });
  for (const row of await openReferences(client,projectId,indexCursor,references.map(({link:_link,...request})=>request))) {
    const {link} = references[row.id-1];
    link.status = 'target_opened';
    link.address = row.blockAddress;
    link.remaining = row.remaining;
    link.lines ??= [];
    if (row.lineId !== null) link.lines.push(add(row).id);
  }
  return {lines,totalLines,retrieval:{searched,evidence,completeCandidatePool}};
}
