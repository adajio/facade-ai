import { invalidInput } from "./store.js";

export type Original = { versionId: string; originalSha256: string };
export type ReviewSourceInput = Original & { anchor: string; quote?: string; limitation?: string };
export type ReviewSource = ReviewSourceInput & { documentId: string; label: string };
export type ReviewStatus = "present" | "partial" | "not_found" | "unassessed";
export type ReviewPropertyStatus = "confirmed" | "unanswered" | "not_mentioned" | "insufficient" | "conflicting";
export type ReviewAnalysis<S = ReviewSource> = {
  applicability: { kind: "included" | "excluded" | "undetermined"; reason: string; sources: S[] };
  properties: {
    key: string; label: string; status: ReviewPropertyStatus; finding: string; sources: S[];
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
  if (applies.kind === "excluded" && !grounded(applies.sources).length)
    invalidInput("Для исключения требования нужно прямое основание.");
  if (!Array.isArray(properties) || properties.length > 16 || !Array.isArray(tensions) || tensions.length > 12)
    invalidInput("Некорректный состав разбора свойства или противоречия.");

  const propertyKeys = new Set<string>();
  const checkedProperties = properties.map(property => {
    if (!property || !key(property.key) || propertyKeys.has(property.key) || !text(property.label,120) ||
        !["confirmed", "unanswered", "not_mentioned", "insufficient", "conflicting"].includes(property.status) || !text(property.finding,550))
      invalidInput("Некорректное свойство требования.");
    propertyKeys.add(property.key);
    const { letter, response } = property;
    let checkedResponse: ReviewAnalysis["properties"][number]["response"];
    if (response !== undefined) {
      if (!response || !["received","not_received"].includes(response.state) || !text(response.finding,350) ||
          response.state === "received" && property.status === "unanswered" ||
          response.state === "not_received" && property.status === "not_mentioned")
        invalidInput("Некорректное решение о получении ответа.");
      const basis = sources(response.sources);
      if (!grounded(basis).length) invalidInput("Для статуса получения ответа нужен прямой источник.");
      checkedResponse = {state:response.state,finding:response.finding,sources:basis};
    }
    const evidence = sources(property.sources);
    const supported = grounded(evidence).length > 0;
    if (["confirmed","unanswered"].includes(property.status) && !supported)
      invalidInput("Для подтверждённого или оставшегося без ответа свойства нужен источник.");
    if (!letter || !["ask","omit"].includes(letter.kind) || !text(letter.text,350) ||
        letter.kind === "ask" && (applies.kind === "excluded" || property.status === "confirmed" || !supported && !checkedResponse && property.status !== "conflicting"))
      invalidInput("Вопрос без открытого свойства или адресного основания.");
    return {key:property.key,label:property.label,status:property.status,finding:property.finding,sources:evidence,
      ...(checkedResponse && {response:checkedResponse}), letter:{kind:letter.kind,text:letter.text}};
  });

  const tensionKeys = new Set<string>(), openTensions = new Set<string>();
  const checkedTensions = tensions.map(tension => {
    if (!tension || !key(tension.key) || tensionKeys.has(tension.key) || !propertyKeys.has(tension.propertyKey) ||
        !["open","resolved"].includes(tension.status) || !text(tension.finding,550) ||
        !Array.isArray(tension.sides) || tension.sides.length < 2 || tension.sides.length > 4)
      invalidInput("Некорректное противоречие.");
    tensionKeys.add(tension.key);
    if (tension.status === "open") openTensions.add(tension.propertyKey);
    const positions = new Set<string>();
    const sides = tension.sides.map(side => {
      if (!side || !text(side.text,350)) invalidInput("Некорректная сторона противоречия.");
      const evidence = sources(side.sources);
      const locations = grounded(evidence).map(place);
      if (!locations.length || locations.some(location => positions.has(location)))
        invalidInput("Каждой стороне противоречия нужен собственный адресный источник.");
      for (const location of locations) positions.add(location);
      return {text:side.text,sources:evidence};
    });
    const resolutionSources = sources(tension.resolutionSources);
    if (tension.status === "resolved" ? !grounded(resolutionSources).length : resolutionSources.length)
      invalidInput("Некорректное основание разрешения противоречия.");
    return {key:tension.key,propertyKey:tension.propertyKey,status:tension.status,finding:tension.finding,sides,resolutionSources};
  });
  if (checkedProperties.some(property => (property.status === "conflicting") !== openTensions.has(property.key)))
    invalidInput("Открытое противоречие должно быть связано со свойством.");
  return {applicability:applies,properties:checkedProperties,tensions:checkedTensions};
}

export function renderPreliminaryQuestions(rows: { title: string; analysis?: ReviewAnalysis }[]) {
  return rows.flatMap(row => (row.analysis?.properties ?? []).flatMap(property => property.letter.kind === "ask"
    ? [`${row.title} — ${property.label}. ${property.letter.text.trim()}`] : [])).join("\n\n")
    || "По доступным основаниям адресных вопросов для письма не установлено.";
}
