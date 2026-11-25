<script lang="ts">
  import type { FacadeObservation, FactEquivalentsPage } from './facade-assessment';
  import { renderAddress } from './copilot';
  import { describe, interrupted } from './http';
  import Notice from './Notice.svelte';

  let { item, canMerge, contextId, loadEquivalents, otherVariants, busy, version, submit }: {
    item: FacadeObservation; canMerge: boolean; contextId: string | null; otherVariants: string[]; busy: boolean; version: number;
    loadEquivalents: (observationId: string, version: number, contextId: string | null, after: string | null, signal: AbortSignal) => Promise<FactEquivalentsPage>;
    submit: (observationId: string, body: Record<string, unknown>, expectedVersion: number) => Promise<boolean>;
  } = $props();
  let action = $state('');
  let reason = $state('');
  let variant = $state('');
  let value = $state('');
  let unit = $state('');
  let memberIds = $state<string[]>([]);
  let startingVersion = $state<number>();
  let alternatives = $state<FactEquivalentsPage['items']>([]);
  let next = $state<string | null>(null);
  let loading = $state(false);
  let lookupProblem = $state('');
  let lookup = $state<AbortController>();

  $effect(() => {
    const current = version;
    const area = contextId;
    const observationId = item.id;
    if (action !== 'merge' || !canMerge || startingVersion !== current) return;
    const stop = new AbortController();
    lookup = stop;
    alternatives = [];
    memberIds = [];
    next = null;
    void load(observationId, current, area, null, stop.signal);
    return () => stop.abort();
  });

  async function load(observationId: string, expectedVersion: number, area: string | null, after: string | null, signal: AbortSignal) {
    loading = true;
    lookupProblem = '';
    try {
      const page = await loadEquivalents(observationId, expectedVersion, area, after, signal);
      if (signal.aborted) return;
      if (page.version !== expectedVersion) {
        lookupProblem = 'Версия сведений изменилась. Обновите оценку.';
        return;
      }
      alternatives = after ? [...alternatives, ...page.items] : page.items;
      next = page.nextCursor;
    } catch (error) {
      if (!signal.aborted && !interrupted(error)) lookupProblem = describe(error);
    } finally {
      if (!signal.aborted) loading = false;
    }
  }

  function choose() {
    startingVersion ??= version;
    if (action === 'correct') {
      value = item.engineeringReview?.decision.action === 'correct' ? item.engineeringReview?.decision.value ?? '' : item.value ?? '';
      unit = item.engineeringReview?.decision.action === 'correct' ? item.engineeringReview?.decision.unit ?? '' : item.unit ?? '';
    }
    if (action === 'select_variant') variant = '';
    if (action === 'merge') memberIds = [];
  }

  async function save(event: SubmitEvent) {
    event.preventDefault();
    const applied = await submit(item.id, { action, reason,
      ...(action === 'correct' ? { value, unit } : {}),
      ...(action === 'select_variant' ? { variant } : {}),
      ...(action === 'merge' ? { memberIds } : {}),
    }, startingVersion ?? version);
    if (applied) {
      startingVersion = undefined;
      action = '';
      reason = '';
      memberIds = [];
    }
  }
</script>

<details>
  <summary>Решение по сведению</summary>
  <form onsubmit={save}>
    <label>Действие
      <select bind:value={action} onchange={choose} required>
        <option value="">Выберите действие</option>
        {#if item.value !== null || item.quote}<option value="confirm">{item.value !== null ? 'Подтвердить значение' : 'Подтвердить запись'}</option>{/if}
        {#if otherVariants.length}<option value="select_variant">Выбрать вариант</option>{/if}
        <option value="correct">Исправить число или единицу</option>
        <option value="exclude">Исключить ложную находку</option>
        {#if canMerge}<option value="merge">Объединить эквивалентные записи</option>{/if}
      </select>
    </label>
    {#if action === 'select_variant'}
      <label>Вариант<select bind:value={variant} required>
        <option value="">Выберите вариант</option>
        {#each otherVariants as option}<option value={option}>{option}</option>{/each}
      </select></label>
    {:else if action === 'correct'}
      <div class="form-row">
        <label>Исправленное число<input bind:value inputmode="decimal" required maxlength="100" /></label>
        <label>Единица<input bind:value={unit} maxlength="100" /></label>
      </div>
    {:else if action === 'merge'}
      <fieldset disabled={startingVersion !== version}>
        <legend>Эквивалентные записи в области сведения</legend>
        <Notice kind="error" message={lookupProblem} />
        {#if loading && !alternatives.length}<p role="status">Ищем эквивалентные записи…</p>{/if}
        {#if !loading && !lookupProblem && !alternatives.length}<p>Эквивалентных записей пока нет.</p>{/if}
        {#each alternatives as candidate (candidate.id)}
          <label><input type="checkbox" bind:group={memberIds} value={candidate.id} />
            {candidate.label ? candidate.label + ' · ' : ''}{renderAddress(candidate.address)} · ветвь {candidate.branch}
            · редакция {candidate.revision ?? 'уточняется'} · {candidate.quote ?? candidate.attribute}</label>
        {/each}
        {#if next && lookup}<button type="button" disabled={loading}
          onclick={() => load(item.id, version, contextId, next, lookup!.signal)}>Ещё эквивалентные записи</button>{/if}
      </fieldset>
    {/if}
    <label>Основание решения<textarea bind:value={reason} oninput={() => startingVersion ??= version} maxlength="2000" required></textarea></label>
    {#if startingVersion !== undefined && startingVersion !== version}
      <p class="notice">Доступна версия {version}. Введённое основание сохранено.</p>
      <button type="button" onclick={() => { startingVersion = version; memberIds = []; }}>Использовать текущую версию</button>
    {/if}
    <button class="primary" disabled={busy || !action || action === 'merge' && !memberIds.length ||
      startingVersion !== undefined && startingVersion !== version}>Сохранить решение по сведению</button>
  </form>
</details>
