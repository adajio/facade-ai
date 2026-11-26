import type { PoolClient } from "pg";
import { contradictoryDeliveryLine, exactDeliveryStatement } from "../../domain/delivery-statement.js";
import { readPackageAnalysis, type PackageAnalysis, type PackageFact } from "../harness/package-analysis.js";
import { hasPrintedRevision, hasInactiveRevision } from "../harness/pair-evidence.js";
import { blockedComparisonReads } from "../harness/package-walk.js";
import { deliveredLines } from "../questions/attribute-aliases.js";
import { hasAddressedCategoricalSubject, hasAddressedSubject } from "../questions/subject-evidence.js";
import { canonicalJson, isInventoryRole, normalizeFactValue, requirementSubjectKey } from "./domain.js";
import type { Evidence, ReaderAddress, ReaderLine } from "../pdf/types.js";
import { comparisonRows, readCanonicalComparisonRows, type IssuedComparisonEvidence } from "./facade-comparison-rows.js";
import { deliveryEvidenceIds, fullDeliveryLine, type DeliveryEvidence } from "./facade-delivery.js";
import { nonDeliveryFromOriginal, type FacadeFact, type FacadeReadout } from "./facade-model.js";
import { completedReaderJob, indexSemanticInput } from "./facade-semantic.js";
import type { Gate } from "./store.js";
import { acceptedOriginals, type OriginalBasis } from "../intake/accepted-originals.js";
import { readFactReviews } from "./fact-review.js";
import { matchingDocumentFacadeLink, readDocumentFacadeLinks, readManuallyNamedFacades, type DocumentFacadeLink } from "./document-facades.js";

type AcceptedVersion = { id: string; sha256: string; documentId: string; label: string };
type Impact = { receiptId: string; questionId: string };
type ConfirmedStage = { versionId: string; target: ReaderAddress | null; stage: string; evidenceId: string | null; originalBasis: OriginalBasis | null };
function manualPlaceKey(versionId: string, address: ReaderAddress, format: string) {
  if (format === 'pdf' && /^[1-9]\d*$/.test(address.unitId)) {
    return canonicalJson([versionId, 'pdf-page', address.unitId]);
  }
  const at = address.locator;
  return format === 'xlsx' && at?.sheet && at.cell ? canonicalJson([versionId, 'xlsx-cell', address.unitId, at.sheet, at.cell]) : undefined;
}

const typeClause = /^(?:тип фасада|facade (?:kind|type))\s*[:=–—]\s*([\p{L}\p{N}][\p{L}\p{N} _-]{0,99})\s*$/iu;
type ReplacementReference = { observationId: string; evidenceId: string; versionId: string; address: Record<string, unknown> };
export type FacadeReplacement = {
  id: string;
  questionId: string;
  catalogVersionId: string;
  receiptIds: string[];
  replaced: ReplacementReference[];
  replacements: ReplacementReference[];
};

function unlabelledHeading(line: string | undefined, quote: string) {
  if (!line?.includes(quote)) return;
  const fields = line.trim().split(/[|;·\n]/u);
  const headers = fields.flatMap((field) => {
    const title = /^(?:title|heading|заголовок|наименование)\s*:\s*(.+)$/iu.exec(field.trim())?.[1]?.trim();
    return title ? [title] : [];
  });
  const heading = headers.length === 1 ? headers[0] : !headers.length && fields.length === 1 ? fields[0] : undefined;
  if (heading && quote.includes(heading) && !exactDeliveryStatement(line, heading, "not_delivered") &&
    !contradictoryDeliveryLine(line, heading)) return heading;
}

