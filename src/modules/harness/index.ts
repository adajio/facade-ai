import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import type { Pool } from 'pg';
import type { WorkerContext } from '../../platform/worker-context.js';
import { sealManagedTestDatabase, toolHash } from '../../platform/runtime-boundary.js';
import { createFormatAdapters } from '../formats/index.js';
import { createGateway, createStep15Gateway, journalFromEnv, type OpenRouterProfile, type Step15Approval } from '../gateway/index.js';
import type { ModelTransport } from '../gateway/types.js';
import { startImports } from '../imports/index.js';
import { createIntakeStorage } from '../intake/blob.js';
import { createRuntimePdfService } from '../pdf/index.js';
import { isReaderId } from '../pdf/service.js';
import { ReaderError } from '../pdf/types.js';
import { createRuntimeInquiryPorts, processNextInquiry } from '../questions/index.js';
import { dispatchNext } from './dispatch.js';
import type { ResearchTask } from './contracts.js';
import { validateLivePolicy } from './live-policy.js';
import { loadResearchProfile, profileHold, researchSlot, type ResearchProfile } from './profile.js';
import { activatePackageProjects, dispatchPackagePair, packageModelAdmission, preparePackageMap } from './package-dispatch.js';
import { publication } from './publication.js';
import { schedulePackageReview } from './package-review.js';
import { reviewPairAdmission } from './review-pair.js';
import { connectReader } from './reader.js';
import { executeResearch, researchKind, resumeInterruptedResearch } from './runner.js';
import { resumeResearchStops } from './stops.js';

export { register } from './stops.js';
export { readPackageAnalysis, type PackageAnalysis } from './package-analysis.js';

function configuredApprovals(): OpenRouterProfile[] {
  try {
    const input: unknown = JSON.parse(process.env.FACADE_GATEWAY_STEP15_PROFILES ?? '[]');
    return Array.isArray(input) ? input.filter((item) => item && typeof item === 'object') : [];
  } catch {
    return [];
  }
}

interface ManagedTestOptions {
  transport: ModelTransport & { kind: 'managed' };
  profile: ResearchProfile;
  toolSha256: string;
}

