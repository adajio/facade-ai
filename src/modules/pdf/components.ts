import { ReaderError, type Evidence, type ReaderComponentInput, type ReaderLine, type ReaderObservationComponent } from './types.js';
import { assignmentReferences, ifcLengthProperty, lengthSiUnit, stepEntity } from '../formats/ifc-units.js';

type Addressed = { component: ReaderObservationComponent; line: ReaderLine; lines: readonly ReaderLine[]; format: string };
const invalid = (code = 'reader_component_link_invalid') => new ReaderError(code, 'Составная опора не подтверждена указанными адресами', 422);
const escaped = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
function literalIn(text: string, literal: string) {
  if (!/^[+-]?\d+(?:[,.]\d+)?$/u.test(literal)) {
    return new RegExp(`(?<![\\p{L}\\p{N}])${escaped(literal)}(?![\\p{L}\\p{N}])`, 'u').test(text);
  }
  return new RegExp(`(?<![\\p{L}\\p{N}.,+-])${escaped(literal)}(?![\\p{N}]|[.,]\\d|[eE][+-]?\\d)`, 'u').test(text);
}

function sameTable(a: ReaderLine, b: ReaderLine) {
  const dims = ['table', 'sheet', 'section'];
  return dims.some((key) => a.locator?.[key] !== undefined)
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
    const intervening = a.lines.filter((line) => sameTable(a.line, line) && line.locator?.column === left.column
      && typeof line.locator.row === 'number' && line.locator.row > (left.row as number) && line.locator.row < (right.row as number));
    return intervening.length === right.row - left.row - 1
      && intervening.every((line) => /^\s*[+-]?\d+(?:[,.]\d+)?\s*$/u.test(line.text));
  }
  const one = a.line.box, two = b.line.box;
  if (!one || !two) return false;
  if (direction === 'row') {
    const [before, after] = one.x < two.x ? [one, two] : [two, one];
    return sameBand(before, after) && before.x + before.width <= after.x && !a.lines.some(({ box }) =>
      box && sameBand(before, box) && box.x >= before.x + before.width && box.x < after.x);
  }
  const gap = two.y - (one.y + one.height);
  const overlaps = (box: typeof one) => box.x < two.x + two.width && box.x + box.width > two.x;
  return gap >= 0 && gap < 4 * two.height && overlaps(one) && !a.lines.some(({ box }) =>
    box && box.y > one.y && box.y < two.y && overlaps(box));
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
    if (!issued || matches?.length !== 1 || !literalIn(part.quote, part.literal)) throw invalid('reader_component_quote_mismatch');
    const { evidence: view, lines } = issued;
    const [line] = matches;
    const current = { line, lines, format: view.format, component: { ...part, source: view.source, receiptId: view.receiptId,
      readerVersion: view.readerVersion, evidenceHref: `/api/v1/evidence/${view.id}`,
      address: { ...view.address, box: line.box ?? view.address.box, locator: { ...view.address.locator, ...line.locator } },
    } };
    if (part.link.kind === 'anchor' ? index !== 0 : !Number.isInteger(part.link.to) || part.link.to < 0
      || part.link.to >= index || !verifyLink(current, addressed[part.link.to], part.link.kind)) throw invalid();
    if (part.role === 'unit' && (part.link.kind === 'anchor' || (part.link.kind !== 'ifc_reference'
      && (part.link.kind === 'shared_identifier' || addressed[part.link.to]?.component.role !== 'value'))
      || /^[+-]?\d+(?:[,.]\d+)?$/u.test(part.literal))) throw invalid();
    addressed.push(current);
  }
  return { components: addressed.map(({ component }) => component), ifcUnit: verifiedIfcUnit(addressed) };
}
