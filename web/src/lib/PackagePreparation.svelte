<script lang="ts">
  import { originalUrl } from './copilot';
  import { count, label } from './format';
  import { denied, describe, id, interrupted, type Api } from './http';
  import { projectV1, scopedUrl } from './workspace';

  type Item = { occurrenceId: string | null; documentId: string | null; versionId: string | null; label: string;
    state: 'waiting' | 'available' | 'unavailable' | 'excluded'; reason: string | null;
    kind: 'document' | 'archive' | 'technical' | 'import_entry'; derivativeAvailable: boolean };
  type Preparation = { projectId: string; receiptId: string; state: 'waiting' | 'ready'; manifestId: string | null; revision: number | null;
    counts: { total: number; available: number; unavailable: number; waiting: number; archives: number; technical: number; restrictions: number }; items: Item[];
    restrictions: { label: string; reason: string; sourceId: string }[]; reasons: string[] };
  let { api, projectId, receiptId, refreshKey, compact = false }: {
    api: Api; projectId: string; receiptId: string; refreshKey: number; compact?: boolean;
  } = $props();
  let preparation = $state<Preparation>();
  let error = $state('');
  let loadedKey = '';
  let failures = $derived.by(() => {
    const items = (preparation?.items ?? []).filter((item) => item.state === 'unavailable' || item.kind === 'archive' && item.reason);
    const extra: Item[] = (preparation?.restrictions ?? []).filter((restriction) => !items.some((item) =>
      item.occurrenceId === restriction.sourceId || item.label === restriction.label && item.reason === restriction.reason))
      .map((restriction) => ({ occurrenceId: null, documentId: null, versionId: null, label: restriction.label,
        state: 'unavailable', reason: restriction.reason, kind: 'import_entry', derivativeAvailable: false }));
    return [...items, ...extra];
  });
  let derivatives = $derived.by(() => {
    const seen = new Set<string>();
    return (preparation?.items ?? []).filter((item) => {
      if (item.state !== 'available' || !item.derivativeAvailable || !item.documentId || !item.versionId || seen.has(item.versionId)) return false;
      seen.add(item.versionId);
      return true;
    });
  });
  function card(item: Item) {
    return scopedUrl(projectId, 'receipts', { document: item.versionId, row: item.occurrenceId }, receiptId);
  }
  function derivative(item: Item) {
    return '/api/v1/documents/' + id(item.documentId!) + '/versions/' + id(item.versionId!) + '/dwg-derivative';
  }
  $effect(() => {
    const project = projectId;
    const receipt = receiptId;
    void refreshKey;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const key = project + '/' + receipt;
    if (loadedKey !== key) { preparation = undefined; error = ''; loadedKey = key; }
    async function load() {
      try {
        const result = await api.json<Preparation>(projectV1(project) + '/receipts/' + id(receipt) + '/preparation', { signal: controller.signal });
        if (controller.signal.aborted) return;
        if (result.projectId !== project || result.receiptId !== receipt) throw new Error('Получено состояние другого поступления.');
        preparation = result;
        error = '';
      } catch (failure) {
        if (controller.signal.aborted || interrupted(failure)) return;
        if (denied(failure)) preparation = undefined;
        error = describe(failure);
      }
      if (!controller.signal.aborted && (error || !preparation?.manifestId || preparation.state === 'waiting')) timer = setTimeout(load, 30_000);
    }
    void load();
    return () => { controller.abort(); if (timer) clearTimeout(timer); };
  });
</script>

<section class="card" aria-labelledby={compact ? 'preparation-overview-title' : 'preparation-receipt-title'}>
  <h2 id={compact ? 'preparation-overview-title' : 'preparation-receipt-title'}>Подготовка документов к анализу</h2>
  {#if error}<p role="alert">Не удалось обновить состояние подготовки: {error}.{preparation ? ' Показаны последние полученные сведения.' : ''}</p>{/if}
  {#if preparation}
    {@const counts = preparation.counts}
    {#if preparation.state === 'waiting'}
      <p role="status">Проверяются приём файлов, раскрытие архивов и подготовка исходников. Анализ доступных документов ожидает завершения подготовки.</p>
    {:else if counts.available === 0}
      <p role="status">Нет пригодных для анализа документов. Новый анализ по этому составу не запущен.</p>
    {:else}
      <p role="status">Подготовка файлов завершена. Доступные документы могут быть переданы на анализ.</p>
    {/if}
    <p>Документов: {count(counts.total)} · доступно для анализа: {count(counts.available)} · не подготовлено: {count(counts.unavailable)} · ожидают: {count(counts.waiting)}.</p>
    <p class="meta">Архивов: {count(counts.archives)} · служебных частей: {count(counts.technical)} · ограничений при приёме и раскрытии: {count(counts.restrictions)}.</p>
    {#if !preparation.manifestId}<p class="meta">Снимок подготовки этого поступления ещё не закреплён. Показано текущее состояние; ранее сохранённый разбор доступен отдельно.</p>{/if}
    {#if failures.length}
      <h3>Непрочитанные документы и ограничения приёма</h3>
      <ul>{#each failures as item, index (item.occurrenceId ?? item.versionId ?? index)}
        <li><strong>{item.label}</strong> · {item.reason ? label(item.reason) : 'Причина не указана сервером'}
          {#if item.documentId && item.versionId}
            · <a href={originalUrl(item.documentId, item.versionId)} target="_blank" rel="noopener noreferrer">Открыть оригинал</a>
            {#if item.occurrenceId} · <a href={card(item)}>Карточка документа</a>{/if}
          {/if}
        </li>
      {/each}</ul>
    {/if}
    {#if derivatives.length}
      <details><summary>Машиночитаемые версии DWG · {count(derivatives.length)}</summary>
        <ul>{#each derivatives as item (item.versionId)}<li>{item.label} · <a href={derivative(item)}>Скачать машиночитаемую версию</a>
          {#if item.occurrenceId} · <a href={card(item)}>Карточка документа и карта</a>{/if}
          · <a href={originalUrl(item.documentId!, item.versionId!)} target="_blank" rel="noopener noreferrer">Оригинал</a>
        </li>{/each}</ul>
      </details>
    {/if}
  {:else if !error}<p role="status">Загружаем состояние подготовки…</p>{/if}
</section>
