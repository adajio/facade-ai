<script lang="ts">
  import { tick } from 'svelte';
  import { Commands } from '../lib/commands';
  import { label } from '../lib/format';
  import { ApiError, denied, describe, id, interrupted, type Api } from '../lib/http';
  import type { Occurrence } from '../lib/intake';
  import { V1, scopedUrl, type OpenEvidence, type WorkspaceProps } from '../lib/workspace';
  import Notice from '../lib/Notice.svelte';
  import WorkJob, { type Job } from './DocumentJob.svelte';
  import { pageCache } from '../lib/page-cache';

  type Unit = { id: string; label?: string; locator?: Record<string, string | number> };
  type ReaderMap = { source: { documentId: string; versionId: string; sha256: string }; units: Unit[] };
  type Work = {
    jobs: Job[]; jobCount: number;
    branches: { branch: string; completed: number; total: number; outcome: string }[];
    mappingReason?: string; mapReady: boolean; mapped: boolean; catalogAssigned: boolean;
  };

  let { api, context, occurrence, renew }: {
    api: Api; context: WorkspaceProps;
    occurrence: Occurrence & { documentId: string; versionId: string };
    open: OpenEvidence; renew: () => void;
  } = $props();
  const commands = new Commands(() => api);
  let units = $state<Unit[]>([]);
  let work = $state<Work>();
  let readerError = $state('');
  let workError = $state('');
  let originalError = $state('');
  let ready = $state(false);
  let heading: HTMLHeadingElement;
  let viewer = $state<HTMLHeadingElement>();
  let refreshWork = $state(0);
  let fullPdf = $state(false);
  let preview = $state<{ key: string; url?: string }>();

  const documentId = $derived(occurrence.documentId);
  const versionId = $derived(occurrence.versionId);
  const originalHash = $derived(occurrence.sha256);
  const snapshotRevision = $derived(context.refreshKey);
  const mapReady = $derived(work?.mapReady);
  const path = $derived('/api/documents/' + id(documentId) + '/versions/' + id(versionId));
  const original = $derived(path + '/content');
  const isPdf = $derived(occurrence.mediaType === 'application/pdf');
  const pages = $derived(units.flatMap(({ locator }) => typeof locator?.page === 'number' ? [locator.page] : []));
  const selectedPage = $derived.by(() => {
    const raw = context.params.get('page');
    return raw && /^[1-9]\d{0,6}$/u.test(raw) ? Number(raw) : undefined;
  });
  const page = $derived(selectedPage !== undefined && (!pages.length || pages.includes(selectedPage))
    ? selectedPage : pages[0] ?? 1);
  const pdfUrl = $derived(original + '#page=' + page);
  const previewKey = $derived(ready && isPdf && !fullPdf && !context.masked && originalHash &&
    selectedPage !== undefined && pages.includes(page) ? [context.project.id, versionId, originalHash, page].join('/') : undefined);

  $effect(() => {
    const key = previewKey;
    if (!key) return;
    const stop = new AbortController();
    const generation = pageCache.generation;
    const expected = '"sha256-' + originalHash + '"';
    const url = V1 + path.slice(4) + '/reader/pages/' + page;
    const cached = pageCache.get(key);
    if (cached) {
      preview = { key, url: cached };
      return () => { preview = undefined; };
    }
    const { signal } = stop;
    const fetchPage = async () => {
      const response = await api.response(url, { signal }).catch(async (error) => {
        if (!(error instanceof ApiError) || error.code !== 'reader_resource_wait') throw error;
        await new Promise<void>((resolve) => setTimeout(resolve, 350));
        signal.throwIfAborted();
        return api.response(url, { signal });
      });
      if (response.headers.get('ETag') !== expected || response.headers.get('Content-Type')?.split(';')[0] !== 'image/png') {
        throw new Error('Неверная версия страницы');
      }
      const body = await response.blob();
      signal.throwIfAborted();
      if (generation === pageCache.generation) preview = { key, url: pageCache.add(key, body, generation) };
    };
    void fetchPage().catch(() => {
      if (!signal.aborted) preview = { key };
    });
    return () => { stop.abort(); preview = undefined; };
  });

  $effect(() => {
    void versionId;
    fullPdf = false;
    void tick().then(() => heading?.focus());
  });

  $effect(() => {
    const url = original;
    const expectedHash = originalHash;
    const expectedPdf = isPdf;
    const controller = new AbortController();
    const { signal } = controller;
    ready = false;
    originalError = '';
    void api.response(url, { method: 'HEAD', signal }).then((response) => {
      if (expectedHash && response.headers.get('ETag') !== '"sha256-' + expectedHash + '"') {
        originalError = 'Полученная версия не совпадает с SHA-256 в описи.';
      } else if (expectedPdf && response.headers.get('Content-Type')?.split(';')[0] !== 'application/pdf') {
        originalError = 'Сервер не подтвердил формат PDF принятого оригинала.';
      } else {
        ready = true;
      }
    }).catch((error) => { if (!signal.aborted) originalError = describe(error); });
    return () => controller.abort();
  });

  $effect(() => {
    const url = V1 + path.slice(4) + '/reader/units';
    const expected = { documentId, versionId, sha256: originalHash };
    void snapshotRevision;
    void mapReady;
    const controller = new AbortController();
    readerError = '';
    void api.json<ReaderMap>(url, { signal: controller.signal }).then((value) => {
      if (value.source.documentId !== expected.documentId || value.source.versionId !== expected.versionId ||
          expected.sha256 && value.source.sha256 !== expected.sha256) {
        units = [];
        readerError = 'Карта относится к другой версии оригинала.';
        return;
      }
      units = value.units;
    }).catch((error) => {
      if (controller.signal.aborted || interrupted(error)) return;
      units = [];
      readerError = error instanceof ApiError && error.code === 'reader_map_unavailable'
        ? 'Карта физических единиц ещё недоступна.' : describe(error);
    });
    return () => controller.abort();
  });

  $effect(() => {
    const url = path + '/work';
    void snapshotRevision;
    void refreshWork;
    const controller = new AbortController();
    const { signal } = controller;
    let timer: ReturnType<typeof setTimeout>;

    async function load() {
      try {
        work = await api.json<Work>(url, { signal: AbortSignal.any([signal, AbortSignal.timeout(8000)]) });
        workError = '';
      } catch (error) {
        if (signal.aborted) return;
        work = undefined;
        workError = describe(error);
        if (denied(error)) {
          ready = false;
          return;
        }
      } finally {
        if (!signal.aborted) timer = setTimeout(load, 5000);
      }
    }
    void load();
    return () => { controller.abort(); clearTimeout(timer); };
  });

  function setPage(next: number, focus = false) {
    if (!ready || !Number.isSafeInteger(next) || next < 1 || (pages.length && !pages.includes(next))) return;
    context.setDocumentPage(next);
    if (focus) void tick().then(() => viewer?.focus());
  }

  function closeOriginal() {
    context.setDocumentPage();
    void tick().then(() => document.getElementById('document-open-original')?.focus());
  }

  async function change(job: Job, action: 'priority' | 'resume', priority?: number) {
    try {
      if (action === 'priority' && job.actions.priority.version !== undefined) {
        await commands.send(path + '/work/' + id(job.id) + '/priority', 'PATCH', { priority }, job.actions.priority.version);
      } else if (action === 'resume' && job.actions.resume.href && job.actions.resume.version !== undefined) {
        await commands.send(job.actions.resume.href, 'POST', {}, job.actions.resume.version);
      }
    } finally {
      refreshWork += 1;
      renew();
    }
  }
