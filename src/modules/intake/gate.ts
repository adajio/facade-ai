import type { PoolClient } from "pg";
import { lockProjectScopes } from "../access/commands.js";
import { conflict, invalid, notFound } from "./errors.js";

type Hold = {
  id: string;
  receiptId: string;
  source: "upload" | "import";
  sourceId: string;
  generation: number;
  version: number;
  scopeIds: string[] | null;
};

export async function lockIntakeProject(tx: PoolClient, projectId: string): Promise<void> {
  await tx.query("SELECT pg_advisory_xact_lock(hashtextextended('intake/project/' || $1::text, 0))", [projectId]);
}

export async function getIntakeGate(tx: PoolClient, projectId: string, scopeId: string) {
  const snapshot = await tx.query<{ generation: string; project_generation: string }>(
    `SELECT GREATEST(COALESCE(p.unknown_generation, 0), COALESCE(s.generation, 0)) AS generation,
            COALESCE(p.generation, 0) AS project_generation
       FROM project_scopes a
       LEFT JOIN intake_project_generations p ON p.project_id = a.project_id
       LEFT JOIN intake_scope_generations s ON s.scope_id = a.id
      WHERE a.id = $2 AND a.project_id = $1`,
    [projectId, scopeId],
  );
  if (snapshot.rowCount !== 1) notFound();
  const holds = await tx.query<Omit<Hold, "generation"> & { generation: string }>(
    `SELECT id, receipt_id AS "receiptId", source, source_id AS "sourceId", generation, version,
            scope_ids AS "scopeIds"
       FROM intake_holds WHERE project_id = $1 AND closed_at IS NULL
        AND (scope_ids IS NULL OR $2 = ANY(scope_ids)) ORDER BY generation, id`,
    [projectId, scopeId],
  );
  return {
    generation: Number(snapshot.rows[0].generation),
    projectGeneration: Number(snapshot.rows[0].project_generation),
    holds: holds.rows.map((hold) => ({ ...hold, generation: Number(hold.generation) })),
  };
}

export async function appendIntakeEvent(
  tx: PoolClient, projectId: string, receiptId: string, type: string, data: Record<string, unknown>,
): Promise<void> {
  await tx.query("INSERT INTO intake_events (project_id, receipt_id, type, data) VALUES ($1, $2, $3, $4)",
    [projectId, receiptId, type, JSON.stringify(data)]);
}

export async function createHold(
  tx: PoolClient,
  input: { projectId: string; receiptId: string; source: Hold["source"]; sourceId: string; scopeIds?: string[] },
) {
  const { projectId, receiptId, source, sourceId, scopeIds } = input;
  const { rows: [project] } = await tx.query<{ generation: string }>(
    `INSERT INTO intake_project_generations (project_id, generation, unknown_generation)
     VALUES ($1, 1, CASE WHEN $2 THEN 1 ELSE 0 END)
     ON CONFLICT (project_id) DO UPDATE SET generation = intake_project_generations.generation + 1,
       unknown_generation = CASE WHEN $2 THEN intake_project_generations.generation + 1
                                 ELSE intake_project_generations.unknown_generation END
     RETURNING generation`,
    [projectId, !scopeIds],
  );
  if (scopeIds) {
    await tx.query(
      `INSERT INTO intake_scope_generations (project_id, scope_id, generation)
       SELECT $1, unnest($2::uuid[]), $3
       ON CONFLICT (scope_id) DO UPDATE SET generation = EXCLUDED.generation`,
      [projectId, scopeIds, project.generation],
    );
  }
  const { rows: [{ id }] } = await tx.query<{ id: string }>(
    `INSERT INTO intake_holds (project_id, receipt_id, source, source_id, generation, scope_ids)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
    [projectId, receiptId, source, sourceId, project.generation, scopeIds ?? null],
  );
  const hold = { id, receiptId, source, sourceId, generation: Number(project.generation), version: 1, scopeIds: scopeIds ?? null };
  await appendIntakeEvent(tx, projectId, receiptId, "intake.held", hold);
  return hold;
}

export async function resolveIntakeHold(tx: PoolClient, input: {
  projectId: string; holdId: string; generation: number; version: number; scopeIds: string[] | null;
}) {
  const { projectId, holdId, generation, version, scopeIds } = input;
  if (scopeIds?.length === 0) invalid("empty_scope_ids", "Supply scopes to narrow or null to close");
  await lockIntakeProject(tx, projectId);
  await lockProjectScopes(tx, projectId);
  const result = await tx.query<{ scope_ids: string[] | null }>(
    `SELECT scope_ids FROM intake_holds WHERE id = $1 AND project_id = $2
       AND version = $3 AND generation = $4 AND closed_at IS NULL FOR UPDATE`,
    [holdId, projectId, version, generation],
  );
  if (!result.rowCount) throw new IntakeHoldVersionError();
  const previous = result.rows[0].scope_ids;
  if (scopeIds) {
    const scopes = new Set(scopeIds);
    if (scopes.size !== scopeIds.length || (previous && scopeIds.some((id) => !previous.includes(id)))) {
      invalid("hold_scopes_not_narrower", "Scopes must narrow the hold");
    }
    await lockProjectScopes(tx, projectId, scopeIds);
  }
  return await updateHold(tx, { projectId, holdId, scopeIds });
}

class IntakeHoldVersionError extends Error {
  readonly statusCode = 412;
  readonly code = "hold_version_mismatch";
  constructor() {
    super("The hold version or generation has changed");
  }
}

async function updateHold(tx: PoolClient, input: { projectId: string; holdId: string; scopeIds: string[] | null }) {
  const { projectId, holdId, scopeIds } = input;
  const { rows: [hold] } = await tx.query<{ receiptId: string; version: number; generation: string }>(
    `UPDATE intake_holds SET version = version + 1, scope_ids = COALESCE($3::uuid[], scope_ids),
            closed_at = CASE WHEN $3::uuid[] IS NULL THEN now() END
      WHERE id = $1 AND project_id = $2 AND closed_at IS NULL
      RETURNING receipt_id AS "receiptId", version, generation`,
    [holdId, projectId, scopeIds],
  );
  if (!hold) conflict("hold_already_closed", "Intake hold is already closed");
  const data = { holdId, version: hold.version, generation: Number(hold.generation), scopeIds };
  await appendIntakeEvent(tx, projectId, hold.receiptId, scopeIds ? "intake.hold_narrowed" : "intake.hold_closed", data);
  return data;
}

export async function closeEmptyHold(tx: PoolClient, projectId: string, holdId: string | null): Promise<void> {
  if (!holdId) return;
  const { rowCount } = await tx.query(
    "SELECT 1 FROM intake_holds WHERE id = $1 AND project_id = $2 AND closed_at IS NULL FOR UPDATE",
    [holdId, projectId],
  );
  if (rowCount) await updateHold(tx, { projectId, holdId, scopeIds: null });
}
