<script lang="ts">
  import { bytes, count } from './format';
  import type { WorkSlice } from './work-slice';

  let { slice }: { slice?: WorkSlice } = $props();
  const files = $derived(slice?.files);
  const assessment = $derived(slice?.assessment);
  const inventoryClosed = $derived(Boolean(slice?.totals.all && !slice.totals.open));

  function tasks(branch: 'A' | 'B' | null) {
    const items = slice?.readings.filter((item) => item.branch === branch) ?? [];
    const total = items.reduce((sum, item) => sum + item.total, 0);
    const done = items.find((item) => item.state === 'done')?.total ?? 0;
    const held = items.find((item) => item.state === 'held')?.total ?? 0;
    return total ? `${count(done)} из ${count(total)}${held ? ' · на удержании ' + count(held) : ''}` : 'Заданий пока нет';
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
      <h2>Анализ позиций</h2>
      {#if assessment?.total}
        <progress aria-label="Проверенные обязательные позиции" value={assessment.checked ?? assessment.covered} max={assessment.total}></progress>
        <p>{assessment.checked === undefined ? 'Покрыто' : 'Проверено'} {count(assessment.checked ?? assessment.covered)} из {count(assessment.total)} обязательных позиций
          {#if assessment.conflicts} · найдено конфликтов {count(assessment.conflicts)}{/if}</p>
      {:else}
        <p>Проверка обязательных позиций ещё не началась</p>
      {/if}
    </div>
  </div>
  {#if slice}
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
</style>
