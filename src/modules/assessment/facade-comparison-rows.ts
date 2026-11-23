import { createHash } from "node:crypto";
import type { PoolClient } from "pg";
import type { PackageAnalysis, PackageFact } from "../harness/package-analysis.js";
import { verifiedNativeLineCrops } from "../pdf/native-line.js";
import { contains, validBox, type Evidence, type NativePresentation, type ReaderAddress, type ReaderLine } from "../pdf/types.js";
import { blockId, memoryVersion } from "../project-memory/contracts.js";
import { canonicalJson, requirementSubjectKey } from "./domain.js";

export type RowCitation = {
  observationId: string; evidenceId: string; runId: string; lineId: string;
  address: ReaderAddress; quote: string; href: string;
};

export type IssuedComparisonEvidence = { evidenceId: string; runId: string; content: string | null };
type Witness = { fact: PackageFact; evidence: Evidence; line: ReaderLine; key: string; citation: RowCitation };
export type CanonicalRow = {
  blockId: string; artifactSha256: string; lineId: string; text: string; address: ReaderAddress;
};
export type ComparisonRow = {
  key: string;
  property: string;
  role: PackageFact["sourceRole"];
  scopeKey: string;
  binding: PackageFact["binding"];
  value: RowCitation;
  context: RowCitation;
  canonical?: Pick<CanonicalRow, "blockId" | "artifactSha256" | "lineId">;
  composed: boolean;
};

const roleNames = new Map<string, PackageFact["sourceRole"]>([
  ["drawing", "drawing"], ["чертеж", "drawing"], ["чертёж", "drawing"],
  ["detail", "detail"], ["узел", "detail"], ["schedule", "schedule"], ["ведомость", "schedule"],
  ["specification", "specification"], ["спецификация", "specification"],
  ["calculation", "calculation"], ["расчёт", "calculation"], ["расчет", "calculation"],
]);
const facadeField = /^(?:(?:project )?facade(?: (?:id|identifier|mark|designation))?|фасад|(?:марка|обозначение|код|идентификатор) фасада(?: проекта)?)$/iu;
const buildingField = /^(?:building|block|корпус|здание|секция)$/iu;
const axesField = /^(?:axes|grid|оси)$/iu;
const revisionField = /^(?:revision|редакция)$/iu;
const inactive = /\b(?:superseded|obsolete|withdrawn|draft|not[ -]+current|previous)\b|замен[её]н|архивн|недействующ|не\s+действующ|неактуальн|отмен[её]н|черновик/iu;
const measure = /^[+-]?\d+(?:[.,]\d+)?$/u;
const unitLiteral = /^[\p{L}°µ%][\p{L}\p{N}°µ%/²³.-]{0,15}$/u;
const printedMeasure = /^([+-]?\d+(?:[.,]\d+)?)\s*(\S+)$/u;
const fieldPattern = /^([\p{L}][\p{L}\p{N} ._()/-]{0,99})\s*:\s*(.*)$/u;
const clauses = (text: string) => text.split("|").map((clause) => clause.trim());
const fields = (text: string) => clauses(text).flatMap((clause) => {
  const match = fieldPattern.exec(clause);
  return match ? [{ name: match[1].trim(), value: match[2], literal: clause }] : [];
});
const locatorKey = (locator: ReaderAddress["locator"], keys: string[]) => keys.map((key) => locator?.[key]);
const sheetKeys = ["sheet", "sheetId", "cell", "row", "column"];
const pageKeys = ["page", "rotation"];
const rowKey = (block: string, line: string) => canonicalJson([block, line]);

