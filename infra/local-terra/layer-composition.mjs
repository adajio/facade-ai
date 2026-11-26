// A check of arithmetic explicitly written in one statement. A different zone or edition can
// legitimately specify a different assembly, so comparisons across sources stay with the engineer.
const subjects = [
  {word:/утеплител|теплоизоляци/iu,key:'insulation',name:'теплоизоляции'},
  {word:/гидроизоляци/iu,key:'waterproofing',name:'гидроизоляции'},
  {word:/облицов/iu,key:'cladding',name:'облицовки'},
];
function millimetres(raw) {
  const value=raw.trim();
  if (!/^(?:\d+|\d{1,3}(?:[ \u00a0\u202f]\d{3})+)(?:[.,]\d+)?$/u.test(value)) return null;
  return Number(value.replace(/[ \u00a0\u202f]/gu,'').replace(',','.'));
}

export function layerComposition(text) {
  const stop=text.search(/(?:^|[\s(])(?:1\s*(?:[-–]?[йы]й?)?\s+слой|слой\s*(?:№\s*)?1\b)/iu);
  if (stop<0) return;
  const header=text.slice(0,stop);
  const subject=subjects.find(item=>item.word.test(header));
  if (!subject) return;
  const stated=header.match(/(\d[\d., \u00a0\u202f]*)\s*мм\s*[:(\s]*$/iu);
  const matches=[...text.slice(stop).matchAll(/(?:^|[^\p{L}\d])([1-9])\s*(?:[-–]?й)?\s+слой(?![\p{L}\d])|(?:^|[^\p{L}\d])слой\s*(?:№\s*)?([1-9])(?=\D|$)/giu)];
  if (matches.length<2 || matches.length>8) return;
  const widths=[];
  for (const [i,m] of matches.entries()) {
    if (Number(m[1] ?? m[2])!==i+1) return;
    const part=text.slice(stop+m.index, matches[i+1] ? stop+matches[i+1].index : undefined);
    const mm=[...part.matchAll(/(\d[\d., \u00a0\u202f]*)\s*мм(?![\p{L}²³])/giu)];
    if (mm.length!==1 || /(?:\d\s*[-–—…/]\s*|от\s+\d+\s+до\s*)\d+(?:[.,]\d+)?\s*мм/iu.test(part)) return;
    const value=millimetres(mm[0][1]);
    if (value===null) return;
    widths.push(value);
  }
  const sum=Number(widths.reduce((a,b)=>a+b,0).toFixed(3));
  return {subject:subject.key,name:subject.name,widths,sum,stated:stated?millimetres(stated[1]):null};
}

export function includeLayerEvidence(snapshot,input) {
  const keyById=new Map(snapshot.promptData?.evidence ?? []);
  const groups=new Map();
  for (const line of snapshot.lines) {
    const composition=layerComposition(line.text);
    if (!composition || line.text.length>4000) continue;
    for (const key of keyById.get(line.id) ?? []) {
      const id=key+'/'+composition.subject;
      const byVariant=groups.get(id) ?? new Map();
      const signature=JSON.stringify([composition.stated,composition.widths]);
      if (!byVariant.has(signature)) byVariant.set(signature,{...composition,line});
      groups.set(id,byVariant);
    }
  }
  return input.rows.map(row=>{
    if (!row.analysis || row.analysis.applicability.kind==='excluded') return row;
    let properties=row.analysis.properties;
    for (const subject of subjects) {
      const group=groups.get(row.key+'/'+subject.key);
      if (!group) continue;
      const entries=[...group.values()];
      if (!entries.some(item=>item.stated!==null && Math.abs(item.sum-item.stated)>0.01) || properties.length>=16) continue;
      // Only list the discrepancy and the closest independently written alternative.
      entries.sort((a,b)=>Number(b.stated!==null && b.stated!==b.sum)-Number(a.stated!==null && a.stated!==a.sum));
      const first=entries[0], other=entries.slice(1).find(item=>item.line.versionId!==first.line.versionId && item.stated===first.stated);
      const listed=other?[first,other]:[first];
      const key='checked_layers_'+subject.key;
      const finding='По записи источника: '+listed.map(item=>item.widths.join(' + ')+' = '+item.sum+' мм'+(item.stated!==null?' при указанной общей толщине '+item.stated+' мм':'')).join('. По другому источнику: ')+'. Область применения нужно сверить по указанным адресам.';
      const sources=listed.map(({line})=>({versionId:line.versionId,originalSha256:line.originalSha256,anchor:line.anchor,quote:line.text}));
      const property={key,label:'Сумма слоёв '+subject.name,status:'insufficient',finding,sources,
        letter:{kind:'omit',text:'Сначала инженеру нужно сверить слои, зону и редакцию по приведённым источникам.'}};
      properties=[...properties.filter(item=>item.key!==key),property];
    }
    return properties===row.analysis.properties ? row : {...row,status:row.status==='present'?'partial':row.status,analysis:{...row.analysis,properties}};
  });
}
