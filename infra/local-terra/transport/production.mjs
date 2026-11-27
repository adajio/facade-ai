import { request as httpRequest } from 'node:http';
import { randomUUID } from 'node:crypto';
import { link, lstat, open, readFile, readdir, unlink } from 'node:fs/promises';
import { dirname, isAbsolute, join } from 'node:path';
import { ModelTransportError } from '../request-budget.mjs';

export const terraModel = 'gpt-6.1-terra';
export const terraRequestBytes = 24 * 1024 * 1024;
export const terraResponseBytes = 8 * 1024 * 1024;
const reviewTools = new Set(['submit_preliminary_review', 'revise_package_review']);
const researchTools = new Set([
  'inventory','survey','zoom','extract','ocr','search','save_observation','request_next','finish_reading',
  'inspect_structure','record_blocks','record_semantic_check','context_inventory','open_context','save_compound_observation',
]);
const id = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/u;
const transportUnavailable = 'mac_terra_not_started';

const automaticAdmission = `SELECT
  EXISTS (SELECT 1 FROM project_reading_activity restored WHERE restored.project_id=$1 AND restored.receipt_id=$2
    AND restored.stage='saved_review' AND restored.status='restored') AS restored,
  EXISTS (SELECT 1 FROM gateway_attempts a JOIN intake_receipts r ON r.id=$2 AND r.project_id=a.project_id
    WHERE a.project_id=$1 AND a.created_at>=r.created_at AND a.state IN ('reserved','prepared','sending','unknown')) AS held,
  EXISTS (SELECT 1 FROM intake_receipts WHERE project_id=$1 AND id=$2
    AND analysis_scenario=2 AND sealed_at IS NOT NULL AND created_at > $3::timestamptz) AS automatic,
  EXISTS (SELECT 1 FROM intake_receipts WHERE project_id=$1 AND id=$2 AND analysis_scenario=1) AS "otherScenario"`;
const preciseTimestamp = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/u;

