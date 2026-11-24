import type { PoolClient } from "pg";
import { lockScopes } from "../supplements/holds.js";
import { publishProjectEvent, readProjectionPosition } from "../supplements/events.js";
import { names, normalize } from "./domain.js";
import type { Candidate, ObservationPublication, Pair, Subject } from "./domain.js";

export interface InquiryRow {
  id: string;
  project_id: string;
  scope_id: string;
  stage: string;
  slice_id: string | null;
  catalog_version_id: string | null;
  assessment_question_id: string | null;
  generation_id: string | null;
  anchor_id: string | null;
  subject: Subject;
  property_key: string;
  variant_key: string;
  subject_names: string[];
  version: number;
  search_version: number;
  needs_review: boolean;
}

export interface SearchResult {
  state: "empty" | "partial" | "verified";
  candidates: Candidate[];
  pairs: Pair[];
  limitations: string[];
}

export async function enqueue(tx: PoolClient, id: string, searchVersion: number) {
  await tx.query(
    `INSERT INTO inquiry_jobs (inquiry_id, search_version) VALUES ($1, $2)
     ON CONFLICT (inquiry_id) DO UPDATE SET search_version = EXCLUDED.search_version,
       available_at = now(), lease_token = NULL, lease_until = NULL, attempts = 0`,
    [id, searchVersion],
  );
}

export async function createInquiry(
  tx: PoolClient,
  input: Subject & {
    projectId: string; scopeId: string; stage: string; sliceId?: string; catalogVersionId?: string;
    anchorId?: string; assessmentQuestionId?: string; generationId?: string;
  },
): Promise<InquiryRow> {
  const subject = { subject: input.subject, aliases: input.aliases, property: input.property, variant: input.variant };
  const result = await tx.query<InquiryRow>(
    `INSERT INTO inquiries
       (project_id, scope_id, stage, slice_id, catalog_version_id, anchor_id, assessment_question_id, generation_id,
        subject, property_key, variant_key, subject_names)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *`,
    [input.projectId, input.scopeId, input.stage, input.sliceId, input.catalogVersionId, input.anchorId,
      input.assessmentQuestionId, input.generationId, subject, normalize(input.property), normalize(input.variant ?? ""), names(subject)],
  );
  const inquiry = result.rows[0];
  await enqueue(tx, inquiry.id, inquiry.search_version);
  return inquiry;
}

