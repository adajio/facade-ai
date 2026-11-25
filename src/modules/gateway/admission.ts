import type { PoolClient } from 'pg';
import { acceptedOriginals } from '../intake/accepted-originals.js';
import { hash, positiveInteger, type ModelAuthorization } from './types.js';

export type SyntheticScope = {
  projectId: string;
  scopeId: string | null;
  approvalRef: string;
  originalSha256s: readonly string[];
  retentionApproval?: {
    approvalRef: string;
    noTrainingEvidenceRef: string;
    validUntil: string;
  };
};

export type CustomerScope = {
  projectId: string;
  approvalRef: string;
  allowImages: boolean;
} & (
  | { scopeId: string | null; originalSha256s: readonly string[]; acceptedProjectOriginals?: never }
  | { scopeId: null; acceptedProjectOriginals: true; originalSha256s?: never }
);

export type CustomerAccess = {
  keyFingerprint: string;
  evidenceRef: string;
  validUntil: string;
  scopes: readonly CustomerScope[];
};

const uuid = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
const sha256 = /^[a-f0-9]{64}$/;
const imageUrl = /^data:image\/png;base64,([A-Za-z0-9+/]+={0,2})$/;
const signature = Buffer.from('89504e470d0a1a0a', 'hex');

export function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function validScope(scope: Pick<SyntheticScope, 'projectId' | 'scopeId' | 'approvalRef'>) {
  return scope && typeof scope.projectId === 'string' && uuid.test(scope.projectId)
    && (scope.scopeId === null || (typeof scope.scopeId === 'string' && uuid.test(scope.scopeId)))
    && typeof scope.approvalRef === 'string' && Boolean(scope.approvalRef.trim());
}

function validOriginalPins(pins: unknown) {
  return Array.isArray(pins) && pins.length > 0
    && pins.every((digest: unknown) => typeof digest === 'string' && sha256.test(digest));
}

export function validSyntheticScopes(scopes: readonly SyntheticScope[] | undefined): boolean {
  return Array.isArray(scopes) && scopes.length > 0
    && scopes.every(scope => validScope(scope) && validOriginalPins(scope.originalSha256s));
}

export function syntheticScope(scopes: readonly SyntheticScope[] | undefined, projectId: string, scopeId: string | null) {
  return scopes?.find(item => item.projectId === projectId && item.scopeId === scopeId);
}

export function validCustomerAccess(access: CustomerAccess | undefined, apiKey: string): boolean {
  return Boolean(access && access.keyFingerprint === hash(apiKey)
    && typeof access.evidenceRef === 'string' && access.evidenceRef.trim()
    && Date.parse(access.validUntil) > Date.now() && Array.isArray(access.scopes) && access.scopes.length > 0
    && access.scopes.every(scope => validScope(scope) && typeof scope.allowImages === 'boolean'
      && (scope.acceptedProjectOriginals === true
        ? scope.scopeId === null && scope.originalSha256s === undefined
        : scope.acceptedProjectOriginals === undefined && validOriginalPins(scope.originalSha256s)))
    && new Set(access.scopes.map(scope => JSON.stringify([scope.projectId, scope.scopeId]))).size === access.scopes.length);
}

export function customerScope(access: CustomerAccess | undefined, projectId: string, scopeId: string | null) {
  return access && Date.parse(access.validUntil) > Date.now()
    ? access.scopes.find(scope => scope.projectId === projectId && scope.scopeId === scopeId)
    : undefined;
}

export function scopeAllowsOriginal(scope: SyntheticScope | CustomerScope, digest: string): boolean {
  return sha256.test(digest) && ((scope.originalSha256s?.includes(digest) ?? false) || 'acceptedProjectOriginals' in scope
    && scope.acceptedProjectOriginals === true);
}

export function requestHasImages(request: unknown): boolean {
  const messages = record(request)?.messages;
  return Array.isArray(messages) && messages.some(message => {
    const content = record(message)?.content;
    return Array.isArray(content) && content.some(part => record(part)?.type === 'image_url');
  });
}

export function pngBase64Length(url: unknown, profile: {
  maxImageBytes: number; maxImageWidth: number; maxImageHeight: number; maxImagePixels: number;
}): number | null {
  if (typeof url !== 'string') return null;
  const match = imageUrl.exec(url);
  if (!match || match[1].length > Math.ceil(profile.maxImageBytes / 3) * 4) return null;
  const png = Buffer.from(match[1], 'base64');
  if (png.length < 33 || png.length > profile.maxImageBytes || png.toString('base64') !== match[1]
    || !png.subarray(0,8).equals(signature) || png.readUInt32BE(8) !== 13
    || png.toString('ascii',12,16) !== 'IHDR') return null;
  const width = png.readUInt32BE(16);
  const height = png.readUInt32BE(20);
  if (!positiveInteger(width, profile.maxImageWidth) || !positiveInteger(height, profile.maxImageHeight)
    || width * height > profile.maxImagePixels) return null;

  let pixels = false;
  for (let offset = 33; offset + 12 <= png.length;) {
    const size = png.readUInt32BE(offset);
    const type = png.toString('ascii', offset + 4, offset + 8);
    offset += 12 + size;
    if (offset > png.length || ['acTL','fcTL','fdAT','IHDR'].includes(type)) return null;
    if (type === 'IDAT') pixels = true;
    if (type === 'IEND') return pixels && size === 0 && offset === png.length ? match[1].length : null;
  }
  return null;
}

