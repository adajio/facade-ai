<script lang="ts" module>
  export const valueRoles = {
    design: 'Проектное значение', as_built: 'Фактическое значение', limit: 'Предельное значение',
  };
  export type ValueRole = keyof typeof valueRoles;
  export type Comparison = { sources: { sourceRole: string; valueRole: ValueRole; priority: number }[] };
</script>
<script lang="ts">
  let { comparison = $bindable(), roles }: { comparison?: Comparison; roles: string[] } = $props();
  const values = Object.entries(valueRoles) as [ValueRole, string][];
  const source = (): Comparison['sources'][number] => ({ sourceRole: roles[0] ?? '', valueRole: 'design', priority: 0 });
</script>

{#if comparison}
  <fieldset>
    <legend>Правила сопоставления источников</legend>
    {#each comparison.sources as rule, index}
      <div class="form-row">
        <label>Роль сравниваемого источника
          <select bind:value={rule.sourceRole} required>
            <option value="">Выберите роль</option>
            {#each roles as role}<option value={role}>{role}</option>{/each}
          </select>
        </label>
        <label>Роль сравниваемого значения
          <select bind:value={rule.valueRole}>
            {#each values as [key, label]}<option value={key}>{label}</option>{/each}
          </select>
        </label>
        <label>Приоритет<input type="number" required min="0" max="100" step="1" bind:value={rule.priority} /></label>
        {#if comparison.sources.length > 1}
          <button type="button" class="quiet" onclick={() => {
            if (comparison) comparison.sources = comparison.sources.filter((_, at) => at !== index);
          }}>Удалить источник</button>
        {/if}
      </div>
    {/each}
    <div class="actions">
      <button type="button" disabled={comparison.sources.length >= 16 || !roles.length}
        onclick={() => comparison?.sources.push(source())}>Добавить источник сравнения</button>
      <button type="button" class="quiet" onclick={() => comparison = undefined}>Убрать правила сравнения</button>
    </div>
  </fieldset>
{:else}
  <button type="button" disabled={!roles.length} onclick={() => comparison = { sources: [source()] }}>Задать правила сравнения</button>
{/if}