function addressedApproval(lines: ReaderLine[], anchor: ReaderLine, observation: PackageFact["observation"], revision: string) {
  const inactive = /(?:не\s+(?:подписан|утвержд[её]н)|подпись\s+(?:отсутствует|аннулирована|отозвана)|черновик|\b(?:draft|unsigned|unapproved)\b)/iu;
  const revisionMarker = /^(?:revision|rev\.?|редакция|ревизия|ред\.?)(?=\s|[:№=])/iu;
  const marker = /^(?:подписано|подписал[а]?|утвержд[её]но|утвердил[а]?|signed by|approved by)(?:\s*:\s*|\s+)(.+)$/iu;
  const fullName = /^\p{Lu}\p{Ll}{1,}(?:[-‐‑]\p{Lu}\p{Ll}{1,})?\s+(?:\p{Lu}\.\s*\p{Lu}\.|(?:\p{Lu}\p{Ll}{1,}\s+)?\p{Lu}\p{Ll}{1,}\.?)$/u;
  const fields = lines.flatMap((line) => line.text.split(/[|;·\n]/u).map((text) => ({ line, text: text.trim() })));
  if (fields.some(({ text }) => inactive.test(text) || revisionMarker.test(text) && !hasPrintedRevision(text, revision))) return;
  const approvals = fields.filter(({ text }) => marker.test(text));
  if (approvals.length !== 1) return;
  const [{ text: quote, line }] = approvals;
  const signer = marker.exec(quote)![1];
  const unnamed = /(?<!\p{L})(?:фамилия|отчество|должность|директор|инженер|ответственное лицо|full name|first name|last name|signatory|director|engineer)(?!\p{L})/iu;
  if (!fullName.test(signer) || unnamed.test(signer)) return;
  const { address, evidenceId } = observation;
  const lineId = line.id;
  if (line === anchor) return { evidenceId, lineId, address, quote };
  if (!lineId || lines.filter(({ id }) => id === lineId).length !== 1 || !line.box && !Object.keys(line.locator ?? {}).length) return;
  return { evidenceId, lineId, address: { unitId: address.unitId, ...(line.box ? { box: line.box } : {}),
    ...(line.locator ? { locator: line.locator } : {}) }, quote };
}

