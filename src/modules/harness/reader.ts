import type { Pool, PoolClient } from 'pg';
import { occurrenceScope, occurrenceScopeJoin } from './occurrence-scope.js';
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
  publish: (tx: PoolClient, context: ReaderContext, input: ObservationInput, observation: Observation) => Promise<void>,
): ReaderPort {
  async function contextPlaces({ task, branch }: ReaderContext, id: string | null, offset: number) {
    if (task.job.mode !== 'primary') return [];
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

  return {
    async contexts(context, offset) {
      const rows = await contextPlaces(context, null, offset);
      return { items: rows.slice(0, 32), ...(rows.length > 32 ? { nextOffset: offset + 32 } : {}) };
    },
    async openContext(context, id, representation) {
      const [authorized] = await contextPlaces(context, id, 0);
      if (!authorized) throw new ReaderRefusal('context_window_unavailable', 'permanent');
      const { place } = authorized;
      try {
        const { evidence, bytes } = await service.open(place.source, executionScope(context), {
          address: { unitId: place.unitId, ...(place.box ? { box: place.box } : {}) }, representation,
        });
        if (evidence.source.versionId !== place.source.versionId || evidence.source.sha256 !== place.source.sha256
          || evidence.address.unitId !== place.unitId || evidence.mediaType !== 'application/json') {
          throw new ReaderRefusal('context_window_unavailable', 'permanent');
        }
        return { evidenceId: evidence.id, place, readerVersion: evidence.readerVersion, sha256: evidence.sha256,
          mediaType: evidence.mediaType, bytes, limitations: evidence.limitations };
      } catch (error) {
        return refusal(error);
      }
    },
    async inventory(context) {
      if (context.task.job.mode !== 'primary') {
        const { a, b } = context.task.job.dispute;
        return [{ support: 'A', place: a.place }, { support: 'B', place: b.place }];
      }
      const { place } = context.task.job;
      try {
        const map = await service.map(place.source);
        return { place, format: map.format, units: map.units.slice(0, 200), totalUnits: map.units.length };
      } catch (error) {
        return refusal(error);
      }
    },
    async next({ task, branch }) {
      if (task.job.mode !== 'primary') return null;
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
          address, representation, ...(request.kind === 'zoom' ? { dpi: 200 } : {}),
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
      const { evidence, alternatives, sourceRole, components, ...observation } = input;
      const limitation = alternatives
        ? [observation.limitation, ...alternatives].filter(Boolean).join(' · ').slice(0, 500)
        : observation.limitation;
      try {
        const pinned = await service.pin(evidence.place.source, executionScope(context), {
          ...observation, scope: context.task.scopeId, evidenceId: evidence.evidenceId, ...(limitation ? { limitation } : {}),
        }, tx, components);
        await publish(tx, context, { ...input, sourceRole }, pinned);
        return { observationId: pinned.id };
      } catch (error) {
        return refusal(error);
      }
    },
  };
}
