import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import type { Pool } from 'pg';
import type { WorkerContext } from '../../platform/worker-context.js';
import { createFormatAdapters } from '../formats/index.js';
import { createGateway, createStep15Gateway, journalFromEnv, type OpenRouterProfile, type Step15Approval } from '../gateway/index.js';
import { startImports } from '../imports/index.js';
import { createIntakeStorage } from '../intake/blob.js';
import { createRuntimePdfService } from '../pdf/index.js';
import { ReaderError } from '../pdf/types.js';
import { createRuntimeInquiryPorts, processNextInquiry } from '../questions/index.js';
import { dispatchNext } from './dispatch.js';
import type { ResearchTask } from './contracts.js';
import { validateLivePolicy } from './live-policy.js';
import { loadResearchProfile, profileHold, researchSlot, type ResearchProfile } from './profile.js';
import { publication } from './publication.js';
import { reviewPairAdmission } from './review-pair.js';
import { connectReader } from './reader.js';
import { executeResearch, researchKind, resumeInterruptedResearch } from './runner.js';
import { managedTransport } from './transport.js';
import { resumeResearchStops } from './stops.js';

export { register } from './stops.js';

function configuredApprovals(): OpenRouterProfile[] {
  try {
    const input: unknown = JSON.parse(process.env.FACADE_GATEWAY_STEP15_PROFILES ?? '[]');
    return Array.isArray(input) ? input.filter((item) => item && typeof item === 'object') : [];
  } catch {
    return [];
  }
}

function modelGateway(context: WorkerContext, external: ReturnType<typeof journalFromEnv>, profile: ResearchProfile) {
  const managed = process.env.FACADE_HARNESS_MANAGED_URL;
  const localGateway = () => createGateway(context.db, { journal: external?.journal, reviewAdmission: reviewPairAdmission });
  if (process.env.FACADE_GATEWAY_LIVE_MODE === 'step-15') {
    const apiKey = process.env.FACADE_GATEWAY_OPENROUTER_KEY;
    if (managed || !external || !apiKey?.trim()) return {
      gateway: localGateway(), online: true, hasTransport: false,
      admit: (task: ResearchTask) => ({
        reason: 'research_gateway_unconfigured',
        nextAction: `Проверить настройки шлюза для ${researchSlot(task.job)}.`,
      }),
    };
    const approval: Omit<Step15Approval, 'profiles'> = {
      qualification: 'step-15', apiKey,
      endpoint: (process.env.FACADE_GATEWAY_OPENROUTER_ENDPOINT ?? 'https://openrouter.ai') as Step15Approval['endpoint'],
    };
    const approvals = configuredApprovals();
    const policy = validateLivePolicy(profile, approvals, process.env, (route) => {
      if (!(Date.parse(route.validUntil) > Date.now()) ||
        approvals.filter(({ routeId, revision }) => routeId === route.routeId && revision === route.revision).length !== 1) {
        return false;
      }
      try {
        // Construction validates credentials and the route envelope without accessing the network or journal.
        createStep15Gateway(context.db, external.journal, { ...approval, profiles: [route] });
        return true;
      } catch {
        return false;
      }
    });
    const gateway = policy.approvals.length === 0 ? localGateway() :
      createStep15Gateway(context.db, external.journal, { ...approval, profiles: policy.approvals }, reviewPairAdmission);
    return { gateway, admit: policy.hold, online: true, hasTransport: policy.approvals.length > 0 };
  }
  if (managed && !external) throw new Error('Managed gateway requires a separate intent journal');
  const gateway = managed && external
    ? createGateway(context.db, { journal: external.journal, transport: managedTransport(managed), reviewAdmission: reviewPairAdmission })
    : localGateway();
  return {
    gateway, admit: (task: ResearchTask) => profileHold(profile, task),
    online: Boolean(managed), hasTransport: Boolean(managed),
  };
}

