import { createContext } from 'svelte';
import { SvelteMap } from 'svelte/reactivity';
import type { Api } from './http';
import type { UploadProgress } from './intake';

export type TransferStatus = {
  running: boolean;
  receiptId?: string;
  file?: string;
  progress?: Parameters<UploadProgress>[0];
  success?: string;
  error?: string;
};

export class IntakeTransfers {
  readonly status = new SvelteMap<string, TransferStatus>();
  private readonly running = new Map<string, AbortController>();

  constructor(readonly api: Api) {}

  start(project: string, receiptId?: string) {
    if (this.running.has(project)) return;
    const controller = new AbortController();
    this.running.set(project, controller);
    this.status.set(project, { running: true, receiptId });

    const isCurrent = () => this.running.get(project) === controller;
    const update = (change: Partial<TransferStatus>) => {
      const previous = this.status.get(project);
      if (isCurrent() && previous) {
        this.status.set(project, { ...previous, ...change });
      }
    };

    return {
      signal: controller.signal,
      update,
      isCurrent,
      finish: () => {
        if (!isCurrent()) return false;
        update({ running: false });
        this.running.delete(project);
        return true;
      },
    };
  }

  pause(project: string) {
    this.running.get(project)?.abort();
  }

  clear() {
    for (const controller of this.running.values()) controller.abort();
    this.running.clear();
    this.status.clear();
    this.api.reset();
  }
}

export const [getIntakeTransfers, setIntakeTransfers] = createContext<IntakeTransfers>();
