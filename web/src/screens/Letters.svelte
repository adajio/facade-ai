<script lang="ts">
  import { onMount } from 'svelte';
  import { Commands } from '../lib/commands';
  import { conflictMessage } from '../lib/conflict';
  import { date, label } from '../lib/format';
  import { ApiError, describe, endpoint, id, interrupted, issue, query, type Api } from '../lib/http';
  import { V1, projectApi, projectV1, scopedUrl, type Assessment, type Citation, type OpenEvidence, type Page, type WorkspaceProps } from '../lib/workspace';
  import EvidenceButtons from '../lib/EvidenceButtons.svelte';
  import Notice from '../lib/Notice.svelte';
  import WordingReviewForm from '../lib/WordingReview.svelte';
  import { managedWording, wordingFields, type WordingReview, type WordingSource } from '../lib/wording';

  type Selection = { questionId: string; questionVersion: number; decisionId: string };
  type Ground = Selection & {
    subject: string; action: string; recipient: string; wording: string;
    kind: string; alternativeWording?: string;
    basis?: { scope?: { name: string }; requiredFormats?: string[]; citations?: Citation[]; machine?: { citations?: Citation[] } };
    sources?: WordingSource[];
  };
  type Item = Ground & {
    id: string; editedWording?: string | null; wordingSha256?: string;
    wordingApproval?: WordingReview & { basisSha256: string };
  };
  type Summary = { id: string; number: number; scopeId?: string | null; assessmentContextId?: string | null; version: number; revisionId: string; status: string; recipient: string; createdAt: string };
  type RevisionRow = { id: string; version: number; status: string; createdAt: string };
  type Revision = RevisionRow & { items: Item[]; text: string; recipient: string; layout: 'formal' | 'brief' };
  type Export = { id: string; format: 'txt' | 'docx'; url: string; historicalUrl: string; revisionId: string };
  type ResponseRow = { id: string; kind: string; receivedAt: string };
  type SentRow = { id: string; revisionId: string; sentAt: string; recipient: string };
  type Sent = SentRow & { text: string; items: Item[]; registeredAt?: string };
  type Letter = Summary & { revisions: RevisionRow[]; sent: SentRow[]; responses: ResponseRow[]; exports: Export[] };
  type Eligible = { items: Ground[]; holds: unknown[] };
  type Supplement = { id: string; receiptId: string; sentId: string };

  let { api, context, renew, open }: { api: Api; context: WorkspaceProps; renew: () => void; open: OpenEvidence } = $props();
  const commands = new Commands(() => api);
  let letters = $state<Summary[]>([]);
  let cursor = $state<string | null>(null);
  let eligible = $state<Eligible>();
  let assessmentOutcome = $state('');
  let letter = $state<Letter>();
  let revision = $state<Revision>();
  let sentSnapshot = $state<Sent>();
  let responseRecord = $state<{ id: string; text: string; kind: string; receivedAt: string }>();
  let linked = $state<Supplement[]>([]);
  let preview = $state('');
  let previewError = $state('');
  let checked = $state<string[]>([]);
  let recipient = $state('');
  let draftRecipient = $state('');
  let layout = $state<'formal' | 'brief'>('formal');
  let wording = $state<Record<string, string>>({});
  let basedOn = $state<number>();
  let draftDirty = $state(false);
  let marks = $state<Record<string, WordingReview>>({});
  let sentBasis = $state<Revision>();
  let sentText = $state('');
  let sentRecipient = $state('');
  let sentAt = $state('');
  let itemIds = $state<string[]>([]);
  let responseKind = $state<'response' | 'refusal'>('response');
  let responseItem = $state('');
  let responseText = $state('');
  let responseAt = $state('');
  let busy = $state(false);
  let paging = $state(false);
  let problem = $state('');
  let eligibleError = $state('');
  let listError = $state('');
  let detailError = $state('');
  let status = $state('');
  let sentId = $derived(context.params.get('sent') ?? '');
  let activeResponse = $derived(context.params.get('response') ?? '');
  let historical = $derived(Boolean(context.revision || sentId || activeResponse));
  let activeId = $derived(context.objectId ?? '');
  let base = $derived(projectV1(context.project.id) + '/letters');
  let assessmentContextId = $derived(context.params.get('context') ||
    (letter?.id === activeId ? letter?.assessmentContextId : undefined) || undefined);
  let target = $derived(assessmentContextId ? { assessmentContextId } : { scopeId: context.scopeId || undefined });
  let current = $derived(letter?.id === activeId ? letter : undefined);
  let currentRevision = $derived(revision && current && revision.id === (context.revision ?? current.revisionId) ? revision : undefined);
  let choices = $derived((eligible?.items ?? []).filter((item) => !recipient || item.recipient === recipient));
  let reviewItems = $derived(currentRevision?.items.flatMap((item) => {
    const ground = currentGround(item);
    if (!ground || !item.editedWording || managedWording(item.editedWording, ground.wording, ground.alternativeWording)) return [];
    return [{ item, ground }];
  }) ?? []);
  let readyToConfirm = $derived(Boolean(currentRevision?.items.length && currentRevision.items.every((item) => currentGround(item))
    && reviewItems.every(({ item, ground }) => marks[reviewKey(item, ground)] || item.wordingApproval)));

  function path(letterId: string) {
    return V1 + '/letters/' + id(letterId);
  }
  function url(letterId?: string, params: Record<string, unknown> = {}) {
    return scopedUrl(context.project.id, 'letters', {
      scope: assessmentContextId ? undefined : context.scopeId, context: assessmentContextId,
      ...params,
    }, letterId);
  }
  function assessmentUrl(letter?: Summary, questionId?: string) {
    return scopedUrl(context.project.id, 'completeness', {
      scope: letter?.scopeId ?? (assessmentContextId ? undefined : context.scopeId),
      context: letter?.assessmentContextId ?? assessmentContextId,
    }, questionId);
  }
  function asSelection(item: Ground): Selection {
    return { questionId: item.questionId, questionVersion: item.questionVersion, decisionId: item.decisionId };
  }
  function currentGround(item: Ground) {
    return eligible?.items.find((ground) => ground.questionId === item.questionId && ground.recipient === draftRecipient);
  }

  function reviewKey(item: Item, ground: Ground) {
    return [item.id, item.wordingSha256, ground.questionId, ground.questionVersion, ground.decisionId].join('/');
  }

  function supports(item: Ground) {
    const sources = (item.sources ?? []).flatMap(({ address, label }) => address?.evidenceId
      ? [{ ...address, sourceLabel: label }]
      : []);
    const saved = item.basis?.citations ?? item.basis?.machine?.citations ?? [];
    if (item.kind !== 'confirmed_conflict') return sources.length ? sources : saved;

    // Some already-saved revisions carry fewer display sources than their stored basis.
    const distinct = new Map<string, Citation>();
    for (const citation of [...sources, ...saved]) {
      const key = JSON.stringify([citation.documentId ?? citation.evidenceId, citation.versionId,
        citation.sha256, sortAddress(citation.address), citation.value, citation.unit]);
      if (!distinct.has(key)) distinct.set(key, citation);
    }
    return [...distinct.values()];
  }

  function sortAddress(value: unknown): unknown {
    if (Array.isArray(value)) return value.map(sortAddress);
    if (!value || typeof value !== 'object') return value;
    return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b))
      .map(([key, entry]) => [key, sortAddress(entry)]));
  }

  $effect(() => {
    const scopeId = context.scopeId;
    const selection = target;
    const listPath = base;
    void context.refreshKey;
    const stop = new AbortController();
    listError = '';
    api.json<Page<Summary>>(query(listPath, selection), { signal: stop.signal }).then((page) => {
      letters = page.items;
      cursor = page.nextCursor ?? null;
    }).catch((error) => { if (!interrupted(error)) listError = describe(error); });
    eligible = undefined;
    if (selection.scopeId || selection.assessmentContextId) {
      eligibleError = '';
      api.json<Eligible>(query(listPath + '/eligible', selection), { signal: stop.signal })
        .then(async (result) => {
          eligible = result;
          assessmentOutcome = '';
          if (result.items.length || result.holds.length || selection.assessmentContextId) return;
          const outcome = await api.json<Assessment>(query(listPath.replace(/\/letters$/, '/assessments/current'), { scopeId }), {
            signal: stop.signal,
          }).catch(() => undefined);
          if (!stop.signal.aborted && outcome) assessmentOutcome = outcome.outcome;
        })
        .catch((error) => { if (!interrupted(error)) { eligible = undefined; eligibleError = describe(error); } });
    }
    return () => stop.abort();
  });

  $effect(() => {
    void activeId;
    void context.revision;
    draftDirty = false;
    marks = {};
    basedOn = undefined;
    sentBasis = undefined;
    status = '';
    problem = '';
  });

  $effect(() => {
    const letterId = activeId;
    const revisionId = context.revision;
    const sent = sentId;
    const response = activeResponse;
    const projectId = context.project.id;
    void context.refreshKey;
    if (!letterId) return;
    const abort = new AbortController();
    const signal = abort.signal;
    const selected = path(letterId);
    preview = '';
    previewError = '';
    detailError = '';
    async function load() {
      try {
        const item = await api.json<Letter>(selected, { signal });
        letter = item;
        if (sent) sentSnapshot = await api.json<Sent>(selected + '/sent/' + id(sent), { signal });
        if (response) responseRecord = await api.json(selected + '/responses/' + id(response), { signal });
        if (sent || response) return;
        const result = await api.json<Revision>(selected + '/revisions/' + id(revisionId ?? item.revisionId), { signal });
        revision = result;
        if (!draftDirty || revisionId) editFrom(result);
        if (!revisionId && item.status === 'confirmed') {
          try {
            preview = (await currentText(item, signal)).text;
          } catch (error) {
            if (!interrupted(error)) previewError = describe(error);
          }
        }
      } catch (error) {
        if (!interrupted(error)) { letter = undefined; detailError = describe(error); }
      }
    }
    void load();
    api.json<Page<Supplement>>(query(projectApi(projectId) + '/supplements/links', { letterId }), { signal })
      .then((page) => linked = page.items)
      .catch((error) => { if (!interrupted(error)) linked = []; });
    return () => abort.abort();
  });

  onMount(() => {
    const beforeUnload = (event: BeforeUnloadEvent) => {
      if (draftDirty || sentBasis) {
        event.preventDefault();
        event.returnValue = '';
      }
    };
    const guard = (event: Event) => {
      if ((draftDirty || sentBasis) && !window.confirm('Несохранённые правки. Покинуть страницу?')) event.preventDefault();
    };
    window.addEventListener('beforeunload', beforeUnload);
    window.addEventListener('facade:navigate', guard);
    return () => {
      window.removeEventListener('beforeunload', beforeUnload);
      window.removeEventListener('facade:navigate', guard);
    };
  });

  function markDraft() {
    basedOn ??= current?.version;
    draftDirty = true;
  }

  function editFrom(value: Revision) {
    wording = Object.fromEntries(value.items.map((item) => [item.questionId, item.editedWording ?? item.wording]));
    draftRecipient = value.recipient;
    layout = value.layout;
  }

  async function more() {
    if (!cursor || paging) return;
    const observed = context.refreshKey;
    paging = true;
    try {
      const page = await api.json<Page<Summary>>(query(base, { ...target, cursor }));
      if (observed !== context.refreshKey) return;
      const known = new Set(letters.map((item) => item.id));
      letters = [...letters, ...page.items.filter((item) => !known.has(item.id))];
      cursor = page.nextCursor ?? null;
    } catch (error) {
      listError = describe(error);
    } finally {
      paging = false;
    }
  }

  async function run(task: () => Promise<void>, version?: number, recheck = true) {
    if (busy) return;
    problem = '';
    status = '';
    busy = true;
    try {
      await task();
    } catch (error) {
      problem = conflictMessage(error, version);
      if (error instanceof ApiError && error.code === 'letter_wording_basis_mismatch') {
        const field = typeof error.details.field === 'string' ? wordingFields[error.details.field] : undefined;
        const subject = currentRevision?.items.find((item) => item.questionId === error.details.questionId)?.subject;
        problem = [error.message, subject, field].filter(Boolean).join(' · ');
      }
      if (error instanceof ApiError && [409, 412, 422].includes(error.status)) preview = '';
    } finally {
      busy = false;
      if (recheck) renew();
    }
  }

  function create(event: SubmitEvent) {
    event.preventDefault();
    const selected = choices.filter((item) => checked.includes(item.questionId));
    if (!selected.length) return;
    void run(async () => {
      const result = await commands.send<Summary>(base, 'POST', {
        ...target, recipient, items: selected.map(asSelection),
      });
      window.location.assign(url(result.id));
    });
  }

  function save(event: SubmitEvent) {
    event.preventDefault();
    const head = current;
    const selected = currentRevision;
    if (!head || !selected) return;
    const version = basedOn ?? head.version;
    void run(async () => {
      await commands.send(path(head.id), 'PATCH', {
        layout, recipient: draftRecipient,
        items: selected.items.filter((item) => typeof wording[item.questionId] === 'string').map((item) => ({
          questionId: item.questionId,
          wording: wording[item.questionId] === item.wording ? null : wording[item.questionId],
        })),
      }, version);
      draftDirty = false;
      basedOn = undefined;
      status = 'Редакция сохранена и ожидает подтверждения.';
    }, version);
  }

  function confirmRevision() {
    const head = current;
    if (!head || !currentRevision || !readyToConfirm) return;
    const selections = currentRevision.items.flatMap((item) => {
      const ground = currentGround(item);
      if (!ground) return [];
      const review = marks[reviewKey(item, ground)];
      return [{ ...asSelection(ground), ...(review && { review }) }];
    });
    void run(async () => {
      await commands.send(path(head.id) + '/confirm', 'POST', { items: selections }, head.version);
      status = 'Редакция подтверждена.';
    }, head.version);
  }

  function currentText(head: Letter, signal?: AbortSignal) {
    const version = issue(head.version).version!;
    return api.json<{ text: string; version: number; revisionId: string }>(path(head.id) + '/current-text', {
      signal, headers: { 'If-Match': version },
    });
  }

  function copy() {
    const head = current;
    if (!head) return;
    void run(async () => {
      const result = await currentText(head);
      await navigator.clipboard.writeText(result.text);
      status = 'Актуальный текст скопирован.';
    }, head.version, false);
  }

  function exportLetter(format: Export['format']) {
    const head = current;
    if (!head) return;
    void run(async () => {
      const result = await commands.send<Export>(path(head.id) + '/exports', 'POST', { format }, head.version);
      const file = await api.response(endpoint(result.url));
      const payload = await file.blob();
      const download = URL.createObjectURL(payload);
      try {
        const anchor = document.createElement('a');
        anchor.href = download;
        anchor.download = 'letter-' + head.number + '-v' + head.version + '.' + format;
        anchor.click();
        status = 'Выгрузка подготовлена.';
      } finally {
        setTimeout(() => URL.revokeObjectURL(download), 1000);
      }
    }, head.version);
  }

  function prepareSent() {
    if (!currentRevision || currentRevision.status !== 'confirmed') return;
    itemIds = currentRevision.items.map((item) => item.id);
    sentText = currentRevision.text;
    sentRecipient = currentRevision.recipient;
    sentAt = '';
    sentBasis = currentRevision;
  }

  function sendSnapshot(event: SubmitEvent) {
    event.preventDefault();
    if (!current || !sentBasis) return;
    const { id: letterId } = current;
    const selected = sentBasis;
    void run(async () => {
      const result = await commands.send<{ id?: string; sentId?: string }>(path(letterId) + '/sent', 'POST', {
        revisionId: selected.id, itemIds: selected.items.filter((item) => itemIds.includes(item.id)).map((item) => item.id),
        text: sentText, recipient: sentRecipient, sentAt: new Date(sentAt).toISOString(),
      });
      sentBasis = undefined;
      status = 'Факт внешней отправки зарегистрирован.';
      const target = result.id ?? result.sentId;
      if (target) window.location.assign(url(letterId, { sent: target }));
    });
  }

  function saveResponse(event: SubmitEvent) {
    event.preventDefault();
    if (!current || !sentSnapshot) return;
    const { id: letterId } = current;
    const sent = sentSnapshot;
    void run(async () => {
      await commands.send(path(letterId) + '/responses', 'POST', {
        sentId: sent.id, itemId: responseItem, kind: responseKind, text: responseText,
        receivedAt: new Date(responseAt).toISOString(),
      });
      responseText = '';
      status = 'Ответ сохранён в истории отправки.';
    });
  }
