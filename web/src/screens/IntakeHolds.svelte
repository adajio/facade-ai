<script lang="ts">
  import { Commands } from '../lib/commands';
  import { conflictMessage } from '../lib/conflict';
  import { describe, id, type Api } from '../lib/http';
  import { projectApi, projectV1, scopedUrl, type Assessment, type IntakeHold, type Projection, type ScopeProjection, type WorkspaceProps } from '../lib/workspace';
  import Notice from '../lib/Notice.svelte';

  type Impact = {
    scopeId: string; assessmentVersion: number | null; questionIds: string[]; reviewed: boolean;
    questions: Assessment['questions'];
  };

  let { api, context, projection, receiptId, renew }: {
    api: Api; context: WorkspaceProps; projection?: Projection; receiptId: string; renew: () => void;
  } = $props();

  const commands = new Commands(() => api);
  let available = $derived(holdsIn(projection).filter((hold) => !receiptId || hold.receiptId === receiptId));
  let selection = $state<IntakeHold>();
  let mode = $state<'classify' | 'resolve'>();
  let checked = $state<string[]>([]);
  let impacts = $state<Impact[]>([]);
  let reason = $state('');
  let busy = $state(false);
  let error = $state('');
  let status = $state('');
  let needsReview = $state(false);
  let base = $derived(projectApi(context.project.id));
  let namedScopes = $derived(new Map(context.project.scopes.map((scope) => [scope.id, scope.name])));

  function holdsIn(snapshot?: Projection) {
    const causes = snapshot?.holds ?? snapshot?.scopes?.flatMap((scope) => scope.holds) ?? [];
    return [...new Map(causes.map((cause) => [cause.id, cause])).values()];
  }

  function holdPath(hold: IntakeHold) {
    return base + '/supplements/holds/' + id(hold.id);
  }

  function classify(hold: IntakeHold) {
    selection = hold;
    checked = hold.scopeIds ? [...hold.scopeIds] : [];
    mode = 'classify';
    reason = '';
    status = '';
    error = '';
    needsReview = false;
  }

  async function resolve(hold: IntakeHold, retain = false) {
    if (busy || !hold.scopeIds?.length) return;
    busy = true;
    status = '';
    error = '';
    needsReview = false;
    try {
      const snap = await api.json<Projection>(base + '/snapshot');
      const current = holdsIn(snap).find((item) => item.id === hold.id);
      if (!current?.scopeIds?.length) {
        selection = undefined;
        mode = undefined;
        status = 'Причина уже рассмотрена или ждёт классификации.';
        renew();
        return;
      }
      const prior = new Map(impacts.map((impact) => [impact.scopeId, impact]));
      const scopes = new Map((snap.scopes ?? []).map((scope) => [scope.id, scope]));
      const result: Impact[] = [];
      for (const scopeId of current.scopeIds) {
        const scope = scopes.get(scopeId) as ScopeProjection | undefined;
        if (!scope) throw new Error('Снимок не содержит одну из удержанных областей.');
        const version = scope.assessmentVersion;
        const questions = version == null ? [] : (await api.json<Assessment>(
          projectV1(context.project.id) + '/assessments/' + id(version) + '?scopeId=' + id(scopeId),
        )).questions;
        const selected = retain ? prior.get(scopeId)?.questionIds : undefined;
        result.push({
          scopeId, assessmentVersion: version, questions, reviewed: false,
          questionIds: selected?.filter((questionId) => questions.some((item) => item.id === questionId)) ?? [],
        });
      }
      selection = current;
      impacts = result;
      if (!retain) reason = '';
      mode = 'resolve';
    } catch (problem) {
      error = describe(problem);
    } finally {
      busy = false;
    }
  }

  async function submit(event: SubmitEvent) {
    event.preventDefault();
    if (!selection || busy) return;
    const hold = selection;
    const version = hold.version;
    busy = true;
    status = '';
    error = '';
    try {
      if (mode === 'classify') {
        if (!checked.length) return;
        await commands.send(holdPath(hold), 'PATCH', { generation: hold.generation, scopeIds: checked }, version);
        status = 'Применимость поступления уточнена.';
      } else {
        if (!impacts.length || impacts.some((item) => !item.reviewed)) return;
        await commands.send(holdPath(hold) + '/resolve', 'POST', {
          generation: hold.generation,
          reason,
          impacts: impacts.map(({ scopeId, assessmentVersion, questionIds }) => ({ scopeId, assessmentVersion, questionIds })),
        }, version);
        status = 'Проверка влияния сохранена. Затронутые вопросы возвращены на сверку.';
      }
      selection = undefined;
      mode = undefined;
      renew();
    } catch (problem) {
      error = conflictMessage(problem, version);
      needsReview = true;
      renew();
    } finally {
      busy = false;
    }
  }

  function refreshInput() {
    if (!selection) return;
    if (mode === 'resolve') void resolve(selection, true);
    else {
      const current = available.find((item) => item.id === selection?.id);
      if (!current) {
        status = 'Причина больше не действует.';
        selection = undefined;
        mode = undefined;
      } else {
        checked = checked.filter((scopeId) => !current.scopeIds || current.scopeIds.includes(scopeId));
        selection = current;
      }
      needsReview = false;
    }
  }
