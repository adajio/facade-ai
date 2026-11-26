<script lang="ts">
  import { denied, describe, query, type Api } from '../lib/http';
  import { count, date, label } from '../lib/format';
  import { projectStageLabel } from '../lib/project-stages';
  import { projectV1, scopedUrl, type Assessment, type OpenEvidence, type Projection, type WorkspaceProps } from '../lib/workspace';
  import { chooseWorkArea, currentOperation, requirementsUrl, workReceiptFilters, workSliceApi, type WorkReceiptFilter, type WorkSlice } from '../lib/work-slice';
  import Notice from '../lib/Notice.svelte';
  import PackagePreparation from '../lib/PackagePreparation.svelte';
  import ReceiptEvidenceChain from '../lib/ReceiptEvidenceChain.svelte';
  import WorkProgress from '../lib/WorkProgress.svelte';
  import TerraReadingProgress, { type TerraReading } from '../lib/TerraReadingProgress.svelte';

  let { api, context, projection, open, renew }: {
    api: Api; context: WorkspaceProps; projection?: Projection; open: OpenEvidence; renew: () => void;
  } = $props();
  const facadeMode = $derived(context.project.intakeMode && !context.scopeId && !context.project.scopeId);
  const projectId = $derived(context.project.id);
  const currentScope = $derived(context.scopeId);
  const accessScope = $derived(context.project.scopeId);
  let workSlice = $state<WorkSlice>();
  let error = $state('');
  let accessDenied = $state(false);
  let scopedAssessment = $state<Assessment>();
  let refreshSlice = $state<() => void>();
  let terra = $state<TerraReading>();
  let terraError = $state('');
  let terraUpdated = $state<number>();

  $effect(() => {
    const currentProjectId = projectId;
    const scopeId = facadeMode ? undefined : currentScope;
    const cancel = new AbortController();
    const { signal } = cancel;
    const restrictedScope = accessScope;
    let timer: ReturnType<typeof setTimeout>;
    let loading = false;
    let refreshPending = false;
    workSlice = undefined;
    scopedAssessment = undefined;
    terra = undefined;
    terraError = '';
    terraUpdated = undefined;

    async function load() {
      if (loading) {
        refreshPending = true;
        return;
      }
      loading = true;
      const deadline = AbortSignal.timeout(15_000);
      const request = { signal: AbortSignal.any([signal, deadline]) };
      clearTimeout(timer);
      try {
        if (restrictedScope) {
          scopedAssessment = await api.json<Assessment>(
            query(projectV1(currentProjectId) + '/assessments/current', { scopeId: restrictedScope }), request);
        } else {
          const slicePromise = api.json<WorkSlice>(query(workSliceApi(currentProjectId), { scopeId }), request);
          const terraPromise = facadeMode ? api.json<TerraReading>(projectV1(currentProjectId) + '/terra-reading', request) : undefined;
          if (terraPromise) {
            const [sliceResult, terraResult] = await Promise.allSettled([slicePromise, terraPromise]);
            if (sliceResult.status === 'rejected') throw sliceResult.reason;
            workSlice = sliceResult.value;
            if (terraResult.status === 'fulfilled') { terra = terraResult.value; terraError = ''; terraUpdated = Date.now(); }
            else {
              if (denied(terraResult.reason)) terra = undefined;
              terraError = describe(terraResult.reason);
            }
          } else workSlice = await slicePromise;
        }
        error = '';
        accessDenied = false;
      } catch (problem) {
        if (signal.aborted) return;
        accessDenied = denied(problem);
        if (accessDenied) {
          workSlice = undefined;
          scopedAssessment = undefined;
          terra = undefined;
        }
        error = deadline.aborted ? 'Ответ сервера задерживается. Можно повторить загрузку сводки.' : describe(problem);
      } finally {
        loading = false;
        if (!signal.aborted) {
          if (refreshPending) {
            refreshPending = false;
            void load();
          } else if (document.visibilityState === 'visible') {
            // Confirmed upload parts can move ahead of the project event stream.
            timer = setTimeout(load, facadeMode && (terra?.enabled || terraError || error) ? 8_000 : 15_000);
          }
        }
      }
    }
    refreshSlice = () => { void load(); };
    void load();
    const onVisible = () => { if (document.visibilityState === 'visible') void load(); };
    document.addEventListener('visibilitychange', onVisible);
    return () => { cancel.abort(); clearTimeout(timer); document.removeEventListener('visibilitychange', onVisible); };
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
    return scopedUrl(context.project.id, 'completeness', { scope: context.scopeId });
  }

</script>

{#if workSlice && facadeMode && terra?.enabled}
  <TerraReadingProgress data={terra} slice={workSlice} updatedAt={terraUpdated} error={terraError} canEdit={context.canEdit} />
  {#if terra.receipt}
    {#key terra.receipt.receiptId}
      <ReceiptEvidenceChain {api} projectId={context.project.id} receiptId={terra.receipt.receiptId} refreshKey={context.refreshKey} />
    {/key}
    <PackagePreparation {api} projectId={context.project.id} receiptId={terra.receipt.receiptId} refreshKey={context.refreshKey} compact />
  {/if}
{:else if workSlice && facadeMode && !terra && terraError}
  <section class="card"><h2>Состояние разбора</h2><Notice kind="error" message={'Не удалось загрузить состояние чтения: ' + terraError} /><button onclick={refreshSlice}>Повторить</button></section>
{:else if workSlice}
  {@const selected = chooseWorkArea(workSlice, context.params.get('context'))}
  {@const assessment = selected.assessment}
  {@const areas = workSlice.assessment?.contexts}
  {@const chooseArea = Boolean(areas?.length && !assessment)}
  {@const accepted = workSlice.files?.accepted ?? workSlice.acceptedOccurrences}
  {@const receipt = workSlice.activeReceipt ?? workSlice.latestReceipt}
  {@const area = assessment?.contextId}
  {@const target = scopedUrl(context.project.id, 'letters', { scope: context.scopeId, context: area })}
  {@const current = currentOperation(selected)}
  <section class="card stage-flow" aria-labelledby="project-stages-title">
    <h2 id="project-stages-title">{projectStageLabel('Стадия 1')}</h2>
    <p>Определите, достаточно ли материалов для начала работ.</p>
    {#if context.project.stage && context.project.stage !== 'Стадия 1'}<p>Стадия проектирования · {context.project.stage}</p>{/if}
    {#if areas && areas.length > 1 || chooseArea}
      <nav class="actions" aria-label="Область проверки">
        {#each areas ?? [] as item (item.contextId)}
          <a class="button" aria-current={item.contextId === area ? 'page' : undefined}
            href={scopedUrl(context.project.id, 'overview', { context: item.contextId })}>{item.kind === 'common' ? 'Весь комплект' : item.name}</a>
        {/each}
      </nav>
      {#if chooseArea}<p role="status">{context.params.has('context') ? 'Выбранная область проверки недоступна.' : 'Выберите область, чтобы открыть её требования, заключение и письма.'}</p>{/if}
    {/if}
    <details open={current === 1} class:active-step={current === 1}>
      <summary aria-current={current === 1 ? 'step' : undefined}>{#if current === 1}<span class="step-label">Текущий шаг</span>{/if}1. Приём документов · {workSlice.totals.all ? 'Поступлений ' + workSlice.totals.all : 'Материалы ещё не поступили'}</summary>
      {#if receipt}<a href={receiptUrl('all', receipt.receiptId)}>Поступление №{receipt.number}</a>{/if}
      {#if context.canEdit}<a class="button" class:primary={!accepted} href={scopedUrl(context.project.id, 'receipts', { upload: 1 })}>{workSlice.totals.all ? 'Добавить поступление' : 'Загрузить первый комплект'}</a>{/if}
      <a href={receiptUrl('all')}>К поступлениям</a>
    </details>
    <section class="reading-step" class:active-step={current === 2} aria-labelledby="reading-step-heading">
      <h3 id="reading-step-heading" aria-current={current === 2 ? 'step' : undefined}>{#if current === 2}<span class="step-label">Текущий шаг</span>{/if}2. Подготовка и чтение</h3>
      <WorkProgress slice={chooseArea ? workSlice : selected} {api} canEdit={context.canEdit} refresh={() => refreshSlice?.()} />
      {#if receipt}<a class="button" href={receiptUrl('all', receipt.receiptId)}>Открыть опись поступления №{receipt.number}</a>{/if}
    </section>
    <details open={current === 3} class:active-step={current === 3}>
      <summary aria-current={current === 3 ? 'step' : undefined}>{#if current === 3}<span class="step-label">Текущий шаг</span>{/if}3. Проверка требований · {accepted && assessment ? (assessment.checked ?? assessment.covered) + ' из ' + assessment.total : 'Ожидает материалов и правил'}</summary>
      {#if context.project.catalog}<p>{context.project.catalog.name} · версия {context.project.catalog.revision}</p>{/if}
      {#if assessment}
        <a class="button" href={requirementsUrl(selected)}>Все требования · {assessment.total}</a>
        {#if assessment.checked !== undefined && !assessment.evidence}<a href={requirementsUrl(selected, 'checked')}>Проверено · {assessment.checked}</a>{/if}
        {#if assessment.ready !== undefined}<a href={requirementsUrl(selected, 'done')}>Готово · {assessment.ready}</a>{/if}
        {#if assessment.review !== undefined}<a href={requirementsUrl(selected, 'review')}>Требуют проверки · {assessment.review}</a>{/if}
      {:else if !chooseArea}<a href={scopedUrl(context.project.id, 'settings', {})}>Посмотреть правила проверки</a>{/if}
    </details>
    <details open={current === 4} class:active-step={current === 4}>
      <summary aria-current={current === 4 ? 'step' : undefined}>{#if current === 4}<span class="step-label">Текущий шаг</span>{/if}4. Заключение · {assessment?.concluded ? 'Записано' : assessment?.previousConclusion ? 'Нужен пересмотр' : 'Заключение ещё не записано'}</summary>
      {#if assessment?.previousConclusion && !assessment.concluded}<p>{assessment.previousConclusion.reason}</p>{/if}
      {#if accepted && !chooseArea}<a class="button" href={scopedUrl(context.project.id, 'completeness', { context: area, scope: context.scopeId, panel: 'conclusion' })}>Открыть заключение по области</a>
      {:else if !accepted}<p>Сначала примите исходные материалы.</p>{/if}
    </details>
    <details open={current === 5} class:active-step={current === 5}>
      <summary aria-current={current === 5 ? 'step' : undefined}>{#if current === 5}<span class="step-label">Текущий шаг</span>{/if}5. Переписка · {assessment?.letter ? 'Допустимых пунктов ' + assessment.letter : 'Пока нет подтверждённых пунктов'}</summary>
      {#if assessment?.letter !== undefined}<a href={requirementsUrl(selected, 'letter')}>Основания для письма · {assessment.letter}</a>{/if}
      {#if !chooseArea}<a class="button" href={target}>Открыть письма и основания</a>{/if}
    </details>
    <p class="meta">{projectStageLabel('Стадия 2')} · Пока недоступна</p>
  </section>
  <div class="metrics" aria-label="Поступления в текущей проверке">
    {#each workSlice.filters as item (item.filter)}
      <a class="metric" href={receiptUrl(item.filter)}><span>{workReceiptFilters[item.filter]}</span><strong>{count(item.total)}</strong></a>
    {/each}
  </div>
{:else if scopedAssessment}
  <section class="card"><h2>Комплектность области</h2><p>{label(scopedAssessment.outcome)}</p><a href={assessmentUrl()}>Открыть оценку</a></section>
{:else if !accessDenied && !context.project.scopeId}
  <section class="card">
    <h2>{projectStageLabel('Стадия 1')}</h2>
    {#if context.project.catalog}<p>{context.project.catalog.name} · версия {context.project.catalog.revision}</p>{/if}
    {#if !error}<p role="status">Загружаем сведения о поступлениях и требованиях…</p>{/if}
    <nav class="actions" aria-label="Продолжить работу">
      {#if context.canEdit}<a class="button primary" href={scopedUrl(context.project.id, 'receipts', { scope: context.scopeId, upload: 1 })}>Загрузить комплект</a>{/if}
      <a href={scopedUrl(context.project.id, 'receipts', { scope: context.scopeId })}>Открыть поступления</a>
      <a href={scopedUrl(context.project.id, 'completeness', { scope: context.scopeId, context: context.params.get('context') })}>Открыть требования</a>
    </nav>
  </section>
{:else if !error}<p role="status">Загружаем данные проекта…</p>{/if}
{#if error}<Notice message={'Состояние проекта · ' + error} /><button onclick={refreshSlice}>Обновить обзор</button>{/if}

<style>
  .reading-step { padding: .7rem .8rem .85rem; }
  .reading-step h3 { font-size: 1rem; margin-block: 0 .35rem; }
  .stage-flow > details, .reading-step { margin-block: .5rem; border: 1px solid var(--line); border-radius: .4rem; }
  .stage-flow > details { padding: .25rem .8rem; }
  .stage-flow > details[open] { padding-bottom: .85rem; }
  .stage-flow > .active-step { border-inline-start: .3rem solid var(--accent); }
  .stage-flow > details > summary { padding-block: .65rem; min-height: 40px; cursor: pointer; font-weight: 600; }
  .stage-flow > details > a { display: inline-flex; align-items: center; min-height: 40px; margin-inline-end: .6rem; }
  .step-label { color: var(--accent-text); margin-inline-end: .6rem; font-size: .87em; }
</style>

{#if projection?.changes?.length}
  <section class="card"><h2>Последние изменения</h2>
    <ul class="plain-list">{#each projection.changes as event (event.cursor)}<li>{date(event.createdAt)} · {label(event.type)}</li>{/each}</ul>
  </section>
{/if}
