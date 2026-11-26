import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstat, open, readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { dirname, isAbsolute, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { terraRequestKind, terraModel, terraRejection, terraRequestBytes, terraResponseBytes } from './production.mjs';

const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/u;
const knownCode = (error = '') => terraRejection(error.trim().split('\n').at(-1));

async function readLimit(path) {
  try {
    const file = await lstat(path);
    if (!file.isFile() || (file.mode & 0o077) || file.uid !== process.getuid() || file.size > 4096) return null;
    const {id,maxCalls} = JSON.parse(await readFile(path,'utf8'));
    if (typeof id === 'string' && uuid.test(id) && Number.isSafeInteger(maxCalls) && maxCalls > 0)
      return {id,maxCalls};
  } catch (error) { if (error.code === 'ENOENT') return undefined; }
  return null;
}

async function isPaused(path) {
  try { await lstat(path); return true; }
  catch (error) { if (error.code === 'ENOENT') return false; throw error; }
}

async function usedCalls(path) {
  try { return (await readFile(path,'utf8')).split('\n').filter(Boolean).length; }
  catch (error) { if (error.code === 'ENOENT') return 0; throw error; }
}

function invokeAdapter(adapter, body) {
  return new Promise(resolve => {
    const child = spawn('/usr/bin/python3',[adapter], {
      stdio:['pipe','pipe','pipe'], env:{...process.env,FACADE_TERRA_REASONING_EFFORT:'high'},
    });
    let started = false, size = 0, stderr = '', overflow = false;
    const chunks = [];
    let kill;
    const stop = () => {
      child.kill('SIGTERM');
      kill ??= setTimeout(()=>child.kill('SIGKILL'),3000);
    };
    const timer = setTimeout(stop,255000);
    child.on('spawn',()=>{started=true;});
    child.on('error',()=>{});
    child.stdin.on('error',()=>{});
    child.stdout.on('data',chunk=>{
      size += chunk.length;
      if (size > terraResponseBytes) { overflow=true; stop(); }
      else chunks.push(chunk);
    });
    child.stderr.on('data',chunk=>{stderr=(stderr+chunk.toString('utf8')).slice(-4096);});
    child.on('close',code=>{
      clearTimeout(timer);
      clearTimeout(kill);
      if (!started) return resolve({error:'adapter_unavailable'});
      if (code !== 0 || overflow) return resolve({error:knownCode(stderr) ?? 'unknown'});
      resolve({body:Buffer.concat(chunks)});
    });
    child.stdin.end(body);
  });
}

function json(response, status, value, error) {
  response.writeHead(status, {'content-type':'application/json', 'cache-control':'no-store',
    ...(error && {'x-facade-terra-error':error})});
  response.end(JSON.stringify(value));
}

export function createMacTerraBridge({pauseFile,limitFile,ledgerDir,run}) {
  let busy = false;
  let draining = false;
  const same = (a,b) => b && a.id === b.id && a.maxCalls === b.maxCalls;
  async function currentGate() {
    if (draining || await isPaused(pauseFile)) return null;
    const limit = await readLimit(limitFile);
    if (limit === null) return null;
    const day = new Date().toISOString().slice(0,10);
    return {...limit,ledger:join(ledgerDir,limit ? 'limit-'+limit.id+'.jsonl' : 'dispatch-'+day+'.jsonl')};
  }
  async function availability() {
    const gate = await currentGate();
    if (!gate) return {error:'paused'};
    if (gate.maxCalls !== undefined && await usedCalls(gate.ledger) >= gate.maxCalls) return {error:'budget'};
    return {gate};
  }
  const server = createServer({requestTimeout:60000,headersTimeout:10000}, async (incoming,response)=>{
    let reserved = false;
    try {
      if (incoming.method === 'GET' && (incoming.url === '/health' || incoming.url === '/health/research')) {
        const {gate} = await availability();
        return json(response,200,{ready:Boolean(gate) && !busy,busy});
      }
      const path = incoming.url;
      if (incoming.method !== 'POST' || (path !== '/v1/review' && path !== '/v1/research')) return json(response,404,{},'request');
      const declared = Number(incoming.headers['content-length']);
      if (incoming.headers['content-type'] !== 'application/json' || !Number.isSafeInteger(declared)
          || declared < 1 || declared > terraRequestBytes) return json(response,400,{},'request');
      async function rejectBeforeDispatch(status,error) {
        // Finish the bounded upload before closing: otherwise a large request can
        // fail with EPIPE before the caller reads the pre-dispatch rejection.
        for await (const _ of incoming) { /* discard */ }
        return json(response,status,{},error);
      }
      if (busy) return await rejectBeforeDispatch(409,'busy');
      busy = reserved = true;
      const {gate,error} = await availability();
      if (!gate) return await rejectBeforeDispatch(503,error);
      let size = 0;
      const chunks = [];
      for await (const chunk of incoming) {
        size += chunk.length;
        if (size > declared) return json(response,400,{},'request');
        chunks.push(chunk);
      }
      if (size !== declared) return json(response,400,{},'request');
      const body = Buffer.concat(chunks);
      let input;
      try { input = JSON.parse(body.toString('utf8')); } catch { return json(response,400,{},'request'); }
      const kind = terraRequestKind(input);
      if (!kind || path !== `/v1/${kind}`) return json(response,400,{},'request');
      if (response.destroyed) return;
      if (!same(gate,await currentGate())) return json(response,503,{},'paused');
      const handle = await open(gate.ledger,'a',0o600);
      try {
        await handle.writeFile(JSON.stringify({at:new Date().toISOString(),requestSha256:createHash('sha256').update(body).digest('hex')})+'\n');
        await handle.sync();
      } finally { await handle.close(); }
      if (!same(gate,await currentGate())) return json(response,503,{},'paused');
      if (response.destroyed) return;
      const result = await run(body);
      if (result.error) return json(response,502,{},result.error);
      response.writeHead(200,{'content-type':'application/json','cache-control':'no-store','content-length':result.body.length});
      response.end(result.body);
    } catch {
      // An interrupted response never grants an automatic retry.
      if (!response.headersSent) json(response,500,{},'unknown');
      else response.destroy();
    } finally {
      if (reserved) busy = false;
    }
  });
  server.drain = () => { draining = true; server.close(); };
  return server;
}

async function main() {
  const {FACADE_TERRA_MAC_SOCKET:socket,FACADE_TERRA_MAC_PAUSE:pauseFile,FACADE_TERRA_MAC_LIMIT:limitFile,
    FACADE_TERRA_MAC_LEDGER:ledgerDir,FACADE_TERRA_MAC_ADAPTER:adapter} = process.env;
  if (![socket,pauseFile,limitFile,ledgerDir,adapter].every(path => typeof path === 'string' && isAbsolute(path)))
    throw Error('invalid_mac_terra_config');
  if (!(await lstat(adapter)).isFile()) throw Error('invalid_mac_terra_adapter');
  for (const path of new Set([dirname(socket),dirname(pauseFile),dirname(limitFile),ledgerDir])) {
    const dir = await lstat(path);
    if (!dir.isDirectory() || dir.uid !== process.getuid() || (dir.mode & 0o077)) throw Error('unsafe_mac_terra_directory');
  }
  process.umask(0o077);
  const server = createMacTerraBridge({pauseFile,limitFile,ledgerDir,run:body=>invokeAdapter(adapter,body)});
  server.on('error',error=>{console.error('mac-terra',error.code ?? 'listen_failed');process.exitCode=1;});
  server.listen(socket,()=>console.log(terraModel+' high • private transport ready'));
  process.once('SIGTERM',server.drain);
  process.once('SIGINT',server.drain);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  main().catch(error=>{console.error('mac-terra',error.code ?? error.message);process.exitCode=1;});