</script>

<section class="card" aria-labelledby="document-heading">
  <div class="card-header">
    <h2 id="document-heading" bind:this={heading} tabindex="-1">{occurrence.relativePath}</h2>
    {#if ready}
      <div class="actions">
        {#if isPdf}
          <button id="document-open-original" class="primary" type="button"
            onclick={() => setPage(pages.includes(page) || !pages.length ? page : pages[0], true)}>Открыть оригинал</button>
          {#if context.canEdit && context.scopeId}
            <a class="button" href={scopedUrl(context.project.id, 'fragments', {
              scope: context.scopeId, document: documentId, version: versionId, page,
            })}>Подготовить фрагмент</a>
          {/if}
        {/if}
        <a class="button" href={original} download={occurrence.relativePath.split('/').at(-1)}>Скачать оригинал</a>
      </div>
    {/if}
  </div>
  <Notice kind="error" message={originalError} />
  {#if !ready && !originalError && !workError}<p role="status">Проверяем доступ к оригиналу…</p>{/if}
  {#if selectedPage !== undefined && ready && isPdf && !context.masked}
    <section class="original" aria-labelledby="document-viewer">
      <div class="card-header">
        <h3 id="document-viewer" tabindex="-1" bind:this={viewer}>Оригинал PDF</h3>
        <button type="button" onclick={closeOriginal}>Закрыть просмотр</button>
      </div>
      <div class="actions">
        <button type="button" disabled={page === 1} onclick={() => setPage(page - 1)}>Предыдущая страница</button>
        <span aria-live="polite">Страница {page}{pages.length ? ' из ' + pages.length : ''}</span>
        <button type="button" disabled={!pages.length || page >= pages.at(-1)!} onclick={() => setPage(page + 1)}>Следующая страница</button>
        <a href={pdfUrl} target="_blank" rel="noopener">Открыть PDF в новой вкладке</a>
        {#if previewKey || fullPdf}
          <button type="button" class="quiet" onclick={() => fullPdf = !fullPdf}>
            {fullPdf ? 'Быстрый просмотр страницы' : 'Полный просмотр PDF'}
          </button>
        {/if}
      </div>
      {#if previewKey && preview?.key !== previewKey}
        <p role="status">Готовим страницу {page}…</p>
      {:else if previewKey && preview?.url}
        <img class="page-preview" alt={'Оригинал PDF, страница ' + page} src={preview.url} />
      {:else}
        {#key pdfUrl}
          <iframe title={'Оригинал PDF, страница ' + page} src={pdfUrl}></iframe>
        {/key}
      {/if}
    </section>
  {/if}
  <dl class="details">
    <dt>Версия оригинала</dt><dd class="numeric">{occurrence.versionId}</dd>
    <dt>SHA-256</dt><dd class="numeric">{occurrence.sha256 ?? '—'}</dd>
    <dt>Фактический тип</dt><dd>{occurrence.mediaType ?? '—'}</dd>
    {#if occurrence.restriction}<dt>Ограничение</dt><dd>{label(occurrence.restriction)}</dd>{/if}
  </dl>
  <h3>Физические единицы</h3>
  <Notice message={readerError} />
  {#if units.length}
    <ul class="plain-list unit-list">
      {#each units as unit (unit.id)}
        {@const number = unit.locator?.page}
        <li>
          {#if isPdf && typeof number === 'number' && ready}
            <button type="button" onclick={() => setPage(number, true)}>{unit.label ?? 'Страница ' + number}</button>
          {:else}
            {unit.label ?? unit.id}
            {#if unit.locator?.coverage} · {label(unit.locator.coverage)}{/if}
            {#if unit.locator?.limitations} · {String(unit.locator.limitations).split(',').map((value) => label(value)).join(' · ')}{/if}
          {/if}
        </li>
      {/each}
    </ul>
  {/if}

  <h3>Состояние чтения</h3>
  <Notice message={workError} />
  {#if work}
    {#if work.mappingReason}
      <p>Подготовка карты приостановлена · {label(work.mappingReason)}</p>
    {:else if !work.mapped}
      <p>Подготовка карты оригинала ожидает обработки.</p>
    {:else if !work.mapReady}
      <p>Оригинал принят. Представление для чтения недоступно.</p>
    {:else if !work.jobCount}
      <p>Карта готова. Задания чтения пока отсутствуют.</p>
    {/if}
    {#if work.branches.some(({ outcome }) => outcome === 'held')}<p>Чтение остановлено. Причины указаны в заданиях.</p>{/if}
    {#if !work.catalogAssigned}<p>Нет рабочего каталога. Оценка комплектности ожидает назначения.</p>{/if}
    {#if work.branches.length}
      <ul class="plain-list">
        {#each work.branches as branch (branch.branch)}
          <li>Ветвь {branch.branch} · завершено заданий {branch.completed} из {branch.total} · {label(branch.outcome)}</li>
        {/each}
      </ul>
    {/if}
    {#if work.jobCount > work.jobs.length}
      <p class="meta">Показано {work.jobs.length} из {work.jobCount} заданий. Сначала остановленные и активные.</p>
    {/if}
    {#each work.jobs as job (job.id)}
      <WorkJob {job} {change} />
    {/each}
  {:else if !workError}
    <p role="status">Проверяем очередь чтения…</p>
  {/if}
</section>

<style>
  .original { margin-block: 1rem; }
  iframe { width: 100%; height: max(24rem, 64dvh); border: 1px solid var(--line); margin-top: .6rem; }
  .page-preview { display: block; width: auto; max-width: 100%; max-height: max(24rem, 64dvh);
    object-fit: contain; border: 1px solid var(--line); margin: .6rem auto 0; }
  .unit-list { display: flex; flex-wrap: wrap; align-items: center; gap: .4rem .7rem; }
</style>
