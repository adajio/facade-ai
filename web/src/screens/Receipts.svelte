<script lang="ts">
  import { onDestroy } from 'svelte';
  import { Commands } from '../lib/commands';
  import { ApiError, describe, id, interrupted, query, type Api } from '../lib/http';
  import { date, bytes, count, label } from '../lib/format';
  import { receiptPath, relativePath, sendFile, type Capabilities, type Inventory, type Occurrence, type Receipt, type Upload, type UploadProgress } from '../lib/intake';
  import { projectApi, scopedUrl, type OpenEvidence, type Page, type Projection, type WorkspaceProps } from '../lib/workspace';
  import Notice from '../lib/Notice.svelte';
  import Document from './Document.svelte';
  import IntakeHolds from './IntakeHolds.svelte';

  type ReceiptList = { receipts: Receipt[]; nextCursor?: number | null };
  type Link = { id: string; receiptId: string; letterId: string; sentId: string; itemId?: string };
  type ImportEntry = { id: string; relativePath?: string; path?: string; status?: string; reason?: string; restriction?: string };

  let { api, context, projection, renew, open }: { api: Api; context: WorkspaceProps; projection?: Projection; renew: () => void; open: OpenEvidence } = $props();
  const commands = new Commands(() => api);
  let list = $state<Receipt[]>([]);
  let nextCursor = $state<number | null>(null);
  let inventory = $state<Inventory>();
  let technicalEntries = $state<ImportEntry[]>([]);
  let entriesCursor = $state<string | null>(null);
  let capabilities = $state<Capabilities>();
  let formats = $state<Capabilities>();
  let links = $state<Link[]>([]);
  let error = $state('');
  let detailError = $state('');
  let importError = $state('');
  let operationError = $state('');
  let success = $state('');
  let loading = $state(false);
  let paging = $state(false);
  let technicalPaging = $state(false);
  let form = $state(false);
  let channel = $state<'file' | 'folder' | 'link'>('file');
  let files = $state<File[]>([]);
  let linkUrl = $state('');
  let declareScope = $state(false);
  let replacements = $state('');
  let existing = $state('');
  let active = $state('');
  let activeDocument = $state('');
  let activeReceipt = $derived(active || context.objectId || '');
  $effect(() => { void context.objectId; active = ''; activeDocument = ''; });
  let selectedDocument = $derived(inventory?.occurrences.find((item) => item.occurrenceId === activeDocument));
  let pending = $state(false);
  let progress = $state<Parameters<UploadProgress>[0]>();
  let workingFile = $state('');
  let uploadSignal: AbortController | undefined;
  let batch = new Map<File, string>();
  let finished = new Set<File>();
  let mode = $derived(context.filter === 'uploading' || context.filter === 'open' ? 'uploading' : undefined);
  let linkedLetter = $derived(context.params.get('letter') ?? '');
  let linkedSent = $derived(context.params.get('sent') ?? '');
  let linkedItem = $derived(context.params.get('item') ?? '');

  $effect(() => {
    const path = projectApi(context.project.id);
    const stop = new AbortController();
    api.json<Capabilities>(path + '/intake/capabilities', { signal: stop.signal }).then((value) => capabilities = value)
      .catch((problem) => { if (!interrupted(problem)) error = describe(problem); });
    api.json<Capabilities>('/api/imports/capabilities', { signal: stop.signal }).then((value) => formats = value)
      .catch((problem) => { if (!interrupted(problem)) importError = describe(problem); });
    return () => stop.abort();
  });

  $effect(() => {
    const project = context.project.id;
    const state = mode;
    void context.refreshKey;
    const stop = new AbortController();
    loading = true;
    error = '';
    api.json<ReceiptList>(query(projectApi(project) + '/receipts', { state }), { signal: stop.signal }).then((page) => {
      list = page.receipts;
      nextCursor = page.nextCursor ?? null;
    }).catch((problem) => { if (!stop.signal.aborted) error = describe(problem); })
      .finally(() => { if (!stop.signal.aborted) loading = false; });
    return () => stop.abort();
  });

  $effect(() => {
    const receipt = activeReceipt;
    const project = context.project.id;
    void context.refreshKey;
    if (!receipt) return;
    const stop = new AbortController();
    detailError = '';
    api.json<Inventory>(receiptPath(receipt) + '/inventory', { signal: stop.signal })
      .then((value) => inventory = value)
      .catch((problem) => { if (!interrupted(problem)) { inventory = undefined; detailError = describe(problem); } });
    api.json<{ items: Link[] }>(query(projectApi(project) + '/supplements/links', { receiptId: receipt }), { signal: stop.signal })
      .then((page) => links = page.items)
      .catch((problem) => { if (!interrupted(problem)) links = []; });
    api.json<Page<ImportEntry> & { entries?: ImportEntry[] }>(receiptPath(receipt) + '/import-inventory', { signal: stop.signal })
      .then((page) => { technicalEntries = page.entries ?? page.items ?? []; entriesCursor = page.nextCursor ?? null; })
      .catch((problem) => { if (!interrupted(problem)) technicalEntries = []; });
    return () => stop.abort();
  });

  onDestroy(() => uploadSignal?.abort());

  function url(receipt?: string) {
    return scopedUrl(context.project.id, 'receipts', { scope: context.scopeId, filter: context.filter }, receipt);
  }

  async function loadMore() {
    if (paging || nextCursor == null) return;
    const observed = context.refreshKey;
    paging = true;
    try {
      const page = await api.json<ReceiptList>(query(projectApi(context.project.id) + '/receipts', { state: mode, cursor: nextCursor }));
      if (observed !== context.refreshKey) return;
      const prior = new Set(list.map((item) => item.receiptId));
      list = [...list, ...page.receipts.filter((item) => !prior.has(item.receiptId))];
      nextCursor = page.nextCursor ?? null;
    } catch (problem) {
      error = describe(problem);
    } finally {
      paging = false;
    }
  }

  async function loadTechnical() {
    if (!entriesCursor || technicalPaging) return;
    const observed = context.refreshKey;
    technicalPaging = true;
    try {
      const page = await api.json<{ entries: ImportEntry[]; nextCursor?: string }>(
        query(receiptPath(activeReceipt) + '/import-inventory', { cursor: entriesCursor }),
      );
      if (observed !== context.refreshKey) return;
      technicalEntries = [...technicalEntries, ...page.entries];
      entriesCursor = page.nextCursor ?? null;
    } catch (problem) {
      importError = describe(problem);
    } finally {
      technicalPaging = false;
    }
  }

  function selectFiles(event: Event) {
    files = Array.from((event.currentTarget as HTMLInputElement).files ?? []);
    batch = new Map();
    finished = new Set();
  }

  function folder(input: HTMLInputElement) {
    input.setAttribute('webkitdirectory', '');
  }

  function resume(upload: Upload) {
    active = inventory?.receiptId ?? '';
    existing = upload.uploadId;
    channel = 'file';
    form = true;
    files = [];
    finished = new Set();
    batch = new Map();
  }

  function startNew() {
    form = true;
    active = '';
    existing = '';
    channel = 'file';
    files = [];
    batch = new Map();
    finished = new Set();
    operationError = '';
  }

  async function transfer(event: SubmitEvent) {
    event.preventDefault();
    if (pending) return;
    operationError = '';
    success = '';
    progress = undefined;
    const controller = new AbortController();
    const signal = controller.signal;
    uploadSignal = controller;
    pending = true;
    try {
      if (!active) {
        const result = await commands.send<Receipt>(projectApi(context.project.id) + '/receipts', 'POST', {
          source: channel === 'link' ? 'import' : 'upload',
        }, undefined, signal);
        active = result.receiptId;
      }
      const receiptId = active;
      const base = receiptPath(receiptId);
      const scopeId = declareScope ? context.scopeId : '';
      if (linkedLetter && linkedSent) {
        await commands.send(projectApi(context.project.id) + '/supplements/links', 'POST', {
          receiptId, letterId: linkedLetter, sentId: linkedSent, itemId: linkedItem || null,
        }, undefined, signal);
      }
      if (channel === 'link') {
        await commands.send(base + '/imports', 'POST', {
          url: linkUrl.trim(), scopeIds: scopeId ? [scopeId] : undefined,
        }, undefined, signal);
        await commands.send(base + '/seal', 'POST', {}, undefined, signal);
        linkUrl = '';
        success = 'Ссылка принята. Загрузка поставлена в очередь.';
        form = false;
        return;
      }
      const selected = existing ? (inventory?.uploads ?? []).find((upload) => upload.uploadId === existing) : undefined;
      if (existing && (!selected || files.length !== 1)) throw new Error('Выберите исходный файл для этой передачи.');
      for (const file of files) {
        if (finished.has(file)) continue;
        workingFile = relativePath(file);
        const recoveredId = batch.get(file);
        const previous = recoveredId ? await api.json<Upload>('/api/uploads/' + id(recoveredId), { signal }) : selected;
        let acrossNavigation = previous;
        if (!acrossNavigation && inventory?.receiptId === receiptId) {
          const occurrence = inventory.occurrences.find((item) => item.relativePath === relativePath(file));
          if (occurrence) acrossNavigation = inventory.uploads.find((item) => item.occurrenceId === occurrence.occurrenceId && item.status === 'uploading');
        }
        await sendFile({
          api, commands, receiptId, file, scopeId, previous: acrossNavigation, replacements, signal,
          remember: (uploadId) => batch.set(file, uploadId),
          onProgress: (value) => progress = value,
        });
        finished.add(file);
      }
      success = 'Файлы приняты. Опись доступна до завершения чтения.';
      existing = '';
      files = [];
      form = false;
      replacements = '';
    } catch (problem) {
      operationError = interrupted(problem) ? 'Передача приостановлена. Уже принятые части сохранены.'
        : problem instanceof Error && !(problem instanceof TypeError) && !(problem instanceof ApiError)
          ? problem.message : describe(problem);
    } finally {
      pending = false;
      workingFile = '';
      renew();
    }
  }

  async function mutate(path: string, message: string) {
    if (pending) return;
    pending = true;
    operationError = '';
    try {
      await commands.send(path, 'POST', {});
      success = message;
    } catch (problem) {
      operationError = describe(problem);
    } finally {
      pending = false;
      renew();
    }
  }
