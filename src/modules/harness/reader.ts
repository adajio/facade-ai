import type { Pool, PoolClient } from 'pg';
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
  return {
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
      const { evidence, alternatives, sourceRole, ...observation } = input;
      const limitation = alternatives
        ? [observation.limitation, ...alternatives].filter(Boolean).join(' · ').slice(0, 500)
        : observation.limitation;
      try {
        const pinned = await service.pin(evidence.place.source, executionScope(context), {
          ...observation, scope: context.task.scopeId, evidenceId: evidence.evidenceId, ...(limitation ? { limitation } : {}),
        }, tx);
        await publish(tx, context, { ...input, sourceRole }, pinned);
        return { observationId: pinned.id };
      } catch (error) {
        return refusal(error);
      }
    },
  };
}
