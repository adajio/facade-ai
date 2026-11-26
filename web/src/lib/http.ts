import { copy } from './copy';

export type RecordData = Record<string, unknown>;

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details: RecordData = {},
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

type Exchange = {
  method?: string;
  json?: unknown;
  body?: BodyInit;
  headers?: HeadersInit;
  signal?: AbortSignal;
};

export function endpoint(path: string) {
  const url = new URL(path, window.location.origin);
  if (url.origin !== window.location.origin || !url.pathname.startsWith('/api/')) {
    throw new Error('Сервер вернул недопустимую ссылку');
  }
  return url.pathname + url.search;
}

export class Api {
  private lifetime = new AbortController();
  private csrf = '';

  constructor(private readonly onUnauthorized: () => void) {}

  reset() {
    this.lifetime.abort();
    this.lifetime = new AbortController();
    this.csrf = '';
  }

  setCsrf(token: string) {
    this.csrf = token;
  }

  async response(path: string, options: Exchange = {}): Promise<Response> {
    const lifetime = this.lifetime.signal;
    const signal = options.signal ? AbortSignal.any([lifetime, options.signal]) : lifetime;
    const headers = new Headers(options.headers);
    if (options.json !== undefined) headers.set('Content-Type', 'application/json');
    if (this.csrf && options.method && options.method !== 'GET') {
      headers.set('X-CSRF-Token', this.csrf);
    }
    const response = await fetch(endpoint(path), {
      method: options.method,
      body: options.json === undefined ? options.body : JSON.stringify(options.json),
      headers,
      signal,
      cache: 'no-store',
      credentials: 'same-origin',
      redirect: 'error',
    });
    signal.throwIfAborted();
    if (!response.ok) {
      const detail = await response.json().catch(() => ({})) as RecordData;
      signal.throwIfAborted();
      if (response.status === 401 && path !== '/api/sessions') this.onUnauthorized();
      const code = String(detail.code ?? detail.error ?? 'http_error');
      throw new ApiError(response.status, code, String(detail.message ?? code), detail);
    }
    return response;
  }

  async json<T = RecordData>(path: string, options: Exchange = {}): Promise<T> {
    const lifetime = this.lifetime.signal;
    const response = await this.response(path, options);
    const body = response.status === 204 ? undefined : await response.json();
    lifetime.throwIfAborted();
    options.signal?.throwIfAborted();
    return body as T;
  }

  async mutate<T = RecordData>(path: string, method: string, body: unknown, command: Command, signal?: AbortSignal) {
    const headers: Record<string, string> = { 'Idempotency-Key': command.key };
    if (command.version !== undefined) headers['If-Match'] = command.version;
    return this.json<T>(path, { method, json: body, headers, signal });
  }
}

export type Command = { key: string; version?: string };

export function issue(version?: string | number): Command {
  return {
    key: crypto.randomUUID(),
    version: version === undefined ? undefined : JSON.stringify(String(version).replace(/^"|"$/g, '')),
  };
}

export function denied(error: unknown) {
  return error instanceof ApiError && [401, 403, 404].includes(error.status);
}

export function describe(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.code === 'scope_held') return 'Актуальная выдача удержана до разбора поступивших материалов.';
    if (error.code === 'hold_material_pending') return 'Материалы ещё не приняты или состав импорта продолжает формироваться.';
    if (error.code === 'letter_unconfirmed') return 'Редакция ещё не подтверждена.';
    if (error.code === 'letter_basis_stale') return 'Основание письма изменилось.';
    if (error.code === 'snapshot_required') return copy.snapshotRequired;
    if (error.status === 409) return 'Команда конфликтует с текущим состоянием. Сверьте сохранённые данные.';
    if (error.status === 412) return 'Сервер уже сохранил другую версию. Ваш ввод сохранён.';
    if (error.status === 429) return 'Достигнут временный предел. Повторите после паузы.';
    if (error.code === 'no_eligible_items') return copy.noLetterItems;
    if (denied(error)) return 'Ресурс недоступен.';
    return error.message || 'Сервер отклонил запрос.';
  }
  return 'Не удалось связаться с сервером. Проверьте соединение и повторите.';
}

export function interrupted(error: unknown) {
  return error instanceof DOMException && error.name === 'AbortError';
}

export function query(path: string, params: Record<string, unknown>) {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== '') search.set(key, String(value));
  }
  const suffix = search.toString();
  return suffix ? path + '?' + suffix : path;
}

export function id(value: string | number) {
  return encodeURIComponent(value);
}
