import type { Pool, PoolClient } from 'pg';
import { openVerifiedDwgFile, persistDwgFile, verifyDwgFile } from '../formats/dwg-durable.js';
import { isOdaDwgVersion, parseDwgVersion } from '../formats/dwg-profile.js';
import { ReaderError } from './types.js';
import type { DocumentKey, ReaderUnit, SourceRef } from './types.js';

export async function findStoredDwgDerivative(db: Pool | PoolClient, document: DocumentKey, readerVersion?: string) {
  const { rows: [row] } = await db.query<{ original_sha256: string; reader_version: string; derivative_sha256: string;
    byte_size: string; converter_identity: string; format: 'dxf'|'dwg-json'; storage_key: string }>(
    `SELECT d.original_sha256,d.reader_version,d.derivative_sha256,d.byte_size,d.converter_identity,d.format,d.storage_key
     FROM dwg_derivatives d JOIN intake_document_versions v ON v.id=d.version_id AND v.project_id=d.project_id AND v.document_id=d.document_id
     JOIN intake_originals o ON o.id=v.original_id AND o.project_id=v.project_id AND o.sha256=d.original_sha256
     WHERE d.project_id=$1 AND d.document_id=$2 AND d.version_id=$3 AND ($4::text IS NULL OR d.reader_version=$4)
     ORDER BY d.created_at DESC,d.reader_version DESC LIMIT 1`, [document.projectId,document.documentId,document.versionId,readerVersion ?? null]);
  if (!row) return undefined;
  const version = parseDwgVersion(row.reader_version);
  if ((version && version.converter !== row.converter_identity) || (isOdaDwgVersion(row.reader_version) && row.format !== 'dxf')) {
    throw new ReaderError('dwg_derivative_invalid','Идентичность профиля производной DWG нарушена',424);
  }
  const size = Number(row.byte_size);
  if (!Number.isSafeInteger(size) || size <= 0) throw new ReaderError('dwg_derivative_invalid','Размер производной DWG не подтверждён',424);
  const source = { ...document, sha256: row.original_sha256 };
  const file = await verifyDwgFile(source,row.derivative_sha256,size,true);
  if (!file) return undefined;
  if (file.storageKey !== row.storage_key) throw new ReaderError('dwg_derivative_invalid','Идентичность производной DWG нарушена',424);
  return { readerVersion:row.reader_version, derivativeSha256:row.derivative_sha256, byteSize:size, format:row.format, path:file.path };
}
export async function verifyStoredDwgDerivative(db: Pool | PoolClient, document: DocumentKey, readerVersion: string) {
  const result = await findStoredDwgDerivative(db,document,readerVersion);
  if (!result) return undefined;
  return {readerVersion:result.readerVersion,derivativeSha256:result.derivativeSha256,byteSize:result.byteSize};
}

// A copy has its own version address. Reader addresses are transferable only within the
// same original bytes, project and complete reader profile, including fonts and recovery revision.
export async function reuseStoredDwgDerivative(db: Pool | PoolClient, source: SourceRef, readerVersion: string, expected?: string): Promise<ReaderUnit[] | undefined> {
  const profile = parseDwgVersion(readerVersion);
  if (!profile || !isOdaDwgVersion(readerVersion)) return undefined;
  const { rows } = await db.query<{ documentId: string; versionId: string; derivative: string;
      byteSize: string; storageKey: string; units: ReaderUnit[] }>(
    `SELECT d.document_id AS "documentId",d.version_id AS "versionId",d.derivative_sha256 AS derivative,
        d.byte_size AS "byteSize",d.storage_key AS "storageKey",m.units
      FROM dwg_derivatives d JOIN reader_maps m ON m.project_id=d.project_id AND m.document_id=d.document_id
        AND m.version_id=d.version_id AND m.reader_version=d.reader_version AND m.original_sha256=d.original_sha256
      JOIN intake_document_versions v ON v.project_id=d.project_id AND v.document_id=d.document_id AND v.id=d.version_id
      JOIN intake_originals o ON o.project_id=v.project_id AND o.id=v.original_id AND o.sha256=d.original_sha256
      WHERE d.project_id=$1 AND d.original_sha256=$2 AND d.reader_version=$3 AND d.converter_identity=$4
        AND d.version_id<>$5 AND d.format='dxf' AND m.format='dwg' AND ($6::text IS NULL OR d.derivative_sha256=$6)
      ORDER BY d.created_at DESC,d.version_id LIMIT 32`,
    [source.projectId,source.sha256,readerVersion,profile.converter,source.versionId,expected ?? null]);
  for (const row of rows) {
    const size = Number(row.byteSize);
    if ((expected && row.derivative!==expected) || !Number.isSafeInteger(size) || size<=0 || !Array.isArray(row.units) || !row.units.length ||
        row.units.some(({ locator }) => locator?.derivativeSha256 !== row.derivative
          || (locator.derivativeFormat !== undefined && locator.derivativeFormat !== 'dxf')
          || (locator.converterIdentity !== undefined && locator.converterIdentity !== profile.converter)
          || typeof locator.partSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(locator.partSha256))) continue;
    const predecessor = { ...source, documentId:row.documentId, versionId:row.versionId };
    let file;
    try {
      const saved = await verifyDwgFile(predecessor,row.derivative,size,true);
      if (!saved || saved.storageKey!==row.storageKey) continue;
      file = await openVerifiedDwgFile(saved.path,row.derivative,size);
    } catch (error) {
      if (!(error instanceof ReaderError)) throw error;
      continue;
    }
    try {
      await persistDwgFile(source,file,row.derivative);
      return row.units.map(unit=>({ ...unit, locator:{ ...unit.locator, derivativeFormat:'dxf', converterIdentity:profile.converter } }));
    } finally { await file.close(); }
  }
}
