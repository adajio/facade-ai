import type { SessionAccount } from '../access/auth.js';

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
  context?: { id: string; address: SourceAddress; text: string }[];
  window?: true;
  readerVersion?: string;
  version: 'current' | 'historical' | 'unknown';
  representation: 'native' | 'ocr' | 'render';
  limitations: string[];
  proof: { kind: 'memory'; blockId: string } | { kind: 'evidence'; evidenceId: string };
};

export type PublishedSource = { id: string; page: number; quote: string };

export type MemorySearch = {
  sources: MemorySource[];
  windows: MemorySource[];
  limitations: string[];
};

export type CopilotMemory = {
  search(session: SessionAccount, projectId: string, query: string): Promise<MemorySearch>;
  open(session: SessionAccount, projectId: string, id: string): Promise<MemorySource | null>;
  searchPublications(session: SessionAccount, projectId: string, scopeId: string, query: string):
    Promise<{ sources: PublishedSource[]; limitations: string[] }>;
  openPublication(session: SessionAccount, projectId: string, scopeId: string, id: string): Promise<PublishedSource | null>;
};

export type SourceIdentity = Pick<MemorySource, 'id' | 'sha256' | 'documentId' | 'versionId' | 'proof'>;

export type StoredAnswer = {
  claims: { text: string; sources: string[] }[];
  exposed: SourceIdentity[];
  cited: string[];
  limitations: string[];
};

export const copilotTurnLimit = 24;
export const copilotReadBatchLimit = 6;
export const copilotSearchResultLimit = 6;
export const copilotOcrLimit = 4;

// Each turn can discover at most one batch of new search results. OCR can add one separately.
export const copilotJournalLimit = copilotTurnLimit * copilotReadBatchLimit * copilotSearchResultLimit + copilotOcrLimit;
