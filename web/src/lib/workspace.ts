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
  sourceRole?: string;
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

export type EvidenceActions = { confirm?: () => void; dismiss?: () => void };
export type OpenEvidence = (
  refs: Citation[], index: number, trigger: HTMLElement, comparison?: { actions?: EvidenceActions },
) => void;

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
  navCounts?: { activeUploads?: number; needsReview?: number; readyForLetter?: number; members?: number };
  holds?: IntakeHold[];
  scopes?: ScopeProjection[];
  metrics?: Record<string, Metric>;
  changes?: ProjectEvent[];
};
export type Page<T> = { items: T[]; nextCursor?: string | null; sliceId?: string; total?: number };

export type ConclusionInput = { kind: 'citation'; evidenceId: string } | { kind: 'original'; versionId: string; anchor: string } |
  { kind: 'inventory'; occurrenceId: string; inventoryRevision: string };
export type InventoryLimitation = { occurrenceId: string; receiptId: string; number: number; label: string; restriction: string; inventoryRevision: string };

export type Assessment = {
  hasAcceptedMaterials?: boolean;
  scope?: { id: string; name: string; stage: string };
  catalogVersionId: string;
  version: number;
  inputGeneration?: string | number;
  holds?: { id: string; receiptId?: string; reason?: string }[];
  limitations?: string[];
  outcome: string;
  questions: AssessmentQuestion[];
  conclusion?: {
    id?: string; startWork: string; reason: string; authorId?: string; createdAt?: string; outcome?: string; basedOnVersion?: number;
    basis?: { kind: 'original'; original: import('./facade-assessment').OriginalBasis } | { kind: 'citation'; citation: Citation } | ({ kind: 'inventory' } & InventoryLimitation);
  };
  change?: { reason?: string; questionIds?: string[] };
};

export type ClarificationBasis = {
  inventories: { receiptId: string; number: string; revision: string }[];
  places: { documentId: string; versionId: string; sha256: string; label: string;
    address: { unitId: string; box?: { x: number; y: number; width: number; height: number } } }[];
  alternatives: string[];
};

export type AssessmentQuestion = {
  id: string;
  letterEligible?: boolean;
  version: number;
  dependencyVersion?: number;
  outcome: string;
  semanticRemainder?: {
    state: 'complete' | 'open'; totalWindows: number; verifiedWindows: number; alternativesVerified?: boolean;
    reasons: string[]; omittedItems: number; items: {
      windowId: string | null; versionId: string; unitId: string | null;
      box?: { x: number; y: number; width: number; height: number };
      pendingBranches?: ('A' | 'B')[]; reason: string; nextAction: string;
    }[];
  };
  researchStops?: {
    id?: string; jobId: string; branch: 'A' | 'B'; reason: string; nextAction: string; continuationRequested?: boolean;
    place: { unitId: string; page?: number; source: { documentId: string; versionId: string } };
    lastRejectedTool?: { name: string; code: string; turn: number };
    evidence?: { evidenceId: string; place: { unitId: string; page?: number; box?: RecordData;
      source: { documentId: string; versionId: string; sha256: string } } }[];
    lastRequest?: { turn: number; attemptId: string; tool: string; arguments: string };
  }[];
  requirement: {
    positionId: string; partId: string; subject: string; part: string;
    formats: string[]; requiredFormats?: string[]; equivalentFormats?: string[]; completeness?: string; applicability?: string; recipient?: string; requestedAction?: string;
  };
  machine: {
    outcome: string; citations: Citation[]; receiptIds: string[]; delivery?: string;
    readability?: string; limitations: string[];
    inventory?: { kind: string; receiptIds: string[]; currentCompositionChecked: boolean; alternativesChecked: boolean };
  };
  decision?: {
    id: string; action: string; outcome: string; reason: string; authorId: string; createdAt: string;
    startWorkCritical?: boolean; requestExternal?: boolean; clarification?: ClarificationBasis;
    exclusion?: { kind: 'not_required' | 'work_without_data'; until: string | null };
  };
  clarification?: ClarificationBasis;
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
  masked?: boolean;
  refreshKey: number;
  setDocumentPage: (page?: number) => void;
  setDocumentCad: (part?: string, entity?: string) => void;
  params: URLSearchParams;
};

export function isEngineer(project: Project) {
  return project.actions?.includes('project:engineer') ?? false;
}
