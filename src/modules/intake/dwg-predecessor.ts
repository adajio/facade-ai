import type { PoolClient } from 'pg';
import { dxfEncodingRecoveryVersion, dxfGroupRecoveryVersion, dwgReaderProfile, dwgVersionPin } from '../formats/dwg-profile.js';

type Predecessor = { versions: string[]; before: string | null };

export function dwgPredecessor(current: string | null): Predecessor {
  const previous = process.env.FACADE_DWG_PREDECESSOR_ID;
  const before = process.env.FACADE_DWG_PREDECESSOR_BEFORE;
  const pin = current?.match(dwgVersionPin);
  if ((!previous && !before) || !pin) return { versions: [], before: null };
  if (!previous || !/^sha256:[a-f0-9]{64}$/.test(previous) ||
      !before || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z$/.test(before) || !Number.isFinite(Date.parse(before))) {
    throw new Error('invalid_dwg_predecessor');
  }
  if (pin[1] === previous) return { versions: [], before: null };
  const base = `${dwgReaderProfile}:dwg:${previous}:fonts:sha256:${pin[2]}`;
  return { versions: [base, dxfGroupRecoveryVersion(base)!, dxfEncodingRecoveryVersion(base)!], before };
}

/** Shared by dispatch and preparation. The expressions are internal aliases/parameters. */
export function pinnedDwgPredecessorSql(map: string, versions: string, before: string) {
  return `(${map}.format='dwg' AND ${map}.requested_reader_version=ANY(${versions})
    AND (${map}.reader_version IS NULL OR ${map}.reader_version=${map}.requested_reader_version)
    AND (
      EXISTS (
        SELECT 1 FROM intake_package_preparation_items pin
        JOIN intake_package_preparations prep ON prep.id=pin.manifest_id AND prep.project_id=pin.project_id
        WHERE pin.project_id=${map}.project_id AND pin.version_id=${map}.version_id
          AND pin.map_fingerprint=${map}.fingerprint AND prep.created_at<${before}
      ) OR EXISTS (
        SELECT 1 FROM intake_package_preparations prep
        WHERE prep.project_id=${map}.project_id AND prep.created_at<${before}
          AND prep.manifest->'items' @> jsonb_build_array(jsonb_build_object(
            'kind','document','state','unavailable','versionId',${map}.version_id::text,
            'mapFingerprint',${map}.fingerprint,'requestedReaderVersion',${map}.requested_reader_version))
      )
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
