import { mergeSources } from './review-analysis.mjs';

const uuid='[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}';
const batchReason=new RegExp(`^drawing_batch:(${uuid})(?:,(${uuid}))?$`, 'u');
export const isDrawingBatch = reason => batchReason.test(reason);

export function drawingBatchReasons(snapshot) {
  const sheet=snapshot?.sheetReading;
  const sent=new Set((sheet?.images ?? []).map(image=>image.id));
  const uncovered=(sheet?.drawings ?? []).filter(drawing=>drawing.overviewIds.every(id=>!sent.has(id))
    && (drawing.overviewIds.length || drawing.limitations.some(item=>item.reason==='dwg_reading_timeout')))
    .map(drawing=>drawing.versionId).sort();
  const batches=[];
  for (let i=0;i<uncovered.length;i+=2) batches.push('drawing_batch:'+uncovered.slice(i,i+2).join(','));
  return batches;
}

export function selectDrawingBatch(raw,reason) {
  const match=batchReason.exec(reason);
  if (!match) throw Error('invalid_drawing_batch');
  const ids=new Set(match.slice(1).filter(Boolean));
  const files=raw.files.filter(file=>ids.has(file.versionId) && (file.format==='dwg' || /\.dwg$/iu.test(file.path)));
  if (files.length!==ids.size) throw Error('drawing_batch_source_mismatch');
  const lines=raw.lines.filter(line=>ids.has(line.versionId));
  const lineIds=new Set(lines.map(line=>line.id));
  const evidence=raw.retrieval?.evidence.filter(hit=>lineIds.has(hit.id)).map(hit=>({...hit,
    neighbours:hit.neighbours.filter(neighbour=>lineIds.has(neighbour.id)),
    refs:hit.refs.flatMap(ref=>{
      const lines=(ref.lines ?? []).filter(id=>lineIds.has(id));
      return ref.status==='target_opened' && !lines.length ? [] : [{...ref,lines}];
    }),
  }));
  return {...raw,files,lines,
    indexCursor:raw.indexCursor.filter(cursor=>ids.has(cursor.versionId)),
    ...(evidence && {retrieval:{...raw.retrieval,evidence}}),
    alternateSources:raw.alternateSources?.filter(source=>ids.has(source.originalVersionId) && ids.has(source.availableVersionId)),
    scopeNote:'Адресное продолжение предварительного обзора. Переданы новые DWG из той же закрытой описи. Выводы по другим оригиналам сохраняются. Охват остальных участков и применимость требуют адресной проверки.'};
}

export function preserveUnrevisitedRows(input,previousRows,readRows) {
  const previous=new Map(previousRows.map(row=>[row.key,row]));
  const read=new Map(readRows.map(row=>[row.key,row]));
  const rows=input.rows.map(row=>{
    const old=previous.get(row.key), candidate=read.get(row.key);
    if (!old || !candidate || candidate.status!=='unassessed' || candidate.sources.some(source=>source.quote)
      || candidate.analysis?.properties.length || candidate.analysis?.tensions.length
      || candidate.analysis?.applicability.kind!=='undetermined') return row;
    return {...old,sources:mergeSources(old.sources,candidate.sources).slice(0,100)};
  });
  return {...input,rows};
}
