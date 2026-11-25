import type { PoolClient } from 'pg';
import { acceptedOriginals, verifyOriginalBasis, type OriginalBasis } from '../intake/accepted-originals.js';
import type { parseConclusion } from './inputs.js';
import { AssessmentError, type snapshot } from './store.js';
import { facadePlaceKey, findDocumentFacadeLink, readDocumentFacadeLinks } from './document-facades.js';
import type { ReaderAddress } from '../pdf/types.js';
import type { getLockedFacadeContext } from './facade-store.js';

type Input = NonNullable<ReturnType<typeof parseConclusion>['basis']>;
type Assessment = Awaited<ReturnType<typeof snapshot>>;
type InventoryLimit = { occurrenceId: string; receiptId: string; number: number; versionId: string | null; label: string; restriction: string; inventoryRevision: string };
export type ConclusionBasis = { kind: 'original'; original: OriginalBasis } |
  { kind: 'citation'; citation: Assessment['questions'][number]['machine']['citations'][number] } |
  ({ kind: 'inventory' } & InventoryLimit);

export function conclusionBasisVersions(area: Awaited<ReturnType<typeof getLockedFacadeContext>>, inventory = false) {
  const facadeId = area.context.facadeId;
  if (!facadeId) return undefined;
  const cited = area.questions.filter(({ active }) => active)
    .flatMap(({ machine }) => machine.citations.map(({ versionId }) => versionId));
  const linked = area.input.links.filter((link) => link.facadeId === facadeId && (!inventory || link.targetKey === 'document'))
    .map(({ versionId }) => versionId);
  return [...new Set([...cited, ...linked])];
}

export async function inventoryLimits(tx: PoolClient, projectId: string, after?: string, occurrenceId?: string, versionIds?: string[]) {
  const { rows } = await tx.query<InventoryLimit>(
    `SELECT o.id AS "occurrenceId",r.id AS "receiptId",r.number::float8 AS number,o.version_id AS "versionId",o.relative_path AS label,
       coalesce(o.restriction, o.state) AS restriction,
       (SELECT concat(coalesce(max(e.id),0),':',count(*)) FROM intake_events e WHERE e.receipt_id=r.id) AS "inventoryRevision"
     FROM intake_occurrences o JOIN intake_receipts r ON r.id=o.receipt_id
     WHERE o.project_id=$1 AND (o.restriction IS NOT NULL OR o.state IN ('cancelled','expired'))
       AND ($2::uuid IS NULL OR o.id>$2) AND ($3::uuid IS NULL OR o.id=$3)
       AND ($4::uuid[] IS NULL OR o.version_id=ANY($4)) ORDER BY o.id LIMIT 101`,
    [projectId, after ?? null, occurrenceId ?? null, versionIds ?? null]);
  return rows;
}

export async function conclusionBasis(tx: PoolClient, projectId: string, input: Input, assessment: Assessment,
  forArea: { common: boolean; scopeId?: string; facadeId?: string }): Promise<ConclusionBasis> {
  const { common, scopeId, facadeId } = forArea;
  const citations = assessment.questions.flatMap((row) => row.machine.citations);
  const invalid = () => new AssessmentError(422, 'conclusion_basis_unavailable', 'Основание не подтверждено для выбранной области.');
  if (input.kind === 'citation') {
    const citation = citations.find((item) => item.evidenceId === input.evidenceId);
    if (!citation) throw invalid();
    return { kind: 'citation', citation };
  }
  async function occurrenceAllowed(row: InventoryLimit) {
    if (common || row.versionId && citations.some((item) => item.versionId === row.versionId)) return true;
    if (facadeId && row.versionId) {
      const [accepted] = await acceptedOriginals(tx, projectId, { versionId: row.versionId });
      if (!accepted) return false;
      const links = await readDocumentFacadeLinks(tx, projectId, row.versionId);
      return links.some((link) => link.targetKey === 'document' && link.facadeId === facadeId && link.basis.sha256 === accepted.sha256);
    }
    if (!scopeId) return false;
    const result = await tx.query('SELECT 1 FROM intake_holds WHERE project_id=$1 AND receipt_id=$2 AND $3=ANY(scope_ids) LIMIT 1',
      [projectId, row.receiptId, scopeId]);
    return Boolean(result.rowCount);
  }
  if (input.kind === 'inventory') {
    const [row] = await inventoryLimits(tx, projectId, undefined, input.occurrenceId);
    if (!row || !await occurrenceAllowed(row)) throw invalid();
    if (row.inventoryRevision !== input.inventoryRevision) throw new AssessmentError(412, 'inventory_changed', 'Состав описи изменился. Сверьте ограничение.');
    return { kind: 'inventory', ...row };
  }
  const original = await verifyOriginalBasis(tx, projectId, input.versionId, input.anchor);
  if (facadeId) {
    const matching = await findDocumentFacadeLink(tx, projectId, original);
    const exact = facadePlaceKey(original.address);
    const cited = exact && citations.some((item) => {
      if (item.versionId !== original.versionId || !item.address) return false;
      const address = item.address as unknown as ReaderAddress;
      const page = original.address.locator?.page;
      return facadePlaceKey(address) === exact || page !== undefined && !address.locator?.page && String(page) === address.unitId;
    });
    if (matching ? matching.facadeId !== facadeId : !cited) throw invalid();
  } else if (!common && !citations.some((item) => item.versionId === original.versionId)) {
    const { rows } = await tx.query<{ receipt_id: string }>('SELECT DISTINCT receipt_id FROM intake_occurrences WHERE project_id=$1 AND version_id=$2', [projectId, original.versionId]);
    // A whole-project receipt can contain several facades. Only an explicit scope assignment qualifies here.
    const allowed = scopeId && (await tx.query('SELECT 1 FROM intake_holds WHERE project_id=$1 AND receipt_id=ANY($2::uuid[]) AND $3=ANY(scope_ids) LIMIT 1',
      [projectId, rows.map((row) => row.receipt_id), scopeId])).rowCount;
    if (!allowed) throw invalid();
  }
  return { kind: 'original', original };
}
