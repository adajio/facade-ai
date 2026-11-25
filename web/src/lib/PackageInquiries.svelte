<script lang="ts">
  import { untrack } from 'svelte';
  import { Commands } from './commands';
  import { originalUrl, renderAddress, type SourceAddress } from './copilot';
  import EvidenceButtons from './EvidenceButtons.svelte';
  import { date, label } from './format';
  import { describe, id, interrupted, query, type Api } from './http';
  import Notice from './Notice.svelte';
  import OriginalBasisFields from './OriginalBasisFields.svelte';
  import { projectV1, scopedUrl, V1, type Citation, type OpenEvidence, type WorkspaceProps } from './workspace';

  type Summary = { id: string; subject: string; property: string; state: string; needsReview: boolean };
  type Decision = { action: string; reason: string; answer?: string; authorId: string; version: number; createdAt: string };
  type Inquiry = Summary & {
    version: number; assessmentContextId: string; assessmentQuestionId?: string; assessmentVersion: number; stage: string | null;
    selectedSearchVersion: number; sourceReplaced: boolean; basisChanged: boolean; source: { documentId: string; versionId: string; label: string; address: SourceAddress };
    candidates: { applicability: string; source: Citation & { observationId: string } }[];
    limitations: string[]; decision?: Decision; decisionHistory: Decision[]; searchHistory: { searchVersion: number; state: string }[];
  };
  type Page = { inquiries: Summary[]; nextAfter: string | null; sliceId: string };

  let { api, context, contextId, contextName, assessmentVersion, requirement, open, renew }: {
    api: Api; context: WorkspaceProps; contextId: string; contextName: string; assessmentVersion: number;
    requirement?: { id: string; text: string }; open: OpenEvidence; renew: () => void;
  } = $props();

  const commands = new Commands(() => api);
  let list = $state<Summary[]>([]);
  let selected = $state<Inquiry>();
  let loading = $state(true);
  let detailLoading = $state(false);
  let next = $state<string | null>(null);
  let listSlice = $state('');
  let readError = $state('');
  let detailError = $state('');
  let commandError = $state('');
  let status = $state('');
  let busy = $state(false);
  let heading = $state<HTMLHeadingElement>();
  let registryHeading = $state<HTMLHeadingElement>();
  let lastFocus = '';
  let subject = $state('');
  let property = $state('');
  let variant = $state('');
  let reason = $state('');
  let answer = $state('');
  let action = $state('accept');
  let choice = $state<string[]>([]);
  let decisionVersion = $state<number>();
  let versionId = $state('');
  let anchor = $state('');
  let retryVersionId = $state('');
  let retryAnchor = $state('');
  let issueId = $derived(context.params.get('inquiry'));
  let historyVersion = $derived(context.params.get('searchVersion'));
  let fromRequirement = $derived(context.params.get('requirement'));
  let openRequested = $derived(context.params.get('ask') === '1');
  let createOpen = $state(false);
  let listPath = $derived(projectV1(context.project.id) + '/inquiries');
  let issuePath = $derived(issueId ? V1 + '/inquiries/' + id(issueId) : '');
  let detail = $derived(selected?.id === issueId && !detailLoading ? selected : undefined);
  let showForm = $derived(context.canEdit && !historyVersion);
  const limitations: Record<string, string> = {
    package_reading_incomplete: 'Не все материалы охвачены проверкой А/Б.',
    candidate_limit: 'Поиск просмотрел первые 100 опубликованных мест по адресу.',
    address_unavailable: 'Сохранённая опора сейчас не открывается.',
    meaning_unclear: 'Применимость или содержание опоры требует сверки.',
    search_interrupted: 'Предыдущий поиск прерван. Можно повторить.',
  };

  function route(inquiry?: string, searchVersion?: number) {
    return scopedUrl(context.project.id, 'questions', { context: contextId, inquiry, searchVersion, requirement: fromRequirement }, undefined);
  }

  $effect(() => {
    const path = listPath;
    const area = contextId;
    void context.refreshKey;
    const stop = new AbortController();
    loading = true;
    readError = '';
    api.json<Page>(query(path, { assessmentContextId: area }), { signal: stop.signal }).then((page) => {
      if (stop.signal.aborted) return;
      list = page.inquiries;
      listSlice = page.sliceId;
      next = page.nextAfter;
    }).catch((error) => { if (!stop.signal.aborted && !interrupted(error)) readError = describe(error); })
      .finally(() => { if (!stop.signal.aborted) loading = false; });
    return () => stop.abort();
  });

  $effect(() => {
    const path = issuePath;
    const area = contextId;
    const searchVersion = historyVersion;
    void context.refreshKey;
    detailError = '';
    if (!path) return;
    const stop = new AbortController();
    detailLoading = true;
    api.json<Inquiry>(query(path, { assessmentContextId: area, searchVersion }), { signal: stop.signal }).then((value) => {
      if (!stop.signal.aborted) selected = value;
    }).catch((error) => {
      if (stop.signal.aborted || interrupted(error)) return;
      selected = undefined;
      detailError = describe(error);
    }).finally(() => { if (!stop.signal.aborted) detailLoading = false; });
    return () => stop.abort();
  });

  $effect(() => {
    const active = issueId;
    const historical = historyVersion;
    const target = active ? heading : registryHeading;
    const key = (active ?? 'list') + '/' + (historical ?? '');
    if (!target || lastFocus === key) return;
    target.focus();
    lastFocus = key;
  });

  $effect(() => {
    void issueId;
    reason = '';
    answer = '';
    action = 'accept';
    decisionVersion = undefined;
    choice = [];
    retryVersionId = '';
    retryAnchor = '';
    status = '';
    commandError = '';
  });

  $effect(() => {
    if (openRequested) createOpen = true;
  });

  $effect(() => {
    if (openRequested && requirement?.id === fromRequirement && !untrack(() => subject.trim())) {
      subject = requirement?.text ?? '';
    }
  });

  async function more() {
    if (!next || loading) return;
    const expected = listSlice;
    loading = true;
    try {
      const page = await api.json<Page>(query(listPath, { assessmentContextId: contextId, after: next }));
      if (page.sliceId !== expected || listSlice !== expected) renew();
      else {
        list = [...list, ...page.inquiries];
        next = page.nextAfter;
      }
    } catch (error) {
      readError = describe(error);
      renew();
    } finally {
      loading = false;
    }
  }

  async function create(event: SubmitEvent) {
    event.preventDefault();
    if (busy || !versionId || !anchor.trim()) return;
    busy = true;
    commandError = '';
    try {
      const result = await commands.send<{ id: string }>(listPath, 'POST', {
        assessmentContextId: contextId, assessmentVersion, assessmentQuestionId: fromRequirement || undefined,
        subject, property, variant: variant.trim() || undefined, versionId, anchor,
      });
      window.location.assign(route(result.id));
    } catch (error) {
      commandError = describe(error);
      renew();
    } finally {
      busy = false;
    }
  }

  async function decide(event: SubmitEvent) {
    event.preventDefault();
    if (busy || !detail) return;
    busy = true;
    commandError = '';
    try {
      await commands.send(issuePath + '/decisions', 'POST', {
        action, reason, answer: action === 'correct' ? answer : undefined, candidateIds: action === 'reject' ? [] : choice,
      }, decisionVersion ?? detail.version);
      reason = '';
      answer = '';
      choice = [];
      decisionVersion = undefined;
      status = 'Решение сохранено.';
    } catch (error) {
      commandError = describe(error);
    } finally {
      busy = false;
      renew();
    }
  }

  async function repeat(event: SubmitEvent) {
    event.preventDefault();
    if (busy || !detail || !retryVersionId || !retryAnchor.trim()) return;
    busy = true;
    commandError = '';
    try {
      await commands.send(issuePath + '/searches', 'POST', { assessmentVersion, versionId: retryVersionId, anchor: retryAnchor }, detail.version);
      status = 'Повторный поиск поставлен в очередь.';
    } catch (error) {
      commandError = describe(error);
    } finally {
      busy = false;
      renew();
    }
  }
