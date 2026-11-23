import type { Pool, PoolClient } from 'pg';
import type { Branch, Place } from './contracts.js';
import type { Observation } from '../pdf/types.js';

export const packageRoles = ['drawing', 'detail', 'schedule', 'specification', 'calculation', 'inventory',
  'correspondence', 'model', 'other', 'unknown'] as const;
export type PackageSourceRole = typeof packageRoles[number];

export interface PackageBinding {
  state: 'identified' | 'common' | 'unclear' | 'unidentified';
  candidates: { id: string; label: string }[];
  quote: string | null;
  reason: string;
  version: number;
  actorId: string | null;
}

export interface PackageFact {
  id: string;
  branch: Branch;
  windowId: string;
  observation: Observation;
  evidenceHref: string;
  attribute: string | null;
  sourceRole: PackageSourceRole;
  designStage: string | null;
  revision: string | null;
  revisionStatus: 'current' | 'superseded' | 'unknown';
  basis: { role?: string; stage?: string; revision?: string };
  binding: PackageBinding;
}

export interface PackageWindow {
  id: string;
  place: Place;
  readerVersion: string | null;
  format: string;
  branches: Record<Branch, {
    status: 'pending' | 'queued' | 'reading' | 'held' | 'covered' | 'reviewed_no_match' | 'refused';
    reason: string | null;
    jobId: string | null;
    nextAction: string | null;
  }>;
}

export interface PackageComparison {
  aFactId: string;
  bFactId: string;
  status: 'agreement' | 'reading_disagreement' | 'applicability_unclear';
}

export interface PackageAnalysis {
  facts: PackageFact[];
  candidates: PackageBinding['candidates'];
  windows: PackageWindow[];
  comparisons: PackageComparison[];
  coverage: {
    inventory: 'open' | 'closed';
    acceptedVersions: number;
    mappedVersions: number;
    refusedVersions: number;
    pendingVersions: number;
    completedWindows: number;
    physicalBoundary: 'mapped_places';
    facadeBoundary: 'observed_facades';
  };
}

export async function readPackageAnalysis(db: Pool | PoolClient, projectId: string): Promise<PackageAnalysis> {
  const result = await db.query<{ analysis: PackageAnalysis }>(
    'SELECT harness_read_package_analysis($1) AS analysis', [projectId]);
  return result.rows[0].analysis;
}
