<script lang="ts">
  import { projectApi, scopedUrl } from './workspace';
  import { Commands } from './commands';
  import { describe, query, type Api } from './http';
  import Notice from './Notice.svelte';
  import { evidenceFilters, type EvidenceFilter } from './triage';
  import { bytes, count, label } from './format';
  import { chooseWorkArea, readingStatus, requirementsUrl, type ResearchContinuation, type WorkSlice } from './work-slice';

  let { slice, api, canEdit, refresh }: {
    slice?: WorkSlice; api: Api; canEdit: boolean; refresh: () => void;
  } = $props();
  const commands = new Commands(() => api);
  let continuing = $state(false);
  let error = $state('');
  let result = $state.raw<{ slice: WorkSlice; continuation: ResearchContinuation; requested: number }>();
  const continuation = $derived(result && result.slice === slice ? result.continuation : slice?.continuation);

  async function continueAvailable() {
    if (!slice || continuing || !continuation?.available) return;
    const { projectId, scopeId } = slice;
    continuing = true;
    error = '';
    try {
      const outcome = await commands.send<{ requested: number; continuation: ResearchContinuation }>(
        query(projectApi(projectId) + '/research-stops/resume', { scopeId }), 'POST', {},
      );
      if (slice?.projectId === projectId && slice.scopeId === scopeId) {
        result = { slice, ...outcome };
        refresh();
      }
    } catch (problem) {
      error = describe(problem);
    } finally {
      continuing = false;
    }
  }
  let now = $state(Date.now());
  $effect(() => { const timer = setInterval(() => now = Date.now(), 1000); return () => clearInterval(timer); });
  const files = $derived(slice?.files);
  const assessment = $derived(slice?.assessment);
  const inventoryClosed = $derived(Boolean(slice?.totals.all && !slice.totals.open));

  function tasks(branch: 'A' | 'B' | null) {
    const items = slice?.readings.filter((item) => item.branch === branch) ?? [];
    const total = items.reduce((sum, item) => sum + item.total, 0);
    const done = items.find((item) => item.state === 'done')?.total ?? 0;
    const held = items.find((item) => item.state === 'held')?.total ?? 0;
    const running = items.find((item) => item.state === 'leased')?.total ?? 0;
    const queued = items.find((item) => item.state === 'ready')?.total ?? 0;
    return total ? `${count(done)} из ${count(total)}${running ? ' · в работе ' + count(running) : ''}${queued ? ' · в очереди ' + count(queued) : ''}${held ? ' · на удержании ' + count(held) : ''}` : 'Заданий пока нет';
  }
</script>

