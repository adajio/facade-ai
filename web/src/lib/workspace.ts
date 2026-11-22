import type { Project } from './contracts';
import { id, query, type RecordData } from './http';
import { projectUrl, type Section } from './routes';

export const V1 = '/api/v1';

export function projectApi(projectId: string) {
  return '/api/projects/' + id(projectId);
}

export function projectV1(projectId: string) {
  return V1 + '/projects/' + id(projectId);
}

export function scopedUrl(projectId: string, section: Section, params: Record<string, unknown>, objectId?: string) {
  return query(projectUrl(projectId, section, objectId), params);
}

export type Citation = {
  evidenceId: string;
  observationId?: string;
  documentId?: string;
  versionId?: string;
  sha256?: string;
  label?: string;
  documentRevision?: { label: string; evidenceId?: string };
  sourceLabel?: string;
  quote?: string;
  branch?: 'A' | 'B';
  value?: string | null;
  normalizedValue?: number | string | null;
  unit?: string | null;
  href?: string;
  address?: RecordData;
  components?: CitationComponent[];
};

export type CitationComponent = {
  role: 'value' | 'unit' | 'variant' | 'revision' | 'identifier' | 'relationship';
  quote: string;
  literal: string;
  evidenceId: string;
  lineId: string;
  address: RecordData;
  source: { documentId: string; versionId: string; sha256: string };
};

export type OpenEvidence = (refs: Citation[], index: number, trigger: HTMLElement) => void;

export type Position = { sliceId: string; cursor: string; projectionVersion: string };
export type ProjectEvent = Position & { type: string; createdAt: string; payload: RecordData };
export type EventPage = { events: ProjectEvent[]; cursor: string; head: Position; hasMore: boolean };
export type Metric = { value: number; total?: number; filter?: string };
export type IntakeHold = {
  id: string; receiptId?: string; source?: 'upload' | 'import'; sourceId?: string;
  reason?: string; version: number; generation: number; scopeIds: string[] | null;
};
export type ScopeProjection = {
  id: string; version: number; assessmentVersion: number | null;
  catalogVersionId: string; inputGeneration: number; holds: IntakeHold[];
};
export type Projection = Position & {
  holds?: IntakeHold[];
  scopes?: ScopeProjection[];
  metrics?: Record<string, Metric>;
  changes?: ProjectEvent[];
};
export type Page<T> = { items: T[]; nextCursor?: string | null; sliceId?: string; total?: number };

export type Assessment = {
  scope?: { id: string; name: string; stage: string };
  catalogVersionId: string;
  version: number;
  inputGeneration?: string | number;
  holds?: { id: string; receiptId?: string; reason?: string }[];
  limitations?: string[];
  outcome: string;
  questions: AssessmentQuestion[];
  conclusion?: {
    id?: string; startWork: string; reason: string; authorId?: string; createdAt?: string; outcome?: string;
  };
  change?: { reason?: string; questionIds?: string[] };
};

export type AssessmentQuestion = {
  id: string;
  version: number;
  dependencyVersion?: number;
  outcome: string;
  researchStops?: {
    id?: string; jobId: string; branch: 'A' | 'B'; reason: string; nextAction: string; continuationRequested?: boolean;
    place: { unitId: string; page?: number; source: { documentId: string; versionId: string } };
    lastRejectedTool?: { name: string; code: string; turn: number };
  }[];
  requirement: {
    positionId: string; partId: string; subject: string; part: string;
    formats: string[]; applicability?: string; recipient?: string; requestedAction?: string;
  };
  machine: {
    outcome: string; citations: Citation[]; receiptIds: string[]; delivery?: string;
    readability?: string; limitations: string[];
    inventory?: { kind: string; receiptIds: string[]; currentCompositionChecked: boolean; alternativesChecked: boolean };
  };
  decision?: {
    id: string; action: string; outcome: string; reason: string; authorId: string; createdAt: string;
    startWorkCritical?: boolean;
  };
  history?: AssessmentQuestion['decision'][];
};

export type WorkspaceProps = {
  project: Project;
  scopeId: string;
  sliceId?: string;
  cursor?: string;
  filter?: string;
  objectId?: string;
  revision?: string;
  canEdit: boolean;
  refreshKey: number;
  params: URLSearchParams;
};

export function isEngineer(project: Project) {
  return project.actions?.includes('project:engineer') ?? false;
}