function modelGateway(context: WorkerContext, external: ReturnType<typeof journalFromEnv>, profile: ResearchProfile, packageEnabled: boolean, packageProjects: readonly string[], test?: ManagedTestOptions) {
  const policyOptions = {
    researchAdmission: packageModelAdmission(packageEnabled, packageProjects, process.env.FACADE_HARNESS_PACKAGE_EFFECTS === 'enabled'),
    replayOnly: process.env.FACADE_HARNESS_REPLAY_ONLY === '1',
  };
  const localGateway = () => createGateway(context.db, { journal: external?.journal, reviewAdmission: reviewPairAdmission, ...policyOptions });
  if (test) {
    if (!external || process.env.FACADE_GATEWAY_LIVE_MODE || process.env.FACADE_GATEWAY_OPENROUTER_KEY) {
      throw new Error('Managed model tests require an isolated journal and disabled live gateway');
    }
    const gateway = createGateway(context.db, {
      journal: external.journal, transport: test.transport, reviewAdmission: reviewPairAdmission, ...policyOptions,
    });
    return { gateway, hasTransport: true, mode: 'managed-test', admit: (task: ResearchTask) => profileHold(profile, task) };
  }
  if (process.env.FACADE_GATEWAY_LIVE_MODE === 'step-15') {
    const apiKey = process.env.FACADE_GATEWAY_OPENROUTER_KEY;
    if (!external || !apiKey?.trim()) return {
      gateway: localGateway(), hasTransport: false, mode: 'disabled',
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
      createStep15Gateway(context.db, external.journal, { ...approval, profiles: policy.approvals }, reviewPairAdmission, policyOptions);
    const hasTransport = policy.approvals.length > 0;
    return { gateway, admit: policy.hold, hasTransport,
      mode: hasTransport ? policyOptions.replayOnly ? 'openrouter-replay' : 'openrouter-live' : 'disabled' };
  }
  return {
    gateway: localGateway(), hasTransport: false, mode: 'disabled',
    admit: (task: ResearchTask) => ({
      reason: 'research_gateway_unconfigured', nextAction: `Настроить разрешённый шлюз для ${researchSlot(task.job)}.`,
    }),
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

export async function startWorker(context: WorkerContext, test?: ManagedTestOptions): Promise<void> {
  const { db, logger, config } = context;
  const profile = test?.profile ?? loadResearchProfile();
  const packageMode = process.env.FACADE_HARNESS_PACKAGE_PRIMARY;
  const packageEnabled = packageMode !== 'legacy';
  const packageProjects = [...new Set((process.env.FACADE_HARNESS_PACKAGE_PROJECTS ?? '').split(',')
    .map((value) => value.trim()).filter(Boolean))];
  if (packageProjects.some((id) => !isReaderId(id))) throw new Error('Invalid FACADE_HARNESS_PACKAGE_PROJECTS');
  if (packageMode !== undefined && packageMode !== 'legacy') throw new Error('Invalid FACADE_HARNESS_PACKAGE_PRIMARY');
  const external = journalFromEnv();
  const controller = new AbortController();
  const signal = AbortSignal.any([context.signal, controller.signal]);
  const storage = createIntakeStorage(config.dataDir);
  const lanes: Promise<void>[] = [];
  let seal: Awaited<ReturnType<typeof sealManagedTestDatabase>> | undefined;

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
    const { gateway, admit, hasTransport, mode } = modelGateway(context, external, profile, packageEnabled, packageProjects, test);
    if (test) {
      if (test.transport.kind !== 'managed' || !/^[a-f0-9]{64}$/.test(test.toolSha256) ||
        Object.values(profile).some((slot) => slot && (slot.dataClass !== 'synthetic' || !slot.model.startsWith('managed/')))) {
        throw new Error('Invalid managed model test configuration');
      }
      seal = await sealManagedTestDatabase(db);
    }
    logger.info?.({ mode, toolSha256: test?.toolSha256 ?? await toolHash(new URL(import.meta.url)),
      ...(test && { replayOnly: process.env.FACADE_HARNESS_REPLAY_ONLY === '1', qualifiesProduction: false }) });
    if (packageEnabled) await activatePackageProjects(db, gateway, packageProjects);
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
      poll('dispatch', () => dispatchNext(db, gateway, service.map, profile, publish.onSeal, packageProjects)),
      poll('review', publish.readyReview),
      poll('questions', () => processNextInquiry(db, inquiry, signal)),
      startImports({ ...context, signal }, { storage }),
    );
    if (packageEnabled) lanes.push(
      poll('package map', () => preparePackageMap(db, gateway, service, packageProjects)),
      poll('package primary scheduler', () => dispatchPackagePair(db, gateway, profile)),
      poll('package review scheduler', () => schedulePackageReview(db, gateway, profile)),
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
    for (let lane = 0; lane < (hasTransport ? 3 : 1); lane++) {
      const workerId = randomUUID();
      lanes.push(poll('research', async () => {
        const work = await gateway.claim({ workerId, kinds: [researchKind], leaseMs: 30_000 });
        if (!work) return false;
        await executeResearch(work, {
          db, gateway, reader, admit, configured: (slot) => profile[slot],
          publishOutcome: publish.outcome, loadPriorOutcome: publish.loadPriorOutcome, unsettledPrior: publish.unsettledPrior,
          localLimits: ({ job }) => {
            const configured = profile[researchSlot(job)] ?? job.settings;
            return job.mode === 'primary' && job.packageWindow ? job.settings :
              { maxTurns: configured.maxTurns, maxKnownRejections: configured.maxKnownRejections };
          },
        }, signal);
        return true;
      }));
    }
    await Promise.all(lanes);
  } finally {
    controller.abort();
    await Promise.allSettled(lanes);
    seal?.release(true);
    storage.objects.close();
    await external?.close();
  }
}
