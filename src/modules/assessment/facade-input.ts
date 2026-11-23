import type { PoolClient } from "pg";
import { readPackageAnalysis, type PackageFact } from "../harness/package-analysis.js";
import { deliveredLines } from "../questions/attribute-aliases.js";
import { hasAddressedSubject } from "../questions/subject-evidence.js";
import { canonicalJson, isInventoryRole } from "./domain.js";
import type { Evidence, ReaderAddress } from "../pdf/types.js";
import { exactDeliveryStatement, nonDeliveryFromOriginal, type FacadeFact, type FacadeReadout } from "./facade-model.js";
import type { Gate } from "./store.js";
import { normalizeFormat } from "./store.js";

type AcceptedVersion = { id: string; sha256: string; documentId: string; label: string };
type Impact = { receiptId: string; questionId: string };
type ConfirmedStage = { versionId: string; target: ReaderAddress | null; stage: string; evidenceId: string };
type EvidenceMetadata = Pick<Evidence, "source" | "address" | "representation">;
type ReplacementReference = { observationId: string; evidenceId: string; versionId: string; address: Record<string, unknown> };
export type FacadeReplacement = {
  id: string;
  questionId: string;
  catalogVersionId: string;
  receiptIds: string[];
  replaced: ReplacementReference[];
  replacements: ReplacementReference[];
};

const completeBranch = (state: string) => state === "covered" || state === "reviewed_no_match";

function convertFact(fact: PackageFact, accepted: Map<string, AcceptedVersion>, formats: Map<string, string>,
  stages: Map<string, ConfirmedStage>, evidence: Map<string, EvidenceMetadata>, originalLines: Map<string, string | undefined>): FacadeFact | null {
  const { source, quote, value, unit, evidenceId, receiptId, runId, lineId, address, components, deliveryStatement } = fact.observation;
  const original = accepted.get(source.versionId);
  const format = formats.get(fact.windowId);
  if (!original || original.sha256 !== source.sha256 || original.documentId !== source.documentId || !format) return null;
  const { state, candidates, actorId } = fact.binding;
  const anchored = Boolean(fact.binding.quote || actorId);
  const membership = state === "identified" && anchored && candidates.length ?
    { kind: "facades" as const, facadeIds: candidates.map(({ id }) => id) } :
    state === "common" && anchored ? { kind: "common" as const } :
    { kind: state === "unidentified" ? "unidentified" as const : "ambiguous" as const };
  const attribute = fact.attribute?.trim() || deliveryStatement?.item || null;
  const subjectVerified = attribute && !deliveryStatement && value != null && quote && lineId &&
    hasAddressedSubject({ subject: attribute, property: attribute }, fact.observation,
      [{ id: lineId, text: quote, box: address.box, locator: address.locator }]);
  const literal = attribute?.normalize("NFKC").trim().replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  const anchoredPresence = literal && !deliveryStatement && value == null && quote &&
    fact.observation.grounding === "text" && !exactDeliveryStatement(quote, attribute!, "not_delivered") &&
    new RegExp(`(?<![\\p{L}\\p{N}])${literal}(?![\\p{L}\\p{N}])`, "iu").test(quote.normalize("NFKC"));
  const evidenceBound = Boolean(quote) && fact.observation.grounding !== "limited" && !fact.observation.limitation &&
    Boolean(fact.basis.role) && Boolean(fact.basis.revision) && Boolean(deliveryStatement || subjectVerified || anchoredPresence);
  const active = evidenceBound && fact.sourceRole !== "unknown" && fact.revisionStatus === "current";
  const literalInventory = active && fact.observation.grounding === "text" && Boolean(quote) && isInventoryRole(fact.sourceRole);
  const originalLine = originalLines.get(fact.id);
  const absence = literalInventory && !fact.observation.alternatives?.length &&
    deliveryStatement?.status === "not_delivered" && nonDeliveryFromOriginal(quote!, originalLine, deliveryStatement.item);
  const positiveInOriginal = originalLine && deliveryStatement &&
    exactDeliveryStatement(originalLine, deliveryStatement.item, "delivered");
  const negativeInOriginal = originalLine && deliveryStatement &&
    exactDeliveryStatement(originalLine, deliveryStatement.item, "not_delivered");
  const deliveryUncertainty = positiveInOriginal && negativeInOriginal ||
      (positiveInOriginal && deliveryStatement?.status === "not_delivered") ||
      (negativeInOriginal && deliveryStatement?.status === "delivered") ? "contradictory_original" as const :
    deliveryStatement?.status === "not_delivered" && !absence ? "original_statement_unverified" as const : undefined;
  const printedStage = fact.basis.stage ? fact.designStage : null;
  const confirmation = stages.get(canonicalJson([source.versionId, address])) ??
    (!printedStage ? stages.get(canonicalJson([source.versionId, null])) : undefined);
  const receivedTitle = fact.basis.revisionEvidence;
  const title = receivedTitle && evidence.get(receivedTitle.evidenceId);
  const revisionBasis = title && title.source.versionId === source.versionId && title.source.sha256 === source.sha256 ?
    { evidenceId: receivedTitle!.evidenceId, address: title.address, quote: receivedTitle!.quote } :
    quote && fact.basis.revision && quote.includes(fact.basis.revision) ? { evidenceId, address, quote: fact.basis.revision } : null;
  return {
    membership,
    property: attribute,
    materials: fact.materials.map(({ label }) => label),
    variant: fact.variant,
    addressedValue: Boolean(subjectVerified),
    printedRevision: fact.basis.revision ? fact.revision : null,
    stage: confirmation?.stage ?? printedStage,
    runId,
    finding: {
      kind: absence ? "absence" : deliveryStatement || value == null ? "delivery" : "value",
      applicability: fact.revisionStatus === "superseded" ? "superseded" : active && !deliveryUncertainty ? "active" : "unknown",
      sourceRole: fact.sourceRole,
      format,
      representation: evidence.get(evidenceId)?.representation,
      comparisonKey: "",
      ...(absence ? { nonDelivery: { kind: "explicit_non_delivery", subjectQuote: deliveryStatement.item, questionId: "", receiptId } } : {}),
      citation: {
        observationId: fact.id, evidenceId, branch: fact.branch, receiptId, documentId: source.documentId,
        versionId: source.versionId, sha256: source.sha256, address: { ...address }, label: original.label,
        quote: quote ?? "", value: value ?? null, unit: unit ?? null, href: fact.evidenceHref,
        ...(components ? { components } : {}),
        ...(deliveryStatement ? { deliveryStatement } : {}),
        ...(deliveryUncertainty ? { deliveryUncertainty } : {}),
        ...(confirmation ? { stageConfirmation: { stage: confirmation.stage, evidenceId: confirmation.evidenceId } } : {}),
        ...(fact.revision && revisionBasis ? { documentRevision: {
          label: fact.revision, ...revisionBasis, address: { ...revisionBasis.address },
        } } : {}),
      },
    },
  };
}

