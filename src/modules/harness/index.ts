import { packagePreparationSweep } from './package-preparation.js';
import { createCopilotMemory, createCopilotResearch, copilotKind, copilotModelAdmission, processNextCopilot } from '../copilot/index.js';
import type { CopilotRoute } from '../copilot/worker.js';
import { indexNextProjectMemory } from '../project-memory/index.js';
import { dispatchPackageFollowup, packageFollowupKind, scanPackageStructure } from './package-walk.js';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import type { Pool } from 'pg';
import type { WorkerContext } from '../../platform/worker-context.js';
import { releaseManagedTestDatabase, sealManagedTestDatabase, toolHash } from '../../platform/runtime-boundary.js';
import { createFormatAdapters } from '../formats/index.js';
import { createGateway, createLiveGateway, journalFromEnv, type CheaperInferenceProfile, type FeatherlessProfile, type OpenRouterProfile, type Step15Approval } from '../gateway/index.js';
import { approvalIsCurrent } from '../gateway/admission.js';
import { provisionCustomerProjects, type CustomerRouteGrant } from './customer-projects.js';
import type { ModelTransport } from '../gateway/types.js';
import { startImports } from '../imports/index.js';
import { createIntakeStorage } from '../intake/blob.js';
import { createRuntimePdfService } from '../pdf/index.js';
import { isReaderId } from '../pdf/service.js';
import { ReaderError } from '../pdf/types.js';
import { createRuntimeInquiryPorts, processNextInquiry } from '../questions/index.js';
import { dispatchNext } from './dispatch.js';
import { settingsSchema, type ResearchTask } from './contracts.js';
import { validateLivePolicy } from './live-policy.js';
import { loadResearchProfile, profileHold, researchSlot, type ResearchProfile } from './profile.js';
import { activatePackageProjects, dispatchPackagePair, packageModelAdmission, preparePackageMap } from './package-dispatch.js';
import { publication } from './publication.js';
import { schedulePackageReview } from './package-review.js';
import { reviewPairAdmission } from './review-pair.js';
import { connectReader } from './reader.js';
import { executeResearch, researchKind, resumeInterruptedResearch } from './runner.js';
import { resumeResearchStops } from './stops.js';
import { reconcileNextFacadeDiscovery } from './facade-discovery.js';

export { register } from './stops.js';
export { readPackageAnalysis, type PackageAnalysis } from './package-analysis.js';

type RouterApproval = OpenRouterProfile & { transport?: 'openrouter' };
type LiveApproval = RouterApproval | CheaperInferenceProfile | FeatherlessProfile;

function configuredApprovals(): LiveApproval[] {
  const read = (input: string | undefined): LiveApproval[] => {
    try {
      const parsed: unknown = JSON.parse(input ?? '[]');
      return Array.isArray(parsed) ? parsed.filter(item => item && typeof item === 'object') : [];
    } catch {
      return [];
    }
  };
  return [
    ...read(process.env.FACADE_GATEWAY_STEP15_PROFILES).filter(item => item.transport === undefined || item.transport === 'openrouter'),
    ...read(process.env.FACADE_GATEWAY_CHEAPERINFERENCE_PROFILES).filter(item => item.transport === 'cheaperinference'),
    ...read(process.env.FACADE_GATEWAY_FEATHERLESS_PROFILES).filter(item => item.transport === 'featherless'),
  ];
}

interface ManagedTestOptions {
  transport: ModelTransport & { kind: 'managed' };
  profile: ResearchProfile;
  toolSha256: string;
}

function configuredCopilot(): CopilotRoute | null {
  try {
    const value:unknown=JSON.parse(process.env.FACADE_COPILOT_PROFILE??'null');
    if(!value||typeof value!=='object')return null;
    const parsed=settingsSchema.safeParse({...value,maxTurns:8,maxKnownRejections:1});
    if(!parsed.success)return null;
    const {routeId,model,dataClass,maxTokens,toolChoice}=parsed.data;
    return {routeId,model,dataClass,maxTokens,toolChoice};
  } catch {return null;}
}