</script>

<Notice kind="error" message={listError} />
<Notice kind="error" message={problem} />
<Notice kind="success" message={status} />
{#if (context.scopeId || assessmentContextId) && !activeId}
  <section class="card">
    <h2>Пункты к запросу</h2>
    <Notice kind="error" message={eligibleError} />
    {#if eligible?.holds.length}
      <Notice message="Разбор поступивших материалов удерживает актуальную выдачу для этой области." />
    {:else if eligible && !eligible.items.length}
      <p>{assessmentOutcome === 'sufficient'
        ? 'Письмо не требуется. Комплект достаточен для выбранной области.'
        : 'Внешних оснований пока нет. Для письма нужны подтверждённые нехватка или противоречие.'}</p>
      <a href={assessmentUrl()}>Проверить комплектность</a>
    {:else if eligible?.items.length}
      {#if context.canEdit}
        <form onsubmit={create}>
          <label>Адресат<select bind:value={recipient} required onchange={() => checked = []}>
            <option value="">Выберите адресата</option>
            {#each [...new Set(eligible.items.map((item) => item.recipient))] as option (option)}
              <option value={option}>{option}</option>
            {/each}
          </select></label>
          <ul class="plain-list">
            {#each choices as item (item.questionId)}
              <li>
                <label><input type="checkbox" bind:group={checked} value={item.questionId} disabled={!recipient} /> {item.subject} · {label(item.kind)}</label>
                <p>{item.wording}</p>
                <EvidenceButtons citations={supports(item)} {open} />
              </li>
            {/each}
          </ul>
          <div class="actions"><button class="primary" disabled={busy || !recipient || !checked.length}>Сформировать черновик</button></div>
        </form>
      {:else}
        <ul class="plain-list">{#each eligible.items as item (item.questionId)}
          <li>{item.subject} · {label(item.kind)}<EvidenceButtons citations={supports(item)} {open} /></li>
        {/each}</ul>
      {/if}
    {/if}
  </section>
{/if}

<div class:split={Boolean(activeId)}>
  <section class="card table-card">
    <div class="card-header"><h2>Реестр писем</h2>{#if activeId}<a href={url()}>Подготовить письмо</a>{/if}</div>
    {#if letters.length}
      <div class="table-wrap">
        <table><thead><tr><th>Письмо</th><th>Адресат</th><th>Редакция</th></tr></thead>
          <tbody>{#each letters as item (item.id)}
            <tr><td><a class="row-link" href={url(item.id)} aria-current={activeId === item.id ? 'true' : undefined}>Письмо №{item.number}</a></td>
              <td>{item.recipient}</td><td>{item.version} · {label(item.status)}</td></tr>
          {/each}</tbody>
        </table>
      </div>
      {#if cursor}<div class="card-header"><button type="button" onclick={more} disabled={paging}>Ещё письма</button></div>{/if}
    {:else}<p class="empty">В области пока нет сохранённых писем.</p>{/if}
  </section>

  {#if activeId}
    <div>
      <Notice kind="error" message={detailError} />
      {#if current}
        <section class="card">
          <div class="card-header">
            <h2>Письмо №{current.number}</h2>
            {#if historical}<a href={url(current.id)}>К актуальной редакции</a>{:else}<span class="pill">{label(current.status)} · {current.version}</span>{/if}
          </div>
          {#if sentId && sentSnapshot?.id === sentId}
            <h3>История · снимок отправки</h3>
            <p>{sentSnapshot.recipient} · {date(sentSnapshot.sentAt)}</p>
            <pre>{sentSnapshot.text}</pre>
            <ul class="plain-list">{#each sentSnapshot.items as item (item.id)}
              <li>{item.subject}<EvidenceButtons citations={supports(item)} {open} />
                {#if context.canEdit}
                  <a href={scopedUrl(context.project.id, 'receipts', { scope: context.scopeId, letter: current.id, sent: sentId, item: item.id, upload: 1 })}>Добавить досылку по пункту</a>
                {/if}
              </li>
            {/each}</ul>
            {#if context.canEdit}
              <details><summary>Зарегистрировать ответ или отказ</summary>
                <form onsubmit={saveResponse}>
                  <label>Пункт<select bind:value={responseItem} required><option value="">Выберите пункт</option>
                    {#each sentSnapshot.items as item (item.id)}<option value={item.id}>{item.subject}</option>{/each}
                  </select></label>
                  <label>Вид<select bind:value={responseKind}><option value="response">Ответ</option><option value="refusal">Отказ</option></select></label>
                  <label>Получен<input type="datetime-local" bind:value={responseAt} required /></label>
                  <label>Текст<textarea required bind:value={responseText}></textarea></label>
                  <div class="actions"><button class="primary" disabled={busy}>Сохранить ответ</button></div>
                </form>
              </details>
            {/if}
          {:else if activeResponse && responseRecord?.id === activeResponse}
            <h3>{responseRecord.kind === 'refusal' ? 'Отказ' : 'Ответ'} · {date(responseRecord.receivedAt)}</h3>
            <pre>{responseRecord.text}</pre>
          {:else if currentRevision}
            {#if context.revision}
              <h3>История · редакция {currentRevision.version}</h3>
              <pre>{currentRevision.text}</pre>
            {:else if current.status === 'confirmed'}
              <h3>Предпросмотр актуального текста</h3>
              <Notice message={previewError} />
              {#if preview}
                <pre data-testid="current-letter-text">{preview}</pre>
                <div class="actions">
                  <button type="button" disabled={busy} onclick={copy}>Копировать текст</button>
                  {#if context.canEdit}
                    <button type="button" disabled={busy} onclick={() => exportLetter('txt')}>Выгрузить TXT</button>
                    <button type="button" disabled={busy} onclick={() => exportLetter('docx')}>Выгрузить DOCX</button>
                  {/if}
                </div>
              {/if}
            {:else}
              <h3>Сохранённый черновик</h3><pre>{currentRevision.text}</pre>
            {/if}
            <h3>Основания</h3>
            <ul class="plain-list">{#each currentRevision.items as item (item.id)}
              <li>
                <a href={assessmentUrl(current, item.questionId)}>{item.subject}</a>
                <EvidenceButtons citations={supports(item)} {open} />
              </li>
            {/each}</ul>
            {#if context.canEdit && currentRevision.status === 'confirmed'}
              <button type="button" onclick={prepareSent}>Зафиксировать отправку</button>
            {/if}
          {/if}
        </section>
        {#if context.canEdit && currentRevision && !historical}
          <details class="card">
            <summary>Редактировать формулировки</summary>
            <form onsubmit={save}>
              <label>Адресат<input bind:value={draftRecipient} required oninput={markDraft} /></label>
              <label>Оформление<select bind:value={layout} onchange={markDraft}>
                <option value="formal">Запрос исходных данных</option><option value="brief">Краткий запрос</option>
              </select></label>
              {#each currentRevision.items as item (item.id)}
                <label>{item.subject}<textarea bind:value={wording[item.questionId]} required oninput={markDraft}></textarea></label>
              {/each}
              {#if basedOn != null && basedOn !== current.version}
                <p class="notice">Исходная версия {basedOn}, текущая {current.version}. Ввод сохранён.</p>
                <button type="button" onclick={() => basedOn = current?.version}>Сверил правки с текущей версией</button>
              {/if}
              {#if draftDirty}<p class="meta">Есть несохранённые правки.</p>{/if}
              <div class="actions">
                <button class="primary" disabled={busy || !draftDirty}>Сохранить редакцию</button>
              </div>
            </form>
          </details>
          {#if current.status === 'draft' && !draftDirty}
            <section class="card">
              <h2>Допуск сохранённой редакции</h2>
              {#if currentRevision.items.some((item) => !currentGround(item))}
                <p class="notice">Для части пунктов изменились основания или получатель.</p>
                <a href={assessmentUrl(current)}>Сверить комплектность</a>
              {/if}
              {#each reviewItems as { item, ground } (reviewKey(item, ground))}
                {#if item.wordingSha256 && item.editedWording}
                  {#if item.wordingApproval}<p class="meta">У пункта есть сохранённая сверка. Сервер повторно проверит её при подтверждении.</p>{/if}
                  <WordingReviewForm wording={item.editedWording} hash={item.wordingSha256}
                    scope={ground.basis?.scope?.name ?? context.project.scopes.find((scope) => scope.id === current?.scopeId)?.name ?? ''}
                    subject={ground.subject} action={ground.action} formats={ground.basis?.requiredFormats ?? []}
                    sources={ground.sources ?? []} {open} publish={(review) => {
                      const key = reviewKey(item, ground);
                      if (review) marks[key] = review;
                      else delete marks[key];
                    }} />
                {:else}
                  <p class="notice">Сервер ещё не вернул хэш сохранённой авторской формулировки.</p>
                {/if}
              {/each}
              <div class="actions"><button type="button" class="primary" onclick={confirmRevision} disabled={busy || !readyToConfirm}>Подтвердить редакцию</button></div>
            </section>
          {/if}
        {/if}
        {#if sentBasis && context.canEdit}
          <section class="card">
            <h2>Факт внешней отправки · редакция {sentBasis.version}</h2>
            <form onsubmit={sendSnapshot}>
              <label>Фактический получатель<input required bind:value={sentRecipient} /></label>
              <label>Когда отправлено<input type="datetime-local" required bind:value={sentAt} /></label>
              <fieldset><legend>Отправленные пункты</legend>
                {#each sentBasis.items as item (item.id)}<label><input type="checkbox" bind:group={itemIds} value={item.id} /> {item.subject}</label>{/each}
              </fieldset>
              <label>Фактически отправленный текст<textarea rows="8" required bind:value={sentText}></textarea></label>
              <div class="actions">
                <button class="primary" disabled={busy || !itemIds.length}>Сохранить факт отправки</button>
                <button type="button" onclick={() => sentBasis = undefined}>Закрыть</button>
              </div>
            </form>
          </section>
        {/if}
        <section class="card">
          <h2>История</h2>
          <ul class="plain-list">
            {#each current.revisions as item (item.id)}<li><a href={url(current.id, { revision: item.id })}>Редакция {item.version}</a> · {label(item.status)} · {date(item.createdAt)}</li>{/each}
            {#each current.sent as item (item.id)}<li><a href={url(current.id, { sent: item.id })}>Снимок отправки · {date(item.sentAt)}</a></li>{/each}
            {#each current.responses as item (item.id)}<li><a href={url(current.id, { response: item.id })}>{item.kind === 'refusal' ? 'Отказ' : 'Ответ'} · {date(item.receivedAt)}</a></li>{/each}
            {#each current.exports as item (item.id)}<li><a href={endpoint(item.historicalUrl)} download>История · {item.format.toUpperCase()} · редакция {item.revisionId === current.revisionId ? current.version : current.revisions.find((record) => record.id === item.revisionId)?.version ?? ''}</a></li>{/each}
            {#each linked as item (item.id)}<li><a href={scopedUrl(context.project.id, 'receipts', { scope: context.scopeId }, item.receiptId)}>Связанная досылка</a></li>{/each}
          </ul>
        </section>
      {/if}
    </div>
  {/if}
</div>
