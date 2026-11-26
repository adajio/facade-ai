import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { reassessmentKey } from '../infra/local-terra/reassessment.mjs';
import { replaySavedSheets } from '../infra/local-terra/replay-sheets.mjs';

const scope = { projectId:'p', receiptId:'r', preparationId:'m', catalogVersionId:'c', stage:'stage_1' };
const skillKey = reassessmentKey(scope,'sheet_applicability_v1');
const inventory = [{versionId:'v',originalSha256:'a'.repeat(64)}];
const item = {kind:'document',state:'available',versionId:'v',readerVersion:'reader.1'};
const source = {versionId:'v',originalSha256:inventory[0].originalSha256,anchor:'sheet:1',quote:'Стена'};
const applicability = {kind:'undetermined',reason:'Требуется сверка',sources:[]};
const row = {key:'doc.alpha',status:'unassessed',finding:'Прежний вывод',sources:[],
  analysis:{applicability,properties:[],tensions:[]}};
const property = {key:'fixing',label:'Крепление',finding:'Есть новый адрес',status:'insufficient',
  letter:{kind:'omit',text:'Требуется внутренняя сверка'},sources:[source]};
const parent = {id:'parent',rows:[row]};
const original = {id:'original',parentId:'parent',revisionKey:skillKey,rows:[row]};
const followup = {id:'followup',parentId:'original',revisionKey:'independent',rows:[
  {...row,finding:'Независимый вывод',sources:[source],analysis:{...row.analysis,properties:[property]}},
]};
const response = {rows:[{...row,finding:'Исправленный вывод',citations:[],
  analysis:{applicability:{kind:applicability.kind,reason:applicability.reason,citations:[]},properties:[],tensions:[]}}],
  inspections:[{imageId:'I1',requirementKey:row.key,outcome:'observed',observation:'Виден контур стены'}]};
const snapshot = {...scope,requestSha256:'b'.repeat(64),reviewContract:2,requirements:[{key:row.key,part:'Стена'}],
  inventory,scopeNote:'Опись.',lines:[],indexCursor:[{versionId:'v',readerVersion:item.readerVersion}],
  sheetReading:{images:[{...source,id:'I1',title:'Вид стены',sha256:'d'.repeat(64),readerVersion:item.readerVersion,
    address:{unitId:'1'}}]}};

async function fixture(t, {lineage=[original,parent], saved={}, mapItems=[item], existing, version='v1', otherVersion}={}) {
  const originalKey = reassessmentKey(scope,'sheet_applicability_'+version);
  const replayKey = reassessmentKey(scope,'replay_sheet_applicability_'+version);
  const root = await mkdtemp(join(tmpdir(),'replay-sheets-'));
  t.after(()=>rm(root,{recursive:true,force:true}));
  const folder = join(root, 'addressed', scope.receiptId);
  await mkdir(folder,{recursive:true});
  const base = join(folder,replayKey);
  await writeFile(join(folder,originalKey+'.json'),JSON.stringify({state:'published',snapshot,response,
    reviewId:original.id,parentId:parent.id,...saved}));
  if (otherVersion) {
    const otherKey = reassessmentKey(scope,'sheet_applicability_'+otherVersion);
    await writeFile(join(folder,otherKey+'.json'),JSON.stringify({state:'published',snapshot,
      response:{rows:[]},reviewId:'wrong-version',parentId:parent.id}));
  }
  const recorded = [];
  let published;
  let reads = 0;
  const run = {
    stateDir:root, modelCall:assert.fail, admitClaim:assert.fail,
    publish:async (_db,input) => { assert.equal(published,undefined); published=input; return {id:'fixed'}; },
    recordActivity:async(_db,event) => recorded.push(event),
    db:{query:async sql => {
      reads++;
      if (sql.includes('replay_sheet_existing')) return {rows:existing ? [{id:existing}] : []};
      if (sql.includes('replay_sheet_maps')) return {rows:[{items:mapItems}]};
      if (sql.includes('replay_sheet_lineage')) return {rows:lineage};
      if (sql.includes('AS "reportId"')) return {rows:[{...scope,reportId:lineage[0].id,
        inventory,scopeNote:'Свежая опись.',rows:lineage[0].rows,draftText:'Исходное письмо'}]};
      assert.fail('Unrecognized query');
    }},
  };
  return {
    replay:()=>replaySavedSheets(run,scope,replayKey,base),
    publication:()=>published,
    receipt:async()=>JSON.parse(await readFile(base+'.done','utf8')),
    reads:()=>reads, recorded,
  };
}

