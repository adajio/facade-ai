import { expect, type BrowserContext } from '@playwright/test';
import { createHash, randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { PoolClient } from 'pg';
import type { Assessment } from '../src/lib/workspace';
import { accepted, command, unique } from './synthetic';

const recipient = 'Синтетический адресат';
type FileInput = { name: string; mimeType: string; buffer: Buffer };
export type Publication = {
  projectId: string; documentId: string; versionId: string; jobId: string;
  receiptId: string; holdId: string; sha256: string;
};
type Hold = { id: string; generation: number; version: number };
type PrimaryReviewChange = {
  questionId: string;
  expectedDependencyVersion: number | undefined;
  review: { inputGeneration: string; findings: []; remaining: string[]; completenessChecked: false };
};

export async function addressedFixture(build: string, context: BrowserContext, origin: string, parts: string[]) {
  const compiled = (name: string) => import(pathToFileURL(resolve(build, 'src', name + '.js')).href);
  const [{ openPool }, { readConfig }, { transaction }, { createIntakeStorage }, uploads,
    { createRuntimePdfService }, supplements, questions, assessment] = await Promise.all([
    compiled('platform/db'), compiled('platform/config'), compiled('modules/access/commands'), compiled('modules/intake/blob'),
    compiled('modules/intake/uploads'), compiled('modules/pdf/index'), compiled('modules/supplements/index'),
    compiled('modules/questions/index'), compiled('modules/assessment/index'),
  ]);
  const catalog = await accepted<{ id: string }>(await command(context, origin, '/api/catalogs', 'POST', {
    key: unique('web-addressed'), name: 'Каталог адресной замены',
    requirements: parts.map((part, index) => ({
      key: 'part-' + index, part, applicability: 'all', formats: ['pdf'], equivalents: [], sourceRoles: ['design'],
      completenessCriterion: 'Адресуемая проверенная строка', addressee: recipient,
    })),
  }), 'Каталог');
  const project = await accepted<{ id: string; version: number; scopes: { id: string }[] }>(
    await command(context, origin, '/api/projects', 'POST', {
      name: unique('web-адресная-сверка'), catalogVersionId: catalog.id, scopeName: 'Фасад А',
    }), 'Проект',
  );
  const scopeId = project.scopes[0].id;
  const base = '/api/projects/' + project.id;
  const config = readConfig();
  const db = openPool(config.databaseUrl);
  const storage = createIntakeStorage(config.dataDir);
  const reader = createRuntimePdfService(db, config, { storage });
  const ports = questions.createRuntimeInquiryPorts(db, reader, storage.objects);
  const getAssessment = (version: number | 'current' = 'current') =>
    context.request.get(base + '/assessments/' + version + '?scopeId=' + scopeId)
      .then((response) => accepted<Assessment>(response, 'Комплектность'));

  async function upload(file: FileInput): Promise<Publication> {
    const sha256 = createHash('sha256').update(file.buffer).digest('hex');
    const { receiptId } = await accepted<{ receiptId: string }>(
      await command(context, origin, base + '/receipts', 'POST', {}), 'Поступление',
    );
    const declared = await accepted<{ uploadId: string; holdId: string }>(
      await command(context, origin, '/api/receipts/' + receiptId + '/uploads', 'POST', {
        relativePath: file.name, mediaType: file.mimeType, size: file.buffer.length, sha256, scopeIds: [scopeId],
      }), 'Декларация',
    );
    const path = '/api/uploads/' + declared.uploadId;
    const { csrfToken } = await accepted<{ csrfToken: string }>(await context.request.get('/api/me'), 'Сеанс');
    await accepted(await context.request.put(path + '/parts/1', {
      data: file.buffer, headers: { Origin: origin, 'X-CSRF-Token': csrfToken, 'Content-Type': 'application/octet-stream', 'X-Part-SHA256': sha256 },
    }), 'Часть');
    const input = { projectId: project.id, uploadId: declared.uploadId };
    const prepared = await uploads.prepareOriginal(db, storage, input);
    const result = await transaction(db, async (tx: PoolClient): Promise<Pick<Publication, 'documentId' | 'versionId' | 'jobId'>> => {
      // The fixture owns primary publication for these jobs. Claim them in the
      // finalization transaction so the background dispatcher cannot see them pending.
      const publication = await uploads.publishPreparedOriginal(tx, input, prepared);
      await tx.query('UPDATE intake_reader_jobs SET dispatched_at=clock_timestamp() WHERE project_id=$1 AND id=$2',
        [project.id, publication.jobId]);
      return publication;
    });
    await accepted(await command(context, origin, '/api/receipts/' + receiptId + '/seal', 'POST', {}), 'Запечатать опись');
    return { ...result, projectId: project.id, receiptId, holdId: declared.holdId, sha256 };
  }

  async function observe(file: Publication, input: { subject: string; property: string; quote: string; value: string; questionId: string; branch?: 'A' | 'B' }) {
    const source = { projectId: project.id, documentId: file.documentId, versionId: file.versionId, sha256: file.sha256 };
    const map = await reader.map(source);
    const read = { runId: randomUUID(), branch: input.branch ?? 'A', operationKey: 'native' };
    const { evidence, bytes } = await reader.open(source, read, {
      representation: 'native', address: { unitId: map.units[0].id },
    });
    const { lines } = JSON.parse(bytes.toString('utf8'));
    const line = lines.find((candidate: { text: string }) => candidate.text.includes(input.quote));
    if (!line) throw new Error('Reader не открыл контрольную строку');
    return transaction(db, async (tx: unknown) => {
      await supplements.lockScopes(tx, project.id, [scopeId]);
      const observation = await reader.pin(source, { ...read, operationKey: 'pin' }, {
        scope: scopeId, evidenceId: evidence.id, quote: line.text, lineId: line.id, value: input.value, unit: 'mm',
      }, tx);
      await questions.publishReaderObservation(tx, {
        observation, projectId: project.id, scopeId, readerJobId: file.jobId,
        subject: input.subject, property: input.property, role: 'design', revision: 'effective',
        priority: 'peer', comparableContext: input.subject + '/' + input.property,
        assessmentQuestionId: input.questionId,
      });
      return observation as { id: string; evidenceId: string };
    });
  }

  async function resolveHold(file: Publication, changes: unknown[] = []) {
    const snapshot = await accepted<{ holds: Hold[] }>(
      await context.request.get(base + '/snapshot?scopeId=' + scopeId), 'Снимок',
    );
    const hold = snapshot.holds.find(({ id }) => id === file.holdId);
    if (!hold) throw new Error('Удержание фикстуры не найдено');
    await transaction(db, (tx: unknown) => supplements.resolveSupplementImpact(tx, {
      projectId: project.id, holdId: hold.id, generation: hold.generation, version: hold.version,
      reason: 'Проверены синтетические опоры', impacts: [{ scopeId, changes }],
    }));
  }

  return {
    project, base, scopeId, catalogVersionId: catalog.id, recipient, getAssessment, upload, observe, resolveHold,
    publishPrimaryReview(change: PrimaryReviewChange) {
      return transaction(db, (tx: PoolClient) => assessment.applyAssessmentUpdate(tx, {
        projectId: project.id, scopeId, eventId: randomUUID(), reason: 'primary_research_update', changes: [change],
      })) as Promise<{ assessmentVersion: number }>;
    },
    async drain() {
      const signal = AbortSignal.timeout(30_000);
      const pending = () => db.query(
        'SELECT 1 FROM inquiry_jobs j JOIN inquiries i ON i.id=j.inquiry_id WHERE i.project_id=$1 LIMIT 1',
        [project.id],
      );
      await expect.poll(async () => {
        if (!(await pending()).rowCount) return 0;
        await questions.processNextInquiry(db, ports, signal);
        return (await pending()).rowCount;
      }, { message: 'Очередь поиска синтетического проекта', timeout: 30_000 }).toBe(0);
    },
    async close() {
      storage.objects.close();
      await db.end();
    },
  };
}
