import type { PoolClient } from 'pg';
import { AccessError, unavailable } from '../access/errors.js';
import type { ReaderAddress } from '../pdf/types.js';

export type AcceptedOriginal = {
  id: string; sha256: string; documentId: string; label: string; receiptId: string; occurrenceId: string; mediaType: string;
};
export type OriginalBasis = {
  provenanceKind: 'engineer_override';
  documentId: string;
  versionId: string;
  sha256: string;
  label: string;
  address: ReaderAddress;
};

export async function acceptedOriginals(tx: PoolClient, projectId: string, selection: {
  versionId?: string; after?: string; limit?: number;
} = {}) {
  const { rows } = await tx.query<AcceptedOriginal>(
    `SELECT v.id, v.document_id AS "documentId", raw.sha256, occurrence.relative_path AS label,
            occurrence.receipt_id AS "receiptId", occurrence.id AS "occurrenceId", v.media_type AS "mediaType"
      FROM intake_document_versions v
      JOIN intake_originals raw ON raw.project_id=v.project_id AND raw.id=v.original_id
      JOIN LATERAL (
        SELECT id, receipt_id, relative_path FROM intake_occurrences o
        WHERE o.project_id=v.project_id AND o.version_id=v.id AND o.state='accepted'
        ORDER BY o.created_at, o.id LIMIT 1
      ) occurrence ON true
      WHERE v.project_id=$1 AND ($2::uuid IS NULL OR v.id=$2) AND ($3::uuid IS NULL OR v.id>$3) AND NOT EXISTS (
        SELECT 1 FROM intake_document_versions replacement
        WHERE replacement.project_id=$1 AND replacement.replaces_version_id=v.id
          AND EXISTS (SELECT 1 FROM intake_occurrences o WHERE o.version_id=replacement.id AND o.state='accepted')
      )
      ORDER BY v.id LIMIT $4`, [projectId, selection.versionId ?? null, selection.after ?? null, selection.limit ?? null],
  );
  return rows;
}

export async function verifyOriginalBasis(tx: PoolClient, projectId: string, versionId: string, anchor: string): Promise<OriginalBasis> {
  const [original] = await acceptedOriginals(tx, projectId, { versionId });
  if (!original) throw unavailable();
  const { rows: [map] } = await tx.query<{ format: string; units: { id: string; locator: Record<string, unknown> }[] }>(
    `SELECT format, units FROM reader_maps WHERE project_id=$1 AND version_id=$2 AND original_sha256=$3
       ORDER BY created_at DESC, reader_version DESC LIMIT 1`, [projectId, versionId, original.sha256],
  );
  let address: ReaderAddress | undefined;
  if (map?.format === 'pdf' && /^[1-9]\d{0,6}$/u.test(anchor)) {
    const page = Number(anchor);
    const unit = map.units.find(({ locator }) => locator?.page === page);
    if (unit) address = { unitId: unit.id, locator: { page } };
  } else if (map?.format === 'xlsx') {
    const cell = /^(.*)!([A-Za-z]{1,3})([1-9]\d{0,6})$/u.exec(anchor);
    if (cell) {
      const [, sheet, name, rowNumber] = cell;
      const row = Number(rowNumber);
      const columnName = name.toUpperCase();
      const column = [...columnName].reduce((value, letter) => value * 26 + letter.charCodeAt(0) - 64, 0);
      const unit = map.units.find(({ locator }) => locator?.sheet === sheet &&
        Number(locator.firstRow) <= row && Number(locator.lastRow) >= row);
      if (unit && column <= 16384 && row <= 1048576) {
        address = { unitId: unit.id, locator: { sheet, cell: columnName + rowNumber, row, column } };
      }
    }
  }
  if (!address) throw new AccessError(422, 'original_address_unavailable',
    'Укажите физическую страницу PDF или ячейку XLSX по подготовленной карте оригинала.');
  return { provenanceKind: 'engineer_override', documentId: original.documentId, versionId,
    sha256: original.sha256, label: original.label, address };
}
