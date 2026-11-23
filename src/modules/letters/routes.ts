import { randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { PoolClient } from 'pg';
import { accessConfig, authorize, checkCsrf, checkOrigin, readCookie, readSession, touchSession } from '../access/auth.js';
import type { AccessActor, AccessRequirement } from '../access/auth.js';
import { executeCommand, lockOrganization, lockSession, transaction } from '../access/commands.js';
import { AccessError, sendAccessError, unavailable } from '../access/errors.js';
import { facadeAssessmentHref, getLockedFacadeContext } from '../assessment/facade-store.js';
import { lockIntakeProject } from '../intake/gate.js';
import { contentTypes, hashText, renderDocument, renderText } from './content.js';
import type { Ground, LetterItem, Selection } from './content.js';
import {
  LetterError, assessmentTarget, expectedVersion, identifier, parseConfirm, parseCreate, parseExport, parsePage, parsePatch,
  parseResponse, parseSent,
} from './inputs.js';
import {
  addLetter, exportReceipt, getExportMetadata, getLetter, getRevision, getSent, listLetters, putExport,
  putResponse, putRevision, putSent, readExport, readHistory, readResponse, summary,
} from './store.js';
import type { Letter, Revision } from './store.js';
import { approveWording, wordingIsCurrent } from './wording.js';

type ProjectRequirement = Extract<AccessRequirement, { projectId: string }>;
type LetterTarget = { scopeId?: string | null; assessmentContextId?: string | null };
type LetterResources = LetterTarget & { projectId: string; recipient?: string; selections?: Selection[] };

export interface LetterDependencies {
  lockScopes: (tx: PoolClient, projectId: string, scopeIds: readonly string[]) => Promise<unknown>;
  getHolds: (tx: PoolClient, projectId: string, scopeId: string) => Promise<readonly unknown[]>;
  getGrounds: (tx: PoolClient, args: LetterResources) => Promise<Ground[]>;
}

function isEngineer(actor: AccessActor) {
  return actor.role === 'engineer' || actor.role === 'project_manager';
}

function scopeError(holds: readonly unknown[]): never {
  throw new LetterError(409, 'scope_held', 'В области ожидается проверка поступивших материалов.', { holds });
}

function noEligible(): never {
  throw new LetterError(422, 'no_eligible_items', 'Нет подтверждённых пунктов для письма.');
}

function stale(letter: Letter): never {
  throw new LetterError(412, 'letter_basis_stale', 'Проверьте изменившиеся основания письма.', {
    href: letter.assessmentContextId ? facadeAssessmentHref(letter.projectId) :
      `/api/projects/${letter.projectId}/assessments/current?scopeId=${letter.scopeId}`,
  });
}

function unconfirmed(): never {
  throw new LetterError(422, 'letter_unconfirmed', 'Сначала подтвердите эту редакцию текста.');
}

function orderGrounds(grounds: Ground[], selection: Selection[]) {
  const byId = new Map(grounds.map((item) => [item.questionId, item]));
  return selection.flatMap(({ questionId, questionVersion, decisionId }) => {
    const item = byId.get(questionId);
    return item?.questionVersion === questionVersion && item.decisionId === decisionId ? [item] : [];
  });
}

function sendCommand(reply: FastifyReply, result: { status: number; body: unknown; replayed: boolean }) {
  if (result.replayed) reply.header('Idempotency-Replayed', 'true');
  return reply.code(result.status).send(result.body);
}

function sendExport(
  reply: FastifyReply, letter: Letter, entry: Awaited<ReturnType<typeof readExport>>, historical: boolean,
) {
  if (historical) reply.header('X-Letter-Historical', 'true');
  return reply
    .header('X-Content-Type-Options', 'nosniff')
    .header('Content-Disposition', `attachment; filename="letter-${letter.number}-v${entry.version}.${entry.format}"`)
    .type(contentTypes[entry.format]).send(entry.content);
}

export function registerLetterRoutes(app: FastifyInstance, deps: LetterDependencies, prefix: string) {
  app.setErrorHandler((error, request, reply) => {
    if (error instanceof AccessError) return sendAccessError(error, request, reply);
    throw error;
  });
  app.addHook('onRequest', async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    if (request.method !== 'POST' && request.method !== 'PATCH') return;
    const cookie = readCookie(request);
    if (!cookie) throw new AccessError(401, 'session_required', 'Войдите в приложение.');
    checkOrigin(request, accessConfig());
    checkCsrf(request, cookie);
  });

  function read<T>(
    request: FastifyRequest, requirement: ProjectRequirement,
    work: (tx: PoolClient, actor: AccessActor) => Promise<T>,
    guardScopes = false,
  ): Promise<T> {
    return transaction(app.db, async (tx) => {
      const initial = await readSession(tx, request);
      await lockOrganization(tx, initial.organizationId, false);
      await lockSession(tx, initial.sessionId, false);
      if (guardScopes && requirement.scopeId) {
        await authorize(tx, initial, requirement);
        await deps.lockScopes(tx, requirement.projectId, [requirement.scopeId]);
      }
      const session = await readSession(tx, request);
      const actor = await authorize(tx, session, requirement);
      const result = await work(tx, actor);
      await touchSession(tx, session);
      return result;
    });
  }

  async function lockTarget(tx: PoolClient, projectId: string, target: LetterTarget) {
    if (target.scopeId) await deps.lockScopes(tx, projectId, [target.scopeId]);
    else await lockIntakeProject(tx, projectId);
  }

  async function targetHolds(tx: PoolClient, projectId: string, target: LetterTarget) {
    return target.assessmentContextId ? (await getLockedFacadeContext(tx, projectId, target.assessmentContextId)).gate.holds :
      deps.getHolds(tx, projectId, target.scopeId!);
  }

  async function checkHolds(tx: PoolClient, letter: LetterResources) {
    const holds = await targetHolds(tx, letter.projectId, letter);
    if (holds.length) scopeError(holds);
  }

  async function selectedGrounds(tx: PoolClient, args: LetterResources & { selections: Selection[] }) {
    if (!args.selections.length) return [];
    const grounds = await deps.getGrounds(tx, args);
    return orderGrounds(grounds.filter((ground) => ground.scopeId === (args.assessmentContextId ?? args.scopeId)), args.selections);
  }

  async function assertCurrent(tx: PoolClient, letter: Letter, revision: Revision) {
    await checkHolds(tx, letter);
    if (revision.status === 'draft') unconfirmed();
    const selections = revision.items.map(({ questionId, questionVersion, decisionId }) => ({ questionId, questionVersion, decisionId }));
    const { recipient, layout, items, text, textSha256 } = revision;
    const grounds = await selectedGrounds(tx, { ...letter, recipient, selections });
    // Earlier revisions were saved without a stage line. Check their original text as stored.
    const matchesText = renderText(recipient, layout, items) === text
      || renderText(recipient, layout, items, false) === text;
    if (grounds.length !== revision.items.length
      || grounds.some((ground, index) => {
        const item = revision.items[index];
        return ground.wording !== item.wording || !wordingIsCurrent(item, ground);
      })
      || !matchesText
      || hashText(text) !== textSha256) {
      stale(letter);
    }
  }

  const letterPath = `${prefix}/letters/:letterId`;
  const projectsPath = `${prefix}/projects/:projectId/letters`;
  const pathTo = (letter: Letter) => `/api/letters/${letter.id}`;
  const readRequirement = ({ projectId, scopeId }: Letter): ProjectRequirement => ({
    action: 'project:read', projectId, scopeId: scopeId ?? undefined,
  });
  const editRequirement = ({ projectId, scopeId }: Letter): ProjectRequirement => ({
    action: 'project:engineer', projectId, scopeId: scopeId ?? undefined,
  });

  async function requestLetter(request: FastifyRequest) {
    // Authenticate before resolving the object. Unknown and inaccessible IDs share 404.
    await readSession(app.db, request);
    return getLetter(app.db, identifier((request.params as Record<string, unknown>).letterId, 'letterId'));
  }

  function checkVersion(letter: Letter, revision: Revision, expected: number) {
    if (revision.version !== expected) {
      throw new LetterError(412, 'version_conflict', 'Откройте актуальную редакцию.', {
        currentVersion: revision.version, href: pathTo(letter),
      });
    }
  }

  function versionOf(letter: Letter) {
    return async (tx: PoolClient) => {
      await lockTarget(tx, letter.projectId, letter);
      const head = await getRevision(tx, letter.id);
      return { current: head.version, href: pathTo(letter), details: { revisionId: head.id, status: head.status } };
    };
  }

  app.get(`${projectsPath}/eligible`, async (request) => {
    const projectId = identifier((request.params as { projectId: string }).projectId, 'projectId');
    const query = request.query as Record<string, unknown>;
    const target = assessmentTarget(query);
    if (query.recipient !== undefined && (typeof query.recipient !== 'string' || query.recipient.length > 300)) {
      throw new LetterError(422, 'invalid_letter_input', 'Недопустимый адресат.');
    }
    const recipient = typeof query.recipient === 'string' ? query.recipient.trim() : undefined;
    return read(request, { action: 'project:read', projectId, scopeId: target.scopeId }, async (tx) => {
      const holds = await targetHolds(tx, projectId, target);
      const items = holds.length ? [] : await deps.getGrounds(tx, { projectId, ...target, recipient });
      return { items, holds };
    }, true);
  });

  app.get(projectsPath, async (request) => {
    const projectId = identifier((request.params as { projectId: string }).projectId, 'projectId');
    const { scopeId, assessmentContextId, ...query } = request.query as Record<string, unknown>;
    const target: LetterTarget = scopeId === undefined && assessmentContextId === undefined ? {} :
      assessmentTarget({ scopeId, assessmentContextId });
    const { cursor, limit } = parsePage(query);
    return read(request, { action: 'project:read', projectId, scopeId: target.scopeId ?? undefined }, (tx, actor) =>
      listLetters(tx, projectId, target, cursor, limit, isEngineer(actor)));
  });

  app.post(projectsPath, async (request, reply) => {
    const projectId = identifier((request.params as { projectId: string }).projectId, 'projectId');
    const input = parseCreate(request.body);
    const result = await executeCommand(app.db, request, {
      operation: 'letter.create', requirement: { action: 'project:engineer', projectId, scopeId: input.scopeId }, input,
    }, async (tx, actor) => {
      if (!input.items.length) noEligible();
      await lockTarget(tx, projectId, input);
      await checkHolds(tx, { projectId, ...input });
      const grounds = await selectedGrounds(tx, { ...input, projectId, selections: input.items });
      if (!grounds.length) noEligible();
      if (grounds.length !== input.items.length) {
        throw new LetterError(422, 'ineligible_letter_selection', 'Часть выбранных пунктов не допущена к письму.');
      }
      const letter = await addLetter(tx, projectId, input, actor.userId);
      const revision = await putRevision(tx, letter.id, 1, actor.userId, {
        status: 'confirmed', recipient: input.recipient, layout: 'formal',
        items: grounds.map((ground) => ({ ...ground, id: randomUUID(), editedWording: null })),
      });
      return { status: 201, body: summary(letter, revision), audit: { objectId: letter.id, version: 1 } };
    });
    return sendCommand(reply, result);
  });

  app.get(letterPath, async (request, reply) => {
    const letter = await requestLetter(request);
    return read(request, readRequirement(letter), async (tx, actor) => {
      const engineer = isEngineer(actor);
      const head = await getRevision(tx, letter.id, undefined, engineer);
      reply.header('ETag', `"${head.version}"`);
      return { ...summary(letter, head), ...await readHistory(tx, letter.id, engineer) };
    }, true);
  });

  app.get(`${letterPath}/revisions/:revisionId`, async (request) => {
    const letter = await requestLetter(request);
    const revisionId = identifier((request.params as { revisionId: string }).revisionId, 'revisionId');
    return read(request, readRequirement(letter), async (tx, actor) => {
      const revision = await getRevision(tx, letter.id, revisionId, isEngineer(actor));
      const items = revision.items.map((item) => ({
        ...item, ...(item.editedWording !== null && { wordingSha256: hashText(item.editedWording) }),
      }));
      return { historical: true, ...revision, items };
    });
  });

  app.patch(letterPath, async (request, reply) => {
    const letter = await requestLetter(request);
    const input = parsePatch(request.body);
    const result = await executeCommand(app.db, request, {
      operation: 'letter.patch', requirement: editRequirement(letter), input: { letterId: letter.id, ...input },
      version: versionOf(letter),
    }, async (tx, actor) => {
      const head = await getRevision(tx, letter.id);
      const changes = new Map(input.items.map((item) => [item.questionId, item.wording]));
      if (input.items.some(({ questionId }) => !head.items.some((item) => item.questionId === questionId))) {
        throw new LetterError(422, 'unknown_letter_item', 'В редакции нет этого пункта.');
      }
      const items = head.items.map((item) => {
        const wording = changes.get(item.questionId);
        if (wording === undefined || wording === item.editedWording) return item;
        return { ...item, editedWording: wording, wordingApproval: undefined };
      });
      const recipient = input.recipient ?? head.recipient;
      const requestChanged = recipient !== head.recipient
        || items.some((item, index) => item.editedWording !== head.items[index].editedWording);
      const revision = await putRevision(tx, letter.id, head.version + 1, actor.userId, {
        items, recipient, layout: input.layout ?? head.layout, status: requestChanged ? 'draft' : head.status,
      });
      return { body: summary(letter, revision), audit: { objectId: letter.id, version: revision.version } };
    });
    return sendCommand(reply, result);
  });

  app.post(`${letterPath}/confirm`, async (request, reply) => {
    const letter = await requestLetter(request);
    const input = parseConfirm(request.body);
    const result = await executeCommand(app.db, request, {
      operation: 'letter.confirm', requirement: editRequirement(letter), input: { letterId: letter.id, ...input },
      version: versionOf(letter),
    }, async (tx, actor) => {
      await checkHolds(tx, letter);
      const head = await getRevision(tx, letter.id);
      const chosen = new Set(input.items.map((item) => item.questionId));
      if (chosen.size !== head.items.length || head.items.some((item) => !chosen.has(item.questionId))) {
        throw new LetterError(422, 'ineligible_letter_selection', 'Для подтверждения укажите основания всех пунктов редакции.');
      }
      const grounds = await selectedGrounds(tx, { ...letter, recipient: head.recipient, selections: input.items });
      if (grounds.length !== head.items.length) stale(letter);
      const byQuestion = new Map(grounds.map((ground) => [ground.questionId, ground]));
      const reviews = new Map(input.items.map(({ questionId, review }) => [questionId, review]));
      const items: LetterItem[] = head.items.map((item) => {
        const ground = byQuestion.get(item.questionId)!;
        const wordingApproval = approveWording(item, ground, reviews.get(item.questionId), actor.userId);
        return { ...ground, id: item.id, editedWording: item.editedWording, wordingApproval };
      });
      const revision = await putRevision(tx, letter.id, head.version + 1, actor.userId, {
        recipient: head.recipient, layout: head.layout, status: 'confirmed', items,
      });
      return { body: summary(letter, revision), audit: { objectId: letter.id, version: revision.version } };
    });
    return sendCommand(reply, result);
  });

  app.get(`${letterPath}/current-text`, async (request, reply) => {
    const letter = await requestLetter(request);
    return read(request, readRequirement(letter), async (tx) => {
      const head = await getRevision(tx, letter.id);
      checkVersion(letter, head, expectedVersion(request.headers['if-match']));
      await assertCurrent(tx, letter, head);
      reply.header('ETag', `"${head.version}"`);
      return { revisionId: head.id, version: head.version, text: head.text, textSha256: head.textSha256 };
    }, true);
  });

  app.post(`${letterPath}/exports`, async (request, reply) => {
    const letter = await requestLetter(request);
    const input = parseExport(request.body);
    const result = await executeCommand(app.db, request, {
      operation: 'letter.export', requirement: editRequirement(letter), input: { letterId: letter.id, ...input },
      version: versionOf(letter),
    }, async (tx, actor) => {
      const head = await getRevision(tx, letter.id);
      await assertCurrent(tx, letter, head);
      const previous = await getExportMetadata(tx, letter.id, head.id, input.format);
      const entry = previous ?? await putExport(tx, letter.id, head.id, input.format, await renderDocument(input.format, head.text), actor.userId);
      return {
        status: previous ? 200 : 201, body: exportReceipt(letter.id, { ...entry, version: head.version }),
        audit: { objectId: entry.id, version: head.version },
      };
    });
    return sendCommand(reply, result);
  });

  app.get(`${letterPath}/exports/:exportId`, async (request, reply) => {
    const letter = await requestLetter(request);
    const exportId = identifier((request.params as { exportId: string }).exportId, 'exportId');
    const entry = await read(request, readRequirement(letter), async (tx) => {
      const stored = await readExport(tx, letter.id, exportId);
      const head = await getRevision(tx, letter.id);
      checkVersion(letter, head, stored.version);
      await assertCurrent(tx, letter, head);
      return stored;
    }, true);
    return sendExport(reply, letter, entry, false);
  });

  app.get(`${letterPath}/revisions/:revisionId/exports/:exportId`, async (request, reply) => {
    const letter = await requestLetter(request);
    const ids = request.params as { revisionId: string; exportId: string };
    const revisionId = identifier(ids.revisionId, 'revisionId');
    const exportId = identifier(ids.exportId, 'exportId');
    const entry = await read(request, readRequirement(letter), async (tx) => {
      const stored = await readExport(tx, letter.id, exportId);
      if (stored.revisionId !== revisionId) throw unavailable();
      return stored;
    });
    return sendExport(reply, letter, entry, true);
  });

  app.post(`${letterPath}/sent`, async (request, reply) => {
    const letter = await requestLetter(request);
    const input = parseSent(request.body);
    const result = await executeCommand(app.db, request, {
      operation: 'letter.sent', requirement: editRequirement(letter), input: { letterId: letter.id, ...input },
    }, async (tx, actor) => {
      await lockTarget(tx, letter.projectId, letter);
      const revision = await getRevision(tx, letter.id, input.revisionId);
      if (revision.status !== 'confirmed') unconfirmed();
      const byId = new Map(revision.items.map((item) => [item.id, item]));
      const items = input.itemIds.map((id) => {
        const item = byId.get(id);
        if (!item) throw new LetterError(422, 'unknown_letter_item', 'Пункт не входит в отправленную редакцию.');
        return item;
      });
      const sent = await putSent(tx, letter.id, input, items, actor.userId);
      return {
        status: 201, body: { id: sent.id, revisionId: revision.id, url: `${pathTo(letter)}/sent/${sent.id}` },
        audit: { objectId: sent.id, version: revision.version },
      };
    });
    return sendCommand(reply, result);
  });

  app.get(`${letterPath}/sent/:sentId`, async (request) => {
    const letter = await requestLetter(request);
    const sentId = identifier((request.params as { sentId: string }).sentId, 'sentId');
    return read(request, readRequirement(letter), async (tx) => ({ historical: true, ...await getSent(tx, letter.id, sentId) }));
  });

  app.post(`${letterPath}/responses`, async (request, reply) => {
    const letter = await requestLetter(request);
    const input = parseResponse(request.body);
    const result = await executeCommand(app.db, request, {
      operation: 'letter.response', requirement: editRequirement(letter), input: { letterId: letter.id, ...input },
    }, async (tx, actor) => {
      await lockTarget(tx, letter.projectId, letter);
      const sent = await getSent(tx, letter.id, input.sentId);
      if (!sent.items.some((item) => item.id === input.itemId)) {
        throw new LetterError(422, 'unknown_letter_item', 'Ответ относится к пункту отправленного снимка.');
      }
      const response = await putResponse(tx, letter.id, input, actor.userId);
      return {
        status: 201, body: { ...response, sentId: sent.id, url: `${pathTo(letter)}/responses/${response.id}` },
        audit: { objectId: response.id },
      };
    });
    return sendCommand(reply, result);
  });

  app.get(`${letterPath}/responses/:responseId`, async (request) => {
    const letter = await requestLetter(request);
    const responseId = identifier((request.params as { responseId: string }).responseId, 'responseId');
    return read(request, readRequirement(letter), (tx) => readResponse(tx, letter.id, responseId));
  });
}
