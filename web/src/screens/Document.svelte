<script lang="ts">
  import { tick } from 'svelte';
  import { Commands } from '../lib/commands';
  import { label } from '../lib/format';
  import { ApiError, denied, describe, id, interrupted, type Api } from '../lib/http';
  import type { Occurrence } from '../lib/intake';
  import { V1, scopedUrl, type OpenEvidence, type WorkspaceProps } from '../lib/workspace';
  import Notice from '../lib/Notice.svelte';
  import DocumentStage from '../lib/DocumentStage.svelte';
  import DocumentFacadeLink from '../lib/DocumentFacadeLink.svelte';
  import CadDocument from './CadDocument.svelte';
  import type { ReaderMap } from '../lib/cad';
  import WorkJob, { type Job } from './DocumentJob.svelte';
  import { pageCache } from '../lib/page-cache';

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
  let units = $state<ReaderMap['units']>([]);
  let cadMap = $state<{ versionId: string; readerVersion: string }>();
  let previewMap = $state<{ versionId: string; readerVersion: string; format: 'image' | 'sig' }>();
  let work = $state<Work>();
  let readerError = $state('');
  let workError = $state('');
  let originalError = $state('');
  let derivativeState = $state<{ url: string; available: boolean; error?: string }>();
  let ready = $state(false);
  let heading: HTMLHeadingElement;
  let viewer = $state<HTMLHeadingElement>();
  let refreshWork = $state(0);
  let fullPdf = $state(false);
  let previewAttempt = $state(0);
  let preview = $state<{ key: string; url?: string }>();

  const documentId = $derived(occurrence.documentId);
  const versionId = $derived(occurrence.versionId);
  const cadVersion = $derived(cadMap?.versionId === versionId ? cadMap?.readerVersion : undefined);
  const originalHash = $derived(occurrence.sha256);
  const snapshotRevision = $derived(context.refreshKey);
  const mapReady = $derived(work?.mapReady);
  const path = $derived('/api/documents/' + id(documentId) + '/versions/' + id(versionId));
  const original = $derived(path + '/content');
  const derivativeUrl = $derived(!context.masked && cadVersion
    ? V1 + path.slice(4) + '/dwg-derivative?readerVersion=' + encodeURIComponent(cadVersion) : undefined);
  const derivative = $derived(derivativeState?.url === derivativeUrl ? derivativeState : undefined);
  const isPdf = $derived(occurrence.mediaType === 'application/pdf');
  const alternatePreview = $derived(previewMap?.versionId === versionId ? previewMap : undefined);
  const paged = $derived(isPdf || Boolean(alternatePreview));
  const viewerTitle = $derived(isPdf ? 'Оригинал PDF' : alternatePreview?.format === 'sig' ? 'PDF внутри контейнера подписи' : 'Оригинал изображения');
  const pages = $derived(units.flatMap(({ locator }) => typeof locator?.page === 'number' ? [locator.page] : []));
  const selectedPage = $derived.by(() => {
    const raw = context.params.get('page');
    return raw && /^[1-9]\d{0,6}$/u.test(raw) ? Number(raw) : undefined;
  });
  const page = $derived(selectedPage !== undefined && (!pages.length || pages.includes(selectedPage))
    ? selectedPage : pages[0] ?? 1);
  const pdfUrl = $derived(original + '#page=' + page);
  const previewKey = $derived(ready && paged && !fullPdf && !context.masked && originalHash &&
    selectedPage !== undefined && pages.includes(page) ? [context.project.id, versionId, originalHash, alternatePreview?.readerVersion, page].join('/') : undefined);

  $effect(() => {
    const key = previewKey;
    void previewAttempt;
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
    const signal = AbortSignal.any([stop.signal, AbortSignal.timeout(8000)]);
    const fetchPage = async () => {
      async function requestPreview() {
        for (let retry = 0; ; retry++) {
          try { return await api.response(url, { signal }); }
          catch (error) {
            if (retry >= 4 || !(error instanceof ApiError) || error.code !== 'reader_resource_wait') throw error;
            await new Promise<void>((resolve) => setTimeout(resolve, 300 * (retry + 1)));
            signal.throwIfAborted();
          }
        }
      }
      const response = await requestPreview();
      if (response.headers.get('ETag') !== expected || response.headers.get('Content-Type')?.split(';')[0] !== 'image/png') {
        throw new Error('Неверная версия страницы');
      }
      const body = await response.blob();
      signal.throwIfAborted();
      if (generation === pageCache.generation) preview = { key, url: pageCache.add(key, body, generation) };
    };
    void fetchPage().catch(() => {
      if (!stop.signal.aborted) preview = { key };
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
        cadMap = undefined;
        previewMap = undefined;
        readerError = 'Карта относится к другой версии оригинала.';
        return;
      }
      units = value.units;
      cadMap = value.format === 'dwg' ? { versionId: expected.versionId, readerVersion: value.readerVersion } : undefined;
      const renderable = value.format === 'image' && value.units.some(({ locator }) => locator?.rasterFormat) ||
        value.format === 'sig' && value.units.some(({ locator }) => locator?.signatureKind === 'embedded_pdf');
      previewMap = renderable && (value.format === 'image' || value.format === 'sig')
        ? { versionId: expected.versionId, readerVersion: value.readerVersion, format: value.format } : undefined;
    }).catch((error) => {
      if (controller.signal.aborted || interrupted(error)) return;
      units = [];
      cadMap = undefined;
      previewMap = undefined;
      readerError = error instanceof ApiError && error.code === 'reader_map_unavailable'
        ? 'Карта физических единиц ещё недоступна.' : describe(error);
    });
    return () => controller.abort();
  });

  $effect(() => {
    const url = derivativeUrl;
    derivativeState = undefined;
    if (!url) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const checkDerivative = async () => {
      try {
        await api.response(url, { method: 'HEAD', signal: controller.signal });
        if (!controller.signal.aborted) derivativeState = { url, available: true };
      } catch (error) {
        if (controller.signal.aborted || interrupted(error)) return;
        derivativeState = {
          url, available: false, error: error instanceof ApiError && error.status === 404 ? undefined : describe(error),
        };
        timer = setTimeout(checkDerivative, 30_000);
      }
    };
    void checkDerivative();
    return () => { controller.abort(); if (timer) clearTimeout(timer); };
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
        {#if paged}
          <button id="document-open-original" class="primary" type="button"
            onclick={() => setPage(pages.includes(page) || !pages.length ? page : pages[0], true)}>{alternatePreview?.format === 'sig' ? 'Открыть вложенный PDF' : 'Открыть оригинал'}</button>
          {#if isPdf && context.canEdit && context.scopeId}
            <a class="button" href={scopedUrl(context.project.id, 'fragments', {
              scope: context.scopeId, document: documentId, version: versionId, page,
            })}>Подготовить фрагмент</a>
          {/if}
        {/if}
        <a class="button" href={original} download={occurrence.relativePath.split('/').at(-1)}>Скачать оригинал</a>
        {#if derivative?.available}
          <a class="button" href={derivative.url}>Скачать машиночитаемую версию DWG</a>
        {/if}
      </div>
    {/if}
  </div>
  <Notice kind="error" message={originalError} />
  {#if derivative?.error}<Notice kind="error" message={'Машиночитаемая версия DWG · ' + derivative.error} />{/if}
  {#if !ready && !originalError && !workError}<p role="status">Проверяем доступ к оригиналу…</p>{/if}
  {#if selectedPage !== undefined && ready && paged && !context.masked}
    <section class="original" aria-labelledby="document-viewer">
      <div class="card-header">
        <h3 id="document-viewer" tabindex="-1" bind:this={viewer}>{viewerTitle}</h3>
        <button type="button" onclick={closeOriginal}>Закрыть просмотр</button>
      </div>
      <div class="actions">
        <button type="button" disabled={page === 1} onclick={() => setPage(page - 1)}>Предыдущая страница</button>
        <span aria-live="polite">Страница {page}{pages.length ? ' из ' + pages.length : ''}</span>
        <button type="button" disabled={!pages.length || page >= pages.at(-1)!} onclick={() => setPage(page + 1)}>Следующая страница</button>
        {#if isPdf}
          <a href={pdfUrl} target="_blank" rel="noopener">Открыть PDF в новой вкладке</a>
          {#if previewKey || fullPdf}
            <button type="button" class="quiet" onclick={() => fullPdf = !fullPdf}>
              {fullPdf ? 'Быстрый просмотр страницы' : 'Полный просмотр PDF'}
            </button>
          {/if}
        {/if}
      </div>
      {#if previewKey && preview?.key !== previewKey}
        <p role="status">Готовим страницу {page}…</p>
      {:else if previewKey && preview?.url}
        <img class="page-preview" alt={viewerTitle + ', страница ' + page} src={preview.url} />
      {:else if isPdf}
        {#if previewKey && preview?.key === previewKey && !preview.url}
          <p>Сейчас открыт полный PDF. <button type="button" class="quiet" onclick={() => { preview = undefined; previewAttempt++; }}>Повторить быстрый просмотр страницы</button></p>
        {/if}
        {#key pdfUrl}
          <iframe title={'Оригинал PDF, страница ' + page} src={pdfUrl}></iframe>
        {/key}
      {:else}
        <p>Предпросмотр страницы недоступен. <button type="button" class="quiet" onclick={() => { preview = undefined; previewAttempt++; }}>Повторить предпросмотр</button></p>
      {/if}
    </section>
  {/if}
  {#if occurrence.restriction}<p>Ограничение · {label(occurrence.restriction)}</p>{/if}
  <details><summary>Технические сведения об оригинале</summary>
  <dl class="details">
    <dt>Версия оригинала</dt><dd class="numeric">{occurrence.versionId}</dd>
    <dt>SHA-256</dt><dd class="numeric">{occurrence.sha256 ?? '—'}</dd>
    <dt>Фактический тип</dt><dd>{occurrence.mediaType ?? '—'}</dd>
  </dl>
  </details>
  <h3>{paged ? 'Страницы документа' : 'Листы и части документа'}</h3>
  <Notice message={readerError} />
  {#if cadVersion && ready && !context.masked && units.some(unit => unit.locator?.partSha256)}
    <CadDocument {api} {units} readerVersion={cadVersion} endpoint={V1 + path.slice(4) + '/reader/units'}
      partId={context.params.get('part')} entity={context.params.get('entity')} select={context.setDocumentCad} />
  {:else if units.length}
    <ul class="plain-list unit-list">
      {#each units as unit (unit.id)}
        {@const number = unit.locator?.page}
        <li>
          {#if paged && typeof number === 'number' && ready}
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

  {#if ready && !context.project.scopeId && units.length && (isPdf || occurrence.mediaType === 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')}
    {@const confirmationPath = '/api/projects/' + id(context.project.id) + '/versions/' + id(versionId)}
    {#key versionId}
      <DocumentStage {api} pdf={isPdf} {page} editable={context.canEdit} {renew} path={confirmationPath + '/stage'} />
      <DocumentFacadeLink {api} projectId={context.project.id} pdf={isPdf} {page} editable={context.canEdit} path={confirmationPath + '/facade-links'} />
    {/key}
  {:else if ready && !context.project.scopeId && context.canEdit && !isPdf && occurrence.mediaType !== 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'}
    <p class="meta">Адресное подтверждение стадии и принадлежности доступно для физических страниц PDF и ячеек XLSX.</p>
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
