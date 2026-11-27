import { invalidInput } from "./store.js";

export type Original = { versionId: string; originalSha256: string };
export type ReviewSourceInput = Original & { anchor: string; quote?: string; limitation?: string };
export type ReviewSource = ReviewSourceInput & { documentId: string; label: string };
export type ReviewStatus = "present" | "partial" | "not_found" | "unassessed";
export type ReviewPropertyStatus = "confirmed" | "unanswered" | "not_mentioned" | "insufficient" | "conflicting";
const scopeFields = ["element","zone","purpose","variant"] as const;
export type ReviewScopeSide = { element: string; zone?: string; purpose?: string; variant?: string };
export type ReviewFactScope<S = ReviewSource> = {
  kind: "applicable" | "unrelated" | "undetermined"; target: ReviewScopeSide; observed?: ReviewScopeSide;
  reason: string; sources: S[]; basis?: "literal";
};
export type ReviewAnalysis<S = ReviewSource> = {
  applicability: { kind: "included" | "excluded" | "undetermined"; reason: string; sources: S[] };
  properties: {
    key: string; label: string; status: ReviewPropertyStatus; finding: string; sources: S[]; scope?: ReviewFactScope<S>;
    letter: { kind: "ask" | "omit"; text: string };
    response?: { state: "received" | "not_received"; finding: string; sources: S[] };
  }[];
  tensions: {
    key: string; propertyKey: string; status: "open" | "resolved"; finding: string;
    sides: { text: string; sources: S[] }[]; resolutionSources: S[];
  }[];
};
export type RetainedReviewFinding<S = ReviewSource> = { status: "present" | "partial"; finding: string; sources: S[] };

const key = (value: unknown) => typeof value === "string" && /^[a-z][a-z0-9_-]{0,49}$/.test(value);
const text = (value: unknown, max: number) => typeof value === "string" && value.trim().length > 0 && value.length <= max;
const grounded = (sources: ReviewSource[]) => sources.filter(source => source.quote && !source.limitation);
export function literalSource(source: Pick<ReviewSourceInput,"anchor">) {
  try { return JSON.parse(source.anchor)?.evidenceMode === "literal"; }
  catch { return false; }
}
const independent = (sources: ReviewSource[]) => grounded(sources).filter(source => !literalSource(source));
function literalBindingQuestion(target: ReviewScopeSide) {
  return target.zone ? `Уточните, относится ли запись «${target.element}» к участку «${target.zone}».`
    : `Уточните, к какому элементу и участку относится запись «${target.element}».`;
}
function scopeSide(side: ReviewScopeSide) {
  if (!side || typeof side !== "object" || !text(side.element,120) ||
      !Object.entries(side).every(([field,value]) => scopeFields.some(name => name === field) && text(value,120)))
    invalidInput("Некорректная область инженерного свойства.");
  return side;
}

const place = (source: ReviewSource) => JSON.stringify([source.versionId,source.anchor]);