function modelGateway(context: WorkerContext, external: ReturnType<typeof journalFromEnv>, profile: ResearchProfile, packageEnabled: boolean, packageProjects: readonly string[], reader: () => ReturnType<typeof createRuntimePdfService> | undefined, test?: ManagedTestOptions) {
  const packageAdmission=packageModelAdmission(packageEnabled,packageProjects,process.env.FACADE_HARNESS_PACKAGE_EFFECTS==='enabled',reader);
  const copilotAdmission=copilotModelAdmission();
  const reviewAdmission:typeof reviewPairAdmission=async (tx,work)=>work.kind===copilotKind?'early':reviewPairAdmission(tx,work);
  const policyOptions = {
    researchAdmission: ((tx,work,route,input)=>work.kind===copilotKind?copilotAdmission(tx,work,route,input):packageAdmission(tx,work,route,input)) as typeof packageAdmission,
    replayOnly: process.env.FACADE_HARNESS_REPLAY_ONLY === '1',
  };
  const localGateway = () => createGateway(context.db, { journal: external?.journal, reviewAdmission, ...policyOptions });
  if (test) {
    if (!external || process.env.FACADE_GATEWAY_LIVE_MODE || process.env.FACADE_GATEWAY_OPENROUTER_KEY
      || process.env.FACADE_GATEWAY_CHEAPERINFERENCE_KEY || process.env.FACADE_GATEWAY_FEATHERLESS_KEY) {
      throw new Error('Managed model tests require an isolated journal and disabled live gateway');
    }
    const gateway = createGateway(context.db, {
      journal: external.journal, transport: test.transport, reviewAdmission, ...policyOptions,
    });
    return { gateway, hasTransport: true, mode: 'managed-test', admit: (task: ResearchTask) => profileHold(profile, task) };
  }
  if (process.env.FACADE_GATEWAY_LIVE_MODE === 'step-15') {
    const routerKey = process.env.FACADE_GATEWAY_OPENROUTER_KEY;
    const directKey = process.env.FACADE_GATEWAY_CHEAPERINFERENCE_KEY;
    const featherlessKey = process.env.FACADE_GATEWAY_FEATHERLESS_KEY;
    if (!external || ![routerKey, directKey, featherlessKey].some(key => key?.trim())) return {
      gateway: localGateway(), hasTransport: false, mode: 'disabled',
      admit: (task: ResearchTask) => ({
        reason: 'research_gateway_unconfigured',
        nextAction: `Проверить настройки шлюза для ${researchSlot(task.job)}.`,
      }),
    };
    const approvals = configuredApprovals();
    function enabledFor(profiles: readonly LiveApproval[]): Parameters<typeof createLiveGateway>[2] {
      const openRouter = profiles.filter((route): route is RouterApproval => route.transport === undefined || route.transport === 'openrouter');
      const cheaperInference = profiles.filter((route): route is CheaperInferenceProfile => route.transport === 'cheaperinference');
      const featherless = profiles.filter((route): route is FeatherlessProfile => route.transport === 'featherless');
      return {
        ...(openRouter.length && { openRouter: {
          qualification: 'step-15', apiKey: routerKey ?? '', profiles: openRouter,
          qwen4CustomerApiKey: process.env.FACADE_GATEWAY_OPENROUTER_QWEN4_KEY,
          endpoint: (process.env.FACADE_GATEWAY_OPENROUTER_ENDPOINT ?? 'https://openrouter.ai') as Step15Approval['endpoint'],
        } }),
        ...(cheaperInference.length && { cheaperInference: { apiKey: directKey ?? '', profiles: cheaperInference } }),
        ...(featherless.length && { featherless: { apiKey: featherlessKey ?? '', profiles: featherless } }),
      };
    }
    const usable = (route: LiveApproval) => {
      if (!approvalIsCurrent(route.validUntil) ||
        approvals.filter(({ routeId, revision }) => routeId === route.routeId && revision === route.revision).length !== 1) {
        return false;
      }
      try {
        createLiveGateway(context.db, external.journal, enabledFor([route]));
        return true;
      } catch {
        return false;
      }
    };
    const qualified = approvals.filter(usable);
    const policy = validateLivePolicy(profile, qualified);
    const copilot = configuredCopilot();
    const copilotPolicy = copilot ? validateLivePolicy({ A: null, B: null, lead: { ...copilot, maxTurns: 8, maxKnownRejections: 1 } },
      qualified) : null;
    // Retain the transports for existing assignments authorized by a still-qualified approval.
    const enabled = enabledFor(qualified);
    const hasTransport = qualified.length > 0;
    const gateway = hasTransport
      ? createLiveGateway(context.db, external.journal, enabled, reviewAdmission, policyOptions) : localGateway();
    const defaultCustomerGrants = policy.approvals.flatMap<CustomerRouteGrant>(({ routeId, revision, customerAccess }) => {
      if (!customerAccess?.defaultProjectScope) return [];
      const primary = routeId === profile.A?.routeId ? 'primary_a' : routeId === profile.B?.routeId ? 'primary_b' : null;
      const review: CustomerRouteGrant = { routeId, revision, purpose: 'review', access: customerAccess };
      return primary ? [{ ...review, purpose: primary }, review] : [review];
    });
    const providers = [...new Set(qualified.map(route => route.transport ?? 'openrouter'))];
    const provider = providers.length > 1 ? 'mixed' : providers[0];
    return { gateway, admit: policy.hold, hasTransport, defaultCustomerGrants, copilotRoute: copilotPolicy?.approvals.length ? copilot : null,
      mode: hasTransport ? provider + (policyOptions.replayOnly ? '-replay' : '-live') : 'disabled' };
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

/** Use the same heavy-reader slot as archive extraction in every worker profile. */
export function withSharedReaderSlot(db:Pool, base:ReturnType<typeof createRuntimePdfService>) {
  return {
    ...base,
    map: (...args: Parameters<typeof base.map>) => withReaderSlot(db, () => base.map(...args)),
    open: (...args: Parameters<typeof base.open>) => withReaderSlot(db, () => base.open(...args)),
  };
}

export async function startWorker(context: WorkerContext, test?: ManagedTestOptions): Promise<void> {
  const { db, logger, config } = context;
  const profile = test?.profile ?? loadResearchProfile();
  const packageMode = process.env.FACADE_HARNESS_PACKAGE_PRIMARY;
  const packageEnabled = packageMode !== 'legacy';
  const walkOverride = process.env.FACADE_HARNESS_PACKAGE_WALK;
  if (walkOverride !== undefined && walkOverride !== '0' && walkOverride !== '1') {
    throw new Error('Invalid FACADE_HARNESS_PACKAGE_WALK');
  }
  const newWalkJobs = walkOverride === undefined ? undefined : walkOverride === '1';
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
    let runtimeReader: ReturnType<typeof createRuntimePdfService> | undefined;
    const { gateway, admit, hasTransport, mode, copilotRoute, defaultCustomerGrants } = modelGateway(context, external, profile, packageEnabled, packageProjects, () => runtimeReader, test);
    const allowProfileScans=packageEnabled&&hasTransport&&process.env.FACADE_HARNESS_PACKAGE_EFFECTS==='enabled'&&
      process.env.FACADE_HARNESS_REPLAY_ONLY!=='1';
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
    runtimeReader = base;
    const service = withSharedReaderSlot(db,base);
    const publish = publication(db, gateway, profile);
    const reader = connectReader(db, service, publish.observation);
    const inquiry = createRuntimeInquiryPorts(db, service, storage.objects);
    const localReads=[
      ()=>dispatchNext(db,gateway,service.map,profile,publish.onSeal,packageProjects),
      ()=>indexNextProjectMemory(db,base,signal),
      ...(packageEnabled?[
        ()=>preparePackageMap(db,gateway,service,packageProjects),
        packagePreparationSweep(db,service),
        ()=>scanPackageStructure(db,service),
        ()=>reconcileNextFacadeDiscovery(db),
      ]:[]),
    ];
    let nextLocal=0;
    const copilot={db,gateway,workerId:randomUUID(),route:copilotRoute??null,
      memory:createCopilotMemory(db,()=>service),research:createCopilotResearch(db,service)};
    lanes.push(poll('reader availability', async () => {
      await db.query(`INSERT INTO reader_availability (transport_enabled, observed_at, valid_until)
        VALUES ($1, statement_timestamp(), statement_timestamp() + interval '30 seconds')
        ON CONFLICT (transport_enabled) DO UPDATE SET observed_at=EXCLUDED.observed_at, valid_until=EXCLUDED.valid_until`,
        [hasTransport]);
      await delay(10_000, undefined, { signal }).catch(() => undefined);
      return false;
    }));
    lanes.push(
      poll('local reader and index',async()=>{
        for(let index=0;index<localReads.length;index++) {
          const run=localReads[nextLocal];
          nextLocal=(nextLocal+1)%localReads.length;
          if(await run())return true;
        }
        return false;
      }),
      poll('copilot',()=>processNextCopilot(copilot,signal)),
      poll('review', publish.readyReview),
      poll('questions', () => processNextInquiry(db, inquiry, signal)),
      startImports({ ...context, signal }, { storage }),
    );
    if (allowProfileScans && external && defaultCustomerGrants?.length) {
      lanes.push(poll('customer project defaults', async () => {
        await provisionCustomerProjects(db, external.journal, defaultCustomerGrants);
        await delay(10_000, undefined, { signal }).catch(() => undefined);
        return false;
      }));
    }
    if (packageEnabled) lanes.push(
      poll('package primary scheduler', () => dispatchPackagePair(db, gateway, profile, newWalkJobs, service)),
      poll('package review scheduler', () => schedulePackageReview(db, gateway, profile)),
    );
    if (hasTransport && external) {
      lanes.push(poll('research continuation', () => resumeResearchStops(db, gateway)));
      lanes.push(poll('research recovery', async () => {
        if ((await external.journal.balance()).frozen) return false;
        await gateway.syncRouteIsolations();
        await resumeInterruptedResearch(db, gateway, signal, allowProfileScans);
        return true;
      }, true));
    }
    if(packageEnabled) lanes.push(poll('package followup scheduler',()=>dispatchPackageFollowup(db,gateway,allowProfileScans)));
    const workKinds=[...Array.from({length:hasTransport?3:1},()=>researchKind),...(packageEnabled?[packageFollowupKind]:[])];
    for (const kind of workKinds) {
      const workerId = randomUUID();
      lanes.push(poll(kind, async () => {
        const work = await gateway.claim({ workerId, kinds: [kind], leaseMs: 30_000 });
        if (!work) return false;
        await executeResearch(work, {
          db, gateway, reader, admit, configured: (slot) => profile[slot],
          publishOutcome: publish.outcome, loadPriorOutcome: publish.loadPriorOutcome, unsettledPrior: publish.unsettledPrior,
          localLimits: (task) => {
            const { job } = task;
            if ((job.mode === 'primary' && job.packageWindow) || profileHold(profile, task)) return job.settings;
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
    try {
      if (seal) await releaseManagedTestDatabase(seal);
    } finally {
      storage.objects.close();
      await external?.close();
    }
  }
}