export async function readCanonicalComparisonRows(tx: PoolClient, projectId: string, facts: PackageFact[],
  evidence: ReadonlyMap<string, Evidence>): Promise<CanonicalRow[]> {
  const targets = new Map();
  for (const { observation: o } of facts) {
    const stored = evidence.get(o.evidenceId);
    if (stored?.format !== "pdf" || stored.representation !== "native" || o.grounding !== "text" ||
        !o.lineId || !o.value || o.limitation) continue;
    const { unitId } = o.address;
    const block = blockId(o.source, o.readerVersion, unitId);
    targets.set(rowKey(block, o.lineId), { block_id: block, line_id: o.lineId, unit_id: unitId,
      version_id: o.source.versionId, document_id: o.source.documentId, original_sha256: o.source.sha256, reader_version: o.readerVersion });
  }
  if (!targets.size) return [];
  const { rows } = await tx.query<CanonicalRow>(
    `SELECT b.id AS "blockId", b.artifact_sha256 AS "artifactSha256", l.line_id AS "lineId", l.literal AS text, l.address
       FROM jsonb_to_recordset($2::jsonb) AS t(block_id text, line_id text, unit_id text, version_id uuid,
         document_id uuid, original_sha256 text, reader_version text)
       JOIN project_memory_blocks b ON b.id=t.block_id AND b.project_id=$1 AND b.version_id=t.version_id
         AND b.unit_id=t.unit_id AND b.contract=$3
       JOIN project_memory_versions v ON v.project_id=b.project_id AND v.version_id=b.version_id AND v.contract=b.contract
       JOIN reader_maps r ON r.project_id=b.project_id AND r.version_id=b.version_id AND r.reader_version=v.reader_version
       JOIN project_memory_lines l ON l.block_id=b.id AND l.line_id=t.line_id
       WHERE v.reader_version=t.reader_version AND r.document_id=t.document_id
         AND r.original_sha256=t.original_sha256 AND r.format='pdf'
         AND b.ordinal<v.next_ordinal AND r.units->b.ordinal->>'id'=t.unit_id
         AND b.artifact_sha256 IS NOT NULL AND NOT ('native'=ANY(b.remaining)) AND NOT (b.address ? 'box')`,
    [projectId, JSON.stringify([...targets.values()]), memoryVersion],
  );
  return rows;
}

function nativeWitness(fact: PackageFact, evidence: Evidence, lines: ReaderLine[]): Witness | undefined {
  const { observation: o } = fact;
  if (o.id !== fact.id || o.grounding !== "text" || !o.quote || !o.lineId || o.alternatives?.length || o.deliveryStatement ||
      evidence.id !== o.evidenceId || evidence.runId !== o.runId || evidence.branch !== o.branch || fact.branch !== o.branch ||
      evidence.receiptId !== o.receiptId || evidence.readerVersion !== o.readerVersion ||
      canonicalJson(evidence.source) !== canonicalJson(o.source) || evidence.address.unitId !== o.address.unitId) return;
  const [line, duplicate] = lines.filter(({ id }) => id === o.lineId);
  if (!line || duplicate || !line.text.includes(o.quote)) return;
  let place;
  if (evidence.format === "pdf") {
    const box = line.box;
    const frame = evidence.address.box;
    place = locatorKey(o.address.locator, pageKeys);
    if (!box || !validBox(box) || !o.address.box || !validBox(o.address.box) || !contains(box, o.address.box) ||
        frame && (!validBox(frame) || !contains(frame, box)) ||
        place[0] !== Number(o.address.unitId) || canonicalJson(place) !== canonicalJson(locatorKey(evidence.address.locator, pageKeys))) return;
  } else {
    place = locatorKey(o.address.locator, sheetKeys);
    if (place.some((part) => part === undefined) || o.address.box || o.address.locator?.state !== "visible" ||
        canonicalJson(place) !== canonicalJson(locatorKey(line.locator, sheetKeys)) ||
        place[0] !== evidence.address.locator?.sheet || place[1] !== evidence.address.locator?.sheetId ||
        line.details?.hidden || line.details?.formula) return;
  }
  return { fact, evidence, line, key: canonicalJson([o.source, o.readerVersion, o.address.unitId, place, line.id]),
    citation: { observationId: fact.id, evidenceId: evidence.id, runId: o.runId, lineId: line.id,
      address: o.address, quote: o.quote, href: fact.evidenceHref } };
}

function issuedLines(evidence: Evidence, content: string | null): ReaderLine[] {
  if (!["pdf", "xlsx"].includes(evidence.format) || evidence.representation !== "native" ||
      evidence.mediaType !== "application/json" || evidence.limitations?.length || typeof content !== "string" ||
      Buffer.byteLength(content) !== evidence.size || createHash("sha256").update(content).digest("hex") !== evidence.sha256) return [];
  try {
    const body = JSON.parse(content) as Partial<NativePresentation> | null;
    return Array.isArray(body?.lines) && canonicalJson(body.address) === canonicalJson(evidence.address) ?
      body.lines.filter((line) => typeof line?.text === "string") : [];
  } catch {
    return [];
  }
}

