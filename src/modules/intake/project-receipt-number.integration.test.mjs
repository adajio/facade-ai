import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {readFile,readdir} from 'node:fs/promises';
import test from 'node:test';
import pg from 'pg';

const url=process.env.PROJECT_RECEIPT_TEST_DATABASE_URL;
test('existing and concurrent receipts are numbered within the project, including command replay and old pagination', {skip:!url}, async()=>{
  assert.ok(['localhost','127.0.0.1'].includes(new URL(url).hostname) && new URL(url).pathname.startsWith('/facade_test_'));
  const admin=new pg.Pool({connectionString:url}), schema='number_'+randomUUID().replaceAll('-','');
  await admin.query('CREATE SCHEMA '+schema);
  const db=new pg.Pool({connectionString:url,options:'-c search_path='+schema+',public'});
  try {
    const directory='db/migrations';
    const files=(await readdir(directory)).filter(n=>n.endsWith('.sql') && !n.startsWith('01_')).sort();
    const migration='41_project_receipt_numbers.sql';
    for (const name of files.filter(n=>n<migration)) await db.query(await readFile(directory+'/'+name,'utf8'));
    const org=randomUUID(),user=randomUUID(),a=randomUUID(),b=randomUUID();
    await db.query("INSERT INTO organizations(id,name) VALUES($1,'test')",[org]);
    await db.query("INSERT INTO users(id,organization_id,login) VALUES($1,$2,$3)",[user,org,user]);
    await db.query("INSERT INTO projects(id,organization_id,name,intake_mode) VALUES($1,$3,'A',true),($2,$3,'B',true)",[a,b,org]);
    const create=async(project,dbOrTx=db)=>(await dbOrTx.query("INSERT INTO intake_receipts(project_id,source,created_by) VALUES($1,'upload',$2) RETURNING id,number",[project,user])).rows[0];
    const one=await create(a), two=await create(b), three=await create(a);
    assert.deepEqual([one,two,three].map(r=>r.number),['1','2','3']);
    await db.query(`INSERT INTO command_receipts(organization_id,user_id,project_id,operation,command_key,request_hash,response_status,response_body)
       VALUES ($1,$2,$3,'intake.create_receipt','test',$4,201,$5)`,[org,user,b,Buffer.alloc(32),{receiptId:two.id,number:2}]);
    await db.query(await readFile(directory+'/'+migration,'utf8'));
    assert.deepEqual((await db.query('SELECT number FROM intake_receipts ORDER BY server_sequence')).rows.map(r=>r.number),['1','1','2']);
    assert.equal((await db.query('SELECT response_body FROM command_receipts')).rows[0].response_body.number,1);
    const rolled=await db.connect(); await rolled.query('BEGIN');
    try { assert.equal((await create(b,rolled)).number,'2'); } finally {await rolled.query('ROLLBACK');rolled.release();}
    const concurrent=await Promise.all([create(b),create(a),create(b),create(b)]);
    assert.equal(concurrent[1].number,'3');
    assert.deepEqual([concurrent[0],concurrent[2],concurrent[3]].map(r=>+r.number).sort(),[2,3,4]);
    for (const name of files.filter(n=>n>migration)) await db.query(await readFile(directory+'/'+name,'utf8'));
    const {listReceipts}=await import('../../../dist/src/modules/intake/receipts.js');
    const older=await listReceipts(db,{projectId:a,uploading:false,before:Number(three.number)});
    assert.deepEqual(older.receipts.map(r=>r.receiptId),[one.id]);
  } finally {await db.end(); await admin.query('DROP SCHEMA '+schema+' CASCADE'); await admin.end();}
});
