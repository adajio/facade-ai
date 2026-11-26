import { readSheetEvidence } from './sheet-reading.mjs';
import { readDrawingEvidence } from './drawing-reading.mjs';
import { drawingAttachments } from './drawing-attachments.mjs';

export async function attachReadingSkills(db,reader,sourceRoot,snapshot) {
  const genericFiles=snapshot.files.filter(file=>file.format!=='dwg' && !/\.dwg$/iu.test(file.path));
  const drawing=await readDrawingEvidence(db,reader,snapshot);
  const reading=genericFiles.length ? await readSheetEvidence(db,{...snapshot,files:genericFiles},{sourceRoot,excludeDwg:true})
    : {lines:[],images:[],candidates:[],limitations:[]};
  const inventory=new Map(snapshot.inventory.map(item=>[item.versionId,item.originalSha256]));
  const images=[];
  for (const image of [...drawing.images,...reading.images]) {
    if (image.projectId!==snapshot.projectId || image.receiptId!==snapshot.receiptId ||
        image.preparationId!==snapshot.preparationId || inventory.get(image.versionId)!==image.originalSha256) {
      throw Error('sheet_source_mismatch');
    }
    try {
      await reader.storeSheetPreview(image,Buffer.from(image.pngBase64,'base64'),image.sha256);
      images.push(image);
    } catch {
      reading.limitations.push({reason:'sheet_preview_persistence_failed',versionId:image.versionId,unitId:image.address.unitId});
    }
  }
  const ids=new Set(images.map(image=>image.id));
  const candidates=reading.candidates.map(({imageId,...item})=>({...item,...(ids.has(imageId) && {imageId})}));
  for (const item of drawing.drawings) {
    for (const key of ['overviewIds','detailIds']) item[key]=item[key].filter(id=>ids.has(id));
    item.limitations.push(...reading.limitations.filter(limit=>limit.versionId===item.versionId));
  }
  const scopeNote=snapshot.scopeNote+
    (reading.limitations.length?' Ограничения чтения листов: '+[...new Set(reading.limitations.map(item=>item.reason))].join(', ')+'.':'');
  const attachments=drawing.drawings.length ? await drawingAttachments(drawing.drawings,images) : undefined;
  return {...snapshot,scopeNote,factScopeVersion:1,lines:[...snapshot.lines,...reading.lines,...drawing.lines],
    sheetReading:{images,candidates,drawings:drawing.drawings,limitations:reading.limitations,...(attachments && {attachments})}};
}

export const inspectSheetsInstruction='sheetImages задаёт изображения. Объекты соответствуют порядку вложений. Массивы: [id, вид, название, участок, номер вложения, рамка панели x/y/ширина/высота в пикселях или null]. Файл указан через id изображения в drawingCoverage или sheetTitles. Для каждой панели укажи inspections с его id, ключом связанного требования и коротким наблюдением. Для неприменимого фрагмента оставь requirementKey пустым. observed означает, что графика различима. Заголовок и штамп сами по себе не подтверждают состав или применимость. Опиши штриховку, обозначение и связь с элементом, когда они видны. При сомнении укажи inconclusive или unreadable. Для инженерного вывода приведи дословные строки по адресу и проверь область применения.';
export function inspectionSchema(images) {
  return {type:'array',maxItems:images.length,items:{type:'object',additionalProperties:false,
    required:['imageId','requirementKey','outcome','observation'],properties:{
      imageId:{type:'string',enum:images.map(image=>image.id)},requirementKey:{type:'string'},
      outcome:{type:'string',enum:['observed','inconclusive','unreadable']},observation:{type:'string',maxLength:420}}}};
}

export function publishSheetObservations(snapshot,input,result) {
  const images=snapshot.sheetReading?.images ?? [];
  if (!images.length) return input;
  const responses=Array.isArray(result?.inspections)?result.inspections:[];
  let inspected=0;
  for (const image of images) {
    const matches=responses.filter(item=>item?.imageId===image.id);
    const item=matches[0];
    if (matches.length!==1 || !['observed','inconclusive','unreadable'].includes(item.outcome) ||
        typeof item.observation!=='string' || !item.observation.trim() || item.observation.length>420) continue;
    const row=input.rows.find(entry=>entry.key===item.requirementKey);
    if (!row && item.requirementKey!=='') continue;
    inspected++;
    if (!row) continue;
    const anchor=JSON.stringify({unitId:image.address.unitId,address:image.address,readerVersion:image.readerVersion,
      sheetPreview:{id:image.id,sha256:image.sha256,title:image.title,state:item.outcome,observation:item.observation}});
    if (anchor.length<=4000 && row.sources.length<100) row.sources.push({versionId:image.versionId,
      originalSha256:image.originalSha256,anchor});
  }
  return {...input,scopeNote:input.scopeNote+` Ответ по графическим фрагментам: ${inspected} из ${images.length}.`};
}
