import {createHash} from 'node:crypto';
import {mkdir,writeFile,readFile} from 'node:fs/promises';
import {writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {gzipSync} from 'node:zlib';

const origin='https://api.cheaperinference.com';
const maxWireBytes=4_500_000;
const maxInflatedBytes=20_000_000;
const allowedModels=new Set(['gpt-6.2-sol','gpt-6.1-terra']);
const record=value=>value && typeof value==='object' && !Array.isArray(value);
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const sha256=/^[a-f0-9]{64}$/;
const hash=value=>createHash('sha256').update(value).digest('hex');
function allowedImage(part,profile) {
  if(typeof part.image_url?.url!=='string') return false;
  const payload=part.image_url.url.match(/^data:image\/png;base64,([A-Za-z0-9+/]+=*)$/u)?.[1];
  if(!payload || payload.length>Math.ceil(profile.maxImageBytes/3)*4) return false;
  const image=Buffer.from(payload,'base64');
  if(image.length<33 || image.length>profile.maxImageBytes || image.subarray(0,8).toString('hex')!=='89504e470d0a1a0a') return false;
  const width=image.readUInt32BE(16),height=image.readUInt32BE(20);
  return width>0 && height>0 && width<=profile.maxImageWidth && height<=profile.maxImageHeight &&
    width*height<=profile.maxImagePixels;
}

export function prepareRequest(profile,request) {
  if(!record(request) || !allowedModels.has(profile.wireModel) || request.model!==profile.localModel ||
      request.stream!==false || request.tool_choice!==profile.toolChoice || !Array.isArray(request.tools) ||
      !Array.isArray(request.messages) || request.max_tokens!==profile.maxTokens ||
      request.parallel_tool_calls!==false || 'max_completion_tokens' in request) return null;
  const images=request.messages.flatMap(message=>Array.isArray(message?.content)?message.content:[])
    .filter(part=>part?.type==='image_url');
  if(images.length>(profile.maxImages??0) || images.some(part=>!allowedImage(part,profile))) return null;
  // The reference OpenRouter routes omit parallel_tool_calls from their provider wire payload.
  const {parallel_tool_calls: sequential, ...body}=request;
  const wire=JSON.stringify({...body,model:profile.wireModel,zdr:true,min_discount_percent:0});
  if(Buffer.byteLength(wire)>Math.min(profile.maxRequestBytes??maxWireBytes,maxInflatedBytes)) return null;
  return wire;
}

export function parseReceipt({result,headers,model,ceilingUsdNanos,evidenceRef}) {
  const providerId=result.request_id ?? headers.get('x-ci-request-id') ?? headers.get('x-request-id');
  const billed=result.billing?.billed_cost_usd;
  if(!uuid.test(providerId ?? '') ||
      (headers.has('x-ci-request-id') && headers.get('x-ci-request-id')!==providerId) ||
      result.billing?.status!=='settled' || result.billing?.currency!=='USD' ||
      typeof billed!=='string' || !/^\d{1,5}\.\d{6}$/.test(billed)) {
    return {receipt:{state:'unknown',code:'cheaper_billing_unconfirmed',...(uuid.test(providerId ?? '')&&{providerId})}};
  }
  const [dollars,micros]=billed.split('.');
  const costUsdNanos=Number(dollars)*1_000_000_000+Number(micros)*1000;
  const promptTokens=result.usage?.prompt_tokens;
  const completionTokens=result.usage?.completion_tokens;
  const routeVerified=result.model===model && !headers.has('x-ci-warning') &&
    Number.isSafeInteger(promptTokens) && promptTokens>=0 &&
    Number.isSafeInteger(completionTokens) && completionTokens>=0 && costUsdNanos<=ceilingUsdNanos;
  return {receipt:{state:'paid',costUsdNanos,providerId,evidenceRef,model:typeof result.model==='string'?result.model:'unknown',
    provider:'CheaperInference',routeVerified,
    ...(Number.isSafeInteger(promptTokens)&&promptTokens>=0&&{promptTokens}),
    ...(Number.isSafeInteger(completionTokens)&&completionTokens>=0&&{completionTokens})},
    ...(routeVerified&&{output:result})};
}

export async function createTransport({routes,traceDir,apiKey,projectId,revision,allowedSha256s,networkEnabled=false,fetcher=fetch}) {
  if(!apiKey || !uuid.test(projectId) || !revision || !routes.length) throw new Error('Incomplete isolated route scope');
  if(!Array.isArray(allowedSha256s) || !allowedSha256s.length || !allowedSha256s.every(value=>sha256.test(value))) {
    throw new Error('Frozen input hashes are required');
  }
  const byRoute=new Map(routes.map(route=>[route.id,route]));
  if(byRoute.size!==routes.length) throw new Error('Duplicate route');
  for(const route of routes) {
    if(!allowedModels.has(route.wireModel) || !route.localModel.startsWith('managed/') ||
        !route.supplier || !sha256.test(route.sourceSha256) || !Number.isSafeInteger(route.ceilingUsdNanos) ||
        route.ceilingUsdNanos<1 || route.ceilingUsdNanos>5_000_000_000) throw new Error('Unqualified route');
  }
  await mkdir(traceDir,{recursive:true,mode:0o700});
  const store=(key,data)=>writeFile(join(traceDir,key+'.json'),JSON.stringify(data)+'\n',{mode:0o600,flag:'wx'});
  const client=(path,options)=>fetcher(origin+path,{...options,redirect:'error',
    headers:{authorization:'Bearer '+apiKey,accept:'application/json',...options.headers}});
  return {
    kind:'managed',
    async lookup(attempt) {
      if(!uuid.test(attempt.id??'') || attempt.projectId!==projectId || attempt.revision!==revision) return null;
      const selected=byRoute.get(attempt.routeId);
      if(!selected) return null;
      const read=async suffix=>JSON.parse(await readFile(join(traceDir,attempt.id+'.'+suffix+'.json'),'utf8'));
      try {
        const [intent,completion,http]=await Promise.all([read('intent'),read('completion'),read('http')]);
        const {receipt,output}=completion;
        if(intent.attemptId!==attempt.id || intent.jobId!==attempt.jobId || intent.requestHash!==attempt.requestHash ||
            intent.effectKey!==attempt.effectKey || intent.model!==selected.wireModel || http.status!==200 || http.warning ||
            receipt.state!=='paid'||receipt.routeVerified!==true||receipt.model!==selected.wireModel||
            receipt.evidenceRef!=='ci-test:'+attempt.id||!uuid.test(receipt.providerId)||
            !Number.isSafeInteger(receipt.costUsdNanos)||receipt.costUsdNanos<0||
            receipt.costUsdNanos>attempt.ceilingUsdNanos||!Array.isArray(output?.choices)) return null;
        return completion;
      } catch {return null;}
    },
    quote(route,request) {
      const selected=byRoute.get(route.id);
      if(!selected || route.revision!==revision || !prepareRequest(selected,request)) return null;
      return {ceilingUsdNanos:selected.ceilingUsdNanos,pricingFingerprint:selected.sourceSha256};
    },
    async authorize(tx,route,context) {
      if(!byRoute.has(route.id) || context.projectId!==projectId || context.scopeId!==null ||
          context.dataClass!=='synthetic' || !context.inputRefs.every(id=>uuid.test(id))) return false;
      const refs=[...new Set(context.inputRefs)];
      const {rows:[result]}=await tx.query(`SELECT
        NOT EXISTS(SELECT 1 FROM intake_originals WHERE project_id=$1 AND sha256<>ALL($2::text[]))
        AND (SELECT count(*) FROM reader_evidence e INNER JOIN reader_maps m USING(project_id,version_id,reader_version)
          WHERE e.project_id=$1 AND e.run_id=$3 AND e.id=ANY($4::uuid[]) AND m.original_sha256=ANY($2::text[]))=$5 AS allowed`,
        [projectId,allowedSha256s,context.jobId,refs,refs.length]);
      return result.allowed;
    },
    async send(attempt,route,request,signal) {
      const selected=byRoute.get(route.id);
      const body=selected && prepareRequest(selected,request);
      const rejected=code=>({receipt:{state:'rejected',code,evidenceRef:'ci-test:'+attempt.id}});
      const unknown=code=>({receipt:{state:'unknown',code}});
      if(!networkEnabled || !body || !uuid.test(attempt.id ?? '') || attempt.projectId!==projectId ||
         !sha256.test(attempt.requestHash??'') || attempt.dataClass!=='synthetic' || route.revision!==revision ||
         attempt.ceilingUsdNanos!==selected.ceilingUsdNanos || attempt.previousRejectedId) {
        return rejected('cheaper_isolated_scope_mismatch');
      }
      const compressed=Buffer.byteLength(body)>maxWireBytes?gzipSync(body):null;
      if(compressed && compressed.length>maxWireBytes) return rejected('cheaper_wire_limit');
      // Exclusive creation persists the attempt before any network traffic. Existing attempts are not resent.
      try {
        const intent={attemptId:attempt.id,jobId:attempt.jobId,purpose:attempt.purpose,
          effectKey:attempt.effectKey,requestHash:attempt.requestHash,wireSha256:hash(body),model:selected.wireModel,
          ceilingUsdNanos:attempt.ceilingUsdNanos};
        writeFileSync(join(traceDir,attempt.id+'.intent.json'),JSON.stringify(intent)+'\n',{mode:0o600,flag:'wx',flush:true});
      } catch(error) {
        return error.code==='EEXIST'?unknown('cheaper_duplicate_attempt'):rejected('cheaper_intent_not_saved');
      }
      try {
        const response=await client('/v1/chat/completions',{method:'POST',signal,body:compressed??body,
          headers:{'content-type':'application/json','x-ci-model-lock':'1','x-ci-techniques':'off',
            ...(compressed&&{'content-encoding':'gzip'})}});
        const bytes=await response.text();
        let result;
        try {result=JSON.parse(bytes);} catch {result=null;}
        const safeCode=String(result?.error?.code??'');
        await store(attempt.id+'.http',{status:response.status,responseSha256:hash(bytes),
          errorCode:/^[a-z_]{1,64}$/.test(safeCode)?safeCode:null,
          parameter:/^[A-Za-z0-9_.-]{1,64}$/.test(result?.error?.param??'')?result.error.param:null,
          warning:response.headers.has('x-ci-warning')});
        if(!response.ok || !record(result)) {
          const definiteRejection={400:new Set(['unsupported_parameter','model_lock_conflict','invalid_contract_header',
             'invalid_request','task_budget_exhausted','task_budget_required']),
            403:new Set(['model_not_allowed']),500:new Set(['model_lock_violation']),
            503:new Set(['zdr_capacity_unavailable','min_discount_unavailable'])};
          return definiteRejection[response.status]?.has(safeCode) ?
            rejected('cheaper_'+safeCode) : unknown('cheaper_http_'+response.status);
        }
        const outcome=parseReceipt({result,headers:response.headers,model:selected.wireModel,
          ceilingUsdNanos:attempt.ceilingUsdNanos,evidenceRef:'ci-test:'+attempt.id});
        if(outcome.output) {
          // Keep only the completion consumed by the harness, with its verified receipt.
          await store(attempt.id+'.completion',{receipt:outcome.receipt,output:{choices:outcome.output.choices}});
        }
        return outcome;
      } catch {
        return unknown('cheaper_post_outcome_unknown');
      }
    },
  };
}
