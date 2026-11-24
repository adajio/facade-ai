<script lang="ts">
  import { Commands } from '../lib/commands';
  import { tick } from 'svelte';
  import TriageBar from '../lib/TriageBar.svelte';
  import { bucket, triageCounts, type Triage } from '../lib/triage';
  import { conflictMessage } from '../lib/conflict';
  import { date, label } from '../lib/format';
  import { describe, id, interrupted, type Api } from '../lib/http';
  import { assessmentReasons, clarificationLabels, coverageLabels, observationLabels, type Binding, type FacadeAssessment, type FacadeContext } from '../lib/facade-assessment';
  import { projectV1, scopedUrl, V1, type AssessmentQuestion, type OpenEvidence, type WorkspaceProps } from '../lib/workspace';
  import EvidenceButtons from '../lib/EvidenceButtons.svelte';
  import Notice from '../lib/Notice.svelte';
  import FacadeTypeControl from './FacadeTypeControl.svelte';
  import FacadeObservations from './FacadeObservations.svelte';
  import ClarificationControl from '../lib/ClarificationControl.svelte';

  let { api, context, open, renew, refreshProject, overview = false, overviewVersion, triage, chooseTriage, mode = 'matrix' }: {
    api: Api; context: WorkspaceProps; open: OpenEvidence; renew: () => void; refreshProject?: () => Promise<void>; overview?: boolean; overviewVersion?: number;
    triage?: Triage; chooseTriage?: (value: Triage) => void;
    mode?: 'matrix' | 'facts' | 'questions';
  } = $props();
  const commands = new Commands(() => api);
  let summary = $state<FacadeAssessment>();
  let problem = $state('');
  let contextId = $derived(context.params.get('context') ?? '');
  let view = $derived(summary?.contexts.find((item) => item.assessmentContextId === contextId));
  let counts = $derived(triageCounts(view?.questions ?? summary?.contexts.flatMap((item) => item.questions) ?? []));
  let current = $derived(mode === 'questions' ? 'review' : triage ?? (counts.review ? 'review' : counts.letter ? 'letter' : 'done'));
  let questions = $derived(view?.questions.filter((item) => context.filter ? item.outcome === context.filter
    : item.id === context.objectId && !triage || bucket(item) === current) ?? []);
  let active = $derived(questions.find((item) => item.id === context.objectId));
  let reviewItems = $derived(summary?.comparisonReview?.items.filter((item) =>
    !view?.facadeId || !item.facadeId || item.facadeId === view.facadeId) ?? []);
  let busy = $state(false);
  let result = $state('');
  let commandError = $state('');
  let startWork = $state('');
  let conclusionReason = $state('');
  let conclusionVersion = $state<number>();
  let requestExternal = $state(false);
  let decisionReason = $state('');
  let decisionVersion = $state<number>();
  let decisionAction = $state<'confirm' | 'correct'>('confirm');
  let decisionInput = $state<HTMLTextAreaElement>();
  let requestFocus = $derived(context.objectId || contextId);
  let historicalVersion = $derived(context.params.get('revision') ?? '');

  $effect(() => {
    const projectId = context.project.id;
    const version = historicalVersion || overviewVersion;
    const path = projectV1(projectId) + '/facade-assessment' + (version ? '/' + id(version) : '');
    if (!overviewVersion) void context.refreshKey;
    const controller = new AbortController();
    problem = '';
    void api.json<FacadeAssessment>(path, {
      signal: controller.signal,
    }).then((value) => {
      if (value.projectId !== projectId) {
        summary = undefined;
        problem = 'Сводка относится к другому проекту.';
      } else summary = value;
    }).catch((error) => {
      if (controller.signal.aborted || interrupted(error)) return;
      summary = undefined;
      problem = describe(error);
    });
    return () => controller.abort();
  });

  $effect(() => {
    void requestFocus;
    startWork = '';
    conclusionReason = '';
    conclusionVersion = undefined;
    requestExternal = false;
    decisionAction = 'confirm';
    decisionReason = '';
    decisionVersion = undefined;
    commandError = '';
    result = '';
  });

  function url(ctx?: FacadeContext, question?: AssessmentQuestion, filter?: string) {
    return scopedUrl(context.project.id, mode === 'questions' ? 'questions' : 'completeness', {
      context: ctx?.assessmentContextId, filter, revision: historicalVersion || (ctx ? overviewVersion : undefined), slice: context.params.get('slice'),
    }, question?.id);
  }

  function observationLink(binding?: Binding, facadeId?: string | null) {
    return scopedUrl(context.project.id, mode === 'facts' ? 'facts' : 'completeness', {
      binding, facadeId, revision: summary?.version, context: mode === 'facts' ? contextId : undefined,
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

  function reason(value: string) {
    return assessmentReasons[value] ?? label(value);
  }

  function prepareDecision(question: AssessmentQuestion, confirmation: boolean) {
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

  async function save(event: SubmitEvent, kind: 'conclusion' | 'question') {
    event.preventDefault();
    if (!view || busy || historicalVersion) return;
    const selectedView = view;
    const selectedQuestion = active;
    const version = kind === 'question' ? decisionVersion ?? selectedQuestion?.version : conclusionVersion ?? selectedView.version;
    if (version === undefined || kind === 'question' && !selectedQuestion) return;
    busy = true;
    commandError = '';
    result = '';
    try {
      if (kind === 'question' && selectedQuestion) {
        await commands.send(V1 + '/questions/' + id(selectedQuestion.id) + '/decisions', 'POST', {
          action: decisionAction, reason: decisionReason, requestExternal,
          ...(decisionAction === 'correct' ? { outcome: 'needs_review' } : {}),
        }, version);
        decisionReason = '';
        decisionVersion = undefined;
        decisionAction = 'confirm';
        requestExternal = false;
      } else {
        await commands.send(projectV1(context.project.id) + '/conclusions', 'POST', {
          assessmentContextId: selectedView.assessmentContextId, startWork, reason: conclusionReason,
        }, version);
        conclusionVersion = undefined;
        conclusionReason = '';
        startWork = '';
      }
      result = 'Решение сохранено.';
    } catch (error) {
      commandError = conflictMessage(error, version);
    } finally {
      busy = false;
      renew();
    }
  }
</script>

<Notice kind="error" message={problem && 'Сводка оценки · ' + problem} />
{#if !summary && !problem}<p class="card" role="status">Загружаем сводку оценки…</p>{/if}
{#if summary && mode === 'facts'}
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
    <FacadeObservations {api} {context} {summary} {open} facts preselectedFacade={view?.facadeId} />
  </section>
{:else if summary}
  <section class="card">
    <div class="card-header">
      <h2>{overview ? 'Оценка комплекта' : 'Граница оценки'}</h2>
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
      <dt>Ревизия оценки</dt><dd>{summary.version}</dd>
      {#each Object.entries(coverageLabels) as [key, text] (key)}
        {@const boundary = summary.coverage[key as keyof FacadeAssessment['coverage']]}
        <dt>{text}</dt><dd>{boundary.complete ? 'Подтверждено' : reason(boundary.reason ?? 'needs_review')}</dd>
      {/each}
      <dt>Завершённые окна A/B</dt><dd>{summary.completedWindows} из {summary.activeWindows}</dd>
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
  </section>

  {#if summary.observations}
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

  {#if !view && chooseTriage && !context.filter}
    <TriageBar value={current} {counts} choose={chooseTriage}
      letterUrl={scopedUrl(context.project.id, 'letters', { scope: context.scopeId })} />
  {/if}
  <section class="card table-card">
    <div class="card-header"><h2>Выявленные фасады и общий уровень</h2></div>
    {#if !summary.contexts.some(({ kind }) => kind === 'facade')}<p class="meta">Фасады пока не выявлены.</p>{/if}
    <div class="table-wrap">
      <table>
        <thead><tr><th>Контекст</th><th>Тип фасада</th><th>Проверено</th><th>Нехватка</th><th>Противоречия</th><th>Требуется сверка</th><th>Заключение инженера</th></tr></thead>
        <tbody>
          {#each summary.contexts as item (item.assessmentContextId)}
            <tr>
              <td>
                <a href={url(item)} aria-current={view?.assessmentContextId === item.assessmentContextId ? 'true' : undefined}>{item.name}</a>
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
              <td><a href={url(item, undefined, 'covered')} aria-label={'Проверенные требования · ' + item.name}>{item.counts.covered}</a></td>
              <td><a href={url(item, undefined, 'confirmed_missing')} aria-label={'Подтверждённая нехватка · ' + item.name}>{item.counts.confirmed_missing}</a></td>
              <td><a href={url(item, undefined, 'confirmed_conflict')} aria-label={'Подтверждённые противоречия · ' + item.name}>{item.counts.confirmed_conflict}</a></td>
              <td><a href={url(item, undefined, 'needs_review')} aria-label={'Требуют сверки · ' + item.name}>{item.counts.needs_review}</a></td>
              <td>{item.conclusion ? label(item.conclusion.startWork) : 'Ожидает решения'}</td>
            </tr>
          {/each}
        </tbody>
      </table>
    </div>
  </section>

  {#if !overview && view}
    <section class="card">
      <div class="card-header">
        <h2>{view.name}</h2>
        {#if context.filter}<a href={url(view)}>Все состояния</a>{/if}
      </div>
      <dl class="details">
        <dt>Машинная оценка</dt><dd>{label(view.outcome)}</dd>
        <dt>Начало работ</dt><dd>{label(view.conclusion?.startWork, 'Ожидает решения')}</dd>
        {#if view.conclusion}
          <dt>Основание решения инженера</dt><dd>{view.conclusion.reason} · {date(view.conclusion.createdAt)}</dd>
          {#if view.conclusion.authorId}<dt>Автор</dt><dd>{view.conclusion.authorId}</dd>{/if}
        {/if}
      </dl>
      {#if view.facadeId}
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
        {:else}
          {#key view.facadeId}
            <FacadeTypeControl {api} {context} facade={view} assessmentVersion={summary.version}
              historical={Boolean(historicalVersion)} {open} refreshProject={refreshType} />
          {/key}
        {/if}
      {/if}
      {#if context.canEdit && !historicalVersion && view.questions.length}
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
          <button class="primary" disabled={busy}>Сохранить заключение</button>
        </form>
      {/if}
    </section>

    {#if chooseTriage && !context.filter}
      <TriageBar value={current} {counts} choose={chooseTriage}
        letterUrl={scopedUrl(context.project.id, 'letters', { context: view.assessmentContextId, scope: context.scopeId })} />
    {/if}
    <section class="card table-card">
      <div class="card-header"><h2>Обязательные части</h2></div>
      {#if questions.length}
        <div class="table-wrap"><table>
          <thead><tr><th>Требование</th><th>Машинный вывод</th><th>Проверка содержания</th><th>Решение инженера</th></tr></thead>
          <tbody>
            {#each questions as question (question.id)}
              <tr>
                <td><a data-triage-row href={url(view, question, context.filter)} aria-current={active?.id === question.id ? 'true' : undefined}>{question.requirement.subject} · {question.requirement.part}</a></td>
                <td>{label(question.machine.outcome)}</td>
                <td>{question.semanticRemainder
                  ? question.semanticRemainder.verifiedWindows + ' из ' + question.semanticRemainder.totalWindows +
                    (question.semanticRemainder.state === 'open' ? ' · есть остаток' : '')
                  : 'Данные отсутствуют в этой ревизии'}</td>
                <td>{label(question.decision?.action === 'request_clarification' ? 'clarification' : question.decision?.outcome,
                  'Ожидает решения')}</td>
              </tr>
            {/each}
          </tbody>
        </table></div>
      {:else}
        <p class="empty">{context.filter ? 'В этом состоянии нет требований.' : 'Для этого контекста пока нет применимых требований.'}</p>
      {/if}
    </section>

    {#if active}
      <section class="card">
        <h2>{active.requirement.subject} · {active.requirement.part}</h2>
        <p>Машинный вывод · {label(active.machine.outcome)}</p>
        {#if active.requirement.applicability === 'unknown'}
          <p>Применимость требования требует подтверждения.</p>
        {/if}
        <EvidenceButtons citations={active.machine.citations} {open} compare={active.machine.outcome === 'confirmed_conflict'}
          actions={context.canEdit && !historicalVersion ? comparisonActions(active) : undefined} />
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
          <h3>Проверка содержания</h3>
          <p>{remainder.verifiedWindows} из {remainder.totalWindows} окон · {remainder.state === 'open' ? 'Есть остаток' : 'Проверка завершена'}</p>
          {#if remainder.alternativesVerified !== undefined}
            <p>Альтернативы · {remainder.alternativesVerified ? 'Проверены' : 'Требуют сверки'}</p>
          {/if}
          {#if remainder.reasons.length}
            <ul class="plain-list">{#each remainder.reasons as item}<li>{reason(item)}</li>{/each}</ul>
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
        {#if active.machine.limitations?.length}<p class="meta">{active.machine.limitations.map(reason).join(' · ')}</p>{/if}
        {#each view.questionHolds.find(({ questionId }) => questionId === active?.id)?.receiptIds ?? [] as receiptId (receiptId)}
          <p><a href={receiptLink(receiptId)}>Открыть досылку для пересмотра основания</a></p>
        {/each}
        {#if active.decision && active.decision.action !== 'request_clarification'}
          <p>Решение инженера · {label(active.decision.outcome)} · {active.decision.reason} · {date(active.decision.createdAt)}</p>
        {/if}
        {#key active.id}
          <ClarificationControl {api} question={active} editable={context.canEdit && !historicalVersion} refresh={renew} />
        {/key}
        {#if context.canEdit && !historicalVersion && ['confirmed_missing', 'confirmed_conflict'].includes(active.machine.outcome)}
          <form onsubmit={(event) => save(event, 'question')}>
            <label>Основание подтверждения
              <textarea required bind:this={decisionInput} bind:value={decisionReason} oninput={() => decisionVersion ??= active?.version}></textarea>
            </label>
            {#if decisionAction === 'confirm'}
              <label class="check"><input type="checkbox" bind:checked={requestExternal} onchange={() => decisionVersion ??= active?.version} /> Добавить во внешние основания</label>
            {/if}
            <div class="actions"><button class="primary" disabled={busy}>{decisionAction === 'confirm' ? 'Подтвердить результат' : 'Вернуть на внутреннюю сверку'}</button></div>
          </form>
        {/if}
        <a class="button" href={scopedUrl(context.project.id, 'letters', { context: view.assessmentContextId })}>К письмам по контексту</a>
      </section>
    {/if}
  {:else if !overview && contextId}
    <Notice message="Контекст отсутствует в этой ревизии оценки. Выберите контекст из таблицы." />
  {/if}
  <Notice kind="error" message={commandError} />
  <Notice kind="success" message={result} />
{/if}
