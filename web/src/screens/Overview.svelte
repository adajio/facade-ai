<script lang="ts">
  import { describe, interrupted, query, type Api } from '../lib/http';
  import { count, date, label, bytes } from '../lib/format';
  import { projectApi, projectV1, scopedUrl, type Assessment, type OpenEvidence, type Projection, type WorkspaceProps } from '../lib/workspace';
  import type { Section } from '../lib/routes';
  import Notice from '../lib/Notice.svelte';
  import FacadeAssessment from './FacadeAssessment.svelte';

  let { api, context, projection, open, renew }: {
    api: Api; context: WorkspaceProps; projection?: Projection; open: OpenEvidence; renew: () => void;
  } = $props();
  const facadeMode = $derived(context.project.intakeMode && !context.project.scopeId);
  let assessment = $state<Assessment>();
  let error = $state('');
  let activeReceipt = $state<{ receiptId: string; number: number }>();
  let receiptError = $state('');

  $effect(() => {
    const projectId = context.project.id;
    void context.refreshKey;
    if (context.project.scopeId) return;
    const cancel = new AbortController();
    const path = query(projectApi(projectId) + '/receipts', { state: 'uploading' });
    void api.json<{ receipts: { receiptId: string; number: number; inventoryOpen: boolean }[] }>(path, {
      signal: cancel.signal,
    }).then(({ receipts }) => {
      activeReceipt = receipts.find(({ inventoryOpen }) => inventoryOpen);
      receiptError = '';
    }).catch((problem) => {
      if (cancel.signal.aborted || interrupted(problem)) return;
      activeReceipt = undefined;
      receiptError = describe(problem);
    });
    return () => cancel.abort();
  });

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
    if (!scopeId || facadeMode) return;
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
    <div class="actions">
      {#if context.canEdit && !context.project.scopeId}
        <a class="button primary" href={scopedUrl(context.project.id, 'receipts', { upload: 1 })}>Загрузить комплект</a>
      {/if}
      <a class="button" href={metricUrl('receipts')}>К поступлениям</a>
    </div>
  </div>
  {#if context.project.catalogState === 'unassigned'}<p class="muted">Нет рабочего каталога. Комплект можно загрузить и открыть до его назначения.</p>
  {:else if !context.scopeId && !facadeMode}<p class="muted">Добавьте область, чтобы видеть оценку комплектности.</p>
  {:else if !projection}<p class="muted">Ожидаем снимок проекта.</p>
  {:else if projection.holds?.length}<p>Текущие основания ожидают разбора досылки. Открытых причин · {projection.holds.length}</p>
  {/if}
  {#if activeReceipt}
    <p>Опись формируется · <a href={scopedUrl(context.project.id, 'receipts', {
      scope: context.scopeId, slice: context.params.get('slice'), filter: 'open',
    }, activeReceipt.receiptId)}>Поступление №{activeReceipt.number}</a></p>
  {/if}
  <Notice message={receiptError && 'Состояние поступлений · ' + receiptError} />
</section>

{#if metrics.some(({ key }) => projection?.metrics?.[key] != null)}
<div class="metrics" aria-label="Показатели проекта">
  {#each metrics as metric (metric.key)}
    {@const item = projection?.metrics?.[metric.key]}
    {#if item}<a class="metric" href={metricUrl(metric.section, item.filter)}>
      <span>{metric.title}</span>
      <strong>{metric.byteCount ? bytes(item?.value) : count(item?.value)}
        {#if item?.total != null} / {metric.byteCount ? bytes(item.total) : count(item.total)}{/if}
      </strong>
    </a>{/if}
  {/each}
</div>
{/if}

{#if facadeMode}
  <FacadeAssessment {api} {context} {open} {renew} overview />
{:else}
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
{/if}

{#if projection?.changes?.length}
  <section class="card"><h2>Последние изменения</h2>
    <ul class="plain-list">{#each projection.changes as event (event.cursor)}<li>{date(event.createdAt)} · {label(event.type)}</li>{/each}</ul>
  </section>
{/if}
