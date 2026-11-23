import type { Pool, PoolClient } from 'pg';
import type { PackageMetadataReceipt } from './package-observation.js';
import { occurrenceScope, occurrenceScopeJoin } from './occurrence-scope.js';
import { packageStructure, savePackageBlocks, saveSemanticCheck } from './package-walk.js';
import { authorizedPackageReview } from './package-review.js';
import { authorizedPackageWindow } from './package-dispatch.js';
import type { createRuntimePdfService } from '../pdf/index.js';
import { contains, ReaderError, type ReaderAddress, type Observation, type Representation as ReaderMode } from '../pdf/types.js';
import {
  ReaderRefusal, type ObservationInput, type Place, type ReadRequest, type ReaderContext,
  type ReaderPort, type Representation,
} from './contracts.js';

export type ReaderService = ReturnType<typeof createRuntimePdfService>;

const mediaTypes = new Set<Representation['mediaType']>([
  'application/json', 'text/plain', 'image/png', 'image/jpeg', 'image/webp',
]);

function refusal(error: unknown): never {
  if (!(error instanceof ReaderError)) throw error;
  throw new ReaderRefusal(error.code, error.statusCode >= 500 || error.statusCode === 429 ? 'temporary' : 'permanent');
}

function assignedPlace({ task }: ReaderContext, support?: 'A' | 'B'): Place {
  return task.job.mode === 'primary' ? task.job.place : (support === 'A' ? task.job.dispute.a : task.job.dispute.b).place;
}

function executionScope(context: ReaderContext) {
  return { runId: context.task.jobId, branch: context.branch, operationKey: context.effectKey };
}

