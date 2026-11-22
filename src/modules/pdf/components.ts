import { ReaderError, type Evidence, type ReaderComponentInput, type ReaderLine, type ReaderObservationComponent } from './types.js';
import { assignmentReferences, ifcLengthProperty, lengthSiUnit, stepEntity } from '../formats/ifc-units.js';

type Addressed = { component: ReaderObservationComponent; line: ReaderLine; lines: readonly ReaderLine[]; format: string };
type Binding = NonNullable<ReaderObservationComponent['binding']>;
type Span = { start: number; end: number };
const invalid = (code = 'reader_component_link_invalid') => new ReaderError(code, 'Составная опора не подтверждена указанными адресами', 422);
const escaped = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const numericLiteral = /^[+-]?\d+(?:[,.]\d+)?(?:[eE][+-]?\d+)?$/u;
const unitEnd = '(?![\\p{L}\\p{N}\\p{M}/·⋅^%°])';
const fieldSeparator = /[|;·\t]/gu;

function numbers(text: string) {
  return [...text.matchAll(/(?<![\p{L}\p{N}.,+-])[+-]?\d+(?:[,.]\d+)?(?:[eE][+-]?\d+)?(?![\p{N}]|[.,]\d|[eE][+-]?\d)/gu)]
    .map(({ 0: literal, index }) => ({ start: index, end: index + literal.length, literal }));
}

function quoteSpan({ component: { quote }, line }: Addressed): Span | undefined {
  const start = line.text.indexOf(quote);
  return start >= 0 && line.text.indexOf(quote, start + 1) < 0 ? { start, end: start + quote.length } : undefined;
}

function measuredNumber(value: Addressed) {
  const quote = quoteSpan(value);
  if (!quote) throw invalid('reader_component_measure_ambiguous');
  const text = value.line.text;
  const amounts = numbers(text);
  const found = amounts.filter(({ start, end }) => start >= quote.start && end <= quote.end);
  if (found.length !== 1 || found[0].literal !== value.component.literal) throw invalid('reader_component_measure_ambiguous');
  const nextField = [...text.slice(found[0].end).matchAll(fieldSeparator)][0];
  if (amounts.length > 1 && nextField && text.slice(found[0].end + nextField.index + 1, quote.end).trim()) {
    throw invalid('reader_component_measure_ambiguous');
  }
  return found[0];
}

function precedingField(value: Addressed, amount: Span): Span {
  const line = value.line.text;
  const partFrom = [...line.slice(0, amount.start).matchAll(fieldSeparator)].at(-1)?.index;
  const previous = numbers(line).findLast(({ end }) => end <= amount.start);
  return { start: Math.max(partFrom === undefined ? 0 : partFrom + 1, previous?.end ?? 0), end: amount.end };
}

function linkedUnit(part: Addressed, value: Addressed) {
  if (!numericLiteral.test(value.component.literal)) return false;
  const amount = measuredNumber(value);
  const quote = quoteSpan(part);
  if (!quote) return false;
  const text = value.line.text;
  const symbol = escaped(part.component.literal);
  const suffix = new RegExp(`^\\s*(?:${symbol}${unitEnd}|\\(\\s*${symbol}\\s*\\)|\\[\\s*${symbol}\\s*\\])`, 'u').exec(text.slice(amount.end));
  if (suffix) {
    const start = amount.end + suffix[0].indexOf(part.component.literal);
    if (quote.start <= start && quote.end >= start + part.component.literal.length) return true;
  }
  // A parenthesized unit before a value belongs to its labelled field, unless it is also an adjacent suffix of the previous number.
  const between = precedingField(value, amount);
  const prefix = new RegExp(`(?:\\(\\s*${symbol}\\s*\\)|\\[\\s*${symbol}\\s*\\])\\s*$`, 'u').exec(text.slice(between.start, amount.start));
  if (!prefix) return false;
  const previous = numbers(text).findLast(({ end }) => end <= amount.start);
  const start = between.start + prefix.index + prefix[0].indexOf(part.component.literal);
  return quote.start <= start && quote.end >= start + part.component.literal.length
    && (!previous || text.slice(previous.end, between.start + prefix.index).trim().length > 0);
}

function unitCell({ component: { literal }, line }: Addressed) {
  const symbol = escaped(literal);
  return new RegExp(`^\\s*(?:${symbol}|\\(\\s*${symbol}\\s*\\)|\\[\\s*${symbol}\\s*\\])\\s*$`, 'u').test(line.text);
}