test('replays the exact saved response on its parent and resumes without a second publish', async t=>{
  const f = await fixture(t);
  assert.equal(await f.replay(),'published');
  assert.equal(f.publication().previousReportId,original.id);
  assert.equal(f.publication().rows[0].finding,'Исправленный вывод');
  assert.match(f.publication().rows[0].sources[0].anchor,/sheetPreview/);
  assert.deepEqual(await f.receipt(),{state:'published',reviewId:'fixed',reusedResponses:1,modelCalls:0});
  assert.deepEqual(f.recorded[0].fields,{reviewId:'fixed',reusedResponses:1,modelCalls:0});
  const before = f.reads();
  assert.equal(await f.replay(),'published');
  assert.equal(f.reads(),before);
});

test('applies later properties and sources without replaying their separate responses', async t=>{
  const f = await fixture(t,{lineage:[followup,original,parent]});
  assert.equal(await f.replay(),'published');
  const output=f.publication();
  assert.equal(output.previousReportId,followup.id);
  assert.equal(output.rows[0].finding,'Независимый вывод');
  assert.deepEqual(output.rows[0].analysis.properties,[property]);
  assert.deepEqual(output.rows[0].sources[1],source);
  assert.match(output.rows[0].sources[0].anchor,/sheetPreview/);
});

test('refuses a changed map or an unverifiable successor without publishing', async t=>{
  const missing = await fixture(t,{lineage:[followup]});
  assert.equal(await missing.replay(),'sheet_lineage_unverified');
  assert.equal(missing.publication(),undefined);
  const stale = await fixture(t,{mapItems:[{...item,readerVersion:'reader.2'}]});
  assert.equal(await stale.replay(),'sheet_maps_changed');
  assert.equal(stale.publication(),undefined);
});

test('recovers an existing publication and a stored response without a publication', async t=>{
  const existing = await fixture(t,{existing:'committed'});
  assert.equal(await existing.replay(),'published');
  assert.equal(existing.publication(),undefined);
  assert.equal((await existing.receipt()).reviewId,'committed');
  const responded = await fixture(t,{lineage:[parent],saved:{state:'responded',reviewId:undefined}});
  assert.equal(await responded.replay(),'published');
  assert.equal(responded.publication().previousReportId,parent.id);
});

test('retains later removals and a conflicting applicability decision', async t=>{
  const baseWithOldSources = {...original,rows:[{...row,sources:[source],
    analysis:{...row.analysis,properties:[property]}}]};
  const removal = {...followup,rows:[{...row,finding:'Старый адрес снят'}]};
  const removed = await fixture(t,{lineage:[removal,baseWithOldSources,parent]});
  assert.equal(await removed.replay(),'published');
  const [updated] = removed.publication().rows;
  assert.equal(updated.finding,'Старый адрес снят');
  assert.equal(updated.sources.length,1);
  assert.match(updated.sources[0].anchor,/sheetPreview/);
  assert.equal(updated.analysis.properties.length,0);

  const excluded = {...followup,rows:[{...followup.rows[0],analysis:{...followup.rows[0].analysis,
    applicability:{kind:'excluded',reason:'Решение неприменимо',sources:[source]}}}]};
  const changed = await fixture(t,{lineage:[excluded,baseWithOldSources,parent]});
  assert.equal(await changed.replay(),'published');
  assert.deepEqual(changed.publication().rows,excluded.rows);
});


test('v2 replay reads only the response saved under the explicitly requested profile', async t=>{
  const exact = {...original,revisionKey:reassessmentKey(scope,'sheet_applicability_v2')};
  const f = await fixture(t,{version:'v2',otherVersion:'v1',lineage:[exact,parent]});
  assert.equal(await f.replay(),'published');
  assert.equal(f.publication().rows[0].finding,'Исправленный вывод');
  assert.equal((await f.receipt()).modelCalls,0);
  const wrongLineage = await fixture(t,{version:'v2',otherVersion:'v1'});
  assert.equal(await wrongLineage.replay(),'sheet_lineage_unverified');
  assert.equal(wrongLineage.publication(),undefined);
});