</script>

{#if available.length || selection || status || error}
  <section class="card">
    <h2>Удержания по поступлениям</h2>
    <ul class="plain-list">
      {#each available as hold (hold.id)}
        <li>
          <strong>{hold.reason ?? (hold.scopeIds ? 'Проверка влияния' : 'Применимость пока не определена')}</strong>
          <p class="meta">{hold.source === 'import' ? 'Импорт' : 'Декларация файла'} · поколение {hold.generation} · версия {hold.version}</p>
          {#if hold.scopeIds?.length}<p>{hold.scopeIds.map((scopeId) => namedScopes.get(scopeId) ?? scopeId).join(', ')}</p>{/if}
          <div class="actions">
            {#if !receiptId && hold.receiptId}
              <a class="button" href={scopedUrl(context.project.id, 'receipts', { scope: context.scopeId }, hold.receiptId)}>Открыть поступление</a>
            {/if}
            {#if context.canEdit}
              <button type="button" disabled={busy} onclick={() => classify(hold)}>Уточнить область</button>
              {#if hold.scopeIds?.length}
                <button type="button" disabled={busy} onclick={() => resolve(hold)}>Проверить влияние</button>
              {/if}
            {/if}
          </div>
        </li>
      {/each}
    </ul>
    <Notice kind="error" message={error} />
    <Notice kind="success" message={status} />
    {#if selection && mode}
      <form onsubmit={submit}>
        {#if mode === 'classify'}
          <fieldset>
            <legend>Области применимости</legend>
            {#each context.project.scopes.filter((scope) => !selection?.scopeIds || selection.scopeIds.includes(scope.id)) as scope (scope.id)}
              <label><input type="checkbox" bind:group={checked} value={scope.id} disabled={busy} /> {scope.stage} · {scope.name}</label>
            {/each}
          </fieldset>
        {:else}
          {#each impacts as impact (impact.scopeId)}
            <fieldset>
              <legend>{namedScopes.get(impact.scopeId) ?? impact.scopeId}</legend>
              <p class="meta">Версия оценки · {impact.assessmentVersion ?? 'ещё не создана'}</p>
              {#if impact.questions.length}
                <p>Отметьте вопросы, на которые повлияло поступление.</p>
                {#each impact.questions as question (question.id)}
                  <label><input type="checkbox" checked={impact.questionIds.includes(question.id)}
                    onchange={(event) => {
                      impact.reviewed = false;
                      impact.questionIds = event.currentTarget.checked
                        ? [...impact.questionIds, question.id] : impact.questionIds.filter((value) => value !== question.id);
                    }} /> {question.requirement.subject} · {question.requirement.part}</label>
                {/each}
              {/if}
              <label><input type="checkbox" bind:checked={impact.reviewed} /> {impact.questionIds.length ? 'Выбраны все затронутые вопросы' : 'Подтверждаю отсутствие влияния'}</label>
            </fieldset>
          {/each}
          <label>Основание проверки<textarea bind:value={reason} maxlength="2000" required></textarea></label>
        {/if}
        {#if needsReview}<button type="button" disabled={busy} onclick={refreshInput}>Сверить с текущими данными</button>{/if}
        <div class="actions">
          <button class="primary" disabled={busy || (mode === 'classify' ? !checked.length : !impacts.length || impacts.some((item) => !item.reviewed))}>
            {mode === 'classify' ? 'Сохранить применимость' : 'Сохранить проверку влияния'}
          </button>
          <button type="button" onclick={() => { selection = undefined; mode = undefined; }}>Закрыть</button>
        </div>
      </form>
    {/if}
  </section>
{/if}
