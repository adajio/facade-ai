import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import type { Observation, ReaderLine } from '../pdf/types.js';
import { collectFacadeMentions, resolveFacadeMentions } from './facade-discovery.js';
import { adjacentFacadeTypeHeader, affirmedFacadeKind } from './facade-type-evidence.js';

const projectId=randomUUID();

test('a type needs an affirmative literal and a uniquely addressed adjacent header',()=>{
  const head={id:'heading',text:'Drawing | Project facade ID: CW-751',box:{x:10,y:20,width:100,height:10}};
  const type={id:'kind',text:'Facade type: closed cassette',box:{x:10,y:35,width:95,height:10}};
  assert.equal(adjacentFacadeTypeHeader([head,type],type.id,head.id,type.text),head);
  assert.equal(adjacentFacadeTypeHeader([head,{...type,id:'separator'},type],type.id,head.id,type.text),undefined);
  assert.equal(adjacentFacadeTypeHeader([head,{...type,box:{...type.box,x:120}}],type.id,head.id,type.text),undefined);
  assert.equal(adjacentFacadeTypeHeader([head,{...type,text:'Facade type: not applicable'}],type.id,head.id,'Facade type: not applicable'),undefined);
  assert.equal(affirmedFacadeKind('Facade type: closed cassette | Facade type: unknown'),undefined);
  assert.equal(affirmedFacadeKind('Тип фасада: остекление не подтвержден'),undefined);
});
function opened(quote:string, branch:'A'|'B'='A', versionId=randomUUID()) {
  const lineId='selected';
  const evidenceId=randomUUID();
  const address={unitId:'unit'};
  const obs:Observation={id:randomUUID(),runId:randomUUID(),scope:null,receiptId:randomUUID(),branch,evidenceId,
    address,lineId,quote,grounding:'text',readerVersion:'test',source:{projectId,versionId,documentId:randomUUID(),sha256:'a'.repeat(64)}};
  return {obs, ref:{factId:obs.id,branch,evidenceId,address,lineId,quote,versionId,readerVersion:'test'}};
}
function mark(quote:string,branch:'A'|'B'='A',full=quote) {
  const {obs,ref}=opened(quote,branch);
  const [item]=collectFacadeMentions(obs,{quote,candidates:[]},ref,[{id:ref.lineId,text:full}]);
  assert.ok(item);
  return item;
}

test('a typed facade column spans consecutive rows, stops at a new heading and respects table bounds',()=>{
  const {obs,ref}=opened('VC-220');
  const position=(row:number,column:number,section='main')=>({sheet:'Sheet',section,row,column});
  const grid:ReaderLine[]=[
    {id:'head',text:'Обозначение фасада',locator:position(1,2)},
    {id:'prior',text:'VC-100',locator:position(2,2)},
    {id:ref.lineId,text:'VC-220',locator:position(3,2)},
    {id:'neighbor',text:'Access label',locator:position(1,3)},
  ];
  const proposal={quote:ref.quote,candidates:[{id:randomUUID(),label:ref.quote}]};
  const headerEvidence=randomUUID();
  const [row]=collectFacadeMentions(obs,proposal,ref,grid,new Map([['head',headerEvidence]]));
  assert.equal(row.kind,'designation');
  assert.equal(row.qualifier?.lineId,'head');
  assert.equal(row.qualifier?.evidenceId,headerEvidence);
  assert.equal(collectFacadeMentions(obs,proposal,ref,[...grid,{id:'intervening',text:'Access label',locator:position(2,2)}])[0].kind,'unresolved');
  grid[2].locator=position(3,2,'annex');
  assert.equal(collectFacadeMentions(obs,proposal,ref,grid)[0].kind,'unresolved');
});

