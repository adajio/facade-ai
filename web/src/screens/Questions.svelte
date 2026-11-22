<script lang="ts">
  import { Commands } from '../lib/commands';
  import { conflictMessage } from '../lib/conflict';
  import { date, label } from '../lib/format';
  import { ApiError, describe, id, interrupted, query, type Api } from '../lib/http';
  import { V1, projectV1, scopedUrl, type OpenEvidence, type WorkspaceProps } from '../lib/workspace';
  import { supportCitation, type InquirySupport as Support } from '../lib/inquiry-supports';
  import InquirySupportDetails from '../lib/InquirySupportDetails.svelte';
  import EvidenceButtons from '../lib/EvidenceButtons.svelte';
  import Notice from '../lib/Notice.svelte';
  import QuestionReplacement from './QuestionReplacement.svelte';

  type Summary = {
    id: string; subject: string; state: string; nextAction?: string; version: number;
    searchVersion: number; needsReview?: boolean; stage: string; scopeId: string; assessmentQuestionId?: string;
  };
  type Candidate = { source: Support; reason: string; applicability: string };
  type Decision = { action: string; reason: string; answer?: string; createdAt: string; authorId: string; version: number };
  type Inquiry = Summary & {
    selectedSearchVersion: number; candidates: Candidate[];
    pairs: { left: Support; right: Support; comparison: string }[];
    limitations: string[]; decision?: Decision; decisionHistory: Decision[];
    searchHistory: { searchVersion: number; state: string }[];
  };
  type InquiryPage = { inquiries: Summary[]; nextAfter?: string; sliceId: string };

  let { api, context, mode, open, renew }: {
    api: Api; context: WorkspaceProps; mode: 'questions' | 'facts'; open: OpenEvidence; renew: () => void;
  } = $props();

  const commands = new Commands(() => api);
  let list = $state<Summary[]>([]);
  let inquiry = $state<Inquiry>();
  let cursor = $state<string | null>(null);
  let listSlice = $state('');
  let loading = $state(false);
  let paging = $state(false);
  let pending = $state(false);
  let selectedId = $derived(context.objectId ?? list[0]?.id);
  let listPath = $derived(projectV1(context.project.id) + '/inquiries');
  let error = $state('');
  let detailError = $state('');
  let operationError = $state('');
  let status = $state('');
  let subject = $state('');
  let property = $state('');
  let variant = $state('');
  let action = $state('accept');
  let reason = $state('');
  let answer = $state('');
  let basedOn = $state<number>();
  let selected = $state<string[]>([]);
  let visible = $derived(context.filter ? list.filter((item) => item.state === context.filter) : list);

  $effect(() => {
    const path = listPath;
    const scopeId = context.scopeId;
    void context.refreshKey;
    if (!scopeId) return;
    const stop = new AbortController();
    loading = true;
    error = '';
    api.json<InquiryPage>(query(path, { scopeId }), { signal: stop.signal }).then((page) => {
      list = page.inquiries;
      cursor = page.nextAfter ?? null;
      listSlice = page.sliceId;
    }).catch((problem) => { if (!interrupted(problem)) error = describe(problem); })
      .finally(() => { if (!stop.signal.aborted) loading = false; });
    return () => stop.abort();
  });

  $effect(() => {
    void selectedId;
    selected = [];
    reason = '';
    answer = '';
    basedOn = undefined;
  });

  $effect(() => {
    const inquiryId = selectedId;
    const revision = context.revision;
    void context.refreshKey;
    if (!inquiryId) return;
    const stop = new AbortController();
    detailError = '';
    api.json<Inquiry>(query(V1 + '/inquiries/' + id(inquiryId), { searchVersion: revision }), { signal: stop.signal })
      .then((value) => inquiry = value)
      .catch((problem) => { if (!interrupted(problem)) { inquiry = undefined; detailError = describe(problem); } });
    return () => stop.abort();
  });

  function route(inquiryId?: string, revision?: string | number) {
    return scopedUrl(context.project.id, mode, { scope: context.scopeId, filter: context.filter, revision }, inquiryId);
  }

  async function more() {
    if (!cursor || paging) return;
    const expected = listSlice;
    paging = true;
    try {
      const page = await api.json<InquiryPage>(query(listPath, { scopeId: context.scopeId, after: cursor }));
      if (page.sliceId !== expected || listSlice !== expected) {
        error = 'Появился новый срез. Список перечитывается, выбранная карточка сохраняется.';
        renew();
      } else {
        const known = new Set(list.map((item) => item.id));
        list = [...list, ...page.inquiries.filter((item) => !known.has(item.id))];
        cursor = page.nextAfter ?? null;
      }
    } catch (problem) {
      error = describe(problem);
    } finally {
      paging = false;
    }
  }

  async function create(event: SubmitEvent) {
    event.preventDefault();
    if (!context.sliceId || !context.project.catalogVersionId || pending) return;
    pending = true;
    operationError = '';
    try {
      const result = await commands.send<{ id: string }>(listPath, 'POST', {
        scopeId: context.scopeId, sliceId: context.sliceId, catalogVersionId: context.project.catalogVersionId,
        subject: subject.trim(), property: property.trim(), variant: variant.trim() || undefined,
      });
      window.location.assign(route(result.id));
    } catch (problem) {
      operationError = describe(problem);
      if (problem instanceof ApiError && problem.code === 'snapshot_required') renew();
    } finally {
      pending = false;
    }
  }

  async function save(event: SubmitEvent) {
    event.preventDefault();
    if (!inquiry || pending) return;
    const expected = basedOn ?? inquiry.version;
    pending = true;
    operationError = '';
    status = '';
    try {
      await commands.send(V1 + '/inquiries/' + id(inquiry.id) + '/decisions', 'POST', {
        action, reason, answer: answer.trim() || undefined, candidateIds: selected,
      }, expected);
      status = 'Решение сохранено.';
      basedOn = undefined;
      reason = '';
      answer = '';
    } catch (problem) {
      operationError = conflictMessage(problem, expected);
    } finally {
      pending = false;
      renew();
    }
  }

