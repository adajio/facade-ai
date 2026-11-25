import { createHash } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { canonicalJson } from "../assessment/domain.js";
import type { IntakeStorage } from "../intake/blob.js";
import type { createRuntimePdfService } from "../pdf/index.js";
import { ReaderError } from "../pdf/types.js";
import type { Observation } from "../pdf/types.js";
import { escapeRegex, matchReason, normalize } from "./domain.js";
import type { ObservationPublication, OpenSupport, PackageSupport, QuestionSearchPorts } from "./domain.js";
import { onObservationPublished } from "./store.js";
import { hasVerifiedMeaning } from "./semantic-review.js";
import { deliveredLines, readAttributeAliases } from "./attribute-aliases.js";
import { hasAddressedSubject } from "./subject-evidence.js";

type Reader = Pick<ReturnType<typeof createRuntimePdfService>, "findObservation" | "findEvidence" | "content">;

type Anchoring = Pick<ObservationPublication, "subject" | "aliases" | "property" | "variant" | "role" |
  "revision" | "priority" | "comparableContext" | "assessmentQuestionId" | "generationId" | "subjectVerified">;

type ReaderOriginal = {
  original_id: string;
  replaces_version_id: string | null;
  object_key: string;
  sha256: string;
  size: string;
};

async function original(db: Pool | PoolClient, source: Observation["source"]): Promise<ReaderOriginal | undefined> {
  const { rows } = await db.query<ReaderOriginal>(
    `SELECT v.original_id, v.replaces_version_id, o.object_key, o.sha256, o.size
     FROM intake_document_versions v JOIN intake_originals o ON o.project_id = v.project_id AND o.id = v.original_id
     WHERE v.project_id = $1 AND v.document_id = $2 AND v.id = $3`,
    [source.projectId, source.documentId, source.versionId],
  );
  return rows[0];
}

/** Use the assigned scope, taxonomy and confirmed revision classification from the publisher. */
export async function publishReaderObservation(tx: PoolClient, input: Anchoring & {
  observation: Observation;
  projectId: string;
  scopeId: string;
  readerJobId: string;
  replacesConfirmed?: boolean;
}): Promise<void> {
  const {
    observation, projectId, scopeId, readerJobId, replacesConfirmed, ...assignment
  } = input;
  if (projectId !== observation.source.projectId || scopeId !== observation.scope) {
    throw new Error("Reader observation does not belong to the publication assignment");
  }
  const file = await original(tx, observation.source);
  const { rows: [metadata] } = await tx.query<{ stage: string; format: string }>(
    `SELECT s.stage, m.format FROM project_scopes s
     JOIN reader_observations o ON o.project_id = s.project_id AND o.id = $3 AND o.version_id = $4
     JOIN reader_maps m ON m.project_id = o.project_id AND m.version_id = o.version_id AND m.reader_version = $5
     WHERE s.project_id = $1 AND s.id = $2`,
    [projectId, scopeId, observation.id, observation.source.versionId, observation.readerVersion],
  );
  if (!file || file.sha256 !== observation.source.sha256 || !metadata) {
    throw new Error("Reader observation is missing its assigned, verified original");
  }
  await onObservationPublished(tx, {
    ...assignment,
    ...observation.source,
    observationId: observation.id, scopeId, stage: metadata.stage, readerJobId,
    receiptId: observation.receiptId, originalId: file.original_id, evidenceId: observation.evidenceId,
    address: { ...observation.address }, branch: observation.branch, format: metadata.format, quote: observation.quote,
    readable: observation.grounding !== "limited" && !observation.limitation,
    measurement: observation.value !== undefined && observation.unit !== undefined
      ? { value: observation.value, unit: observation.unit } : undefined,
    ...(observation.components?.length ? { components: observation.components } : {}),
    supersedesVersionIds: replacesConfirmed && file.replaces_version_id ? [file.replaces_version_id] : undefined,
  });
}

function hasName(line: string, name: string): boolean {
  const token = escapeRegex(normalize(name));
  return new RegExp(`(?:^|[^\\p{L}\\p{N}])${token}(?=$|[^\\p{L}\\p{N}])`, "u").test(normalize(line));
}

