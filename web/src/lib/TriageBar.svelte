<script lang="ts">
  import { triageOptions, type Triage } from './triage';
  let { value, counts, choose, letterUrl }: {
    value: Triage; counts: Record<Triage, number>; choose: (value: Triage) => void; letterUrl: string;
  } = $props();
  const labels = { review: 'Требует проверки', letter: 'Для письма клиенту', done: 'Готово / Покрыто' };
  const name = $props.id();
</script>

<div class="triage-actions">
  <fieldset aria-label="Состояние позиций">
    {#each triageOptions as item (item)}
      <label class:active={item === value}>
        <input type="radio" {name} value={item} checked={item === value} onchange={() => choose(item)} />
        {labels[item]} <strong>{counts[item]}</strong>
      </label>
    {/each}
  </fieldset>
  {#if value === 'letter'}<a class="button" href={letterUrl}>Перейти к письму</a>{/if}
</div>

<style>
  .triage-actions, fieldset { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }
  .triage-actions { justify-content: space-between; margin-block: 12px; }
  fieldset { padding: 0; border: 0; }
  label { min-height: 40px; padding: 8px 12px; border: 1px solid var(--line); border-radius: 6px; cursor: pointer; }
  label.active { background: #e5f2ef; border-color: var(--accent); color: var(--accent-text); }
  strong { font-variant-numeric: tabular-nums; }
</style>
