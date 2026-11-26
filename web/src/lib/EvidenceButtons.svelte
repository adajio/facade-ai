<script lang="ts">
  import { approvalEvidence, type Citation, type EvidenceActions, type OpenEvidence } from './workspace';
  let { citations = [], open, compare = false, actions }: {
    citations?: Citation[]; open: OpenEvidence; compare?: boolean; actions?: EvidenceActions;
  } = $props();
  let chosen = $state<string[]>([]);
  let approvals = $derived(citations.flatMap((citation) => approvalEvidence(citation) ?? []));
  // Independent readings may cite the same place. Keep both visible in the list
  // while offering a comparison between distinct places in the originals.
  let places = $derived.by(() => {
    const byPlace = new Map<string, Citation>();
    for (const citation of citations) {
      const key = citation.versionId && citation.address
        ? JSON.stringify([citation.versionId, citation.address, citation.value, citation.unit]) : citation.evidenceId;
      if (!byPlace.has(key)) byPlace.set(key, citation);
    }
    return [...byPlace.values()];
  });
  let pair = $derived(places.length === 2 ? places : places.filter(item => chosen.includes(item.evidenceId)));
</script>

{#if citations.length}
  <div class="actions">
    {#if compare && places.length > 2}
      <fieldset><legend>Выберите два места для сравнения</legend>
        {#each places as place (place.evidenceId)}
          <label><input type="checkbox" value={place.evidenceId} bind:group={chosen}
            disabled={pair.length >= 2 && !chosen.includes(place.evidenceId)} />
            {place.sourceLabel ?? place.label ?? 'Основание'} · {place.value} {place.unit}
          </label>
        {/each}
      </fieldset>
    {/if}
    {#if compare && pair.length === 2}
      <button type="button" onclick={(event) => open(pair, 0, event.currentTarget, { actions })}>Сравнить два источника</button>
    {/if}
    {#each citations as citation, index (`${citation.evidenceId}:${index}`)}
      <button type="button" onclick={(event) => open(citations, index, event.currentTarget)}>
        {citation.sourceLabel ?? (citation.branch ? 'Основание ' + citation.branch : 'Основание ' + (index + 1))}
        {#if citation.value != null} · {citation.value} {citation.unit ?? ''}{/if}
      </button>
    {/each}
    {#each approvals as approval, index (`${approval.evidenceId}:${approval.lineId}:${index}`)}
      <button type="button" onclick={(event) => open(approvals, index, event.currentTarget)}>
        Подпись · {approval.branch ? 'ветвь ' + approval.branch : 'источник ' + (index + 1)}
      </button>
    {/each}
  </div>
{/if}