function unitHeading({ component: { literal }, line }: Addressed) {
  const symbol = escaped(literal);
  const match = new RegExp(`(?:^|[,\\s])(?:${symbol}|\\(\\s*${symbol}\\s*\\)|\\[\\s*${symbol}\\s*\\])\\s*$`, 'u').exec(line.text);
  return Boolean(match && !/[/·⋅]\s*$/u.test(line.text.slice(0, match.index)));
}
function literalIn(text: string, literal: string, gluedUnit = false) {
  if (!/^[+-]?\d+(?:[,.]\d+)?$/u.test(literal)) {
    const boundary = gluedUnit ? '(?<![\\p{L}])' : '(?<![\\p{L}\\p{N}])';
    return new RegExp(`${boundary}${escaped(literal)}(?![\\p{L}\\p{N}])`, 'u').test(text);
  }
  return new RegExp(`(?<![\\p{L}\\p{N}.,+-])${escaped(literal)}(?![\\p{N}]|[.,]\\d|[eE][+-]?\\d)`, 'u').test(text);
}

function sameTable(a: ReaderLine, b: ReaderLine) {
  const dims = ['table', 'sheet', 'sheetId', 'section'];
  return ['table', 'sheet', 'sheetId'].some((key) => a.locator?.[key] !== undefined)
    && dims.every((key) => a.locator?.[key] === b.locator?.[key]);
}

function sameBand(a: NonNullable<ReaderLine['box']>, b: NonNullable<ReaderLine['box']>) {
  return Math.abs(a.y + a.height / 2 - b.y - b.height / 2) < Math.min(a.height, b.height) / 2;
}

function adjacent(a: Addressed, b: Addressed, direction: 'row' | 'column') {
  if (a.line.id === b.line.id) return direction === 'row';
  const left = a.line.locator, right = b.line.locator;
  if (left?.row !== undefined || right?.row !== undefined) {
    if (!sameTable(a.line, b.line) || typeof left?.row !== 'number' || typeof right?.row !== 'number') return false;
    if (direction === 'row') return left.row === right.row && (a.component.role !== 'unit'
      || (typeof right.column === 'number' && left.column === right.column + 1));
    if (typeof left.column !== 'number' || left.column !== right.column || left.row >= right.row) return false;
    // Require continuity in the numeric column and reject an intervening heading.
    const headings = a.lines.filter((line) => sameTable(a.line, line) && line.locator?.column === left.column
      && line.locator?.row === left.row && line.text.trim());
    if (headings.length !== 1 || headings[0].id !== a.line.id) return false;
    const intervening = a.lines.filter((line) => sameTable(a.line, line) && line.locator?.column === left.column
      && typeof line.locator.row === 'number' && line.locator.row > (left.row as number) && line.locator.row < (right.row as number));
    return intervening.length === right.row - left.row - 1
      && intervening.every((line) => /^\s*[+-]?\d+(?:[,.]\d+)?\s*$/u.test(line.text));
  }
  const one = a.line.box, two = b.line.box;
  if (!one || !two) return false;
  if (direction === 'row') {
    if (a.component.role === 'unit' && one.x <= two.x) return false;
    const [before, after] = one.x < two.x ? [one, two] : [two, one];
    return sameBand(before, after) && before.x + before.width <= after.x && !a.lines.some(({ box }) =>
      box && sameBand(before, box) && box.x >= before.x + before.width && box.x < after.x);
  }
  const gap = two.y - (one.y + one.height);
  const center = two.x + two.width / 2;
  const coversColumn = (box: typeof one) => box.x <= center && box.x + box.width >= center;
  return gap >= 0 && gap < 4 * two.height && coversColumn(one) && !a.lines.some(({ id, box }) =>
    id !== a.line.id && box && box.y < two.y && (box.y > one.y || sameBand(one, box)) && coversColumn(box))
    && !a.lines.some(({ id, box, text }) => id !== b.line.id && box && sameBand(two, box) && numbers(text).length > 0
      && one.x <= box.x + box.width / 2 && one.x + one.width >= box.x + box.width / 2);
}

