import type { PoolClient } from "pg";
import { AccessError, invalid, unavailable } from "../access/errors.js";
import { readFacadeSnapshot } from "../assessment/facade-store.js";
import { verifyOriginalBasis, type OriginalBasis } from "../intake/accepted-originals.js";
import type { Observation, ReaderAddress } from "../pdf/types.js";
import { deliveredLines } from "./attribute-aliases.js";
import { escapeRegex, normalize } from "./domain.js";
import type { QuestionSearchPorts } from "./domain.js";
import type { InquiryRow, SearchResult } from "./store.js";

export type PackageSource = Pick<OriginalBasis, "versionId" | "documentId" | "label" | "sha256" | "address">;
export type PackageSearch = {
  source: PackageSource;
  assessmentVersion: number;
  sliceId: string | null;
  stage: string | null;
  catalogVersionId: string | null;
  candidates: PackageCandidate[];
};
type PackageCandidate = {
  applicability: "verified" | "address_unavailable" | "meaning_unclear";
  source: {
    observationId: string; documentId: string; versionId: string; evidenceId: string; receiptId: string;
    address: ReaderAddress; label: string; quote?: string; value?: string; unit?: string; branch: "A" | "B";
    role: string; revision: string;
  };
};

type SourceInput = { versionId: string; anchor: string };
type FacadeSnapshot = NonNullable<Awaited<ReturnType<typeof readFacadeSnapshot>>>["payload"];
type Context = FacadeSnapshot["contexts"][number];

export async function packageContext(tx: PoolClient, projectId: string, contextId: string, expected?: number) {
  const snapshot = await readFacadeSnapshot(tx, projectId);
  const context = snapshot?.payload.contexts.find((context) => context.assessmentContextId === contextId);
  if (!snapshot || !context) throw unavailable();
  if (expected !== undefined && snapshot.version !== expected) throw stale();
  const { rows: [project] } = await tx.query<{ project_stage: string | null; catalog_version_id: string | null }>(
    `SELECT project_stage, catalog_version_id FROM projects WHERE id=$1 AND intake_mode`, [projectId],
  );
  if (!project) throw unavailable();
  if (project.project_stage !== snapshot.payload.stage || project.catalog_version_id !== snapshot.payload.catalogVersionId) throw stale();
  return { ...snapshot, context };
}

export function stale() {
  return new AccessError(409, "snapshot_required", "Основания вопроса изменились. Откройте актуальную область и повторите поиск.");
}

export async function packageSource(tx: PoolClient, projectId: string, input: SourceInput, snapshot: FacadeSnapshot,
  context: Context): Promise<PackageSource> {
  const { documentId, versionId, sha256, label, address } = await verifyOriginalBasis(tx, projectId, input.versionId, input.anchor);
  if (context.facadeId) {
    const { rowCount } = await tx.query(
      `SELECT 1 FROM facade_assessment_observations o
       WHERE o.project_id=$1 AND o.ref=ANY($2::text[]) AND o.payload->>'versionId'=$3
         AND o.payload#>>'{address,unitId}'=$4 AND o.payload->>'revisionStatus'='current'
         AND o.payload#>>'{binding,state}'='identified'
         AND o.payload#>'{binding,candidates}' @> jsonb_build_array(jsonb_build_object('id',$5::text))
       LIMIT 1`, [projectId, snapshot.observations.refs, versionId, address.unitId, context.facadeId],
    );
    if (!rowCount) throw invalid("inquiry_source_outside_context", "Принадлежность выбранного места этому фасаду не установлена. Откройте область «Весь комплект».");
  }
  return { documentId, versionId, sha256, label, address };
}

export const packageStateColumns = `EXISTS (
  SELECT 1 FROM intake_document_versions v
  JOIN intake_occurrences o ON o.project_id=v.project_id AND o.version_id=v.id AND o.state='accepted'
  WHERE v.project_id=i.project_id AND v.replaces_version_id=(i.package_source->>'versionId')::uuid
) AS "sourceReplaced",
  i.assessment_context_id IS NOT NULL AND EXISTS (
    SELECT 1 FROM projects p WHERE p.id=i.project_id AND (
      p.project_stage IS DISTINCT FROM i.stage OR p.catalog_version_id IS DISTINCT FROM i.catalog_version_id)
  ) AS "basisChanged"`;

type CandidateInput = {
  pin: Observation; originalId: string; sourceRole: string; revision: string;
};

