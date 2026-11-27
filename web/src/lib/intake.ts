import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import { type Commands } from './commands';
import { type Api, id } from './http';

export type Receipt = {
  analysisScenario?: 1 | 2;
  analysisBaseReviewId?: string | null;
  receiptId: string; number: number; sealed: boolean; inventoryOpen: boolean;
  source?: string; createdAt?: string;
};
export type Part = { number: number; offset: number; length: number; sha256: string };
export type Upload = {
  uploadId: string; occurrenceId: string; status: string; size: number; sha256: string;
  partSize: number; expiresAt: string; confirmedBytes: number; parts?: Part[];
};
export type Occurrence = {
  occurrenceId: string; relativePath: string; parentOccurrenceId?: string;
  importId?: string; status: string; inventoryPending: boolean; restriction?: string;
  mediaType?: string; documentId?: string; versionId?: string; originalId?: string;
  size?: number; sha256?: string;
};
export type ManifestMode = 'once' | 'open';
export type NewInput = { itemId: string; scopeIds?: string[] } & (
  { kind: 'link'; url: string } |
  { kind: 'file'; relativePath: string; size: number; sha256: string; mediaType?: string }
);
export type ManifestItem = {
  itemId: string; kind: 'file' | 'archive' | 'link'; relativePath: string | null; status: string;
  size: number | null; sha256: string | null; confirmedBytes: number; reason: string | null;
  uploadId: string | null; importId: string | null; occurrenceId: string | null; expiresAt: string | null;
  canRetry: boolean;
};
export type Manifest = { mode: ManifestMode; version: number; items: ManifestItem[] };
export type Inventory = Receipt & {
  projectId: string;
  manifest?: Manifest | null;
  uploads: Upload[]; occurrences: Occurrence[];
  imports: { importId: string; status: string; reason?: string }[];
};
export type Capabilities = {
  analysisScenarios?: (1 | 2)[];
  defaultAnalysisScenario?: 1 | 2;
  analysisBases?: { id: string; number: number; createdAt: string }[];
  partSize?: number; maxReceiptBytes?: number; uploadTtlSeconds?: number;
  archiveFormats?: string[]; archiveIsolationConfigured?: boolean; channels?: string[];
};
export type UploadProgress = (value: { phase: 'hashing' | 'transfer' | 'finalizing'; bytes: number; total: number }) => void;

export function receiptPath(receiptId: string) {
  return '/api/receipts/' + id(receiptId);
}

export function relativePath(file: File) {
  return file.webkitRelativePath || file.name;
}

export async function fileChecksum(file: Blob, signal: AbortSignal, onProgress: UploadProgress) {
  const hash = sha256.create();
  const blockSize = 2 * 1024 * 1024;
  for (let offset = 0; offset < file.size; offset += blockSize) {
    signal.throwIfAborted();
    const end = Math.min(offset + blockSize, file.size);
    hash.update(new Uint8Array(await file.slice(offset, end).arrayBuffer()));
    onProgress({ phase: 'hashing', bytes: end, total: file.size });
  }
  signal.throwIfAborted();
  return bytesToHex(hash.digest());
}

export async function sendFile(options: {
  api: Api; commands: Commands; receiptId: string; file: File; scopeId?: string;
  previous?: Upload; replacements?: string; checksum?: string; signal: AbortSignal; onProgress: UploadProgress;
  remember: (uploadId: string) => void;
}) {
  const { api, commands, file, scopeId, signal, onProgress, previous, receiptId, replacements, remember } = options;
  const checksum = options.checksum ?? await fileChecksum(file, signal, onProgress);
  const active = previous ?? await commands.send<Upload>(receiptPath(receiptId) + '/uploads', 'POST', {
    relativePath: relativePath(file), size: file.size, sha256: checksum,
    mediaType: file.type || undefined, scopeIds: scopeId ? [scopeId] : undefined,
    replacesVersionId: replacements || undefined,
  }, undefined, signal);
  remember(active.uploadId);
  const path = '/api/uploads/' + id(active.uploadId);
  const confirmed = await api.json<Upload>(path, { signal });
  if (confirmed.sha256 !== checksum || confirmed.size !== file.size) {
    throw new Error('Выбранный файл отличается от объявленного оригинала.');
  }
  if (confirmed.status === 'complete') {
    onProgress({ phase: 'transfer', bytes: file.size, total: file.size });
    return;
  }
  if (confirmed.status !== 'uploading' || !Number.isSafeInteger(confirmed.partSize) || confirmed.partSize <= 0) {
    throw new Error('Передача в этом состоянии недоступна.');
  }

  const parts = new Map((confirmed.parts ?? []).map((part) => [part.number, part]));
  let transferred = confirmed.confirmedBytes;
  onProgress({ phase: 'transfer', bytes: transferred, total: file.size });
  for (let offset = 0, number = 1; offset < file.size; offset += confirmed.partSize, number += 1) {
    signal.throwIfAborted();
    const length = Math.min(confirmed.partSize, file.size - offset);
    const piece = file.slice(offset, offset + length);
    const partHash = bytesToHex(sha256(new Uint8Array(await piece.arrayBuffer())));
    const existing = parts.get(number);
    if (existing) {
      if (existing.offset !== offset || existing.length !== length || existing.sha256 !== partHash) {
        throw new Error('Подтверждённая часть не совпадает с выбранным файлом.');
      }
      continue;
    }
    await api.response(path + '/parts/' + number, {
      method: 'PUT', body: piece, signal,
      headers: { 'Content-Type': 'application/octet-stream', 'X-Part-SHA256': partHash },
    });
    transferred += length;
    onProgress({ phase: 'transfer', bytes: transferred, total: file.size });
  }
  onProgress({ phase: 'finalizing', bytes: transferred, total: file.size });
  await commands.send(path + '/complete', 'POST', {}, undefined, signal);
}

export function itemPath(receiptId: string, itemId: string) {
  return receiptPath(receiptId) + '/manifest/' + id(itemId);
}

export async function sendManifestFile(options: {
  api: Api; commands: Commands; receiptId: string; item: ManifestItem; file: File; checksum: string;
  signal: AbortSignal; onProgress: UploadProgress;
}) {
  const { commands, receiptId, item, file, checksum, signal } = options;
  if (relativePath(file) !== item.relativePath || file.size !== item.size || checksum !== item.sha256) {
    throw new Error('Выбранный файл отличается от объявленного оригинала.');
  }
  const upload = await commands.send<Upload>(itemPath(receiptId, item.itemId) + '/upload', 'POST', {
    restartUploadId: item.status === 'expired' ? item.uploadId : undefined,
  }, undefined, signal);
  await sendFile({ ...options, previous: upload, remember: () => {} });
}

// A receipt id is enough to recover a committed declaration after loss of the
// response. File handles, checksums and public share URLs stay out of localStorage.
export function pendingReceipt(projectId: string, receiptId?: string | null): string {
  const key = 'facade:intake:pending:' + projectId;
  try {
    if (receiptId === null) localStorage.removeItem(key);
    else if (receiptId) localStorage.setItem(key, receiptId);
    return localStorage.getItem(key) ?? '';
  } catch {
    return '';
  }
}
