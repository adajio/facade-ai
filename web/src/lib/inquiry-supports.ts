import type { Citation } from './workspace';

export type InquirySupport = Citation & {
  observationId: string;
  subject: string;
  property: string;
  variant?: string;
  revision: string;
  role: string;
  versionId: string;
  receiptId: string;
  format?: string;
  assessmentQuestionId?: string;
  relativePath?: string;
  measurement?: { value: string; unit: string };
};

export function supportCitation(source: InquirySupport): Citation {
  return { ...source, value: source.measurement?.value ?? source.value, unit: source.measurement?.unit ?? source.unit };
}

export function supportAddress(source: Citation) {
  const address = source.address ?? {};
  const locator = address.locator && typeof address.locator === 'object' ? { ...address, ...address.locator } : address;
  const fields = [
    [locator.page, 'стр.'], [locator.sheet, 'лист'], [locator.section, 'раздел'], [locator.paragraph, 'абзац'],
    [locator.table, 'таблица'], [locator.row ?? locator.line, 'строка'], [locator.column, 'столбец'],
    [locator.cell ?? locator.range, 'ячейка'], [locator.view ?? locator.layout, 'вид'], [locator.handle, 'объект'],
  ];
  return fields.flatMap(([value, caption]) =>
    typeof value === 'number' || (typeof value === 'string' && value.trim()) ? [caption + ' ' + value] : [],
  ).join(', ') || (address.unitId !== undefined ? 'единица ' + address.unitId : '');
}