function literalHas(literal: string, subject: string) {
  const token = escapeRegex(normalize(subject));
  return new RegExp(`(?:^|[^\\p{L}\\p{N}])${token}(?=$|[^\\p{L}\\p{N}])`, "u").test(normalize(literal));
}

export async function searchPackageInquiry(tx: PoolClient, job: InquiryRow, ports: QuestionSearchPorts,
  signal: AbortSignal): Promise<SearchResult> {
  const source = job.package_source!;
  const assessmentVersion = job.package_snapshot_version!;
  const snapshot = await readFacadeSnapshot(tx, job.project_id, assessmentVersion);
  const context = snapshot?.payload.contexts.find((item) => item.assessmentContextId === job.assessment_context_id);
  if (!snapshot || !context) throw unavailable();
  const locator = source.address.locator ?? {};
  const { rows } = await tx.query<CandidateInput>(
    `SELECT r.payload AS pin,v.original_id AS "originalId",o.payload->>'sourceRole' AS "sourceRole",
            o.payload->>'revisionStatus' AS revision
     FROM facade_assessment_observations o
     JOIN reader_observations r ON r.project_id=o.project_id AND r.id=o.observation_id
     JOIN intake_document_versions v ON v.project_id=r.project_id AND v.id=r.version_id
     WHERE o.project_id=$1 AND o.ref=ANY($2::text[]) AND r.version_id=$3
       AND r.payload#>>'{address,unitId}'=$4
       AND ($5::text IS NULL OR upper(r.payload#>>'{address,locator,cell}')=$5
         OR (r.payload#>>'{address,locator,row}'=$6 AND r.payload#>>'{address,locator,column}'=$7))
       AND o.payload->>'revisionStatus'<>'superseded'
       AND o.payload#>>'{engineeringReview,state}' IS DISTINCT FROM 'review_required'
       AND ($8::uuid IS NULL OR (o.payload#>>'{binding,state}'='identified'
         AND o.payload#>'{binding,candidates}' @> jsonb_build_array(jsonb_build_object('id',$8::text))))
     ORDER BY r.id LIMIT 101`,
    [job.project_id, snapshot.payload.observations.refs, source.versionId, source.address.unitId,
      locator.cell ?? null, locator.row ?? null, locator.column ?? null, context.facadeId],
  );
  const packageResult = packageSearch(job)!;
  const limitations = new Set<string>();
  if (!snapshot.payload.coverage.reading.complete) limitations.add("package_reading_incomplete");
  if (rows.length > 100) limitations.add("candidate_limit");
  for (const { pin, originalId, sourceRole, revision } of rows.slice(0, 100)) {
    signal.throwIfAborted();
    const quote = pin.quote;
    if (!quote || !literalHas(quote, job.subject.subject) || !literalHas(quote, job.subject.property) ||
      (job.subject.variant && !literalHas(quote, job.subject.variant))) continue;
    const reference = { ...pin.source, scopeId: pin.scope, originalId, observationId: pin.id, receiptId: pin.receiptId,
      evidenceId: pin.evidenceId, address: { ...pin.address }, quote: pin.quote, components: pin.components };
    const opened = await ports.openPackageSupport?.(reference, signal);
    const textVerified = opened?.grounding === "text" && opened.content.kind === "text" &&
      deliveredLines(opened.content.text).some((line) => line.id === opened.lineId && line.text.includes(quote));
    const applicability = !opened ? "address_unavailable" :
      !textVerified || revision !== "current" ? "meaning_unclear" : "verified";
    if (applicability !== "verified") limitations.add(applicability);
    packageResult.candidates.push({ applicability, source: {
      observationId: pin.id, documentId: source.documentId, versionId: source.versionId, label: source.label,
      address: pin.address, quote: pin.quote, value: pin.value, unit: pin.unit, branch: pin.branch,
      evidenceId: pin.evidenceId, receiptId: pin.receiptId, role: sourceRole, revision,
    } });
  }
  return { state: limitations.size ? "partial" : packageResult.candidates.some(({ applicability }) => applicability === "verified")
    ? "verified" : "empty", limitations: [...limitations], candidates: [], pairs: [], packageResult };
}

export function packageSearch(job: InquiryRow): PackageSearch | undefined {
  if (!job.package_source || !job.package_snapshot_version) return undefined;
  return { source: job.package_source, assessmentVersion: job.package_snapshot_version, sliceId: job.slice_id,
    stage: job.stage, catalogVersionId: job.catalog_version_id, candidates: [] };
}
