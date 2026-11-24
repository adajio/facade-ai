import type { APIRequestContext, BrowserContext, Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';

export function unique(prefix: string) {
  return prefix + '-' + randomUUID().slice(0, 12);
}

export const admin = {
  login: process.env.FACADE_E2E_ADMIN_LOGIN,
  password: process.env.FACADE_E2E_ADMIN_PASSWORD,
};

export async function signIn(page: Page, login: string, password: string, next = '/projects') {
  await page.goto('/login?next=' + encodeURIComponent(next));
  await page.getByRole('textbox', { name: 'Логин' }).fill(login);
  await page.getByLabel('Пароль', { exact: true }).fill(password);
  try {
    const [response] = await Promise.all([
      page.waitForResponse((result) => new URL(result.url()).pathname === '/api/sessions' && result.request().method() === 'POST'),
      page.getByRole('button', { name: 'Войти', exact: true }).click(),
    ]);
    if (!response.ok()) {
      const problem = await response.json().catch(() => ({})) as { code?: string };
      throw new Error('Синтетический вход · HTTP ' + response.status() + ' · ' + (problem.code ?? 'http_error'));
    }
    await page.waitForURL((url) => url.pathname !== '/login');
  } catch (error) {
    await page.evaluate(() => {
      const field = document.querySelector<HTMLInputElement>('input[type="password"]');
      if (field) field.value = '';
    }).catch(() => {});
    throw error;
  }
}

export type ReadyAccount = { login: string; password: string; userId: string };

export async function command(context: BrowserContext, origin: string, path: string, method: string, data?: unknown, version?: number) {
  const session = await context.request.get('/api/me');
  if (!session.ok()) throw new Error('Синтетическая сессия недоступна');
  const { csrfToken } = await session.json() as { csrfToken: string };
  return context.request.fetch(path, {
    method, data, headers: {
      Origin: origin, 'X-CSRF-Token': csrfToken, 'Idempotency-Key': randomUUID(),
      ...(version === undefined ? {} : { 'If-Match': JSON.stringify(String(version)) }),
    },
  });
}

export async function accepted<T = unknown>(response: Awaited<ReturnType<APIRequestContext['fetch']>>, name: string) {
  if (!response.ok()) {
    const body = await response.json().catch(() => ({})) as { code?: string };
    const code = body.code ?? 'http_error';
    throw new Error(name + ' · HTTP ' + response.status() + ' · ' + code);
  }
  return (response.status() === 204 ? undefined : await response.json()) as T;
}

export async function applyFixtureReview(apply: () => Promise<void>) {
  // The fixture controls the observations. The worker can still publish an
  // assessment between the fixture's read and the transactional update.
  for (let attempt = 0; ; attempt++) {
    try {
      await apply();
      return;
    } catch (error) {
      if (attempt >= 2 || !(error instanceof Error) || !('code' in error) || error.code !== 'assessment_input_stale') throw error;
    }
  }
}

export async function account(owner: BrowserContext, invitee: BrowserContext, origin: string, prefix: string, operator = false): Promise<ReadyAccount> {
  const login = unique(prefix);
  const password = 'Synthetic-' + randomUUID();
  const invitation = await accepted<{ userId: string; token: string }>(await command(owner, origin, '/api/users/invitations', 'POST', { login }), 'Приглашение');
  await accepted(await invitee.request.post('/api/invitations/complete', {
    data: { password, token: invitation.token }, headers: { Origin: origin },
  }), 'Активация приглашения');
  if (operator) {
    const listing = await owner.request.get('/api/users');
    const { users } = await accepted<{ users: { id: string; version: number }[] }>(listing, 'Список учётных записей');
    const user = users.find((entry: { id: string }) => entry.id === invitation.userId);
    if (!user) throw new Error('Не найдена учётная запись оператора');
    await accepted(await command(owner, origin, '/api/users/' + user.id, 'PATCH', { technicalOperator: true }, user.version), 'Допуск оператора');
  }
  return { login, password, userId: invitation.userId };
}

export function pdf(line: string | string[] = 'AL-01 2 mm') {
  const lines = Array.isArray(line) ? line : [line];
  const content = 'BT /F1 20 Tf 40 240 Td 24 TL ' + lines.map((text) => '(' + text + ') Tj').join(' T* ') + ' ET\n';
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 420 300] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>',
    '<< /Length ' + Buffer.byteLength(content) + ' >>\nstream\n' + content + 'endstream',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  let data = '%PDF-1.4\n';
  const offsets = [0];
  for (const [index, object] of objects.entries()) {
    offsets.push(Buffer.byteLength(data));
    data += (index + 1) + ' 0 obj\n' + object + '\nendobj\n';
  }
  const xref = Buffer.byteLength(data);
  data += 'xref\n0 ' + offsets.length + '\n0000000000 65535 f \n';
  for (const offset of offsets.slice(1)) data += String(offset).padStart(10, '0') + ' 00000 n \n';
  data += 'trailer\n<< /Size ' + offsets.length + ' /Root 1 0 R >>\nstartxref\n' + xref + '\n%%EOF\n';
  return { name: 'facade-web-synthetic.pdf', mimeType: 'application/pdf', buffer: Buffer.from(data) };
}
