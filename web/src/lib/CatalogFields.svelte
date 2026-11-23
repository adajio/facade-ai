<script lang="ts" module>
  export type Requirement = {
    key: string; part: string; formats: string[]; equivalents: string[];
    applicability: string; level?: 'facade' | 'common';
    sourceRoles: string[]; completenessCriterion: string; addressee: string;
  };
  export function blank(): Requirement {
    return { key: '', part: '', formats: [], equivalents: [], applicability: 'all', sourceRoles: [], completenessCriterion: '', addressee: '' };
  }
  export function copy(source: Requirement[]): Requirement[] {
    return source.map((item) => ({ ...item, formats: [...item.formats], equivalents: [...item.equivalents], sourceRoles: [...item.sourceRoles] }));
  }
</script>
<script lang="ts">
  let { requirements = $bindable([]) }: { requirements: Requirement[] } = $props();
  const parse = (value: string) => value.split(',').map((part) => part.trim()).filter(Boolean);
</script>

{#each requirements as requirement, index}
  <fieldset>
    <legend>Обязательная часть {index + 1}</legend>
    <div class="form-row">
      <label>Код части<input required bind:value={requirement.key} /></label>
      <label>Наименование<input required bind:value={requirement.part} /></label>
      <label>Область действия<input required bind:value={requirement.applicability} /></label>
    </div>
    <label>Уровень требования
      <select bind:value={requirement.level}>
        <option value={undefined}>По правилу области</option>
        <option value="facade">Для каждого фасада</option>
        <option value="common">Для проекта в целом</option>
      </select>
    </label>
    <div class="form-row">
      <label>Форматы<input required value={requirement.formats.join(', ')} onchange={(e) => requirement.formats = parse(e.currentTarget.value)} /></label>
      <label>Эквиваленты<input value={requirement.equivalents.join(', ')} onchange={(e) => requirement.equivalents = parse(e.currentTarget.value)} /></label>
      <label>Роли источников<input required value={requirement.sourceRoles.join(', ')} onchange={(e) => requirement.sourceRoles = parse(e.currentTarget.value)} /></label>
    </div>
    <label>Критерий полноты<input required bind:value={requirement.completenessCriterion} /></label>
    <label>Адресат<input required bind:value={requirement.addressee} /></label>
    <button type="button" class="quiet" onclick={() => requirements = requirements.filter((_, item) => item !== index)}>Удалить часть</button>
  </fieldset>
{/each}
<div class="actions"><button type="button" onclick={() => requirements = [...requirements, blank()]}>Добавить обязательную часть</button></div>
