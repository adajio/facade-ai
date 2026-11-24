const MAX_ENTRIES = 30;
const MAX_BYTES = 60 * 1024 * 1024;

type Entry = { url: string; size: number };

class PageCache {
  private readonly entries = new Map<string, Entry>();
  private readonly transient = new Set<string>();
  private bytes = 0;
  private revision = 0;

  get generation() { return this.revision; }

  get(key: string) {
    const entry = this.entries.get(key);
    if (!entry) return;
    this.entries.delete(key);
    this.entries.set(key, entry);
    return entry.url;
  }

  add(key: string, blob: Blob, generation: number) {
    if (generation !== this.revision || blob.size > MAX_BYTES) return;
    const existing = this.get(key);
    if (existing) return existing;
    while (this.entries.size >= MAX_ENTRIES || this.bytes + blob.size > MAX_BYTES) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.remove(oldest);
    }
    const url = URL.createObjectURL(blob);
    this.entries.set(key, { url, size: blob.size });
    this.bytes += blob.size;
    return url;
  }

  temporary(blob: Blob, generation: number) {
    if (generation !== this.revision) return;
    const url = URL.createObjectURL(blob);
    this.transient.add(url);
    return url;
  }

  release(url: string) {
    if (this.transient.delete(url)) URL.revokeObjectURL(url);
  }

  clear() {
    this.revision++;
    for (const key of this.entries.keys()) this.remove(key);
    for (const url of this.transient) this.release(url);
  }

  private remove(key: string) {
    const entry = this.entries.get(key);
    if (!entry) return;
    URL.revokeObjectURL(entry.url);
    this.entries.delete(key);
    this.bytes -= entry.size;
  }
}

export const pageCache = new PageCache();
