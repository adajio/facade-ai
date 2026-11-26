import { mkdir, open, readFile, rename, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import pg from 'pg';

const zone='Europe/Moscow';
const formatTime=new Intl.DateTimeFormat('ru-RU',{timeZone:zone,hour:'2-digit',minute:'2-digit',second:'2-digit'});
const stages={project:'Проект',intake:'Поступление',archive:'Распаковка',file_map:'Подготовка файла',index:'Индексирование',
  preparation:'Опись',detailed_reading:'Подробное чтение',primary_review:'Первичный обзор',revision:'Обновление обзора',
  review_saved:'Матрица и черновик',operation:'Действия на стенде',effort_comparison:'Сравнение режимов Terra',model_call:'Вызов модели'};
const statuses={created:'создан',received:'принято',sealed:'приём завершён',published:'сохранено',ready:'в очереди',leased:'начато',
  covered:'участок проверен',partial:'частичный результат',completed:'завершено',limited:'есть ограничение',mapped:'карта построена',
  held:'приостановлено',waiting:'ожидание',running:'в работе',failed:'ошибка',unknown:'исход не подтверждён',rejected:'ответ отклонён',
  sending:'отправка начата',final_refusal:'зафиксирована причина отказа'};
const cell=v=>String(v??'').replaceAll('|','\\|').replace(/\s+/g,' ');
const dayOf="(event_time AT TIME ZONE 'Europe/Moscow')::date";
const details=f=>Object.entries(f).filter(([k])=>!['history','versionId','jobId','readerVersion','reviewId','previousReviewId','requestSha256'].includes(k))
  .map(([k,v])=>k+'='+v).join(' · ');
async function atomic(path,body){
 const temp=path+'.'+process.pid+'.tmp';let file;
 try{file=await open(temp,'w',0o600);await file.writeFile(body);await file.sync();await file.close();file=undefined;await rename(temp,path);}
 finally{await file?.close();await rm(temp,{force:true});}
}
async function readJson(path){
 try{return JSON.parse(await readFile(path,'utf8'));}catch(e){if(e.code!=='ENOENT') throw e;return {};}
}
export async function exportActivity(db,dir){
 await mkdir(dir,{recursive:true,mode:0o700});
 const stamps=await readJson(join(dir,'.published.json'));
 const tx=await db.connect();
 try{
  await tx.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
  const {rows:days}=await tx.query(`SELECT p.id AS project,p.name,${dayOf}::text AS day,count(*)::int AS events,
   max(a.id)::text AS last, max(a.event_time) AS latest FROM project_reading_activity a JOIN projects p ON p.id=a.project_id
   GROUP BY p.id,p.name,${dayOf} ORDER BY p.name,p.id,day DESC`);
  const index=['# Внутренние журналы чтения','','Время московское. Журнал обновляется из базы локального стенда. Для каждого дня доступны хронология и полный перечень событий в JSONL.',''];
  let name;
  for(const d of days){
   const key=d.project+'/'+d.day, stamp='v2:'+d.events+':'+d.last+':'+d.name;
   if(name!==d.project){name=d.project; index.push('', '## '+cell(d.name),'');}
   index.push('- ['+d.day+']('+key+'.md) · '+d.events+' событий · [JSONL]('+key+'.jsonl)');
   if(stamps[key]===stamp)continue;
   const {rows}=await tx.query(`SELECT a.id,a.project_id,a.receipt_id,r.number AS receipt_number,a.preparation_id,
     a.event_time,a.recorded_at,a.stage,a.status,a.reason,a.attempt_key,a.fields FROM project_reading_activity a
     LEFT JOIN intake_receipts r ON r.id=a.receipt_id WHERE a.project_id=$1 AND ${dayOf}=$2::date ORDER BY event_time,a.id`,[d.project,d.day]);
   const milestones=rows.filter(x=>['preparation','review_saved','effort_comparison','operation'].includes(x.stage) || x.stage==='primary_review'&&x.status==='unknown');
   const md=['# '+cell(d.name)+' · '+d.day,'','## Результаты и изменения','',
     ...milestones.map(x=>'- '+formatTime.format(x.event_time)+' · '+(stages[x.stage]??x.stage)+' · '+(statuses[x.status]??x.status)+' · '+cell([x.reason,details(x.fields)].filter(Boolean).join(' · '))),
     ...(milestones.length?[]:['Сохранённых результатов на этот день пока нет.']),'','## Все события','','Время московское. Для восстановленных событий указан источник времени. Состав документов и тексты модели хранятся в проекте.','',
    '| Время | Поступление | Этап | Состояние | Причина или изменение |','| --- | --- | --- | --- | --- |'];
   for(const x of rows){
    const f=x.fields;
    const history=f.history==='state_at_install'?'Состояние на момент включения журнала':f.history==='last_recorded_state'?'По последней сохранённой записи':'';
    const context=[x.reason,details(f),history,f.versionId?'файл '+f.versionId:''].filter(Boolean).join(' · ');
    md.push('| '+formatTime.format(x.event_time)+' | '+(x.receipt_number??'—')+' | '+cell(stages[x.stage]??x.stage)+' | '+cell(statuses[x.status]??x.status)+' | '+cell(context)+' |');
   }
   const projectDir=join(dir,d.project);await mkdir(projectDir,{recursive:true,mode:0o700});
   await atomic(join(dir,key+'.jsonl'),rows.map(x=>JSON.stringify(x)).join('\n')+'\n');
   await atomic(join(dir,key+'.md'),md.join('\n')+'\n');stamps[key]=stamp;
  }
  await tx.query('COMMIT');
  await atomic(join(dir,'Все проекты.md'),index.join('\n')+'\n');
  await atomic(join(dir,'.published.json'),JSON.stringify(stamps));
 }catch(error){await tx.query('ROLLBACK').catch(()=>{});throw error;}finally{tx.release();}
}
async function main(){
 const base=process.env.FACADE_ACTIVITY_DIR;if(!base||!process.env.DATABASE_URL)throw Error('missing operator journal configuration');
 const db=new pg.Pool({connectionString:process.env.DATABASE_URL,max:2});const lock=await db.connect();
 try{if(!(await lock.query("select pg_try_advisory_lock(hashtextextended('facade/operator-activity-export',0)) as ok")).rows[0].ok)throw Error('exporter already active');
 do{try{await exportActivity(db,base);}catch(e){if(process.argv.includes('--once'))throw e;console.error(new Date().toISOString(),'activity export failed',e.code??e.name);}
 if(process.argv.includes('--once'))break;await sleep(15000);}while(true);
 }finally{lock.release();await db.end();}
}
if(process.argv[1]&&pathToFileURL(resolve(process.argv[1])).href===import.meta.url)main().catch(e=>{console.error(e.code??e.message);process.exitCode=1;});
