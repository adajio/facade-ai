<script lang="ts">
  import { denied, describe, query, type Api } from '../lib/http';
  import { bytes, count, date, label } from '../lib/format';
  import { projectV1, scopedUrl, type Assessment, type OpenEvidence, type Projection, type WorkspaceProps } from '../lib/workspace';
  import { workReceiptFilters, workSliceApi, type WorkReceiptFilter, type WorkSlice } from '../lib/work-slice';
  import Notice from '../lib/Notice.svelte';
  import FacadeAssessment from './FacadeAssessment.svelte';

  let { api, context, projection, open, renew }: {
    api: Api; context: WorkspaceProps; projection?: Projection; open: OpenEvidence; renew: () => void;
  } = $props();
  const facadeMode = $derived(context.project.intakeMode && !context.project.scopeId);
  let workSlice = $state<WorkSlice>();
  let error = $state('');
  let scopedAssessment = $state<Assessment>();
  let refreshSlice = $state<() => void>();

  $effect(() => {
    const projectId = context.project.id;
    const scopeId = facadeMode ? undefined : context.scopeId;
    const cancel = new AbortController();
    const { signal } = cancel;
    const accessScope = context.project.scopeId;
    let timer: ReturnType<typeof setTimeout>;
    let loading = false;
    let refreshPending = false;

    async function load() {
      if (loading) {
        refreshPending = true;
        return;
      }
      loading = true;
      clearTimeout(timer);
      try {
        if (accessScope) {
          scopedAssessment = await api.json<Assessment>(
            query(projectV1(projectId) + '/assessments/current', { scopeId: accessScope }), { signal });
        } else {
          workSlice = await api.json<WorkSlice>(query(workSliceApi(projectId), { scopeId }), { signal });
        }
        error = '';
      } catch (problem) {
        if (signal.aborted) return;
        if (denied(problem)) {
          workSlice = undefined;
          scopedAssessment = undefined;
        }
        error = describe(problem);
      } finally {
        loading = false;
        if (!signal.aborted) {
          if (refreshPending) {
            refreshPending = false;
            void load();
          } else if (workSlice?.activeReceipt && document.visibilityState === 'visible') {
            // Confirmed upload parts can move ahead of the project event stream.
            timer = setTimeout(load, 15_000);
          }
        }
      }
    }
    refreshSlice = () => { void load(); };
    return () => { cancel.abort(); clearTimeout(timer); };
  });

  $effect(() => {
    void context.refreshKey;
    refreshSlice?.();
  });

  function receiptUrl(filter?: WorkReceiptFilter, receiptId?: string) {
    return scopedUrl(context.project.id, 'receipts', {
      scope: context.scopeId, workSlice: workSlice?.workSliceId, filter,
    }, receiptId);
  }

  function assessmentUrl() {
    return scopedUrl(context.project.id, 'completeness', { scope: context.scopeId, revision: workSlice?.assessment?.version });
  }

  function readingLabel(state: WorkSlice['readings'][number]['state']) {
    return ({ ready: 'В очереди', leased: 'В работе', done: 'Завершено', held: 'На удержании' })[state];
  }
</script>

<section class="card" aria-labelledby="collection-title">
  <div class="card-header"><h2 id="collection-title">Сбор исходных данных</h2>
    {#if !context.project.scopeId}
      <div class="actions">
        {#if context.canEdit}
          <a class="button primary" href={scopedUrl(context.project.id, 'receipts', { upload: 1 })}>Загрузить комплект</a>
        {/if}
        <a class="button" href={receiptUrl('all')}>К поступлениям</a>
      </div>
    {/if}
  </div>
  {#if !context.project.scopeId && (workSlice?.catalogAssigned === false || !workSlice && context.project.catalogState === 'unassigned')}
    <p class="muted">Нет рабочего каталога. Комплект можно загрузить и открыть до его назначения.</p>
  {:else if context.project.scopeId && projection?.holds?.length}
    <p>Текущие основания ожидают разбора досылки. Открытых причин · {projection.holds.length}</p>
  {/if}
  {#if workSlice?.activeReceipt}
    {@const active = workSlice.activeReceipt}
    <p>{active.filter === 'processing' ? 'Обрабатывается' : 'Опись формируется'} ·
      <a href={receiptUrl(active.filter, active.receiptId)}>Поступление №{active.number}</a></p>
  {/if}
  {#if !workSlice && !error && !context.project.scopeId}<p role="status">Загружаем срез проекта…</p>{/if}
  <Notice message={error && 'Состояние проекта · ' + error} />
</section>

{#if workSlice}
  <div class="metrics" aria-label="Поступления в срезе">
    {#each workSlice.filters as item (item.filter)}
      <a class="metric" href={receiptUrl(item.filter)}>
        <span>{workReceiptFilters[item.filter]}</span>
        <strong>{count(item.total)}</strong>
      </a>
    {/each}
  </div>
  <section class="card">
    <h2>Опись и чтение</h2>
    <dl class="details">
      <dt>Подтверждённые байты</dt><dd>{bytes(workSlice.confirmedBytes)}</dd>
      <dt>Принятые вхождения</dt><dd>{count(workSlice.acceptedOccurrences)}</dd>
      {#each workSlice.readings as reading (`${reading.branch ?? "review"}:${reading.state}`)}
        <dt>{reading.branch ? 'Ветвь ' + reading.branch : 'Сверка'} · {readingLabel(reading.state)}</dt><dd>{count(reading.total)}</dd>
      {:else}
        <dt>Чтение</dt><dd>Задания чтения пока отсутствуют</dd>
      {/each}
    </dl>
  </section>
{/if}

{#if facadeMode && workSlice?.assessment?.kind === 'facade'}
  {#key workSlice.assessment.version}
    <FacadeAssessment {api} {context} {open} {renew} overview overviewVersion={workSlice.assessment.version} />
  {/key}
{:else if !facadeMode}
  <section class="card">
    <div class="card-header"><h2>Комплектность</h2>
      {#if context.scopeId}<a href={assessmentUrl()}>Открыть оценку</a>{/if}
    </div>
    {#if workSlice?.assessment || scopedAssessment}
      <dl class="details">
        <dt>Машинная оценка</dt><dd>{label(workSlice?.assessment?.outcome ?? scopedAssessment?.outcome)}</dd>
        {#if workSlice?.assessment}
          <dt>Покрытые требования</dt><dd>{count(workSlice.assessment.covered)} из {count(workSlice.assessment.total)}</dd>
        {:else}
          <dt>Начало работ</dt><dd>{label(scopedAssessment?.conclusion?.startWork, 'Ожидает решения')}</dd>
        {/if}
      </dl>
    {:else if workSlice}<p class="muted">Для выбранной области ещё нет версии оценки.</p>{/if}
  </section>
{/if}

{#if projection?.changes?.length}
  <section class="card"><h2>Последние изменения</h2>
    <ul class="plain-list">{#each projection.changes as event (event.cursor)}<li>{date(event.createdAt)} · {label(event.type)}</li>{/each}</ul>
  </section>
{/if}
