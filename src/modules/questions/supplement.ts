import type { Pool, PoolClient } from "pg";
import { transaction } from "../access/commands.js";
import { pairProofVersion } from "../assessment/domain.js";
import { publishProjectEvent } from "../supplements/events.js";
import { lockScopes, resolveSupplementImpact } from "../supplements/holds.js";

type ReadyHold = {
  id: string;
  project_id: string;
  generation: string;
  version: number;
  impacts: { scopeId: string; assessmentVersion: number; questionIds: string[] }[];
};

async function readyHold(db: Pool | PoolClient, id?: string): Promise<ReadyHold | undefined> {
  // Each version belongs to the specific upload or import which created the hold.
  // A receipt can contain several other entries with their own causes.
  const { rows } = await db.query<ReadyHold>(
    `WITH eligible AS (
       SELECT h.*
       FROM intake_holds h JOIN intake_receipts r ON r.project_id=h.project_id AND r.id=h.receipt_id
       WHERE h.closed_at IS NULL AND h.scope_ids IS NOT NULL AND r.sealed_at IS NOT NULL
         AND ($1::uuid IS NULL OR h.id=$1)
     ), materials AS (
       SELECT DISTINCT h.id AS hold_id, o.version_id
       FROM eligible h
       LEFT JOIN intake_uploads u ON h.source='upload' AND u.id=h.source_id AND u.hold_id=h.id AND u.state='complete'
       LEFT JOIN intake_imports i ON h.source='import' AND i.id=h.source_id AND i.hold_id=h.id AND i.state='completed'
       JOIN intake_occurrences o ON o.project_id=h.project_id AND o.receipt_id=h.receipt_id
         AND (o.id=u.occurrence_id OR o.import_id=i.id)
       WHERE o.state='accepted' AND NOT o.inventory_pending AND o.restriction IS NULL
         AND (i.id IS NULL OR NOT EXISTS (
           SELECT 1 FROM intake_occurrences pending
           WHERE pending.import_id=i.id AND (pending.inventory_pending OR pending.state='declared' OR pending.restriction IS NOT NULL)
         ))
     ), scoped AS (
       SELECT h.id, scope.id AS scope_id, current_generation.id AS generation_id, latest.version AS assessment_version, latest.catalog_version_id
       FROM eligible h CROSS JOIN LATERAL unnest(h.scope_ids) AS scope(id)
       JOIN intake_project_generations p ON p.project_id=h.project_id
       LEFT JOIN intake_scope_generations s ON s.project_id=h.project_id AND s.scope_id=scope.id
       JOIN harness_generations current_generation ON current_generation.project_id=h.project_id
         AND current_generation.scope_id=scope.id AND current_generation.sealed_at IS NOT NULL
         AND current_generation.input_generation=greatest(p.unknown_generation, coalesce(s.generation,0))
         AND current_generation.input_generation>=h.generation
       JOIN gateway_generations g ON g.generation_id=current_generation.id AND g.current AND g.sealed
       JOIN LATERAL (
         SELECT version, source_token, input_generation, catalog_version_id FROM assessment_revisions
         WHERE scope_id=scope.id ORDER BY version DESC LIMIT 1
       ) latest ON latest.source_token=current_generation.source_token
         AND latest.input_generation=current_generation.input_generation
       WHERE NOT EXISTS (
         SELECT 1 FROM gateway_primary pending WHERE pending.generation_id=g.generation_id AND pending.state='pending'
       )
     ), checked AS (
       SELECT DISTINCT s.id, s.scope_id, s.assessment_version, m.version_id, link.question_id
       FROM scoped s
       JOIN materials m ON m.hold_id=s.id
       JOIN harness_observations link ON link.generation_id=s.generation_id AND link.scope_id=s.scope_id
       JOIN inquiry_observations observed ON observed.id=link.observation_id
         AND observed.version_id=m.version_id AND NOT observed.superseded
       JOIN LATERAL (
         SELECT active, machine, review FROM assessment_question_revisions
         WHERE scope_id=s.scope_id AND question_id=link.question_id
           AND assessment_version<=s.assessment_version
         ORDER BY assessment_version DESC LIMIT 1
       ) assessment ON assessment.active AND assessment.review->'completenessChecked'='true'::jsonb
         AND assessment.machine->>'outcome' IN ('covered','confirmed_conflict','confirmed_missing')
         AND NOT EXISTS (
           SELECT 1 FROM jsonb_array_elements(coalesce(assessment.review->'confirmedPairs','[]'::jsonb)) pair
           WHERE pair->>'proofVersion' IS DISTINCT FROM '${pairProofVersion}'
         )
       WHERE EXISTS (
         SELECT 1 FROM jsonb_array_elements(assessment.review->'findings') f
         WHERE f->>'applicability'='active' AND f#>>'{citation,observationId}'=link.observation_id::text
       )
       AND NOT EXISTS (
         SELECT 1 FROM jsonb_array_elements(assessment.machine->'citations') citation
         WHERE NOT EXISTS (
           SELECT 1 FROM inquiries q JOIN inquiry_search_results result
             ON result.inquiry_id=q.id AND result.search_version=q.search_version
           CROSS JOIN LATERAL jsonb_array_elements(result.candidates) support
           WHERE q.scope_id=s.scope_id AND q.catalog_version_id=s.catalog_version_id AND q.assessment_question_id=link.question_id
             AND support->>'applicability'='verified'
             AND support#>>'{source,observationId}'=citation->>'observationId'
         )
       )
       AND EXISTS (
         SELECT 1 FROM inquiries q JOIN inquiry_search_results result
           ON result.inquiry_id=q.id AND result.search_version=q.search_version
         CROSS JOIN LATERAL jsonb_array_elements(result.candidates) support
         WHERE q.scope_id=s.scope_id AND q.catalog_version_id=s.catalog_version_id AND q.assessment_question_id=link.question_id
           AND support->>'applicability'='verified'
           AND support#>>'{source,observationId}'=link.observation_id::text
       )
     ), impact AS (
       SELECT c.id, c.scope_id, c.assessment_version, array_agg(DISTINCT c.question_id) AS question_ids
       FROM checked c
       GROUP BY c.id,c.scope_id,c.assessment_version
       HAVING count(DISTINCT c.version_id)=(SELECT count(*) FROM materials WHERE hold_id=c.id)
       AND NOT EXISTS (
         SELECT 1 FROM scoped s JOIN materials m ON m.hold_id=s.id
         JOIN harness_observations o ON o.generation_id=s.generation_id
         JOIN inquiry_observations observed ON observed.id=o.observation_id AND NOT observed.superseded
           AND observed.version_id=m.version_id
         JOIN LATERAL (
           SELECT requirement FROM assessment_question_revisions
           WHERE scope_id=s.scope_id AND question_id=o.question_id AND assessment_version<=s.assessment_version
           ORDER BY assessment_version DESC LIMIT 1
         ) required ON true
         WHERE s.id=c.id AND s.scope_id=c.scope_id
           AND (observed.source->>'subjectVerified' IS DISTINCT FROM 'false'
             OR o.finding->>'sourceRole'='approved_change'
             OR (required.requirement->'formats') ? (o.finding->>'format'))
           AND NOT EXISTS (
           SELECT 1 FROM checked affected WHERE affected.id=c.id AND affected.scope_id=c.scope_id
             AND affected.version_id=m.version_id AND affected.question_id=o.question_id
         )
       )
     )
     SELECT h.id,h.project_id,h.generation,h.version,
       jsonb_agg(jsonb_build_object('scopeId',i.scope_id,'assessmentVersion',i.assessment_version,
           'questionIds',i.question_ids) ORDER BY i.scope_id) AS impacts
     FROM eligible h JOIN impact i USING(id)
     GROUP BY h.id,h.project_id,h.generation,h.version
     HAVING count(*)=max(cardinality(h.scope_ids))
     ORDER BY h.generation,h.id LIMIT 1`,
    [id ?? null],
  );
  return rows[0];
}

export async function resolveNextVerifiedSupplement(db: Pool): Promise<boolean> {
  const candidate = await readyHold(db);
  if (!candidate) return false;
  return transaction(db, async (tx) => {
    await lockScopes(tx, candidate.project_id);
    const current = await readyHold(tx, candidate.id);
    if (!current) return false;
    const reason = "verified_supplement";
    await resolveSupplementImpact(tx, {
      projectId: current.project_id, holdId: current.id, generation: Number(current.generation), version: current.version,
      reason, impacts: current.impacts.map(({ scopeId, assessmentVersion }) => ({ scopeId, assessmentVersion, changes: [] })),
    });
    await publishProjectEvent(tx, current.project_id, {
      type: "inquiries.supplement_verified", payload: { holdId: current.id, impacts: current.impacts },
    });
    return true;
  });
}
