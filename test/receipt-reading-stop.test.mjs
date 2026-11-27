import test from 'node:test';
import assert from 'node:assert/strict';
import { engineeringOutcome, readingStopReason, readingProfile, backgroundCallLimits } from '../dist/src/modules/harness/reading-stop.js';

const source={quote:'Марка 741',anchor:'лист 2'};
const properties=[{key:'mark',status:'confirmed',finding:'Первый вывод',sources:[source],scope:{kind:'applicable',target:{element:'Панели'}},letter:{kind:'omit',text:''}}];
const review=(props,draftText='')=>({rows:[{key:'R1',status:'partial',sources:[],analysis:{properties:props,tensions:[],applicability:{kind:'included'}}}],draftText});
test('new grounding and addressed tasks affect the engineering result; duplicate citations do not',()=>{
  const a=review(properties);
  const b=review([{...properties[0],finding:'Переформулировано',sources:[source,{...source,anchor:'лист 3'}]}]);
  assert.equal(engineeringOutcome(a),engineeringOutcome(b));
  const sizes={...properties[0],sources:[{quote:'Панели 3 мм или 5 мм'}]};
  assert.notEqual(engineeringOutcome(review([{...sizes,finding:'Панели 3 мм'}])),engineeringOutcome(review([{...sizes,finding:'Панели 5 мм'}])));
  assert.notEqual(engineeringOutcome(a),engineeringOutcome(review([{...properties[0],sources:[{...source,quote:'Марка 742'}]}])));
  assert.notEqual(engineeringOutcome(a),engineeringOutcome(review([{...properties[0],scope:{kind:'undetermined'}}])));
  assert.notEqual(engineeringOutcome(a),engineeringOutcome(review(properties,'Уточните марку для секции 2.')));
});
test('stop only on two independently assessed flat windows or the receipt budget',()=>{
  assert.equal(readingStopReason(9,['flat','flat']),'no_useful_change');
  for(const other of ['gain','unknown']) assert.equal(readingStopReason(9,['flat',other]),null);
  assert.equal(readingStopReason(backgroundCallLimits.compact,['unknown']),'receipt_call_limit');
});

test('grounded client questions keep a different goal eligible after two flat windows; legacy reports get a finite budget',()=>{
 const ask=review([{...properties[0],status:'unanswered',letter:{kind:'ask',text:'Уточните марку.'}}]);
 assert.equal(readingProfile(ask.rows),'addressed');
 assert.equal(readingStopReason(40,['flat','flat'],'addressed'),null);
 ask.rows[0].analysis.properties[0].scope.kind='undetermined';
 assert.equal(readingProfile(ask.rows),'compact');
 assert.equal(readingProfile([{key:'R1'}]),'legacy');
});
