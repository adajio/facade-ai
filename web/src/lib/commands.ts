import { issue, type Api, type Command } from './http';

type Attempt = { command: Command; running?: Promise<unknown> };

export class Commands {
  private readonly attempts = new Map<string, Attempt>();

  constructor(private readonly api: () => Api) {}

  async send<T>(
    path: string, method: string, body: unknown, version?: number | string, signal?: AbortSignal,
  ): Promise<T> {
    const fingerprint = JSON.stringify([path, method, version, body]);
    const attempt = this.attempts.get(fingerprint) ?? { command: issue(version) };
    this.attempts.set(fingerprint, attempt);
    if (attempt.running) return attempt.running as Promise<T>;
    const result = this.api().mutate<T>(path, method, body, attempt.command, signal);
    attempt.running = result;
    try {
      const value = await result;
      this.attempts.delete(fingerprint);
      return value;
    } finally {
      attempt.running = undefined;
    }
  }
}
