<script lang="ts" module>
  import { valueRoles, type ValueRole } from './ComparisonFields.svelte';
  type Representation = 'native' | 'ocr' | 'render';
  type EvidenceOption = {
    sourceRole: string; valueRole?: ValueRole; mode?: 'value' | 'presence'; formats?: string[]; subject?: string; representations?: Representation[];
  };
  export type EvidenceRule = { allOf: { anyOf: EvidenceOption[] }[]; distinctOriginals?: boolean };

  export function copyEvidenceRule(rule: EvidenceRule): EvidenceRule {
    return { ...rule, allOf: rule.allOf.map(({ anyOf }) => ({
      anyOf: anyOf.map((option) => ({
        ...option, representations: option.representations?.slice(), formats: option.formats?.slice(),
      })),
    })) };
  }
</script>

<script lang="ts">
  let { rule = $bindable(), roles, formats }: { rule?: EvidenceRule; roles: string[]; formats: string[] } = $props();
  const representations: { code: Representation; label: string }[] = [
    { code: 'native', label: 'Текст оригинала' }, { code: 'ocr', label: 'OCR' }, { code: 'render', label: 'Изображение' },
  ];
  const option = () => ({ sourceRole: roles[0] ?? '' });
  const group = () => ({ anyOf: [option()] });

  function setRepresentation(item: EvidenceOption, code: Representation, checked: boolean) {
    const previous = item.representations ?? [];
    const next = checked ? [...previous, code] : previous.filter((entry) => entry !== code);
    item.representations = next.length ? next : undefined;
  }
</script>

{#if rule}
  <fieldset>
    <legend>Доказательства для автоматической проверки</legend>
    <p>Для каждой группы требуется один из указанных вариантов.</p>
    {#each rule.allOf as requiredGroup, groupIndex}
      <fieldset>
        <legend>Группа {groupIndex + 1}</legend>
        {#each requiredGroup.anyOf as item, optionIndex}
          <fieldset>
            <legend>Вариант {optionIndex + 1}</legend>
            <label>Роль источника
              <select bind:value={item.sourceRole} required>
                <option value="">Выберите роль</option>
                {#each roles as role}<option value={role}>{role}</option>{/each}
              </select>
            </label>
            <label>Что проверять
              <select bind:value={item.mode} onchange={(event) => { if (event.currentTarget.value === 'presence') item.valueRole = undefined; }}>
                <option value={undefined}>Значение по умолчанию</option>
                <option value="value">Значение</option>
                <option value="presence">Наличие</option>
              </select>
            </label>
            {#if item.mode !== 'presence'}
              <label>Роль значения в доказательстве
                <select bind:value={item.valueRole}>
                  <option value={undefined}>Любая роль</option>
                  {#each Object.entries(valueRoles) as [key, label]}<option value={key}>{label}</option>{/each}
                </select>
              </label>
            {/if}
            <label>Форматы варианта через запятую
              <input value={item.formats?.join(', ') ?? ''} placeholder={formats.join(', ')}
                onchange={(event) => {
                  const selected = event.currentTarget.value.split(',').map((format) => format.trim()).filter(Boolean);
                  item.formats = selected.length ? selected : undefined;
                }} />
            </label>
            <label>Предмет в источнике
              <input maxlength="200" value={item.subject ?? ''}
                onchange={(event) => item.subject = event.currentTarget.value.trim() || undefined} />
            </label>
            <div class="actions">
              {#each representations as { code, label }}
                <label><input type="checkbox" checked={item.representations?.includes(code) ?? false}
                  onchange={(event) => setRepresentation(item, code, event.currentTarget.checked)} /> {label}</label>
              {/each}
            </div>
            {#if requiredGroup.anyOf.length > 1}
              <button type="button" class="quiet"
                onclick={() => requiredGroup.anyOf = requiredGroup.anyOf.filter((_, index) => index !== optionIndex)}>
                Удалить вариант
              </button>
            {/if}
          </fieldset>
        {/each}
        <div class="actions">
          <button type="button" disabled={requiredGroup.anyOf.length >= 16} onclick={() => requiredGroup.anyOf.push(option())}>
            Добавить вариант
          </button>
          {#if rule.allOf.length > 1}
            <button type="button" class="quiet" onclick={() => {
              if (rule) rule.allOf = rule.allOf.filter((_, index) => index !== groupIndex);
            }}>Удалить группу</button>
          {/if}
        </div>
      </fieldset>
    {/each}
    <label><input type="checkbox" bind:checked={rule.distinctOriginals} /> Каждая группа требует отдельного оригинала</label>
    <div class="actions">
      <button type="button" disabled={rule.allOf.length >= 16} onclick={() => rule?.allOf.push(group())}>Добавить группу</button>
      <button type="button" class="quiet" onclick={() => rule = undefined}>Убрать правило</button>
    </div>
  </fieldset>
{:else}
  <button type="button" onclick={() => rule = { allOf: [group()] }}>Задать правило доказательств</button>
{/if}
