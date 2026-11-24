import assert from 'node:assert/strict';
import { test } from 'node:test';
import { structureFromLines } from './package-walk.js';

test('the structural cursor preserves a long worksheet and keeps cells on the same row together', () => {
  const lines=Array.from({length:713},(_,index)=>({id:'cell:'+index,locator:{row:Math.floor(index/3)+1}}));
  const {blocks,limitation}=structureFromLines('xlsx',lines,[]);
  assert.equal(limitation,null);
  assert.deepEqual(blocks.flatMap(({lineIds})=>lineIds),lines.map(({id})=>id));
  for(let index=1;index<blocks.length;index++) assert.equal(blocks[index].rows!.first,blocks[index-1].rows!.last+1);
});

test('an empty PDF native layer retains a visual region without imposing a fixed zoom grid', () => {
  const frame={x:0,y:0,width:640,height:450};
  const {blocks,limitation}=structureFromLines('pdf',[],['pdf_native_empty'],frame);
  assert.equal(limitation,null);
  assert.deepEqual(blocks,[{id:'page-detail',kind:'visual',box:frame}]);
});
