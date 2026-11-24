type DeliveryStatus = 'delivered' | 'not_delivered';

const boundary = /[|·;,\r\n\u2028\u2029]+|(?<=[.!?…。！？])\s+/u;
const conjunction = /\s+(?:and|but|whereas|or|и|но|а|однако|либо|или)\s+/giu;
const leadingConjunction = /^(?:and|but|whereas|or|и|но|а|однако|либо|или) /u;
const subjectLabel = /^(?:item|subject|position|document|предмет|позиция|документ)\s*:\s*/iu;
const englishVerb = '(?:supplied|provided|delivered|included|sent|transmitted)';
const russianVerb = '(?:передан[аоы]?|предоставлен[аоы]?|поставлен[аоы]?|направлен[аоы]?|приложен[аоы]?|включ[её]н[аоы]?)';
const englishPositive = `(?:${englishVerb}|received)`;
const russianPositive = `(?:${russianVerb}|получен[аоы]?|принят[аоы]?)`;
const englishNegative = `(?:not ${englishVerb}|omitted)`;
const russianNegative = `(?:не ${russianVerb}|не вош[её]л|отсутствует)`;
const auxiliary = '(?:(?:was|were|is|are|has been|have been|бы(?:л|ла|ло|ли)) )?';
const reference = '(?:it|they|this|that|он|она|оно|они|(?:the(?: same)?|this|that) (?:item|document|file)|(?:этот|тот) (?:документ|файл)|эта позиция)';
const implicitPositive = new RegExp(`^(?:${reference} )?${auxiliary}(?:${englishPositive}|${russianPositive})[.!?…。！？]?$`, 'u');
const implicitNegative = new RegExp(`^(?:${reference} )?${auxiliary}(?:${englishNegative}|${russianNegative})[.!?…。！？]?$`, 'u');
const negativePredicate = new RegExp(`(?<!\\p{L})(?:${englishNegative}|${russianNegative})(?!\\p{L})`, 'gu');
const compact = (text: string) => text.normalize('NFKC').toLowerCase().trim().replace(/\s+/gu, ' ');
const clean = (text: string) => compact(text).replace(subjectLabel, '');

function statementPattern(name: string, status: DeliveryStatus) {
  const subject = `(?:the )?(?:(?:document|file|item|материал|документ|файл|позиция) )?[«"“]?${name}[»"”]?`;
  const negative = status === 'not_delivered';
  const english = negative ? englishNegative : englishPositive;
  const russian = negative ? russianNegative : russianPositive;
  const inPackage = '(?: in (?:this|the|current) (?:package|submission|delivery)| в (?:текущем )?(?:пакете|комплекте|составе))?';
  return new RegExp(`^(?:${subject}(?: [–—-] |: | )${auxiliary}(?:${english}|${russian})${inPackage}` +
    `|(?:${russian}|${english})[: ]+${subject})[.!?…。！？]?$`, 'u');
}

const literalName = (item: string) => compact(item).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function clauses(text: string, ...exact: RegExp[]) {
  return text.split(boundary).flatMap((part, index) => {
    const literal = clean(part);
    if (exact.some((pattern) => pattern.test(literal))) return [literal];
    const sentence = index ? literal.replace(leadingConjunction, '') : literal;
    const result: string[] = [];
    let start = 0;
    for (const match of sentence.matchAll(conjunction)) {
      const head = clean(sentence.slice(start, match.index));
      // A conjunction in the item name is not a boundary before its predicate.
      if (!namedPositive.test(head) && !namedNegative.test(head) && !implicitPositive.test(head) && !implicitNegative.test(head)) continue;
      result.push(head);
      start = match.index + match[0].length;
    }
    result.push(clean(sentence.slice(start)));
    return result;
  });
}

export function exactDeliveryStatement(quote: string, item: string, status: DeliveryStatus): boolean {
  const name = literalName(item);
  if (!name) return false;
  const pattern = statementPattern(name, status);
  return clauses(quote, pattern).some((clause) => pattern.test(clause));
}

// Withhold an unresolved affirmative pronoun or standalone status. An
// immediately preceding, explicitly named other item can own that status.
export function contradictoryDeliveryLine(line: string, item: string): boolean {
  const name = literalName(item);
  if (!name) return false;
  const positive = statementPattern(name, 'delivered');
  const negative = statementPattern(name, 'not_delivered');
  let otherAntecedent = false;
  for (const clause of clauses(line, positive, negative)) {
    if (!clause) continue;
    if (positive.test(clause) || clause.split(negativePredicate).slice(1).some((part) =>
      positive.test(part.trim()) || implicitPositive.test(part.trim()))) return true;
    if (implicitPositive.test(clause)) {
      if (!otherAntecedent) return true;
      continue;
    }
    otherAntecedent = !negative.test(clause) && (namedPositive.test(clause) || namedNegative.test(clause));
  }
  return false;
}

const namedSubject = '(?!(?:a|an|it|they|this|that|some|another|same|он|она|оно|они|этот|тот|тот же)(?: |$))' +
  '(?!(?:document|file|item|документ|файл|позиция)(?: (?:was|is|has been|бы(?:л|ла|ло|ли))? |$))' +
  '[\\p{L}\\p{N}][\\p{L}\\p{N} ._/-]*?';
const namedPositive = statementPattern(namedSubject, 'delivered');
const namedNegative = statementPattern(namedSubject, 'not_delivered');
