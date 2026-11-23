import type { PoolClient } from 'pg';
import type { VerifiedPairEvidence } from '../assessment/domain.js';
import type { DeliveryStatement, ReaderComponentInput } from '../pdf/types.js';
import type { VerifiedNativeDeliveryLine } from '../pdf/native-line.js';
import { z } from 'zod';
import type { PackageDetails, PackageMetadataReceipt } from './package-observation.js';

export const branchSchema = z.enum(['A', 'B']);
export type Branch = z.infer<typeof branchSchema>;
const id = z.string().uuid();
const sha256 = z.string().regex(/^[a-f0-9]{64}$/);
const text = z.string().trim().min(1).max(500);
export const boxSchema = z.strictObject({
  x: z.number().min(0),
  y: z.number().min(0),
  width: z.number().positive(),
  height: z.number().positive(),
});
export const sourceSchema = z.strictObject({ projectId: id, documentId: id, versionId: id, sha256 });
export const placeSchema = z.strictObject({
  source: sourceSchema,
  unitId: z.string().min(1).max(240),
  page: z.number().int().positive().optional(),
  box: boxSchema.optional(),
});
export const questionSchema = z.strictObject({
  id: id,
  subject: text,
  property: text,
  variant: text.optional(),
  sourceRoles: z.array(text).optional(),
});
export const citationSchema = z.strictObject({
  observationId: id,
  evidenceId: id,
  branch: branchSchema,
  place: placeSchema,
  quote: text,
  value: text,
  unit: z.string().trim().max(500),
  normalizedValue: text.optional(),
});
export const disputeSchema = z.strictObject({
  id,
  question: questionSchema.omit({ id: true }).extend({ id: id.optional() }),
  a: citationSchema.extend({ branch: z.literal('A') }),
  b: citationSchema.extend({ branch: z.literal('B') }),
}).refine(({a, b}) => a.observationId !== b.observationId);

export const settingsSchema = z.strictObject({
  routeId: z.string().min(1),
  model: z.string().min(1),
  dataClass: z.string().min(1),
  toolChoice: z.enum(['required', 'auto']).optional(),
  maxTokens: z.number().int().positive().max(16_384),
  maxTurns: z.number().int().positive().max(40),
  maxKnownRejections: z.number().int().min(0).max(5),
});

const packageReviewSchema = z.strictObject({ scopeId: text, scopeLabel: text,
  readerVersions: z.strictObject({ A: text, B: text }), routeRevision: text, catalogVersionId:id.optional(), stage:text.optional() });
const packageDiscovery = z.union([z.strictObject({ label: text }), z.strictObject({ kind: z.literal('profile_scan'),
  candidateBlocks: z.array(z.string().min(1).max(60)).max(4096).optional() })]);
export type PackageDiscovery = z.infer<typeof packageDiscovery>;

export function supportsFacadeHeader(job:ResearchJob) {
  if(job.mode!=='primary'||!job.packageWindow)return false;
  const {followup,profileInspection}=job.packageWindow;
  return followup ? followup.discovery&&'kind' in followup.discovery&&followup.discovery.kind==='profile_scan' : Boolean(profileInspection);
}
export const jobSchema = z.discriminatedUnion('mode', [
  z.strictObject({
    mode: z.literal('primary'),
    branch: branchSchema,
    place: placeSchema,
    question: questionSchema.optional(),
    localRefusal: text.optional(),
    observationProtocol: z.literal(2).optional(),
    packageWindow: z.strictObject({ id, readerVersion: text, routeRevision: text,
      profileInspection: z.strictObject({ lineIds: z.array(text).max(8) }).optional(),
      walkProtocol: z.literal(1).optional(), followup: z.strictObject({ rootJobId: id,
        blocks: z.array(z.string().min(1).max(60)).min(1).max(4096),
        discovery: packageDiscovery.optional(),
        semantic:z.strictObject({catalogVersionId:id,stage:text,epoch:z.string().regex(/^\d+$/),
          positions:z.array(z.strictObject({facadeId:id.nullable(),positionId:text,scopeEpoch:z.string().regex(/^\d+$/)})).max(4096)}).optional(),
      }).optional(),
    }).optional(),
    settings: settingsSchema.nullable(),
  }),
  z.strictObject({ mode: z.literal('lead'), dispute: disputeSchema, settings: settingsSchema.nullable(), packageReview: packageReviewSchema.optional() }),
  z.strictObject({
    mode: z.literal('verify'),
    branch: branchSchema,
    dispute: disputeSchema,
    proposal: z.strictObject({
      aObservationId: id,
      bObservationId: id,
      explanation: text,
    }),
    settings: settingsSchema.nullable(),
    packageReview: packageReviewSchema.optional(),
  }),
]);

export type Source = z.infer<typeof sourceSchema>;
export type Place = z.infer<typeof placeSchema>;
export type TargetQuestion = z.infer<typeof questionSchema>;
export type Citation = z.infer<typeof citationSchema>;
export type Dispute = z.infer<typeof disputeSchema>;
export type ScheduledResearchJob = z.infer<typeof jobSchema>;
export type ResearchJob = ScheduledResearchJob & { settings: ResearchSettings };
export type PrimaryJob = Extract<ScheduledResearchJob, { mode: 'primary' }>;
export type ResearchSettings = z.infer<typeof settingsSchema>;

export interface ScheduledResearchTask {
  jobId: string;
  projectId: string;
  scopeId: string | null;
  generationId: string;
  job: ScheduledResearchJob;
}

export type ResearchTask = ScheduledResearchTask & { job: ResearchJob; earlyPair?: true; pairScopeName?: string };