export function createReaderSupportOpener(
  db: Pool, reader: Reader, objects: IntakeStorage["objects"],
  tx?: PoolClient,
): (source: PackageSupport, signal: AbortSignal) => Promise<OpenSupport | null> {
  return async (source, signal) => {
      const pin = tx
        ? (await tx.query<{ payload: Observation }>(
          "SELECT payload FROM reader_observations WHERE project_id=$1 AND id=$2",
          [source.projectId, source.observationId],
        )).rows[0]?.payload
        : await reader.findObservation(source.projectId, source.observationId);
      if (!pin || pin.scope !== source.scopeId || pin.receiptId !== source.receiptId ||
        pin.evidenceId !== source.evidenceId || pin.source.documentId !== source.documentId ||
        pin.source.versionId !== source.versionId || pin.source.sha256 !== source.sha256 ||
        pin.quote !== source.quote || (source.measurement && (pin.value !== source.measurement.value ||
          pin.unit !== source.measurement.unit)) ||
        canonicalJson(pin.components) !== canonicalJson(source.components) ||
        canonicalJson(pin.address) !== canonicalJson(source.address)) return null;
      const evidence = await reader.findEvidence(source.projectId, source.evidenceId, tx);
      if (!evidence || evidence.source.versionId !== source.versionId || evidence.source.sha256 !== source.sha256) return null;
      const file = await original(tx ?? db, pin.source);
      if (!file || file.original_id !== source.originalId || file.sha256 !== source.sha256) return null;
      try {
        const intact = async (original: ReaderOriginal) => {
          const content = await objects.get(original.object_key);
          const hash = createHash("sha256");
          let length = 0;
          for await (const bytes of content) {
            signal.throwIfAborted();
            length += bytes.length;
            if (length > Number(original.size)) return false;
            hash.update(bytes);
          }
          return length === Number(original.size) && hash.digest("hex") === original.sha256;
        };
        if (!await intact(file)) return null;
        const originals = new Set([pin.source.versionId]);
        const seen = new Set([evidence.id]);
        for (const part of pin.components ?? []) {
          if (part.source.projectId !== source.projectId) return null;
          if (!originals.has(part.source.versionId)) {
            const owner = await original(tx ?? db, part.source);
            if (!owner || owner.sha256 !== part.source.sha256 || !await intact(owner)) return null;
            originals.add(part.source.versionId);
          }
          if (seen.has(part.evidenceId)) continue;
          const issued = await reader.findEvidence(source.projectId, part.evidenceId, tx);
          if (!issued || issued.branch !== pin.branch || canonicalJson(issued.source) !== canonicalJson(part.source)) return null;
          await reader.content(issued);
          seen.add(part.evidenceId);
        }
        const bytes = await reader.content(evidence);
        return {
          observationId: pin.id, versionId: source.versionId, sha256: source.sha256,
          lineId: pin.lineId, grounding: pin.grounding,
          content: evidence.mediaType.startsWith("image/")
            ? { kind: "image", bytes, mediaType: evidence.mediaType }
            : { kind: "text", text: bytes.toString("utf8") },
        };
      } catch (error) {
        if ((error instanceof ReaderError && error.statusCode < 500) ||
          (error as { $metadata?: { httpStatusCode?: number } })?.$metadata?.httpStatusCode === 404) return null;
        throw error;
      }
  };
}

export function createRuntimeInquiryPorts(
  db: Pool, reader: Reader, objects: IntakeStorage["objects"],
  checkMeaning?: QuestionSearchPorts["checkMeaning"],
  tx?: PoolClient,
): QuestionSearchPorts {
  const openSupport = createReaderSupportOpener(db, reader, objects, tx);
  return {
    openSupport, openPackageSupport: openSupport,
    async checkMeaning(question, candidate, support, signal, context) {
      if (candidate.components?.length) {
        if (support.content.kind !== "text" || !candidate.measurement || candidate.components.some((part) => !part.binding)) return "unclear";
        const { rows: [scope] } = await (tx ?? db).query<{ name: string }>(
          "SELECT name FROM project_scopes WHERE project_id=$1 AND id=$2", [context.projectId, context.scopeId]);
        if (!scope) return "unclear";
        const aliases = candidate.assessmentQuestionId && candidate.assessmentQuestionId === context.assessmentQuestionId
          ? await readAttributeAliases(tx ?? db, candidate.assessmentQuestionId) : [];
        const supported = hasAddressedSubject({ ...question, scopeName: scope.name, aliases: [...question.aliases ?? [], ...aliases] }, {
          ...candidate.measurement, quote: candidate.quote, lineId: support.lineId,
          grounding: support.grounding ?? "limited", components: candidate.components,
        }, deliveredLines(support.content.text));
        return supported ? "same" : "unclear";
      }
      if (candidate.subjectVerified === false) {
        if (!candidate.assessmentQuestionId || candidate.assessmentQuestionId !== context.assessmentQuestionId ||
          support.content.kind !== "text" ||
          matchReason(question, candidate) === "same_property") return "unclear";
        const aliases = await readAttributeAliases(db, candidate.assessmentQuestionId);
        if (!aliases.length) return "unclear";
        return hasAddressedSubject({ subject: "", property: "", aliases }, {
          quote: candidate.quote, value: candidate.measurement?.value, unit: candidate.measurement?.unit,
          lineId: support.lineId, grounding: support.grounding ?? "limited",
        }, deliveredLines(support.content.text)) ? "same" : "unclear";
      }
      if (support.content.kind === "text" && candidate.quote &&
        matchReason(question, candidate) !== "same_property") {
        const text = support.content.text;
        const decoded: unknown = text.startsWith("{") ? JSON.parse(text) : text;
        const rows = typeof decoded === "string" ? [decoded] : (decoded as { lines?: { text: string }[] }).lines
          ?.map(({ text: line }) => line) ?? [];
        if (rows.some((line) => line.includes(candidate.quote!) &&
          [candidate.subject, ...candidate.aliases ?? []].some((name) => hasName(candidate.quote!, name)))) {
          return "same";
        }
      }
      if (await hasVerifiedMeaning(db, context, candidate)) return "same";
      return checkMeaning?.(question, candidate, support, signal, context) ?? "unclear";
    },
  };
}
