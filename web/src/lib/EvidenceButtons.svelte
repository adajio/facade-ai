<script lang="ts">
  import { type Citation, type EvidenceActions, type OpenEvidence } from './workspace';
  let { citations = [], open, compare = false, actions }: {
    citations?: Citation[]; open: OpenEvidence; compare?: boolean; actions?: EvidenceActions;
  } = $props();
  let pair = $derived(citations.length === 2 && citations[0].evidenceId !== citations[1].evidenceId ? citations : []);
</script>

{#if citations.length}
  <div class="actions">
    {#if compare && pair.length}
      <button type="button" onclick={(event) => open(pair, 0, event.currentTarget, { actions })}>Сравнить два источника</button>
    {/if}
    {#each citations as citation, index (`${citation.evidenceId}:${index}`)}
      <button type="button" onclick={(event) => open(citations, index, event.currentTarget)}>
        {citation.sourceLabel ?? (citation.branch ? 'Основание ' + citation.branch : 'Основание ' + (index + 1))}
        {#if citation.value != null} · {citation.value} {citation.unit ?? ''}{/if}
      </button>
    {/each}
  </div>
{/if}
