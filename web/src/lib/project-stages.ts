export const projectStages = [
  { code: 'Стадия 1', name: 'Распознавание входящих документов', available: true },
  { code: 'Стадия 2', name: 'Подготовка к спецификации', available: false },
] as const;

export function projectStageLabel(code: string) {
  const stage = projectStages.find((item) => item.code === code);
  return stage ? `${stage.code}. ${stage.name}` : code;
}