const variantHeading = /^\s*(?:variant|execution|исполнени[ея]|вариант)\s*[:№]?\s*$/iu;
const variantCode = /^(?:\p{L}{1,3}\d{0,8}|\d{1,8}\p{L}{0,3})(?:[-_]\d{1,6})?$/u;
function variantBinding(part: Addressed, target: Addressed): Binding | undefined {
  const { line, component: { literal, quote } } = part;
  const explicit = new RegExp(`(?<![\\p{L}\\p{N}])(?:variant|execution|исполнени[ея]|вариант)\\s*[:№=]?\\s*${escaped(literal)}(?![\\p{L}\\p{N}_-])`, 'iu');
  const field = explicit.exec(quote);
  const span = quoteSpan(part);
  if (field && span) {
    const at = span.start + field.index;
    if (target.line.id === line.id && part.format !== 'ifc' && numericLiteral.test(target.component.literal)) {
      const amount = measuredNumber(target);
      const ownNumbers = numbers(line.text);
      const boundary = ownNumbers.findLast(({ end }) => end <= amount.start)?.end ?? 0;
      const next = ownNumbers.find(({ start }) => start >= amount.end);
      if (at < boundary || (next && at + field[0].length > next.start)) return;
      const separator = [...line.text.slice(0, at).matchAll(fieldSeparator)].at(-1)?.index ?? -1;
      const fieldPrefix = line.text.slice(separator + 1, at).trim();
      const afterAmount = line.text.slice(amount.end, at).trim();
      if (fieldPrefix && (at < amount.end || !/^(?:[\p{L}\p{M}\p{N}%°/⋅·^]+|\([^()\s]+\)|\[[^[\]\s]+\])?$/u.test(afterAmount))) return;
    } else if (line.text.slice(0, at).trim() || line.text.slice(at + field[0].length).trim()) {
      return;
    }
    return { kind: 'variant_field', lineId: line.id, text: field[0] };
  }
  const { row, column } = line.locator ?? {};
  const targetColumn = target.line.locator?.column;
  if (typeof row !== 'number' || typeof column !== 'number' || typeof targetColumn !== 'number' || column === targetColumn
    || line.text.trim() !== literal || !variantCode.test(literal)) return;
  const variantColumn = part.lines.filter((item) => sameTable(item, line) && item.locator?.column === column
    && typeof item.locator?.row === 'number' && item.locator.row < row).sort((a, b) => Number(b.locator?.row) - Number(a.locator?.row));
  const header = variantColumn.find(({ text }) => !variantCode.test(text.trim()));
  if (!header || !variantHeading.test(header.text)) return;
  const first = Number(header.locator?.row);
  const intermediate = part.lines.filter((item) => sameTable(item, target.line) && item.locator?.column === targetColumn
    && Number(item.locator?.row) > first && Number(item.locator?.row) < row);
  if (intermediate.length !== row - first - 1 || !intermediate.every(({ text }) => numericLiteral.test(text.trim()))) return;
  return { kind: 'variant_field', lineId: header.id, text: header.text };
}

const identifierHeading = /^\s*(?:id|identifier|designation|item|mark|part|обозначение|идентификатор|марка|элемент|позиция|наименование|деталь|объект|узел|код)\s*[:№]?\s*$/iu;
function rowIdentifier(part: Addressed, value: Addressed) {
  const { line, lines } = part;
  if (numbers(line.text).length) return false;
  const { row, column } = line.locator ?? {};
  const valueColumn = value.line.locator?.column;
  if (typeof row === 'number' && typeof column === 'number' && typeof valueColumn === 'number') {
    if (column >= valueColumn) return false;
    const columnLines = lines.filter((item) => sameTable(item, value.line) && item.locator?.column === valueColumn
      && Number(item.locator?.row) < row && item.text.trim());
    const headingRow = columnLines.filter(({ text }) => !numericLiteral.test(text.trim()))
      .map(({ locator }) => Number(locator?.row)).sort((a, b) => b - a)[0];
    if (headingRow !== undefined) {
      const headings = lines.filter((item) => sameTable(item, line) && item.locator?.column === column
        && item.locator?.row === headingRow && item.text.trim());
      if (headings.length) {
        return headings.length === 1 && identifierHeading.test(headings[0].text)
          && columnLines.filter(({ locator }) => Number(locator?.row) > headingRow).length === row - headingRow - 1;
      }
    }
    return !lines.some((item) => sameTable(item, line) && item.locator?.row === row
      && Number(item.locator.column) < column && item.text.trim());
  }
  const box = line.box, expected = value.line.box;
  return Boolean(box && expected && box.x < expected.x && !lines.some((item) => item.box && item.box.x < box.x
    && sameBand(item.box, box) && item.text.trim()));
}

