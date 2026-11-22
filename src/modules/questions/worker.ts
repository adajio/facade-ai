import { randomUUID } from "node:crypto";
import { canonicalJson } from "../assessment/domain.js";
import type { Pool, PoolClient } from "pg";
import { lockScopes } from "../supplements/holds.js";
import { publishProjectEvent } from "../supplements/events.js";
import { checkLocalApplicability, compareMeasurements, makePair, matchReason } from "./domain.js";
import type { Candidate, ObservationPublication, Pair, QuestionSearchPorts } from "./domain.js";
import { transaction } from "../access/commands.js";
import type { InquiryRow, SearchResult } from "./store.js";
import { resolveNextVerifiedSupplement } from "./supplement.js";
import { refreshCompletedSemanticReview, scheduleSemanticReview } from "./semantic-review.js";

const searchLimit = 24;
const maxAttempts = 3;
const leaseSeconds = 120;

interface Job extends InquiryRow {
  attempts: number;
  token: string;
}

async function claim(db: Pool): Promise<Job | undefined> {
  const token = randomUUID();
  const result = await db.query<Job>(
    `WITH next AS (
       SELECT inquiry_id FROM inquiry_jobs
       WHERE available_at <= now() AND (lease_until IS NULL OR lease_until <= now())
       ORDER BY available_at, inquiry_id LIMIT 1 FOR UPDATE SKIP LOCKED
     ), claimed AS (
       UPDATE inquiry_jobs j SET lease_token = $1, lease_until = now() + $2 * interval '1 second',
         attempts = attempts + 1
       FROM next WHERE j.inquiry_id = next.inquiry_id
       RETURNING j.inquiry_id, j.search_version, j.attempts
     )
     SELECT i.*, c.attempts, $1::uuid AS token FROM claimed c JOIN inquiries i ON i.id = c.inquiry_id
     WHERE i.search_version = c.search_version`,
    [token, leaseSeconds],
  );
  return result.rows[0];
}

async function search(db: Pool, job: Job, ports: QuestionSearchPorts, signal: AbortSignal): Promise<SearchResult> {
  const found = await db.query<{ source: ObservationPublication; superseded: boolean }>(
    `SELECT o.source, (o.superseded OR EXISTS (
       SELECT 1 FROM inquiry_replaced_places x
       WHERE x.question_id=$9 AND x.catalog_version_id=$10 AND x.scope_version=s.version
         AND o.source->>'assessmentQuestionId'=x.question_id::text
         AND x.version_id=o.version_id AND x.address=o.source->'address'
     )) AS superseded
     FROM inquiry_observations o JOIN project_scopes s ON s.id=o.scope_id
     WHERE o.project_id = $1 AND o.scope_id = $2 AND o.stage = $3 AND o.property_key = $4
     ORDER BY (o.id = $5) DESC NULLS LAST, (o.variant_key = $6 AND o.subject_names && $7::text[]) DESC,
       (o.variant_key = $6) DESC, (NOT o.superseded AND o.source->>'revision' = 'effective') DESC, o.id
     LIMIT $8`,
    [job.project_id, job.scope_id, job.stage, job.property_key, job.anchor_id,
      job.variant_key, job.subject_names, searchLimit + 1, job.assessment_question_id, job.catalog_version_id],
  );

  const candidates: Candidate[] = [];
  for (const { source: stored, superseded } of found.rows.slice(0, searchLimit)) {
    signal.throwIfAborted();
    const source = superseded ? { ...stored, revision: "superseded" as const } : stored;
    const reason = matchReason(job.subject, source);
    let applicability = checkLocalApplicability(job.subject, source);
    if (!applicability) {
      const opened = await ports.openSupport(source, signal);
      if (!opened || opened.observationId !== source.observationId || opened.versionId !== source.versionId ||
        opened.sha256 !== source.sha256) {
        applicability = "address_unavailable";
      } else {
        const meaning = await ports.checkMeaning(job.subject, source, opened, signal, {
          inquiryId: job.id, assessmentQuestionId: job.assessment_question_id, scopeId: job.scope_id, projectId: job.project_id,
          searchVersion: job.search_version, generationId: job.generation_id,
        });
        applicability = meaning === "same" ? "verified" : meaning === "different" ? "meaning_different" : "meaning_unclear";
      }
    }
    candidates.push({ source, reason: source.subjectVerified === false && applicability === "verified" ? "registered_alias" : reason, applicability });
  }

  let pairs: Pair[] = [];
  const verified = candidates.filter((candidate) => candidate.applicability === "verified");
  const anchor = verified.find(({ source }) => source.observationId === job.anchor_id);
  if (job.anchor_id) {
    if (anchor) {
      for (const right of verified) {
        const pair = makePair(anchor, right);
        if (pair) pairs.push(pair);
      }
    }
  } else {
    for (const [index, left] of verified.entries()) {
      for (const right of verified.slice(index + 1)) {
        const pair = makePair(left, right);
        if (pair) pairs.push(pair);
      }
    }
  }

  const limitations = [...new Set(candidates
    .filter(({ applicability }) => !["verified", "meaning_different", "variant_mismatch", "revision_superseded", "reference_only"]
      .includes(applicability))
    .map(({ applicability }) => applicability))] as string[];
  const atOnePlace = new Map<string, ObservationPublication>();
  const ambiguousOriginals = new Set<string>();
  for (const { source } of verified) {
    const key = `${source.sha256}/${canonicalJson(source.address)}`;
    const first = atOnePlace.get(key);
    if (first?.measurement && source.measurement &&
      compareMeasurements(first.measurement, source.measurement) !== "agreement") {
      ambiguousOriginals.add(source.originalId);
      ambiguousOriginals.add(first.originalId);
    }
    if (!first) atOnePlace.set(key, source);
  }
  if (ambiguousOriginals.size) {
    pairs = pairs.filter(({ left, right }) => !ambiguousOriginals.has(left.originalId) && !ambiguousOriginals.has(right.originalId));
    limitations.push("readers_disagree_at_same_place");
  }
  if (verified.some(({ source }) => source.measurement && (!source.priority || !source.comparableContext))) {
    limitations.push("comparison_context_unknown");
  }
  if (found.rows.length > searchLimit) limitations.push("candidate_limit");
  if (job.anchor_id && !pairs.length) limitations.push("no_comparable_pair");
  const state = limitations.length ? "partial" : verified.length ? "verified" : "empty";
  return { candidates, pairs, limitations, state };
}

