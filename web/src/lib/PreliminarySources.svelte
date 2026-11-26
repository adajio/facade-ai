<script lang="ts">
  import { preliminarySourcePlace, preliminarySourceUrl, type PreliminarySource } from './preliminary-review';

  let { sources, label }: { sources: PreliminarySource[]; label?: string } = $props();
</script>

<ul aria-label={label}>
  {#each sources as source}
    <li>
      <a href={preliminarySourceUrl(source)} target="_blank" rel="noopener noreferrer">{source.label}</a>
      · {preliminarySourcePlace(source).label}
      {#if source.quote?.trim()}<blockquote>{source.quote}</blockquote>{/if}
      {#if source.limitation?.trim()}<p class="meta"><strong>Ограничение</strong> · {source.limitation}</p>{/if}
    </li>
  {/each}
</ul>

<style>
  ul { margin-block: .35rem; padding-inline-start: 1.25rem; overflow-wrap: anywhere; }
  li + li { margin-block-start: .35rem; }
  p { margin: .2rem 0; }
</style>
