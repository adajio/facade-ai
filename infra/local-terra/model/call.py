#!/usr/bin/env python3
"""Run one Facade reader turn using the user's signed-in Codex account."""
import base64
import datetime
import binascii
import json
import hashlib
import time
import os
from pathlib import Path
import shutil
import signal
import struct
import subprocess
import sys
import tempfile
import uuid

HERE = Path(__file__).resolve().parent
MODEL = 'gpt-6.1-terra'
LIMIT = 24 * 1024 * 1024
DISABLED = ('shell_tool', 'unified_exec', 'apps', 'plugins', 'hooks', 'multi_agent',
            'memories', 'standalone_web_search', 'skill_search', 'view_image', 'image_generation',
            'skill_mcp_dependency_install', 'in_app_browser', 'in_app_chat', 'js_repl')

class Refusal(Exception):
    pass

def require(condition, message):
    if not condition:
        raise Refusal(message)

def prepare(request, temp):
    require(isinstance(request, dict) and request.get('model') == MODEL, 'unsupported_model')
    messages = request.get('messages')
    require(isinstance(messages, list) and messages, 'missing_messages')
    image_paths = []
    for message in messages:
        require(isinstance(message, dict) and message.get('role') in
                ('system', 'user', 'assistant', 'tool'), 'invalid_message')
        content = message.get('content')
        if isinstance(content, list):
            for idx, part in enumerate(content):
                require(isinstance(part, dict), 'invalid_content_part')
                if part.get('type') == 'text':
                    require(isinstance(part.get('text'), str), 'invalid_text')
                    continue
                require(part.get('type') == 'image_url' and message['role'] == 'user', 'unsupported_media')
                url = part.get('image_url', {}).get('url', '')
                prefix = 'data:image/png;base64,'
                require(isinstance(url, str) and url.startswith(prefix), 'unsupported_image_format')
                data = base64.b64decode(url[len(prefix):], validate=True)
                require(24 <= len(data) <= 8*1024*1024 and data[:8] == b'\x89PNG\r\n\x1a\n'
                        and data[12:16] == b'IHDR', 'invalid_png')
                width,height = struct.unpack('>II', data[16:24])
                require(width > 0 and height > 0 and width*height <= 24_000_000, 'image_dimensions')
                require(len(image_paths) < 32, 'image_count')
                path = temp / f'image-{len(image_paths)+1}.png'
                path.write_bytes(data)
                image_paths.append(path)
                content[idx] = {'type':'attached_image', 'ordinal':len(image_paths)}
        else:
            require(content is None or isinstance(content,str), 'invalid_content')
    tools = request.get('tools', [])
    require(isinstance(tools,list), 'invalid_tools')
    names = [t['function']['name'] for t in tools if t.get('type') == 'function']
    require(len(names) == len(tools) and all(isinstance(n,str) and n for n in names), 'invalid_tool')
    required = request.get('tool_choice') == 'required'
    require(not required or names, 'no_tools')
    schema = {'type':'object','additionalProperties':False,'required':['action','body'],
              'properties':{'action':{'type':'string','enum':names + ([] if required else ['reply'])},
                            'body':{'type':'string'}}}
    schema_path = temp / 'schema.json'
    schema_path.write_text(json.dumps(schema))
    prompt = json.dumps({'messages':messages, 'available_functions':tools},ensure_ascii=False,separators=(',',':'))
    return prompt, image_paths, schema_path, names, required

def terminate(proc):
    if proc.poll() is None:
        try:
            os.killpg(proc.pid,signal.SIGTERM)
            proc.wait(3)
        except subprocess.TimeoutExpired:
            os.killpg(proc.pid,signal.SIGKILL)
            proc.wait()
        except ProcessLookupError:
            pass

