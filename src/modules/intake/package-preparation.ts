import { createHash } from 'node:crypto';
import type { PoolClient } from 'pg';
import { archiveFormat } from '../imports/policy.js';
import { isThumbsDbName, thumbnailCacheUnits, windowsThumbnailCache } from '../formats/windows-thumbnail-cache.js';
import { lockIntakeProject } from './gate.js';
import { inventoryOpen } from './receipts.js';

export type DerivativeProof = { readerVersion: string; derivativeSha256: string; byteSize: number };
export type PreparationInput = { projectId: string; receiptId: string;
  expectedReaderVersions: Record<string, string | null>; verifiedDerivatives?: Record<string, DerivativeProof> };
type RelatedPdf = { occurrenceId: string; documentId: string; versionId: string; label: string };
export type PreparationItem = { occurrenceId: string | null; documentId: string | null; versionId: string | null;
  label: string; state: 'waiting' | 'available' | 'unavailable' | 'excluded'; reason: string | null;
  kind: 'document' | 'archive' | 'technical' | 'import_entry'; derivativeAvailable: boolean;
  originalId?: string; originalSha256?: string; readerVersion?: string | null; requestedReaderVersion?: string | null;
  mapFingerprint?: string; windowIds?: string[]; format?: string; limitations?: string[]; derivative?: DerivativeProof & { format: string };
  relatedPdf?: RelatedPdf };
export type PreparationCounts = { total: number; available: number; unavailable: number; waiting: number;
  archives: number; technical: number; restrictions: number };
export type PreparationManifest = { projectId: string; receiptId: string; counts: PreparationCounts;
  items: PreparationItem[]; restrictions: { label: string; reason: string; sourceId: string }[] };
export type PreparationView = { state: 'waiting' | 'ready'; manifestId: string | null; revision: number | null;
  counts: PreparationCounts; items: PreparationItem[]; restrictions: PreparationManifest['restrictions']; reasons: string[] };

type Occurrence = { occurrenceId: string; parentId: string | null; label: string; media: string; documentId: string;
  versionId: string; originalId: string; sha256: string; originalSize: string; restriction: string | null; format: string | null;
  fingerprint: string | null; readerVersion: string | null; requested: string | null; refusal: string | null;
  physicalLimitation: string | null; units: unknown[] | null; windows: { id: string; unitId: string }[]; readerOriginalSha: string | null;
  derivativeSha: string | null; derivativeSize: string | null; derivativeFormat: string | null; derivativeKey: string | null };