function boundComponent(part: Addressed, target: Addressed | undefined): Binding {
  const { line, component, format } = part;
  const bind = (kind: Binding['kind'], text = component.quote): Binding => ({ kind, lineId: line.id, text });
  if (!target) {
    if (format === 'ifc') {
      const property = stepEntity(line.text);
      return property?.type === 'IFCPROPERTYSINGLEVALUE' ? bind('value_context', property.args[0]) : bind('context');
    }
    if (!numericLiteral.test(component.literal)) return bind('context');
    const range = precedingField(part, measuredNumber(part));
    return bind('value_context', line.text.slice(range.start, range.end).trim());
  }
  const { kind } = component.link;
  if (component.role === 'unit' && kind !== 'ifc_reference') {
    const linked = kind === 'source_context' || (kind === 'same_row' && line.id === target.line.id)
      ? linkedUnit(part, target) : kind === 'same_row' ? unitCell(part) : kind === 'column_header' && unitHeading(part);
    if (!linked) throw invalid('reader_component_unit_unbound');
  }
  if (component.role === 'variant') {
    const field = variantBinding(part, target);
    if (!field) throw invalid('reader_component_variant_unbound');
    return field;
  }
  if (kind === 'column_header') {
    if (/[|;\t\r\n]/u.test(line.text)) throw invalid('reader_component_link_invalid');
    return bind('column_header', line.text);
  }
  if (component.role === 'identifier' && kind === 'same_row' && line.id !== target.line.id) {
    if (!rowIdentifier(part, target)) throw invalid('reader_component_identifier_unbound');
    return bind('row_context');
  }
  if (component.role === 'identifier' && (kind === 'source_context' || kind === 'same_row') && target.component.role === 'value'
    && numericLiteral.test(target.component.literal)) {
    const range = precedingField(target, measuredNumber(target));
    const quote = quoteSpan(part);
    if (quote && quote.start >= range.start && quote.end <= range.end) return bind('value_context');
    const [first] = numbers(line.text);
    if (quote && first && quote.end <= first.start) return bind('row_context');
    // A full citation containing the measured field can still identify its row by a distinct literal from the prefix.
    const prefix = first && line.text.slice(0, first.start);
    if (prefix && literalIn(prefix, component.literal)) return bind('row_context', prefix.trim());
    throw invalid('reader_component_identifier_unbound');
  }
  return bind('context');
}

function references(record: string, step: string) {
  // A STEP identifier appearing in a quoted attribute is ordinary text.
  const attributes = record.replace(/^\s*#[1-9]\d*\s*=\s*IFC[A-Z0-9]+\s*\(/iu, '');
  if (attributes === record) return false;
  return attributes.replace(/'(?:[^']|'')*'/gu, '').match(/#[1-9]\d*/gu)?.some((id) => id === step) === true;
}

function verifyLink(a: Addressed, b: Addressed, kind: Exclude<ReaderComponentInput['link']['kind'], 'anchor'>) {
  const component = a.component, target = b.component;
  const sameVersion = component.source.versionId === target.source.versionId && component.source.sha256 === target.source.sha256;
  const sameUnit = sameVersion && component.address.unitId === target.address.unitId;
  const sameEvidence = sameUnit && component.evidenceId === target.evidenceId;
  switch (kind) {
    case 'same_row': return sameEvidence && adjacent(a, b, 'row');
    case 'column_header': return (component.role === 'unit' || component.role === 'identifier') && target.role === 'value'
      && sameEvidence && adjacent(a, b, 'column');
    case 'source_context': return sameEvidence && a.line.id === b.line.id;
    case 'shared_identifier': return component.role === 'identifier' && target.role === 'identifier'
      && component.literal.length >= 4 && component.literal === target.literal && component.evidenceId !== target.evidenceId
      && (sameVersion || component.source.documentId !== target.source.documentId);
    case 'ifc_reference': return a.format === 'ifc' && b.format === 'ifc' && sameVersion
      && typeof a.line.locator?.step === 'string' && typeof b.line.locator?.step === 'string'
      && (references(a.line.text, b.line.locator.step) || references(b.line.text, a.line.locator.step)
        || (component.role === 'relationship' && target.role === 'value' &&
          a.line.locator.step === a.component.address.locator?.ifcProjectStep &&
          ifcLengthProperty(stepEntity(b.line.text))?.localUnit === '$'));
  }
}

