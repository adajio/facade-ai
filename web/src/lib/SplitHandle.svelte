<script lang="ts">
  let { value, change, drawer = false, stacked = false }: { value: number; change: (value: number) => void; drawer?: boolean; stacked?: boolean } = $props();
  let drag: { start: number; value: number; size: number; pointerId: number } | undefined;

  function start(event: PointerEvent) {
    if (event.button !== 0 || !event.isPrimary) return;
    const handle = event.currentTarget as HTMLElement;
    const container = drawer ? handle.parentElement?.parentElement : handle.parentElement;
    const bounds = container?.getBoundingClientRect();
    if (!bounds) return;
    const size = stacked ? bounds.height - handle.offsetHeight : bounds.width - (drawer ? 0 : handle.offsetWidth);
    if (size <= 0) return;
    drag = { start: stacked ? event.clientY : event.clientX, value, size, pointerId: event.pointerId };
    handle.setPointerCapture(event.pointerId);
  }

  function move(event: PointerEvent) {
    if (drag?.pointerId === event.pointerId) {
      const position = stacked ? event.clientY : event.clientX;
      change(Math.round(drag.value + 100 * (drag.start - position) / drag.size));
    }
  }

  function keyboard(event: KeyboardEvent) {
    if (event.key === 'Home') change(35);
    else if (event.key === 'End') change(68);
    else if (event.key === (stacked ? 'ArrowUp' : 'ArrowLeft') || event.key === ']') change(value + 5);
    else if (event.key === (stacked ? 'ArrowDown' : 'ArrowRight') || event.key === '[') change(value - 5);
    else return;
    event.preventDefault();
  }
</script>

<!-- svelte-ignore a11y_no_noninteractive_tabindex, a11y_no_noninteractive_element_interactions (Focusable adjustable separator.) -->
<div class="handle" class:drawer class:stacked role="separator" tabindex="0" aria-label={stacked ? 'Высота просмотрщика' : 'Ширина просмотрщика'}
  aria-controls="workspace-evidence" aria-orientation={stacked ? 'horizontal' : 'vertical'} aria-valuemin={35} aria-valuemax={68} aria-valuenow={value} aria-valuetext={value + '%'}
  onkeydown={keyboard} onpointerdown={start} onpointermove={move} onlostpointercapture={() => drag = undefined}
  ondblclick={() => change(50)}></div>

<style>
  .handle { cursor: col-resize; touch-action: none; position: relative; }
  .handle::before { content: ''; position: absolute; inset: 0; width: var(--split-rule); margin-inline: auto; background: var(--line); }
  .handle:hover::before, .handle:focus-visible::before { background: var(--accent); }
  @media (max-width: 1140px) {
    .handle:not(.drawer, .stacked) { display: none; }
    .handle.stacked { cursor: row-resize; }
    .handle.stacked::before { width: auto; height: var(--split-rule); margin: auto 0; }
    .handle.drawer { position: absolute; inset: 0 auto 0 calc(-1 * var(--split-target)); width: var(--split-target); }
  }
</style>
