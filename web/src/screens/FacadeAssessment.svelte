<script lang="ts">
  import { Commands } from '../lib/commands';
  import { conflictMessage } from '../lib/conflict';
  import { date, label } from '../lib/format';
  import { describe, id, interrupted, type Api } from '../lib/http';
  import { assessmentReasons, coverageLabels, observationLabels, type Binding, type FacadeAssessment, type FacadeContext } from '../lib/facade-assessment';
  import { projectV1, scopedUrl, V1, type AssessmentQuestion, type OpenEvidence, type WorkspaceProps } from '../lib/workspace';
  import EvidenceButtons from '../lib/EvidenceButtons.svelte';
  import Notice from '../lib/Notice.svelte';
  import FacadeObservations from './FacadeObservations.svelte';

  let { api, context, open, renew, overview = false, overviewVersion }: {
    api: Api; context: WorkspaceProps; open: OpenEvidence; renew: () => void; overview?: boolean; overviewVersion?: number;
  } = $props();
  const commands = new Commands(() => api);
  let summary = $state<FacadeAssessment>();
  let problem = $state('');
  let contextId = $derived(context.params.get('context') ?? '');
  let view = $derived(summary?.contexts.find((item) => item.assessmentContextId === contextId));
  let questions = $derived(view?.questions.filter((item) => !context.filter || item.outcome === context.filter) ?? []);
  let active = $derived(questions.find((item) => item.id === context.objectId));
  let busy = $state(false);
  let result = $state('');
  let commandError = $state('');
  let startWork = $state('');
  let conclusionReason = $state('');
  let conclusionVersion = $state<number>();
  let requestExternal = $state(false);
  let decisionReason = $state('');
  let decisionVersion = $state<number>();
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
    decisionReason = '';
    decisionVersion = undefined;
    commandError = '';
    result = '';
  });

  function url(ctx?: FacadeContext, question?: AssessmentQuestion, filter?: string) {
    return scopedUrl(context.project.id, 'completeness', {
      context: ctx?.assessmentContextId, filter, revision: historicalVersion || (ctx ? overviewVersion : undefined), slice: context.params.get('slice'),
    }, question?.id);
  }

  function observationLink(binding: Binding, facadeId?: string | null) {
    return scopedUrl(context.project.id, 'completeness', { binding, facadeId, revision: summary?.version });
  }

  function receiptLink(receiptId: string) {
    return scopedUrl(context.project.id, 'receipts', {}, receiptId);
  }

  function reason(value: string) {
    return assessmentReasons[value] ?? label(value);
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
          action: 'confirm', reason: decisionReason, requestExternal,
        }, version);
        decisionReason = '';
        decisionVersion = undefined;
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
{#if summary}
  <section class="card">
    <div class="card-header">
      <h2>{overview ? 'Оценка комплекта' : 'Граница оценки'}</h2>
      {#if overview}<a class="button" href={url()}>Открыть оценку</a>{/if}
      {#if historicalVersion}<a href={scopedUrl(context.project.id, 'completeness', { context: contextId })}>К актуальной оценке</a>{/if}
    </div>
    <dl class="details">
      <dt>Машинная оценка</dt><dd>{label(summary.outcome)}</dd>
      <dt>Стадия</dt><dd>{summary.stage ?? 'Ожидает подтверждения'}</dd>
      <dt>Ревизия оценки</dt><dd>{summary.version}</dd>
      {#each Object.entries(coverageLabels) as [key, text] (key)}
        {@const boundary = summary.coverage[key as keyof FacadeAssessment['coverage']]}
        <dt>{text}</dt><dd>{boundary.complete ? 'Подтверждено' : reason(boundary.reason ?? 'needs_review')}</dd>
      {/each}
      <dt>Проверенные окна A/B</dt><dd>{summary.completedWindows} из {summary.activeWindows}</dd>
    </dl>
    {#if summary.limitations.length}
      <ul class="plain-list">{#each summary.limitations as limit (limit)}<li>{reason(limit)}</li>{/each}</ul>
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

  <section class="card table-card">
    <div class="card-header"><h2>Выявленные фасады и общий уровень</h2></div>
    {#if !summary.contexts.some(({ kind }) => kind === 'facade')}<p class="meta">Фасады пока не выявлены.</p>{/if}
    <div class="table-wrap">
      <table>
        <thead><tr><th>Контекст</th><th>Проверено</th><th>Нехватка</th><th>Противоречия</th><th>Требуется сверка</th><th>Заключение инженера</th></tr></thead>
        <tbody>
          {#each summary.contexts as item (item.assessmentContextId)}
            <tr>
              <td>
                <a href={url(item)} aria-current={view?.assessmentContextId === item.assessmentContextId ? 'true' : undefined}>{item.name}</a>
                {#if item.facadeId && summary.observations}
                  <br /><a class="meta" href={observationLink('identified', item.facadeId)}>Сведения по фасаду</a>
                {/if}
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

    <section class="card table-card">
      <div class="card-header"><h2>Обязательные части</h2></div>
      {#if questions.length}
        <div class="table-wrap"><table>
          <thead><tr><th>Требование</th><th>Машинный вывод</th><th>Решение инженера</th></tr></thead>
          <tbody>
            {#each questions as question (question.id)}
              <tr>
                <td><a href={url(view, question, context.filter)} aria-current={active?.id === question.id ? 'true' : undefined}>{question.requirement.subject} · {question.requirement.part}</a></td>
                <td>{label(question.machine.outcome)}</td>
                <td>{label(question.decision?.outcome, 'Ожидает решения')}</td>
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
        <EvidenceButtons citations={active.machine.citations} {open} />
        {#if active.machine.limitations?.length}<p class="meta">{active.machine.limitations.map(reason).join(' · ')}</p>{/if}
        {#each view.questionHolds.find(({ questionId }) => questionId === active?.id)?.receiptIds ?? [] as receiptId (receiptId)}
          <p><a href={receiptLink(receiptId)}>Открыть досылку для пересмотра основания</a></p>
        {/each}
        {#if active.decision}
          <p>Решение инженера · {label(active.decision.outcome)} · {active.decision.reason} · {date(active.decision.createdAt)}</p>
        {/if}
        {#if context.canEdit && !historicalVersion && ['confirmed_missing', 'confirmed_conflict'].includes(active.machine.outcome)}
          <form onsubmit={(event) => save(event, 'question')}>
            <label>Основание подтверждения
              <textarea required bind:value={decisionReason} oninput={() => decisionVersion ??= active?.version}></textarea>
            </label>
            <label class="check"><input type="checkbox" bind:checked={requestExternal} onchange={() => decisionVersion ??= active?.version} /> Добавить во внешние основания</label>
            <div class="actions"><button class="primary" disabled={busy}>Подтвердить результат</button></div>
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
