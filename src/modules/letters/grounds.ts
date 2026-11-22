import { selectConfirmedGrounds } from '../assessment/commands.js';
import type { Ground as AssessmentGround, GroundsOptions } from '../assessment/commands.js';
import { canonicalJson } from '../assessment/domain.js';
import { AssessmentError } from '../assessment/store.js';
import { externalLine } from './content.js';
import type { Ground } from './content.js';
import { LetterError } from './inputs.js';
import type { LetterDependencies } from './routes.js';

type Citation = AssessmentGround['citations'][number];

function addressLabel(citation: Citation) {
  const address = citation.address;
  const locator = typeof address.locator === 'object' && address.locator !== null
    ? { ...address, ...address.locator } : address;
  return [
    ['page', 'стр.'], ['sheet', 'лист'], ['section', 'раздел'], ['paragraph', 'абз.'],
    ['table', 'табл.'], ['row', 'строка'], ['column', 'столбец'], ['cell', 'ячейка'],
    ['layout', 'лист'], ['view', 'вид'], ['space', 'пространство'], ['handle', 'объект'],
    ['derivativeHandle', 'объект производного вида'], ['step', 'запись IFC'], ['propertyPath', 'путь свойства'],
  ].flatMap(([key, prefix]) => {
    const value = key === 'row' ? locator.row ?? locator.line : locator[key];
    if ((typeof value === 'number' && Number.isFinite(value)) || (typeof value === 'string' && value.trim())) {
      return [`${prefix} ${externalLine(String(value))}`];
    }
    return [];
  });
}

function clientSource(citation: Citation) {
  const name = externalLine(citation.label ?? '');
  const revision = externalLine(citation.documentRevision?.label ?? '');
  const label = [
    name ? `«${name}»` : 'Документ из описи',
    ...(revision ? [`ред. ${revision}`] : []),
    ...addressLabel(citation),
  ].join(', ');
  return { label, address: citation };
}

function distinctConflictCitations(citations: readonly Citation[]): Citation[] {
  const locations = new Map<string, Citation>();
  for (const citation of citations) {
    const { documentId, versionId, sha256, address, value, unit } = citation;
    const key = canonicalJson([documentId, versionId, sha256, address, value, unit]);
    const previous = locations.get(key);
    if (!previous || (!previous.documentRevision && citation.documentRevision)) locations.set(key, citation);
  }
  return [...locations.values()];
}

function conflictFact(sources: Ground['sources']): string {
  const byValue = new Map<string, string[]>();
  for (const { label, address } of sources) {
    const value = externalLine([address.value, address.unit].filter((entry) => entry !== null).join(' '));
    const labels = byValue.get(value);
    if (labels) labels.push(label);
    else byValue.set(value, [label]);
  }
  const values = [...byValue].map(([value, labels]) => {
    const place = labels.length === 1 ? 'в источнике' : 'в источниках';
    return `${place} ${labels.join(' и ')} указано ${value}`;
  });
  return `Значения расходятся, ${values.join(', а ')}.`;
}

export function renderGround(ground: AssessmentGround): Ground {
  const { scope, subject, part, requestedAction, citations, kind } = ground;
  const item = subject === part ? subject : `${subject} — ${part}`;
  const intro = `${externalLine(scope.name)}. ${externalLine(item)}.`;
  const sources = (kind === 'confirmed_conflict' ? distinctConflictCitations(citations) : citations).map(clientSource);
  const action = externalLine(requestedAction).replace(/[.!?]+$/u, '');
  const direction = `Просим ${action.slice(0, 1).toLocaleLowerCase('ru')}${action.slice(1)}.`;
  let facts: string[];
  if (kind === 'confirmed_conflict') {
    facts = [conflictFact(sources)];
  } else {
    const formats = ground.requiredFormats.map(externalLine);
    const missing = formats.length ? `Не получен материал в требуемом формате (${formats.join(', ')}).` : 'Материал не передан.';
    const sourceLabels = [...new Set(sources.map(({ label }) => label))];
    const reference = sourceLabels.length ? `Основание: ${sourceLabels.join('; ')}.` : '';
    facts = [missing, reference].filter(Boolean);
  }
  return {
    questionId: ground.questionId,
    questionVersion: ground.questionVersion,
    decisionId: ground.decisionId,
    kind,
    scopeId: ground.scopeId,
    recipient: ground.recipient,
    subject,
    action: requestedAction,
    sources,
    basis: ground,
    wording: [intro, ...facts, direction].join(' '),
    alternativeWording: [intro, direction, ...facts].join(' '),
  };
}

export async function getGrounds(
  tx: Parameters<LetterDependencies['getGrounds']>[0],
  args: Parameters<LetterDependencies['getGrounds']>[1],
  readDocumentRevision: GroundsOptions['readDocumentRevision'],
): Promise<Ground[]> {
  try {
    const result = await selectConfirmedGrounds(tx, {
      projectId: args.projectId, scopeId: args.scopeId, recipient: args.recipient, items: args.selections, readDocumentRevision,
    });
    return result.items.map(renderGround);
  } catch (error) {
    if (error instanceof AssessmentError) {
      throw new LetterError(error.statusCode, error.code, error.message, error.details);
    }
    throw error;
  }
}
