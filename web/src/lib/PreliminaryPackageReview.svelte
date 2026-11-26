<script lang="ts">
  import { preliminarySourcePlace, preliminarySourceUrl, preliminaryStatusLabels, type PreliminaryReview, type PreliminaryStatus } from './preliminary-review';
  import { date } from './format';
  import { denied, describe, id, interrupted, type Api } from './http';
  import { projectV1 } from './workspace';
  import Notice from './Notice.svelte';
  import PreliminaryStatusBadge from './PreliminaryStatusBadge.svelte';

  type ReadingProgress = { totalWindows: number; mappedVersions: number; acceptedVersions: number;
    completed: number; covered: number; noMatch: number; refused: number; held: number; reading: number };
  let { api, projectId, refreshKey, mode }: { api: Api; projectId: string; refreshKey: number; mode: 'review' | 'letter' } = $props();
  let reviews = $state<PreliminaryReview[]>([]);
  let selectedId = $state('');
  let manuallySelected = $state(false);
  let error = $state('');
  let copied = $state('');
  let progress = $state<ReadingProgress>();
  let progressError = $state('');
  let textArea = $state<HTMLTextAreaElement>();
  let selected = $derived(reviews.find((item) => item.id === selectedId));
  let progressReviewId = $derived(mode === 'review' && selected?.isCurrent ? selected.id : undefined);
  let counts = $derived(selected ? (Object.keys(preliminaryStatusLabels) as PreliminaryStatus[]).map((status) => ({
    status, count: selected!.rows.filter((row) => row.status === status).length,
  })) : []);

  $effect(() => {
    const project = projectId;
    void refreshKey;
    const controller = new AbortController();
    async function load() {
      const items: PreliminaryReview[] = [];
      let cursor: string | null = null;
      do {
        const path = projectV1(project) + '/preliminary-package-reviews' + (cursor ? '?after=' + encodeURIComponent(cursor) : '');
        const page: { items: PreliminaryReview[]; nextCursor?: string | null } = await api.json(path, { signal: controller.signal });
        items.push(...page.items);
        if (page.nextCursor && page.nextCursor === cursor) throw new Error('Курсор истории не продвинулся');
        cursor = page.nextCursor ?? null;
      } while (cursor);
      if (controller.signal.aborted) return;
      reviews = items;
      if (!manuallySelected || !items.some((item) => item.id === selectedId)) {
        selectedId = (items.find((item) => item.isCurrent) ?? items[0])?.id ?? '';
        manuallySelected = false;
      }
      error = '';
    }
    void load().catch((failure) => {
      if (!controller.signal.aborted && !interrupted(failure)) {
        if (denied(failure)) { reviews = []; selectedId = ''; }
        error = describe(failure);
      }
    });
    return () => controller.abort();
  });

  $effect(() => {
    const reviewId = progressReviewId;
    const project = projectId;
    progress = undefined;
    progressError = '';
    if (!reviewId) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    async function loadProgress() {
      let finished = false;
      try {
        const result = await api.json<ReadingProgress>(projectV1(project) + '/preliminary-package-reviews/' + id(reviewId!) + '/reading-progress', { signal: controller.signal });
        if (controller.signal.aborted) return;
        progress = result;
        progressError = '';
        finished = result.acceptedVersions > 0 && result.mappedVersions >= result.acceptedVersions &&
          result.completed >= result.totalWindows && result.reading === 0 && result.held === 0;
      } catch (failure) {
        if (controller.signal.aborted || interrupted(failure)) return;
        progressError = describe(failure);
      }
      if (!controller.signal.aborted && !finished) timer = setTimeout(loadProgress, 30_000);
    }
    void loadProgress();
    return () => { controller.abort(); if (timer) clearTimeout(timer); };
  });

  async function copyDraft() {
    if (!selected) return;
    try {
      await navigator.clipboard.writeText(selected.draftText);
      copied = 'Текст скопирован.';
    } catch {
      textArea?.focus();
      textArea?.select();
      copied = 'Текст выделен. Скопируйте его обычной командой копирования.';
    }
  }