async function release(tx: PoolClient, job: Job) {
  await tx.query(
    `UPDATE inquiry_jobs SET lease_token = NULL, lease_until = NULL, available_at = now() + interval '2 seconds'
     WHERE inquiry_id = $1 AND search_version = $2 AND lease_token = $3`,
    [job.id, job.search_version, job.token],
  );
}

async function complete(db: Pool, job: Job, result: SearchResult) {
  await transaction(db, async (tx) => {
    await lockScopes(tx, job.project_id, [job.scope_id]);
    const current = await tx.query(
      `SELECT 1 FROM inquiries i JOIN inquiry_jobs j ON j.inquiry_id = i.id AND j.search_version = i.search_version
       WHERE i.id = $1 AND j.search_version = $2 AND j.lease_token = $3 AND j.lease_until > now()
       FOR UPDATE OF i, j`,
      [job.id, job.search_version, job.token],
    );
    if (!current.rowCount) return;
    await tx.query(
      `INSERT INTO inquiry_search_results (inquiry_id, search_version, state, limitations, candidates, pairs)
       VALUES ($1,$2,$3,$4,$5::jsonb,$6::jsonb)`,
      [job.id, job.search_version, result.state, result.limitations,
        JSON.stringify(result.candidates), JSON.stringify(result.pairs)],
    );
    const prior = await tx.query<{ candidate_ids: string[]; candidates: Candidate[] }>(
      `SELECT d.candidate_ids, r.candidates FROM inquiry_decisions d JOIN inquiry_search_results r
         ON r.inquiry_id = d.inquiry_id AND r.search_version = d.search_version
       WHERE d.inquiry_id = $1 ORDER BY d.version DESC LIMIT 1`,
      [job.id],
    );
    const currentIds = new Set(result.candidates.filter(({ applicability }) => applicability === "verified")
      .map(({ source }) => source.observationId));
    const previous = prior.rows[0];
    const previousIds = new Set(previous?.candidates.filter(({ applicability }) => applicability === "verified")
      .map(({ source }) => source.observationId));
    const needsReview = previous !== undefined && (
      previous.candidate_ids.some((id) => !currentIds.has(id)) ||
      [...currentIds].some((id) => !previousIds.has(id))
    );
    await tx.query("UPDATE inquiries SET version = version + 1, needs_review = needs_review OR $2 WHERE id = $1",
      [job.id, needsReview]);
    await scheduleSemanticReview(db, tx, job, result);
    await tx.query("DELETE FROM inquiry_jobs WHERE inquiry_id = $1", [job.id]);
    await publishProjectEvent(tx, job.project_id, {
      type: "inquiries.changed", payload: { scopeId: job.scope_id, inquiryIds: [job.id] },
    });
  });
}

export async function processNextInquiry(db: Pool, ports: QuestionSearchPorts, signal: AbortSignal): Promise<boolean> {
  if (signal.aborted) return false;
  const job = await claim(db);
  if (!job) return await refreshCompletedSemanticReview(db) || await resolveNextVerifiedSupplement(db);
  if (job.attempts > maxAttempts) {
    await complete(db, job, { state: "partial", limitations: ["search_interrupted"], candidates: [], pairs: [] });
    return true;
  }
  let result: SearchResult;
  try {
    result = await search(db, job, ports, AbortSignal.any([signal, AbortSignal.timeout(90_000)]));
    signal.throwIfAborted();
  } catch {
    if (signal.aborted || job.attempts < maxAttempts) {
      await transaction(db, (tx) => release(tx, job));
      return true;
    }
    result = { state: "partial", limitations: ["search_interrupted"], candidates: [], pairs: [] };
  }
  try {
    await complete(db, job, result);
  } catch (error) {
    await transaction(db, (tx) => release(tx, job));
    throw error;
  }
  return true;
}