export function convertFact(fact: PackageFact, accepted: Map<string, AcceptedVersion>, formats: Map<string, string>,
  stages: Map<string, ConfirmedStage>, evidence: Map<string, DeliveryEvidence>, original: ReaderLine[] | undefined,
  provenFacade: boolean, links?: ReadonlyMap<string, DocumentFacadeLink>): FacadeFact | null {
  const { source, quote, value, unit, evidenceId, receiptId, runId, lineId, address, components, deliveryStatement } = fact.observation;
  const acceptedOriginal = accepted.get(source.versionId);
  const format = formats.get(fact.windowId);
  if (!acceptedOriginal || acceptedOriginal.sha256 !== source.sha256 || acceptedOriginal.documentId !== source.documentId || !format) return null;
  const { state, candidates, actorId } = fact.binding;
  const anchored = Boolean(fact.binding.quote || actorId);
  const membership = state === "identified" && provenFacade && candidates.length ?
    { kind: "facades" as const, facadeIds: candidates.map(({ id }) => id) } :
    state === "common" && anchored ? { kind: "common" as const } :
    { kind: state === "unidentified" ? "unidentified" as const : "ambiguous" as const };
  // A document or place link applies where membership was open. Existing addressed claims
  // for another facade or the common level retain their own evidence.
  const link = membership.kind === 'ambiguous' || membership.kind === 'unidentified' ?
    matchingDocumentFacadeLink(links, format === 'pdf' && !address.locator?.page && /^[1-9]\d*$/.test(address.unitId) ?
      { ...address, locator: { page: Number(address.unitId) } } : address) : undefined;
  const attribute = fact.attribute?.trim() || deliveryStatement?.item || null;
  const addressedLines = original ?? (lineId && quote ? [{ id: lineId, text: quote, box: address.box, locator: address.locator }] : []);
  const subjectVerified = attribute && !deliveryStatement && value != null &&
    (hasAddressedSubject({ subject: attribute, property: attribute }, fact.observation, addressedLines) ||
      hasAddressedCategoricalSubject(attribute, fact.observation, addressedLines));
  const literal = attribute?.normalize("NFKC").trim().replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  const addressedLine = addressedLines.filter(({ id }) => id === lineId);
  const heading = !attribute && value == null && !deliveryStatement && quote && fact.observation.grounding === "text" &&
    addressedLine.length === 1 ? unlabelledHeading(addressedLine[0].text, quote) : undefined;
  const anchoredPresence = literal && !deliveryStatement && value == null && quote &&
    fact.observation.grounding === "text" && addressedLine.length === 1 && addressedLine[0].text.includes(quote) &&
    !exactDeliveryStatement(addressedLine[0].text, attribute!, "not_delivered") &&
    new RegExp(`(?<![\\p{L}\\p{N}])${literal}(?![\\p{L}\\p{N}])`, "iu").test(quote.normalize("NFKC"));
  const currentLine = !addressedLine.some((line) => hasInactiveRevision(line.text));
  const metadataGrounded = currentLine && Boolean(quote) && fact.observation.grounding !== "limited" && !fact.observation.limitation &&
    !fact.observation.alternatives?.length &&
    Boolean(fact.basis.role) && Boolean(fact.basis.revision) && fact.sourceRole !== "unknown" && fact.revisionStatus === "current";
  const active = metadataGrounded && Boolean(deliveryStatement || subjectVerified || anchoredPresence);
  const documentApproval = metadataGrounded && (anchoredPresence || heading) && original && quote && fact.revision &&
    addressedLine.length === 1 && addressedLine[0].text.includes(quote)
    ? addressedApproval(original, addressedLine[0], fact.observation, fact.revision) : undefined;
  function contextAddress(evidenceId: string) {
    const item = evidence.get(evidenceId);
    return item?.source.versionId === source.versionId && item.source.sha256 === source.sha256 ? item.address : undefined;
  }
  const valueRoleProof = fact.basis.valueRole;
  const rolePart = fact.basis.parts?.valueRole;
  const roleAddress = rolePart ? contextAddress(rolePart.evidenceId) : address;
  const roleQuote = rolePart?.quote ?? quote;
  const valueRoleBasis = valueRoleProof?.quote && roleAddress && roleQuote?.includes(valueRoleProof.quote)
    ? { ...valueRoleProof, evidenceId: rolePart?.evidenceId ?? evidenceId, address: { ...roleAddress } } : undefined;
  const literalInventory = active && fact.observation.grounding === "text" && Boolean(quote) && isInventoryRole(fact.sourceRole);
  const issuedMatches = original?.filter(({ id }) => id === lineId);
  const issuedLine = issuedMatches?.length === 1 ? issuedMatches[0] : undefined;
  const full = deliveryStatement?.status === "not_delivered" ? fullDeliveryLine(fact, format, evidence, issuedLine) : undefined;
  const originalLine = deliveryStatement?.status === "not_delivered" ? full?.line.text : issuedLine?.text;
  const canEstablishAbsence = literalInventory && !fact.observation.alternatives?.length && deliveryStatement?.status === "not_delivered";
  const absence = canEstablishAbsence && nonDeliveryFromOriginal(full?.companion?.quote ?? quote!, originalLine, deliveryStatement.item);
  const hasLegacyCrop = canEstablishAbsence && !fact.basis.deliveryLine && Boolean(evidence.get(evidenceId)?.address.box) &&
    Boolean(issuedLine?.text.includes(quote!)) && exactDeliveryStatement(quote!, deliveryStatement.item, "not_delivered");
  const positiveInOriginal = originalLine && deliveryStatement &&
    contradictoryDeliveryLine(originalLine, deliveryStatement.item);
  const negativeInOriginal = originalLine && deliveryStatement &&
    exactDeliveryStatement(originalLine, deliveryStatement.item, "not_delivered");
  const deliveryUncertainty = positiveInOriginal && negativeInOriginal ||
      (positiveInOriginal && deliveryStatement?.status === "not_delivered") ||
      (negativeInOriginal && deliveryStatement?.status === "delivered") ? "contradictory_original" as const :
    deliveryStatement?.status === "not_delivered" && !absence ? "original_statement_unverified" as const : undefined;
  const printedStage = fact.basis.stage ? fact.designStage : null;
  const key = manualPlaceKey(source.versionId, address, format);
  const localStage = key ? stages.get(key) : undefined;
  const confirmation = stages.get(canonicalJson([source.versionId, address])) ??
    (localStage?.originalBasis ? localStage : undefined) ??
    (!printedStage ? stages.get(canonicalJson([source.versionId, null])) : undefined);
  const receivedTitle = fact.basis.revisionEvidence;
  const title = receivedTitle && evidence.get(receivedTitle.evidenceId);
  const revisionPart = fact.basis.parts?.revision;
  const revisionPartAddress = revisionPart && contextAddress(revisionPart.evidenceId);
  const revisionBasis = title && title.source.versionId === source.versionId && title.source.sha256 === source.sha256 ?
    { evidenceId: receivedTitle!.evidenceId, address: title.address, quote: receivedTitle!.quote } :
    revisionPart && revisionPartAddress && fact.basis.revision && revisionPart.quote.includes(fact.basis.revision) ?
      { evidenceId: revisionPart.evidenceId, address: revisionPartAddress, quote: fact.basis.revision } :
    quote && fact.basis.revision && quote.includes(fact.basis.revision) ? { evidenceId, address, quote: fact.basis.revision } : null;
  return {
    membership: link ? { kind: 'facades', facadeIds: [link.facadeId] } : membership,
    ...(link ? { documentFacadeLink: { version: link.version, basis: link.basis, facadeId: link.facadeId } } : {}),
    property: attribute,
    ...(heading ? { legacyPresence: { subject: heading, verified: Boolean(original) && metadataGrounded } } : {}),
    ...(anchoredPresence || heading && original ? { addressedPresence: true } : {}),
    ...(documentApproval ? { documentApproval } : {}),
    materials: fact.materials.map(({ label }) => label),
    variant: fact.variant,
    addressedValue: Boolean(subjectVerified),
    ...(format === "pdf" && lineId && (hasLegacyCrop || absence && full?.identity) ? {
      deliveryLocation: canonicalJson([source, receiptId, fact.observation.readerVersion, address.unitId, lineId, deliveryStatement.item]),
    } : {}),
    ...(absence && full?.identity ? { deliveryLineIdentity: full.identity } : {}),
    printedRevision: fact.basis.revision ? fact.revision : null,
    stage: confirmation?.stage ?? printedStage,
    runId,
    finding: {
      kind: absence ? "absence" : deliveryStatement || value == null ? "delivery" : "value",
      applicability: fact.revisionStatus === "superseded" ? "superseded" : active && !deliveryUncertainty ? "active" : "unknown",
      sourceRole: fact.sourceRole,
      format,
      representation: evidence.get(evidenceId)?.representation,
      ...(valueRoleBasis ? { valueRole: valueRoleBasis.kind } : {}),
      comparisonKey: "",
      ...(absence ? { nonDelivery: { kind: "explicit_non_delivery", subjectQuote: deliveryStatement.item, questionId: "", receiptId } } : {}),
      citation: {
        observationId: fact.id, evidenceId, branch: fact.branch, receiptId, documentId: source.documentId,
        versionId: source.versionId, sha256: source.sha256, address: { ...address }, label: acceptedOriginal.label,
        quote: quote ?? "", value: value ?? null, unit: unit ?? null, href: fact.evidenceHref,
        ...(components ? { components } : {}),
        ...(deliveryStatement ? { deliveryStatement } : {}),
        ...(absence && full?.companion ? { deliveryBasis: full.companion } : {}),
        ...(deliveryUncertainty ? { deliveryUncertainty } : {}),
        ...(confirmation ? { stageConfirmation: { stage: confirmation.stage, ...(confirmation.originalBasis ? { originalBasis: confirmation.originalBasis } : { evidenceId: confirmation.evidenceId! }) } } : {}),
        ...(valueRoleBasis ? { valueRoleBasis } : {}),
        ...(fact.revision && revisionBasis ? { documentRevision: {
          label: fact.revision, ...revisionBasis, address: { ...revisionBasis.address },
        } } : {}),
      },
    },
  };
}

