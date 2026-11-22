import type { Citation } from './workspace';

export type TextRange = { start: number; end: number };
export type WordingReview = {
  wordingSha256: string;
  scope: TextRange;
  subject: TextRange;
  action: TextRange;
  citations: { observationId: string; reference: TextRange; value?: TextRange }[];
};

export type WordingSource = {
  label: string;
  address: Citation & { observationId: string };
};

export const wordingFields: Record<string, string> = {
  scope: 'Область',
  subject: 'Предмет',
  action: 'Действие',
  reference: 'Обозначение источника',
  value: 'Значение с единицей',
  citations: 'Опоры',
  wording: 'Формулировка',
};

export function managedWording(edited: string, wording: string, alternative?: string) {
  const normalize = (text: string) => text.trim().replace(/[\t \n\r]+/g, ' ');
  const value = normalize(edited);
  return [wording, alternative].some((text) => text != null && normalize(text) === value);
}
