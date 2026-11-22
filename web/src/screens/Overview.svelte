<script lang="ts">
  import { describe, interrupted, query, type Api } from '../lib/http';
  import { count, date, label, bytes } from '../lib/format';
  import { projectV1, scopedUrl, type Assessment, type Projection, type WorkspaceProps } from '../lib/workspace';
  import type { Section } from '../lib/routes';
  import Notice from '../lib/Notice.svelte';

  let { api, context, projection }: { api: Api; context: WorkspaceProps; projection?: Projection } = $props();
  let assessment = $state<Assessment>();
  let error = $state('');

  const metrics: { key: string; title: string; section: Section; byteCount?: boolean }[] = [
    { key: 'confirmedBytes', title: 'Подтверждённые байты', section: 'receipts', byteCount: true },
    { key: 'openReceipts', title: 'Открытые описи', section: 'receipts' },
    { key: 'coverageA', title: 'Физические единицы A', section: 'receipts' },
    { key: 'coverageB', title: 'Физические единицы B', section: 'receipts' },
    { key: 'coveredParts', title: 'Готовые обязательные части', section: 'completeness' },
    { key: 'verifiedFacts', title: 'Проверенные сведения', section: 'facts' },
    { key: 'reviews', title: 'Сверки', section: 'questions' },
    { key: 'decisions', title: 'Решения инженера', section: 'completeness' },
    { key: 'externalRequests', title: 'Внешние запросы', section: 'letters' },
    { key: 'internalQuestions', title: 'Внутренние вопросы', section: 'questions' },
  ];

  $effect(() => {
    const scopeId = context.scopeId;
    const path = projectV1(context.project.id) + '/assessments/current';
    void context.refreshKey;
    if (!scopeId) return;
    const cancel = new AbortController();
    error = '';
    api.json<Assessment>(query(path, { scopeId }), { signal: cancel.signal }).then((result) => {
      assessment = result;
    }).catch((problem) => {
      if (!interrupted(problem)) error = describe(problem);
    });
    return () => cancel.abort();
  });

  function metricUrl(section: Section, filter?: string) {
    return scopedUrl(context.project.id, section, { scope: context.scopeId, slice: projection?.sliceId, filter });
  }
</script>

<section class="card" aria-labelledby="collection-title">
  <div class="card-header"><h2 id="collection-title">Сбор исходных данных</h2>
    <a class="button" href={metricUrl('receipts')}>К поступлениям</a>
  </div>
  {#if !context.scopeId}<p class="muted">Добавьте область, чтобы видеть оценку комплектности.</p>
  {:else if !projection}<p class="muted">Ожидаем снимок проекта.</p>
  {:else if projection.holds?.length}<p>Текущие основания ожидают разбора досылки. Открытых причин · {projection.holds.length}</p>
  {:else}<p>Поступления, опись и результаты чтения доступны в разделе «Поступления».</p>{/if}
</section>

<div class="metrics" aria-label="Показатели проекта">
  {#each metrics as metric (metric.key)}
    {@const item = projection?.metrics?.[metric.key]}
    <a class="metric" href={metricUrl(metric.section, item?.filter)}>
      <span>{metric.title}</span>
      <strong>{metric.byteCount ? bytes(item?.value) : count(item?.value)}
        {#if item?.total != null} / {metric.byteCount ? bytes(item.total) : count(item.total)}{/if}
      </strong>
    </a>
  {/each}
</div>

<section class="card">
  <div class="card-header"><h2>Комплектность</h2><a href={metricUrl('completeness')}>Открыть оценку</a></div>
  <Notice kind="error" message={error} />
  <dl class="details">
    <dt>Машинная оценка</dt><dd>{label(assessment?.outcome)}</dd>
    <dt>Заключение инженера</dt><dd>{assessment?.conclusion ? label(assessment.conclusion.outcome ?? assessment.outcome) : 'Ожидает решения'}</dd>
    <dt>Начало работ</dt><dd>{label(assessment?.conclusion?.startWork, 'Ожидает решения')}</dd>
  </dl>
  {#if assessment?.limitations?.length}<p class="meta">{assessment.limitations.map((value) => label(value)).join(' · ')}</p>{/if}
</section>

{#if projection?.changes?.length}
  <section class="card"><h2>Последние изменения</h2>
    <ul class="plain-list">{#each projection.changes as event (event.cursor)}<li>{date(event.createdAt)} · {label(event.type)}</li>{/each}</ul>
  </section>
{/if}
