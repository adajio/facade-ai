<script lang="ts">
  import { date } from './format';
  import { preliminaryStatusLabels, type PreliminaryChanges, type PreliminaryRow } from './preliminary-review';
  import PreliminarySources from './PreliminarySources.svelte';

  let { row, changes, compact = false }: { row: PreliminaryRow; changes?: PreliminaryChanges; compact?: boolean } = $props();

  const change = $derived(changes?.rows.find(({ key }) => key === row.key));
  const status = $derived(change?.previousStatus && change.previousStatus !== row.status
    ? `Статус изменился с «${preliminaryStatusLabels[change.previousStatus]}» на «${preliminaryStatusLabels[row.status]}»`
    : change?.previousStatus ? 'Статус прежний' : 'В первоначальном разборе статус позиции отсутствует');
  const findingChanged = $derived(change?.previousFinding != null && change.previousFinding !== row.finding);
</script>

{#if !changes}
  <p class="meta row-change">Нет данных для сравнения с первоначальным разбором</p>
{:else if changes.baselineId === null}
  <p class="meta row-change">Первоначальный разбор</p>
{:else if !change}
  <p class="meta row-change">Нет данных для сравнения по позиции</p>
{:else if !change.changed}
  <p class="meta row-change">С первоначального разбора без изменений</p>
{:else if compact}
  <p class="meta row-change">
    <strong>{status}</strong>
    {#if findingChanged} · Вывод изменился{/if}
    {#if change.addedSources.length} · Добавлено оснований {change.addedSources.length}{/if}
    {#if change.removedSources.length} · Исключено оснований {change.removedSources.length}{/if}
  </p>
{:else}
  <div class="changes">
    <h4>Что изменилось после первоначального разбора</h4>
    {#if changes.baselineAt}<p class="meta">Первоначальный разбор от {date(changes.baselineAt)}</p>{/if}
    <p>{status}</p>
    {#if findingChanged}
      <dl class="findings">
        <dt>Первоначальный вывод</dt><dd>{change.previousFinding}</dd>
        <dt>Вывод в этой редакции</dt><dd>{row.finding}</dd>
      </dl>
    {/if}
    {#if change.addedSources.length}
      <h4>Добавленные основания</h4>
      <PreliminarySources sources={change.addedSources} label="Добавленные основания" />
    {/if}
    {#if change.removedSources.length}
      <h4>Основания, исключённые из нового вывода</h4>
      <PreliminarySources sources={change.removedSources} label="Исключённые основания" />
    {/if}
  </div>
{/if}

<style>
  .row-change { margin: .35rem 0 0; overflow-wrap: anywhere; }
  .changes { border-block-start: 1px solid var(--line); margin-block-start: .7rem; padding-block-start: .6rem; overflow-wrap: anywhere; }
  .changes h4 { margin: .5rem 0 .25rem; }
  .changes p { margin: .35rem 0; }
  .findings { margin: .45rem 0; }
  .findings dt { font-weight: 620; }
  .findings dd { margin: 0 0 .45rem; white-space: pre-wrap; }
</style>