function provesFullRow(context: Witness, anchor: Witness, canonical: CanonicalRow | undefined, label: string, measured: string) {
  if (anchor.evidence.format === "xlsx") return context.line.text === anchor.line.text;
  if (!canonical || !canonical.address.box || !/^[0-9a-f]{64}$/u.test(canonical.artifactSha256) ||
      canonical.address.unitId !== anchor.evidence.address.unitId ||
      canonicalJson(locatorKey(canonical.address.locator, pageKeys)) !==
        canonicalJson(locatorKey(anchor.evidence.address.locator, pageKeys))) return false;
  const full = { id: canonical.lineId, text: canonical.text, box: canonical.address.box };
  if (context.line.text === full.text && anchor.line.text === full.text) {
    return [context, anchor].every(({ line }) => canonicalJson(line.box) === canonicalJson(full.box));
  }
  const crops = [context, anchor].flatMap(({ evidence, line }) => evidence.address.box ?
    [{ evidenceId: evidence.id, frame: evidence.address.box, line }] : []);
  return crops.length === 2 && clauses(context.line.text).at(-1) === label && clauses(anchor.line.text)[0] === measured &&
    verifiedNativeLineCrops(full, crops, anchor.evidence.id, anchor.citation.quote)?.crops.length === 2;
}

function isAddressedMeasure(anchor: Witness, field: ReturnType<typeof fields>[number], value: string, unit: string) {
  const parsed = printedMeasure.exec(field.value);
  if (!parsed || parsed[1] !== value || parsed[2] !== unit) return false;
  const { text } = anchor.line;
  const quote = anchor.citation.quote;
  const start = text.indexOf(quote);
  const fieldStart = text.indexOf(field.literal);
  const measureStart = fieldStart + field.literal.lastIndexOf(field.value);
  return start === text.lastIndexOf(quote) && fieldStart === text.lastIndexOf(field.literal) &&
    start <= measureStart && start + quote.length >= measureStart + value.length;
}

function contextRole(witness: Witness, profile: PackageAnalysis["facadeProfiles"][number] | undefined) {
  const { fact, line, citation, evidence } = witness;
  const [candidate, other] = fact.binding.candidates;
  if (!candidate || other || fact.binding.state !== "identified" || !fact.binding.quote || !profile) return;
  const mention = profile.mentions.find((mention) =>
    mention.factId === fact.id && mention.evidenceId === citation.evidenceId && mention.lineId === line.id &&
    mention.branch === fact.branch && mention.versionId === evidence.source.versionId &&
    mention.readerVersion === evidence.readerVersion && canonicalJson(mention.address) === canonicalJson(citation.address));
  if (!mention || !line.text.includes(mention.quote) || !citation.quote.includes(fact.binding.quote)) return;
  const row = fields(line.text);
  const [mark, another] = row.filter(({ name }) => facadeField.test(name));
  const buildings = row.filter(({ name }) => buildingField.test(name));
  const axes = row.filter(({ name }) => axesField.test(name));
  const registered = mention.kind === "registry";
  if (!mark || another || !citation.quote.includes(mark.literal) || requirementSubjectKey(mark.value) !== requirementSubjectKey(candidate.label) ||
      buildings.length > 1 || axes.length > 1 || (!registered && (!mention.context ||
        buildings[0]?.value !== mention.context.building || axes[0]?.value !== mention.context.axes))) return;
  const [roleText, ...rest] = clauses(line.text);
  const role = roleNames.get(roleText.toLowerCase());
  if (!role || !citation.quote.startsWith(roleText) || rest.some((part) => !fieldPattern.test(part)) ||
      fact.sourceRole !== "unknown" && (fact.sourceRole !== role || !fact.basis.role || !roleText.includes(fact.basis.role))) return;
  const scopeKey = canonicalJson([candidate.id, requirementSubjectKey(mark.value),
    ...[buildings[0]?.value, axes[0]?.value].map((value) => value && requirementSubjectKey(value))]);
  return { role, scopeKey };
}