</script>

{#if error}
  <section class="card"><h2>Предварительный разбор пакета</h2><Notice kind="error" message={'Не удалось загрузить предварительный разбор: ' + error + (selected ? '. Показан последний полученный результат.' : '')} /></section>
{/if}
{#if selected}
  <section class="card preliminary-review" aria-label={mode === 'review' ? 'Предварительный разбор пакета' : 'Черновик письма по результатам проверки'}>
    <h2>{mode === 'review' ? 'Предварительный разбор пакета' : 'Черновик письма по результатам проверки'}</h2>
    <p class="notice">Предварительный результат. Решение инженера отображается в строке каждого требования.</p>
    {#if reviews.length > 1}
      <label>Поступление
        <select bind:value={selectedId} onchange={() => { manuallySelected = true; copied = ''; }}>
          {#each reviews as item, index (item.id)}
            <option value={item.id} title={item.receiptId}>Разбор {index + 1} · {date(item.createdAt)} · {item.isCurrent ? 'актуальное' : 'историческое'}</option>
          {/each}
        </select>
      </label>
    {/if}
    <p title={selected.receiptId}><strong>{selected.isCurrent ? 'Актуальный разбор' : 'Исторический разбор'}</strong> · {date(selected.createdAt)}</p>
    <p class="meta" title={'Версия каталога: ' + selected.catalogVersionId}>{selected.stage}</p>
    {#if selected.scopeNote}<p>{selected.scopeNote}</p>{/if}
    {#if mode === 'review' && selected.isCurrent}
      {#if progressError}<p role="alert">Не удалось загрузить состояние постраничного чтения: {progressError}</p>{/if}
      {#if progress && !progressError}
        <p role="status" class="meta">Постраничное чтение:
          {#if progress.mappedVersions < progress.acceptedVersions || progress.acceptedVersions === 0}
            строится карта файлов ({progress.mappedVersions} из {progress.acceptedVersions}).
            {#if progress.totalWindows > 0} Завершено {progress.completed} из {progress.totalWindows} участков.{/if}
          {:else if progress.totalWindows === 0}
            в карте нет участков для чтения.
          {:else}
            завершено {progress.completed} из {progress.totalWindows} участков: с находками {progress.covered}, без совпадений {progress.noMatch}, с отказом {progress.refused}.
          {/if}
          {#if progress.held > 0} Ожидают разбора: {progress.held}.{/if}
          Сейчас читается {progress.reading}.
        </p>
      {/if}
    {/if}
    {#if mode === 'review'}
      <div class="actions" aria-label="Число позиций по состояниям">
        {#each counts as item (item.status)}<PreliminaryStatusBadge status={item.status} count={item.count} />{/each}
      </div>
      <p class="meta">Всего позиций: {selected.rows.length}</p>
      <details><summary>Все выводы и источники</summary>
      <div class="table-wrap"><table>
        <thead><tr><th>Позиция</th><th>Состояние</th><th>Предварительный разбор и источники</th></tr></thead>
        <tbody>
          {#each selected.rows as row (row.key)}
            <tr><td>{row.title}</td><td><PreliminaryStatusBadge status={row.status} /></td><td>
              <p>{row.finding}</p>
              {#if row.sources.length}
                <ul>{#each row.sources as source}
                  <li><a href={preliminarySourceUrl(source)} target="_blank" rel="noopener noreferrer">{source.label}</a> · {preliminarySourcePlace(source).label}</li>
                {/each}</ul>
              {/if}
            </td></tr>
          {/each}
        </tbody>
      </table></div></details>
    {:else}
      <label>Текст предварительного черновика
        <textarea bind:this={textArea} readonly rows="18" value={selected.draftText}></textarea>
      </label>
      <div class="actions"><button type="button" onclick={copyDraft}>Скопировать текст</button><span role="status">{copied}</span></div>
    {/if}
  </section>
{/if}

<style>
  textarea { width: 100%; min-height: 18em; field-sizing: content; }
</style>
