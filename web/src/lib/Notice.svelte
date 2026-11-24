<script lang="ts">
  let { message, kind = 'info' }: { message: string; kind?: 'info' | 'error' | 'success' } = $props();
</script>

{#if message}
  <p class="notice {kind}" role={kind === 'error' ? 'alert' : 'status'}>{message}</p>
{/if}
