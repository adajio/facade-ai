import { spawn } from 'node:child_process';

// This is a transport primitive, not a Gateway transport: no per-call price is
// available for a ChatGPT subscription and the existing Gateway requires one.
export async function callCodex(request, { script, python = 'python3', signal, timeoutMs = 255000 } = {}) {
  if (!script || request?.model !== 'gpt-6.1-terra' || !Array.isArray(request.messages)) {
    throw new Error('invalid_codex_request');
  }
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) throw new Error('invalid_timeout');
  if (signal?.aborted) throw new Error('codex_not_started');
  const payload = JSON.stringify(request);
  return new Promise((resolve, reject) => {
    const child = spawn(python, [script], { stdio: ['pipe', 'pipe', 'pipe'] });
    const chunks = [];
    let outputBytes = 0, exceeded = false, interrupted = false, started = false, killTimer;
    const limit = 8 * 1024 * 1024;
    const abort = () => {
      interrupted = true;
      child.kill('SIGTERM');
      killTimer ??= setTimeout(() => child.kill('SIGKILL'), 3000);
    };
    const timer = setTimeout(abort, timeoutMs);
    signal?.addEventListener('abort', abort, { once: true });
    child.once('spawn', () => { started = true; });
    child.stdout.on('data', chunk => {
      outputBytes += chunk.length;
      if (outputBytes > limit) { exceeded = true; abort(); }
      else chunks.push(chunk);
    });
    // Do not expose prompts or source material through logs.
    child.stderr.resume();
    child.stdin.on('error', () => {});
    let spawnError;
    child.once('error', error => { spawnError = error; });
    child.once('close', code => {
      clearTimeout(timer);
      clearTimeout(killTimer);
      signal?.removeEventListener('abort', abort);
      if (spawnError || !started) return reject(new Error('codex_not_started'));
      // Once spawned, an interrupted or malformed response has an unknown outcome.
      if (interrupted || exceeded || code !== 0) return reject(new Error('codex_outcome_unknown'));
      let result;
      try { result = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { return reject(new Error('codex_outcome_unknown')); }
      const choice = result?.choices?.[0];
      const message = choice?.message;
      if (result?.model !== 'gpt-6.1-terra' || typeof result.id !== 'string' || !result.id ||
          message?.role !== 'assistant' || !['stop', 'tool_calls'].includes(choice?.finish_reason) ||
          (message.content !== null && typeof message.content !== 'string') ||
          (message.tool_calls !== undefined && (!Array.isArray(message.tool_calls) || message.tool_calls.some(call =>
            !call?.id || call.type !== 'function' || typeof call.function?.name !== 'string' ||
            typeof call.function?.arguments !== 'string')))) {
        return reject(new Error('codex_outcome_unknown'));
      }
      resolve(result);
    });
    child.stdin.end(payload);
  });
}
