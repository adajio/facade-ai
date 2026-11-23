import type { PoolClient } from 'pg';

export const packagePrimaryProjectLimit = 8;
export const packagePrimaryGlobalLimit = 96;
export const packageResumeWaitingSlot = 'package_resume_waiting_slot';

export const currentPackageSource = `EXISTS (
  SELECT 1 FROM intake_occurrences o WHERE o.project_id=w.project_id AND o.version_id=w.version_id AND o.state='accepted'
) AND NOT EXISTS (
  SELECT 1 FROM intake_document_versions v JOIN intake_occurrences o ON o.project_id=v.project_id
    AND o.version_id=v.id AND o.state='accepted'
  WHERE v.project_id=w.project_id AND v.replaces_version_id=w.version_id
)`;
export const currentPackageWindows = `harness_package_windows w JOIN harness_package_maps m
  ON m.version_id=w.version_id AND m.fingerprint=w.map_fingerprint AND m.active`;
export const currentPackagePrimary = `harness_package_branches b JOIN ${currentPackageWindows} ON w.id=b.window_id
  JOIN gateway_jobs j ON j.id=b.job_id JOIN gateway_generations g ON g.generation_id=j.generation_id AND g.current
  WHERE b.active AND ${currentPackageSource}`;
export const runnablePackagePrimary = `${currentPackagePrimary} AND j.state IN ('ready','leased')`;

export async function lockPackagePrimarySlots(tx: PoolClient) {
  await tx.query("SELECT pg_advisory_xact_lock(hashtextextended('facade/package-dispatch',0))");
}