/** Call from the observation publication transaction after taking the shared scope lock. */
export async function onObservationPublished(tx: PoolClient, event: ObservationPublication): Promise<void> {
  await lockScopes(tx, event.projectId, [event.scopeId]);
  const scope = await tx.query<{ catalog_version_id: string }>(
    `SELECT p.catalog_version_id FROM project_scopes s JOIN projects p ON p.id = s.project_id
     WHERE s.id = $1 AND p.id = $2 AND s.stage = $3`,
    [event.scopeId, event.projectId, event.stage],
  );
  if (!scope.rowCount) throw new Error("Observation scope and stage must match the assigned project");
  const propertyKey = normalize(event.property);
  const subjectNames = names(event);
  const variant = normalize(event.variant ?? "");
  const inserted = await tx.query(
    `INSERT INTO inquiry_observations
       (id, project_id, scope_id, stage, version_id, property_key, variant_key, subject_names, source, superseded)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,
       EXISTS (SELECT 1 FROM inquiry_superseded_versions superseded WHERE scope_id = $3 AND stage = $4
         AND (version_id = $5 OR EXISTS (SELECT 1 FROM jsonb_array_elements(coalesce($9::jsonb->'components','[]'::jsonb)) AS c(part)
           WHERE c.part#>>'{source,versionId}'=superseded.version_id::text))))
     ON CONFLICT (id) DO NOTHING RETURNING superseded`,
    [event.observationId, event.projectId, event.scopeId, event.stage, event.versionId, propertyKey, variant, subjectNames, event],
  );
  if (!inserted.rowCount) {
    const same = await tx.query("SELECT 1 FROM inquiry_observations WHERE id = $1 AND source = $2::jsonb",
      [event.observationId, event]);
    if (!same.rowCount) throw new Error("Observation identity was reused with different data");
    return;
  }
  const incomingSuperseded = inserted.rows[0].superseded === true;
  const replaced = [...new Set(event.supersedesVersionIds ?? [])].filter((id) => id !== event.versionId);
  if (incomingSuperseded && !replaced.length) return;
  if (replaced.length) {
    if (event.revision === "superseded") throw new Error("A superseded version cannot establish a replacement");
    await tx.query(
      `INSERT INTO inquiry_superseded_versions (scope_id, stage, version_id)
       SELECT $1, $2, unnest($3::uuid[]) ON CONFLICT DO NOTHING`,
      [event.scopeId, event.stage, replaced],
    );
    await tx.query(
      `UPDATE inquiry_observations SET superseded = true
       WHERE scope_id = $1 AND stage = $2 AND (version_id = ANY($3::uuid[]) OR EXISTS (
         SELECT 1 FROM jsonb_array_elements(coalesce(source->'components','[]'::jsonb)) AS c(part)
         WHERE c.part#>>'{source,versionId}'=ANY($3::uuid[]::text[])))`,
      [event.scopeId, event.stage, replaced],
    );
  }

  const inquiries = await tx.query<InquiryRow & { direct: boolean; replaced: boolean; refresh_anchor: boolean }>(
    `WITH replaced_observations AS (
       SELECT id, property_key, variant_key, subject_names FROM inquiry_observations
       WHERE scope_id = $1 AND stage = $2 AND (version_id = ANY($5::uuid[]) OR EXISTS (
         SELECT 1 FROM jsonb_array_elements(coalesce(source->'components','[]'::jsonb)) AS c(part)
         WHERE c.part#>>'{source,versionId}'=ANY($5::uuid[]::text[])))
     )
     SELECT i.*,
       (NOT $8 AND i.property_key = $3 AND i.variant_key = $6 AND i.subject_names && $4::text[]) AS direct,
       impact.replaced,
       (a.superseded OR a.source->>'revision' <> 'effective' OR a.source->>'readable' = 'false'
          OR a.source->>'role' IN ('reference','unknown')) AS refresh_anchor
     FROM inquiries i LEFT JOIN inquiry_observations a ON a.id = i.anchor_id
     CROSS JOIN LATERAL (
       SELECT EXISTS (
         SELECT 1 FROM replaced_observations old
         WHERE old.property_key = i.property_key AND old.variant_key = i.variant_key AND (
           old.id = i.anchor_id OR old.subject_names && i.subject_names OR EXISTS (
             SELECT 1 FROM inquiry_search_results r
             CROSS JOIN LATERAL jsonb_array_elements(r.candidates) candidate
             WHERE r.inquiry_id = i.id AND r.search_version = i.search_version
               AND candidate->>'applicability' = 'verified'
               AND candidate#>>'{source,observationId}' = old.id::text
           ))
       ) AS replaced
     ) impact
     WHERE i.scope_id = $1 AND i.stage = $2 AND i.catalog_version_id = $7 AND (
       (NOT $8 AND i.property_key = $3 AND i.variant_key = $6) OR impact.replaced)
     ORDER BY i.id FOR UPDATE OF i`,
    [event.scopeId, event.stage, propertyKey, subjectNames, replaced, variant, scope.rows[0].catalog_version_id, incomingSuperseded],
  );

  let existingMachineInquiry = false;
  for (const inquiry of inquiries.rows) {
    const direct = inquiry.direct;
    if (direct && inquiry.anchor_id) existingMachineInquiry = true;
    const newAnchor = direct && inquiry.refresh_anchor && event.readable &&
      event.revision === "effective" && event.role !== "unknown" && event.role !== "reference"
      ? event.observationId : null;
    const updated = await tx.query<{ search_version: number }>(
      `UPDATE inquiries SET version = version + 1, search_version = search_version + 1,
         anchor_id = coalesce($2, anchor_id),
         assessment_question_id = coalesce(assessment_question_id, $3),
         generation_id = coalesce($5, generation_id),
         needs_review = needs_review OR ($4 AND EXISTS (SELECT 1 FROM inquiry_decisions WHERE inquiry_id = $1))
       WHERE id = $1 RETURNING search_version`,
      [inquiry.id, newAnchor, direct ? event.assessmentQuestionId : null, direct || inquiry.replaced, direct ? event.generationId : null],
    );
    await enqueue(tx, inquiry.id, updated.rows[0].search_version);
  }

  const changed = inquiries.rows.map(({ id }) => id);
  if (!existingMachineInquiry && !incomingSuperseded) {
    const { sliceId } = await readProjectionPosition(tx, event.projectId);
    const created = await createInquiry(tx, {
      ...event, anchorId: event.observationId, sliceId, catalogVersionId: scope.rows[0].catalog_version_id,
    });
    changed.push(created.id);
  }
  if (!changed.length) return;
  await publishProjectEvent(tx, event.projectId, {
    type: "inquiries.changed", payload: { scopeId: event.scopeId, inquiryIds: changed },
  });
}

export async function getCurrentInquiryPairs(tx: PoolClient, projectId: string, scopeId: string): Promise<Pair[]> {
  const result = await tx.query<{ pairs: Pair[] }>(
    `SELECT r.pairs FROM inquiry_search_results r JOIN inquiries i
       ON i.id = r.inquiry_id AND i.search_version = r.search_version
     JOIN projects p ON p.id = i.project_id AND p.catalog_version_id = i.catalog_version_id
     WHERE i.project_id = $1 AND i.scope_id = $2
     ORDER BY i.id`,
    [projectId, scopeId],
  );
  const found = new Map<string, Pair>();
  for (const pair of result.rows.flatMap(({ pairs }) => pairs)) {
    found.set([pair.left.observationId, pair.right.observationId].sort().join("/"), pair);
  }
  return [...found.values()];
}


/** Refresh only search cards that have the named assessment dependency. */
export async function refreshAssessmentInquiries(
  tx: PoolClient, projectId: string, scopeId: string, questionId: string, catalogVersionId: string,
  anchor?: string,
) {
  const { rows } = await tx.query<{ id: string; search_version: number }>(
    `UPDATE inquiries SET version=version+1, search_version=search_version+1,
       needs_review=needs_review OR EXISTS (SELECT 1 FROM inquiry_decisions d WHERE d.inquiry_id=inquiries.id),
       anchor_id=CASE WHEN anchor_id IS NULL THEN NULL ELSE coalesce($5::uuid,anchor_id) END
     WHERE project_id=$1 AND scope_id=$2 AND assessment_question_id=$3 AND catalog_version_id=$4
     RETURNING id,search_version`,
    [projectId, scopeId, questionId, catalogVersionId, anchor ?? null],
  );
  for (const { id, search_version } of rows) await enqueue(tx, id, search_version);
  return rows.map(({ id }) => id);
}