/** Compose only candidate-review inputs. Each witness is checked against its own run's issued native bytes. */
export function comparisonRows(facts: PackageFact[], formats: ReadonlyMap<string, string>, evidence: ReadonlyMap<string, Evidence>,
  issued: IssuedComparisonEvidence[], profiles: PackageAnalysis["facadeProfiles"], native: CanonicalRow[]): Map<string, ComparisonRow> {
  const canonicalByRow = Map.groupBy(native, (row) => rowKey(row.blockId, row.lineId));
  const issuedByEvidence = new Map(issued.map((event) => [event.evidenceId, event]));
  const parsed = new Map<string, ReaderLine[]>();
  const witnesses = facts.toSorted((a, b) => a.id.localeCompare(b.id)).flatMap((fact) => {
    const stored = evidence.get(fact.observation.evidenceId);
    const event = issuedByEvidence.get(fact.observation.evidenceId);
    if (!stored || !event || event.runId !== stored.runId || stored.format !== formats.get(fact.windowId)) return [];
    if (!parsed.has(stored.id)) parsed.set(stored.id, issuedLines(stored, event.content));
    const witness = nativeWitness(fact, stored, parsed.get(stored.id)!);
    return witness ? [witness] : [];
  });
  const scoped = Map.groupBy(witnesses, ({ fact, key }) => canonicalJson([fact.branch, fact.observation.receiptId, key]));
  const profileById = new Map(profiles.filter(({ identity }) => identity !== "unresolved").map((profile) => [profile.facadeId, profile]));
  const result = new Map<string, ComparisonRow>();
  for (const group of scoped.values()) {
    const revisionFields = group.flatMap(({ line }) => fields(line.text).filter(({ name }) => revisionField.test(name)).map(({ value }) => value));
    const revisions = new Set(group.flatMap(({ fact }) => fact.revision ? [requirementSubjectKey(fact.revision)] : []));
    if (new Set(revisionFields.map(requirementSubjectKey)).size > 1 || revisionFields.some((value) => !value || inactive.test(value)) ||
        revisions.size > 1 || group.some(({ fact }) => fact.revisionStatus === "superseded")) continue;
    const identities = new Set(group.flatMap(({ fact }) => fact.binding.candidates.map(({ id }) => id)));
    const attributes = new Set(group.flatMap(({ fact }) => fact.attribute ? [requirementSubjectKey(fact.attribute)] : []));
    if (identities.size !== 1 || attributes.size !== 1 || group.some(({ fact }) =>
      fact.binding.state === "common" || fact.binding.state === "unclear")) continue;
    const contexts = group.flatMap((witness) => {
      if (!witness.fact.attribute) return [];
      const candidate = witness.fact.binding.candidates[0];
      const context = candidate && contextRole(witness, profileById.get(candidate.id));
      return context ? [{ witness, ...context }] : [];
    });
    if (new Set(contexts.map(({ role, scopeKey }) => canonicalJson([role, scopeKey]))).size !== 1) continue;
    if (group.some(({ fact }) => fact.sourceRole !== "unknown" && fact.sourceRole !== contexts[0].role)) continue;
    for (const anchor of group) {
      const { fact, line } = anchor;
      const { value, unit, source, readerVersion, address } = fact.observation;
      if (fact.observation.limitation || !value || !unit || !measure.test(value) || !unitLiteral.test(unit)) continue;
      const [canonical, duplicateRow] = canonicalByRow.get(rowKey(blockId(source, readerVersion, address.unitId), line.id)) ?? [];
      if (duplicateRow) continue;
      const matching = contexts.flatMap((context) => {
        const { witness } = context;
        const property = witness.fact.attribute!;
        const names = (text: string) => fields(text).filter(({ name }) => requirementSubjectKey(name) === requirementSubjectKey(property));
        const [field, duplicate] = names(line.text);
        const [contextField, duplicateContext] = names(witness.line.text);
        if (!field || duplicate || !contextField || duplicateContext ||
            !witness.citation.quote.includes(contextField.name) || !isAddressedMeasure(anchor, field, value, unit) ||
            !provesFullRow(witness, anchor, canonical, contextField.literal, field.literal) ||
            (line.text !== witness.line.text && (contextField.value || clauses(line.text).length !== 1))) return [];
        return [{ ...context, property, measured: field.literal }];
      });
      if (!matching.length) continue;
      // Prefer the anchor's own scope when it has a validated row; other witnesses remain within its branch.
      const { witness, role, scopeKey, property, measured } = matching.find(({ witness }) => witness === anchor) ?? matching[0];
      const physicalPlace = anchor.evidence.format === "pdf" ?
        ["pdf", ...locatorKey(address.locator, pageKeys), line.id] :
        ["xlsx", address.locator?.sheetId, address.locator?.cell];
      result.set(fact.id, { key: canonicalJson([source, physicalPlace]), property, role, scopeKey, binding: witness.fact.binding,
        value: { ...anchor.citation, quote: measured }, context: witness.citation,
        ...(canonical && anchor.evidence.format === "pdf" ? { canonical: {
          blockId: canonical.blockId, artifactSha256: canonical.artifactSha256, lineId: canonical.lineId,
        } } : {}),
        composed: !fact.attribute || witness !== anchor || fact.sourceRole !== role });
    }
  }
  return result;
}
