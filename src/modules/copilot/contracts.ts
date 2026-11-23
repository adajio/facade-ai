import type { PoolClient } from 'pg';

export type SourceAddress = {
  unitId: string;
  locator?: Record<string, string | number>;
  box?: { x: number; y: number; width: number; height: number };
};

export type MemorySource = {
  id: string;
  documentId: string;
  versionId: string;
  sha256: string;
  label: string;
  address: SourceAddress;
  text: string;
  version: 'current' | 'historical' | 'unknown';
  representation: 'native' | 'ocr' | 'render';
  limitations: string[];
};

export type MemorySearch = {
  sources: MemorySource[];
  limitations: string[];
};

export type CopilotMemory = {
  search(tx: PoolClient, projectId: string, query: string): Promise<MemorySearch>;
  open(tx: PoolClient, projectId: string, id: string): Promise<MemorySource | null>;
};
