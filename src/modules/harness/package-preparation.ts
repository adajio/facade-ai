import type { Pool, PoolClient } from 'pg';
import { transaction } from '../gateway/types.js';
import { capturePackagePreparation, listPackagePreparationVersions, type PreparationInput } from '../intake/package-preparation.js';
import { verifyStoredDwgDerivative } from '../pdf/index.js';
import { dxfEncodingRecoveryVersion, dxfGroupRecoveryVersion, isDxfRecoveryVersion } from '../formats/dwg-profile.js';
import { largeJpegRecoveryVersion } from '../formats/raster-profile.js';
import type { ReaderService } from './reader.js';

type Receipt = { projectId: string; receiptId: string };
type PreparationReader = Pick<ReaderService, 'readerVersion' | 'formatFor'>;

export async function packagePreparationInput(tx: PoolClient, target: Receipt, reader: PreparationReader): Promise<PreparationInput> {
  const expectedReaderVersions: PreparationInput['expectedReaderVersions'] = {};
  const verifiedDerivatives: NonNullable<PreparationInput['verifiedDerivatives']> = {};
  const profiles = new Map<string, string | null>();
  for (const item of await listPackagePreparationVersions(tx, target)) {
    const format = reader.formatFor(item.media, item.label);
    if (!profiles.has(format)) profiles.set(format, await reader.readerVersion(format));
    let version = profiles.get(format) ?? null;
    if (format === 'dwg') {
      const document = { projectId: target.projectId, documentId: item.documentId, versionId: item.versionId };
      const offline = !version || version.includes(':unavailable');
      const recovered = item.activeReaderVersion && (offline ? isDxfRecoveryVersion(item.activeReaderVersion)
        : [dxfGroupRecoveryVersion(version), dxfEncodingRecoveryVersion(version)].includes(item.activeReaderVersion));
      const pinnedVersion = offline || recovered ? item.activeReaderVersion ?? version : version;
      if (recovered) version = pinnedVersion;
      if (pinnedVersion) {
        try {
          const stored = await verifyStoredDwgDerivative(tx, document, pinnedVersion);
          if (stored) { verifiedDerivatives[item.versionId] = stored; version = pinnedVersion; }
        } catch (error) {
          // A damaged or unavailable stored object must not admit this version.
          if ((error as {statusCode?: number}).statusCode !== 424) throw error;
        }
      }
    }
    const rasterRecovery = largeJpegRecoveryVersion(version,item.media,item.label);
    if (rasterRecovery && item.activeRequestedVersion===rasterRecovery && !item.activeReaderVersion) version = rasterRecovery;
    expectedReaderVersions[item.versionId] = version;
  }
  return { ...target, expectedReaderVersions, verifiedDerivatives };
}

export async function refreshReceiptPreparation(tx: PoolClient, target: Receipt, reader: PreparationReader) {
  return capturePackagePreparation(tx, await packagePreparationInput(tx, target, reader));
}

// Only document versions in an immutable, currently admitted manifest may receive new work.
export const preparedPackageWindow = `EXISTS (SELECT 1 FROM intake_package_preparation_windows i
  JOIN intake_package_preparation_current c ON c.manifest_id=i.manifest_id AND c.project_id=i.project_id
  WHERE i.project_id=w.project_id AND i.window_id=w.id)`;

/** Compute reader profiles and verify derivative bytes before taking the shared slot lock. */
export async function preflightPackageWindow(tx: PoolClient, reader: PreparationReader, projectId: string, windowId: string) {
  const { rows } = await tx.query<{ receiptId: string }>(`SELECT c.receipt_id AS "receiptId" FROM intake_package_preparation_windows i
    JOIN intake_package_preparation_current c ON c.manifest_id=i.manifest_id AND c.project_id=i.project_id
    WHERE i.project_id=$1 AND i.window_id=$2 ORDER BY c.receipt_id`, [projectId, windowId]);
  const inputs: PreparationInput[] = [];
  for (const row of rows) inputs.push(await packagePreparationInput(tx, { projectId, receiptId: row.receiptId }, reader));
  return inputs;
}

/** Verify under the intake lock immediately before admission; caller must use the same transaction. */
export async function verifyCurrentPreparation(tx: PoolClient, input: PreparationInput, expectedId: string, windowId?: string) {
  const current = await capturePackagePreparation(tx, input);
  if (current.state !== 'ready' || current.manifestId !== expectedId) return false;
  if (!windowId) return true;
  return Boolean((await tx.query(`SELECT 1 FROM intake_package_preparation_windows
    WHERE project_id=$1 AND manifest_id=$2 AND window_id=$3`, [input.projectId, expectedId, windowId])).rowCount);
}

/** Consume a preflight under the project lock without rereading potentially large derivatives. */
export async function preparedManifestForWindow(tx: PoolClient, projectId: string, windowId: string, inputs: PreparationInput[]) {
  for (const input of inputs) {
    if (input.projectId !== projectId) continue;
    const { rows: [candidate] } = await tx.query<{ id: string }>(`SELECT c.manifest_id AS id
      FROM intake_package_preparation_current c JOIN intake_package_preparation_windows w ON w.manifest_id=c.manifest_id
      WHERE c.project_id=$1 AND c.receipt_id=$2 AND w.window_id=$3`, [projectId,input.receiptId,windowId]);
    if (candidate && await verifyCurrentPreparation(tx,input,candidate.id,windowId)) return candidate.id;
  }
  return null;
}

/** Revisit sealed and still arriving receipts independently of the order in which files finish mapping. */
export function packagePreparationSweep(db: Pool, reader: PreparationReader) {
  let after: string | null = null;
  let restartAfter = 0;
  return async () => {
    if (Date.now() < restartAfter) return false;
    const { rows: [target] } = await db.query<Receipt>(`SELECT r.id AS "receiptId",r.project_id AS "projectId" FROM intake_receipts r
      JOIN projects p ON p.id=r.project_id WHERE ($1::uuid IS NULL OR r.id>$1)
      AND (p.intake_mode OR EXISTS (SELECT 1 FROM harness_package_projects h WHERE h.project_id=r.project_id))
      ORDER BY r.id LIMIT 1`,[after]);
    if (!target) { after=null; restartAfter=Date.now()+5_000; return false; }
    after=target.receiptId;
    const result=await transaction(db,tx => refreshReceiptPreparation(tx,target,reader));
    return result.state === 'ready' && result.created;
  };
}
