<script lang="ts">
  import { Commands } from '../lib/commands';
  import { describe, denied, endpoint, id, query, type Api } from '../lib/http';
  import { projectApi, scopedUrl, type WorkspaceProps } from '../lib/workspace';
  import Notice from '../lib/Notice.svelte';

  type Box = { x: number; y: number; width: number; height: number };
  type Summary = { id: string; page: number; version: number; state: 'draft' | 'granted' | 'revoked' };
  type Fragment = Summary & {
    box: Box; quote: string | null; previewUrl?: string;
    source?: { documentId: string; versionId: string; sha256: string };
    history?: { version: number; reason: string; createdAt: string; actorId: string }[];
  };
  type FragmentPage = { items: Summary[]; nextCursor: string | null };

  let { api, context }: { api: Api; context: WorkspaceProps } = $props();
  const commands = new Commands(() => api);
  const labels = { draft: 'Черновик', granted: 'Выдан', revoked: 'Отозван' };
  let base = $derived(projectApi(context.project.id) + '/scopes/' + id(context.scopeId) + '/fragment-publications');
  let selectedId = $derived(context.objectId);
  let after = $derived(context.params.get('after'));
  let list = $state<FragmentPage>();
  let card = $state<Fragment>();
  let shown = $derived(card?.id === selectedId ? card : undefined);
  let listError = $state('');
  let cardError = $state('');
  let operationError = $state('');
  let pending = $state(false);
  let update = $state(0);
  let documentId = $state('');
  let versionId = $state('');
  let page = $state<number>();
  let x = $state<number>();
  let y = $state<number>();
  let width = $state<number>();
  let height = $state<number>();
  let kind = $state<'quote' | 'crop'>('quote');
  let quote = $state('');
  let reason = $state('');
  let changeReason = $state('');

  $effect(() => {
    const params = context.params;
    documentId = params.get('document') ?? '';
    versionId = params.get('version') ?? '';
    page = Number(params.get('page')) || 1;
  });

  $effect(() => {
    void selectedId;
    changeReason = '';
    operationError = '';
  });

  $effect(() => {
    if (!context.scopeId) return;
    const path = base;
    const key = selectedId;
    const cursor = after;
    void context.refreshKey;
    void update;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    cardError = '';

    async function load() {
      const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(8_000)]);
      await Promise.all([
        api.json<FragmentPage>(query(path, { after: cursor }), { signal })
          .then((data) => { list = data; listError = ''; })
          .catch((error) => {
            if (!controller.signal.aborted) { list = undefined; listError = describe(error); }
          }),
        key && api.json<Fragment>(path + '/' + id(key), { signal })
          .then((data) => { card = data; cardError = ''; })
          .catch((error) => {
            if (controller.signal.aborted) return;
            card = undefined;
            cardError = denied(error)
              ? 'Фрагмент недоступен. Для этой области требуется отдельная действующая выдача.'
              : describe(error);
          }),
      ]);
      if (!controller.signal.aborted) timer = setTimeout(load, 5000);
    }

    void load();
    return () => { controller.abort(); clearTimeout(timer); };
  });

  function link(key?: string, cursor?: string | null) {
    return scopedUrl(context.project.id, 'fragments', { scope: context.scopeId, after: cursor }, key);
  }

  async function submit(event: SubmitEvent) {
    event.preventDefault();
    if (pending) return;
    pending = true;
    operationError = '';
    try {
      const body = { documentId, versionId, page, box: { x, y, width, height }, kind, reason, ...(kind === 'quote' ? { quote } : {}) };
      const saved = await commands.send<{ id: string }>(base, 'POST', body);
      window.location.assign(link(saved.id));
    } catch (error) {
      operationError = describe(error);
    } finally {
      pending = false;
    }
  }

  async function change(event: SubmitEvent, fragment: Fragment) {
    event.preventDefault();
    if (pending) return;
    pending = true;
    operationError = '';
    const action = fragment.state === 'draft' ? 'grant' : 'revoke';
    try {
      await commands.send(base + '/' + id(fragment.id) + '/' + action, 'POST', { reason: changeReason }, fragment.version);
      changeReason = '';
    } catch (error) {
      operationError = describe(error);
    } finally {
      pending = false;
      update++;
    }
  }
</script>

