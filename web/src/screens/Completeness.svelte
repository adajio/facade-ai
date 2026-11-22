<script lang="ts">
  import { Commands } from '../lib/commands';
  import { conflictMessage } from '../lib/conflict';
  import { date, label } from '../lib/format';
  import { describe, id, interrupted, query, type Api } from '../lib/http';
  import { V1, projectApi, projectV1, scopedUrl, type Assessment, type AssessmentQuestion, type Citation, type OpenEvidence, type WorkspaceProps } from '../lib/workspace';
  import EvidenceButtons from '../lib/EvidenceButtons.svelte';
  import Notice from '../lib/Notice.svelte';
  import ScopeRequirements from './ScopeRequirements.svelte';

  let { api, context, open, renew }: { api: Api; context: WorkspaceProps; open: OpenEvidence; renew: () => void } = $props();
  const commands = new Commands(() => api);
  let snapshot = $state<Assessment>();
  let loadError = $state('');
  let selected = $state('');
  let showHistory = $state(false);
  let historical = $derived(Boolean(context.revision));
  let visible = $derived((snapshot?.questions ?? []).filter((row) => !context.filter || context.filter === row.outcome));
  let row = $derived(visible.find((entry) => entry.id === (selected || context.objectId)) ?? visible[0]);
  let action = $state('confirm');
  let reason = $state('');
  let correction = $state('covered');
  let exclusion = $state('not_required');
  let critical = $state(false);
  let requestExternal = $state(false);
  let startWork = $state('can_start');
  let conclusionReason = $state('');
  let basedOn = $state<number>();
  let conclusionBase = $state<number>();
  let marked = $state<string[]>([]);
  let batchBases = $state<Record<string, number>>({});
  let saving = $state(false);
  let operationStatus = $state('');
  let operationError = $state('');

  function openStoppedEvidence(stop: NonNullable<AssessmentQuestion['researchStops']>[number], index: number, event: MouseEvent) {
    const entries: Citation[] = (stop.evidence ?? []).map(({ evidenceId, place }) => ({
      evidenceId, ...place.source, branch: stop.branch,
      address: { unitId: place.unitId, page: place.page, box: place.box },
    }));
    open(entries, index, event.currentTarget as HTMLElement);
  }

  $effect(() => {
    const scopeId = context.scopeId;
    const version = context.revision ?? 'current';
    const path = projectV1(context.project.id) + '/assessments/' + id(version);
    void context.refreshKey;
    if (!scopeId) return;
    const controller = new AbortController();
    loadError = '';
    api.json<Assessment>(query(path, { scopeId }), { signal: controller.signal }).then((result) => {
      snapshot = result;
    }).catch((error) => {
      if (!interrupted(error)) loadError = describe(error);
    });
    return () => controller.abort();
  });

  $effect(() => { void context.objectId; selected = ''; });

  function edit() {
    basedOn ??= row?.version;
  }

  async function continueResearch(stopId: string) {
    if (saving) return;
    await run(async () => {
      await commands.send(projectApi(context.project.id) + '/research-stops/' + id(stopId) + '/resume', 'POST', {});
    });
  }

  async function saveQuestion(event: SubmitEvent) {
    event.preventDefault();
    if (!row || saving) return;
    const version = basedOn ?? row.version;
    const selectedRow = row;
    await run(async () => {
      const body = {
        action, reason, startWorkCritical: critical, requestExternal: requestExternal && ['confirm', 'correct'].includes(action),
        ...(action === 'correct' ? { outcome: correction } : {}),
        ...(action === 'exclude' ? { exclusion: { kind: exclusion } } : {}),
      };
      await commands.send(V1 + '/questions/' + id(selectedRow.id) + '/decisions', 'POST', body, version);
      reason = '';
      basedOn = undefined;
    }, version);
  }

  function mark(question: AssessmentQuestion, checked: boolean) {
    if (checked) {
      marked = [...marked, question.id];
      batchBases[question.id] = question.version;
    } else {
      marked = marked.filter((value) => value !== question.id);
      delete batchBases[question.id];
    }
  }

  async function confirmMarked() {
    if (saving || !marked.length) return;
    // Each item carries its own expected version and exposes its own receipt.
    await run(async () => {
      for (const questionId of [...marked]) {
        await commands.send(V1 + '/questions/' + id(questionId) + '/decisions', 'POST', {
          action: 'confirm', reason, requestExternal: true,
        }, batchBases[questionId]);
        marked = marked.filter((value) => value !== questionId);
        delete batchBases[questionId];
        operationStatus = 'Часть решений сохранена.';
      }
      reason = '';
    });
  }

  async function saveConclusion(event: SubmitEvent) {
    event.preventDefault();
    if (!snapshot || saving) return;
    const version = conclusionBase ?? snapshot.version;
    await run(async () => {
      await commands.send(projectV1(context.project.id) + '/conclusions', 'POST', {
        scopeId: context.scopeId, startWork, reason: conclusionReason,
      }, version);
      conclusionBase = undefined;
      conclusionReason = '';
    }, version);
  }

  async function run(task: () => Promise<void>, version?: number) {
    operationStatus = '';
    operationError = '';
    saving = true;
    try {
      await task();
      operationStatus = 'Сохранено на сервере.';
    } catch (error) {
      operationError = conflictMessage(error, version);
    } finally {
      saving = false;
      renew();
    }
  }