test('a bare mark never inherits scope across originals, and a linked context still yields a single identity',()=>{
  const registry=mark('Project facade ID: VC-220 | Building: Annex | Axes: 7-8');
  const bareA=mark('Facade: VC-220');
  const bareB=mark('Facade: VC-220','B');
  const context=mark('Фасад: VC-220 | Корпус: Annex | Оси: 7-8','B');
  const other=mark('Фасад: VC-220 | Корпус: Hall | Оси: 2-3','B');
  const proof=resolveFacadeMentions(projectId,[registry,bareA,bareB,context,other]);
  assert.equal(proof.has(bareA),false);
  assert.equal(proof.has(bareB),false);
  assert.equal(proof.get(context)?.id,proof.get(registry)?.id);
  assert.notEqual(proof.get(other)?.id,proof.get(registry)?.id);

  const address=mark('Project facade reference: VC-220','A');
  const foreign=mark('Project facade reference: VC-220 | Building: Hall | Axes: 2-3','A');
  const explicit=resolveFacadeMentions(projectId,[registry,address,foreign]);
  assert.equal(explicit.get(address)?.id,explicit.get(registry)?.id);
  assert.equal(explicit.has(foreign),false);
});

test('registry confirmation retains the issued contextual ID and can be withdrawn',()=>{
  const prior=mark('Facade: VC-220 | Building: Annex | Axes: 7-8','A');
  const registry=mark('Project facade ID: VC-220 | Building: Annex | Axes: 7-8','B');
  const established=resolveFacadeMentions(projectId,[prior]);
  const id=established.get(prior)?.id;
  const joined=resolveFacadeMentions(projectId,[prior,registry],established);
  assert.equal(joined.get(prior)?.id,id);
  assert.equal(joined.get(registry)?.id,id);
  assert.equal(resolveFacadeMentions(projectId,[prior],joined).get(prior)?.id,id);
});

test('qualifiers after a second facade field are never borrowed by the first',()=>{
  const line='Facade: VC-100 | Facade: VC-220 | Building: Annex | Axes: 7-8';
  const first=mark('Facade: VC-100','A',line);
  const second=mark('Facade: VC-220','A',line);
  assert.equal(first.kind,'designation');
  assert.equal(first.context,undefined);
  assert.equal(second.kind,'context');
  assert.deepEqual(second.context,{building:'Annex',axes:'7-8'});
  assert.equal(second.contextQuote,'Facade: VC-220 | Building: Annex | Axes: 7-8');
});

test('contradictory partial registry scopes prevent merging identical project IDs',()=>{
  const a=mark('Идентификатор фасада проекта: HC-36 | Корпус: 1');
  const b=mark('Идентификатор фасада проекта: HC-36 | Корпус: 2','B');
  assert.equal(a.context,undefined);
  assert.equal(a.partialContext?.building,'1');
  const former=resolveFacadeMentions(projectId,[a]);
  assert.ok(former.has(a));
  assert.equal(resolveFacadeMentions(projectId,[a,b],former).size,0);
  const reference=mark('Ссылка на код фасада проекта: HC-36 | Корпус: 2');
  assert.equal(resolveFacadeMentions(projectId,[a,reference]).has(reference),false);
});

test('descriptive cladding is not an identity and directional headings survive inflection and reversed order',()=>{
  const prose='Фасад: рекламная облицовка | Корпус: 1 | Оси: А–Б';
  const {obs,ref}=opened(prose);
  assert.deepEqual(collectFacadeMentions(obs,{quote:prose,candidates:[]},ref,[{id:ref.lineId,text:prose}]),[]);
  const proposed=collectFacadeMentions(obs,{quote:prose,candidates:[{id:randomUUID(),label:'рекламная облицовка'}]},
    ref,[{id:ref.lineId,text:prose}]);
  assert.equal(proposed[0].kind,'unresolved');
  const bare=mark('Восточного фасада');
  const direct=mark('Восточный фасад | Корпус: 1 | Оси: А–Б');
  const reversed=mark('Фасад восточный | Оси: А-Б | Корпус: 1','B');
  const linked=resolveFacadeMentions(projectId,[bare,direct,reversed,...proposed]);
  assert.equal(bare.kind,'designation');
  assert.equal(linked.has(bare),false);
  assert.ok(linked.get(direct)?.id);
  assert.equal(linked.get(direct)?.id,linked.get(reversed)?.id);
  assert.equal(linked.has(proposed[0]),false);
});