export function facadeObservation(fact: PackageFact) {
  const { observation, id, branch, attribute, sourceRole, designStage, revision, revisionStatus, basis, binding, evidenceHref } = fact;
  const quote = observation.quote ?? null;
  const typeAttribute = /^(?:тип фасада|facade (?:kind|type))$/iu;
  const typeClause = /^(?:тип фасада|facade (?:kind|type))\s*[:=–—]\s*([\p{L}\p{N}][\p{L}\p{N} _-]{0,99})\s*$/iu;
  const proposedFacadeKind = attribute && typeAttribute.test(attribute.trim()) && quote && basis.role &&
    binding.state === "identified" && revisionStatus !== "superseded" && observation.grounding === "text"
    ? quote.split(/[|·;,\n]/u).flatMap((clause) => typeClause.exec(clause.trim())?.[1]?.trim() ?? [])[0] ?? null : null;
  return { id, branch, attribute, sourceRole, designStage, revision, revisionStatus, basis, binding, evidenceHref,
    evidenceId: observation.evidenceId, proposedFacadeKind,
    receiptId: observation.receiptId, documentId: observation.source.documentId, versionId: observation.source.versionId,
    sha256: observation.source.sha256, address: observation.address, quote,
    value: observation.value ?? null, unit: observation.unit ?? null,
    originalHref: `/api/documents/${observation.source.documentId}/versions/${observation.source.versionId}/content` };
}

export type FacadeObservation = ReturnType<typeof facadeObservation>;

