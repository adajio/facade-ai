import { createHash } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { transaction } from "../access/commands.js";
import { publishProjectEvent } from "../supplements/events.js";
import { inventoryOpen } from "../intake/receipts.js";
import { lockIntakeProject } from "../intake/gate.js";
import { canonicalJson } from "./domain.js";
import { AssessmentError, invalidInput } from "./store.js";

import { preliminaryChanges, type ReviewRow } from "./preliminary-changes.js";
import { enrichReviewAnalysis, literalSource, renderPreliminaryQuestions, type Original, type RetainedReviewFinding, type ReviewAnalysis,
  type ReviewSourceInput, type ReviewStatus } from "./preliminary-analysis.js";
export type PreliminaryPackageReviewInput = {
  projectId: string; receiptId: string; catalogVersionId: string; model: "gpt-6.1-terra" | "gemini-3.8-flash";
  inventory: Original[];
  preparationId?: string;
  previousReportId?: string;
  revisionKey?: string;
  scopeNote: string;
  rows: { key: string; status: ReviewStatus; finding: string; sources: ReviewSourceInput[];
    analysis?: ReviewAnalysis<ReviewSourceInput>; retained?: RetainedReviewFinding<ReviewSourceInput> }[];
  draftText: string;
  scenarioOne?: { files: Original[]; evidence: unknown[]; coverageComplete: boolean; requests: unknown[] };
};

type InventoryRow = Original & { documentId: string; label: string };
function text(value: unknown, max: number): value is string {
  return typeof value === "string" && value.trim().length > 0 && value.length <= max;
}

