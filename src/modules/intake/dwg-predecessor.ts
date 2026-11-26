import type { PoolClient } from 'pg';
import { emptyDwgFontAssets } from '../formats/cad-font-assets.js';
import { dxfEncodingRecoveryVersion, dxfGroupRecoveryVersion, dwgReaderProfile, historicalDwgReaderProfile, parseDwgVersion } from '../formats/dwg-profile.js';

type Predecessor = { versions: string[]; before: string | null };

export function dwgPredecessor(current: string | null): Predecessor {
  const previous = process.env.FACADE_DWG_PREDECESSOR_ID;
  const before = process.env.FACADE_DWG_PREDECESSOR_BEFORE;
  const pin = parseDwgVersion(current);
  if (!pin || (!previous && !before)) return { versions: [], before: null };
  if (!previous || !/^sha256:[a-f0-9]{64}$/.test(previous) ||
      !before || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z$/.test(before) || !Number.isFinite(Date.parse(before))) {
    throw new Error('invalid_dwg_predecessor');
  }
  const fonts = new Set([pin.fonts, emptyDwgFontAssets.identity]);
  const versions = [historicalDwgReaderProfile, dwgReaderProfile].flatMap(profile =>
    Array.from(fonts, identity => `${profile}:dwg:${previous}:fonts:sha256:${identity}`)
      .filter(base => base !== current)
      .flatMap(base => [base, dxfGroupRecoveryVersion(base)!, dxfEncodingRecoveryVersion(base)!]));
  return { versions, before };
}

/** Preserve admitted evidence. Previously held versions return to map preparation. */
export function pinnedDwgPredecessorSql(map: string, versions: string, before: string) {
  return `(${map}.format='dwg' AND ${map}.reader_version=${map}.requested_reader_version
    AND ${map}.requested_reader_version=ANY(${versions})
    AND EXISTS (
      SELECT 1 FROM intake_package_preparation_items pin
      JOIN intake_package_preparations prep ON prep.id=pin.manifest_id AND prep.project_id=pin.project_id
      WHERE pin.project_id=${map}.project_id AND pin.version_id=${map}.version_id
        AND pin.map_fingerprint=${map}.fingerprint AND prep.created_at<${before}
    ))`;
}

export async function listPinnedDwgPredecessors(tx: Pick<PoolClient,'query'>, projectId: string,
    versionIds: string[], current: string | null) {
  const rule = dwgPredecessor(current);
  if (!rule.versions.length || !versionIds.length) return new Map<string,string>();
  const { rows } = await tx.query<{versionId: string; requested: string}>(
    `SELECT m.version_id AS "versionId",m.requested_reader_version AS requested
     FROM harness_package_maps m WHERE m.project_id=$1 AND m.version_id=ANY($2::uuid[]) AND m.active
       AND ${pinnedDwgPredecessorSql('m','$3::text[]','$4::timestamptz')}`,[projectId,versionIds,rule.versions,rule.before]);
  return new Map(rows.map(({versionId,requested})=>[versionId,requested]));
}