<section class="processing" aria-label="Ход обработки проекта">
  <div class="indicators">
    <div>
      <h2>Файлы и подготовка</h2>
      {#if files?.accepted}
        <progress aria-label="Файлы с готовой картой среди принятых" value={files.prepared} max={files.accepted}></progress>
        <p>Подготовлено {count(files.prepared)} из {count(files.accepted)} принятых файлов
          {#if inventoryClosed} · описи закрыты{:else} · состав уточняется{/if}</p>
      {:else if slice}
        <p>{slice.acceptedOccurrences ? 'Принято вхождений · ' + count(slice.acceptedOccurrences) : 'Ожидаются файлы'}</p>
      {:else}
        <p class="meta">Данные об обработке пока недоступны</p>
      {/if}
    </div>
    <div>
      <h2>Проверка требований по каталогу</h2>
      {#if assessment?.contexts && assessment.contexts.length > 1 && !assessment.contextId && slice}
        <p>Требования по областям проверки</p>
        {#each assessment.contexts as area (area.contextId)}
          <p><a href={requirementsUrl(chooseWorkArea(slice, area.contextId))}>{area.kind === 'common' ? 'Весь комплект' : area.name} · {area.checked ?? area.covered} из {area.total}</a></p>
        {/each}
      {:else if assessment?.total && slice && (slice.files?.accepted || slice.acceptedOccurrences)}
        <progress aria-label="Проверенные обязательные позиции" value={assessment.checked ?? assessment.covered} max={assessment.total}></progress>
        <p>{#if assessment.checked}<a href={requirementsUrl(slice, 'checked')}>Проверено {count(assessment.checked)}</a>{:else}{assessment.checked === undefined ? 'Покрыто' : 'Проверено'} {count(assessment.checked ?? assessment.covered)}{/if} из {count(assessment.total)} требований
          {#if assessment.conflicts} · найдено конфликтов {count(assessment.conflicts)}{/if}</p>
      {:else}
        <p>{slice?.catalogAssigned === false ? 'Для оценки требований нужен применимый каталог.' : 'Проверка требований ещё не началась.'}</p>
      {/if}
      {#if slice && assessment?.total && (!assessment.contexts || assessment.contexts.length <= 1 || assessment.contextId)}
        <a href={requirementsUrl(slice)}>Посмотреть все {assessment.total} требований</a>
        {#if assessment.evidence}
          <ul class="plain-list evidence-counts" aria-label="Итоги проверки требований">
            {#each Object.entries(evidenceFilters) as [filter, title] (filter)}
              <li><a href={requirementsUrl(slice, filter)}>{title} · {count(assessment.evidence[filter as EvidenceFilter])}</a></li>
            {/each}
          </ul>
        {/if}
        {#if assessment.letter}
          <p><a href={scopedUrl(slice.projectId, 'letters', { scope: slice.scopeId, context: assessment.contextId })}>Подтверждено к запросу · {count(assessment.letter)}</a></p>
        {/if}
      {/if}
    </div>
  </div>
  {#if slice}
    <p role="status">{readingStatus(slice, now)}</p>
    {#if continuation && (continuation.available || continuation.queued || continuation.needsAction)}
      <div class="actions">
        {#if canEdit && continuation.available}
          <button type="button" disabled={continuing} onclick={continueAvailable}>
            Продолжить доступные задания · {count(continuation.available)}
          </button>
        {/if}
        {#if continuation.queued}<span>Ожидают продолжения в очереди · {count(continuation.queued)}</span>{/if}
        {#if continuation.needsAction}<span>Требуют отдельного действия · {count(continuation.needsAction)}</span>{/if}
      </div>
    {/if}
    <Notice kind="error" message={error} />
    <Notice kind="success" message={result && result.slice.projectId === slice.projectId && result.slice.scopeId === slice.scopeId
      ? result.requested ? 'К продолжению принято заданий · ' + count(result.requested) : 'Доступных для продолжения заданий больше нет.'
      : ''} />
    {#if slice.stops?.length}
      <ul class="plain-list" aria-label="Остановленные задания">
        {#each slice.stops as stop (stop.jobId)}
          <li><strong>{stop.branch ? 'Ветвь ' + stop.branch : 'Сверка'}</strong> · {label(stop.reason, 'Требуется проверка задания')}
            <p>{label(stop.nextAction, 'Проверьте сохранённые материалы и состояние задания в документе.')}</p>
            {#if stop.receiptId && stop.versionId}
              <a href={scopedUrl(slice.projectId, 'receipts', { scope: slice.scopeId, document: stop.versionId }, stop.receiptId)}>{stop.label || 'Открыть документ'}</a>
            {/if}
          </li>
        {/each}
      </ul>
      {#if slice.moreStops}<p>Показаны первые восемь остановок. Остальные задания доступны в карточках документов.</p>{/if}
    {/if}
    {#if slice.readingService && (files?.accepted || slice.acceptedOccurrences)}
      <p class="meta">Последний сигнал исполнителя · <time datetime={slice.readingService.observedAt}>{new Date(slice.readingService.observedAt).toLocaleString('ru-RU')}</time></p>
    {/if}
    <details>
      <summary>Подробности обработки</summary>
      <dl class="details">
        <dt>Передача</dt><dd>{bytes(slice.confirmedBytes)} подтверждено</dd>
        <dt>Опись</dt><dd>{count(slice.acceptedOccurrences)} принятых вхождений · {count(slice.totals.open)} открытых описей</dd>
        <dt>Карта оригиналов</dt><dd>{files ? count(files.prepared) + ' из ' + count(files.accepted) : 'Данные этой проверки отсутствуют'}</dd>
        <dt>Ветвь A</dt><dd>{tasks('A')}</dd>
        <dt>Ветвь B</dt><dd>{tasks('B')}</dd>
        <dt>Сверки</dt><dd>{tasks(null)}</dd>
        <dt>Применение</dt><dd>{assessment ? 'Оценка №' + assessment.version : 'Оценка пока не сформирована'}</dd>
      </dl>
    </details>
  {/if}
</section>

<style>
  .processing { border-block: 1px solid var(--line); padding-block: 12px; margin-bottom: 16px; }
  .indicators { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(220px, 100%), 1fr)); gap: 12px 24px; }
  h2 { margin-bottom: 4px; }
  progress { height: .65rem; }
  p { margin-bottom: 8px; }
  .evidence-counts { display: flex; flex-wrap: wrap; gap: 4px 12px; margin-top: 6px; }
</style>