async function withReaderSlot<T>(db: Pool, work: () => Promise<T>): Promise<T> {
  const tx = await db.connect();
  let acquired = false;
  let discard = false;
  try {
    const { rows: [slot] } = await tx.query<{ acquired: boolean }>(
      "SELECT pg_try_advisory_lock(hashtextextended('facade/heavy-local-slot',0)) AS acquired");
    acquired = slot.acquired;
    if (!acquired) throw new ReaderError('reader_resource_wait', 'Reader slot is busy', 503);
    return await work();
  } finally {
    if (acquired) {
      try {
        await tx.query("SELECT pg_advisory_unlock(hashtextextended('facade/heavy-local-slot',0))");
      } catch {
        discard = true;
      }
    }
    tx.release(discard);
  }
}

export async function startWorker(context: WorkerContext): Promise<void> {
  const { db, logger, config } = context;
  const profile = loadResearchProfile();
  const external = journalFromEnv();
  const controller = new AbortController();
  const signal = AbortSignal.any([context.signal, controller.signal]);
  const storage = createIntakeStorage(config.dataDir);
  const lanes: Promise<void>[] = [];

  async function poll(name: string, next: () => Promise<boolean>, once = false) {
    while (!signal.aborted) {
      try {
        if (await next()) {
          if (once) return;
          continue;
        }
      } catch (error) {
        if (signal.aborted) return;
        const code = (error as { code?: unknown } | null)?.code;
        const detail = typeof code === 'string' && /^[A-Z0-9]{5}$/.test(code) ? ` (PostgreSQL ${code})` : '';
        logger.warn(`Worker lane ${name} will retry after an operational failure${detail}`);
      }
      await delay(700, undefined, { signal }).catch(() => undefined);
    }
  }

  try {
    const { gateway, admit, online, hasTransport } = modelGateway(context, external, profile);
    const base = createRuntimePdfService(db, config, { storage, adapters: createFormatAdapters() });
    const service = {
      ...base,
      map: (...args: Parameters<typeof base.map>) => withReaderSlot(db, () => base.map(...args)),
      open: (...args: Parameters<typeof base.open>) => withReaderSlot(db, () => base.open(...args)),
    };
    const publish = publication(db, gateway, profile);
    const reader = connectReader(db, service, publish.observation);
    const inquiry = createRuntimeInquiryPorts(db, service, storage.objects);
    lanes.push(
      poll('dispatch', () => dispatchNext(db, gateway, service.map, profile, publish.onSeal)),
      poll('review', publish.readyReview),
      poll('questions', () => processNextInquiry(db, inquiry, signal)),
      startImports({ ...context, signal }, { storage }),
    );
    if (hasTransport && external) {
      lanes.push(poll('research continuation', () => resumeResearchStops(db, gateway)));
      lanes.push(poll('research recovery', async () => {
        if ((await external.journal.balance()).frozen) return false;
        await gateway.syncRouteIsolations();
        await resumeInterruptedResearch(db, gateway, signal);
        return true;
      }, true));
    }
    for (let lane = 0; online && lane < 3; lane++) {
      const workerId = randomUUID();
      lanes.push(poll('research', async () => {
        const work = await gateway.claim({ workerId, kinds: [researchKind], leaseMs: 30_000 });
        if (!work) return false;
        await executeResearch(work, {
          db, gateway, reader, admit, configured: (slot) => profile[slot],
          publishOutcome: publish.outcome, loadPriorOutcome: publish.loadPriorOutcome, unsettledPrior: publish.unsettledPrior,
          localLimits: ({ job }) => {
            const configured = profile[researchSlot(job)] ?? job.settings;
            return { maxTurns: configured.maxTurns, maxKnownRejections: configured.maxKnownRejections };
          },
        }, signal);
        return true;
      }));
    }
    await Promise.all(lanes);
  } finally {
    controller.abort();
    await Promise.allSettled(lanes);
    storage.objects.close();
    await external?.close();
  }
}
