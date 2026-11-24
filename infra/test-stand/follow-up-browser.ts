import { expect } from '@playwright/test';
import type { BrowserContext, Page } from '@playwright/test';
import { createHash } from 'node:crypto';
import { appendFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { accepted, command, pdf, unique } from './synthetic';

const logDir = process.env.FACADE_FOLLOWUP_DIR!;
const MiB = 1024 ** 2;
const hash = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');

async function upload(ctx: BrowserContext, origin: string, receipt: string, file: { name: string; buffer: Buffer; sha: string; size?: number }) {
  return accepted<{ uploadId: string; partSize: number }>(await command(ctx, origin, '/api/receipts/' + receipt + '/uploads', 'POST', {
    relativePath: file.name, size: file.size ?? file.buffer.length, sha256: file.sha,
    mediaType: file.name.endsWith('.pdf') ? 'application/pdf' : 'application/octet-stream',
  }), 'Декларация испытания');
}

async function part(ctx: BrowserContext, origin: string, csrf: string, uploadId: string, number: number, bytes: Buffer) {
  const result = await ctx.request.put(`/api/uploads/${uploadId}/parts/${number}`, {
    data: bytes, headers: { Origin: origin, 'X-CSRF-Token': csrf,
      'Content-Type': 'application/octet-stream', 'X-Part-SHA256': hash(bytes) },
  });
  await accepted(result, 'Часть испытания');
}

async function csrf(ctx: BrowserContext) {
  return (await accepted<{ csrfToken: string }>(await ctx.request.get('/api/me'), 'Сессия испытания')).csrfToken;
}

export async function startFollowupLoad(ctx: BrowserContext, origin: string, catalogVersionId: string) {
  const project = await accepted<{ id: string }>(await command(ctx, origin, '/api/projects', 'POST', {
    name: unique('Step14-A'), catalogVersionId,
  }), 'Проект A');
  const { receiptId } = await accepted<{ receiptId: string }>(await command(ctx, origin, `/api/projects/${project.id}/receipts`, 'POST', {}), 'Поступление A');
  const name = 'step14-rate-limited.bin';
  const desiredParts = 128;
  const sourceHash = createHash('sha256');
  for (let index = 1; index <= desiredParts; index++) sourceHash.update(Buffer.alloc(MiB, index));
  const declared = await upload(ctx, origin, receiptId, { name, buffer: Buffer.alloc(0), sha: sourceHash.digest('hex'), size: desiredParts * MiB });
  expect(declared.partSize).toBe(MiB);
  const a = await ctx.newPage();
  await a.goto(`/projects/${project.id}/receipts/${receiptId}`);
  await expect(a.getByText(name, { exact: true }).first()).toBeVisible();
  const token = await csrf(ctx);
  const first = Date.now();
  let last = first;
  let sent = 0;
  let stopping = false;
  let failure: unknown;
  await part(ctx, origin, token, declared.uploadId, ++sent, Buffer.alloc(MiB, sent));
  const background = (async () => {
    while (!stopping && sent < desiredParts - 1) {
      await delay(900);
      if (stopping) break;
      await part(ctx, origin, token, declared.uploadId, ++sent, Buffer.alloc(MiB, sent));
      last = Date.now();
      await appendFile(join(logDir, 'load-parts.jsonl'), JSON.stringify({ part: sent, ackAt: last }) + '\n');
    }
  })().catch(error => { failure = error; });
  return { first, active: () => !failure && sent < desiredParts - 1 && !stopping, async finish() {
    stopping = true;
    await background;
    await a.close();
    if (failure) throw failure;
    return { projectId: project.id, receiptId, uploadId: declared.uploadId, first, last, sent,
      acknowledgedBytes: sent * MiB, declaredBytes: desiredParts * MiB };
  } };
}

export async function measureFollowup(page: Page, ctx: BrowserContext, origin: string, projectId: string,
  scopeId: string, load: Awaited<ReturnType<typeof startFollowupLoad>>) {
  const { receiptId } = await accepted<{ receiptId: string }>(await command(ctx, origin,
    `/api/projects/${projectId}/receipts`, 'POST', {}), 'Измерительное поступление B');
  const url = `/projects/${projectId}/receipts/${receiptId}?scope=${scopeId}`;
  const token = await csrf(ctx);
  const measurements = [];
  for (let i = 0; i < 20; i++) {
    expect(load.active(), 'Нагрузка A должна идти во всех измерениях').toBe(true);
    const active = i === 0 ? page : await ctx.newPage();
    await active.goto(url);
    const file = { ...pdf('Step 14 sample ' + i), name: `step14-sample-${i}.pdf` };
    const { uploadId } = await upload(ctx, origin, receiptId, { ...file, sha: hash(file.buffer) });
    await part(ctx, origin, token, uploadId, 1, file.buffer);
    const commitStarted = Date.now();
    await accepted(await command(ctx, origin, `/api/uploads/${uploadId}/complete`, 'POST', {}), 'Финализация B');
    const commitConfirmed = Date.now();
    const ready = (tab: Page) => tab.getByRole('row').filter({ hasText: file.name })
      .getByRole('button', { name: 'Карточка документа' });
    await expect(ready(active)).toBeVisible({ timeout: 10_000 });
    const warmShown = Date.now();
    await active.close();
    const reopened = await ctx.newPage();
    const reopenStarted = Date.now();
    await reopened.goto(url);
    await expect(ready(reopened)).toBeVisible({ timeout: 10_000 });
    const reopenShown = Date.now();
    await reopened.close();
    const row = { i, warmLowerMs: Math.max(0, warmShown - commitConfirmed),
      warmUpperMs: warmShown - commitStarted, reopenMs: reopenShown - reopenStarted };
    measurements.push(row);
    await appendFile(join(logDir, 'latency.jsonl'), JSON.stringify(row) + '\n');
  }
  const p95 = (key: 'warmLowerMs' | 'warmUpperMs' | 'reopenMs') =>
    measurements.map(row => row[key]).sort((a, b) => a - b)[Math.ceil(measurements.length * .95) - 1];
  await writeFile(join(logDir, 'latency-summary.json'), JSON.stringify({
    n: measurements.length, warmP95LowerMs: p95('warmLowerMs'), warmP95UpperMs: p95('warmUpperMs'),
    reopenP95Ms: p95('reopenMs'), projectId, receiptId,
  }, null, 2) + '\n');
}
