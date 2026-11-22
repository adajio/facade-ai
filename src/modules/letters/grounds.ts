import { selectConfirmedGrounds } from '../assessment/commands.js';
import type { Ground as AssessmentGround, GroundsOptions } from '../assessment/commands.js';
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
    ['layout', 'лист'], ['view', 'вид'], ['handle', 'объект'],
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

export function renderGround(ground: AssessmentGround): Ground {
  const { scope, subject, part, requestedAction, citations, kind } = ground;
  const item = subject === part ? subject : `${subject} — ${part}`;
  const intro = `${externalLine(scope.name)}. ${externalLine(item)}.`;
  const sources = citations.map(clientSource);
  const action = externalLine(requestedAction).replace(/[.!?]+$/u, '');
  const direction = `Просим ${action.slice(0, 1).toLocaleLowerCase('ru')}${action.slice(1)}.`;
  let facts: string[];
  if (kind === 'confirmed_conflict') {
    const values = citations.map((citation, index) => {
      const value = [citation.value, citation.unit].filter((entry) => entry !== null).join(' ');
      return `в источнике ${sources[index].label} указано ${externalLine(value)}`;
    });
    facts = [`Значения расходятся, ${values.join(', а ')}.`];
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