def run(request):
    effort = os.environ.get('FACADE_TERRA_REASONING_EFFORT','high')
    require(effort in ('medium','high'), 'unsupported_effort')
    started = time.monotonic()
    digest = hashlib.sha256(json.dumps(request, ensure_ascii=False, separators=(',',':')).encode()).hexdigest()
    with tempfile.TemporaryDirectory(prefix='turn-',dir=HERE/'tmp') as tmp:
        temp = Path(tmp)
        prompt, images, schema, names, required = prepare(request, temp)
        command = [str(Path.home()/'.local/bin/codex'),'exec','--ignore-user-config','--ignore-rules',
                   '--ephemeral','--skip-git-repo-check','-s','read-only','-m',MODEL,
                   '-C',str(HERE/'empty'),'-c','web_search="disabled"',
                   '-c','model_reasoning_effort=' + json.dumps(effort),'-c','project_doc_max_bytes=0',
                   '-c','features.skip_host_skill_discovery=true','-c','suppress_unstable_features_warning=true',
                   '-c', 'model_instructions_file=' + json.dumps(str(HERE/'instructions.txt')),
                   '--json','--output-schema',str(schema)]
        for feature in DISABLED:
            command.extend(('--disable',feature))
        for path in images:
            command.extend(('-i',str(path)))
        command.append('-')
        env = {k:os.environ[k] for k in ('HOME','USER','LOGNAME','PATH','LANG','TMPDIR','CODEX_HOME','SSL_CERT_FILE') if k in os.environ}
        env.update({'RUST_LOG':'off','NO_COLOR':'1'})
        proc = subprocess.Popen(command, stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.DEVNULL,
                                cwd=HERE/'empty',env=env,start_new_session=True)
        prior = signal.signal(signal.SIGTERM,lambda *_: (_ for _ in ()).throw(InterruptedError()))
        try:
            events,_ = proc.communicate(prompt.encode(),timeout=240)
        finally:
            terminate(proc)
            signal.signal(signal.SIGTERM,prior)
        message = None
        usage = None
        error_class = None
        for line in events.splitlines():
            event = json.loads(line)
            if event.get('type') == 'item.completed':
                item = event['item']
                if item['type'] == 'agent_message':
                    message = item['text']
                else:
                    if item['type'] not in ('reasoning','plan'):
                        label = str(item['type'])
                        raise Refusal('unexpected_codex_item_' + (label if label.isidentifier() else 'unknown'))
            if event.get('type') == 'turn.completed':
                usage = event.get('usage')
            elif event.get('type') in ('error','turn.failed'):
                detail = str(event).lower()
                if any(k in detail for k in ('context_length_exceeded', 'context window', 'maximum context', 'too many input tokens')):
                    error_class = 'context_limit'
                elif any(k in detail for k in ('request_too_large','request too large','payload too large')):
                    error_class = 'request_too_large'

                if any(k in detail for k in ('usage limit','quota','rate limit','usage_limit','rate_limit')):
                    raise Refusal('codex_usage_limit')
                if any(k in detail for k in ('unauthorized','login','authentication','invalid_grant')):
                    raise Refusal('codex_login_required')
        # Only correlation and operational counters are retained, never prompt text or pixels.
        measured = {'time':datetime.datetime.now(datetime.timezone.utc).isoformat(), 'requestSha256':digest,
                    'effort':effort, 'elapsedMs':round((time.monotonic()-started)*1000), 'images':len(images),
                    'exit':proc.returncode, 'answer':isinstance(message,str),'errorClass':error_class,
                    'inputTokens':usage.get('input_tokens') if isinstance(usage,dict) else None,
                    'outputTokens':usage.get('output_tokens') if isinstance(usage,dict) else None}
        write_diagnostics('model-activity.jsonl', measured)
        if 'submit_preliminary_review' in names:
            record = {'time':datetime.datetime.now(datetime.timezone.utc).isoformat(), 'tool':'submit_preliminary_review',
                      'exit':proc.returncode, 'answer':isinstance(message,str), 'effort':effort, 'payload_bytes':len(prompt.encode()),
                      'images':len(images), 'error_class':error_class,
                      'usage':{key:usage.get(key) for key in ('input_tokens','output_tokens')} if isinstance(usage,dict) else None}
            write_diagnostics('preliminary-transport.jsonl', record)
        require(proc.returncode == 0 and isinstance(message,str) and isinstance(usage,dict),
                ('codex_'+error_class) if error_class else 'codex_turn_incomplete')
        output = json.loads(message)
        action = output['action']
        body = output['body']
        require(isinstance(body,str), 'invalid_codex_response')
        assistant = {'role':'assistant','content':None}
        if action in names:
            arguments = json.loads(body)
            require(isinstance(arguments,dict) and len(body)<=65536,'invalid_function_arguments')
            assistant['tool_calls']=[{'id':f'call_{uuid.uuid4().hex}','type':'function',
                                      'function':{'name':action,'arguments':body}}]
            finish = 'tool_calls'
        else:
            require(not required and action == 'reply','unknown_function')
            assistant['content']=body
            finish='stop'
        return {'id':f'codex-{uuid.uuid4().hex}','model':MODEL,'local_effort':effort,'choices':[{'message':assistant,'finish_reason':finish}],
                'usage':{'prompt_tokens':usage['input_tokens'],'completion_tokens':usage['output_tokens']}}

def write_diagnostics(filename, record):
    # Journal availability must not turn a successful model answer into an unknown outcome.
    try:
        with (HERE.parent / 'logs' / filename).open('a') as log:
            print(json.dumps(record), file=log)
    except OSError:
        pass

def log_failure_code(code):
    # Keep only adapter-defined error codes. Never write source material to this journal.
    safe = code if len(code) <= 80 and code.replace('_', '').isalnum() else 'codex_adapter_failure'
    try:
        with (HERE.parent / 'logs' / 'adapter-failures.jsonl').open('a') as log:
            print(json.dumps({'time': datetime.datetime.now(datetime.timezone.utc).isoformat(), 'code': safe}), file=log)
    except OSError:
        pass


if __name__ == '__main__':
    os.umask(0o077)
    try:
        raw = sys.stdin.buffer.read(LIMIT+1)
        require(len(raw)<=LIMIT,'input_too_large')
        response = run(json.loads(raw))
        print(json.dumps(response,ensure_ascii=False))
    except Refusal as exc:
        log_failure_code(str(exc))
        print(str(exc),file=sys.stderr)
        sys.exit(1)
    except (OSError, ValueError, KeyError, TypeError, AttributeError, binascii.Error, subprocess.TimeoutExpired) as exc:
        log_failure_code('codex_adapter_'+type(exc).__name__)
        print('codex_adapter_'+type(exc).__name__,file=sys.stderr)
        sys.exit(1)
