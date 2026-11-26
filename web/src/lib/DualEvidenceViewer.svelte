<script lang="ts">
  import { tick } from 'svelte';
  import type { Api } from './http';
  import type { Citation, EvidenceActions } from './workspace';
  import EvidenceViewer from './EvidenceViewer.svelte';

  let { api, projectId, refs, close, verify, openLine, actions }: {
    api: Api; projectId: string; refs: Citation[]; close: () => void;
    verify: () => void; openLine: (ref: Citation, trigger: HTMLElement) => void; actions?: EvidenceActions;
  } = $props();
  let full = $state(false);
  let sideBySide = $state(false);
  let closeButton: HTMLButtonElement;
  let panel: HTMLElement;
  const title = $props.id();
  const labels = ['Первый источник', 'Второй источник'];
  const roles: Record<string, string> = { drawing: 'Чертёж', schedule: 'Ведомость', inventory: 'Опись' };
  const format = new Intl.NumberFormat('ru', { maximumFractionDigits: 3, signDisplay: 'exceptZero' });
  const percentFormat = new Intl.NumberFormat('ru', { maximumFractionDigits: 1, style: 'percent', signDisplay: 'exceptZero' });
  const numberFormat = /^[-+]?\d+(?:[.,]\d+)?$/u;
  let components = $state<(number | undefined)[]>([]);
  let delta = $derived.by(() => {
    const [first, second] = refs;
    const unit = first?.unit?.trim();
    if (!unit || unit !== second?.unit?.trim() || !first.value || !second.value ||
        !numberFormat.test(first.value.trim()) || !numberFormat.test(second.value.trim())) return;
    const left = Number(first.value.replace(',', '.'));
    const right = Number(second.value.replace(',', '.'));
    return { value: right - left, percent: left ? (right - left) / Math.abs(left) : undefined, unit };
  });

  function address(ref: Citation) {
    const locator = ref.address?.locator as Record<string, unknown> | undefined;
    const page = locator?.page ?? ref.address?.page;
    if (typeof page === 'number') return 'с. ' + page;
    if (typeof locator?.sheet === 'string' && typeof locator?.cell === 'string') return locator.sheet + '!' + locator.cell;
    return undefined;
  }

  $effect(() => { void tick().then(() => closeButton?.focus({ preventScroll: true })); });

  function keyboard(event: KeyboardEvent) {
    if (event.defaultPrevented) return;
    if (event.key === 'Escape') {
      event.preventDefault();
      if (full && !matchMedia('(max-width: 850px)').matches) { full = false; sideBySide = false; }
      else close();
    } else if (event.key === 'Tab' && (full || matchMedia('(max-width: 850px)').matches)) {
      const controls = Array.from(panel.querySelectorAll<HTMLElement>('button:not([disabled]), a[href], [tabindex="0"]'));
      const first = controls[0], last = controls.at(-1);
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
      if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
    }
  }

  function decide(action: () => void) {
    close();
    void tick().then(action);
  }
</script>

<svelte:window onkeydown={keyboard} />
<section class:full bind:this={panel} class="comparison" aria-labelledby={title}>
  <header>
    <div class="card-header">
      <h2 id={title}>Сравнение источников</h2>
      <div class="actions">
        {#if full}<button class="quiet layout-control" type="button" aria-pressed={sideBySide} onclick={() => sideBySide = !sideBySide}>Рядом</button>{/if}
        <button class="quiet layout-control" type="button" onclick={() => { full = !full; if (!full) sideBySide = false; }}>
          {full ? 'Выйти из полного экрана' : 'На весь экран'}
        </button>
        <button class="quiet" type="button" bind:this={closeButton} onclick={close} aria-label="Закрыть сравнение источников">Закрыть</button>
      </div>
    </div>
    <div class="values">
      {#each refs as ref, i (ref.evidenceId)}
        <div><strong class="numeric">{ref.value ?? '—'} {ref.unit ?? ''}</strong>
          <small>{[ref.label ?? ref.sourceLabel ?? labels[i], address(ref), ref.sourceRole && roles[ref.sourceRole],
            ref.documentRevision?.label].filter(Boolean).join(' · ')}</small>
        </div>
      {/each}
      {#if delta}
        <div><strong class="numeric">Δ {format.format(delta.value)} {delta.unit}{delta.percent === undefined ? '' : ' (' + percentFormat.format(delta.percent) + ')'}</strong>
          <small>Единицы совпадают</small></div>
      {:else}
        <small>Дельта недоступна по исходным значениям и единицам</small>
      {/if}
    </div>
  </header>
  <div class="slots" class:sideBySide>
    {#each refs as ref, index (ref.evidenceId)}
      <EvidenceViewer {api} {projectId} refs={[ref]} index={0} componentIndex={components[index]}
        select={() => {}} selectComponent={(value) => components[index] = value}
        {close} {verify} {openLine} embedded slotLabel={labels[index]} />
    {/each}
  </div>
  {#if actions?.confirm || actions?.dismiss}
    <footer class="actions">
      {#if actions.confirm}<button class="primary" type="button" onclick={() => decide(actions!.confirm!)}>Подтвердить конфликт для письма</button>{/if}
      {#if actions.dismiss}<button type="button" onclick={() => decide(actions!.dismiss!)}>Снять конфликт · указать причину</button>{/if}
    </footer>
  {/if}
</section>

<style>
  .comparison { display: flex; flex-direction: column; gap: 8px; max-height: calc(100dvh - 76px); padding: 12px;
    border: 1px solid var(--line); border-radius: 8px; background: var(--surface); }
  header, footer { flex: none; }
  .values { display: flex; flex-wrap: wrap; gap: 8px 20px; padding: 8px 0; border-block: 1px solid var(--line); }
  .values div { display: grid; }
  .values small { color: var(--muted); overflow-wrap: anywhere; }
  .slots { display: grid; grid-template-columns: minmax(0, 1fr); grid-auto-rows: max-content; gap: 8px; overflow: auto; padding: 4px; }
  .sideBySide { grid-template-columns: repeat(2, minmax(0, 1fr)); align-items: start; }
  .full { position: fixed; inset: 12px; z-index: 10; max-height: none; box-shadow: 0 0 0 100vmax #172b3582; }
  @media (min-width: 851px) and (max-width: 1140px) { .comparison:not(.full) { max-height: 60dvh; } }
  @media (max-width: 850px) {
    .comparison { position: fixed; inset: 0; z-index: 10; max-height: none; border-radius: 0; }
    .layout-control { display: none; }
    .sideBySide { grid-template-columns: minmax(0, 1fr); }
  }
</style>
