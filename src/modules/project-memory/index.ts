import type { FastifyInstance } from 'fastify';

export { indexNextProjectMemory } from './consumer.js';
export { readProjectMemory, searchProjectMemory } from './read.js';
export type { MemoryBlock, MemoryContentReader, MemoryHit, MemoryReadInput, MemoryReadResult, MemorySearchInput,
  MemorySearchResult, MemorySnapshot } from './contracts.js';

// Memory is reached through authorized application consumers, with the intake worker as its producer.
export async function register(_app: FastifyInstance): Promise<void> {}