</script>

{#if !context.scopeId}
  <p class="card">Для оценки нужна область проекта.</p>
{:else}
  <Notice kind="error" message={loadError} />
  {#if !snapshot && !loadError}<p role="status">Загружаем оценку…</p>{/if}
  {#if snapshot}
    {#if context.canEdit && !historical}
      <ScopeRequirements {api} project={context.project} scopeId={context.scopeId} saved={renew} />
    {/if}
    <section class="card">
      <div class="card-header">
        <h2>{historical ? 'История · оценка ' + snapshot.version : 'Оценка ' + snapshot.version}</h2>
        {#if historical}
          <a href={scopedUrl(context.project.id, 'completeness', { scope: context.scopeId })}>Актуальная оценка</a>
        {:else}
          <button type="button" onclick={() => showHistory = !showHistory}>История оценок</button>
        {/if}
      </div>
      {#if showHistory}
        <div class="actions">
          {#each Array.from({ length: Math.min(snapshot.version - 1, 30) }, (_, index) => snapshot!.version - index - 1) as version (version)}
            <a href={scopedUrl(context.project.id, 'completeness', { scope: context.scopeId, revision: version })}>Версия {version}</a>
          {/each}
          {#if snapshot.version < 2}<span>Предыдущих оценок пока нет.</span>{/if}
        </div>
      {/if}
      <dl class="details">
        <dt>Машинная оценка</dt><dd>{label(snapshot.outcome)}</dd>
        <dt>Версия каталога</dt><dd>{snapshot.catalogVersionId}</dd>
        <dt>Заключение инженера</dt><dd>{snapshot.conclusion ? label(snapshot.conclusion.outcome ?? snapshot.outcome) : 'Ожидает решения'}</dd>
        <dt>Начало работ</dt><dd>{label(snapshot.conclusion?.startWork, 'Ожидает решения')}</dd>
        {#if snapshot.conclusion}<dt>Основание</dt><dd>{snapshot.conclusion.reason} · {date(snapshot.conclusion.createdAt)}</dd>{/if}
        {#if snapshot.change?.reason}<dt>Причина пересмотра</dt><dd>{label(snapshot.change.reason)}</dd>{/if}
      </dl>
      {#if snapshot.limitations?.length}<p class="meta">{snapshot.limitations.map((item) => label(item)).join(' · ')}</p>{/if}
      {#if snapshot.holds?.length}<Notice message={'Ожидается разбор поступлений · ' + snapshot.holds.length} />{/if}
    </section>

    <div class="split">
      <section class="card table-card">
        <div class="card-header"><h2>Обязательные части</h2>{#if context.filter}<a href={scopedUrl(context.project.id, 'completeness', { scope: context.scopeId })}>Все состояния</a>{/if}</div>
        {#if visible.length}
          <div class="table-wrap">
            <table>
              <thead><tr><th>Позиция и часть</th><th>Формат</th><th>Состояние</th>{#if context.canEdit && !historical}<th>К подтверждению</th>{/if}</tr></thead>
              <tbody>
                {#each visible as item (item.id)}
                  <tr>
                    <td><button type="button" class="quiet" aria-pressed={row?.id === item.id}
                      onclick={() => { selected = item.id; basedOn = undefined; reason = ''; }}>{item.requirement.subject} · {item.requirement.part}</button></td>
                    <td>{item.requirement.formats.join(', ')}</td>
                    <td><span class="pill">{label(item.outcome)}</span></td>
                    {#if context.canEdit && !historical}
                      <td>{#if ['confirmed_missing', 'confirmed_conflict'].includes(item.machine.outcome)}
                        <input type="checkbox" aria-label={'Подтвердить ' + item.requirement.part} checked={marked.includes(item.id)}
                          onchange={(event) => mark(item, event.currentTarget.checked)} />
                      {/if}</td>
                    {/if}
                  </tr>
                {/each}
              </tbody>
            </table>
          </div>
        {:else}
          <p class="empty">{context.filter ? 'В выбранном состоянии строк нет.' : 'В этой версии каталога нет применимых обязательных частей.'}</p>
        {/if}
      </section>

      {#if row}
        <section class="card" aria-labelledby="assessment-row">
          <h2 id="assessment-row">{row.requirement.subject} · {row.requirement.part}</h2>
          <dl class="details">
            <dt>Редакция вопроса</dt><dd>{row.version}</dd>
            <dt>Машинный вывод</dt><dd>{label(row.machine.outcome)}</dd>
            <dt>Поступление</dt><dd>{label(row.machine.delivery)}</dd>
            <dt>Читаемость</dt><dd>{label(row.machine.readability)}</dd>
            <dt>Решение инженера</dt><dd>{row.decision ? label(row.decision.outcome) : 'Ожидает решения'}</dd>
            {#if row.decision}<dt>Основание</dt><dd>{row.decision.reason} · {date(row.decision.createdAt)}</dd>{/if}
            {#if row.machine.inventory}
              <dt>Опись</dt><dd>{label(row.machine.inventory.kind)} · {row.machine.inventory.currentCompositionChecked ? 'Текущий состав проверен' : 'Состав требует проверки'}</dd>
            {/if}
          </dl>
          {#if row.machine.limitations.length}<p class="meta">{row.machine.limitations.map((item) => label(item)).join(' · ')}</p>{/if}
          {#if row.researchStops?.length}
            <details open>
              <summary>Остановленные задания чтения ({row.researchStops.length})</summary>
              <ul class="plain-list">
                {#each row.researchStops as stop (stop.jobId)}
                  <li>
                    <strong>Ветвь {stop.branch} · {label(stop.reason)}</strong>
                    <p class="meta">{stop.place.page ? 'Стр. ' + stop.place.page : stop.place.unitId} · {stop.nextAction}</p>
                    {#if stop.lastRejectedTool}
                      <p class="meta">Ход {stop.lastRejectedTool.turn} · {stop.lastRejectedTool.name} · {label(stop.lastRejectedTool.code)}</p>
                    {/if}
                    {#if stop.lastRequest}
                      <details>
                        <summary>Аргументы отклонённого запроса</summary>
                        <pre class="request-arguments">{stop.lastRequest.arguments}</pre>
                      </details>
                    {/if}
                    {#each stop.evidence ?? [] as saved, index (saved.evidenceId)}
                      <button type="button" onclick={(event) => openStoppedEvidence(stop, index, event)}>
                        Открыть прочитанное место {saved.place.page ? 'на стр. ' + saved.place.page : saved.place.unitId}
                      </button>
                    {/each}
                    <a href={'/api/documents/' + id(stop.place.source.documentId) + '/versions/' + id(stop.place.source.versionId) + '/content'} target="_blank" rel="noopener">Открыть оригинал остановленного задания</a>
                    {#if stop.continuationRequested}
                      <p class="meta">Продолжение запрошено.</p>
                    {:else if context.canEdit && !historical && stop.id}
                      <button type="button" disabled={saving} onclick={() => stop.id && continueResearch(stop.id)}>Продолжить чтение</button>
                    {/if}
                  </li>
                {/each}
              </ul>
            </details>
          {/if}
          <EvidenceButtons citations={row.machine.citations} {open} />
          {#if row.machine.receiptIds.length}
            <ul class="plain-list">{#each row.machine.receiptIds as receipt, i (receipt)}
              <li><a href={scopedUrl(context.project.id, 'receipts', { scope: context.scopeId }, receipt)}>Связанное поступление {i + 1}</a></li>
            {/each}</ul>
          {/if}
          {#if row.history?.length}
            <details><summary>История решений</summary>
              <ul class="plain-list">{#each row.history as decision}<li>{label(decision?.outcome)} · {decision?.reason} · {date(decision?.createdAt)}</li>{/each}</ul>
            </details>
          {/if}
          {#if context.canEdit && !historical}
            <form onsubmit={saveQuestion}>
              <label>Действие
                <select bind:value={action} onchange={edit}>
                  <option value="confirm">Подтвердить вывод</option>
                  <option value="correct">Исправить вывод</option>
                  <option value="exclude">Отметить исключение</option>
                  <option value="revoke">Отменить решение</option>
                </select>
              </label>
              {#if action === 'correct'}
                <label>Исправленный исход<select bind:value={correction}>
                  <option value="covered">Покрыто</option><option value="needs_review">Требуется внутренняя сверка</option>
                </select></label>
              {:else if action === 'exclude'}
                <label>Исключение<select bind:value={exclusion}>
                  <option value="not_required">Не требуется</option><option value="work_without_data">Работаем без этих данных</option>
                </select></label>
              {/if}
              {#if ['confirm', 'correct'].includes(action) && ['confirmed_missing', 'confirmed_conflict'].includes(row.machine.outcome)}
                <label><input type="checkbox" bind:checked={requestExternal} onchange={edit} /> Подтвердить к внешнему запросу</label>
              {/if}
              <label><input type="checkbox" bind:checked={critical} onchange={edit} /> Для начала работ</label>
              <label>Основание решения<textarea required bind:value={reason} oninput={edit}></textarea></label>
              {#if basedOn != null && basedOn !== row.version}
                <p class="notice">Ввод опирался на версию {basedOn}. Сейчас доступна версия {row.version}.</p>
                <button type="button" onclick={() => basedOn = row?.version}>Использовать текущую версию</button>
              {/if}
              <div class="actions">
                <button class="primary" disabled={saving}>Сохранить решение</button>
                {#if marked.length}<button type="button" disabled={saving || !reason.trim()} onclick={confirmMarked}>Подтвердить выбранные · {marked.length}</button>{/if}
              </div>
            </form>
          {/if}
        </section>
      {/if}
    </div>
    <Notice kind="error" message={operationError} />
    <Notice kind="success" message={operationStatus} />
    {#if context.canEdit && !historical}
      <section class="card">
        <h2>Заключение по области</h2>
        <form onsubmit={saveConclusion}>
          <label>Решение о начале работ<select bind:value={startWork} onchange={() => conclusionBase ??= snapshot?.version}>
            <option value="can_start">Можно начать</option>
            <option value="can_start_with_limitations">Можно начать с ограничениями</option>
            <option value="cannot_start">Начинать нельзя</option>
          </select></label>
          <label>Основание заключения<textarea required bind:value={conclusionReason} oninput={() => conclusionBase ??= snapshot?.version}></textarea></label>
          {#if conclusionBase != null && conclusionBase !== snapshot.version}
            <p class="notice">Ввод опирался на версию {conclusionBase}. Сейчас доступна версия {snapshot.version}.</p>
            <button type="button" onclick={() => conclusionBase = snapshot?.version}>Сверил заключение с текущей версией</button>
          {/if}
          <div class="actions"><button class="primary" disabled={saving}>Сохранить заключение</button></div>
        </form>
      </section>
    {/if}
  {/if}
{/if}

<style>
  .request-arguments { white-space: pre-wrap; overflow-wrap: anywhere; }
</style>
