import { createRequire } from 'node:module';

const sharp=createRequire(new URL('../../src/modules/formats/package.json',import.meta.url))('sharp');

const side=800;

function singles(images) {
  return images.map(({id,pngBase64})=>({pngBase64,panels:[{id}]}));
}

async function board(grid) {
  const rows=1+Math.max(...grid.map(tile=>tile.row));
  const rowHeight=Math.min(side,Math.floor(2*side/rows));
  const tiles=await Promise.all(grid.map(async ({image,column,row})=>{
    const left=column*side, top=row*rowHeight;
    const {data,info}=await sharp(Buffer.from(image.pngBase64,'base64')).flatten({background:'#fff'})
      .resize({width:side-12,height:rowHeight-12,fit:'inside',withoutEnlargement:true}).png().toBuffer({resolveWithObject:true});
    const x=left+Math.floor((side-info.width)/2), y=top+Math.floor((rowHeight-info.height)/2);
    return {part:{input:data,left:x,top:y},panel:{id:image.id,rectangle:[x,y,info.width,info.height]}};
  }));
  const width=side*(1+Math.max(...grid.map(tile=>tile.column)));
  const height=rowHeight*rows;
  const bytes=await sharp({create:{width,height,channels:3,background:'#e3e5e8'}})
    .composite(tiles.map(tile=>tile.part)).png().toBuffer();
  return {pngBase64:bytes.toString('base64'),panels:tiles.map(tile=>tile.panel)};
}

async function renderBoards(grids) {
  const attachments=[];
  for (const grid of grids) {
    try { attachments.push(await board(grid)); }
    catch { attachments.push(...singles(grid.map(tile=>tile.image))); }
  }
  return attachments;
}

export async function drawingAttachments(drawings,images) {
  const byId=new Map(images.map(image=>[image.id,image]));
  const seen = new Set();
  function tile(id,column,row) {
    const image=byId.get(id);
    if (!image || seen.has(id)) return [];
    seen.add(id);
    return [{image,column,row}];
  }
  const groups=[];
  for (let i=0;i<drawings.length;i+=2) {
    const grid=drawings.slice(i,i+2).flatMap((drawing,column)=>{
      const detail=drawing.detailIds[0];
      const stamp=drawing.detailIds.slice(1).find(id=>['title_block','title_block_region'].includes(byId.get(id)?.kind));
      return [...tile(drawing.overviewIds[0],column,0),...tile(detail,column,1),...tile(stamp,column,2)];
    });
    if (grid.length) groups.push(grid);
  }
  const remaining=drawings.flatMap(drawing=>drawing.detailIds.slice(1)).filter(id=>byId.has(id));
  const extras=[];
  for (let i=0;i<remaining.length;i+=4) {
    const grid=remaining.slice(i,i+4).flatMap((id,index)=>tile(id,index%2,Math.floor(index/2)));
    if (grid.length) extras.push(grid);
  }
  return [...await renderBoards(groups),...singles(images.filter(image=>!seen.has(image.id))),...await renderBoards(extras)];
}

export function sheetImageMetadata(sheet) {
  if (!sheet.attachments) return sheet.images.map(({id,title,kind,address,versionId})=>({
    id,title,kind,unit:address.unitId,versionId,
  }));
  const locate=new Map();
  for (const [i,attachment] of sheet.attachments.entries()) for (const panel of attachment.panels) {
    locate.set(panel.id,[i+1,panel.rectangle ?? null]);
  }
  return sheet.images.map(({id,title,kind,address})=>[id,kind,Array.from(title ?? '').slice(0,90).join(''),
    address.unitId,...locate.get(id)]);
}
