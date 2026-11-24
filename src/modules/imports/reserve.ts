import type { PoolClient } from "pg";

export async function importScratchUnwrittenBytes(tx: PoolClient): Promise<bigint> {
  const { rows: [{ bytes }] } = await tx.query<{ bytes: string }>(
    "SELECT COALESCE(SUM(pending_bytes),0) AS bytes FROM import_scratch_reservations",
  );
  return BigInt(bytes);
}
