import { ApiError } from './http';

// A count can change between rendering the overview and following its link.
export async function versionForCount<T extends { version: number }>(
  seen: string | null, current: T, load: (version: string) => Promise<T>,
) {
  if (!seen || seen === String(current.version) || !/^[1-9][0-9]*$/.test(seen)) return { snapshot: current };
  try {
    return { snapshot: await load(seen), historical: seen };
  } catch (error) {
    if (!(error instanceof ApiError) || error.status !== 404 || error.code !== 'assessment_not_found') throw error;
    return { snapshot: current, expired: true };
  }
}