export const pairCriteria = ['variant', 'revision', 'applicability', 'comparability'] as const;
const pairEvidence = z.strictObject({ evidenceId: id, quote: text });
const pairCheck = z.strictObject({
  status: z.enum(['confirmed', 'unclear', 'incompatible']), reason: text,
  sources: z.array(pairEvidence).max(8),
});
const packagePairCheck = pairCheck.extend({ sources: z.array(pairEvidence.extend({ lineId: text.optional() })).max(8) });
export const pairChecksSchema = z.strictObject({
  variant: pairCheck, revision: pairCheck, applicability: pairCheck, comparability: pairCheck,
});
export const packagePairChecksSchema = z.strictObject({
  variant: packagePairCheck, revision: packagePairCheck, applicability: packagePairCheck, comparability: packagePairCheck,
});
export type PairChecks = z.infer<typeof packagePairChecksSchema>;
export function pairConfirmed(checks: PairChecks | undefined): boolean {
  return !!checks && pairCriteria.every((criterion) => checks[criterion].status === 'confirmed');
}

export interface Representation {
  evidenceId: string;
  place: Place;
  readerVersion: string;
  sha256: string;
  mediaType: 'application/json' | 'text/plain' | 'image/png' | 'image/jpeg' | 'image/webp';
  bytes: Buffer;
  support?: Branch;
  transform?: {
    width: number; height: number; pixelsPerPoint: number; pixelOriginX: number; pixelOriginY: number;
  };
  limitations?: string[];
}

export interface EvidenceRef {
  evidenceId: string;
  place: Place;
  readerVersion: string;
  sha256: string;
}

export interface ObservationInput {
  evidence: EvidenceRef;
  quote?: string;
  lineId?: string;
  value?: string;
  unit?: string;
  normalizedValue?: string;
  deliveryStatement?: DeliveryStatement;
  box?: z.infer<typeof boxSchema>;
  limitation?: string;
  alternatives?: string[];
  sourceRole?: string;
  package?: PackageDetails;
  components?: readonly ReaderComponentInput[];
  verifiedDelivery?: VerifiedNativeDeliveryLine & { role: { evidenceId: string; quote: string } };
}

export interface ReaderContext {
  task: ResearchTask;
  branch: Branch;
  effectKey: string;
}

export type ReadRequest =
  | { kind: 'survey' | 'extract' | 'ocr' | 'zoom'; support?: Branch; box?: z.infer<typeof boxSchema> }
  | { kind: 'search'; query: string; support?: Branch };

export interface PackageBlock {
  id: string;
  kind: 'native' | 'visual';
  lineIds?: string[];
  rows?:{first:number;last:number};
  box?: Place['box'];
}

export interface PackageSemanticCheck {
  windowId: string;
  branch: Branch;
  jobId: string;
  primaryJobId: string;
  readerVersion: string;
  facadeId: string | null;
  positionId: string;
  catalogVersionId: string;
  stage: string;
  basisIds: string[];
  disposition:'supported'|'alternatives_checked';
  subject?:string|null;
  reason?:string|null;
}

export interface BlockCheck {
  blockId: string;
  evidenceId: string;
  reviewed: boolean;
  reason: string;
}

export interface ReaderPort {
  structure?(context: ReaderContext, tx?:PoolClient): Promise<{ blocks: PackageBlock[]; limitation: string | null }>;
  checkBlocks?(tx: PoolClient, context: ReaderContext, checks: BlockCheck[]): Promise<void>;
  checkSemantics?(tx: PoolClient, context: ReaderContext, check: Omit<PackageSemanticCheck, 'windowId' | 'branch' | 'jobId' | 'primaryJobId' | 'readerVersion'>): Promise<void>;
  inventory(context: ReaderContext): Promise<unknown>;
  next?(context: ReaderContext): Promise<Place | null>;
  contexts?(context: ReaderContext, offset: number): Promise<{ items: { id: string; place: Place; format: string; support?: Branch }[]; nextOffset?: number }>;
  openContext?(context: ReaderContext, id: string, representation: 'native' | 'ocr' | 'render', box?: Place['box']): Promise<Representation>;
  read(context: ReaderContext, request: ReadRequest): Promise<Representation>;
  verifyDeliveryLine?(tx: PoolClient, context: ReaderContext, input: ObservationInput, issued: EvidenceRef[]):
    Promise<VerifiedNativeDeliveryLine | undefined>;
  record(
    tx: PoolClient, context: ReaderContext, observation: ObservationInput
  ): Promise<{ observationId: string; packageMetadata?: PackageMetadataReceipt }>;
}

export class ReaderRefusal extends Error {
  constructor(
    public readonly code: string,
    public readonly recoverability: 'permanent' | 'temporary',
  ) {
    super(code);
  }
}

export type ResearchOutcome =
  | { kind: 'covered'; observationIds: string[] }
  | { kind: 'reviewed_no_match'; evidenceIds: string[] }
  | { kind: 'final_refusal'; reason: string; evidenceIds: string[] }
  | { kind: 'proposal'; aObservationId: string; bObservationId: string; explanation: string; checks?: PairChecks;
      evidenceIds?: string[]; verifiedPair?: VerifiedPairEvidence }
  | { kind: 'verification'; verdict: 'supported' | 'unclear'; evidenceIds: string[]; explanation: string;
      checks?: PairChecks; verifiedPair?: VerifiedPairEvidence };

export interface ResearchSuspension {
  reason: string;
  nextAction: string;
  retryAt?: Date;
}

export type ModelResult =
  | { status: 'paid'; output: unknown; attemptId: string }
  | { status: 'rejected'; attemptId: string; code: string; retryable: boolean; retryAt?: Date }
  | { status: 'held'; code: string; nextAction: string; attemptId?: string; retryAt?: Date };
