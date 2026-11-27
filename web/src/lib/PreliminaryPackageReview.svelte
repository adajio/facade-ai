<script lang="ts">
  import { preliminaryQuestions, preliminaryStatusLabels, type PreliminaryReview, type PreliminaryStatus } from './preliminary-review';
  import { date } from './format';
  import { denied, describe, id, interrupted, type Api } from './http';
  import { projectV1, scopedUrl } from './workspace';
  import { readingStopMessages, readingStopReason } from './reading-stop';
  import Notice from './Notice.svelte';
  import PreliminaryRequirementAnalysis from './PreliminaryRequirementAnalysis.svelte';
  import PreliminaryRowChange from './PreliminaryRowChange.svelte';
  import PreliminarySources from './PreliminarySources.svelte';
  import PreliminaryStatusBadge from './PreliminaryStatusBadge.svelte';
  import ReceiptEvidenceChain from './ReceiptEvidenceChain.svelte';
  import type { TerraReading } from './TerraReadingProgress.svelte';

  type ReadingProgress = { totalWindows: number; mappedVersions: number; acceptedVersions: number;
    completed: number; covered: number; partial?: number; noMatch: number; refused: number; held: number; reading: number };
  let { api, projectId, refreshKey, mode }: { api: Api; projectId: string; refreshKey: number; mode: 'review' | 'letter' } = $props();
  let reviews = $state<PreliminaryReview[]>([]);
  let selectedId = $state('');
  let manuallySelected = $state(false);
  let error = $state('');
  let copied = $state('');
  let progress = $state<ReadingProgress>();
  let progressError = $state('');
  let textArea = $state<HTMLTextAreaElement>();
  let letterReading = $state<{ project: string; data: Pick<TerraReading, 'enabled' | 'receipt' | 'report' | 'progress'> }>();
  let selected = $derived(reviews.find((item) => item.id === selectedId));
  let progressReviewId = $derived(mode === 'review' && selected?.isCurrent ? selected.id : undefined);
  const letterReviewId = $derived(mode === 'letter' && selected?.isCurrent ? selected.id : undefined);
  const letterStop = $derived.by(() => {
    const data = letterReading?.data;
    if (!letterReviewId || letterReading?.project !== projectId || !data?.enabled ||
        data.report?.id !== letterReviewId || data.receipt?.receiptId !== selected?.receiptId) return;
    return readingStopReason(data.progress);
  });
  let questions = $derived(selected ? preliminaryQuestions(selected.rows) : []);
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
    void refreshKey;
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

  $effect(() => {
    const project = projectId;
    void refreshKey;
    if (!letterReviewId) return;
    const controller = new AbortController();
    void api.json<NonNullable<typeof letterReading>['data']>(projectV1(project) + '/terra-reading', { signal: controller.signal })
      .then(data => {
        if (!controller.signal.aborted) letterReading = { project, data };
      })
      .catch(failure => {
        if (!controller.signal.aborted && denied(failure)) letterReading = undefined;
      });
    return () => controller.abort();
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
    <p class="notice">{mode === 'review' ? 'Предварительный результат. Решение инженера отображается в строке каждого требования.'
      : 'Предварительный проект по результатам разбора. Редакции писем инженера хранятся в списке писем.'}</p>
    {#if reviews.length > 1}
      <label>Разбор
        <select bind:value={selectedId} onchange={() => { manuallySelected = true; copied = ''; }}>
          {#each reviews as item (item.id)}
            <option value={item.id} title={item.receiptId}>{date(item.createdAt)} · {item.isCurrent ? 'Актуальный' : 'Исторический'}</option>
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
            {#if progress.totalWindows > 0} Результат по {progress.completed} из {progress.totalWindows} участков.{/if}
          {:else if progress.totalWindows === 0}
            в карте нет участков для чтения.
          {:else}
            результат по {progress.completed} из {progress.totalWindows} участков.
          {/if}
          {#if progress.totalWindows > 0}
            С находками {progress.covered}, без совпадений {progress.noMatch}, с отказом {progress.refused}{#if progress.partial !== undefined}, частично прочитано {progress.partial}{/if}.
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
        <thead><tr><th>Позиция</th><th>Предварительный разбор и источники</th></tr></thead>
        <tbody>
          {#each selected.rows as row (row.key)}
            <tr><td>{row.title}</td><td>
              <PreliminaryRequirementAnalysis {row} />
              <PreliminaryRowChange {row} changes={selected.changes} />
            </td></tr>
          {/each}
        </tbody>
      </table></div></details>
    {:else}
      {#if letterStop}
        <div class="notice letter-reading-stop">
          <div role="status">
            <p><strong>Черновик по частично прочитанному пакету.</strong></p>
            <p>{readingStopMessages[letterStop]}</p>
            <p>Откройте комплектность, чтобы сверить выводы и открытые пункты по источникам.</p>
          </div>
          <a href={scopedUrl(projectId, 'completeness', {})}>Сверить требования и источники</a>
        </div>
      {/if}
      {#if !selected.changes}
        <p class="meta">Нет данных для сравнения с первоначальным проектом письма.</p>
      {:else if selected.changes.baselineId === null}
        <p class="meta">Первоначальный проект письма.</p>
      {:else if !selected.changes.letter.changed}
        <p class="meta">{selected.changes.baselineScope === 'previous_receipt' ? 'Проект письма с предыдущего поступления без изменений.' : 'Проект письма с первоначального разбора без изменений.'}</p>
      {:else}
        {@const changes = selected.changes}
        {@const earlierReceipt = changes.baselineScope === 'previous_receipt'}
        <p title={changes.baselineReceiptId ?? undefined}>
          {earlierReceipt ? 'Проект письма изменился после предыдущего поступления' : 'Проект письма изменился после первоначального разбора'}{changes.baselineAt ? ' от ' + date(changes.baselineAt) : ''}.
        </p>
        {#if changes.letter.removed.length || changes.letter.added.length}
          <details class="letter-changes">
            <summary>Изменения проекта письма</summary>
            <div class="form-row">
              <div>
                <h3>{earlierReceipt ? 'Текст по предыдущему поступлению' : 'Первоначальный текст'}</h3>
                {#each changes.letter.removed as text}<p>{text}</p>{:else}<p>Фрагменты не исключены.</p>{/each}
              </div>
              <div>
                <h3>Текст в этой редакции</h3>
                {#each changes.letter.added as text}<p>{text}</p>{:else}<p>Фрагменты не добавлены.</p>{/each}
              </div>
            </div>
          </details>
        {/if}
      {/if}
      <label>Текст предварительного черновика
        <textarea bind:this={textArea} readonly rows="18" value={selected.draftText}></textarea>
      </label>
      <div class="actions"><button type="button" onclick={copyDraft}>Скопировать текст</button><span role="status">{copied}</span></div>
      {#if questions.length}
        <details class="letter-sources">
          <summary>Основания вопросов письма</summary>
          <ol>
            {#each questions as question (question.key)}
              <li>
                <strong>{[...question.subjects].join(' / ')}</strong>
                <p>{question.text}</p>
                <PreliminarySources sources={question.sources} label={question.subjects.size === 1 ? 'Основания вопроса по свойству «' + question.property + '»' : 'Источники этого вопроса'} />
              </li>
            {/each}
          </ol>
        </details>
      {/if}
    {/if}
  </section>
  {#if mode === 'review'}
    {#key selected.id}
      <ReceiptEvidenceChain {api} {projectId} receiptId={selected.receiptId} reviewId={selected.id} {refreshKey} />
    {/key}
  {/if}
{/if}

<style>
  textarea { width: 100%; min-height: 18em; field-sizing: content; }
  .letter-reading-stop p { margin: 0 0 .35rem; }
  .letter-sources { margin-block-start: .85rem; }
  .letter-sources li + li { margin-block-start: .7rem; }
  .letter-sources p { margin: .35rem 0; }
  .letter-changes { margin-block-end: .85rem; }
  .letter-changes .form-row { align-items: start; }
  .letter-changes .form-row > div { flex: 1 1 15rem; min-width: 0; margin-block-start: .5rem; }
  .letter-changes p { white-space: pre-wrap; overflow-wrap: anywhere; }
</style>