export function connectReader(
  db: Pool, service: ReaderService,
  publish: (tx: PoolClient, context: ReaderContext, input: ObservationInput, observation: Observation) => Promise<void | PackageMetadataReceipt>,
): ReaderPort {
  async function checkPackage(context: ReaderContext, connection: Pool | PoolClient = db, support?: 'A' | 'B') {
    const { task, branch } = context;
    if (task.scopeId !== null) return undefined;
    if (task.job.mode !== 'primary') {
      if (task.job.packageReview && await authorizedPackageReview(connection, task.projectId, task.generationId, task.job, task.jobId)) {
        return support ? task.job.packageReview.readerVersions[support] : undefined;
      }
      throw new ReaderRefusal('analysis_input_denied', 'permanent');
    }
    if (!task.job.packageWindow ||
      !await authorizedPackageWindow(connection, { id: task.jobId, projectId: task.projectId,
        generationId: task.generationId, branch, place: task.job.place,
        windowId: task.job.packageWindow.id, readerVersion: task.job.packageWindow.readerVersion })) {
      throw new ReaderRefusal('analysis_input_denied', 'permanent');
    }
    return task.job.packageWindow.readerVersion;
  }

  async function contextPlaces(context: ReaderContext, id: string | null, offset: number) {
    const {task,branch}=context;
    if (task.job.mode !== 'primary') return [];
    if (task.scopeId === null) {
      if(!task.job.packageWindow?.walkProtocol) return [];
      await checkPackage(context);
      const {rows}=await db.query<{ id:string;place:Place;format:string }>(
        `SELECT w.id,w.place,m.format
         FROM harness_package_windows w JOIN harness_package_maps m ON m.version_id=w.version_id AND m.fingerprint=w.map_fingerprint AND m.active
         JOIN harness_package_windows anchor ON anchor.id=$1 AND anchor.version_id=w.version_id AND anchor.map_fingerprint=w.map_fingerprint
         WHERE w.project_id=$2 AND m.reader_version=$3 AND ($4::uuid IS NULL OR w.id=$4)
         ORDER BY abs(w.ordinal-anchor.ordinal),w.ordinal LIMIT 33 OFFSET $5`,
        [task.job.packageWindow.id,task.projectId,task.job.packageWindow.readerVersion,id,offset]);
      return rows;
    }
    const { rows } = await db.query<{ id: string; place: Place; format: string }>(
      `SELECT hp.obligation_id AS id,hp.place,m.format FROM harness_primary_places hp
       JOIN gateway_generations g USING(generation_id) JOIN harness_document_maps m ON m.version_id=hp.version_id
       JOIN gateway_jobs j ON j.generation_id=hp.generation_id AND j.obligation_id=hp.obligation_id::text
       WHERE g.current AND g.project_id=$1 AND g.scope_id=$2 AND g.generation_id=$3 AND hp.branch=$4
       AND hp.question_id IS NOT DISTINCT FROM $5::uuid AND j.id<>$6 AND NOT (j.payload ? 'localRefusal')
       AND ($7::uuid IS NULL OR hp.obligation_id=$7) AND EXISTS (
         SELECT 1 FROM intake_occurrences c ${occurrenceScopeJoin}
         WHERE c.project_id=$1 AND c.version_id=hp.version_id AND ($2=ANY(${occurrenceScope}) OR ${occurrenceScope} IS NULL))
       ORDER BY m.format,hp.version_id,hp.unit_key,hp.obligation_id LIMIT 33 OFFSET $8`,
      [task.projectId, task.scopeId, task.generationId, branch, task.job.question?.id ?? null, task.jobId, id, offset]);
    return rows;
  }

  async function reviewWindows({ task }: ReaderContext, id: string | null, offset: number) {
    if (!task.earlyPair || task.job.mode === 'primary') return [];
    if (task.scopeId === null) {
      if (!task.job.packageReview || !await authorizedPackageReview(db, task.projectId, task.generationId, task.job, task.jobId)) return [];
      const { a, b } = task.job.dispute;
      const { rows } = await db.query<{ id: string; place: Place; support: 'A' | 'B'; format: string }>(
        `SELECT w.id,w.place,m.format,CASE WHEN w.version_id=$2 THEN 'A' ELSE 'B' END AS support
         FROM harness_package_windows w JOIN harness_package_maps m ON m.version_id=w.version_id AND m.fingerprint=w.map_fingerprint AND m.active
         WHERE w.project_id=$1 AND w.version_id IN ($2,$3) AND ($4::uuid IS NULL OR w.id=$4)
         ORDER BY w.ordinal,support,w.id LIMIT 33 OFFSET $5`, [task.projectId,a.place.source.versionId,b.place.source.versionId,id,offset]);
      return rows;
    }
    const { rows } = await db.query<{ id: string; place: Place; support: 'A' | 'B'; format: string }>(
      `SELECT hp.obligation_id AS id,hp.place,hp.branch AS support,m.format
       FROM harness_live_review_pairs d
       JOIN harness_primary_places hp ON hp.generation_id=d.generation_id AND hp.question_id=d.question_id
         AND hp.version_id::text=CASE hp.branch WHEN 'A' THEN d.a#>>'{citation,versionId}' ELSE d.b#>>'{citation,versionId}' END
       JOIN harness_document_maps m ON m.version_id=hp.version_id AND m.project_id=d.project_id
       JOIN gateway_jobs j ON j.generation_id=hp.generation_id AND j.obligation_id=hp.obligation_id::text
       WHERE d.id=$1 AND d.generation_id=$2 AND d.project_id=$3 AND d.scope_id=$4 AND d.independent_sources
         AND NOT (j.payload ? 'localRefusal') AND ($5::uuid IS NULL OR hp.obligation_id=$5)
         AND EXISTS (SELECT 1 FROM intake_occurrences c ${occurrenceScopeJoin}
           WHERE c.project_id=d.project_id AND c.version_id=hp.version_id AND c.state='accepted'
             AND (d.scope_id=ANY(${occurrenceScope}) OR ${occurrenceScope} IS NULL))
       ORDER BY coalesce((hp.place->>'page')::int,0),hp.branch,hp.unit_key,hp.obligation_id
       LIMIT 33 OFFSET $6`, [task.job.dispute.id, task.generationId, task.projectId, task.scopeId, id, offset],
    );
    return rows;
  }

  return {
    async structure(context,tx) {
      await checkPackage(context,tx);
      return packageStructure(tx??db,context);
    },
    async checkBlocks(tx,context,checks) {
      await checkPackage(context,tx);
      await savePackageBlocks(tx,context,checks);
    },
    async checkSemantics(tx,context,check) {
      await checkPackage(context,tx);
      await saveSemanticCheck(tx,context,check);
    },
    async contexts(context, offset) {
      const rows = context.task.job.mode === 'primary' ? await contextPlaces(context, null, offset) :
        await reviewWindows(context, null, offset);
      return { items: rows.slice(0, 32), ...(rows.length > 32 ? { nextOffset: offset + 32 } : {}) };
    },
    async openContext(context, id, representation, box) {
      const [authorized] = context.task.job.mode === 'primary'
        ? await contextPlaces(context, id, 0) : await reviewWindows(context, id, 0);
      if (!authorized) throw new ReaderRefusal('context_window_unavailable', 'permanent');
      const { place } = authorized;
      if (box && place.box && !contains(place.box,box)) throw new ReaderRefusal('outside_assigned_window','permanent');
      try {
        const support = 'support' in authorized ? authorized.support as 'A' | 'B' : undefined;
        const readerVersion = await checkPackage(context, db, support);
        const { evidence, bytes } = await service.open(place.source, executionScope(context), {
          address: { unitId: place.unitId, box:box??place.box }, representation, readerVersion,
          ...(representation==='render' && box ? { dpi:200 } : {}),
        });
        if (evidence.source.versionId !== place.source.versionId || evidence.source.sha256 !== place.source.sha256
          || evidence.address.unitId !== place.unitId || !mediaTypes.has(evidence.mediaType as Representation['mediaType'])) {
          throw new ReaderRefusal('context_window_unavailable', 'permanent');
        }
        return { evidenceId: evidence.id, place:{ ...place,box:evidence.address.box ?? place.box }, readerVersion: evidence.readerVersion, sha256: evidence.sha256,
          mediaType: evidence.mediaType as Representation['mediaType'], bytes, limitations: evidence.limitations,transform:evidence.transform,
          ...('support' in authorized ? { support: authorized.support as 'A' | 'B' } : {}) };
      } catch (error) {
        return refusal(error);
      }
    },
    async inventory(context) {
      if (context.task.job.mode !== 'primary') {
        await checkPackage(context);
        const { a, b } = context.task.job.dispute;
        return [{ support: 'A', place: a.place }, { support: 'B', place: b.place }];
      }
      const { place } = context.task.job;
      try {
        const expected = await checkPackage(context);
        const map = await service.map(place.source);
        if (expected && expected !== map.readerVersion) throw new ReaderRefusal('reader_profile_changed', 'temporary');
        return { place, format: map.format, units: map.units.slice(0, 200), totalUnits: map.units.length };
      } catch (error) {
        return refusal(error);
      }
    },
    async next({ task, branch }) {
      if (task.scopeId === null || task.job.mode !== 'primary') return null;
      const { rows: [row] } = await db.query<{ place: Place }>(
        `SELECT hp.place FROM harness_primary_places hp
         JOIN gateway_jobs j ON j.generation_id=hp.generation_id AND j.obligation_id=hp.obligation_id::text
         WHERE hp.generation_id=$1 AND hp.branch=$2 AND hp.question_id IS NOT DISTINCT FROM $3::uuid
           AND j.id<>$4 AND j.state IN ('ready','leased')
         ORDER BY hp.version_id IS DISTINCT FROM $5::uuid,j.created_at,j.id LIMIT 1`,
        [task.generationId, branch, task.job.question?.id ?? null, task.jobId, task.job.place.source.versionId]);
      return row?.place ?? null;
    },
    async read(context, request: ReadRequest) {
      const readerVersion = await checkPackage(context, db, request.support);
      const place = assignedPlace(context, request.support);
      const box = ('box' in request ? request.box : undefined) ?? place.box;
      if (place.box && box && !contains(place.box, box)) {
        throw new ReaderRefusal('outside_assigned_window', 'permanent');
      }
      const address: ReaderAddress = { unitId: place.unitId, ...(box ? { box } : {}) };
      const representation: ReaderMode = request.kind === 'zoom' || request.kind === 'survey'
        ? 'render' : request.kind === 'ocr' ? 'ocr' : 'native';
      try {
        const view = await service.open(place.source, executionScope(context), {
          address, representation, readerVersion, ...(request.kind === 'zoom' ? { dpi: 200 } : {}),
        });
        const evidence = view.evidence;
        const mediaType = evidence.mediaType as Representation['mediaType'];
        if (!mediaTypes.has(mediaType)) throw new ReaderRefusal('unsupported_media_type', 'permanent');
        const limitations = [...evidence.limitations];
        if (request.kind === 'search') {
          const text = view.bytes.toString('utf8').normalize('NFKC').toLocaleLowerCase('ru');
          const query = request.query.normalize('NFKC').toLocaleLowerCase('ru');
          if (!text.includes(query)) limitations.push('no_text_match_in_assigned_unit');
        }
        return {
          evidenceId: evidence.id, readerVersion: evidence.readerVersion, mediaType, sha256: evidence.sha256,
          place: {
            source: evidence.source, unitId: evidence.address.unitId,
            ...(place.page ? { page: place.page } : {}), ...(evidence.address.box ? { box: evidence.address.box } : {}),
          },
          bytes: view.bytes, transform: evidence.transform, limitations,
        };
      } catch (error) {
        return refusal(error);
      }
    },
    async record(tx, context, input) {
      const readerVersion = await checkPackage(context, tx);
      const { evidence, alternatives, sourceRole, components, package: metadata, ...observation } = input;
      if (readerVersion && evidence.readerVersion !== readerVersion) throw new ReaderRefusal('reader_profile_changed', 'temporary');
      const limitation = alternatives
        ? [observation.limitation, ...alternatives].filter(Boolean).join(' · ').slice(0, 500)
        : observation.limitation;
      try {
        const pinned = await service.pin(evidence.place.source, executionScope(context), {
          ...observation, scope: context.task.scopeId, evidenceId: evidence.evidenceId, ...(limitation ? { limitation } : {}),
        }, tx, components);
        const packageMetadata = await publish(tx, context, input, pinned);
        return { observationId: pinned.id, ...(packageMetadata ? { packageMetadata } : {}) };
      } catch (error) {
        return refusal(error);
      }
    },
  };
}
