import { recordPrimaryActivity } from './activity.mjs';

export const maxInputTokens = 65_536;
export const maxRequestBytes = 60_000;
export const maxWireBytes = 6 * 1024 ** 2;
export const maxImageBytes = 4 * 1024 ** 2;
export const maxImageCount = 24;
const imageTokens = 2048;
const pngDataPrefix = 'data:image/png;base64,';
const base64 = /^[A-Za-z0-9+/]+={0,2}(?![\s\S])/u;
// This signed, tool-disabled Codex profile adds fixed instructions, an output schema and framing.
// Reserve their allowance separately from the variable, byte-level BPE input. The private Terra
// tokenizer isn't exposed by the adapter. Its measured usage is reported independently after a turn.
const profileOverheadTokens = 8_192;

export function measureRequest(request) {
  const wireBytes = Buffer.byteLength(JSON.stringify(request));
  let imageCount = 0, imageBytes = 0, invalidMedia = false;
  const messages = request.messages?.map(message => {
    if (!Array.isArray(message.content)) return message;
    const content = message.content.map(part => {
      if (part?.type === 'text') {
        invalidMedia ||= typeof part.text !== 'string';
        return part;
      }
      if (part?.type !== 'image_url') {
        invalidMedia = true;
        return part;
      }
      const url = part.image_url?.url;
      const encoded = typeof url === 'string' && url.startsWith(pngDataPrefix) ? url.slice(pngDataPrefix.length) : '';
      if (message.role !== 'user' || !encoded || encoded.length % 4 || !base64.test(encoded)) {
        invalidMedia = true;
      } else {
        imageBytes += encoded.length * 3 / 4 - (encoded.endsWith('==') ? 2 : Number(encoded.endsWith('=')));
      }
      return {type:'attached_image',ordinal:++imageCount};
    });
    return {...message,content};
  });
  // The Python adapter replaces each data URL with its attachment ordinal before composing the prompt.
  const adapterBytes = imageCount ? Buffer.byteLength(JSON.stringify({...request,messages})) : wireBytes;
  const tools = imageCount && request.tools === undefined ? [] : request.tools;
  const promptBytes = Buffer.byteLength(JSON.stringify({messages,available_functions:tools}));
  return {requestBytes:Math.max(adapterBytes,promptBytes),promptBytes,wireBytes,imageBytes,imageCount,
    estimatedInputTokens:promptBytes + profileOverheadTokens + imageCount * imageTokens,maxInputTokens,maxRequestBytes,
    ...(invalidMedia && {invalidMedia})};
}

export function remainingRequestBytes({
  requestBytes,estimatedInputTokens,maxRequestBytes:limit=maxRequestBytes,
  wireBytes=requestBytes,imageBytes=0,imageCount=0,invalidMedia=false,
}) {
  if (invalidMedia || imageBytes > maxImageBytes || imageCount > maxImageCount) return -1;
  // Extra text adds escaped UTF-8 bytes both to the wire representation and to the projected request.
  return Math.min(Math.min(limit,maxRequestBytes)-requestBytes,maxInputTokens-estimatedInputTokens,maxWireBytes-wireBytes);
}

export function messageEntryBytes(value) {
  return Buffer.byteLength(JSON.stringify(JSON.stringify(value))) - 1; // Escaping plus one array separator.
}

export function responseUsage(response) {
  const {prompt_tokens:inputTokens,completion_tokens:outputTokens} = response?.usage ?? {};
  const count = value => Number.isSafeInteger(value) && value >= 0;
  return {...(count(inputTokens) && {inputTokens}), ...(count(outputTokens) && {outputTokens})};
}

export async function emitActivity(record, db, snapshot, stage, status, attemptKey, fields, reason) {
  if (!snapshot?.preparationId) return;
  const {projectId,receiptId,preparationId} = snapshot;
  try {
    await (record ?? recordPrimaryActivity)(db, {projectId,receiptId,preparationId,stage,status,attemptKey,fields,reason});
  } catch {
    // The fsynced attempt and the report transaction remain authoritative. A telemetry failure
    // cannot invalidate an answer or trigger a second invocation.
  }
}

export function duration(from, to = Date.now()) {
  if (from == null) return {};
  const elapsedMs = to - new Date(from).valueOf();
  return Number.isSafeInteger(elapsedMs) && elapsedMs >= 0 ? {elapsedMs} : {};
}

