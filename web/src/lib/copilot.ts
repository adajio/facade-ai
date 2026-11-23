import { id } from './http';

export type SourceAddress = {
  unitId: string;
  locator?: Record<string, string | number>;
  box?: { x: number; y: number; width: number; height: number };
};

export type OriginalSource = {
  id: string; label: string; documentId: string; versionId: string;
  text: string; context?: { id: string; text: string; address: SourceAddress }[]; window?: true; address: SourceAddress; version: 'current' | 'historical' | 'unknown';
  representation: 'native' | 'ocr' | 'render'; limitations: string[];
};

export type PublishedSource = { id: string; page: number; quote: string };
export type SourceDetail = { mode: 'originals'; source: OriginalSource } | { mode: 'publications'; source: PublishedSource };
export type VersionDetail = Pick<OriginalSource, 'documentId' | 'versionId' | 'label' | 'version'> & { mediaType: string; receiptId: string; occurrenceId: string };

export type SearchResult = { limitations: string[] } & (
  { mode: 'originals'; sources: OriginalSource[]; windows?: OriginalSource[] } |
  { mode: 'publications'; sources: PublishedSource[] }
);

export type CopilotQuestion = {
  id: string; question: string; state: 'pending' | 'queued' | 'research_queued' | 'answered' | 'limited' | 'held' | 'historical';
  reason?: string; asOf?: string; claims?: { text: string; sources: string[] }[]; researchSourceId?: string; citations?: OriginalSource[]; limitations?: string[];
  partialSources?: Pick<OriginalSource, 'id' | 'label' | 'address' | 'representation'>[];
  readActions?: ({ completed: boolean } & (
    { operation: 'search_sources'; query: string } | { operation: 'open_source'; sourceId?: string }
  ))[];
};

export const sourceVersions = {
  current: 'Актуальный источник', historical: 'Исторический источник', unknown: 'Применимость редакции требует сверки',
};

export const representations = { native: 'Текст оригинала', ocr: 'Распознано OCR', render: 'Изображение' };

function locatorLabel(key: string) {
  const names: Record<string, string> = {
    page: 'стр.', sheet: 'лист', sheetName: 'лист', row: 'строка', column: 'столбец',
    cell: 'ячейка', range: 'диапазон', paragraph: 'абзац', table: 'таблица',
    rowFirst: 'первая строка', rowLast: 'последняя строка',
  };
  return names[key] ?? key;
}

export function renderAddress(address: SourceAddress) {
  const fields = Object.entries(address.locator ?? {}).map(([key, value]) => locatorLabel(key) + ' ' + value);
  if (!fields.length) fields.push(address.unitId);
  if (address.box) {
    const { x, y, width, height } = address.box;
    fields.push('область ' + [x, y, width, height].map((value) => Math.round(value * 100) / 100).join(', ') + ' пт');
  }
  return fields.join(' · ');
}

export function originalUrl(documentId: string, versionId: string, page?: unknown) {
  return '/api/documents/' + id(documentId) + '/versions/' + id(versionId) + '/content' +
    (typeof page === 'number' && Number.isSafeInteger(page) && page > 0 ? '#page=' + page : '');
}
