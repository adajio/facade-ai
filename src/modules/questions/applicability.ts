import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import type { Pool, PoolClient } from "pg";
import { authorize, readSession, requireAccess, uuid } from "../access/auth.js";
import { executeCommand, transaction } from "../access/commands.js";
import { AccessError, invalid, unavailable } from "../access/errors.js";
import { canonicalJson, type Finding, type Review } from "../assessment/domain.js";
import { facadeAssessmentHref } from "../assessment/facade-store.js";
import { assessmentHref, getLockedGate, getQuestions, synchronize, normalizeFormat } from "../assessment/store.js";
import { applyAssessmentUpdate } from "../assessment/updates.js";
import { createIntakeStorage } from "../intake/blob.js";
import { createRuntimePdfService } from "../pdf/index.js";
import type { Observation } from "../pdf/types.js";
import { publishProjectEvent } from "../supplements/events.js";
import { deliveredLines, readAttributeAliases } from "./attribute-aliases.js";
import { normalize } from "./domain.js";
import type { ObservationPublication, QuestionSearchPorts } from "./domain.js";
import { createReaderSupportOpener, createRuntimeInquiryPorts } from "./reader.js";
import { facadeSupplementOptions, getReplacementQuestion, replaceFacadeSources } from "./facade-replacement.js";
import { refreshAssessmentInquiries } from "./store.js";
import { hasAddressedSubject, isAttributeAlias } from "./subject-evidence.js";

type Reference = { observationId: string; evidenceId: string; versionId: string };
type ScopedQuestion = { projectId: string; scopeId: string; assessmentContextId: string | null };
type ProofRow = { source: ObservationPublication; observation: Observation };
type OpenProof = ProofRow & { representation: Awaited<ReturnType<QuestionSearchPorts["openSupport"]>> & object };

function text(value: unknown, limit: number): string {
  if (typeof value !== "string" || !value.trim() || value.length > limit || !value.isWellFormed() || value.includes("\0")) {
    throw invalid();
  }
  return value.trim();
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw invalid();
  return value as Record<string, unknown>;
}

function references(value: unknown, allowEmpty = false): Reference[] {
  if (!Array.isArray(value) || (!allowEmpty && !value.length) || value.length > 16) throw invalid();
  const entries = value.map((element) => {
    const item = record(element);
    return { observationId: uuid(item.observationId), evidenceId: uuid(item.evidenceId), versionId: uuid(item.versionId) };
  });
  if (new Set(entries.map(({ observationId }) => observationId)).size !== entries.length) throw invalid();
  return entries.sort((a, b) => a.observationId.localeCompare(b.observationId));
}

async function locate(db: Pool | PoolClient, id: string): Promise<ScopedQuestion> {
  const { rows: [row] } = await db.query<ScopedQuestion>(
    `SELECT s.project_id AS "projectId",s.scope_id AS "scopeId",s.assessment_context_id AS "assessmentContextId"
     FROM assessment_questions q JOIN assessment_series s ON s.scope_id=q.scope_id WHERE q.id=$1`, [id],
  );
  if (!row) throw unavailable();
  return row;
}

async function currentQuestion(tx: PoolClient, ref: ScopedQuestion, id: string) {
  const { projectId, scopeId } = ref;
  const gate = await getLockedGate(tx, projectId, scopeId);
  const revision = await synchronize(tx, projectId, scopeId, gate);
  const question = (await getQuestions(tx, scopeId, revision.version)).find((q) => q.active && q.id === id);
  const { rows: [scope] } = await tx.query<{ version: number }>(
    "SELECT version FROM project_scopes WHERE id=$1 AND project_id=$2", [scopeId, projectId],
  );
  if (!question || !scope || !revision.catalog_version_id) throw unavailable();
  return { question, scopeVersion: scope.version, catalogVersionId: revision.catalog_version_id, gate, revision };
}

type Current = Awaited<ReturnType<typeof currentQuestion>>;

