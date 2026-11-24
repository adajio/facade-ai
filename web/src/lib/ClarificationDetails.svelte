<script lang="ts">
  import { originalUrl } from './copilot';
  import type { ClarificationBasis } from './workspace';
  let { basis }: { basis: ClarificationBasis } = $props();
</script>

<details>
  <summary>Проверенные описи и места</summary>
  <ul class="plain-list">
    {#each basis.inventories as inventory (inventory.receiptId)}
      <li>Опись №{inventory.number} · версия <span class="numeric">{inventory.revision}</span></li>
    {/each}
  </ul>
  {#if basis.alternatives.length}
    <p>Учтённые формы и варианты · {basis.alternatives.join(', ')}</p>
  {/if}
  <ul class="plain-list">
    {#each basis.places as place}
      {@const page = /^[1-9][0-9]{0,6}$/u.test(place.address.unitId) ? Number(place.address.unitId) : undefined}
      <li><a href={originalUrl(place.documentId, place.versionId, page)} target="_blank" rel="noopener">
        {place.label} · {page ? 'с. ' + page : place.address.unitId}
      </a>
        {#if place.address.box}
          <span class="meta"> · область {[place.address.box.x, place.address.box.y, place.address.box.width, place.address.box.height]
            .map((number) => number.toFixed(1)).join(', ')} пт</span>
        {/if}
      </li>
    {/each}
  </ul>
</details>