</script>

<div class="actions receipt-actions">
  {#if context.canEdit}<button type="button" class="primary" disabled={pending} onclick={startNew}>Добавить поступление</button>{/if}
  <a class="button" href={scopedUrl(context.project.id, 'receipts', { scope: context.scopeId, filter: mode ? undefined : 'uploading' })}>{mode ? 'Все поступления' : 'Незавершённые'}</a>
</div>

{#if context.canEdit && (form || (linkedLetter && linkedSent))}
  <section class="card" aria-labelledby="upload-title">
    <div class="card-header">
      <h2 id="upload-title">{existing ? 'Возобновить передачу' : linkedLetter ? 'Досылка к письму' : activeReceipt ? 'Добавить исходные данные' : 'Новое поступление'}</h2>
      {#if capabilities?.maxReceiptBytes}<span class="meta">До {bytes(capabilities.maxReceiptBytes)} на поступление</span>{/if}
    </div>
    {#if capabilities?.partSize || capabilities?.ttlSeconds}
      <p class="meta">{[
        capabilities?.partSize ? 'Размер части ' + bytes(capabilities.partSize) : '',
        capabilities?.ttlSeconds ? 'Докачка в течение ' + count(capabilities.ttlSeconds) + ' с' : '',
      ].filter(Boolean).join(' · ')}</p>
    {/if}
    {#if formats?.archiveFormats?.length}
      <p class="meta">Архивы · {formats.archiveFormats.map((format) => format.toUpperCase()).join(', ')}
        {#if formats.archiveIsolationConfigured === false} · Раскрытие архивов на этом стенде ограничено{/if}
      </p>
    {/if}
    <form onsubmit={transfer} aria-label="Передача исходных данных">
      {#if !existing}
        <label>Способ передачи<select aria-label="Способ передачи" bind:value={channel} disabled={pending}>
          <option value="file">Файлы или архивы</option>
          <option value="folder">Папка</option>
          <option value="link">Публичная ссылка Яндекс.Диска</option>
        </select></label>
      {/if}
      {#if channel === 'link'}
        <label>Публичная ссылка<input type="url" bind:value={linkUrl} required disabled={pending} /></label>
        <Notice message={importError} />
      {:else if channel === 'folder'}
        <label>Папка<input type="file" use:folder multiple required onchange={selectFiles} disabled={pending} /></label>
      {:else}
        <label>{existing ? 'Исходный файл' : 'Файлы или архивы'}<input type="file" multiple={!existing} required onchange={selectFiles} disabled={pending} /></label>
      {/if}
      {#if context.scopeId && !existing}
        <label><input type="checkbox" bind:checked={declareScope} disabled={pending} /> Применимость ограничена выбранной областью</label>
      {/if}
      {#if files.length}<p class="meta">{files.length} файлов · {bytes(files.reduce((sum, file) => sum + file.size, 0))}</p>{/if}
      {#if progress}
        <div role="status">
          <p>{progress.phase === 'hashing' ? 'Проверка контрольной суммы' : 'Подтверждено сервером'} · {workingFile || 'Файл'} · {bytes(progress.bytes)} из {bytes(progress.total)}</p>
          <progress value={progress.bytes} max={progress.total || 1}></progress>
        </div>
      {/if}
      <div class="actions">
        <button class="primary" disabled={pending}>{existing ? 'Продолжить передачу' : channel === 'link' ? 'Принять ссылку' : 'Начать передачу'}</button>
        {#if pending}<button type="button" onclick={() => uploadSignal?.abort()}>Приостановить</button>
        {:else if !linkedLetter}<button type="button" class="quiet" onclick={() => { form = false; existing = ''; }}>Закрыть</button>{/if}
      </div>
    </form>
  </section>
{/if}

<Notice kind="error" message={operationError} />
<Notice kind="success" message={success} />
<Notice kind="error" message={error} />

{#if loading && !list.length}<p role="status">Открываем список поступлений…</p>{/if}
{#if list.length || (!loading && !error)}
  <section class="card table-card">
    <div class="card-header"><h2>{mode ? 'Незавершённые поступления' : 'Реестр поступлений'}</h2></div>
    {#if list.length}
      <div class="table-wrap">
        <table><thead><tr><th>Поступление</th><th>Канал</th><th>Опись</th><th>Принято</th></tr></thead>
          <tbody>
            {#each list as receipt (receipt.receiptId)}
              <tr>
                <td><a class="row-link" href={url(receipt.receiptId)} aria-current={receipt.receiptId === activeReceipt ? 'true' : undefined}>Поступление №{receipt.number}</a></td>
                <td>{receipt.source === 'import' ? 'Ссылка' : 'Файлы'}</td>
                <td>{receipt.inventoryOpen ? 'Открыта' : 'Зафиксирована'}</td>
                <td>{date(receipt.createdAt)}</td>
              </tr>
            {/each}
          </tbody>
        </table>
      </div>
      {#if nextCursor != null}<div class="card-header"><button type="button" onclick={loadMore} disabled={paging}>Ещё поступления</button></div>{/if}
    {:else}
      <p class="empty">В этом списке поступлений пока нет.</p>
    {/if}
  </section>
{/if}

<IntakeHolds {api} {context} {projection} {renew} receiptId={activeReceipt} />
<Notice kind="error" message={detailError} />
{#if inventory && inventory.receiptId === activeReceipt}
  <section class="card" aria-labelledby="receipt-title">
    <div class="card-header">
      <h2 id="receipt-title">Поступление №{inventory.number}</h2>
      <span class="pill">{inventory.inventoryOpen ? 'Опись открыта' : 'Опись зафиксирована'}</span>
    </div>
    <div class="actions">
      {#if context.canEdit && !inventory.sealed}
        <button type="button" disabled={pending} onclick={() => { active = inventory?.receiptId ?? ''; form = true; }}>Добавить файлы</button>
        <button type="button" disabled={pending} onclick={() => mutate(receiptPath(inventory!.receiptId) + '/seal', 'Объявление входов завершено.')}>Завершить объявление входов</button>
      {/if}
    </div>
    {#if inventory.uploads.length}
      <h3>Передача</h3>
      <ul class="plain-list">
        {#each inventory.uploads as upload (upload.uploadId)}
          <li>
            <strong>{inventory.occurrences.find((item) => item.occurrenceId === upload.occurrenceId)?.relativePath ?? 'Файл'}</strong>
            <p class="meta">{label(upload.status)} · {bytes(upload.confirmedBytes)} из {bytes(upload.size)}{upload.status === 'uploading' ? ' · докачка до ' + date(upload.expiresAt) : ''}</p>
            {#if context.canEdit && upload.status === 'uploading'}
              <div class="actions">
                <button type="button" disabled={pending} onclick={() => resume(upload)}>Докачать файл</button>
                <button type="button" disabled={pending} onclick={() => mutate('/api/uploads/' + id(upload.uploadId) + '/cancel', 'Пустая передача отменена.')}>Отменить декларацию</button>
              </div>
            {/if}
          </li>
        {/each}
      </ul>
    {/if}
    {#if inventory.imports.length}
      <h3>Импорт</h3>
      <ul class="plain-list">
        {#each inventory.imports as item (item.importId)}
          <li>{label(item.status)} {item.reason ? ' · ' + label(item.reason) : ''}
            {#if context.canEdit && !['completed', 'cancelled'].includes(item.status)}
              <button type="button" disabled={pending} onclick={() => mutate(receiptPath(inventory!.receiptId) + '/imports/' + id(item.importId) + '/cancel', 'Импорт отменён.')}>Отменить пустой импорт</button>
            {/if}
            {#if context.canEdit && ['limited', 'failed', 'paused'].includes(item.status)}
              <button type="button" disabled={pending} onclick={() => { startNew(); }}>Загрузить файлы напрямую</button>
            {/if}
          </li>
        {/each}
      </ul>
    {/if}
    {#if links.length}
      <h3>Переписка</h3>
      <ul class="plain-list">{#each links as link (link.id)}
        <li><a href={scopedUrl(context.project.id, 'letters', { scope: context.scopeId, sent: link.sentId }, link.letterId)}>Снимок отправки</a></li>
      {/each}</ul>
    {/if}
  </section>

  <section class="card table-card">
    <div class="card-header"><h2>Опись</h2></div>
    {#if inventory.occurrences.length}
      <div class="table-wrap">
        <table><thead><tr><th>Путь</th><th>Размер</th><th>Состояние</th><th>Оригинал</th></tr></thead>
          <tbody>{#each inventory.occurrences as item (item.occurrenceId)}
            <tr>
              <td>{item.relativePath}</td>
              <td>{bytes(item.size)}</td>
              <td>{label(item.status)}{item.inventoryPending ? ' · раскрывается' : ''}{item.restriction ? ' · ' + label(item.restriction) : ''}</td>
              <td>{#if item.documentId && item.versionId}
                <button type="button" aria-pressed={activeDocument === item.occurrenceId}
                  onclick={() => activeDocument = item.occurrenceId}>Карточка документа</button>
              {/if}</td>
            </tr>
          {/each}</tbody>
        </table>
      </div>
    {:else}<p class="empty">В описи пока нет вхождений.</p>{/if}
  </section>
  {#if technicalEntries.length}
    <section class="card">
      <h2>Состав контейнеров</h2>
      <ul class="plain-list">{#each technicalEntries as item, index (item.id ?? index)}
        <li>{item.relativePath ?? item.path} · {label(item.status)} {item.reason ?? item.restriction ?? ''}</li>
      {/each}</ul>
      {#if entriesCursor}<button type="button" onclick={loadTechnical} disabled={technicalPaging}>Ещё элементы</button>{/if}
    </section>
  {/if}
  {#if selectedDocument?.documentId && selectedDocument.versionId}
    {#key selectedDocument.versionId}
      <Document {api} {context} {renew} {open} occurrence={selectedDocument as Occurrence & { documentId: string; versionId: string }} />
    {/key}
  {/if}
{/if}

<style>
  .receipt-actions { margin-bottom: .8rem; }
</style>
