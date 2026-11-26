import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {test} from 'node:test';

import {maxWireBytes,maxImageBytes,maxImageCount,measureRequest,remainingRequestBytes}
  from '../infra/local-terra/request-budget.mjs';

const adapter = fileURLToPath(new URL('../infra/local-terra/model/call.py',import.meta.url));
const pixel = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+rIVsAAAAASUVORK5CYII=', 'base64');
const attachment = bytes => ({type:'image_url',image_url:{url:'data:image/png;base64,'+bytes.toString('base64')}});
const message = content => ({role:'user',content});
const part = text => ({type:'text',text});
const make = (...messages) => ({model:'gpt-6.1-terra',messages,tools:[],tool_choice:'auto'});

test('text and attachment ordinals match the Python adapter, wire and PNG bytes stay separate',()=>{
  const first = make(message('Строка "Б"\n\t\u0001 🚧'));
  const historical = measureRequest(first);
  assert.equal(historical.wireBytes,Buffer.byteLength(JSON.stringify(first)));
  assert.equal(historical.promptBytes,Buffer.byteLength(JSON.stringify({messages:first.messages,available_functions:first.tools})));
  assert.equal(historical.requestBytes,Math.max(historical.wireBytes,historical.promptBytes));
  assert.equal(historical.estimatedInputTokens,historical.promptBytes+8192);
  assert.equal(historical.imageBytes,0);
  assert.equal(historical.imageCount,0);

  const request = make(...first.messages,message([part('Рамка · 12'),attachment(pixel)]),message([attachment(pixel)]));
  const data = JSON.stringify(request);
  const python = [
    'import importlib.util, json, pathlib, sys, tempfile',
    'spec = importlib.util.spec_from_file_location("adapter", sys.argv[1]); m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)',
    'raw = sys.stdin.buffer.read(); request = json.loads(raw)',
    'with tempfile.TemporaryDirectory() as d:',
    '    prompt, files, *_ = m.prepare(request, pathlib.Path(d))',
    '    result = dict(wireBytes=len(raw), imageCount=len(files), imageBytes=sum(f.stat().st_size for f in files), promptBytes=len(prompt.encode("utf-8")), projectedBytes=len(json.dumps(request, ensure_ascii=False, separators=(",", ":")).encode("utf-8")))',
    '    print(json.dumps(result))',
  ].join('\n');
  const fromAdapter = JSON.parse(execFileSync('python3',['-B','-c',python,adapter],{input:data,encoding:'utf8'}));
  const measured = measureRequest(request);
  for (const key of ['wireBytes','promptBytes','imageCount','imageBytes']) assert.equal(measured[key],fromAdapter[key],key);
  assert.equal(measured.requestBytes,Math.max(fromAdapter.promptBytes,fromAdapter.projectedBytes));
  assert.equal(measured.estimatedInputTokens,fromAdapter.promptBytes+8192+2*2048);
  assert.ok(remainingRequestBytes(measured)>0);
  assert.equal(JSON.stringify(request),data);
  const {tools:_,...withoutTools} = request;
  assert.equal(measureRequest(withoutTools).promptBytes,fromAdapter.promptBytes);
});

test('wire, decoded image bytes and attachment count each enforce their own limit',()=>{
  const atImageLimit = measureRequest(make(message([part('Чертёж'),attachment(Buffer.alloc(maxImageBytes))])));
  assert.equal(atImageLimit.imageBytes,maxImageBytes);
  assert.ok(atImageLimit.wireBytes<maxWireBytes);
  assert.ok(remainingRequestBytes(atImageLimit)>=0);
  assert.ok(remainingRequestBytes({...atImageLimit,wireBytes:maxWireBytes+1})<0);
  assert.equal(remainingRequestBytes({...atImageLimit,wireBytes:maxWireBytes}),0);
  const annotated = attachment(pixel);
  annotated.image_url.detail = 'x'.repeat(maxWireBytes);
  const overWire = measureRequest(make(message([annotated])));
  assert.ok(overWire.wireBytes>maxWireBytes);
  assert.equal(overWire.imageBytes,pixel.length);
  assert.ok(overWire.requestBytes<1_000);
  assert.ok(remainingRequestBytes(overWire)<0);
  const overImageLimit = measureRequest(make(message([attachment(Buffer.alloc(maxImageBytes+1))])));
  assert.equal(overImageLimit.imageBytes,maxImageBytes+1);
  assert.ok(overImageLimit.wireBytes<maxWireBytes);
  assert.ok(remainingRequestBytes(overImageLimit)<0);
  const many = count => measureRequest(make(message(Array.from({length:count},()=>attachment(pixel)))));
  assert.ok(remainingRequestBytes(many(maxImageCount))>=0);
  assert.ok(remainingRequestBytes(many(maxImageCount+1))<0);
});

test('ineligible media are rejected before dispatch',()=>{
  for (const url of ['https://example.test/a.png','data:image/jpeg;base64,AAAA','data:image/png;base64,AA..','data:image/png;base64,A===','data:image/png;base64,AAA\n']) {
    const budget = measureRequest(make(message([{type:'image_url',image_url:{url}}])));
    assert.ok(remainingRequestBytes(budget)<0);
  }
  const assistant = {role:'assistant',content:[attachment(pixel)]};
  assert.ok(remainingRequestBytes(measureRequest(make(assistant)))<0);
});
