import type { Pool, PoolClient } from "pg";
import type { ReaderLine } from "../pdf/types.js";

export async function readAttributeAliases(db: Pool | PoolClient, questionId: string): Promise<string[]> {
  const { rows } = await db.query<{ alias: string }>(
    `SELECT a.alias FROM inquiry_attribute_aliases a
     JOIN assessment_questions q ON q.id=a.question_id
     JOIN project_scopes s ON s.id=q.scope_id AND s.version=a.scope_version
     JOIN projects p ON p.id=s.project_id AND p.catalog_version_id=a.catalog_version_id
     WHERE a.question_id=$1 ORDER BY a.alias_key`, [questionId],
  );
  return rows.map(({ alias }) => alias);
}

export function deliveredLines(content: string | null): ReaderLine[] {
  if (!content) return [];
  try {
    const parsed = JSON.parse(content) as { lines?: ReaderLine[] } | null;
    return Array.isArray(parsed?.lines) ? parsed.lines.filter((line) => typeof line?.text === "string") : [];
  } catch {
    return [];
  }
}
