import { qwen4Max, terraModel } from '../gateway/index.js';
import { settingsSchema, type ResearchSettings, type ResearchSuspension, type ResearchTask, type ScheduledResearchJob } from './contracts.js';

export const researchSlots = ['A', 'B', 'lead'] as const;
export type ResearchSlot = typeof researchSlots[number];
export type ResearchProfile = Record<ResearchSlot, ResearchSettings | null>;

export function researchSlot(job: ScheduledResearchJob): ResearchSlot {
  return job.mode === 'lead' ? 'lead' : job.branch;
}

function defaultResearchProfile(): ResearchProfile {
  const reader = { dataClass: 'synthetic', maxTokens: 2_048, maxTurns: 32, maxKnownRejections: 1 };
  return {
    A: { ...reader, routeId: 'cheaperinference-terra-reader', model: terraModel },
    B: { ...reader, routeId: 'openrouter-alibaba-qwen4-max-reader', model: qwen4Max },
    lead: null,
  };
}

export function loadResearchProfile(env = process.env): ResearchProfile {
  if (env.FACADE_HARNESS_PROFILE === undefined) return defaultResearchProfile();
  const profile: ResearchProfile = { A: null, B: null, lead: null };
  let input: unknown;
  try {
    input = JSON.parse(env.FACADE_HARNESS_PROFILE);
  } catch {
    return profile;
  }
  if (input === null || typeof input !== 'object' || Array.isArray(input)) return profile;
  const configured = input as Partial<Record<ResearchSlot, unknown>>;
  for (const slot of researchSlots) {
    const result = settingsSchema.safeParse(configured[slot]);
    if (result.success) profile[slot] = result.data;
  }
  if (profile.A && profile.B && (profile.A.model === profile.B.model || profile.A.routeId === profile.B.routeId)) {
    profile.A = null;
    profile.B = null;
  }
  return profile;
}


export function profileHold(profile: ResearchProfile, task: ResearchTask): ResearchSuspension | null {
  const slot = researchSlot(task.job);
  const expected = profile[slot];
  const actual = task.job.settings;
  if (!expected) return { reason: 'research_profile_unavailable', nextAction: `Настроить профиль для ${slot}.` };
  if (expected.routeId !== actual.routeId || expected.model !== actual.model || expected.dataClass !== actual.dataClass
    || (expected.toolChoice ?? 'required') !== (actual.toolChoice ?? 'required')) {
    return { reason: 'research_profile_changed', nextAction: `Восстановить назначенный маршрут для ${slot}.` };
  }
  return null;
}