/** Trusted producer only: validates the complete original-byte inventory before saving a model draft. */
export async function publishPreliminaryPackageReview(db: Pool, input: PreliminaryPackageReviewInput) {
  const classic = input.model === "gemini-3.8-flash";
  if ((!classic && input.model !== "gpt-6.1-terra") || classic !== Boolean(input.scenarioOne) ||
      (input.scenarioOne && (!Array.isArray(input.scenarioOne.files) || !Array.isArray(input.scenarioOne.evidence) ||
        !Array.isArray(input.scenarioOne.requests) || typeof input.scenarioOne.coverageComplete !== "boolean")) || !text(input.scopeNote, 10000) || !text(input.draftText, 200000) ||
      !Array.isArray(input.rows) || !Array.isArray(input.inventory)) invalidInput("Некорректный предварительный разбор.");
  return transaction(db, async (tx) => {
    await lockIntakeProject(tx, input.projectId);
    const { rows: [project] } = await tx.query<{ catalog_version_id: string; project_stage: string; requirements: { key: string; part: string }[]; generation: string }>(
      `SELECT p.catalog_version_id,p.project_stage,c.requirements,coalesce(g.generation,0) AS generation
       FROM projects p JOIN catalog_versions c ON c.id=p.catalog_version_id AND c.organization_id=p.organization_id
       LEFT JOIN intake_project_generations g ON g.project_id=p.id WHERE p.id=$1 FOR UPDATE OF p`, [input.projectId]);
    if (!project || project.catalog_version_id !== input.catalogVersionId || !project.project_stage) invalidInput("Каталог или стадия проекта изменились.");
    const {rows:[receipt]} = await tx.query<{analysis_scenario: number; analysis_base_review_id: string | null}>(`SELECT analysis_scenario,analysis_base_review_id
      FROM intake_receipts r WHERE r.project_id=$1 AND r.id=$2 AND NOT ${inventoryOpen} FOR SHARE OF r`, [input.projectId, input.receiptId]);
    if (!receipt || receipt.analysis_scenario !== (classic ? 1 : 2)) invalidInput("Поступление не запечатано или недоступно.");
    const { rows: originals } = await tx.query<InventoryRow>(
      `SELECT DISTINCT ON (v.id) v.id AS "versionId",v.document_id AS "documentId",o.sha256 AS "originalSha256",i.relative_path AS label
       FROM intake_occurrences i JOIN intake_document_versions v ON v.id=i.version_id AND v.project_id=i.project_id
       JOIN intake_originals o ON o.id=v.original_id AND o.project_id=v.project_id
       WHERE i.project_id=$1 AND i.receipt_id=$2 AND i.state='accepted'
       ORDER BY v.id,i.relative_path,i.id`, [input.projectId, input.receiptId]);
    const supplied = [...input.inventory].sort((a,b) => a.versionId.localeCompare(b.versionId));
    if (!originals.length || supplied.length !== originals.length || supplied.some((item,i) =>
      item.versionId !== originals[i].versionId || item.originalSha256 !== originals[i].originalSha256)) invalidInput("Опись или хэши оригиналов не совпадают с поступлением.");
    if (Boolean(input.previousReportId) !== Boolean(input.revisionKey) || input.revisionKey && !/^[a-f0-9]{64}$/.test(input.revisionKey)) invalidInput("Некорректная версия разбора.");
    if (input.previousReportId) {
      const replay = await tx.query('SELECT id,previous_report_id FROM preliminary_package_reviews WHERE project_id=$1 AND receipt_id=$2 AND revision_key=$3',
        [input.projectId,input.receiptId,input.revisionKey]);
      if (replay.rowCount) {
        if (replay.rows[0].previous_report_id !== input.previousReportId) invalidInput("Другая исходная версия разбора.");
        return {id:replay.rows[0].id as string};
      }
      const latest = await tx.query(`SELECT id FROM preliminary_package_reviews WHERE project_id=$1 AND receipt_id=$2 AND catalog_version_id=$3 AND stage=$4
        AND inventory=$5::jsonb AND (preparation_id IS NULL OR preparation_id=$6) ORDER BY created_at DESC,id DESC LIMIT 1`,
        [input.projectId,input.receiptId,input.catalogVersionId,project.project_stage,JSON.stringify(supplied),input.preparationId ?? null]);
      if (latest.rows[0]?.id !== input.previousReportId) invalidInput("Предыдущая версия разбора изменилась.");
    }
    const requirements = project.requirements.filter((r) => r && text(r.key, 200) && text(r.part, 1000));
    if (requirements.length !== project.requirements.length || new Set(requirements.map((r) => r.key)).size !== requirements.length ||
      input.rows.length !== requirements.length || new Set(input.rows.map((r) => r.key)).size !== requirements.length) invalidInput("Состав позиций не совпадает с каталогом.");
    const byKey = new Map(input.rows.map((row) => [row.key, row]));
    const byVersion = new Map(originals.map((item) => [item.versionId, item]));
    if (classic && receipt.analysis_base_review_id) {
      const {rows: inherited} = await tx.query<InventoryRow>(`WITH RECURSIVE replaced AS (
          SELECT replaces_version_id AS id FROM intake_document_versions WHERE project_id=$1 AND id=ANY($3::uuid[]) AND replaces_version_id IS NOT NULL
          UNION SELECT v.replaces_version_id FROM intake_document_versions v JOIN replaced x ON x.id=v.id
            WHERE project_id=$1 AND v.replaces_version_id IS NOT NULL
        ) SELECT DISTINCT ON (v.id) v.id AS "versionId",v.document_id AS "documentId",o.sha256 AS "originalSha256",i.relative_path AS label
        FROM preliminary_package_reviews r JOIN intake_scenario_one_results s ON s.review_id=r.id
        CROSS JOIN LATERAL jsonb_array_elements(s.files) f
        JOIN intake_document_versions v ON v.project_id=r.project_id AND v.id=(f->>'versionId')::uuid
        JOIN intake_originals o ON o.project_id=v.project_id AND o.id=v.original_id AND o.sha256=f->>'originalSha256'
        JOIN intake_occurrences i ON i.project_id=v.project_id AND i.version_id=v.id AND i.state='accepted'
        WHERE r.project_id=$1 AND r.id=$2 AND r.catalog_version_id=$4 AND r.stage=$5 AND NOT EXISTS (SELECT 1 FROM replaced x WHERE x.id=v.id)
        ORDER BY v.id,i.relative_path,i.id`,
        [input.projectId,receipt.analysis_base_review_id,originals.map(item=>item.versionId),input.catalogVersionId,project.project_stage]);
      for (const original of inherited) if (!byVersion.has(original.versionId)) byVersion.set(original.versionId,original);
    }
    if (input.scenarioOne?.files.some(file=>byVersion.get(file.versionId)?.originalSha256 !== file.originalSha256))
      invalidInput("Состав исходников для проверки по чек-листу изменился.");
    const rows = requirements.map((requirement) => {
      const row = byKey.get(requirement.key);
      if (!row || !["present", "partial", "not_found", "unassessed"].includes(row.status) || !text(row.finding, 20000) || !Array.isArray(row.sources) || row.sources.length > 100) invalidInput("Некорректная позиция разбора.");
      if ((row.status === "present" || row.status === "partial") && row.sources.length === 0) invalidInput("Для найденной позиции требуется источник.");
      const enrichSource = (source: ReviewSourceInput) => {
        if (!source || typeof source !== "object") invalidInput("Некорректное обоснование.");
        const original = byVersion.get(source.versionId);
        if (!original || original.originalSha256 !== source.originalSha256 || !text(source.anchor, 4000)) invalidInput("Источник не относится к исходным байтам поступления.");
        if (source.quote !== undefined && !text(source.quote,4000) || source.limitation !== undefined && !text(source.limitation,4000)) invalidInput("Некорректное обоснование.");
        return { ...(source.quote ? {quote:source.quote} : {}), ...(source.limitation ? {limitation:source.limitation} : {}), documentId: original.documentId, versionId: original.versionId, label: original.label, anchor: source.anchor, originalSha256: original.originalSha256 };
      };
      const sources = row.sources.map(enrichSource);
      const analysis = row.analysis === undefined ? undefined : enrichReviewAnalysis(row.analysis,enrichSource);
      const onlyLiteral = sources.some(literalSource) &&
        !sources.some(source => source.quote && !source.limitation && !literalSource(source));
      if (onlyLiteral && (!analysis || analysis.applicability.kind === "excluded" ||
          row.status === "present" || row.status === "not_found"))
        invalidInput("Дословная запись не устанавливает выполнение или исключение требования.");
      let retained: RetainedReviewFinding | undefined;
      if (row.retained !== undefined) {
        const earlier = row.retained;
        if (!analysis || !earlier || !["present","partial"].includes(earlier.status) || !text(earlier.finding,20000) ||
            !Array.isArray(earlier.sources) || !earlier.sources.length || earlier.sources.length > 100)
          invalidInput("Некорректный сохранённый вывод.");
        retained = {status:earlier.status,finding:earlier.finding,sources:earlier.sources.map(enrichSource)};
      }
      return { key: requirement.key, title: requirement.part, status: row.status, finding: row.finding, sources,
        ...(analysis && {analysis}), ...(retained && {retained}) };
    });
    const structured = rows.some(row => row.analysis);
    if (structured && !rows.every(row => row.analysis)) invalidInput("Свойства разбора нужны для каждой позиции.");
    const draftText = structured ? renderPreliminaryQuestions(rows) : input.draftText;
    if (!text(draftText,200000)) invalidInput("Некорректный черновик разбора.");
    const inventory = originals.map(({ versionId, originalSha256 }) => ({ versionId, originalSha256 }));
    if (input.preparationId) {
      const current = await tx.query('SELECT 1 FROM intake_package_preparation_current WHERE project_id=$1 AND receipt_id=$2 AND manifest_id=$3',
        [input.projectId,input.receiptId,input.preparationId]);
      if (!current.rowCount) invalidInput("Состав подготовленного поступления изменился.");
    }
    const payload = { ...(input.revisionKey ? {revisionKey:input.revisionKey} : {}), ...(input.preparationId ? {preparationId:input.preparationId} : {}), projectId: input.projectId, receiptId: input.receiptId, catalogVersionId: input.catalogVersionId,
      model: input.model, stage: project.project_stage, inventory, scopeNote: input.scopeNote, rows, draftText,
      ...(input.scenarioOne ? {scenarioOne:input.scenarioOne} : {}) };
    const hash = createHash("sha256").update(canonicalJson(payload)).digest("hex");
    const { rows: [saved] } = await tx.query<{ id: string }>(
      `INSERT INTO preliminary_package_reviews(project_id,receipt_id,catalog_version_id,model,stage,input_generation,inventory,scope_note,rows,draft_text,content_hash,preparation_id,previous_report_id,revision_key)
       VALUES($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9::jsonb,$10,$11,$12,$13,$14)
       ON CONFLICT(project_id,content_hash) DO NOTHING RETURNING id`,
      [input.projectId,input.receiptId,input.catalogVersionId,input.model,project.project_stage,project.generation,JSON.stringify(inventory),input.scopeNote,JSON.stringify(rows),draftText,hash,input.preparationId ?? null,input.previousReportId ?? null,input.revisionKey ?? null]);
    if (saved) {
      if (input.scenarioOne) await tx.query(`INSERT INTO intake_scenario_one_results(review_id,files,evidence,coverage_complete,requests)
        VALUES($1,$2::jsonb,$3::jsonb,$4,$5::jsonb)`,[saved.id,JSON.stringify(input.scenarioOne.files),
        JSON.stringify(input.scenarioOne.evidence),input.scenarioOne.coverageComplete,JSON.stringify(input.scenarioOne.requests)]);
      await publishProjectEvent(tx, input.projectId, { type: "package-analysis.changed", payload: {} });
      return { id: saved.id };
    }
    const existing = await tx.query<{ id: string }>("SELECT id FROM preliminary_package_reviews WHERE project_id=$1 AND content_hash=$2", [input.projectId, hash]);
    return { id: existing.rows[0].id };
  });
}