export function modelFailure(error) {
  return error instanceof ModelTransportError ? {state:error.state,reason:error.message}
    : {state:'unknown',reason:'model_request_failed_or_unknown'};
}

export class ModelTransportError extends Error {
  constructor(state, reason) {
    super(reason);
    this.state = state;
  }
}

const common = new Set('докум проект раздел фасад указан выпол налич состав матери групп долже требов syste docume compl certific proje part object drawin'.split(' '));

function terms(value) {
  return String(value ?? '').toLowerCase().normalize('NFKC').replaceAll('ё','е').match(/[\p{L}\p{N}]{3,}/gu)
    ?.map(word => word.slice(0, /[а-я]/.test(word) ? 5 : 6)).filter(term => !common.has(term)) ?? [];
}

function vocabulary(requirements) {
  const index = new Map();
  for (const [criterion, row] of requirements.entries()) {
    const weights = new Map();
    const rule = row.evidenceRule;
    const subjects = Array.isArray(rule?.allOf)
      ? rule.allOf.flatMap(group => Array.isArray(group?.anyOf)
        ? group.anyOf.map(option => option?.subject).filter(subject => typeof subject === 'string') : [])
      : [];
    for (const field of [typeof rule === 'string' ? rule : '',row.completenessCriterion,row.applicability]) {
      for (const term of terms(field)) weights.set(term, 1);
    }
    for (const field of [row.part,row.aliases,row.equivalents,...subjects]) {
      for (const term of terms(field)) weights.set(term, 4);
    }
    for (const [term, weight] of weights) {
      const matches = index.get(term) ?? [];
      matches.push([criterion,weight]);
      index.set(term,matches);
    }
  }
  return index;
}

export function prioritizeEvidence(items, requirements, describe) {
  const index = vocabulary(requirements);
  const groups = new Map(), best = new Map();
  for (const item of items) {
    const {source,text,label} = describe(item);
    const scores = new Map();
    for (const [value, factor] of [[text,3],[label,1]]) {
      for (const term of new Set(terms(value))) {
        for (const [criterion, weight] of index.get(term) ?? []) {
          scores.set(criterion,(scores.get(criterion) ?? 0)+weight*factor);
        }
      }
    }
    let score = 0;
    for (const value of scores.values()) score = Math.max(score,value);
    const candidate = {item,score};
    for (const [criterion, value] of scores) {
      if (value > (best.get(criterion)?.value ?? 0)) best.set(criterion,{candidate,value});
    }
    const group = groups.get(source) ?? [];
    group.push(candidate);
    groups.set(source,group);
  }
  const queues = [...groups.values()].map(group => group.sort((a,b) => b.score-a.score));
  queues.sort((a,b) => b[0].score-a[0].score);
  const selected = new Set([...best.values()].map(({candidate}) => candidate.item));
  for (let active = queues, rank = 0; active.length; rank++) {
    active = active.filter(queue => {
      selected.add(queue[rank].item);
      return queue.length > rank+1;
    });
  }
  return [...selected];
}

// Keep the model-facing catalog legible while sharing repeated lists and repeated
// subject/role alternatives. The persisted and validated catalog stays canonical.
export function compactCatalog(requirements) {
  const fields = ['aliases','formats','equivalents','sourceRoles'];
  const lists = [];
  const entries = requirements.map(requirement => {
    const row = {...requirement};
    for (const field of fields) {
      if (!Array.isArray(row[field])) continue;
      const list = row[field];
      if (!list.length) { delete row[field]; continue; }
      const index = lists.findIndex(entry=>JSON.stringify(entry)===JSON.stringify(list));
      if (index === -1) row[field] = lists.push(list);
      else row[field] = index+1;
    }
    if (Array.isArray(row.evidenceRule?.allOf) && Object.keys(row.evidenceRule).length===1 &&
        row.evidenceRule.allOf.every(group=>Array.isArray(group?.anyOf) && Object.keys(group).length===1 &&
          group.anyOf.every(option=>option && Object.keys(option).every(key=>['mode','subject','sourceRole'].includes(key))))) {
      row.evidenceRule = row.evidenceRule.allOf.map(({anyOf}) => {
        const options = new Map();
        for (const {mode,subject,sourceRole} of anyOf) {
          const key = JSON.stringify([mode,subject]);
          if (!options.has(key)) options.set(key,[subject ?? null,mode,[]]);
          options.get(key)[2].push(sourceRole);
        }
        return [...options.values()];
      });
    }
    return row;
  });
  return {requirements:entries,catalogLists:lists};
}