function typeInLine(line: string) {
  const found = new Set(line.split(/[|·;,\n]/u).flatMap((clause) => typeClause.exec(clause.trim())?.[1]?.trim() ?? []));
  return found.size === 1 ? found.values().next().value! : null;
}

export function facadeObservation(fact: PackageFact, originalLine?: string) {
  const { observation, id, branch, attribute, sourceRole, designStage, revision, revisionStatus, variant, basis, binding, evidenceHref } = fact;
  const quote = observation.quote ?? null;
  const proposedFacadeKind = quote && basis.role &&
    binding.state === "identified" && revisionStatus !== "superseded" && observation.grounding === "text"
    ? typeInLine(quote) : null;
  const facadeKindSourceVerified = Boolean(proposedFacadeKind && originalLine && quote && originalLine.includes(quote) &&
    typeInLine(originalLine) === proposedFacadeKind);
  return { id, branch, attribute, sourceRole, designStage, revision, revisionStatus, variant, basis, binding, evidenceHref,
    evidenceId: observation.evidenceId, proposedFacadeKind, facadeKindSourceVerified,
    receiptId: observation.receiptId, documentId: observation.source.documentId, versionId: observation.source.versionId,
    sha256: observation.source.sha256, address: observation.address, quote,
    value: observation.value ?? null, unit: observation.unit ?? null,
    normalized: normalizeFactValue(observation.value ?? null, observation.unit ?? null),
    originalHref: `/api/documents/${observation.source.documentId}/versions/${observation.source.versionId}/content` };
}

