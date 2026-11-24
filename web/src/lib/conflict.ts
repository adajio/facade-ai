import { ApiError, describe } from './http';

export function conflictVersion(error: unknown, basedOn?: number) {
  if (!(error instanceof ApiError) || error.status !== 412) return undefined;
  const version = error.details.currentVersion ?? error.details.version;
  return { basis: basedOn, current: typeof version === 'number' ? version : undefined, details: error.details.details };
}

export function conflictMessage(error: unknown, basedOn?: number) {
  const conflict = conflictVersion(error, basedOn);
  if (!conflict) return describe(error);
  const detail = [conflict.basis != null ? 'Исходная версия ' + conflict.basis : '',
    conflict.current != null ? 'текущая версия ' + conflict.current : 'актуальная версия доступна после обновления'].filter(Boolean);
  return describe(error) + ' ' + detail.join(', ') + '.';
}