function verifiedIfcUnit(addressed: Addressed[]) {
  const [anchor] = addressed;
  if (anchor.format !== 'ifc') return;
  const property = ifcLengthProperty(stepEntity(anchor.line.text));
  const part = addressed.find(({ component }) => component.role === 'unit');
  if (!property && !part) return;
  const unproven = () => invalid('reader_ifc_unit_unproven');
  if (!property || !part || Number(anchor.component.literal) !== property.value) throw unproven();
  const unit = stepEntity(part.line.text);
  const normalized = lengthSiUnit(unit);
  if (!unit || !normalized || !part.component.quote.includes('.LENGTHUNIT.') || !part.component.quote.includes('.METRE.')
    || (normalized === 'mm' && !part.component.quote.includes('.MILLI.'))) throw unproven();
  if (property.localUnit !== '$') {
    if (property.localUnit !== unit.id) throw unproven();
    return normalized;
  }
  const locator = anchor.component.address.locator;
  const ownRelationships = addressed.filter(({ component }) => component.role === 'relationship' &&
    component.source.versionId === anchor.component.source.versionId && component.source.sha256 === anchor.component.source.sha256);
  const project = ownRelationships.find(({ line }) => line.locator?.step === locator?.ifcProjectStep);
  const assignment = ownRelationships.find(({ line }) => line.locator?.step === locator?.ifcUnitAssignmentStep);
  if (unit.id !== locator?.ifcProjectLengthUnitStep || !project || !assignment ||
    !project.component.quote.includes(String(locator.ifcUnitAssignmentStep)) || !assignment.component.quote.includes(unit.id) ||
    stepEntity(project.line.text)?.args[8] !== locator.ifcUnitAssignmentStep ||
    !assignmentReferences(stepEntity(assignment.line.text))?.includes(unit.id)) throw unproven();
  return normalized;
}

export function groundComponents(inputs: readonly ReaderComponentInput[], evidence: ReadonlyMap<string, { evidence: Evidence; lines: ReaderLine[] }>) {
  if (inputs.length < 2 || inputs.length > 12 || inputs[0].role !== 'value' || inputs[0].link.kind !== 'anchor' ||
    ['value', 'unit', 'variant', 'revision'].some((role) => inputs.filter((part) => part.role === role).length > 1)) throw invalid();
  if (/^[+-]?\d+(?:[,.]\d*)?(?:[eE][+-]?\d+)?$/u.test(inputs[0].literal) && !inputs.some(({ role }) => role === 'unit')) {
    throw invalid('reader_component_unit_required');
  }
  const addressed: Addressed[] = [];
  for (const [index, part] of inputs.entries()) {
    const issued = evidence.get(part.evidenceId);
    const matches = issued?.lines.filter(({ id, text }) => id === part.lineId && text.includes(part.quote));
    if (!issued || matches?.length !== 1 || !literalIn(part.quote, part.literal, part.role === 'unit')) {
      throw invalid('reader_component_quote_mismatch');
    }
    const { evidence: view, lines } = issued;
    const [line] = matches;
    const current: Addressed = { line, lines, format: view.format, component: { ...part, source: view.source, receiptId: view.receiptId,
      readerVersion: view.readerVersion, evidenceHref: `/api/v1/evidence/${view.id}`,
      address: { ...view.address, box: line.box ?? view.address.box, locator: { ...view.address.locator, ...line.locator } },
    } };
    if (part.link.kind === 'anchor' ? index !== 0 : !Number.isInteger(part.link.to) || part.link.to < 0
      || part.link.to >= index || !verifyLink(current, addressed[part.link.to], part.link.kind)) throw invalid();
    if (part.role === 'unit' && (part.link.kind === 'anchor' || (part.link.kind !== 'ifc_reference'
      && (part.link.kind === 'shared_identifier' || addressed[part.link.to]?.component.role !== 'value'))
      || /^[+-]?\d+(?:[,.]\d+)?$/u.test(part.literal))) throw invalid();
    current.component.binding = boundComponent(current, part.link.kind === 'anchor' ? undefined : addressed[part.link.to]);
    addressed.push(current);
  }
  return { components: addressed.map(({ component }) => component), ifcUnit: verifiedIfcUnit(addressed) };
}
