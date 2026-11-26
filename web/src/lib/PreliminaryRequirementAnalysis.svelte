<script lang="ts">
  import type { PreliminaryAnalysis, PreliminaryFactScope, PreliminaryPropertyStatus, PreliminaryRow, PreliminaryScopeSide } from './preliminary-review';
  import PreliminarySources from './PreliminarySources.svelte';

  let { analysis, retained }: { analysis?: PreliminaryAnalysis; retained?: PreliminaryRow['retained'] } = $props();
  const applicability = { included: 'Применимо', excluded: 'Исключено', undetermined: 'Применимость не установлена' };
  const factScope: Record<PreliminaryFactScope['kind'], string> = {
    applicable: 'Область свидетельства подтверждена',
    unrelated: 'Свидетельство относится к другой области',
    undetermined: 'Область свидетельства требует сверки',
  };
  const scopeFields = { element: 'Элемент', zone: 'Зона', purpose: 'Назначение', variant: 'Исполнение' } as const;
  function scopeLabel(side: PreliminaryScopeSide) {
    return (Object.keys(scopeFields) as (keyof PreliminaryScopeSide)[])
      .flatMap(key => side[key] ? [scopeFields[key] + ' — ' + side[key]] : []).join(' · ');
  }
  const propertyStatus: Record<PreliminaryPropertyStatus, string> = {
    confirmed: 'Подтверждённый вариант',
    unanswered: 'Запрос зафиксирован, ответ в доступных источниках не найден',
    not_mentioned: 'Не упомянуто в доступных источниках',
    insufficient: 'Недостаточно данных',
    conflicting: 'Есть противоречие',
  };
  function statusLabel(property: PreliminaryAnalysis['properties'][number]) {
    if (property.status === 'not_mentioned' && property.response?.state === 'received')
      return 'Ответ получен, свойство в нём не упомянуто';
    if (property.status === 'unanswered' && property.response?.state === 'not_received')
      return 'Ответ заказчика не получен';
    return propertyStatus[property.status];
  }
</script>

{#if analysis}
  <div class="analysis">
    <p><strong>{applicability[analysis.applicability.kind]}</strong> · {analysis.applicability.reason}</p>
    {#if analysis.applicability.sources.length}
      <PreliminarySources sources={analysis.applicability.sources} label="Основания применимости" />
    {/if}
    {#if analysis.applicability.kind === 'excluded'}
      <p class="meta">Запрос по этому требованию в письмо не включён.</p>
    {/if}
    {#each analysis.properties as property (property.key)}
      <section class="property" aria-label={property.label}>
        <h4>{property.label}</h4>
        <p><strong>{statusLabel(property)}</strong> · {property.finding}</p>
        {#if property.scope}
          <div class="scope">
            <p><strong>{factScope[property.scope.kind]}</strong> · {property.scope.reason}</p>
            <dl>
              <dt>Область вопроса</dt>
              <dd>{scopeLabel(property.scope.target)}</dd>
              {#if property.scope.observed}
                <dt>Область источника</dt>
                <dd>{scopeLabel(property.scope.observed)}</dd>
              {/if}
            </dl>
            {#if property.scope.sources.length}
              <PreliminarySources sources={property.scope.sources} label={'Адреса проверки области по свойству «' + property.label + '»'} />
            {/if}
          </div>
        {/if}
        {#if property.response}
          <p><strong>Сведения об ответе</strong> · {property.response.finding}</p>
          <PreliminarySources sources={property.response.sources} label={'Основания статуса ответа по свойству «' + property.label + '»'} />
        {/if}
        {#if property.sources.length}
          <PreliminarySources sources={property.sources} label={'Источники по свойству «' + property.label + '»'} />
        {/if}
        {#each analysis.tensions.filter(item => item.propertyKey === property.key) as tension (tension.key)}
          <div class="tension">
            <p><strong>{tension.status === 'open' ? 'Противоречие' : 'Противоречие разрешено'}</strong> · {tension.finding}</p>
            {#each tension.sides as side}
              <div class="tension-side">
                <p>{side.text}</p>
                <PreliminarySources sources={side.sources} label={'Источники по варианту «' + side.text + '»'} />
              </div>
            {/each}
            {#if tension.resolutionSources.length}
              <PreliminarySources sources={tension.resolutionSources} label="Основания разрешения противоречия" />
            {/if}
          </div>
        {/each}
        <p><strong>{property.letter.kind === 'ask' ? 'Вопрос для письма' : 'В письмо не включается'}</strong> · {property.letter.text}</p>
      </section>
    {:else}
      {#if analysis.applicability.kind !== 'excluded'}
        <p class="meta">Отдельные свойства и адресные вопросы для письма не установлены.</p>
      {/if}
    {/each}
    {#if retained}
      <details>
        <summary>Сохранённый вывод предыдущего разбора</summary>
        <p>{retained.finding}</p>
        <PreliminarySources sources={retained.sources} label="Основания сохранённого вывода" />
      </details>
    {/if}
  </div>
{/if}

<style>
  .analysis { margin-block: .65rem; overflow-wrap: anywhere; }
  .analysis p { margin: .35rem 0; }
  .property { margin-block: .65rem; padding-block-start: .55rem; border-block-start: 1px solid var(--line); }
  .property h4 { margin: 0; }
  .scope { margin-block: .45rem; padding-inline-start: .7rem; border-inline-start: 2px solid var(--line); }
  .scope dl { display: grid; grid-template-columns: max-content minmax(0, 1fr); gap: .25rem .6rem; margin: .35rem 0; }
  .scope dt { font-weight: 600; }
  .scope dd { margin: 0; }
  .tension { margin-block: .45rem; padding-inline-start: .7rem; border-inline-start: 2px solid var(--line); }
  .tension-side { margin-block: .5rem; }
</style>
