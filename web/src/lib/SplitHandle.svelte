<script lang="ts">
  let { value, change, drawer = false }: { value: number; change: (value: number) => void; drawer?: boolean } = $props();
  let drag: { left: number; width: number; pointerId: number } | undefined;

  function start(event: PointerEvent) {
    if (event.button !== 0 || !event.isPrimary) return;
    const handle = event.currentTarget as HTMLElement;
    const bounds = drawer ? { left: 0, width: window.innerWidth - 12 } : handle.parentElement?.getBoundingClientRect();
    if (!bounds?.width) return;
    drag = { left: bounds.left, width: bounds.width, pointerId: event.pointerId };
    handle.setPointerCapture(event.pointerId);
  }

  function move(event: PointerEvent) {
    if (drag?.pointerId === event.pointerId) {
      change(Math.round(100 * (drag.left + drag.width - event.clientX) / drag.width));
    }
  }

  function keyboard(event: KeyboardEvent) {
    if (event.key === 'Home') change(35);
    else if (event.key === 'End') change(68);
    else if (event.key === 'ArrowLeft') change(value + 5);
    else if (event.key === 'ArrowRight') change(value - 5);
    else return;
    event.preventDefault();
  }
</script>

<!-- svelte-ignore a11y_no_noninteractive_tabindex, a11y_no_noninteractive_element_interactions (Focusable adjustable separator.) -->
<div class="handle" class:drawer role="separator" tabindex="0" aria-label="Ширина просмотрщика"
  aria-controls="workspace-evidence" aria-orientation="vertical" aria-valuemin={35} aria-valuemax={68} aria-valuenow={value} aria-valuetext={value + '%'}
  onkeydown={keyboard} onpointerdown={start} onpointermove={move} onlostpointercapture={() => drag = undefined}
  ondblclick={() => change(50)}></div>

<style>
  .handle { cursor: col-resize; touch-action: none; position: relative; }
  .handle::before { content: ''; position: absolute; inset: 0 2px; background: var(--line); }
  .handle:hover::before, .handle:focus-visible::before { background: var(--accent); }
  @media (max-width: 1140px) {
    .handle:not(.drawer) { display: none; }
    .handle.drawer { position: absolute; inset: 0 auto 0 -6px; width: 6px; }
  }
</style>