</script>

<section class="card" aria-label="Адресные исследовательские вопросы">
  <h2 bind:this={registryHeading} tabindex="-1">Адресные исследовательские вопросы · {contextName}</h2>
  {#if showForm}
    <details bind:open={createOpen}>
      <summary>Задать адресный вопрос</summary>
      <form onsubmit={create}>
        <div class="form-row">
          <label>Предмет<input bind:value={subject} required maxlength="256" /></label>
          <label>Свойство или что найти<input bind:value={property} required maxlength="256" /></label>
          <label>Вариант<input bind:value={variant} maxlength="256" /></label>
        </div>
        <OriginalBasisFields {api} projectId={context.project.id} bind:versionId bind:anchor edit={() => {}} />
        <button class="primary" disabled={busy || !versionId || !anchor}>Поставить вопрос</button>
      </form>
    </details>
  {/if}
  <Notice kind="error" message={readError} />
  <Notice kind="error" message={detailError} />
  <Notice kind="error" message={commandError} />
  <Notice kind="success" message={status} />
  {#if list.length}
    <ul class="plain-list">
      {#each list as item (item.id)}
        <li><a href={route(item.id)} aria-current={issueId === item.id ? 'true' : undefined}>{item.subject} · {item.property}</a>
          <span class="meta"> · {label(item.state)}{item.needsReview ? ' · требуется пересмотр' : ''}</span></li>
      {/each}
    </ul>
    {#if next}<button type="button" onclick={more} disabled={loading}>Ещё вопросы</button>{/if}
  {:else if !readError}
    <p class="empty">{loading ? 'Загружаем вопросы…' : 'В этой области пока нет адресных вопросов.'}</p>
  {/if}
  {#if detail}
    <article>
      <h3 bind:this={heading} tabindex="-1">{detail.subject} · {detail.property}</h3>
      <p>Внутренний вопрос · в письмо не включается.</p>
      <p>{contextName} · {detail.stage ?? 'Стадия уточняется'} · оценка {detail.assessmentVersion} · поиск {detail.selectedSearchVersion}</p>
      {#if detail.assessmentQuestionId}
        <a href={scopedUrl(context.project.id, 'completeness', { context: contextId }, detail.assessmentQuestionId)}>Открыть требование</a>
      {/if}
      {#if historyVersion}<p class="notice">Исторический поиск · <a href={route(detail.id)}>Актуальный поиск</a></p>{/if}
      {#if detail.sourceReplaced}<p class="notice">Принята новая редакция оригинала. Укажите адрес в действующей редакции и повторите поиск.</p>
      {:else if detail.basisChanged && !historyVersion}<p class="notice">Действующая стадия или рабочий каталог изменились. Повторите поиск на актуальном срезе.</p>
      {:else if detail.needsReview && !historyVersion}<p class="notice">Прежнее решение требует пересмотра.</p>{/if}
      <p><a href={originalUrl(detail.source.documentId, detail.source.versionId, detail.source.address.locator?.page)}
        target="_blank" rel="noopener noreferrer">{detail.source.label} · {renderAddress(detail.source.address)}</a></p>
      <h4>Результат поиска</h4>
      <p>{label(detail.state)}</p>
      {#if detail.limitations.length}
        <ul>{#each detail.limitations as entry}<li>{limitations[entry] ?? label(entry)}</li>{/each}</ul>
      {/if}
      {#if detail.candidates.length}
        <ul class="plain-list">
          {#each detail.candidates as candidate (candidate.source.observationId)}
            <li>
              <p>{candidate.source.branch} · {label(candidate.applicability)}</p>
              {#if candidate.source.quote}<blockquote>{candidate.source.quote}</blockquote>{/if}
              {#if candidate.applicability !== 'address_unavailable'}
                <EvidenceButtons citations={[{ ...candidate.source, observationId: undefined, sourceLabel: 'Открыть адрес опоры' }]} {open} />
              {/if}
              {#if showForm && !detail.sourceReplaced && !detail.basisChanged && candidate.applicability === 'verified'}
                <label><input type="checkbox" bind:group={choice} value={candidate.source.observationId}
                  onchange={() => decisionVersion ??= detail?.version} /> Использовать опору</label>
              {/if}
            </li>
          {/each}
        </ul>
      {:else if !['queued', 'searching'].includes(detail.state)}
        <p>По сохранённым чтениям выбранного места подходящих опор пока нет.</p>
      {/if}
      {#if showForm && !detail.sourceReplaced && !detail.basisChanged && !['queued', 'searching'].includes(detail.state)}
        <form onsubmit={decide}>
          <label>Решение инженера
            <select bind:value={action} onchange={() => decisionVersion ??= detail?.version}>
              <option value="accept">Принять</option><option value="correct">Исправить ответ</option><option value="reject">Отклонить</option>
            </select>
          </label>
          {#if action === 'correct'}<label>Исправленный ответ<input bind:value={answer} required maxlength="4000" /></label>{/if}
          <label>Причина решения<textarea bind:value={reason} oninput={() => decisionVersion ??= detail?.version} required maxlength="4000"></textarea></label>
          {#if decisionVersion !== undefined && decisionVersion !== detail.version}
            <p>Появилась версия {detail.version}. Проверьте опоры. Ввод сохранён.</p>
            <button type="button" onclick={() => { decisionVersion = detail?.version; choice = []; }}>Использовать текущую версию</button>
          {/if}
          <button class="primary" disabled={busy || (action !== 'reject' && !choice.length)}>Сохранить решение</button>
        </form>
      {/if}
      {#if showForm && (detail.sourceReplaced || detail.basisChanged || !['queued', 'searching'].includes(detail.state))}
        <details>
          <summary>Повторить поиск по адресу</summary>
          <form onsubmit={repeat}>
            <OriginalBasisFields {api} projectId={context.project.id} bind:versionId={retryVersionId} bind:anchor={retryAnchor} edit={() => {}} />
            <button disabled={busy || !retryVersionId || !retryAnchor}>Поставить повторный поиск</button>
          </form>
        </details>
      {/if}
      {#if detail.decisionHistory.length}
        <h4>Решения инженера</h4>
        <ul class="plain-list">
          {#each detail.decisionHistory as decision (decision.version)}
            <li>{label(decision.action)} · {decision.reason}{decision.answer ? ' · ' + decision.answer : ''}<br />
              Автор {decision.authorId} · {date(decision.createdAt)} · версия {decision.version}</li>
          {/each}
        </ul>
      {/if}
      {#if detail.searchHistory.length}
        <h4>Версии поиска</h4>
        <ul class="plain-list">
          {#each detail.searchHistory as entry (entry.searchVersion)}
            <li><a href={route(detail.id, entry.searchVersion)}>Поиск {entry.searchVersion} · {label(entry.state)}</a></li>
          {/each}
        </ul>
      {/if}
    </article>
  {:else if detailLoading}
    <p role="status">Загружаем вопрос…</p>
  {/if}
</section>
