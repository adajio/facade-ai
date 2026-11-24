import { createHash } from 'node:crypto';
import type { NativeArtifact, NativePresentation, ReaderAddress, ReaderLine, SourceRef } from '../pdf/types.js';

// Raise on incompatible canonical layout/index changes. Older consumers only write their own epoch.
export const memoryVersion = 1;
export const fingerprint = (value: unknown) => createHash('sha256').update(canonicalJson(value)).digest('hex');
export const folded = (value: string) => value.normalize('NFC').toLowerCase();
export const blockId = (source: SourceRef, readerVersion: string, unitId: string) =>
  fingerprint([memoryVersion, source.projectId, source.versionId, source.sha256, readerVersion, unitId]);

function canonicalJson(value: unknown): string {
  return JSON.stringify(value, (_key, item: unknown) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return item;
    return Object.fromEntries(Object.entries(item).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0));
  });
}

export type MemoryExtent = 'unknown' | 'partial' | 'ready';
export type MemoryRemainder = 'native' | 'graphics' | 'ocr';
export type MemoryTarget = { projectId: string; scopeId?: string };
export type MemorySearchInput = MemoryTarget & {
  query: string;
  versionIds?: readonly string[];
  snapshot?: string;
  limit?: number;
};
export type MemoryReadInput = MemoryTarget & { blockId: string; snapshot: string };
export type MemoryBlock = {
  blockId: string;
  unitId: string;
  documentId?: string;
  versionId?: string;
  readerVersion?: string;
  address: ReaderAddress;
  status: MemoryExtent;
  remaining: MemoryRemainder[];
  limitations: string[];
};
export type MemorySnapshot = {
  version: number;
  snapshot: string;
  status: MemoryExtent;
  boundary: 'project' | 'publications';
  // Remainder is paginated by count. An unknown map may not have any enumerated blocks yet.
  pendingBlocks: number;
  remaining: MemoryBlock[];
  limitations: string[];
};
export type MemoryHit = {
  blockId: string;
  lineId: string;
  text: string;
  address: ReaderAddress;
  versionId?: string;
};
export type MemorySearchResult = MemorySnapshot & { hits: MemoryHit[]; truncated: boolean };
export type MemoryReadResult = {
  version: number;
  snapshot: string;
  block: MemoryBlock;
  lines: ReaderLine[];
  structure?: {
    rows: { key: (string | number)[]; lineIds: string[] }[];
    columns: { key: (string | number)[]; lineIds: string[] }[];
    screen: { key: (string | number)[]; lineIds: string[] }[];
  };
  previewUrl?: string;
};
export type MemoryContentReader = {
  readMaterializedNative(projectId: string, artifact: NativeArtifact): Promise<NativePresentation>;
};
