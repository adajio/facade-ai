<script lang="ts">
  import { preliminaryLetterQuestion, type PreliminaryAnalysis, type PreliminaryFactScope, type PreliminaryPropertyStatus, type PreliminaryRow, type PreliminaryScopeSide } from './preliminary-review';
  import PreliminarySources from './PreliminarySources.svelte';
  import PreliminaryStatusBadge from './PreliminaryStatusBadge.svelte';

  let { row, previousAnalysis, receiptHref }: { row?: PreliminaryRow; previousAnalysis?: PreliminaryAnalysis; receiptHref?: string } = $props();
  const analysis = $derived(row?.analysis ?? previousAnalysis);
  const known = $derived(analysis?.properties.filter(property => property.status === 'confirmed') ?? []);
  const unresolved = $derived(analysis?.properties.filter(property => property.status !== 'confirmed') ?? []);
  const propertySources = $derived(analysis?.properties.some(property =>
    property.sources.length || property.scope?.sources.length || property.response?.sources.length) ||
    analysis?.tensions.some(tension => tension.sides.some(side => side.sources.length) || tension.resolutionSources.length));
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
    if (property.scope?.basis === 'literal') return 'Подтверждена надпись';
    if (property.status === 'not_mentioned' && property.response?.state === 'received')
      return 'Ответ получен, свойство в нём не упомянуто';
    if (property.status === 'unanswered' && property.response?.state === 'not_received')
      return 'Ответ заказчика не получен';
    return propertyStatus[property.status];
  }
</script>

{#snippet propertyDetails(property: PreliminaryAnalysis['properties'][number])}
  {@const question = analysis?.applicability.kind !== 'excluded' ? preliminaryLetterQuestion(property) : undefined}
  <section class="property" aria-label={property.label}>
    <h5>{property.label}</h5>
    <p><strong>{statusLabel(property)}</strong> · {property.finding}</p>
    {#if property.scope}
      <div class="scope">
        <p><strong>{property.scope.basis === 'literal' ? 'Надпись в источнике' : factScope[property.scope.kind]}</strong> · {property.scope.reason}</p>
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
    {#each analysis?.tensions.filter(item => item.propertyKey === property.key) ?? [] as tension (tension.key)}
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
    {#if question}
      <p><strong>Вопрос для письма</strong> · {question}</p>
    {:else if property.letter.kind === 'omit'}
      <p><strong>В письмо не включается</strong> · {property.letter.text}</p>
    {/if}
  </section>
{/snippet}

{#if row || analysis}
  <div class="analysis">
    {#if row}
      <h4>Что установлено</h4>
      <p><PreliminaryStatusBadge status={row.status} /> · {row.finding}</p>
    {/if}
    {#if analysis && analysis.applicability.kind !== 'undetermined'}
      <p><strong>{applicability[analysis.applicability.kind]}</strong> · {analysis.applicability.reason}</p>
    {/if}
    {#each known as property (property.key)}{@render propertyDetails(property)}{/each}

    <h4>Что остаётся выяснить</h4>
    {#if analysis?.applicability.kind === 'undetermined'}
      <p><strong>{applicability.undetermined}</strong> · {analysis.applicability.reason}</p>
    {/if}
    {#if analysis?.applicability.kind === 'excluded'}
      <p class="meta">Запрос по этому требованию в письмо не включён.</p>
    {:else}
      {#each unresolved as property (property.key)}{@render propertyDetails(property)}{/each}
      {#if !unresolved.some(property => preliminaryLetterQuestion(property))}
        <p class="meta">{(!row || row.status === 'present') && analysis?.applicability.kind !== 'undetermined' && known.length && !unresolved.length
          ? 'Открытых уточнений по сохранённому разбору нет.' : 'Адресный вопрос пока не сформирован.'}</p>
      {/if}
    {/if}

    <h4>Где проверить</h4>
    {#if row?.sources.length}<PreliminarySources sources={row.sources} label="Основания вывода" />{/if}
    {#if analysis?.applicability.sources.length}
      <PreliminarySources sources={analysis.applicability.sources} label="Основания применимости" />
    {/if}
    {#if !row?.sources.length && !analysis?.applicability.sources.length}
      <p class="meta">{propertySources ? 'Адреса указаны рядом со свойствами.' : 'Адресные источники по требованию отсутствуют.'}</p>
    {/if}
    {#if receiptHref && !row?.sources.length && !analysis?.applicability.sources.length && !propertySources}
      <p><a href={receiptHref}>Открыть опись поступления</a></p>
    {/if}
    {#if row?.retained}
      <details>
        <summary>Сохранённый вывод предыдущего разбора</summary>
        <p>{row.retained.finding}</p>
        <PreliminarySources sources={row.retained.sources} label="Основания сохранённого вывода" />
      </details>
    {/if}
  </div>
{/if}

<style>
  .analysis { margin-block: .65rem; overflow-wrap: anywhere; }
  .analysis h4 { margin: .8rem 0 .25rem; font-size: .94rem; }
  .analysis p { margin: .35rem 0; }
  .property { margin-block: .65rem; padding-block-start: .55rem; border-block-start: 1px solid var(--line); }
  .property h5 { margin: 0; font-size: .92rem; }
  .scope { margin-block: .45rem; padding-inline-start: .7rem; border-inline-start: 2px solid var(--line); }
  .scope dl { display: grid; grid-template-columns: max-content minmax(0, 1fr); gap: .25rem .6rem; margin: .35rem 0; }
  .scope dt { font-weight: 600; }
  .scope dd { margin: 0; }
  .tension { margin-block: .45rem; padding-inline-start: .7rem; border-inline-start: 2px solid var(--line); }
  .tension-side { margin-block: .5rem; }
</style>