async function readActivation(path) {
  try {
    const value = (await readFile(path,'utf8')).trim();
    if (!preciseTimestamp.test(value) || !Number.isFinite(Date.parse(value))) throw Error('invalid_terra_activation');
    return value;
  } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

async function activationTime(db,stateDir,fileName) {
  const path = join(stateDir,fileName);
  const saved = await readActivation(path);
  if (saved) return saved;
  const {rows:[{time}]} = await db.query(
    `SELECT to_char(clock_timestamp() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS time`);
  if (!preciseTimestamp.test(time) || !Number.isFinite(Date.parse(time))) throw Error('invalid_terra_activation_clock');
  const staged = join(stateDir,'.activation-'+randomUUID());
  try {
    const file = await open(staged,'wx',0o600);
    try { await file.writeFile(time+'\n'); await file.sync(); }
    finally { await file.close(); }
    try { await link(staged,path); }
    catch (error) { if (error.code !== 'EEXIST') throw error; }
    const directory = await open(stateDir,'r');
    try { await directory.sync(); }
    finally { await directory.close(); }
    return await readActivation(path);
  } finally { await unlink(staged).catch(()=>{}); }
}

async function paused(path) {
  try { await lstat(path); return true; }
  catch (error) { if (error.code === 'ENOENT') return false; throw error; }
}

const knownRejection = new Map([
  ['paused','mac_terra_paused'], ['busy','mac_terra_busy'], ['budget','mac_terra_budget_exhausted'],
  ['request','invalid_mac_terra_request'], ['adapter_unavailable','adapter_unavailable'],
  ['codex_context_limit','provider_context_limit'], ['codex_request_too_large','provider_request_too_large'],
  ['codex_usage_limit','provider_usage_limit'], ['codex_login_required','provider_auth_required'],
  ['input_too_large','adapter_input_too_large'], ['unsupported_model','adapter_unsupported_model'],
  ['invalid_function_arguments','invalid_model_arguments'], ['invalid_codex_response','invalid_model_response'],
  ['unknown_function','invalid_model_tool'],
]);
const preDispatchStatuses = new Map([['paused',503],['busy',409],['budget',503],['request',400]]);

const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const fields = (value,allowed) => record(value) && Object.keys(value).every(key=>allowed.includes(key));
const pngPrefix = 'data:image/png;base64,';
const base64 = /^[A-Za-z0-9+/]+={0,2}(?![\s\S])/u;

function allowedImage(part) {
  const {url} = part.image_url ?? {};
  if (!fields(part,['type','image_url']) || part.type !== 'image_url' || !fields(part.image_url,['url']) ||
      typeof url !== 'string' || !url.startsWith(pngPrefix)) return false;
  const encoded = url.slice(pngPrefix.length);
  if (encoded.length < 32 || encoded.length % 4 || !base64.test(encoded)) return false;
  const size = encoded.length / 4 * 3 - (encoded.endsWith('==') ? 2 : Number(encoded.endsWith('=')));
  if (size < 24 || size > 8 * 1024 * 1024) return false;
  const header = Buffer.from(encoded.slice(0,32),'base64');
  const width = header.readUInt32BE(16), height = header.readUInt32BE(20);
  return header.subarray(0,8).equals(Buffer.from('89504e470d0a1a0a','hex')) && header.toString('ascii',12,16) === 'IHDR'
    && width > 0 && height > 0 && width * height <= 24_000_000;
}

function allowedToolCall(call,names) {
  if (!fields(call,['id','type','function']) || call.type !== 'function' || typeof call.id !== 'string' || !call.id || call.id.length > 180 ||
      !fields(call.function,['name','arguments']) || !names.has(call.function.name) || typeof call.function.arguments !== 'string' ||
      call.function.arguments.length > 65_536) return false;
  try { return record(JSON.parse(call.function.arguments)); }
  catch { return false; }
}

function allowedMessages(messages,names,research) {
  if (!Array.isArray(messages) || messages.length < 2 || messages[0]?.role !== 'system' || messages[1]?.role !== 'user' ||
      (!research && messages.length !== 2)) return false;
  const seen = new Set();
  let pending, images = 0;
  for (const [index,message] of messages.entries()) {
    if (!record(message)) return false;
    const {role,content,tool_calls:calls,tool_call_id:reply} = message;
    if (pending !== undefined) {
      if (role !== 'tool' || reply !== pending || typeof content !== 'string' || !fields(message,['role','tool_call_id','content'])) return false;
      pending = undefined;
    } else if (index === 0) {
      if (typeof content !== 'string' || !fields(message,['role','content'])) return false;
    } else if (role === 'user') {
      if (!fields(message,['role','content'])) return false;
      if (typeof content === 'string') continue;
      if (!Array.isArray(content) || !content.length || !content.every(part=>
        part?.type === 'text' ? fields(part,['type','text']) && typeof part.text === 'string' : ++images <= 32 && allowedImage(part ?? {}))) return false;
    } else if (research && role === 'assistant') {
      if (!fields(message,['role','content','tool_calls']) || (content != null && typeof content !== 'string')) return false;
      if (calls === undefined) {
        if (typeof content !== 'string') return false;
      } else {
        if (!Array.isArray(calls) || calls.length !== 1 || !allowedToolCall(calls[0],names) || seen.has(calls[0].id)) return false;
        pending = calls[0].id;
        seen.add(pending);
      }
    } else return false;
  }
  return pending === undefined;
}

export function terraRequestKind(value) {
  if (!record(value) || value.model !== terraModel || !Array.isArray(value.tools)) return;
  const research = value.tools.length === researchTools.size;
  if (research ? !fields(value,['model','messages','tools','tool_choice','parallel_tool_calls','max_tokens','stream']) ||
        !['required','auto'].includes(value.tool_choice) || value.parallel_tool_calls !== false || value.stream !== false || value.max_tokens !== 2048
    : !fields(value,['model','messages','tools','tool_choice']) || value.tool_choice !== 'required' || value.tools.length !== 1) return;
  const names = new Set();
  for (const tool of value.tools) {
    if (!fields(tool,['type','function']) || tool.type !== 'function' || !fields(tool.function,['name','description','parameters'])) return;
    const {name,description,parameters} = tool.function;
    if (!(research ? researchTools : reviewTools).has(name) || names.has(name) ||
        ((research || description !== undefined) && typeof description !== 'string') ||
        ((research || parameters !== undefined) && !record(parameters))) return;
    names.add(name);
  }
  if (allowedMessages(value.messages,names,research)) return research ? 'research' : 'review';
}

function allowedResearchResponse(response,request) {
  if (typeof response.id !== 'string' || !response.id || !Array.isArray(response.choices) || response.choices.length !== 1) return false;
  const choice = response.choices[0];
  const message = choice?.message;
  if (!fields(message,['role','content','tool_calls']) || message.role !== 'assistant') return false;
  if (choice.finish_reason === 'stop') return request.tool_choice === 'auto' && typeof message.content === 'string' && message.tool_calls === undefined;
  return choice.finish_reason === 'tool_calls' && message.content === null && Array.isArray(message.tool_calls) &&
    message.tool_calls.length === 1 && allowedToolCall(message.tool_calls[0],researchTools);
}

export function terraRejection(code) {
  return knownRejection.has(code) && !preDispatchStatuses.has(code) ? code : undefined;
}

function send(socketPath, method, path, body, timeout) {
  return new Promise((resolve, reject) => {
    let connected = false;
    const failure = () => reject(new ModelTransportError(connected ? 'unknown' : 'rejected',
      connected ? 'mac_terra_outcome_unknown' : transportUnavailable));
    const outgoing = httpRequest({
      socketPath, method, path, agent:false, signal:AbortSignal.timeout(timeout),
      ...(body && {headers:{'content-type':'application/json','content-length':body.length}}),
    }, response => {
      connected = true;
      const chunks = [];
      let size = 0;
      response.on('data', chunk => {
        size += chunk.length;
        if (size > terraResponseBytes) return response.destroy(new Error('response_limit'));
        chunks.push(chunk);
      });
      response.on('error', failure);
      response.on('aborted', failure);
      response.on('end', () => resolve({status:response.statusCode, type:response.headers['x-facade-terra-error'],
        body:Buffer.concat(chunks).toString('utf8')}));
    });
    outgoing.on('socket', socket => socket.once('connect', () => { connected = true; }));
    outgoing.on('error', failure);
    outgoing.end(body);
  });
}

async function readGrants(path) {
  try {
    const file = await lstat(path);
    if (!file.isFile() || (file.mode & 0o022) || file.size > 64 * 1024) return [];
    const value = JSON.parse(await readFile(path,'utf8'));
    if (Array.isArray(value) && value.every(grant => grant && Object.keys(grant).length === 3 &&
        ['projectId','receiptId','preparationId'].every(field => typeof grant[field] === 'string' && id.test(grant[field]))))
      return value;
  } catch { /* A missing or malformed closed file admits no new model requests. */ }
  return [];
}

async function entries(path) {
  try { return await readdir(path); }
  catch (error) { if (error.code === 'ENOENT') return []; throw error; }
}

export function productionTerra(env = process.env) {
  const socket = env.FACADE_TERRA_PRODUCTION_SOCKET;
  const admission = env.FACADE_TERRA_PRODUCTION_ADMISSION;
  if (!socket && !admission) return null;
  if (!socket || !admission || !isAbsolute(socket) || !isAbsolute(admission)) throw Error('invalid_production_terra_config');
  let activatedAt, researchActivatedAt;
  const pause = join(dirname(admission),'paused');
  async function admissions({research = false} = {}) {
    const cutoff = research ? researchActivatedAt : activatedAt;
    if (!cutoff) throw Error('terra_activation_required');
    if (await paused(pause)) return null;
    return {activatedAt:cutoff,grants:research ? [] : await readGrants(admission)};
  }
  return {
    async activate(db,stateDir,{research = false} = {}) {
      const cutoff = await activationTime(db,stateDir,research ? 'production-research-activation' : 'production-activation');
      if (research) researchActivatedAt = cutoff;
      else activatedAt = cutoff;
      return cutoff;
    },
    admissions,
    async receipts(rows,stateDir) {
      if (!activatedAt) throw Error('terra_activation_required');
      const grants = await paused(pause) ? [] : await readGrants(admission);
      const admitted = new Set(grants.map(grant => grant.receiptId));
      for (const name of await entries(stateDir)) {
        const receipt = name.slice(0,36);
        if (id.test(receipt) && /^(-[a-f0-9]{64})?\.json$/u.test(name.slice(36))) admitted.add(receipt);
      }
      for (const directory of ['addressed','revisions']) {
        for (const receipt of await entries(join(stateDir,directory))) {
          if (id.test(receipt)) admitted.add(receipt);
        }
      }
      const automatic = !await paused(pause);
      return rows.filter(row => admitted.has(row.id) || automatic && preciseTimestamp.test(row.createdAt) && row.createdAt > activatedAt);
    },
    async hold(tx,snapshot,{research = false} = {}) {
      const access = await admissions({research});
      if (!access) return 'held_terra_production_paused';
      const {activatedAt,grants} = access;
      const explicit = grants.some(grant => grant.projectId === snapshot.projectId && grant.receiptId === snapshot.receiptId &&
        grant.preparationId === snapshot.preparationId);
      const {rows:[status]} = await tx.query(automaticAdmission,[snapshot.projectId,snapshot.receiptId,activatedAt]);
      if (status?.otherScenario) return 'held_other_analysis_scenario';
      if (status?.restored) return 'held_terra_saved_review';
      if (!explicit && status?.automatic !== true) return 'held_terra_production_admission';
      if (status?.held !== false) return 'held_terra_prior_provider_attempt';
      try {
        const health = await send(socket,'GET',research ? '/health/research' : '/health',undefined,2000);
        if (health.status === 200) {
          const state = JSON.parse(health.body);
          if (state) {
            if (state.ready === true) return null;
            if (research && state.busy === true) return 'held_terra_mac_busy';
          }
        }
      } catch { /* Keep the attempt unclaimed while the private transport is unavailable. */ }
      return 'held_terra_mac_unavailable';
    },
    async call(request) {
      const kind = terraRequestKind(request);
      if (!kind) throw new ModelTransportError('rejected','invalid_mac_terra_request');
      const body = Buffer.from(JSON.stringify(request));
      if (body.length > terraRequestBytes) throw new ModelTransportError('rejected','adapter_input_too_large');
      const result = await send(socket,'POST',`/v1/${kind}`,body,270000);
      if (result.status !== 200) {
        const expectedStatus = preDispatchStatuses.get(result.type) ?? 502;
        const rejected = (result.status === expectedStatus || result.type === 'request' && result.status === 404) && knownRejection.get(result.type);
        throw new ModelTransportError(rejected ? 'rejected' : 'unknown',rejected || 'mac_terra_outcome_unknown');
      }
      let response;
      try { response = JSON.parse(result.body); }
      catch { throw new ModelTransportError('unknown','mac_terra_outcome_unknown'); }
      if (response?.model !== terraModel || response.local_effort !== 'high')
        throw new ModelTransportError('unknown','mac_terra_profile_unconfirmed');
      if (kind === 'research' && !allowedResearchResponse(response,request))
        throw new ModelTransportError('unknown','mac_terra_outcome_unknown');
      return response;
    },
  };
}