export async function readPreliminaryPackageReviews(tx: PoolClient, projectId: string, after?: string) {
  const { rows } = await tx.query<{ id: string; receiptId: string; catalogVersionId: string; model: string; createdAt: Date; stage: string; scopeNote: string; rows: ReviewRow[]; draftText: string; isCurrent: boolean; baselineId:string | null; baselineReceiptId:string | null; baselineAt:Date | null; baselineRows:ReviewRow[] | null; baselineDraft:string | null }>(
    `SELECT r.id,r.receipt_id AS "receiptId",r.catalog_version_id AS "catalogVersionId",r.model,r.created_at AS "createdAt",
       CASE WHEN first.id<>r.id THEN first.id ELSE previous.id END AS "baselineId",
       CASE WHEN first.id<>r.id THEN r.receipt_id ELSE previous.receipt_id END AS "baselineReceiptId",
       CASE WHEN first.id<>r.id THEN first.created_at ELSE previous.created_at END AS "baselineAt",
       CASE WHEN first.id<>r.id THEN first.rows ELSE previous.rows END AS "baselineRows",
       CASE WHEN first.id<>r.id THEN first.draft_text ELSE previous.draft_text END AS "baselineDraft",
       r.stage,r.scope_note AS "scopeNote",r.rows,r.draft_text AS "draftText",
       (r.catalog_version_id=p.catalog_version_id AND r.stage=p.project_stage AND r.input_generation=coalesce(g.generation,0)
        AND (r.preparation_id IS NULL OR EXISTS (SELECT 1 FROM intake_package_preparation_current cur
          WHERE cur.project_id=r.project_id AND cur.receipt_id=r.receipt_id AND cur.manifest_id=r.preparation_id))
        AND NOT EXISTS (SELECT 1 FROM intake_receipts later JOIN intake_receipts origin ON origin.id=r.receipt_id
          WHERE later.project_id=r.project_id AND later.number>origin.number)
        AND NOT EXISTS (SELECT 1 FROM preliminary_package_reviews newer WHERE newer.project_id=r.project_id
          AND newer.receipt_id=r.receipt_id AND newer.catalog_version_id=r.catalog_version_id
          AND (newer.created_at,newer.id)>(r.created_at,r.id))) AS "isCurrent"
     FROM preliminary_package_reviews r JOIN projects p ON p.id=r.project_id
     JOIN intake_receipts intake ON intake.project_id=r.project_id AND intake.id=r.receipt_id
     CROSS JOIN LATERAL (SELECT f.id,f.created_at,f.rows,f.draft_text FROM preliminary_package_reviews f
       WHERE f.project_id=r.project_id AND f.receipt_id=r.receipt_id AND f.catalog_version_id=r.catalog_version_id
         AND f.stage=r.stage AND f.inventory=r.inventory AND (f.created_at,f.id)<=(r.created_at,r.id)
       ORDER BY f.created_at,f.id LIMIT 1) first
     LEFT JOIN LATERAL (
       SELECT f.id,f.receipt_id,f.created_at,f.rows,f.draft_text FROM preliminary_package_reviews f
       JOIN intake_receipts earlier ON earlier.project_id=f.project_id AND earlier.id=f.receipt_id
       WHERE first.id=r.id AND f.project_id=r.project_id AND f.catalog_version_id=r.catalog_version_id
         AND f.stage=r.stage AND f.model=r.model AND earlier.number<intake.number AND f.created_at<=r.created_at
         AND (r.model='gpt-6.1-terra' OR f.id=intake.analysis_base_review_id)
       ORDER BY earlier.number DESC,f.created_at DESC,f.id DESC LIMIT 1
     ) previous ON true
     LEFT JOIN intake_project_generations g ON g.project_id=p.id
     WHERE r.project_id=$1 AND ($2::uuid IS NULL OR (r.created_at,r.id) <
       (SELECT created_at,id FROM preliminary_package_reviews WHERE project_id=$1 AND id=$2))
     ORDER BY r.created_at DESC,r.id DESC LIMIT 101`, [projectId, after ?? null]);
  const items = rows.slice(0,100).map(({baselineId,baselineReceiptId,baselineAt,baselineRows,baselineDraft,...item}) => ({
    ...item, changes:preliminaryChanges(item, baselineId && baselineReceiptId && baselineAt && baselineRows && baselineDraft !== null ? {
      id:baselineId,receiptId:baselineReceiptId,createdAt:baselineAt,rows:baselineRows,draftText:baselineDraft,
    } : undefined),
  }));
  return { items, nextCursor: rows.length > 100 ? rows[99].id : null };
}

