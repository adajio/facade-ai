import type { OpenRouterProfile } from '../gateway/index.js';
import type { ResearchSuspension, ResearchTask } from './contracts.js';
import { profileHold, researchSlot, researchSlots, type ResearchProfile, type ResearchSlot } from './profile.js';

export type LiveRoute = Pick<OpenRouterProfile,
  'routeId' | 'model' | 'provider' | 'mode' | 'zdrEvidenceRef' | 'syntheticScopes'>;

function matchesPolicy(route: LiveRoute, dataClass: string, policy: string) {
  if (typeof route.provider !== 'string' || (route.mode !== 'strict-zdr' && route.mode !== 'synthetic-research')) return false;
  const hasZdr = typeof route.zdrEvidenceRef === 'string' && Boolean(route.zdrEvidenceRef.trim());
  if (route.model.startsWith('moonshotai/kimi-') && (route.provider !== 'wafer/us' || !hasZdr)) {
    return false;
  }
  if (policy === 'strict-zdr' && (route.mode !== 'strict-zdr' || !hasZdr)) return false;
  if (policy === 'synthetic-research' &&
      (dataClass !== 'synthetic' || (route.model.startsWith('qwen/') && !/^alibaba(?:\/|$)/.test(route.provider)))) {
    return false;
  }
  return (policy === 'strict-zdr' || policy === 'synthetic-research') &&
    ((dataClass !== 'synthetic' && route.mode !== 'synthetic-research') || (Array.isArray(route.syntheticScopes) && route.syntheticScopes.length > 0));
}

export function validateLivePolicy<T extends LiveRoute>(
  configuration: ResearchProfile,
  approvals: readonly T[],
  env: NodeJS.ProcessEnv = process.env,
  usable: (route: T) => boolean = () => true,
) {
  const policy = env.FACADE_HARNESS_LIVE_POLICY ?? 'strict-zdr';
  const routes = new Map<ResearchSlot, T>();
  for (const slot of researchSlots) {
    const settings = configuration[slot];
    if (!settings) continue;
    const matching = approvals.filter((route) => route?.routeId === settings.routeId && route.model === settings.model);
    if (matching.length === 1 && usable(matching[0]) && matchesPolicy(matching[0], settings.dataClass, policy)) {
      routes.set(slot, matching[0]);
    }
  }
  return {
    approvals: [...new Set(routes.values())],
    hold(task: ResearchTask): ResearchSuspension | null {
      const slot = researchSlot(task.job);
      const blocked = profileHold(configuration, task);
      if (blocked) return blocked;
      const actual = task.job.settings;
      const route = routes.get(slot);
      if (!route) return {
        reason: 'research_route_not_approved',
        nextAction: `Подтвердить маршрут для ${slot}.`,
      };
      if (policy === 'strict-zdr' && actual.dataClass !== 'synthetic') return null;
      const approved = route.syntheticScopes?.find(({ projectId, scopeId }) =>
        task.projectId === projectId && task.scopeId === scopeId);
      const places = task.job.mode === 'primary' ? [task.job.place] : [task.job.dispute.a.place, task.job.dispute.b.place];
      if (approved && places.every(({ source }) =>
        source.projectId === task.projectId && approved.originalSha256s.includes(source.sha256))) return null;
      return {
        reason: 'synthetic_input_not_approved',
        nextAction: `Сверить проект, область и SHA-256 оригиналов с допуском ${slot}.`,
      };
    },
  };
}
