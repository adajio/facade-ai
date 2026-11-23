import type { PoolClient } from "pg";
import { ReaderError, type Evidence, type ReaderLine } from "../pdf/types.js";
import type { Citation, DocumentRevision } from "./domain.js";

export type DocumentRevisionReader = (
  tx: PoolClient, projectId: string, stage: string, citation: Citation,
) => Promise<DocumentRevision | undefined>;

const maxHeaderEvidenceBytes = 8 * 1024 * 1024;
const explicitRevision = /(?:^|[.·;|]\s*)(?:(?:current|effective|действующая|актуальная)\s+)?(?:редакция|ред\.?|revision|rev\.?)\s*[:№]?\s*([\p{L}\d][\p{L}\d_-]{0,23})(?=$|[\s.·;,|])/iu;
const revisionCode = /^(?:\p{L}{0,4}\d[\p{L}\d_-]{0,22}|[A-ZА-ЯЁ])$/u;

function headerRevision(format: string, stage: string, line: ReaderLine): string | undefined {
  const { locator, box } = line;
  const text = line.text.trim().normalize("NFC");
  if (format === "txt") {
    if (locator?.line !== 1) return;
    const [title, headerStage, code, ...rest] = text.split("·").map((part) => part.trim());
    if (title && headerStage && code && !rest.length &&
        headerStage.toUpperCase() === stage.trim().toUpperCase() && revisionCode.test(code)) return code;
  }
  if ((format === "doc" || format === "docx") &&
      (typeof locator?.paragraph !== "number" || locator.paragraph < 1 || locator.paragraph > 3)) return;
  if (format === "pdf" && (!box || box.y < 0 || box.y > 100)) return;
  const label = explicitRevision.exec(text)?.[1];
  return label && revisionCode.test(label) ? label : undefined;
}

function headerAddress(evidence: Evidence, line: ReaderLine): DocumentRevision["address"] {
  return {
    unitId: evidence.address.unitId,
    ...(line.box ? { box: line.box } : {}),
    locator: { ...evidence.address.locator, ...line.locator },
  };
}

export function createDocumentRevisionReader(
  reader: { content(evidence: Evidence): Promise<Buffer> },
): DocumentRevisionReader {
  return async (tx, projectId, stage, citation) => {
    const component = citation.components?.find((part) => part.role === "revision" &&
      part.source.projectId === projectId && part.source.documentId === citation.documentId &&
      part.source.versionId === citation.versionId && part.source.sha256 === citation.sha256);
    // The printed revision belongs to the same original as this citation.
    const locator = citation.address.locator as Record<string, unknown> | undefined;
    const page = locator?.page ?? citation.address.page ?? citation.address.unitId;
    const { rows } = await tx.query<{ evidence: Evidence }>(
      `SELECT DISTINCT ON (e.payload->>'sha256') e.payload AS evidence
       FROM reader_evidence e
       JOIN reader_maps m ON m.project_id = e.project_id
         AND m.version_id = e.version_id AND m.reader_version = e.reader_version
       WHERE e.project_id = $1 AND e.version_id = $2 AND m.original_sha256 = $3 AND m.document_id = $4
         AND e.payload#>>'{source,sha256}' = $3
         AND e.payload->>'representation' = 'native' AND e.payload->>'mediaType' = 'application/json'
         AND (e.payload->>'size')::bigint BETWEEN 1 AND 1048576
         AND (
           e.id = $6::uuid OR
           (m.format = 'pdf' AND e.payload#>>'{address,locator,page}' = $5 AND e.payload#>>'{address,box}' IS NULL)
           OR (m.format IN ('doc', 'docx') AND e.payload#>>'{address,locator,firstParagraph}' = '1')
           OR (m.format = 'txt' AND e.payload#>>'{address,locator,firstLine}' = '1')
         )
       ORDER BY e.payload->>'sha256', e.created_at, e.id`,
      [projectId, citation.versionId, citation.sha256, citation.documentId, page == null ? null : String(page),
        component?.evidenceId ?? null],
    );
    // Conversion metadata can give identical headers different artifact hashes across reads.
    const totalBytes = rows.reduce((sum, { evidence }) => sum + evidence.size, 0);
    if (totalBytes > maxHeaderEvidenceBytes) return undefined;

    const revisions = new Map<string, DocumentRevision>();
    for (const { evidence } of rows) {
      let bytes: Buffer;
      try {
        bytes = await reader.content(evidence);
      } catch (error) {
        if (error instanceof ReaderError && error.statusCode === 424) return undefined;
        throw error;
      }
      const { lines } = JSON.parse(bytes.toString("utf8")) as { lines: ReaderLine[] };
      for (const line of lines) {
        const label = headerRevision(evidence.format, stage, line);
        if (label && (!citation.verifiedRevision || label.toLowerCase() === citation.verifiedRevision.toLowerCase()) &&
            !revisions.has(label)) {
          revisions.set(label, {
            label, quote: line.text, address: headerAddress(evidence, line), evidenceId: evidence.id,
          });
        }
      }
    }
    return revisions.size === 1 ? revisions.values().next().value : undefined;
  };
}