/** Older runs predate manifests. Once prepared, count only windows actually admitted for this receipt. */
export function admittedReceiptReadingWindow(receiptId: '$2' | 't.receipt_id') {
  return `(NOT EXISTS (SELECT 1 FROM intake_package_preparation_current cur WHERE cur.project_id=w.project_id AND cur.receipt_id=${receiptId})
    OR EXISTS (SELECT 1 FROM intake_package_preparation_current cur JOIN intake_package_preparation_windows pi ON pi.manifest_id=cur.manifest_id
      WHERE cur.project_id=w.project_id AND cur.receipt_id=${receiptId} AND pi.window_id=w.id))`;
}

/** A read-only count of primary A reading for the report's own receipt and model. */
export async function readPreliminaryReadingProgress(tx: PoolClient, projectId: string, id: string) {
  const { rows: [progress] } = await tx.query<{
    totalWindows: number; mappedVersions: number; acceptedVersions: number; completed: number;
    covered: number; partial: number; noMatch: number; refused: number; held: number; reading: number;
  }>(`WITH target AS (
       SELECT receipt_id,project_id,model FROM preliminary_package_reviews WHERE project_id=$1 AND id=$2
     ), accepted AS (
       SELECT DISTINCT o.version_id FROM target t JOIN intake_occurrences o
         ON o.project_id=t.project_id AND o.receipt_id=t.receipt_id
       WHERE o.state='accepted' AND o.version_id IS NOT NULL
     ), maps AS (
       SELECT m.version_id,m.fingerprint FROM accepted a JOIN harness_package_maps m ON m.version_id=a.version_id AND m.active
       JOIN target t ON t.project_id=m.project_id
     ), windows AS (
       SELECT w.id FROM maps m JOIN harness_package_windows w ON w.version_id=m.version_id AND w.map_fingerprint=m.fingerprint
       JOIN target t ON t.project_id=w.project_id WHERE ${admittedReceiptReadingWindow('t.receipt_id')}
     ), jobs AS (
       SELECT w.id,j.state,j.result FROM windows w JOIN harness_package_branches b
         ON b.window_id=w.id AND b.active AND b.branch='A'
       JOIN target t ON b.settings->>'model'=t.model
       JOIN gateway_jobs j ON j.id=b.job_id AND j.project_id=t.project_id AND j.purpose='primary_a'
       JOIN gateway_generations g ON g.generation_id=j.generation_id AND g.current
     )
     SELECT (SELECT count(*)::int FROM windows) AS "totalWindows",
       (SELECT count(DISTINCT version_id)::int FROM maps) AS "mappedVersions",
       (SELECT count(*)::int FROM accepted) AS "acceptedVersions",
       count(DISTINCT id) FILTER (WHERE state='done' AND result->>'kind' IN ('covered','partial','reviewed_no_match','final_refusal'))::int AS completed,
       count(DISTINCT id) FILTER (WHERE state='done' AND result->>'kind'='covered')::int AS covered,
       count(DISTINCT id) FILTER (WHERE state='done' AND result->>'kind'='partial')::int AS partial,
       count(DISTINCT id) FILTER (WHERE state='done' AND result->>'kind'='reviewed_no_match')::int AS "noMatch",
       count(DISTINCT id) FILTER (WHERE state='done' AND result->>'kind'='final_refusal')::int AS refused,
       count(DISTINCT id) FILTER (WHERE state='held')::int AS held,
       count(DISTINCT id) FILTER (WHERE state='leased')::int AS reading
     FROM jobs WHERE EXISTS (SELECT 1 FROM target)
     HAVING EXISTS (SELECT 1 FROM target)`, [projectId,id]);
  if (!progress) throw new AssessmentError(404, "preliminary_review_not_found", "Предварительный разбор недоступен.");
  return progress;
}
