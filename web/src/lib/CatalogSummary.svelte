<script lang="ts">
  import type { Catalog } from './contracts';
  let { catalog }: { catalog: Catalog } = $props();
  type Rule = { key: string; part: string; formats?: string[]; equivalents?: string[]; completenessCriterion?: string };
  let rules: Rule[] = $derived(Array.isArray(catalog.requirements) ? catalog.requirements : []);
</script>

<details>
  <summary>Требования каталога «{catalog.name}» · версия {catalog.revision} · {rules.length}</summary>
  {#if catalog.approvalReference || catalog.defaultProfile?.approvalReference}
    <p>Основание утверждения · {catalog.approvalReference ?? catalog.defaultProfile?.approvalReference}</p>
  {/if}
  <ol>{#each rules as rule}
    <li><strong>{rule.part ?? rule.key}</strong>
      {#if rule.formats?.length} · {rule.formats.join(', ')}{/if}
      {#if rule.equivalents?.length} · Допустимая замена: {rule.equivalents.join(', ')}{/if}
      {#if rule.completenessCriterion}<p>{rule.completenessCriterion}</p>{/if}
    </li>
  {/each}</ol>
</details>
