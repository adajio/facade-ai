import { request as httpRequest } from 'node:http';
import { randomUUID } from 'node:crypto';
import { link, lstat, open, readFile, readdir, unlink } from 'node:fs/promises';
import { dirname, isAbsolute, join } from 'node:path';
import { ModelTransportError } from '../request-budget.mjs';

export const terraModel = 'gpt-6.1-terra';
export const terraRequestBytes = 24 * 1024 * 1024;
export const terraResponseBytes = 8 * 1024 * 1024;
export const terraTools = new Set(['submit_preliminary_review', 'revise_package_review']);
const id = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/u;
const transportUnavailable = 'mac_terra_not_started';

const automaticAdmission = `SELECT
  EXISTS (SELECT 1 FROM gateway_attempts a JOIN intake_receipts r ON r.id=$2 AND r.project_id=a.project_id
    WHERE a.project_id=$1 AND a.created_at>=r.created_at AND a.state IN ('reserved','prepared','sending','unknown')) AS held,
  EXISTS (SELECT 1 FROM intake_receipts WHERE project_id=$1 AND id=$2
    AND sealed_at IS NOT NULL AND created_at > $3::timestamptz) AS automatic`;
const preciseTimestamp = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/u;

async function readActivation(path) {
  try {
    const value = (await readFile(path,'utf8')).trim();
    if (!preciseTimestamp.test(value) || !Number.isFinite(Date.parse(value))) throw Error('invalid_terra_activation');
    return value;
  } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

async function activationTime(db,stateDir) {
  const path = join(stateDir,'production-activation');
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

export function allowedTerraRequest(value) {
  return value?.model === terraModel && value.tool_choice === 'required' && Array.isArray(value.messages)
    && value.messages.length > 0 && Array.isArray(value.tools) && value.tools.length === 1
    && value.tools[0]?.type === 'function' && terraTools.has(value.tools[0]?.function?.name);
}

export function terraRejection(code) {
  return knownRejection.has(code) ? code : undefined;
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
  let activatedAt;
  const pause = join(dirname(admission),'paused');
  return {
    async activate(db,stateDir) {
      activatedAt = await activationTime(db,stateDir);
      return activatedAt;
    },
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
    async hold(tx,snapshot) {
      if (!activatedAt) throw Error('terra_activation_required');
      if (await paused(pause)) return 'held_terra_production_paused';
      const grants = await readGrants(admission);
      const explicit = grants.some(grant => grant.projectId === snapshot.projectId && grant.receiptId === snapshot.receiptId &&
        grant.preparationId === snapshot.preparationId);
      const {rows:[status]} = await tx.query(automaticAdmission,[snapshot.projectId,snapshot.receiptId,activatedAt]);
      if (!explicit && status?.automatic !== true) return 'held_terra_production_admission';
      if (status?.held !== false) return 'held_terra_prior_provider_attempt';
      try {
        const health = await send(socket,'GET','/health',undefined,2000);
        if (health.status === 200 && JSON.parse(health.body)?.ready === true) return null;
      } catch { /* Keep the attempt unclaimed while the private transport is unavailable. */ }
      return 'held_terra_mac_unavailable';
    },
    async call(request) {
      if (!allowedTerraRequest(request)) throw new ModelTransportError('rejected','invalid_mac_terra_request');
      const body = Buffer.from(JSON.stringify(request));
      if (body.length > terraRequestBytes) throw new ModelTransportError('rejected','adapter_input_too_large');
      const result = await send(socket,'POST','/v1/review',body,270000);
      if (result.status !== 200) {
        const rejected = knownRejection.get(result.type);
        throw new ModelTransportError(rejected ? 'rejected' : 'unknown',rejected ?? 'mac_terra_outcome_unknown');
      }
      let response;
      try { response = JSON.parse(result.body); }
      catch { throw new ModelTransportError('unknown','mac_terra_outcome_unknown'); }
      if (response?.model !== terraModel || response.local_effort !== 'high')
        throw new ModelTransportError('unknown','mac_terra_profile_unconfirmed');
      return response;
    },
  };
}