function assignedSources(payload: unknown): Record<string, unknown>[] {
  const job = record(payload);
  const dispute = record(job?.dispute);
  const places = job?.mode === 'primary' ? [job.place]
    : job?.mode === 'lead' || job?.mode === 'verify' ? [record(dispute?.a)?.place, record(dispute?.b)?.place] : [];
  return places.map(place => record(record(place)?.source) ?? {});
}

export async function verifyApprovedResearchInputs(tx: PoolClient, context: ModelAuthorization, scope: SyntheticScope | CustomerScope,
  policyBlock?: (scope: SyntheticScope) => string | null,
) {
  const sources = assignedSources(context.payload);
  if (!sources.length || sources.some(source => source.projectId !== context.projectId
    || typeof source.versionId !== 'string' || !uuid.test(source.versionId)
    || typeof source.documentId !== 'string' || !uuid.test(source.documentId)
    || typeof source.sha256 !== 'string' || !scopeAllowsOriginal(scope, source.sha256))
    || context.inputRefs.some(id => !uuid.test(id))) return false;
  const evidenceIds = [...new Set(context.inputRefs)];
  if ('acceptedProjectOriginals' in scope && scope.acceptedProjectOriginals === true) {
    if (context.dataClass !== 'customer' || context.scopeId !== null) return false;
    const project = await tx.query('SELECT 1 FROM projects WHERE id=$1 AND intake_mode', [context.projectId]);
    if (!project.rowCount) return false;
    const evidence = await tx.query<{ versionId: string; sha256: string }>(
      `SELECT e.version_id AS "versionId", m.original_sha256 AS sha256 FROM reader_evidence e
       JOIN reader_maps m USING(project_id,version_id,reader_version)
       WHERE e.project_id=$1 AND e.run_id=$2 AND e.id=ANY($3::uuid[])`,
      [context.projectId, context.jobId, evidenceIds],
    );
    if (evidence.rowCount !== evidenceIds.length) return false;
    const originals = new Map<string, Awaited<ReturnType<typeof acceptedOriginals>>[number]>();
    for (const versionId of new Set([...sources.map(source => source.versionId as string), ...evidence.rows.map(row => row.versionId)])) {
      const [accepted] = await acceptedOriginals(tx, context.projectId, { versionId });
      if (!accepted) return false;
      originals.set(versionId, accepted);
    }
    if (sources.some(source => {
      const accepted = originals.get(source.versionId as string);
      return !accepted || accepted.documentId !== source.documentId || accepted.sha256 !== source.sha256;
    }) || evidence.rows.some(({ versionId, sha256 }) => originals.get(versionId)?.sha256 !== sha256)) return false;
    return true;
  }
  if (!scope.originalSha256s) return false;
  const blocked = policyBlock?.({ ...scope, originalSha256s: scope.originalSha256s });
  if (blocked) return blocked;

  const expected = sources.map(source => ({ version_id: source.versionId, document_id: source.documentId, sha256: source.sha256 }));
  const result = await tx.query<{ authorized: boolean }>(
    `SELECT
      NOT EXISTS (SELECT 1 FROM intake_originals WHERE project_id=$1 AND sha256<>ALL($2::text[]))
      AND (SELECT count(*) FROM jsonb_to_recordset($3::jsonb) src(version_id uuid,document_id uuid,sha256 text)
        JOIN intake_document_versions v ON v.project_id=$1 AND v.id=src.version_id AND v.document_id=src.document_id
        JOIN intake_originals o ON o.project_id=v.project_id AND o.id=v.original_id AND o.sha256=src.sha256)=$4
      AND (SELECT count(*) FROM reader_evidence e
        JOIN reader_maps m USING(project_id,version_id,reader_version)
        WHERE e.project_id=$1 AND e.run_id=$5 AND e.id=ANY($6::uuid[])
          AND m.original_sha256=ANY($2::text[]))=$7 AS authorized`,
    [context.projectId, scope.originalSha256s, JSON.stringify(expected), expected.length,
     context.jobId, evidenceIds, evidenceIds.length],
  );
  return result.rows[0].authorized;
}