const usefulUnits = (units: unknown[] | null) => (units ?? []).filter((value) => {
  const unit = value as { locator?: { coverage?: string } };
  return unit.locator?.coverage !== 'held' && unit.locator?.coverage !== 'original_only';
});
const office = (path: string, media: string, format: string | null) =>
  /\.(docx|docm|xlsx|xlsm|pptx|pptm|odt|ods|odp)$/iu.test(path) ||
  /^(application\/vnd\.openxmlformats-officedocument\.|application\/vnd\.oasis\.opendocument\.)/iu.test(media) ||
  ['doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'odt', 'ods', 'odp'].includes(format ?? '');

/** Determine the exact versions for which runtime must resolve its current reader profile. */
export async function listPackagePreparationVersions(tx: PoolClient, input: Pick<PreparationInput, 'projectId' | 'receiptId'>) {
  const { rows } = await tx.query<{ versionId: string; documentId: string; media: string; label: string; activeReaderVersion: string | null; activeRequestedVersion: string | null }>(
    `SELECT DISTINCT ON (v.id) v.id AS "versionId",v.document_id AS "documentId",v.media_type AS media,o.relative_path AS label,
       m.reader_version AS "activeReaderVersion",m.requested_reader_version AS "activeRequestedVersion"
       FROM intake_occurrences o JOIN intake_document_versions v ON v.id=o.version_id AND v.project_id=o.project_id
       LEFT JOIN harness_package_maps m ON m.project_id=o.project_id AND m.version_id=v.id AND m.active
      WHERE o.project_id=$1 AND o.receipt_id=$2 AND o.state='accepted' ORDER BY v.id,o.created_at,o.id`,
    [input.projectId, input.receiptId]);
  return rows;
}

async function evaluate(tx: PoolClient, input: PreparationInput) {
  const { projectId, receiptId, expectedReaderVersions, verifiedDerivatives = {} } = input;
  const { rows: [receipt] } = await tx.query<{ open: boolean }>(
    `SELECT ${inventoryOpen} AS open FROM intake_receipts r WHERE r.project_id=$1 AND r.id=$2`, [projectId, receiptId]);
  if (!receipt) throw new Error('receipt_not_found');
  const { rows } = await tx.query<Occurrence>(
    `SELECT o.id AS "occurrenceId",o.parent_occurrence_id AS "parentId",o.relative_path AS label,
       v.media_type AS media,v.document_id AS "documentId",v.id AS "versionId",v.original_id AS "originalId",
       orig.sha256,orig.size AS "originalSize",o.restriction,m.format,m.fingerprint,m.reader_version AS "readerVersion",
       m.requested_reader_version AS requested,m.refusal,m.physical_limitation AS "physicalLimitation",
       rm.units,rm.original_sha256 AS "readerOriginalSha",
       coalesce((SELECT jsonb_agg(jsonb_build_object('id',w.id,'unitId',w.place->>'unitId') ORDER BY w.ordinal)
         FROM harness_package_windows w WHERE w.project_id=o.project_id AND w.version_id=v.id AND w.map_fingerprint=m.fingerprint),'[]'::jsonb) AS windows,
       d.derivative_sha256 AS "derivativeSha",d.byte_size::text AS "derivativeSize",d.format AS "derivativeFormat",d.storage_key AS "derivativeKey"
     FROM intake_occurrences o JOIN intake_document_versions v ON v.project_id=o.project_id AND v.id=o.version_id
     JOIN intake_originals orig ON orig.project_id=v.project_id AND orig.id=v.original_id
     LEFT JOIN harness_package_maps m ON m.project_id=o.project_id AND m.version_id=v.id AND m.active
     LEFT JOIN reader_maps rm ON rm.project_id=o.project_id AND rm.version_id=v.id AND rm.document_id=v.document_id AND rm.reader_version=m.reader_version
     LEFT JOIN dwg_derivatives d ON d.project_id=o.project_id AND d.document_id=v.document_id AND d.version_id=v.id
       AND d.reader_version=m.reader_version AND d.original_sha256=orig.sha256
     WHERE o.project_id=$1 AND o.receipt_id=$2 AND o.state='accepted' ORDER BY o.created_at,o.id`, [projectId, receiptId]);
  const byId = new Map(rows.map((row) => [row.occurrenceId, row]));
  function insideOffice(row: Occurrence) {
    let parent = row.parentId;
    const seen = new Set<string>();
    while (parent && !seen.has(parent)) {
      seen.add(parent);
      const ancestor = byId.get(parent);
      if (!ancestor) break;
      if (office(ancestor.label, ancestor.media, ancestor.refusal || !ancestor.readerVersion || !usefulUnits(ancestor.units).length || ancestor.readerOriginalSha !== ancestor.sha256 ? null : ancestor.format)) return true;
      parent = ancestor.parentId;
    }
    return false;
  }
  // Word replaces the first two characters of the open document's name with "~$" in its tiny owner file.
  const companionKeys = new Set(rows.flatMap(row => {
    const file = row.label.split('/').at(-1) ?? '';
    if (file.startsWith('~$') || !/\.docx?$/iu.test(file) || !usefulUnits(row.units).length || row.readerOriginalSha !== row.sha256) return [];
    const directory = row.label.slice(0,row.label.length-file.length);
    return [JSON.stringify([row.parentId,directory,[...file].slice(2).join('').toLowerCase()])];
  }));
  function officeOwnerFile(row: Occurrence) {
    const file = row.label.split('/').at(-1) ?? '';
    if (!/^~\$.+\.docx?$/iu.test(file) || Number(row.originalSize)>512 || usefulUnits(row.units).length) return false;
    const directory = row.label.slice(0,row.label.length-file.length);
    return companionKeys.has(JSON.stringify([row.parentId,directory,file.slice(2).toLowerCase()]));
  }
  // Confirm a CAD lock against its drawing in the same archive directory.
  const siblingKey=(row:Occurrence, extension:string) => JSON.stringify([row.parentId,row.label.normalize('NFC').toLowerCase().replace(/\.[^./]+$/u,extension)]);
  const drawings=new Set(rows.filter(row=>row.format==='dwg' && row.readerOriginalSha===row.sha256).map(row=>siblingKey(row,'.dwg')));
  const lockInfo=(row:Occurrence) => {
    if(row.readerOriginalSha!==row.sha256 || row.units?.length!==1)return undefined;
    return (row.units[0] as {locator?:{lockPair?:string;limitations?:string}}).locator;
  };
  const xmlLocks=new Set(rows.filter(row=>row.format==='dwl2' && lockInfo(row)?.limitations==='cad_lock_candidate')
    .map(row=>JSON.stringify([siblingKey(row,'.dwg'),lockInfo(row)?.lockPair])));
  function companionReason(row:Occurrence){
    const held=lockInfo(row);
    if(row.format==='desktopini' && held?.limitations==='windows_folder_settings')return 'windows_folder_settings';
    if((row.format==='dwl'||row.format==='dwl2') && held?.limitations==='cad_lock_candidate' && held.lockPair &&
        drawings.has(siblingKey(row,'.dwg')) && xmlLocks.has(JSON.stringify([siblingKey(row,'.dwg'),held.lockPair]))) return 'cad_drawing_lock';
  }
  const readablePdfs = new Map<string, Occurrence[]>();
  for (const row of rows) {
    if (row.format !== 'pdf' || row.refusal || !row.fingerprint || !row.readerVersion ||
      row.requested !== expectedReaderVersions[row.versionId] || row.readerOriginalSha !== row.sha256 || insideOffice(row)) continue;
    const readable = new Set(usefulUnits(row.units).map((unit) => (unit as { id: string }).id));
    if (!row.windows.some((window) => readable.has(window.unitId))) continue;
    const group = readablePdfs.get(row.sha256) ?? [];
    group.push(row);
    readablePdfs.set(row.sha256, group);
  }
  function signatureCompanion(row: Occurrence) {
    if (row.format !== 'sig' || row.refusal || !row.readerVersion || row.readerOriginalSha !== row.sha256) return;
    const locator = (row.units?.[0] as { locator?: { signatureKind?: string; embeddedSha256?: string } } | undefined)?.locator;
    if (locator?.signatureKind === 'signature_detached') return { reason: 'signature_detached' };
    if (locator?.signatureKind !== 'embedded_pdf' || !locator.embeddedSha256) return;
    const candidates = readablePdfs.get(locator.embeddedSha256);
    const expectedName = row.label.replace(/\.sig$/iu, '').normalize('NFC').toLowerCase();
    const related = candidates?.find(({ label }) => label.normalize('NFC').toLowerCase() === expectedName) ?? candidates?.[0];
    if (!related) return;
    const { occurrenceId, documentId, versionId, label } = related;
    return { reason: 'signature_pdf_duplicate', relatedPdf: { occurrenceId, documentId, versionId, label } };
  }
  const items: PreparationItem[] = rows.map((row) => {
    const base: PreparationItem = { occurrenceId: row.occurrenceId, documentId: row.documentId, versionId: row.versionId,
      label: row.label, originalId: row.originalId, originalSha256: row.sha256, state: 'waiting', reason: null,
      kind: 'document', derivativeAvailable: false };
    if (officeOwnerFile(row)) return { ...base, kind: 'technical', state: 'excluded', reason: 'office_owner_file' };
    if (insideOffice(row)) return { ...base, kind: 'technical', state: 'excluded', reason: 'office_internal_part' };
    if (!office(row.label, row.media, row.refusal || !row.readerVersion || !usefulUnits(row.units).length || row.readerOriginalSha !== row.sha256 ? null : row.format) && archiveFormat(row.label, row.media))
      return { ...base, kind: 'archive', state: 'excluded', reason: row.restriction };
    if (!Object.hasOwn(expectedReaderVersions, row.versionId)) return { ...base, reason: 'reader_version_not_resolved' };
    if (!row.fingerprint || row.requested !== expectedReaderVersions[row.versionId]) return { ...base, reason: 'reader_map_pending' };
    const mapped = { ...base, readerVersion: row.readerVersion, requestedReaderVersion: row.requested,
      mapFingerprint: row.fingerprint, format: row.format ?? undefined,
      limitations: row.physicalLimitation ? [row.physicalLimitation] : [] };
    if (isThumbsDbName(row.label) && row.readerOriginalSha === row.sha256 && thumbnailCacheUnits(row.format, row.units)) {
      return { ...mapped, kind: 'technical', state: 'excluded', reason: windowsThumbnailCache };
    }
    const technicalReason=companionReason(row);
    if(technicalReason)return {...mapped,kind:'technical',state:'excluded',reason:technicalReason};
    const companion = signatureCompanion(row);
    if (companion) return { ...mapped, ...companion, kind: 'technical', state: 'excluded' };
    if (row.refusal && !(row.refusal === 'physical_inventory_unverified' && usefulUnits(row.units).length))
      return { ...mapped, state: 'unavailable', reason: row.refusal };
    if (!row.readerVersion || !row.units || row.readerOriginalSha !== row.sha256 || row.windows.length === 0)
      return { ...mapped, reason: 'reader_map_unavailable' };
    if (!usefulUnits(row.units).length) {
      const first = row.units[0] as { locator?: { limitations?: string } } | undefined;
      const reason = first?.locator?.limitations?.split(',')[0] || row.physicalLimitation || 'reader_no_usable_parts';
      if (reason.endsWith('_converter_unavailable')) return { ...mapped, reason };
      return { ...mapped, state: 'unavailable', reason };
    }
    const usableIds = new Set(usefulUnits(row.units).map((value) => (value as { id: string }).id));
    const windowIds = row.windows.filter((window) => usableIds.has(window.unitId)).map((window) => window.id);
    if (!windowIds.length) return { ...mapped, reason: 'reader_windows_mismatch' };
    if (row.format === 'dwg') {
      const proof = verifiedDerivatives[row.versionId];
      const matchesUnits = usefulUnits(row.units).every((value) => {
        const unit = value as { locator?: { derivativeSha256?: string } };
        return unit.locator?.derivativeSha256 === row.derivativeSha;
      });
      if (!proof || proof.readerVersion !== row.readerVersion || proof.derivativeSha256 !== row.derivativeSha ||
          proof.byteSize !== Number(row.derivativeSize) || !row.derivativeFormat || !row.derivativeKey || !matchesUnits)
        return { ...mapped, reason: 'derivative_unverified' };
      return { ...mapped, windowIds, state: 'available', derivativeAvailable: true,
        derivative: { ...proof, format: row.derivativeFormat } };
    }
    return { ...mapped, windowIds, state: 'available' };
  });
  const { rows: restrictions } = await tx.query<{ label: string; reason: string; sourceId: string }>(
    `SELECT label,reason,"sourceId" FROM (
       SELECT o.relative_path AS label,o.restriction AS reason,o.id::text AS "sourceId"
       FROM intake_occurrences o WHERE o.project_id=$1 AND o.receipt_id=$2 AND o.restriction IS NOT NULL
       UNION ALL
       SELECT e.original_path,e.reason,e.id::text FROM import_inventory_entries e JOIN import_jobs j ON j.id=e.job_id
       WHERE j.project_id=$1 AND j.receipt_id=$2 AND e.state='rejected' AND e.reason IS NOT NULL
       UNION ALL
       SELECT o.relative_path,coalesce(o.restriction,'intake_' || o.state),o.id::text FROM intake_occurrences o
       WHERE o.project_id=$1 AND o.receipt_id=$2 AND o.state IN ('cancelled','expired')
       UNION ALL
       SELECT coalesce(mi.relative_path,'Исключённая ссылка'),coalesce(mi.exclusion_reason,'manifest_excluded'),mi.id::text
       FROM intake_manifest_items mi JOIN intake_receipts r ON r.id=mi.receipt_id
       WHERE r.project_id=$1 AND r.id=$2 AND mi.excluded_at IS NOT NULL
       UNION ALL
       SELECT coalesce(j.relative_path,'Импорт'),coalesce(j.reason,'import_' || j.status),j.id::text FROM import_jobs j
       WHERE j.project_id=$1 AND j.receipt_id=$2 AND j.occurrence_id IS NULL AND j.status IN ('limited','failed','cancelled')
     ) failures ORDER BY "sourceId"`, [projectId, receiptId]);
  for (const failure of restrictions) {
    if (!byId.has(failure.sourceId)) items.push({ occurrenceId: null, documentId: null, versionId: null, label: failure.label,
      state: 'unavailable', reason: failure.reason, kind: 'import_entry', derivativeAvailable: false });
  }
  const docs = items.filter((item) => item.kind === 'document');
  const counts: PreparationCounts = { total: docs.length, available: docs.filter((item) => item.state === 'available').length,
    unavailable: docs.filter((item) => item.state === 'unavailable').length, waiting: docs.filter((item) => item.state === 'waiting').length,
    archives: items.filter((item) => item.kind === 'archive').length, technical: items.filter((item) => item.kind === 'technical').length,
    restrictions: restrictions.length };
  const manifest: PreparationManifest = { projectId, receiptId, counts, items, restrictions };
  const reasons = [...(receipt.open ? ['inventory_open'] : []), ...(counts.waiting ? ['documents_pending'] : [])];
  const hash = createHash('sha256').update(JSON.stringify(manifest)).digest('hex');
  return { manifest, reasons, hash };
}

/** Read-only projection; no old manifest is advertised while current input differs. */
export async function readPackagePreparation(tx: PoolClient, input: PreparationInput): Promise<PreparationView> {
  const result = await evaluate(tx, input);
  const { rows: [current] } = await tx.query<{ id: string; revision: number; hash: string }>(
    `SELECT p.id,p.revision,p.snapshot_hash AS hash FROM intake_package_preparation_current c
     JOIN intake_package_preparations p ON p.id=c.manifest_id WHERE c.project_id=$1 AND c.receipt_id=$2`, [input.projectId,input.receiptId]);
  const matches = !result.reasons.length && current?.hash === result.hash;
  return { state: result.reasons.length ? 'waiting' : 'ready', manifestId: matches ? current.id : null,
    revision: matches ? current.revision : null, ...result.manifest, reasons: result.reasons };
}

/** Call inside a transaction and repeat immediately before new admissions under the same lock. */
export async function capturePackagePreparation(tx: PoolClient, input: PreparationInput) {
  await lockIntakeProject(tx, input.projectId);
  const result = await evaluate(tx, input);
  if (result.reasons.length) {
    await tx.query('DELETE FROM intake_package_preparation_current WHERE project_id=$1 AND receipt_id=$2', [input.projectId,input.receiptId]);
    return { state: 'waiting' as const, reasons: result.reasons, manifest: result.manifest };
  }
  const { rows: [latest] } = await tx.query<{ id: string; revision: number; hash: string }>(
    `SELECT id,revision,snapshot_hash AS hash FROM intake_package_preparations
     WHERE project_id=$1 AND receipt_id=$2 ORDER BY revision DESC LIMIT 1`, [input.projectId,input.receiptId]);
  let id = latest?.id;
  let revision = latest?.revision;
  const created = !latest || latest.hash !== result.hash;
  if (created) {
    revision = (latest?.revision ?? 0) + 1;
    const { rows: [inserted] } = await tx.query<{ id: string }>(
      `INSERT INTO intake_package_preparations(project_id,receipt_id,revision,snapshot_hash,manifest)
       VALUES($1,$2,$3,$4,$5) RETURNING id`, [input.projectId,input.receiptId,revision,result.hash,JSON.stringify(result.manifest)]);
    id = inserted.id;
    for (const item of result.manifest.items) if (item.kind === 'document' && item.state === 'available' && item.versionId && item.mapFingerprint) {
      await tx.query(`INSERT INTO intake_package_preparation_items(manifest_id,project_id,version_id,map_fingerprint)
        VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING`, [id,input.projectId,item.versionId,item.mapFingerprint]);
      for (const windowId of item.windowIds ?? []) await tx.query(
        `INSERT INTO intake_package_preparation_windows(manifest_id,project_id,window_id) VALUES($1,$2,$3) ON CONFLICT DO NOTHING`,
        [id,input.projectId,windowId]);
    }
  }
  await tx.query(`INSERT INTO intake_package_preparation_current(project_id,receipt_id,manifest_id) VALUES($1,$2,$3)
    ON CONFLICT(project_id,receipt_id) DO UPDATE SET manifest_id=EXCLUDED.manifest_id`, [input.projectId,input.receiptId,id]);
  return { state: 'ready' as const, manifestId: id!, revision: revision!, manifest: result.manifest, created };
}
