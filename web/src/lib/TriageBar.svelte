<script lang="ts">
  import { evidenceFilters, triageOptions, type EvidenceFilter, type Triage } from './triage';
  let { value, counts, checked, evidence, choose, letterUrl }: {
    value: Triage; counts: Record<'review' | 'letter' | 'done', number>; checked: number; evidence?: Record<EvidenceFilter, number>; choose: (value: Triage) => void; letterUrl: string;
  } = $props();
  const labels = { all: 'Все требования', checked: 'Проверено', review: 'Требуют проверки', letter: 'Для письма', done: 'Готово', ...evidenceFilters };
  let totals = $derived({ ...counts, all: counts.review + counts.letter + counts.done, checked, ...evidence });
  const options = $derived<Triage[]>(evidence
    ? ['all', 'checked', 'proven', 'partial', 'remainder', ...triageOptions]
    : ['all', 'checked', ...triageOptions]);
  const name = $props.id();
</script>

<div class="triage-actions">
  <fieldset aria-label="Состояние позиций">
    {#each options as item (item)}
      <label class:active={item === value}>
        <input type="radio" {name} value={item} checked={item === value} onchange={() => choose(item)} />
        {labels[item]} <strong>{totals[item]}</strong>
      </label>
    {/each}
  </fieldset>
  {#if value === 'letter'}<a class="button" href={letterUrl}>Открыть основания для письма</a>{/if}
</div>

<style>
  .triage-actions, fieldset { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }
  .triage-actions { justify-content: space-between; margin-block: 12px; }
  fieldset { padding: 0; border: 0; }
  label { min-height: 40px; padding: 8px 12px; border: 1px solid var(--line); border-radius: 6px; cursor: pointer; }
  label.active { background: #e5f2ef; border-color: var(--accent); color: var(--accent-text); }
  strong { font-variant-numeric: tabular-nums; }
</style>