export type FacadeObservation = ReturnType<typeof facadeObservation>;
export type ComparisonRead = { branch: PackageFact["branch"]; state: "route_required" | "ready" | "leased" | "held" | "done" };

async function comparisonReads(tx: PoolClient, projectId: string, windows: PackageAnalysis["windows"], facts: PackageFact[],
  targetIds: string[]) {
  const { rows } = await tx.query<ComparisonRead & { windowId: string; lineId: string; property: string }>(
    `SELECT f.window_id AS "windowId",f.branch,
      CASE WHEN j.state='leased' AND j.lease_until<=clock_timestamp() THEN 'ready' ELSE j.state END AS state,
      j.payload#>>'{packageWindow,followup,comparison,lineId}' AS "lineId",
      j.payload#>>'{packageWindow,followup,comparison,property}' AS property
     FROM harness_package_followups f JOIN gateway_jobs j ON j.id=f.job_id
     JOIN gateway_generations g ON g.generation_id=j.generation_id AND g.current
     JOIN harness_package_branches b ON b.job_id=f.root_job_id AND b.active
     WHERE j.project_id=$1 AND f.window_id=ANY($2::uuid[]) AND f.plan_key LIKE 'comparison:%'
     ORDER BY j.created_at,j.id`, [projectId, windows.map(({ id }) => id)]);
  const places = new Map(windows.map(({ id, place }) => [id, place]));
  const key = (versionId: string, unitId: string, lineId: string, property: string) =>
    canonicalJson([versionId, unitId, lineId, requirementSubjectKey(property)]);
  const byAddress = new Map<string, Map<PackageFact["branch"], ComparisonRead>>();
  const targetSet = new Set(targetIds);
  const blocked = await blockedComparisonReads(tx, projectId, facts.filter(({ id }) => targetSet.has(id)));
  for (const { windowId, lineId, property, branch, state } of [...blocked, ...rows]) {
    const place = places.get(windowId)!;
    const address = key(place.source.versionId, place.unitId, lineId, property);
    const reads = byAddress.get(address) ?? new Map();
    reads.set(branch, { branch, state });
    byAddress.set(address, reads);
  }
  const byFact = new Map<string, ComparisonRead[]>();
  for (const { id, attribute, observation: { source, address, lineId } } of facts) {
    if (!lineId || !attribute) continue;
    const reads = byAddress.get(key(source.versionId, address.unitId, lineId, attribute));
    if (reads) byFact.set(id, [...reads.values()]);
  }
  return byFact;
}