export async function readFacadeInput(tx: PoolClient, projectId: string) {
  const { rows: [intake] } = await tx.query<{
    closed: boolean; excluded: boolean; unresolvedImports: boolean; receiptIds: string[]; generation: string;
  }>(
    `SELECT EXISTS (SELECT 1 FROM intake_receipts WHERE project_id=$1) AND NOT EXISTS (
       SELECT 1 FROM intake_receipts r WHERE r.project_id=$1 AND (r.sealed_at IS NULL OR EXISTS (
         SELECT 1 FROM intake_occurrences o WHERE o.project_id=$1 AND o.receipt_id=r.id
           AND (o.inventory_pending OR o.state='declared')
       ) OR EXISTS (
         SELECT 1 FROM intake_imports i WHERE i.project_id=$1 AND i.receipt_id=r.id
           AND i.state IN ('queued','running','paused')
       ))
     ) AS closed,
     EXISTS (SELECT 1 FROM intake_manifest_items m JOIN intake_receipts r ON r.id=m.receipt_id
       WHERE r.project_id=$1 AND m.excluded_at IS NOT NULL) OR EXISTS (
         SELECT 1 FROM intake_occurrences o WHERE o.project_id=$1 AND o.parent_occurrence_id IS NULL
           AND o.state IN ('cancelled','expired')
       ) AS excluded,
     EXISTS (SELECT 1 FROM intake_imports i WHERE i.project_id=$1
       AND i.state NOT IN ('completed','queued','running','paused')) AS "unresolvedImports",
     ARRAY (SELECT id FROM intake_receipts WHERE project_id=$1 ORDER BY number) AS "receiptIds",
     coalesce((SELECT generation FROM intake_project_generations WHERE project_id=$1), 0)::text AS generation`,
    [projectId],
  );
  const { rows: versions } = await tx.query<AcceptedVersion>(
    `SELECT v.id, v.document_id AS "documentId", raw.sha256, occurrence.relative_path AS label
      FROM intake_document_versions v
      JOIN intake_originals raw ON raw.project_id=v.project_id AND raw.id=v.original_id
      JOIN LATERAL (
        SELECT relative_path FROM intake_occurrences o
        WHERE o.project_id=v.project_id AND o.version_id=v.id AND o.state='accepted'
        ORDER BY o.created_at, o.id LIMIT 1
      ) occurrence ON true
      WHERE v.project_id=$1 AND NOT EXISTS (
        SELECT 1 FROM intake_document_versions replacement
        WHERE replacement.project_id=$1 AND replacement.replaces_version_id=v.id
          AND EXISTS (SELECT 1 FROM intake_occurrences o WHERE o.version_id=replacement.id AND o.state='accepted')
      )
      ORDER BY v.id`, [projectId],
  );
  const { rows: holds } = await tx.query<Gate["holds"][number]>(
    `SELECT h.id,h.receipt_id AS "receiptId",h.source,h.source_id AS "sourceId",
      h.generation::float8 AS generation,h.version,h.scope_ids AS "scopeIds"
     FROM intake_holds h JOIN intake_receipts r ON r.project_id=h.project_id AND r.id=h.receipt_id
     WHERE h.project_id=$1 AND h.closed_at IS NULL AND h.scope_ids IS NULL
       AND EXISTS (SELECT 1 FROM intake_receipts prior WHERE prior.project_id=$1 AND prior.sealed_at <= r.created_at
         AND prior.id<>r.id)
       AND NOT EXISTS (SELECT 1 FROM supplement_receipt_links l
         JOIN letters letter ON letter.id=l.letter_id AND letter.project_id=l.project_id
         WHERE l.project_id=$1 AND l.receipt_id=r.id AND letter.assessment_context_id IS NOT NULL)
     ORDER BY h.generation,h.id`, [projectId],
  );
  const { rows: impacts } = await tx.query<Impact>(
    `SELECT DISTINCT l.receipt_id AS "receiptId",(item->>'questionId')::uuid AS "questionId"
       FROM supplement_receipt_links l
       JOIN letters letter ON letter.id=l.letter_id AND letter.project_id=l.project_id AND letter.assessment_context_id IS NOT NULL
       JOIN letter_sends sent ON sent.letter_id=l.letter_id AND sent.id=l.sent_id
       CROSS JOIN LATERAL jsonb_array_elements(sent.items) AS item
       WHERE l.project_id=$1 AND (l.item_id IS NULL OR item->>'id'=l.item_id::text)
       ORDER BY 1,2`, [projectId],
  );
  const { rows: replacements } = await tx.query<FacadeReplacement>(
    `SELECT r.id,r.question_id AS "questionId",r.catalog_version_id AS "catalogVersionId",r.receipt_ids AS "receiptIds",
            r.replaced,r.replacements
       FROM facade_source_replacements r
       JOIN assessment_questions q ON q.id=r.question_id
       JOIN assessment_series s ON s.scope_id=q.scope_id
       WHERE s.project_id=$1 ORDER BY r.created_at,r.id`, [projectId],
  );
  const { rows: stages } = await tx.query<ConfirmedStage>(
    `SELECT version_id AS "versionId", target, stage, evidence_id AS "evidenceId"
     FROM document_stage_confirmations WHERE project_id=$1`, [projectId],
  );
  const stageByAddress = new Map(stages.map((stage) => [canonicalJson([stage.versionId, stage.target]), stage]));
  const analysis = await readPackageAnalysis(tx, projectId);
  const accepted = new Map(versions.map((version) => [version.id, version]));
  const windows = analysis.windows.filter(({ place }) => accepted.get(place.source.versionId)?.sha256 === place.source.sha256);
  const formats = new Map(windows.map(({ id, format }) => [id, format]));
  const activeFacts = analysis.facts.filter(({ observation, windowId }) =>
    accepted.get(observation.source.versionId)?.sha256 === observation.source.sha256 && formats.has(windowId));
  const evidenceIds = [...new Set(activeFacts.flatMap(({ observation, basis }) =>
    [observation.evidenceId, ...(basis.revisionEvidence ? [basis.revisionEvidence.evidenceId] : [])]))];
  const evidenceRows = evidenceIds.length ? (await tx.query<{ id: string; payload: EvidenceMetadata }>(
    `SELECT id,payload FROM reader_evidence WHERE project_id=$1 AND id=ANY($2::uuid[])`, [projectId, evidenceIds],
  )).rows : [];
  const evidenceById = new Map(evidenceRows.map(({ id, payload }) => [id, payload]));
  const statementIds = activeFacts.filter(({ observation }) => observation.deliveryStatement).map(({ id }) => id);
  const { rows: statements } = statementIds.length ? await tx.query<{ id: string; lineId: string; content: string }>(
    `SELECT o.id,o.payload->>'lineId' AS "lineId",issued.content FROM reader_observations o
       JOIN LATERAL (
         SELECT event#>>'{reply,body,content}' AS content FROM harness_research_events
         WHERE job_id=o.run_id AND event#>>'{reply,evidence,evidenceId}'=o.evidence_id::text
         ORDER BY sequence LIMIT 1
       ) issued ON true
     WHERE o.project_id=$1 AND o.id=ANY($2::uuid[]) AND o.payload->>'grounding'='text'`, [projectId, statementIds],
  ) : { rows: [] };
  const originalLines = new Map(statements.map(({ id, lineId, content }) =>
    [id, deliveredLines(content).find(({ id }) => id === lineId)?.text]));
  const facts = activeFacts.flatMap((fact) => convertFact(fact, accepted, formats, stageByAddress, evidenceById, originalLines) ?? []);
  const branchesWithFindings = new Set(activeFacts.map(({ windowId, branch }) => `${windowId}:${branch}`));
  const unclassifiedFormats = new Set(windows.filter(({ id }) =>
    !branchesWithFindings.has(`${id}:A`) || !branchesWithFindings.has(`${id}:B`)).map(({ format }) => normalizeFormat(format)));
  const coveredWindows = windows.filter(({ branches }) => completeBranch(branches.A.status) &&
    completeBranch(branches.B.status) && branches.A.jobId && branches.B.jobId && branches.A.jobId !== branches.B.jobId);
  const mappedVersionIds = [...new Set(windows.map(({ place }) => place.source.versionId))].sort();
  const versionIds = versions.map(({ id }) => id);
  const reading = windows.length > 0 && coveredWindows.length === windows.length &&
    canonicalJson(mappedVersionIds) === canonicalJson(versionIds) ?
    { versionIds, basisIds: coveredWindows.flatMap(({ branches }) => [branches.A.jobId!, branches.B.jobId!]).sort() } : null;
  const evidence: FacadeReadout = {
    facts,
    facades: [...new Map(activeFacts.filter(({ binding }) => binding.state === "identified" && (binding.quote || binding.actorId))
      .flatMap(({ binding }) => binding.candidates).map((item) => [item.id, item])).values()],
    map: analysis.coverage.physicalProof,
    subject: analysis.coverage.subjectProof,
    pairs: analysis.verifiedPairs,
    reading,
  };
  return { intake, versionIds, evidence, impacts, replacements, holds, unclassifiedFormats,
    observations: activeFacts.map(facadeObservation), activeWindows: windows.length,
    completedWindows: coveredWindows.length };
}
