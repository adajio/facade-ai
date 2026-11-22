<script lang="ts">
  import { type Citation, type OpenEvidence } from './workspace';
  let { citations = [], open }: { citations?: Citation[]; open: OpenEvidence } = $props();
</script>

{#if citations.length}
  <div class="actions">
    {#each citations as citation, index (`${citation.evidenceId}:${index}`)}
      <button type="button" onclick={(event) => open(citations, index, event.currentTarget)}>
        {citation.branch ? 'Основание ' + citation.branch : 'Основание ' + (index + 1)}
        {#if citation.value != null} · {citation.value} {citation.unit ?? ''}{/if}
      </button>
    {/each}
  </div>
{/if}
