import { canonicalJson } from '../assessment/domain.js';
import { hashText } from './content.js';
import type { Ground, LetterItem, TextRange, WordingApproval, WordingReview } from './content.js';
import { LetterError } from './inputs.js';

function basisHash(ground: Ground) {
  return hashText(canonicalJson(ground.basis));
}

function managedWording(wording: string, ground: Ground) {
  const normalize = (value: string) => value.trim().replace(/[\t \n\r]+/gu, ' ');
  return [ground.wording, ground.alternativeWording].some((value) => normalize(value) === normalize(wording));
}

function storedApprovalMatches(item: LetterItem, ground: Ground) {
  const approval = item.wordingApproval;
  return item.editedWording !== null && approval !== undefined
    && approval.wordingSha256 === hashText(item.editedWording) && approval.basisSha256 === basisHash(ground);
}

export function wordingIsCurrent(item: LetterItem, ground: Ground) {
  return item.editedWording === null || managedWording(item.editedWording, ground) || storedApprovalMatches(item, ground);
}

function words(value: string): string[] {
  return value.normalize('NFKC').toLocaleLowerCase('ru').match(/[\p{L}\p{N}]+/gu) ?? [];
}

function scopeWords(value: string) {
  return words(value).map((word) => /^(?:фасада|фасаде|фасаду|фасадом)$/u.test(word) ? 'фасад' : word).join(' ');
}

function referenceWords(value: string) {
  return words(value).map((word) => /^(?:стр|страница|странице|страницы)$/u.test(word) ? 'стр' : word).join(' ');
}

function valueText(value: string) {
  return value.normalize('NFKC').toLocaleLowerCase('ru').trim().replace(/\s+/gu, ' ')
    .replace(/(?<=\d),(?=\d)/gu, '.').replace(/\u2212/gu, '-');
}

function actionMatches(value: string, kind: Ground['kind']) {
  const tokens = words(value);
  if (tokens.includes('не') || tokens.some((word) => /^(?:замен|демонт|исправ|измен|установ)/u.test(word))) return false;
  const operativeVerb = kind === 'confirmed_missing'
    ? /^(?:предостав(?:ьте|ить)|направ(?:ьте|ить)|пришлите|прислать|переда(?:йте|ть)|вышлите|выслать)$/u
    : /^(?:подтверд(?:ите|ить)|уточн(?:ите|ить)|сообщ(?:ите|ить)|укажите|указать)$/u;
  return tokens.some((word) => operativeVerb.test(word));
}

function assertReview(wording: string, ground: Ground, review: WordingReview) {
  if (hashText(wording) !== review.wordingSha256) {
    throw new LetterError(412, 'letter_wording_review_stale', 'Текст пункта изменился. Повторите сверку.', {
      questionId: ground.questionId,
    });
  }
  function mismatch(field: string, observationId?: string): never {
    throw new LetterError(422, 'letter_wording_basis_mismatch', 'Выделенный текст не соответствует актуальному основанию.', {
      questionId: ground.questionId, field, ...(observationId && { observationId }),
    });
  }
  function excerpt(range: TextRange, field: string, observationId?: string) {
    const value = wording.slice(range.start, range.end);
    const left = wording.slice(0, range.start);
    const right = wording.slice(range.end);
    if (range.end > wording.length || !value.trim() || !value.isWellFormed()
      || (/[\p{L}\p{N}\p{M}]$/u.test(left) && /^[\p{L}\p{N}\p{M}]/u.test(value))
      || (/[\p{L}\p{N}\p{M}]$/u.test(value) && /^[\p{L}\p{N}\p{M}]/u.test(right))) {
      mismatch(field, observationId);
    }
    if (field === 'value' && ((/^[\p{N}]/u.test(value) && /[+−-]$/u.test(left)) || /^[/^]/u.test(right))) {
      mismatch(field, observationId);
    }
    return value;
  }

  if (/\p{Cf}/u.test(wording)) mismatch('wording');

  const expectedScope = scopeWords(ground.basis.scope.name);
  if (scopeWords(excerpt(review.scope, 'scope')) !== expectedScope) mismatch('scope');
  // A second explicitly named façade must use the same designation. The selected
  // text also covers other scope naming conventions used by the catalog.
  const facade = /(?<![\p{L}\p{N}])[Фф]асад(?:а|е|у|ом)?\s+[«"„]?(?:[\p{Lu}]|\p{N}+)(?:[-–][\p{L}\p{N}]+|\p{N}+)?(?![\p{L}\p{N}])/gu;
  const allowedFacades = new Set([...ground.basis.scope.name.matchAll(facade)].map(([match]) => scopeWords(match)));
  if (allowedFacades.size && [...wording.matchAll(facade)].some(([match]) => !allowedFacades.has(scopeWords(match)))) {
    mismatch('scope');
  }

  const subject = words(excerpt(review.subject, 'subject')).sort().join(' ');
  const subjects = [ground.subject, `${ground.subject} ${ground.basis.part}`]
    .map((candidate) => words(candidate).sort().join(' '));
  if (!subject || !subjects.includes(subject)) mismatch('subject');

  const action = excerpt(review.action, 'action');
  if (!actionMatches(action, ground.kind)) mismatch('action');
  if (ground.kind === 'confirmed_missing' &&
    ground.basis.requiredFormats.some((format) => !words(format).every((token) => words(action).includes(token)))) {
    mismatch('action');
  }
  const numberRanges = [review.scope, review.subject];
  const checked = new Map(review.citations.map((citation) => [citation.observationId, citation]));
  if (checked.size !== ground.sources.length) mismatch('citations');
  for (const source of ground.sources) {
    const { observationId, unit, value } = source.address;
    const mark = checked.get(observationId);
    if (!mark) mismatch('citations', observationId);
    const reference = excerpt(mark.reference, 'reference', observationId);
    if (referenceWords(reference) !== referenceWords(source.label)) mismatch('reference', observationId);
    numberRanges.push(mark.reference);
    if (value === null) {
      if (mark.value) mismatch('value', observationId);
      continue;
    }
    if (!mark.value) mismatch('value', observationId);
    const quoted = excerpt(mark.value, 'value', observationId);
    if (valueText(quoted) !== valueText([value, unit].filter(Boolean).join(' '))) mismatch('value', observationId);
    numberRanges.push(mark.value);
  }

  // A marked reference or value cannot be used to approve a second, unsupported
  // number elsewhere in the wording.
  for (const match of wording.matchAll(/\p{N}+/gu)) {
    if (!numberRanges.some(({ start, end }) => start <= match.index && end >= match.index + match[0].length)) {
      mismatch('value');
    }
  }
}

export function approveWording(
  item: LetterItem, ground: Ground, review: WordingReview | undefined, actorId: string,
): WordingApproval | undefined {
  const wording = item.editedWording;
  if (review) {
    if (wording === null) {
      throw new LetterError(422, 'letter_wording_review_unexpected', 'У этого пункта нет авторской формулировки.', {
        questionId: ground.questionId,
      });
    }
    assertReview(wording, ground, review);
    return { ...review, actorId, confirmedAt: new Date().toISOString(), basisSha256: basisHash(ground) };
  }
  if (wording === null || managedWording(wording, ground)) return undefined;
  if (storedApprovalMatches(item, ground)) return item.wordingApproval;
  throw new LetterError(422, 'letter_wording_not_supported', 'Сверьте фрагменты формулировки с актуальным основанием.', {
    questionId: ground.questionId,
  });
}