export function enrichReviewAnalysis(analysis: ReviewAnalysis<ReviewSourceInput>, source: (item: ReviewSourceInput) => ReviewSource): ReviewAnalysis {
  const sources = (items: ReviewSourceInput[]) => {
    if (!Array.isArray(items) || items.length > 12) invalidInput("Некорректные основания разбора свойства.");
    return items.map(source);
  };
  const { applicability, properties, tensions } = analysis ?? {};
  if (!applicability || !["included", "excluded", "undetermined"].includes(applicability.kind) || !text(applicability.reason,420))
    invalidInput("Некорректное решение о применимости.");
  const applies = {kind:applicability.kind,reason:applicability.reason,sources:sources(applicability.sources)};
  if (applies.kind === "excluded" && !independent(applies.sources).length ||
      applies.kind !== "undetermined" && applies.sources.some(literalSource))
    invalidInput("Для решения о применимости требования нужно независимое адресное основание.");
  if (!Array.isArray(properties) || properties.length > 16 || !Array.isArray(tensions) || tensions.length > 12)
    invalidInput("Некорректный состав разбора свойства или противоречия.");

  const propertyKeys = new Set<string>(), held = new Set<string>(), literal = new Set<string>();
  const checkedProperties = properties.map(property => {
    if (!property || !key(property.key) || propertyKeys.has(property.key) || !text(property.label,120) ||
        !["confirmed", "unanswered", "not_mentioned", "insufficient", "conflicting"].includes(property.status) || !text(property.finding,550))
      invalidInput("Некорректное свойство требования.");
    propertyKeys.add(property.key);
    const { letter, response, scope } = property;
    let checkedResponse: ReviewAnalysis["properties"][number]["response"];
    if (response !== undefined) {
      if (!response || !["received","not_received"].includes(response.state) || !text(response.finding,350) ||
          response.state === "received" && property.status === "unanswered" ||
          response.state === "not_received" && property.status === "not_mentioned")
        invalidInput("Некорректное решение о получении ответа.");
      const basis = sources(response.sources);
      if (!independent(basis).length || basis.some(literalSource))
        invalidInput("Для статуса получения ответа нужен независимый адресный источник.");
      checkedResponse = {state:response.state,finding:response.finding,sources:basis};
    }
    const evidence = sources(property.sources);
    const supported = grounded(evidence).length > 0;
    if (["confirmed","unanswered"].includes(property.status) && !supported)
      invalidInput("Для подтверждённого или оставшегося без ответа свойства нужен источник.");
    if (!letter || !["ask","omit"].includes(letter.kind) || !text(letter.text,350) ||
        letter.kind === "ask" && (applies.kind === "excluded" || property.status === "confirmed" || !supported && !checkedResponse && property.status !== "conflicting"))
      invalidInput("Вопрос без открытого свойства или адресного основания.");
    let checkedScope: ReviewFactScope | undefined;
    const usesLiteralEvidence = evidence.some(literalSource);
    if (usesLiteralEvidence && scope === undefined)
      invalidInput("Для дословной записи требуется проверенная область.");
    if (scope !== undefined) {
      if (!scope || !["applicable","unrelated","undetermined"].includes(scope.kind) || !text(scope.reason,420) ||
          scope.basis !== undefined && scope.basis !== "literal")
        invalidInput("Некорректная проверка области инженерного свойства.");
      const context = sources(scope.sources);
      const target = scopeSide(scope.target);
      const observed = scope.observed === undefined ? undefined : scopeSide(scope.observed);
      if (scope.kind !== "undetermined" && (!observed || !grounded(context).length))
        invalidInput("Для установленной области свойства нужен адресный источник.");
      if (scope.kind !== "applicable") {
        if (property.status !== "insufficient" || letter.kind !== "omit" || checkedResponse || evidence.length)
          invalidInput("Для свойства с непроверенной областью оставьте результат на внутреннюю сверку.");
        held.add(property.key);
      }
      if (scope.kind === "applicable" && scope.basis === "literal" &&
          (property.status !== "confirmed" || letter.kind !== "omit" || checkedResponse || evidence.length !== 1 ||
            !evidence[0].quote || evidence[0].limitation ||
            property.finding !== 'В источнике указано: «' + evidence[0].quote.trim() + '».'))
        invalidInput("Дословная запись требует одной подтверждённой цитаты.");
      if (scope.kind === "applicable" && scope.basis !== "literal" &&
          (usesLiteralEvidence || context.some(literalSource) && !independent(context).length) &&
          (property.status !== "insufficient" || checkedResponse || letter.kind !== "ask" ||
            letter.text !== literalBindingQuestion(target)))
        invalidInput("Дословная запись позволяет поставить вопрос о привязке.");
      if (scope.basis === "literal") literal.add(property.key);
      checkedScope = {kind:scope.kind,target,...(observed && {observed}),reason:scope.reason,sources:context,
        ...(scope.basis && {basis:scope.basis})};
    }
    return {key:property.key,label:property.label,status:property.status,finding:property.finding,sources:evidence,
      ...(checkedScope && {scope:checkedScope}),
      ...(checkedResponse && {response:checkedResponse}), letter:{kind:letter.kind,text:letter.text}};
  });

  const tensionKeys = new Set<string>(), openTensions = new Set<string>();
  const checkedTensions = tensions.map(tension => {
    if (!tension || !key(tension.key) || tensionKeys.has(tension.key) || !propertyKeys.has(tension.propertyKey) || held.has(tension.propertyKey) || literal.has(tension.propertyKey) ||
        !["open","resolved"].includes(tension.status) || !text(tension.finding,550) ||
        !Array.isArray(tension.sides) || tension.sides.length < 2 || tension.sides.length > 4)
      invalidInput("Некорректное противоречие.");
    tensionKeys.add(tension.key);
    if (tension.status === "open") openTensions.add(tension.propertyKey);
    const positions = new Set<string>();
    const sides = tension.sides.map(side => {
      if (!side || !text(side.text,350)) invalidInput("Некорректная сторона противоречия.");
      const evidence = sources(side.sources);
      const locations = independent(evidence).map(place);
      if (!locations.length || evidence.some(literalSource) || locations.some(location => positions.has(location)))
        invalidInput("Каждой стороне противоречия нужен собственный адресный источник.");
      for (const location of locations) positions.add(location);
      return {text:side.text,sources:evidence};
    });
    const resolutionSources = sources(tension.resolutionSources);
    if (tension.status === "resolved"
      ? !independent(resolutionSources).length || resolutionSources.some(literalSource) : resolutionSources.length)
      invalidInput("Некорректное основание разрешения противоречия.");
    return {key:tension.key,propertyKey:tension.propertyKey,status:tension.status,finding:tension.finding,sides,resolutionSources};
  });
  if (checkedProperties.some(property => (property.status === "conflicting") !== openTensions.has(property.key)))
    invalidInput("Открытое противоречие должно быть связано со свойством.");
  return {applicability:applies,properties:checkedProperties,tensions:checkedTensions};
}

const normalizeQuestion = (value: string) => value.normalize("NFC").toLocaleLowerCase("ru").replaceAll("ё","е")
  .replace(/\s+/gu," ").trim().replace(/[.!?]+$/u,"");

export function renderPreliminaryQuestions(rows: { title: string; status: ReviewStatus; analysis?: ReviewAnalysis }[]) {
  const seen = new Set<string>();
  return rows.flatMap(row => (row.analysis?.properties ?? []).flatMap(property => {
    if (property.letter.kind !== "ask" || property.scope && property.scope.kind !== "applicable") return [];
    const target = property.scope?.target;
    const identity = JSON.stringify([normalizeQuestion(property.letter.text),target
      ? scopeFields.map(field=>normalizeQuestion(target[field] ?? "")) : normalizeQuestion(property.label)]);
    if (seen.has(identity)) return [];
    seen.add(identity);
    return [`${row.title} — ${property.label}. ${property.letter.text.trim()}`];
  })).join("\n\n") || (!rows.length || rows.some(row=>row.analysis?.applicability.kind !== "excluded" &&
    (["partial","unassessed"].includes(row.status) || row.analysis?.applicability.kind === "undetermined" ||
      row.analysis?.properties.some(property=>property.status !== "confirmed")))
    ? "Вопросы пока не сформированы. Для адресных вопросов недостаточно проверенных сведений."
    : "По результатам проверки открытых адресных вопросов для письма нет.");
}
