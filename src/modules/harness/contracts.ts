import type { PoolClient } from 'pg';
import type { DeliveryStatement, ReaderComponentInput } from '../pdf/types.js';
import { z } from 'zod';

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
  unit: text,
  normalizedValue: text.optional(),
});
export const disputeSchema = z.strictObject({
  id,
  question: questionSchema,
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

export const jobSchema = z.discriminatedUnion('mode', [
  z.strictObject({
    mode: z.literal('primary'),
    branch: branchSchema,
    place: placeSchema,
    question: questionSchema.optional(),
    localRefusal: text.optional(),
    observationProtocol: z.literal(2).optional(),
    settings: settingsSchema.nullable(),
  }),
  z.strictObject({ mode: z.literal('lead'), dispute: disputeSchema, settings: settingsSchema.nullable() }),
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
  scopeId: string;
  generationId: string;
  job: ScheduledResearchJob;
}

export type ResearchTask = ScheduledResearchTask & { job: ResearchJob; earlyPair?: true };

export const pairCriteria = ['variant', 'revision', 'applicability', 'comparability'] as const;
const pairCheck = z.strictObject({
  status: z.enum(['confirmed', 'unclear', 'incompatible']), reason: text,
  sources: z.array(z.strictObject({ evidenceId: id, quote: text })).max(8),
});
export const pairChecksSchema = z.strictObject({
  variant: pairCheck, revision: pairCheck, applicability: pairCheck, comparability: pairCheck,
});
export type PairChecks = z.infer<typeof pairChecksSchema>;
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
  components?: readonly ReaderComponentInput[];
}

export interface ReaderContext {
  task: ResearchTask;
  branch: Branch;
  effectKey: string;
}

export type ReadRequest =
  | { kind: 'survey' | 'extract' | 'ocr' | 'zoom'; support?: Branch; box?: z.infer<typeof boxSchema> }
  | { kind: 'search'; query: string; support?: Branch };

export interface ReaderPort {
  inventory(context: ReaderContext): Promise<unknown>;
  next?(context: ReaderContext): Promise<Place | null>;
  contexts?(context: ReaderContext, offset: number): Promise<{ items: { id: string; place: Place; format: string; support?: Branch }[]; nextOffset?: number }>;
  openContext?(context: ReaderContext, id: string, representation: 'native' | 'ocr'): Promise<Representation>;
  read(context: ReaderContext, request: ReadRequest): Promise<Representation>;
  record(
    tx: PoolClient, context: ReaderContext, observation: ObservationInput
  ): Promise<{ observationId: string }>;
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
  | { kind: 'proposal'; aObservationId: string; bObservationId: string; explanation: string; checks?: PairChecks; evidenceIds?: string[] }
  | { kind: 'verification'; verdict: 'supported' | 'unclear'; evidenceIds: string[]; explanation: string; checks?: PairChecks };

export interface ResearchSuspension {
  reason: string;
  nextAction: string;
  retryAt?: Date;
}

export type ModelResult =
  | { status: 'paid'; output: unknown; attemptId: string }
  | { status: 'rejected'; attemptId: string; code: string; retryable: boolean; retryAt?: Date }
  | { status: 'held'; code: string; nextAction: string; attemptId?: string; retryAt?: Date };