export function facadeDiscovery(facts: PackageFact[], profiles: PackageAnalysis["facadeProfiles"],
  mentions: PackageAnalysis["facadeMentions"]) {
  const current = new Map(facts.filter((fact) => fact.revisionStatus !== "superseded").map((fact) => [fact.id, fact]));
  // The publication already applies the persisted identity aliases and hides provisional bindings.
  const placed = ({ id, binding }: PackageFact) => current.has(id) && binding.state === "identified" && binding.candidates.length > 0;
  const identity = new Map(profiles.filter(({ identity }) => identity !== "unresolved").map((profile) => [profile.facadeId, {
    ...profile, mentions: profile.mentions.filter(({ factId }) => {
      const fact = current.get(factId);
      return fact && placed(fact) && fact.binding.candidates.some(({ id }) => id === profile.facadeId);
    }),
  }]));
  const unresolved = mentions.filter(({ factId }) => {
    const fact = current.get(factId);
    return fact && fact.binding.state !== "common" && !placed(fact);
  });
  return { placed, identity, unresolved };
}

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
  const versions = await acceptedOriginals(tx, projectId);
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
    `SELECT version_id AS "versionId", target, stage, evidence_id AS "evidenceId", original_basis AS "originalBasis"
     FROM document_stage_confirmations WHERE project_id=$1`, [projectId],
  );
  const stageByAddress = new Map(stages.map((stage) => [canonicalJson([stage.versionId, stage.target]), stage]));
  for (const stage of stages) {
    if (!stage.target || !stage.originalBasis) continue;
    const format = stage.target.locator?.sheet ? 'xlsx' : 'pdf';
    const key = manualPlaceKey(stage.versionId, stage.target, format);
    if (key) stageByAddress.set(key, stage);
  }
  const analysis = await readPackageAnalysis(tx, projectId);
  const accepted = new Map(versions.map((version) => [version.id, version]));
  const links = (await readDocumentFacadeLinks(tx, projectId)).filter(({ basis, versionId }) => accepted.get(versionId)?.sha256 === basis.sha256);
  const linksByVersion = new Map([...Map.groupBy(links, ({ versionId }) => versionId)].map(([versionId, items]) =>
    [versionId, new Map(items.map((item) => [item.targetKey, item]))]));
  const manualFacades = await readManuallyNamedFacades(tx, projectId);
  const windows = analysis.windows.filter(({ place }) => accepted.get(place.source.versionId)?.sha256 === place.source.sha256);
  const formats = new Map(windows.map(({ id, format }) => [id, format]));
  const activeFacts = analysis.facts.filter(({ observation, windowId }) =>
    accepted.get(observation.source.versionId)?.sha256 === observation.source.sha256 && formats.has(windowId));
  const evidenceIds = [...new Set(activeFacts.flatMap(({ observation, basis }) =>
    [observation.evidenceId, ...deliveryEvidenceIds(basis), ...(basis.revisionEvidence ? [basis.revisionEvidence.evidenceId] : []),
      ...Object.values(basis.parts ?? {}).map(({ evidenceId }) => evidenceId)]))];
  const evidenceRows = evidenceIds.length ? (await tx.query<{ id: string; payload: Evidence }>(
    `SELECT id,payload FROM reader_evidence WHERE project_id=$1 AND id=ANY($2::uuid[])`, [projectId, evidenceIds],
  )).rows : [];
  const evidenceById = new Map(evidenceRows.map(({ id, payload }) => [id, payload]));
  const rowIds = activeFacts.filter(({ observation }) => observation.grounding === "text" &&
    observation.lineId && observation.quote).map(({ id }) => id);
  const { rows: statements } = rowIds.length ? await tx.query<IssuedComparisonEvidence>(
    `SELECT o.evidence_id AS "evidenceId", o.run_id AS "runId", issued.content
       FROM (SELECT DISTINCT evidence_id,run_id FROM reader_observations
         WHERE project_id=$1 AND id=ANY($2::uuid[]) AND payload->>'grounding'='text') o
       JOIN LATERAL (
         SELECT event#>>'{reply,body,content}' AS content FROM harness_research_events
         WHERE job_id=o.run_id AND event#>>'{reply,evidence,evidenceId}'=o.evidence_id::text
         ORDER BY sequence LIMIT 1
       ) issued ON true`, [projectId, rowIds],
  ) : { rows: [] };
  const statementsByEvidence = new Map(statements.map(({ evidenceId, runId, content }) =>
    [evidenceId, { runId, lines: deliveredLines(content) }]));
  const originalLines = new Map(activeFacts.flatMap(({ id, observation }) => {
    const statement = statementsByEvidence.get(observation.evidenceId);
    return statement && statement.runId === observation.runId ? [[id, statement.lines] as const] : [];
  }));
  const discovery = facadeDiscovery(activeFacts, analysis.facadeProfiles, analysis.facadeMentions);
  const observations = activeFacts.map((fact) => facadeObservation(
    fact.binding.state === "identified" && !discovery.placed(fact) ? { ...fact, binding: { ...fact.binding, state: "unclear",
      reason: "Адресное упоминание ещё не подтверждает принадлежность фасаду." } } : fact,
    originalLines.get(fact.id)?.find(({ id }) => id === fact.observation.lineId)?.text));
  const factReviews = await readFactReviews(tx, projectId, observations);
  const facts = activeFacts.flatMap((fact) => convertFact(fact, accepted, formats, stageByAddress, evidenceById,
    originalLines.get(fact.id), discovery.placed(fact), linksByVersion.get(fact.observation.source.versionId)) ?? []);
  const coveredWindows = windows.flatMap((window) => {
    const a = completedReaderJob(window, "A");
    const b = completedReaderJob(window, "B");
    return a && b && a !== b ? [[a, b]] : [];
  });
  const mappedVersionIds = [...new Set(windows.map(({ place }) => place.source.versionId))].sort();
  const versionIds = versions.map(({ id }) => id);
  const mapped = new Set(mappedVersionIds);
  const semantic = indexSemanticInput(windows, analysis.semanticChecks, versionIds.filter((id) => !mapped.has(id)));
  const reading = windows.length > 0 && coveredWindows.length === windows.length &&
    canonicalJson(mappedVersionIds) === canonicalJson(versionIds) ?
    { versionIds, basisIds: coveredWindows.flat().sort() } : null;
  const evidence: FacadeReadout = {
    facts,
    facades: [...new Map([
      ...links.map(({ facadeId: id, facadeLabel: label }) => ({ id, label })),
      ...activeFacts.filter(discovery.placed).flatMap(({ binding }) => binding.candidates),
      ...manualFacades,
    ].map((item) => [item.id, item])).values()],
    map: analysis.coverage.physicalProof,
    subject: analysis.coverage.subjectProof,
    pairs: analysis.verifiedPairs,
    reading,
  };
  return { intake, versionIds, versions, evidence, impacts, replacements, holds, semantic, discovery, observations, factReviews, links, linksByVersion,
    comparisonRows: comparisonRows(activeFacts, formats, evidenceById, statements, [...discovery.identity.values()],
      await readCanonicalComparisonRows(tx, projectId, activeFacts, evidenceById)),
    comparisonReads: await comparisonReads(tx, projectId, windows, activeFacts, analysis.comparisonFollowups),
    activeWindows: windows.length,
    structurallyReviewedWindows: windows.filter(({ structure }) => structure?.branches.A.complete && structure.branches.B.complete).length,
    completedWindows: coveredWindows.length };
}