{#if !context.scopeId}
  <section class="card"><h2>Опубликованные фрагменты</h2>
    <p>Здесь участнику можно открыть отдельную цитату или участок страницы PDF. Для выдачи фрагмента нужна область проекта с настроенным доступом.</p>
    <a href={scopedUrl(context.project.id, 'receipts', {})}>Открыть оригиналы в поступлениях</a>
  </section>
{:else}
  {#if context.canEdit}
    <details class="card" open={Boolean(context.params.get('document'))}>
      <summary>Подготовить фрагмент PDF</summary>
      <form onsubmit={submit}>
        <div class="form-row">
          <label>Документ<input bind:value={documentId} required /></label>
          <label>Версия оригинала<input bind:value={versionId} required /></label>
          <label>Страница<input type="number" bind:value={page} min="1" max="10000" required /></label>
        </div>
        <fieldset>
          <legend>Рамка от верхнего левого угла видимой страницы, в пунктах PDF</legend>
          <div class="form-row">
            <label>Слева<input type="number" bind:value={x} min="0" step="any" required /></label>
            <label>Сверху<input type="number" bind:value={y} min="0" step="any" required /></label>
            <label>Ширина<input type="number" bind:value={width} min="0.001" step="any" required /></label>
            <label>Высота<input type="number" bind:value={height} min="0.001" step="any" required /></label>
          </div>
        </fieldset>
        <label>Вид фрагмента
          <select bind:value={kind}><option value="quote">Точная цитата</option><option value="crop">Обрезанное изображение</option></select>
        </label>
        {#if kind === 'quote'}<label>Точная цитата<input bind:value={quote} maxlength="500" required /></label>{/if}
        <label>Основание подготовки<input bind:value={reason} maxlength="500" required /></label>
        <div class="actions"><button type="submit" class="primary" disabled={pending}>Сохранить черновик</button></div>
      </form>
    </details>
  {/if}

  <Notice kind="error" message={operationError} />
  <div class="split">
    <section class="card">
      <h2>Фрагменты области</h2>
      <Notice kind="error" message={listError} />
      {#if list?.items.length}
        <ul class="plain-list">
          {#each list.items as item (item.id)}
            <li><a href={link(item.id, after)} aria-current={selectedId === item.id ? 'true' : undefined}>
              Страница {item.page} · {labels[item.state]} · {item.id.slice(0, 8)}
            </a></li>
          {/each}
        </ul>
      {:else if list}
        <p>В этой области нет доступных фрагментов.</p>
      {/if}
      <div class="actions">
        {#if after}<a href={link(selectedId)}>Первая страница</a>{/if}
        {#if list?.nextCursor}<a href={link(selectedId, list.nextCursor)}>Следующая страница</a>{/if}
      </div>
    </section>

    {#if selectedId}
      <section class="card" aria-labelledby="fragment-card">
        <h2 id="fragment-card">Карточка фрагмента</h2>
        <Notice kind="error" message={cardError} />
        {#if shown}
          <p>Страница {shown.page} · {labels[shown.state]} · версия {shown.version}</p>
          <p class="meta">Рамка {shown.box.x}, {shown.box.y} · {shown.box.width} × {shown.box.height} пт</p>
          {#if shown.quote}<blockquote>{shown.quote}</blockquote>{/if}
          {#if shown.previewUrl}
            <img src={endpoint(shown.previewUrl)} alt="Обрезанное изображение фрагмента" />
          {/if}
          {#if context.canEdit && shown.source}
            <p class="meta">Версия оригинала {shown.source.versionId}</p>
            {#if shown.history}
              <details>
                <summary>История публикации</summary>
                <ol>
                  {#each shown.history as event (event.version)}
                    <li>{labels[event.version === 1 ? 'draft' : event.version === 2 ? 'granted' : 'revoked']} · {event.reason}</li>
                  {/each}
                </ol>
              </details>
            {/if}
            {#if shown.state !== 'revoked'}
              <form onsubmit={(event) => change(event, shown!)}>
                <label>{shown.state === 'draft' ? 'Основание выдачи' : 'Основание отзыва'}
                  <input bind:value={changeReason} maxlength="500" required />
                </label>
                <div class="actions">
                  <button type="submit" disabled={pending}>{shown.state === 'draft' ? 'Выдать в выбранную область' : 'Отозвать выдачу'}</button>
                </div>
              </form>
            {/if}
          {/if}
        {/if}
      </section>
    {/if}
  </div>
{/if}

<style>
  img { display: block; max-width: 100%; height: auto; }
</style>