</script>

{#if !context.scopeId}
  <p class="card">Выберите область проекта.</p>
{:else}
  {#if context.canEdit && mode === 'questions'}
    <details class="card">
      <summary>Задать адресный вопрос</summary>
      <form onsubmit={create}>
        <div class="form-row">
          <label>Предмет<input bind:value={subject} required /></label>
          <label>Свойство<input bind:value={property} required /></label>
          <label>Вариант<input bind:value={variant} /></label>
        </div>
        <div class="actions"><button class="primary" disabled={!context.sliceId || pending}>Поставить вопрос</button></div>
      </form>
    </details>
  {/if}
  <Notice kind="error" message={error} />
  <Notice kind="error" message={operationError} />
  <Notice kind="success" message={status} />
  <div class="split">
    <section class="card table-card">
      <div class="card-header"><h2>{mode === 'facts' ? 'Предметы и варианты' : 'Реестр вопросов'}</h2></div>
      {#if visible.length}
        <div class="table-wrap">
          <table><thead><tr><th>Предмет</th><th>Поиск и сверка</th></tr></thead>
            <tbody>{#each visible as item (item.id)}
              <tr><td><a class="row-link" href={route(item.id)} aria-current={selectedId === item.id ? 'true' : undefined}>{item.subject}</a></td>
                <td>{label(item.state)}{item.needsReview ? ' · пересмотр' : ''}</td></tr>
            {/each}</tbody>
          </table>
        </div>
        {#if cursor}<div class="card-header"><button type="button" onclick={more} disabled={paging}>Ещё вопросы</button></div>{/if}
      {:else}<p class="empty">{loading ? 'Загружаем список…' : 'В выбранной области пока нет записей.'}</p>{/if}
    </section>

    <div>
      <Notice kind="error" message={detailError} />
      {#if inquiry && inquiry.id === selectedId}
        <section class="card">
          <h2>{inquiry.subject}</h2>
          <dl class="details">
            <dt>Стадия</dt><dd>{inquiry.stage}</dd>
            <dt>Поиск</dt><dd>{label(inquiry.state)}</dd>
            <dt>Редакция поиска</dt><dd>{inquiry.selectedSearchVersion}</dd>
            <dt>Дальше</dt><dd>{label(inquiry.nextAction)}</dd>
            <dt>Применение инженером</dt><dd>{inquiry.decision ? label(inquiry.decision.action) : 'Ожидает решения'}</dd>
          </dl>
          {#if context.revision}<p class="notice">История · <a href={route(inquiry.id)}>Актуальный поиск</a></p>{/if}
          {#if inquiry.limitations.length}<Notice message={inquiry.limitations.map((entry) => label(entry)).join(' · ')} />{/if}
          {#if !inquiry.candidates.length && !['queued', 'searching'].includes(inquiry.state)}<p>Поиск завершён без доступных опор.</p>{/if}
          {#if inquiry.assessmentQuestionId}
            <a href={scopedUrl(context.project.id, 'completeness', { scope: context.scopeId }, inquiry.assessmentQuestionId)}>Обязательная часть и заключение</a>
          {/if}
          <div class="actions">
            <a href={scopedUrl(context.project.id, 'receipts', { scope: context.scopeId, inquiry: inquiry.id })}>К поступлениям</a>
            <a href={scopedUrl(context.project.id, 'letters', { scope: context.scopeId })}>К письмам</a>
          </div>
        </section>
        {#if inquiry.pairs.length}
          <section class="card">
            <h2>Пары для сверки</h2>
            <ul class="plain-list">{#each inquiry.pairs as pair}
              <li><strong>{label(pair.comparison)}</strong><EvidenceButtons citations={[supportCitation(pair.left), supportCitation(pair.right)]} {open} /></li>
            {/each}</ul>
          </section>
        {/if}
        {#if inquiry.candidates.length}
          <section class="card">
            <h2>Сохранённые места</h2>
            <ul class="plain-list">{#each inquiry.candidates as candidate (candidate.source.observationId)}
              <li>
                <strong>{candidate.source.subject} · {candidate.source.property}{candidate.source.variant ? ' · ' + candidate.source.variant : ''}</strong>
                <p class="meta">{label(candidate.applicability)} · {label(candidate.reason)} · {label(candidate.source.revision)} · {label(candidate.source.role)}</p>
                <InquirySupportDetails source={candidate.source} {open} />
                {#if context.canEdit && !context.revision && candidate.applicability === 'verified'}
                  <label><input type="checkbox" bind:group={selected} value={candidate.source.observationId} onchange={() => basedOn ??= inquiry?.version} /> Использовать опору</label>
                {/if}
              </li>
            {/each}</ul>
          </section>
        {/if}
        {#if mode === 'questions' && inquiry.assessmentQuestionId}
          {#key inquiry.assessmentQuestionId}
            <QuestionReplacement {api} questionId={inquiry.assessmentQuestionId} candidates={inquiry.candidates} {context} {open} {renew} />
          {/key}
        {/if}
        {#if context.canEdit && !context.revision && !['queued', 'searching'].includes(inquiry.state)}
          <section class="card">
            <h2>Решение по вопросу</h2>
            <form onsubmit={save}>
              <label>Действие<select bind:value={action} onchange={() => basedOn ??= inquiry?.version}>
                <option value="accept">Принять</option><option value="correct">Исправить ответ</option><option value="reject">Отклонить</option>
              </select></label>
              {#if action === 'correct'}<label>Исправленный ответ<input bind:value={answer} required /></label>{/if}
              <label>Основание<textarea bind:value={reason} required oninput={() => basedOn ??= inquiry?.version}></textarea></label>
              {#if basedOn != null && basedOn !== inquiry.version}
                <p class="notice">Исходная версия {basedOn}, текущая {inquiry.version}. Ввод сохранён.</p>
                <button type="button" onclick={() => basedOn = inquiry?.version}>Использовать текущую версию</button>
              {/if}
              <div class="actions"><button class="primary" disabled={pending || (action !== 'reject' && !selected.length)}>Сохранить решение</button></div>
            </form>
          </section>
        {/if}
        <section class="card">
          <h2>История</h2>
          {#each inquiry.searchHistory as version (version.searchVersion)}
            <a class="button" href={route(inquiry.id, version.searchVersion)}>Поиск {version.searchVersion} · {label(version.state)}</a>
          {/each}
          <ul class="plain-list">{#each inquiry.decisionHistory as decision (decision.version)}
            <li>{label(decision.action)} · {decision.reason} · {date(decision.createdAt)}{decision.answer ? ' · ' + decision.answer : ''}</li>
          {/each}</ul>
        </section>
      {/if}
    </div>
  </div>
{/if}
