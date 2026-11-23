import { createHash } from "node:crypto";
import type { PageMap, ReaderUnit } from "../pdf/types.js";
import type { Parsed, Unit } from "./model.js";

export type PhysicalInventory = { sourceDigest: string; placeCount: number } | { limitation: string };

type Stamp = { limitation: string } | {
  format: string;
  readerVersion: string;
  originalSha256: string;
  sourceDigest: string;
  placeCount: number;
  mapDigest: string;
};

type InventoriedUnit = ReaderUnit & { physicalInventory?: Stamp };

const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const hexDigest = /^[a-f0-9]{64}$/;

// Keys come from the original's structure. Mapped keys come from the actual delivered windows and rows.
export function matchInventory(source: string[], mapped: string[], mismatch: string): PhysicalInventory {
  const expected = source.sort();
  const actual = mapped.sort();
  if (actual.length !== expected.length || expected.some((key, index) =>
    key !== actual[index] || (index > 0 && key === expected[index - 1]))) return { limitation: mismatch };
  return { sourceDigest: digest(expected), placeCount: expected.length };
}

// Canonicalize locator keys because PostgreSQL stores the map as JSONB.
function mapDigest(units: ReaderUnit[]) {
  return digest(units.map(({ id, width, height, locator }) =>
    [id, width, height, Object.entries(locator ?? {}).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)]));
}

export function stampPhysicalInventory(units: InventoriedUnit[], parsed: Parsed, format: string, readerVersion: string) {
  if (!units.length || !parsed.inventory) return units;
  units[0].physicalInventory = "limitation" in parsed.inventory ? parsed.inventory : {
    ...parsed.inventory, format, readerVersion, originalSha256: parsed.originalSha256!,
    mapDigest: mapDigest(units),
  };
  return units;
}

export function verifyPhysicalInventory(map: Pick<PageMap, "source" | "readerVersion" | "format" | "units">):
  { basisId: string } | { limitation: string } {
  const stamp = (map.units[0] as InventoriedUnit | undefined)?.physicalInventory;
  if (!stamp) {
    const fallback = map.units.find(({ locator }) =>
      locator?.coverage === "held" || locator?.coverage === "original_only" || locator?.derivative)?.locator?.limitations;
    return { limitation: typeof fallback === "string" ? fallback.split(",")[0] : "physical_inventory_unavailable" };
  }
  if (typeof stamp !== "object") return { limitation: "physical_inventory_map_mismatch" };
  if ("limitation" in stamp) {
    return { limitation: typeof stamp.limitation === "string" && stamp.limitation
      ? stamp.limitation : "physical_inventory_map_mismatch" };
  }
  if (stamp.format !== map.format || stamp.readerVersion !== map.readerVersion ||
      stamp.originalSha256 !== map.source.sha256 || !hexDigest.test(stamp.sourceDigest) ||
      !Number.isSafeInteger(stamp.placeCount) || stamp.placeCount < 1 ||
      stamp.mapDigest !== mapDigest(map.units)) return { limitation: "physical_inventory_map_mismatch" };
  return { basisId: `inventory-v1:${digest([map.source.versionId, map.source.sha256,
    map.readerVersion, map.format, stamp.sourceDigest, stamp.placeCount, stamp.mapDigest])}` };
}

export function inventoryLimitation(units: Unit[], ignores: ReadonlySet<string> = new Set()): string | undefined {
  return units.flatMap(({ limitations }) => limitations).find((code) => !ignores.has(code));
}