async function openProofs(
  tx: PoolClient, state: Current, ref: ScopedQuestion, refs: Reference[], ports: QuestionSearchPorts,
): Promise<OpenProof[]> {
  const { rows } = await tx.query<ProofRow>(
    `SELECT i.source,o.payload AS observation
     FROM inquiry_observations i JOIN reader_observations o ON o.id=i.id
     JOIN intake_receipts r ON r.project_id=i.project_id AND r.id=(i.source->>'receiptId')::uuid AND r.sealed_at IS NOT NULL
     WHERE i.id=ANY($1::uuid[]) AND i.project_id=$2 AND i.scope_id=$3 AND i.source->>'assessmentQuestionId'=$4
       AND i.stage=$5 AND NOT i.superseded
       AND NOT EXISTS (SELECT 1 FROM inquiry_replaced_places x
         WHERE x.question_id=$4::uuid AND x.catalog_version_id=$6 AND x.scope_version=$7
         AND x.version_id=i.version_id AND x.address=i.source->'address')`,
    [refs.map(({ observationId }) => observationId), ref.projectId, ref.scopeId, state.question.id,
      state.revision.scope.stage, state.catalogVersionId, state.scopeVersion],
  );
  const existing = new Map(rows.map((row) => [row.source.observationId, row]));
  const signal = AbortSignal.timeout(30_000);
  const proofs: OpenProof[] = [];
  for (const entry of refs) {
    const row = existing.get(entry.observationId);
    if (!row || row.source.versionId !== entry.versionId || row.source.evidenceId !== entry.evidenceId) throw unavailable();
    const { source } = row;
    if (!source.format || !state.question.requirement.formats.includes(normalizeFormat(source.format))) {
      throw invalid("support_format_not_admitted", "Формат опоры отсутствует в действующем требовании.");
    }
    if (source.revision !== "effective" || !source.readable || !source.measurement ||
      !state.question.requirement.sourceRoles.includes(source.role) || !source.comparableContext) {
      throw invalid("support_unverified", "Для опоры требуется действующая область, роль и адресуемое значение.");
    }
    const representation = await ports.openSupport(source, signal);
    if (!representation) throw invalid("support_unavailable", "Оригинал или адресное представление недоступны.");
    proofs.push({ ...row, representation });
  }
  return proofs;
}

function asTarget(state: Current, aliases: readonly string[] = []) {
  return { subject: state.question.requirement.subject, property: state.question.requirement.part, aliases };
}

function bound(proof: OpenProof, target: ReturnType<typeof asTarget>): boolean {
  return proof.representation.content.kind === "text" &&
    hasAddressedSubject(target, proof.observation, deliveredLines(proof.representation.content.text));
}

function currentReview(state: Current): Review {
  const { question, revision, gate } = state;
  const review = question.review;
  if (question.requirement.applicability !== "applicable" || !review || review.inventory ||
    !review.completenessChecked || review.remaining.length || revision.input_generation !== gate.generation) {
    throw invalid("review_incomplete", "Требуется завершённая сверка текущего поколения и установленная применимость вопроса.");
  }
  return review;
}

function requireIndependent(proofs: OpenProof[]) {
  const lead = proofs.filter(({ source }) => source.branch === "A");
  if (!lead.some(({ observation }) => proofs.some(({ source, observation: other }) =>
    source.branch === "B" && other.runId !== observation.runId))) {
    throw invalid("independent_support_required", "Подтвердите опоры обеих независимых ветвей.");
  }
}

function addressedFindings(review: Review, proofs: OpenProof[], mustBeActive: boolean): Map<string, Finding> {
  const byId = new Map(review.findings.map((finding) => [finding.citation.observationId, finding]));
  const valid = new Map<string, Finding>();
  for (const { source } of proofs) {
    const finding = byId.get(source.observationId);
    if (!finding || finding.kind !== "value" || finding.applicability === "superseded" ||
      (mustBeActive && finding.applicability !== "active") || finding.sourceRole !== source.role) {
      throw invalid("support_outside_review", "Опора отсутствует среди текущих числовых оснований вопроса.");
    }
    valid.set(source.observationId, finding);
  }
  return valid;
}

