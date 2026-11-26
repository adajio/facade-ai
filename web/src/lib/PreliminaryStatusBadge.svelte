<script lang="ts">
  import { count as formatCount } from './format';
  import { preliminaryStatusLabels, type PreliminaryStatus } from './preliminary-review';

  let { status, count }: { status: PreliminaryStatus; count?: number } = $props();
</script>

<span class="status-badge" class:present={status === 'present'} class:partial={status === 'partial'}
  class:not-found={status === 'not_found'} class:unassessed={status === 'unassessed'}>
  {preliminaryStatusLabels[status]}{#if count !== undefined}: {formatCount(count)}{/if}
</span>

<style>
  .status-badge { display: inline-block; padding: .16rem .53rem; border: 1px solid transparent; border-radius: .3rem; font-size: .85rem; font-weight: 620; }
  .present { background: #e4f2ec; color: #235b47; }
  .partial { background: #fff3bf; color: #654500; }
  .not-found { background: #f9e5e1; color: #8a3028; }
  .unassessed { background: #eaf1f2; color: #34525c; }
  @media (forced-colors: active) {
    .status-badge { color: CanvasText; background: Canvas; border-color: CanvasText; }
  }
</style>
