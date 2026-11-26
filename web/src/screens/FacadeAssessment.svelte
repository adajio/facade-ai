<script lang="ts">
  import { versionForCount } from '../lib/assessment-version';
  import { Commands } from '../lib/commands';
  import { tick, untrack } from 'svelte';
  import TriageBar from '../lib/TriageBar.svelte';
  import PreliminaryStatusBadge from '../lib/PreliminaryStatusBadge.svelte';
  import PreliminaryRequirementAnalysis from '../lib/PreliminaryRequirementAnalysis.svelte';
  import PreliminaryRowChange from '../lib/PreliminaryRowChange.svelte';
  import PreliminarySources from '../lib/PreliminarySources.svelte';
  import type { PreliminaryStatus, PreliminaryReview } from '../lib/preliminary-review';
  import { evidenceCounts, hasRemainder, localFinding, matchesSelection, requirementChecked, requirementTitle, triageCounts, type Triage } from '../lib/triage';
  import { conflictMessage, conflictVersion } from '../lib/conflict';
  import { date, label } from '../lib/format';
  import { ApiError, denied, describe, id, interrupted, type Api } from '../lib/http';
  import { assessmentReasons, clarificationLabels, coverageLabels, observationLabels, type Binding, type FacadeAssessment, type FacadeContext } from '../lib/facade-assessment';
  import { projectV1, scopedUrl, V1, type AssessmentQuestion, type OpenEvidence, type WorkspaceProps } from '../lib/workspace';
  import EvidenceButtons from '../lib/EvidenceButtons.svelte';
  import Notice from '../lib/Notice.svelte';
  import FacadeTypeControl from './FacadeTypeControl.svelte';
  import FacadeObservations from './FacadeObservations.svelte';
  import ConclusionBasis from '../lib/ConclusionBasis.svelte';
  import type { ConclusionInput } from '../lib/workspace';
  import ClarificationControl from '../lib/ClarificationControl.svelte';
  import PackageInquiries from '../lib/PackageInquiries.svelte';
  import FacadeSupplementReview from '../lib/FacadeSupplementReview.svelte';

  let { api, context, open, renew, refreshProject, overview = false, overviewVersion, triage, chooseTriage, mode = 'matrix' }: {
    api: Api; context: WorkspaceProps; open: OpenEvidence; renew: () => void; refreshProject?: () => Promise<void>; overview?: boolean; overviewVersion?: number;
    triage?: Triage; chooseTriage?: (value: Triage) => void;
    mode?: 'matrix' | 'facts' | 'questions';
  } = $props();
  const commands = new Commands(() => api);
  let summary = $state<FacadeAssessment>();
  let problem = $state('');
  let assessmentRetry = $state(0);
  let preliminary = $state<PreliminaryReview>();
  let preliminaryError = $state('');
  let preliminaryProject = $state('');
  let factsSyncError = $state('');
  let reading = $state(false);
  let staleView = $state(false);
  let loadedSelection: string | undefined;
  const defaultContext = $derived(summary?.contexts.length === 1 ? summary.contexts[0]
    : mode === 'matrix' && !overview ? summary?.contexts.find(item => item.kind === 'common') : undefined);
  let contextId = $derived(context.params.get('context') || defaultContext?.assessmentContextId || '');
  let view = $derived(summary?.contexts.find((item) => item.assessmentContextId === contextId));
  let counts = $derived(triageCounts(view?.questions ?? summary?.contexts.flatMap((item) => item.questions) ?? []));
  let evidence = $derived(view?.questions.some((item) => item.semanticRemainder) ? evidenceCounts(view.questions) : undefined);
  let current = $derived((context.filter || (mode === 'questions' ? 'review' : triage || 'all')) as Triage);
  let questions = $derived(view?.questions.filter((item) => matchesSelection(item, current)) ?? []);
  let active = $derived(view?.questions.find((item) => item.id === context.objectId));
  let inquiryRequirement = $derived(view?.questions.find((item) => item.id === context.params.get('requirement')));
  let heading = $state<HTMLHeadingElement>();
  let inlineNavigation = false;
  let lastOpened: string | undefined;
  let focusedHeading: HTMLHeadingElement | undefined;
  $effect(() => {
    const id = active?.id;
    if (id && heading && (id !== lastOpened || heading !== focusedHeading)) {
      heading.focus({preventScroll: inlineNavigation});
      inlineNavigation = false;
      focusedHeading = heading;
      lastOpened = id;
    } else if (!context.objectId && lastOpened) {
      document.getElementById('requirement-' + lastOpened)?.focus({preventScroll:true});
      inlineNavigation = false;
      lastOpened = undefined;
      focusedHeading = undefined;
    }
  });
  let reviewItems = $derived(summary?.comparisonReview?.items.filter((item) =>
    !view?.facadeId || !item.facadeId || item.facadeId === view.facadeId) ?? []);
  let busy = $state(false);
  let result = $state('');
  let commandError = $state('');
  let commandConflict = $state(false);
  let resultTarget = $state<'conclusion' | 'question'>();
  let basis = $state<ConclusionInput>();
  let startWork = $state('');
  let conclusionReason = $state('');
  let conclusionVersion = $state<number>();
  let requestExternal = $state(false);
  let decisionReason = $state('');
  let decisionVersion = $state<number>();
  let decisionAction = $state<'confirm' | 'correct' | 'exclude' | 'revoke'>('confirm');
  let exclusionKind = $state<'not_required' | 'work_without_data'>('not_required');
  let exclusionUntil = $state('');
  let critical = $state<boolean>();
  let mayRequestExternal = $derived(active && ['confirmed_missing', 'confirmed_conflict'].includes(active.machine.outcome));
  let decisionInput = $state<HTMLTextAreaElement>();
  let requestFocus = $derived(context.objectId || contextId);
  const initialPanel = $derived(context.params.get('panel') || '');
  let conclusionOpen = $state(false);
  $effect(() => { void contextId; conclusionOpen = initialPanel === 'conclusion'; });
  let countVersion = $state('');
  let expiredCount = $state(false);
  let historicalVersion = $derived(context.params.get('revision') || countVersion);

  $effect(() => {
    const projectId = context.project.id;
    const version = context.params.get('revision') || overviewVersion;
    const seen = version ? null : context.params.get('seen');
    const path = projectV1(projectId) + '/facade-assessment' + (version ? '/' + id(version) : '');
    const selection = JSON.stringify([path, seen]);
    void assessmentRetry;
    if (!overviewVersion) void context.refreshKey;
    const controller = new AbortController();
    if (loadedSelection !== selection) summary = undefined;
    reading = true;
    problem = '';
    void api.json<FacadeAssessment>(path, {
      signal: controller.signal,
    }).then(async (fresh) => {
      const result = await versionForCount(seen, fresh, (v) => api.json<FacadeAssessment>(path + '/' + id(v), { signal: controller.signal }));
      const value = result.snapshot;
      if (controller.signal.aborted) return;
      if (value.projectId !== projectId) {
        summary = undefined;
        problem = 'Сводка относится к другому проекту.';
      } else {
        loadedSelection = selection;
        summary = value;
        staleView = false;
        countVersion = result.historical ?? '';
        expiredCount = Boolean(result.expired);
      }
    }).catch((error) => {
      if (controller.signal.aborted || interrupted(error)) return;
      if (denied(error) || loadedSelection !== selection) {
        summary = undefined;
        loadedSelection = undefined;
      } else {
        staleView = true;
      }
      problem = describe(error);
    }).finally(() => { if (!controller.signal.aborted) reading = false; });
    return () => controller.abort();
  });

  $effect(() => {
    const projectId = context.project.id;
    if (mode !== 'facts' || overview || historicalVersion) {
      factsSyncError = '';
      return;
    }
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    async function refreshFactsVersion() {
      try {
        const fresh = await api.json<FacadeAssessment>(projectV1(projectId) + '/facade-assessment', { signal: controller.signal });
        if (controller.signal.aborted) return;
        if (fresh.projectId !== projectId) throw new Error('Сводка относится к другому проекту.');
        if (fresh.version !== summary?.version) summary = fresh;
        factsSyncError = '';
      } catch (failure) {
        if (controller.signal.aborted || interrupted(failure)) return;
        if (denied(failure)) { summary = undefined; loadedSelection = undefined; problem = describe(failure); }
        factsSyncError = describe(failure);
      }
      if (!controller.signal.aborted) timer = setTimeout(refreshFactsVersion, 30_000);
    }
    timer = setTimeout(refreshFactsVersion, 30_000);
    return () => { controller.abort(); clearTimeout(timer); };
  });

  $effect(() => {
    const projectId = context.project.id;
    void context.refreshKey;
    if (overview || mode !== 'matrix' || historicalVersion) {
      preliminary = undefined;
      preliminaryError = '';
      return;
    }
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    async function loadPreliminary() {
      try {
        let after: string | null = null;
        let found: PreliminaryReview | undefined;
        do {
          const path = projectV1(projectId) + '/preliminary-package-reviews' + (after ? '?after=' + encodeURIComponent(after) : '');
          const page: { items: PreliminaryReview[]; nextCursor?: string | null } = await api.json(path, { signal: controller.signal });
          found = page.items.find((item) => item.isCurrent);
          if (page.nextCursor && page.nextCursor === after) throw new Error('Курсор истории не продвинулся');
          after = page.nextCursor ?? null;
        } while (!found && after);
        if (controller.signal.aborted) return;
        preliminary = found;
        preliminaryProject = projectId;
        preliminaryError = '';
      } catch (error) {
        if (controller.signal.aborted || interrupted(error)) return;
        if (denied(error)) preliminary = undefined;
        preliminaryError = describe(error);
      }
      if (!controller.signal.aborted) timer = setTimeout(loadPreliminary, 30_000);
    }
    void loadPreliminary();
    return () => { controller.abort(); if (timer) clearTimeout(timer); };
  });

  const showTerra = $derived(!historicalVersion && preliminaryProject === context.project.id && !!preliminary && preliminary.catalogVersionId === summary?.catalogVersionId);

  const statuses: PreliminaryStatus[] = ['present', 'partial', 'not_found', 'unassessed'];
  let reviewCounts = $derived(statuses.map(status => ({status, count: view?.questions.filter(
    question => preliminaryFor(question)?.status === status).length ?? 0})));

  function preliminaryFor(question: AssessmentQuestion) {
    if (!showTerra || !preliminary) return undefined;
    return preliminary.rows.find((row) => row.key === question.requirement.positionId);
  }

  function contentReason(value: string, question: AssessmentQuestion) {
    if (value === 'semantic_check_missing' && preliminaryFor(question)) return 'Независимая проверка содержания по этому требованию ещё не завершена';
    return reason(value);
  }

  type Draft = {reason: string; version: number; action: typeof decisionAction; external: boolean;
    critical: boolean | undefined; exclusion: typeof exclusionKind; until: string};
  const drafts = new Map<string,Draft>();
  let previousQuestion: string | undefined;
  const draftTarget = $derived(context.objectId ? JSON.stringify([context.project.id, contextId, context.objectId, historicalVersion]) : undefined);
  $effect(() => {
    void requestFocus;
    const target = draftTarget;
    untrack(() => {
      if (previousQuestion && decisionVersion !== undefined) {
        drafts.set(previousQuestion, {reason:decisionReason, version:decisionVersion, action:decisionAction,
          external:requestExternal, critical, exclusion:exclusionKind, until:exclusionUntil});
      }
      previousQuestion = target;
      const draft = target ? drafts.get(target) : undefined;
      decisionAction = draft?.action ?? 'confirm';
      decisionReason = draft?.reason ?? '';
      decisionVersion = draft?.version;
      requestExternal = draft?.external ?? false;
      critical = draft?.critical;
      exclusionKind = draft?.exclusion ?? 'not_required';
      exclusionUntil = draft?.until ?? '';
      startWork = '';
      conclusionReason = '';
      conclusionVersion = undefined;
      commandError = '';
      result = '';
      resultTarget = undefined;
    });
  });

  function url(ctx?: FacadeContext, question?: AssessmentQuestion, filter?: string) {
    return scopedUrl(context.project.id, mode === 'questions' ? 'questions' : 'completeness', {
      context: ctx?.assessmentContextId, filter, revision: historicalVersion || (ctx ? overviewVersion : undefined),
      seen: historicalVersion || overviewVersion ? undefined : context.params.get('seen'), slice: context.params.get('slice'),
    }, question?.id);
  }

  function observationLink(binding?: Binding, facadeId?: string | null) {
    return scopedUrl(context.project.id, 'facts', {
      binding, facadeId, revision: historicalVersion, context: contextId,
    });
  }

  function receiptLink(receiptId: string) {
    return scopedUrl(context.project.id, 'receipts', {}, receiptId);
  }

  async function refreshType() {
    await refreshProject?.();
    renew();
  }

  function remainderLink(item: NonNullable<AssessmentQuestion['semanticRemainder']>['items'][number]) {
    const box = item.box && [item.box.x, item.box.y, item.box.width, item.box.height].join(', ');
    return scopedUrl(context.project.id, 'copilot', { version: item.versionId, unit: item.unitId, box });
  }

  function componentLink(citation: AssessmentQuestion['machine']['citations'][number], index: number) {
    const component = citation.components?.[index];
    return scopedUrl(context.project.id, 'completeness', {
      context: contextId, filter: context.filter, revision: historicalVersion, slice: context.params.get('slice'),
      evidence: citation.observationId ? citation.evidenceId : component?.evidenceId,
      observation: citation.observationId, component: citation.observationId ? index : undefined,
    }, active?.id);
  }

  function machineResult(question: AssessmentQuestion) {
    if (localFinding(question) === 'partial') {
      return question.machine.outcome === 'covered' ? 'Найдено частично' : 'Есть читаемые опоры, нужна сверка';
    }
    if (question.machine.outcome === 'covered' && question.semanticRemainder?.state === 'complete') return 'Доказана достаточность';
    return label(question.machine.outcome === 'needs_review' ? 'internal_review' : question.machine.outcome);
  }

  function reason(value: string) {
    if (value === 'semantic_check_missing' && !historicalVersion && preliminaryProject === context.project.id && preliminary && preliminary.catalogVersionId === summary?.catalogVersionId) return 'Независимая проверка содержания ещё не завершена';
    return assessmentReasons[value] ?? label(value);
  }

  function prepareDecision(question: AssessmentQuestion, confirmation: boolean) {
    resultTarget = 'question';
    if (active?.id !== question.id || active.version !== question.version) {
      commandError = 'Строка проверки изменилась. Откройте её актуальные основания.';
      return;
    }
    decisionVersion ??= question.version;
    decisionAction = confirmation ? 'confirm' : 'correct';
    requestExternal = confirmation;
    void tick().then(() => decisionInput?.focus());
  }

  function comparisonActions(question: AssessmentQuestion) {
    return { confirm: () => prepareDecision(question, true), dismiss: () => prepareDecision(question, false) };
  }

  function editDecision() { decisionVersion ??= active?.version; }

  async function save(event: SubmitEvent, kind: 'conclusion' | 'question') {
    event.preventDefault();
    if (!view || busy || staleView || historicalVersion) return;
    resultTarget = kind;
    const selectedView = view;
    const selectedQuestion = active;
    const submittedDraft = draftTarget;
    const version = kind === 'question' ? decisionVersion ?? selectedQuestion?.version : conclusionVersion ?? selectedView.version;
    if (version === undefined || kind === 'question' && (!selectedQuestion || version !== selectedQuestion.version || !decisionReason.trim())) return;
    busy = true;
    commandError = '';
    commandConflict = false;
    result = '';
    try {
      if (kind === 'question' && selectedQuestion) {
        await commands.send(V1 + '/questions/' + id(selectedQuestion.id) + '/decisions', 'POST', {
          action: decisionAction, reason: decisionReason,
          requestExternal: Boolean(decisionAction === 'confirm' && mayRequestExternal && requestExternal),
          ...(decisionAction !== 'revoke' && critical !== undefined ? { startWorkCritical: critical } : {}),
          ...(decisionAction === 'correct' ? { outcome: 'needs_review' } : {}),
          ...(decisionAction === 'exclude' ? { exclusion: { kind: exclusionKind,
            ...(exclusionUntil ? { until: new Date(exclusionUntil).toISOString() } : {}) } } : {}),
        }, version);
        if (submittedDraft) drafts.delete(submittedDraft);
        if (draftTarget !== submittedDraft) return;
        decisionReason = '';
        decisionVersion = undefined;
        decisionAction = 'confirm';
        requestExternal = false;
        exclusionKind = 'not_required';
        exclusionUntil = '';
        critical = undefined;
      } else {
        await commands.send(projectV1(context.project.id) + '/conclusions', 'POST', {
          assessmentContextId: selectedView.assessmentContextId, startWork, reason: conclusionReason, basis,
        }, version);
        conclusionVersion = undefined;
        conclusionReason = '';
        startWork = '';
      }
      result = 'Решение сохранено.';
    } catch (error) {
      if (kind === 'question' && submittedDraft !== draftTarget && !(error instanceof ApiError && [401,403].includes(error.status))) return;
      commandError = conflictMessage(error, version);
      commandConflict = Boolean(conflictVersion(error));
      if (error instanceof ApiError && [401, 403].includes(error.status)) {
        summary = undefined;
        loadedSelection = undefined;
      }
    } finally {
      busy = false;
      renew();
    }
  }
