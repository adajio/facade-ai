import type { Pool, PoolClient } from 'pg';
import { verifyDwgFile } from '../formats/dwg-durable.js';
import { isOdaDwgVersion, parseDwgVersion } from '../formats/dwg-profile.js';
import { ReaderError } from './types.js';
import type { DocumentKey } from './types.js';

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