export async function registerApplicability(app: FastifyInstance) {
  let runtime: ReturnType<typeof createRuntimePdfService> | undefined;
  let storage: ReturnType<typeof createIntakeStorage> | undefined;
  app.addHook("onClose", async () => { storage?.objects.close(); });
  const resources = () => {
    storage ??= createIntakeStorage(app.config.dataDir);
    runtime ??= createRuntimePdfService(app.db, app.config, { storage });
    return { runtime, objects: storage.objects };
  };

  for (const prefix of ["/api", "/api/v1"]) {
    const path = `${prefix}/questions/:id`;
    app.get<{ Params: { id: string }; Querystring: { supplement?: string } }>(`${path}/applicability`, async (request, reply) => {
      const id = uuid(request.params.id);
      const ref = await locate(app.db, id);
      await requireAccess(app.db, request, {
        projectId: ref.projectId, scopeId: ref.assessmentContextId ? undefined : ref.scopeId, action: "project:read",
      });
      if (ref.assessmentContextId) {
        const readHistory = async (db: Pool | PoolClient) => (await db.query(
          `SELECT id,catalog_version_id AS "catalogVersionId", author_id AS "authorId",reason,replaced,replacements,
            receipt_ids AS "receiptIds",created_at AS "createdAt"
           FROM facade_source_replacements WHERE question_id=$1 ORDER BY created_at DESC,id LIMIT 100`, [id],
        )).rows;
        const { projectId, assessmentContextId } = ref;
        if (request.query.supplement === "1") {
          const body = await transaction(app.db, async (tx) => {
            await authorize(tx, await readSession(tx, request), { projectId, action: "project:engineer" });
            const state = await getReplacementQuestion(tx, projectId, assessmentContextId, id);
            return { aliases: [], replacements: await readHistory(tx), supplement: await facadeSupplementOptions(tx, state, projectId) };
          });
          return reply.header("Cache-Control", "no-store").send(body);
        }
        return reply.header("Cache-Control", "no-store").send({ aliases: [], replacements: await readHistory(app.db) });
      }
      const [aliases, replacements] = await Promise.all([
        app.db.query(
          `SELECT catalog_version_id AS "catalogVersionId",scope_version AS "scopeVersion",alias,
            author_id AS "authorId",reason,proof,created_at AS "createdAt"
           FROM inquiry_attribute_aliases WHERE question_id=$1 ORDER BY created_at DESC,alias_key LIMIT 100`, [id],
        ),
        app.db.query(
          `SELECT id,catalog_version_id AS "catalogVersionId",scope_version AS "scopeVersion",
            author_id AS "authorId",reason,replaced,replacements,created_at AS "createdAt"
           FROM inquiry_source_replacements WHERE question_id=$1 ORDER BY created_at DESC,id LIMIT 100`, [id],
        ),
      ]);
      return reply.header("Cache-Control", "no-store").send({ aliases: aliases.rows, replacements: replacements.rows });
    });

    for (const operation of ["attribute-aliases", "source-replacements"] as const) {
      app.post<{ Params: { id: string } }>(`${path}/${operation}`, async (request, reply) => {
        const id = uuid(request.params.id);
        const ref = await locate(app.db, id);
        const body = record(request.body);
        const alias = operation === "attribute-aliases" ? text(body.alias, 256) : undefined;
        const reason = text(body.reason, 2000);
        const selected = references(alias === undefined ? body.replacements : body.proof);
        const retired = alias === undefined ? references(body.replaced, Boolean(ref.assessmentContextId)) : [];
        if (ref.assessmentContextId) {
          if (alias !== undefined) throw unavailable();
          const { projectId, assessmentContextId } = ref;
          let state: Awaited<ReturnType<typeof getReplacementQuestion>>;
          const result = await executeCommand(app.db, request, {
            operation: "inquiry.source-replacements", requirement: { projectId, action: "project:engineer" },
            input: { id, reason, selected, retired },
            async version(tx) {
              state = await getReplacementQuestion(tx, projectId, assessmentContextId, id);
              return { current: state.question.version, href: facadeAssessmentHref(projectId) };
            },
          }, async (tx, actor) => {
            const { runtime, objects } = resources();
            const body = await replaceFacadeSources(tx, {
              id: randomUUID(), state, projectId, selected, retired, reason, actorId: actor.userId,
              open: createReaderSupportOpener(app.db, runtime, objects, tx),
            });
            return { status: 201, body, audit: { objectId: id, version: body.version, details: { selected, retired } } };
          });
          if (result.replayed) reply.header("Idempotency-Replayed", "true");
          return reply.header("Cache-Control", "no-store").header("ETag", `"${result.body.version}"`).code(result.status).send(result.body);
        }
        let state: Current;
        const result = await executeCommand(app.db, request, {
          operation: `inquiry.${operation}`, requirement: { ...ref, action: "project:engineer" },
          input: { id, alias, reason, selected, retired },
          async version(tx) {
            state = await currentQuestion(tx, ref, id);
            return { current: state.question.version, href: assessmentHref(ref.projectId, ref.scopeId) };
          },
        }, async (tx, actor) => {
          const review = currentReview(state);
          const { runtime, objects } = resources();
          const ports = createRuntimeInquiryPorts(app.db, runtime, objects, undefined, tx);
          const opened = await openProofs(tx, state, ref, selected, ports);
          requireIndependent(opened);
          const verified = addressedFindings(review, opened, alias === undefined);
          const eventId = randomUUID();
          const { catalogVersionId, scopeVersion } = state;

          let revisedFindings: Finding[];
          if (alias !== undefined) {
            if (opened.some((proof) => !isAttributeAlias(asTarget(state), alias, proof.source.measurement!.unit) ||
              !bound(proof, { subject: alias, property: alias, aliases: [] }))) {
              throw invalid("attribute_alias_unverified", "Адреса должны содержать отличительный атрибут подтверждаемого синонима.");
            }
            const { rowCount } = await tx.query(
              `INSERT INTO inquiry_attribute_aliases
                 (question_id,catalog_version_id,scope_version,alias_key,alias,author_id,reason,proof)
               VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb) ON CONFLICT DO NOTHING`,
              [id, catalogVersionId, scopeVersion, normalize(alias), alias, actor.userId, reason, JSON.stringify(selected)],
            );
            if (!rowCount) throw new AccessError(409, "attribute_alias_exists", "Этот синоним уже подтверждён.");
            revisedFindings = review.findings.map((finding) =>
              verified.has(finding.citation.observationId) ? { ...finding, applicability: "active" } : finding);
          } else {
            const aliases = await readAttributeAliases(tx, id);
            if (opened.some((proof) => !bound(proof, asTarget(state, aliases)))) {
              throw invalid("replacement_subject_unverified", "Применимость новых опор к вопросу не установлена.");
            }
            const old = await openProofs(tx, state, ref, retired, ports);
            addressedFindings(review, old, true);
            const replacingVersions = new Set(selected.map(({ versionId }) => versionId));
            if (old.some(({ source }) => replacingVersions.has(source.versionId))) {
              throw invalid("replacement_same_version", "Укажите новую редакцию основания.");
            }
            const places = new Map(old.map(({ source }) => [canonicalJson([source.versionId, source.address]), source]));
            await tx.query(
              `INSERT INTO inquiry_source_replacements
                 (id,question_id,catalog_version_id,scope_version,author_id,reason,replaced,replacements)
               VALUES($1,$2,$3,$4,$5,$6,$7::jsonb,$8::jsonb)`,
              [eventId, id, catalogVersionId, scopeVersion, actor.userId, reason, JSON.stringify(retired), JSON.stringify(selected)],
            );
            for (const { versionId, address } of places.values()) await tx.query(
              `INSERT INTO inquiry_replaced_places (replacement_id,question_id,catalog_version_id,scope_version,version_id,address)
               VALUES($1,$2,$3,$4,$5,$6)`, [eventId, id, catalogVersionId, scopeVersion, versionId, address],
            );
            revisedFindings = review.findings.filter(({ citation }) => !places.has(canonicalJson([citation.versionId, citation.address])));
          }

          const applied = await applyAssessmentUpdate(tx, {
            ...ref, eventId, reason, changes: [{ questionId: id, expectedDependencyVersion: state.question.dependency_version,
              review: { ...review, inputGeneration: state.gate.generation, findings: revisedFindings } }],
          });
          const updated = (await getQuestions(tx, ref.scopeId, applied.assessmentVersion)).find((q) => q.id === id);
          if (!updated) throw unavailable();
          const inquiryIds = await refreshAssessmentInquiries(tx, ref.projectId, ref.scopeId, id, catalogVersionId,
            alias === undefined ? opened[0].source.observationId : undefined);
          await publishProjectEvent(tx, ref.projectId, {
            type: "inquiries.changed", payload: { scopeId: ref.scopeId, inquiryIds, questionId: id },
          });
          return {
            status: 201, body: { id: eventId, questionId: id, version: updated.version, assessmentVersion: applied.assessmentVersion },
            audit: { objectId: id, version: updated.version, details: { eventId, selected, retired } },
          };
        });
        if (result.replayed) reply.header("Idempotency-Replayed", "true");
        return reply.header("Cache-Control", "no-store").code(result.status).send(result.body);
      });
    }
  }
}
