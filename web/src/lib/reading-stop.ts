export const readingStopMessages = {
  no_useful_change: 'Новые участки не изменили выводы по требованиям и состав вопросов письма.',
  receipt_call_limit: 'Достигнут лимит запросов на поступление.',
  no_addressed_goal: 'В сохранённом разборе нет адресной цели для продолжения.',
  target_limit: 'Достигнут лимит участков углублённого чтения.',
  no_readable_windows: 'В подготовленном пакете нет доступных участков для уточнения требований.',
  no_new_targets: 'Для оставшихся вопросов система не нашла новых участков.',
  operator_stopped: 'Углублённое чтение остановлено по решению оператора.',
} as const;

export type ReadingStopReason = keyof typeof readingStopMessages;
type StopProgress = { directed?: { mode: string }; deep?: { reason: string | null; status?: string } | null };

function isStopReason(value: string | null | undefined): value is ReadingStopReason {
  return !!value && Object.hasOwn(readingStopMessages, value);
}

export function readingStopReason(progress?: StopProgress | null) {
  const directed = progress?.directed?.mode;
  const deep = progress?.deep?.reason;
  if (directed === 'operator_stopped') return directed;
  if (progress?.deep?.status === 'partial' && isStopReason(deep)) return deep;
  if (directed !== 'no_new_targets' && isStopReason(directed)) return directed;
}