</script>

{#snippet commandFeedback()}
  <Notice kind="error" message={commandError} />
  {#if commandConflict}<button type="button" disabled={reading} onclick={() => assessmentRetry++}>Загрузить текущую версию для сверки</button>{/if}
  <Notice kind="success" message={result} />
{/snippet}

<Notice kind="error" message={problem && 'Сводка оценки · ' + problem} />
{#if problem}
  {#if staleView && summary}<p>Доступна последняя проверенная версия. Ввод сохранён. Повторите загрузку перед записью.</p>{/if}
  <button type="button" disabled={reading} onclick={() => assessmentRetry++}>Повторить загрузку оценки</button>
{/if}
{#if !summary && !problem}<p class="card" role="status">Загружаем сводку оценки…</p>{/if}
{#if summary && context.params.has('context') && !view}
  <Notice message="Эта область недоступна в выбранной версии." />
  <a href={scopedUrl(context.project.id, mode === 'matrix' ? 'completeness' : mode, { revision: historicalVersion })}>Выбрать доступную область</a>
{:else if summary && mode === 'facts'}
  {#if factsSyncError}<Notice kind="error" message={'Не удалось обновить сведения · ' + factsSyncError} />{/if}
  <section class="card">
    <div class="card-header">
      <h2>{view?.name ?? 'Сведения по комплекту'}</h2>
      {#if historicalVersion}
        <a href={scopedUrl(context.project.id, 'facts', { context: contextId, binding: context.params.get('binding') })}>Актуальные сведения</a>
      {/if}
    </div>
    <nav class="actions" aria-label="Привязка сведений">
      <a class="button quiet" href={observationLink(undefined, view?.facadeId)} aria-current={context.params.has('binding') ? undefined : 'page'}>Все</a>
      {#each Object.entries(observationLabels) as [binding, label] (binding)}
        <a class="button quiet" href={observationLink(binding as Binding, view?.facadeId)}
          aria-current={context.params.get('binding') === binding ? 'page' : undefined}>{label}</a>
      {/each}
    </nav>
    <FacadeObservations {api} {context} {summary} {open} {renew} facts preselectedFacade={view?.facadeId} />
  </section>
{:else if summary}
  {#if historicalVersion}<p class="notice">Историческая версия · только чтение. Оценка №{summary.version}. <a href={scopedUrl(context.project.id, 'completeness', { context: contextId, filter: context.filter }, context.objectId)}>К актуальной проверке</a></p>{/if}
  {#if expiredCount}<p role="status">Данные обновились. Ниже показаны требования и числа актуальной версии.</p>{/if}
  {#if !overview && view}
    {#if mode === 'questions' && !historicalVersion}
      {#key view.assessmentContextId}
        <PackageInquiries {api} {context} contextId={view.assessmentContextId}
          contextName={view.kind === 'common' ? 'Весь комплект' : view.name} assessmentVersion={summary.version}
          requirement={inquiryRequirement ? { id: inquiryRequirement.id, text: inquiryRequirement.requirement.subject } : undefined}
          {open} {renew} />
      {/key}
    {/if}
    {#snippet selectedRequirement()}
      {#if active}
      {@const reportRow = preliminaryFor(active)}
      <section class="requirement-detail" id={'review-' + active.id} aria-labelledby={'review-title-' + active.id}>
        <header class="review-header">
        <h2 id={'review-title-' + active.id} bind:this={heading} tabindex="-1">{requirementTitle(active.requirement)}</h2>
        <a class="close-requirement" data-inline-requirement={active.id} href={url(view, undefined, context.filter)}>Свернуть требование</a>
        </header>
        <div class="requirement-review-grid">
        <div class="requirement-evidence">
          <h3>Что нашла система</h3>
        {#if reportRow}
          <p><PreliminaryStatusBadge status={reportRow.status} /> · {reportRow.finding}</p>
          <h4>Где проверить</h4>
          {#if reportRow.sources.length}
            <PreliminarySources sources={reportRow.sources} label="Основания вывода" />
          {:else}<p>В разборе нет ссылки на конкретный лист. <a href={receiptLink(preliminary!.receiptId)}>Открыть опись поступления</a></p>{/if}
          <PreliminaryRequirementAnalysis analysis={reportRow.analysis} retained={reportRow.retained} />
          <PreliminaryRowChange row={reportRow} changes={preliminary?.changes} />
        {:else}
          <p>{machineResult(active)}</p>
        {/if}
        {#if active.machine.citations.length}
          <EvidenceButtons citations={active.machine.citations} {open} compare={active.machine.outcome === 'confirmed_conflict'}
            actions={context.canEdit && !historicalVersion ? comparisonActions(active) : undefined} />
        {/if}
        {#if active.requirement.completeness}<p class="criterion-rule"><strong>Критерий достаточности</strong> · {active.requirement.completeness}</p>{/if}
        <details class="catalog-rule"><summary>Форматы по каталогу</summary>
        <p>Формат по каталогу · {(active.requirement.requiredFormats ?? active.requirement.formats?.filter((format) => !active.requirement.equivalentFormats?.includes(format)))?.join(', ').toUpperCase() || 'Не указан'}{active.requirement.equivalentFormats?.length ? ' · Допустимая замена: ' + active.requirement.equivalentFormats.join(', ').toUpperCase() : ''}</p>
        </details>
        </div>
        <div class="requirement-decision">
        {#if active.decision}
          {@const decision = active.decision}
          <p>{decision.action === 'revoke' ? 'Решение отменено' : 'Решение инженера'} · {label(active.outcome)} · {decision.reason}</p>
          <p class="meta">{view.name} · {decision.authorId} · {date(decision.createdAt)}</p>
          {#if decision.exclusion}
            <p>{decision.exclusion.kind === 'not_required' ? 'Не требуется' : 'Работаем без этих данных'}{#if decision.exclusion.until}{' · до '}{date(decision.exclusion.until)}{/if}</p>
          {/if}
          {#if decision.startWorkCritical}<p>Для начала работ</p>{/if}
        {/if}
        {#if context.canEdit && !historicalVersion && !view.questionHolds.some(({ questionId }) => questionId === active?.id)}
          <form class="question-decision" aria-label="Решение инженера по требованию" onsubmit={(event) => save(event, 'question')}>
            <h3>Ваше решение по требованию</h3>
            {#if active.machine.outcome === 'needs_review'}
              <p>Запишите, что осталось уточнить, или укажите, почему требование можно исключить.</p>
            {:else}
              <p>Сверьте по оригиналу вывод «{machineResult(active)}» и укажите основание решения.</p>
            {/if}
            <label>Действие по требованию
              <select bind:value={decisionAction} onchange={editDecision}>
                <option value="confirm">{active.machine.outcome === 'needs_review' ? 'Оставить на внутренней сверке' : 'Подтвердить формальный вывод'}</option>
                {#if active.machine.outcome !== 'needs_review' || decisionAction === 'correct'}<option value="correct">Вернуть на внутреннюю сверку</option>{/if}
                <option value="exclude">Отметить исключение</option>
                {#if active.decision && active.decision.action !== 'revoke'}<option value="revoke">Отменить решение</option>{/if}
              </select>
            </label>
            {#if decisionAction === 'exclude'}
              <label>Исключение
                <select bind:value={exclusionKind} onchange={editDecision}>
                  <option value="not_required">Не требуется</option>
                  <option value="work_without_data">Работаем без этих данных</option>
                </select>
              </label>
              <label>Действует до (местное время)<input type="datetime-local" bind:value={exclusionUntil} oninput={editDecision} /></label>
            {/if}
            {#if decisionAction !== 'revoke'}
              <label class="check"><input type="checkbox" checked={critical ?? active.decision?.startWorkCritical ?? false}
                onchange={(event) => { critical = event.currentTarget.checked; editDecision(); }} /> Без этих данных нельзя начать работы</label>
            {/if}
            {#if decisionAction === 'confirm' && mayRequestExternal}
              <label class="check"><input type="checkbox" bind:checked={requestExternal} onchange={editDecision} /> Добавить во внешние основания</label>
            {/if}
            <label>Основание решения
              <textarea required maxlength="2000" placeholder="Укажите документ и лист, результат сверки или что ещё нужно проверить" bind:this={decisionInput} bind:value={decisionReason} oninput={editDecision}></textarea>
            </label>
            {#if decisionVersion !== undefined && decisionVersion !== active.version}
              <p>Исходная версия {decisionVersion}. Текущая версия {active.version}.</p>
              <button type="button" onclick={() => { decisionVersion = active?.version; commandError = ''; commandConflict = false; }}>Сверил изменения строки</button>
            {/if}
            <div class="actions"><button class="primary" disabled={busy || staleView || !decisionReason.trim() || decisionVersion !== undefined && decisionVersion !== active.version}>Сохранить решение по требованию</button></div>
          </form>
        {:else if context.canEdit && !historicalVersion && view.questionHolds.some(({questionId}) => questionId === active?.id)}
          <p>Поступила досылка. Сверьте новое основание перед записью решения.</p>
          {#each view.questionHolds.find(({questionId}) => questionId === active?.id)?.receiptIds ?? [] as receiptId}
            <a href={receiptLink(receiptId)}>Открыть досылку</a>
          {/each}
        {:else if !active.decision}
          <p>Инженер ещё не записал решение по этому требованию.</p>
        {/if}
        {#key active.id}
          <ClarificationControl {api} question={active} editable={context.canEdit && !historicalVersion} refresh={renew} />
        {/key}
        {#if active.letterEligible}
          <a class="button primary" href={scopedUrl(context.project.id, 'letters', { context: view.assessmentContextId })}>Подготовить письмо по подтверждённым пунктам</a>
        {:else if mode === 'questions'}
          <a class="button" href={scopedUrl(context.project.id, 'completeness', { context: view.assessmentContextId, revision: historicalVersion }, active.id)}>Открыть требование в комплектности</a>
        {/if}
        {#if resultTarget === 'question'}
          {@render commandFeedback()}
        {/if}
        </div>
        </div>
        <details class="verification-details" open={current === 'partial' || current === 'remainder'}><summary>Подробности машинной и независимой проверки</summary>
        <p>Формальный машинный вывод · {machineResult(active)}</p>
        {#if active.machine.outcome === 'covered' && active.semanticRemainder?.state === 'open'}
          <p>По открытым источникам есть адресные опоры. Для вывода по всему требованию проверьте оставшиеся места и допустимые замены.</p>
        {/if}
        {#if active.requirement.applicability === 'unknown'}
          <p>Применимость требования требует подтверждения.</p>
        {/if}
        {#each active.machine.citations as citation}
          {#if citation.components?.length}
            <ul class="plain-list">
              {#each citation.components as component, index}
                <li><a href={componentLink(citation, index)}>{component.quote}</a></li>
              {/each}
            </ul>
          {/if}
        {/each}
        {#if active.semanticRemainder}
          {@const remainder = active.semanticRemainder}
          <h3>Независимая проверка содержания</h3>
          <p>Проверено {remainder.verifiedWindows} из {remainder.totalWindows} окон A/B · {remainder.state === 'open' ? 'Есть остаток' : 'Проверка окон завершена'}</p>
          {#if remainder.alternativesVerified !== undefined}
            <p>Альтернативы · {remainder.alternativesVerified ? 'Проверены' : 'Требуют сверки'}</p>
          {/if}
          {#if remainder.reasons.length}
            <ul class="plain-list">{#each remainder.reasons as item}<li>{contentReason(item, active)}</li>{/each}</ul>
          {/if}
          {#if remainder.items.length}
            <ul class="plain-list">
              {#each remainder.items as item}
                <li>
                  {#if context.canEdit}
                    <a href={remainderLink(item)}>{item.unitId ? 'Открыть место ' + item.unitId : 'Открыть версию оригинала'}</a>
                    ·
                  {:else if item.unitId}
                    Место {item.unitId} ·
                  {/if}
                  {reason(item.reason)}
                  {#if item.pendingBranches?.length}<span class="meta"> · ветви {item.pendingBranches.join(' и ')}</span>{/if}
                  <p>{item.nextAction}</p>
                </li>
              {/each}
            </ul>
          {/if}
          {#if remainder.omittedItems}<p>Ещё адресов с остатком · {remainder.omittedItems}</p>{/if}
        {/if}
        {#if active.machine.limitations?.length}<p class="meta">{active.machine.limitations.map((item) => contentReason(item, active!)).join(' · ')}</p>{/if}
        {#key active.id}
          <FacadeSupplementReview {api} question={active} canEdit={context.canEdit && !historicalVersion} refreshKey={context.refreshKey} {open} {renew} />
        {/key}
        </details>
      </section>
      {/if}
    {/snippet}
    {#if preliminaryError}<Notice kind="error" message={'Предварительный разбор · ' + preliminaryError + (preliminary ? '. Показан последний полученный результат.' : '')} />{/if}
    {#if preliminary && preliminaryProject === context.project.id && preliminary.catalogVersionId !== summary.catalogVersionId}<p class="notice">Предварительный разбор относится к другой версии каталога и не сопоставлен с этими требованиями.</p>{/if}
    {#if showTerra && view.kind !== 'common'}<p class="notice">Система оценила поступление целиком. Сверьте, какие источники относятся к выбранной области.</p>{/if}
    {#snippet filters()}
      {#if chooseTriage}
        <TriageBar value={current} {counts} {evidence} checked={view.questions.filter(requirementChecked).length} choose={chooseTriage}
          letterUrl={scopedUrl(context.project.id, 'letters', { context: view.assessmentContextId, scope: context.scopeId })} />
      {/if}
    {/snippet}
    {#snippet filterPanel()}
      {#if showTerra && chooseTriage}
      <details class="card" open={current !== 'all'}><summary>Фильтры по состоянию инженерной проверки</summary>{@render filters()}</details>
    {:else}{@render filters()}{/if}
    {/snippet}
    <section class="card table-card" aria-label="Комплектность по требованиям">
      <div class="matrix-intro"><div class="card-header"><h2>{mode === 'questions' ? 'Требования для внутренней сверки' : 'Требования'} · {view.kind === 'common' ? 'Весь комплект' : view.name}</h2></div>
      {#if summary.contexts.length > 1}<a href="#assessment-contexts">Выбрать другую область проверки</a>{/if}
      {#if showTerra}
        <div class="status-counts" aria-label="Результаты по требованиям">{#each reviewCounts as item (item.status)}<PreliminaryStatusBadge status={item.status} count={item.count} />{/each}</div>
      {/if}
      {#if questions.length && context.canEdit && !historicalVersion}
        <p>В строке «Сверить и решить» открываются источники и форма решения по этому требованию.</p>
      {/if}
      {@render filterPanel()}</div>
      {#if active && !questions.some(q => q.id === active?.id)}{@render selectedRequirement()}{/if}
      {#if questions.length}
        <div class="table-wrap matrix-wrap"><table>
          <thead><tr><th>Требование</th>{#if showTerra}<th>Что нашла система</th>{:else}<th>Формальный машинный вывод</th><th>Независимая проверка содержания</th>{/if}<th>Решение инженера</th></tr></thead>
          <tbody>
            {#each questions as question (question.id)}
              {@const reportRow = preliminaryFor(question)}
              <tr id={'matrix-row-' + question.id} class:selected-row={active?.id === question.id}>
                <td><a id={'requirement-' + question.id} data-triage-row data-inline-requirement={question.id} aria-expanded={active?.id === question.id} aria-controls={active?.id === question.id ? 'review-' + question.id : undefined} onclick={() => { inlineNavigation = true; }} href={url(view, active?.id === question.id ? undefined : question, context.filter)} aria-current={active?.id === question.id ? 'true' : undefined}>{requirementTitle(question.requirement)}</a></td>
                {#if showTerra}
                <td>{#if reportRow}
                  <PreliminaryStatusBadge status={reportRow.status} />
                  <span class="finding-preview">{reportRow.finding}</span>
                  {#if reportRow.retained}<small class="meta">В карточке есть основания из предыдущего разбора</small>{/if}
                  <PreliminaryRowChange row={reportRow} changes={preliminary?.changes} compact />
                {:else}Нет текущего разбора по позиции{/if}</td>
                {:else}
                <td>{machineResult(question)}</td>
                <td>{question.semanticRemainder
                  ? question.semanticRemainder.verifiedWindows + ' из ' + question.semanticRemainder.totalWindows +
                    (question.semanticRemainder.state === 'open' ? ' · есть остаток' :
                      question.machine.outcome === 'covered' && question.machine.limitations?.length ? ' · есть ограничения' : '')
                  : 'Нет данных независимой проверки в этой ревизии'}</td>
                {/if}
                <td>
                  {#if question.decision && question.decision.action !== 'revoke'}
                    <div>{label(question.decision.action === 'request_clarification' ? 'clarification' : question.decision.outcome)}</div>
                  {/if}
                  <a class="decision-link" data-inline-requirement={question.id} aria-expanded={active?.id === question.id} onclick={() => { inlineNavigation = true; }} href={url(view, active?.id === question.id ? undefined : question, context.filter)} aria-label={(active?.id === question.id ? 'Свернуть требование' : context.canEdit && !historicalVersion ? 'Сверить и решить' : 'Посмотреть основания') + ' · ' + requirementTitle(question.requirement)}>
                    {active?.id === question.id ? 'Свернуть' : context.canEdit && !historicalVersion ? 'Сверить и решить' : 'Посмотреть основания'}
                  </a>
                </td>
              </tr>
              {#if active?.id === question.id}
                <tr class="detail-row"><td colspan={showTerra ? 3 : 4}>{@render selectedRequirement()}</td></tr>
              {/if}
            {/each}
          </tbody>
        </table></div>
      {:else}
        <p class="empty">{mode === 'questions' ? 'Требований для внутренней сверки сейчас нет.' : context.filter ? 'В этом состоянии нет требований.' : 'Для этой области пока нет применимых требований.'}</p>
      {/if}
    </section>

    {#if view.facadeId}
      <section class="card" aria-label="Принадлежность и тип фасада">
        {#if view.identity?.sources.length}
          <h3>Основания принадлежности</h3>
          <p>{view.identity.state === 'independent' ? 'Подтверждено двумя ветвями' : view.identity.state === 'engineer'
            ? 'Уточнено инженером' : 'Установлено по адресной опоре одной ветви'}</p>
          <EvidenceButtons citations={view.identity.sources.map(({ citation }) => citation)} {open} />
        {/if}
        {#if view.conflictingTypes?.length}
          <h3>Разные типы в действующих оригиналах</h3>
          <p>Сверьте редакции и принадлежность опор перед подтверждением типа.</p>
          <EvidenceButtons citations={view.conflictingTypes.map(({ kind, citation }) => ({ ...citation, sourceLabel: kind }))} {open} />
        {/if}
        {#key view.facadeId}
          <FacadeTypeControl {api} {context} facade={view} assessmentVersion={summary.version}
            historical={Boolean(historicalVersion)} {open} refreshProject={refreshType} />
        {/key}
      </section>
    {/if}
    <details class="card" bind:open={conclusionOpen}>
      <summary>Заключение · {view.kind === 'common' ? 'Весь комплект' : view.name} · {view.conclusion ? label(view.conclusion.startWork) : view.previousConclusion ? 'Требуется пересмотр' : 'Ещё не записано'}</summary>
      <div class="card-header">
        {#if context.filter}<a href={url(view)}>Все состояния</a>{/if}
      </div>
      <dl class="details">
        <dt>Машинная оценка</dt><dd>{label(view.outcome)}</dd>
        <dt>Начало работ</dt><dd>{label(view.conclusion?.startWork, 'Ожидает решения')}</dd>
        {#if view.conclusion}
          <dt>Основание решения инженера</dt><dd>{view.conclusion.reason} · {date(view.conclusion.createdAt)}</dd>
          <ConclusionBasis {api} projectId={context.project.id} saved={view.conclusion} {open} />
          {#if view.conclusion.authorId}<dt>Автор</dt><dd>{view.conclusion.authorId}</dd>{/if}
          {#if view.conclusion.basedOnVersion}<dt>Версия оценки для заключения</dt><dd>{view.conclusion.basedOnVersion}</dd>{/if}
        {/if}
      </dl>
      {#if !view.conclusion && view.previousConclusion}
        {@const previous = view.previousConclusion}
        <p>{previous.reason}</p>
        <a href={scopedUrl(context.project.id, 'completeness', { context: view.assessmentContextId, revision: previous.assessmentVersion, panel: 'conclusion' })}>
          Предыдущее заключение · {label(previous.startWork)} · версия оценки {previous.basedOnVersion}
        </a>
      {/if}
      {#if context.canEdit && !historicalVersion && (summary.acceptedVersions ?? summary.activeWindows) > 0 && mode === 'matrix'}
        <form onsubmit={(event) => save(event, 'conclusion')}>
          <div class="form-row">
            <label>Можно ли начать работы
              <select required bind:value={startWork} onchange={() => conclusionVersion ??= view?.version}>
                <option value="">Выберите решение</option>
                <option value="can_start">Можно начать</option>
                <option value="cannot_start">Начинать нельзя</option>
                <option value="can_start_with_limitations">Можно начать с ограничениями</option>
              </select>
            </label>
            <label>Основание решения
              <textarea required bind:value={conclusionReason} oninput={() => conclusionVersion ??= view?.version}></textarea>
            </label>
          </div>
          {#key view.assessmentContextId}
            <ConclusionBasis {api} projectId={context.project.id} assessmentContextId={view.assessmentContextId} {open}
              bind:input={basis} citations={view.questions.flatMap((q) => q.machine.citations)} edit={() => conclusionVersion ??= view?.version} />
          {/key}
          {#if conclusionVersion !== undefined && conclusionVersion !== view.version}<p>Исходная версия {conclusionVersion}. Текущая версия {view.version}.</p><button type="button" onclick={() => { conclusionVersion = view?.version; commandError = ''; commandConflict = false; }}>Сверил изменения</button>{/if}
          <button class="primary" disabled={busy || staleView || !basis || conclusionVersion !== undefined && conclusionVersion !== view.version}>Сохранить заключение</button>
        </form>
      {/if}
    </details>

  {:else if !overview && contextId}
    <Notice message="Эта область недоступна в выбранной версии. Выберите доступную область проверки." />
  {/if}
  {#if summary.contexts.length !== 1 || !view}
  <section id="assessment-contexts" class="card table-card">
    <div class="card-header"><h2>Выберите область проверки</h2></div>
    {#if !summary.contexts.some(({ kind }) => kind === 'facade')}<p class="meta">Фасады пока не выявлены.</p>{/if}
    <div class="table-wrap">
      <table>
        <thead><tr><th>Контекст</th><th>Тип фасада</th><th>Проверено</th><th>Нехватка</th><th>Противоречия</th><th>Остаток проверки</th><th>Заключение инженера</th></tr></thead>
        <tbody>
          {#each summary.contexts as item (item.assessmentContextId)}
            <tr>
              <td>
                <a href={url(item, undefined, context.filter)} aria-current={view?.assessmentContextId === item.assessmentContextId ? 'true' : undefined}>{item.kind === 'common' ? 'Весь комплект' : item.name}</a>
                {#if item.facadeId && summary.observations}
                  <br /><a class="meta" href={observationLink('identified', item.facadeId)}>Сведения по фасаду</a>
                {/if}
              </td>
              <td>
                {#if item.kind === 'facade'}
                  {item.facadeType?.kind ?? 'Требуется подтверждение'}
                  {#if item.facadeType?.state === 'stale'}<br /><span class="meta">Опора требует сверки</span>{/if}
                {:else}—{/if}
              </td>
              <td><a href={url(item, undefined, 'checked')} aria-label={'Проверенные требования · ' + item.name}>{item.questions.filter(requirementChecked).length}</a></td>
              <td><a href={url(item, undefined, 'confirmed_missing')} aria-label={'Подтверждённая нехватка · ' + item.name}>{item.counts.confirmed_missing}</a></td>
              <td><a href={url(item, undefined, 'confirmed_conflict')} aria-label={'Подтверждённые противоречия · ' + item.name}>{item.counts.confirmed_conflict}</a></td>
              <td><a href={url(item, undefined, 'remainder')} aria-label={'Остаток проверки · ' + item.name}>{item.questions.filter(hasRemainder).length}</a></td>
              <td>{item.conclusion ? label(item.conclusion.startWork) : 'Ожидает решения'}</td>
            </tr>
          {/each}
        </tbody>
      </table>
    </div>
  </section>

  {/if}
  <details class="card"><summary>Что вошло в проверку</summary>
    <div class="card-header">
      {#if overview}<a class="button" href={url()}>Открыть оценку</a>{/if}
      {#if historicalVersion}<a href={scopedUrl(context.project.id, 'completeness', { context: contextId })}>К актуальной оценке</a>{/if}
    </div>
    <dl class="details">
      <dt>Машинная оценка</dt><dd>{label(summary.outcome)}</dd>
      <dt>Стадия</dt><dd>{summary.stage ?? 'Ожидает подтверждения'}</dd>
      {#if summary.profile}
        <dt>Рабочая матрица</dt>
        <dd>{summary.profile.state === 'active' && summary.catalog
          ? summary.catalog.name + ' · редакция ' + summary.catalog.revision : reason(summary.profile.state)}</dd>
        {#if summary.profile.confirmedKinds.length}
          <dt>Типы для выбора матрицы</dt><dd>{summary.profile.confirmedKinds.join(', ')}</dd>
        {/if}
      {/if}
      <dt>Технический снимок входных данных</dt><dd>№{summary.version}. Обновляется при изменении описи, участков чтения и оснований проверки.</dd>
      {#each Object.entries(coverageLabels) as [key, text] (key)}
        {@const boundary = summary.coverage[key as keyof FacadeAssessment['coverage']]}
        <dt>{text}</dt><dd>{boundary.complete ? 'Подтверждено' : reason(boundary.reason ?? 'needs_review')}</dd>
      {/each}
      <dt>Окна с подтверждённым охватом A/B</dt><dd>{summary.completedWindows} из {summary.activeWindows}</dd>
      {#if summary.structurallyReviewedWindows !== undefined}
        <dt>Структура проверена обеими ветвями</dt><dd>{summary.structurallyReviewedWindows} из {summary.activeWindows}</dd>
      {/if}
    </dl>
    {#if summary.limitations.length}
      <ul class="plain-list">{#each summary.limitations as limit (limit)}<li>{reason(limit)}</li>{/each}</ul>
    {/if}
    {#if !overview && !historicalVersion && summary.profile?.state !== 'active' && context.project.actions?.includes('project:manage')}
      <a href={scopedUrl(context.project.id, 'members', {})}>Управление стадией и рабочим каталогом</a>
    {/if}
  </details>

  {#if summary.observations && context.params.has('binding')}
    <section class="card">
      <div class="card-header"><h2>Сведения по привязке</h2></div>
      <ul class="plain-list">
        {#each Object.entries(observationLabels) as [binding, text] (binding)}
          <li><a href={observationLink(binding as Binding)}>{text} · {summary.observations.counts[binding as Binding]}</a></li>
        {/each}
      </ul>
      {#if context.params.has('binding')}
        <FacadeObservations {api} {context} {summary} {open} />
      {/if}
    </section>
  {/if}

  {#if !overview && (reviewItems.length || summary.comparisonReview?.limited)}
    <section class="card">
      <h2>Междокументные сверки</h2>
      {#each reviewItems as item (item.id)}
        <details>
          <summary>{item.property} · {reason(item.reasons[0])}</summary>
          {#if item.reasons.length > 1}
            <ul class="plain-list">{#each item.reasons.slice(1) as gap (gap)}<li>{reason(gap)}</li>{/each}</ul>
          {/if}
          <ul class="plain-list">
            {#each item.sources as source (source.citation.evidenceId)}
              <li>
                <strong>{source.citation.label ?? 'Оригинал'}</strong>
                {#if source.binding.candidates.length} · {source.binding.candidates.map(({ label }) => label).join(', ')}{/if}
                {#if source.variant} · исполнение {source.variant}{/if}
                {#if source.revision} · редакция {source.revision}{/if}
                {#if source.stage} · стадия {source.stage}{/if}
                {#if source.revisionStatus !== 'current' && !source.row?.drawingView} · действующая редакция требует сверки{/if}
                {#each source.clarification ?? [] as read (read.branch)}
                  {#if read.state === 'route_required'}
                    <div>Ветвь {read.branch}. Для адресного дочитывания требуется доступ к закреплённому маршруту.</div>
                  {:else}
                    <div>Адресное дочитывание {read.branch} · {clarificationLabels[read.state]}</div>
                  {/if}
                {/each}
                {#if source.row}
                  <div>
                    Ветвь {source.citation.branch} ·
                    {#if source.row.value.address.locator?.cell}
                      {source.row.value.address.locator.sheet}!{source.row.value.address.locator.cell}
                    {:else}
                      стр. {source.row.value.address.locator?.page}, строка {source.row.value.lineId}
                    {/if}
                  </div>
                  <blockquote>{source.row.value.quote}</blockquote>
                  {#if source.row.context.quote !== source.row.value.quote}
                    <blockquote>{source.row.context.quote}</blockquote>
                  {/if}
                  {#if source.row.context.evidenceId !== source.citation.evidenceId}
                    <EvidenceButtons citations={[{ ...source.row.context, branch: source.citation.branch,
                      documentId: source.citation.documentId, versionId: source.citation.versionId,
                      sha256: source.citation.sha256, sourceLabel: 'Контекст строки' }]} {open} />
                  {/if}
                  {#if source.row.drawingView}
                    {@const view = source.row.drawingView}
                    <p>Исполнение {view.variant.value} указано для марки {view.variant.mark} в этом виде.</p>
                    <blockquote>{view.title.quote}<br />{view.scope.quote}<br />{view.variant.citation.quote}</blockquote>
                    <p>
                      Редакция {view.revision.value} отмечена как действующая в заголовке этого листа.
                      {#if view.stage}В заголовке указана стадия {view.stage}.{/if}
                    </p>
                    <blockquote>{view.revision.citation.quote}</blockquote>
                    <EvidenceButtons citations={[
                      { ...view.title, sourceLabel: 'Название вида' }, { ...view.scope, sourceLabel: 'Область вида' },
                      { ...view.variant.citation, sourceLabel: 'Марка и исполнение' },
                      { ...view.revision.citation, sourceLabel: 'Редакция листа' },
                    ].map((citation) => ({ ...citation, branch: source.citation.branch, documentId: source.citation.documentId,
                      versionId: source.citation.versionId, sha256: source.citation.sha256 }))} {open} />
                  {/if}
                {:else if source.citation.quote}
                  <blockquote>{source.citation.quote}</blockquote>
                {/if}
              </li>
            {/each}
          </ul>
          <EvidenceButtons citations={item.sources.map(({ citation, sourceRole }) => ({ ...citation, sourceLabel: citation.label, sourceRole }))} {open} compare />
        </details>
      {/each}
      {#if summary.comparisonReview?.limited}<p>Проверена только часть сочетаний источников.</p>{/if}
    </section>
  {/if}

  {#if !overview && summary.unresolvedMentions?.items.length}
    <section class="card">
      <h2>Упоминания без установленного фасада</h2>
      <p>Найдите вторую адресную опору с проектным идентификатором либо обозначением корпуса и осей.</p>
      <ul class="plain-list">
        {#each summary.unresolvedMentions.items as item}
          <li>
            {item.label} · {item.citation.quote}
            <EvidenceButtons citations={[item.citation]} {open} />
          </li>
        {/each}
      </ul>
      {#if summary.unresolvedMentions.limited}<p>Показана часть адресных упоминаний.</p>{/if}
    </section>
  {/if}

  {#if !active || resultTarget === 'conclusion'}
          {@render commandFeedback()}
  {/if}
{/if}

<style>
  .status-counts { display: flex; flex-wrap: wrap; align-items: center; gap: .5rem; margin-block: .5rem; }
  .decision-link { display: inline-block; padding-block: .3rem; white-space: nowrap; }
  .verification-details { margin-block-start: 1rem; border-block-start: 1px solid var(--line); padding-block-start: .75rem; }
  .finding-preview { display: -webkit-box; line-clamp: 2; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; color: var(--muted); font-size: .9rem; }
  .criterion-rule { border-inline-start: 2px solid var(--line); padding-inline-start: .6rem; }
  @media (max-width: 700px) {
    .matrix-wrap table, .matrix-wrap tbody, .matrix-wrap tr, .matrix-wrap td { display: block; width: 100%; box-sizing: border-box; }
    .matrix-wrap thead { position: absolute; width: 1px; height: 1px; overflow: hidden; clip-path: inset(50%); }
    .matrix-wrap tr { border-block-start: 1px solid var(--line); }
    .matrix-wrap td { padding: .35rem .8rem; border: 0; }
    .matrix-wrap .detail-row > td { padding: 0; }
    .matrix-wrap .finding-preview { margin-block-start: .2rem; }
  }
  .matrix-intro { padding: 1rem; }
  .matrix-intro .card-header { padding: 0; }
  .matrix-intro p { margin: .5rem 0; }
  .matrix-intro details { margin: .6rem 0 0; }
  .selected-row, .selected-row:hover { background: #edf5f4; }
  .detail-row > td { padding: 0; }
  .requirement-detail { background: var(--paper); border-inline-start: 3px solid var(--accent); padding: clamp(.75rem, 2vw, 1.5rem); white-space: normal; overflow-wrap: anywhere; }
  .review-header { display: flex; justify-content: space-between; align-items: baseline; gap: 1rem; margin-bottom: 1rem; }
  .review-header h2 { margin: 0; font-size: 1.12rem; }
  .close-requirement { flex-shrink: 0; }
  .requirement-review-grid { display: grid; grid-template-columns: minmax(0, 1.15fr) minmax(0, 1fr); gap: 1.25rem; align-items: start; }
  .requirement-review-grid h3 { margin: 0 0 .55rem; font-size: 1rem; }
  .requirement-review-grid h4 { font-size: .94rem; margin: .8rem 0 .25rem; }
  .requirement-review-grid p { margin: .45rem 0; }
  .requirement-evidence ul { padding-inline-start: 1.2rem; margin: .35rem 0; }
  .requirement-evidence li { margin-block: .4rem; }
  .catalog-rule { margin-top: 1rem; }
  .requirement-decision { background: var(--field); border: 1px solid var(--line); border-radius: .45rem; padding: .9rem; min-width: 0; }
  .question-decision { display: grid; gap: .55rem; }
  .question-decision textarea, .question-decision select { width: 100%; min-width: 0; }
  @media (max-width: 800px) {
    .requirement-review-grid { grid-template-columns: minmax(0, 1fr); }
    .review-header { flex-wrap: wrap; gap: .4rem; }
  }
</style>
