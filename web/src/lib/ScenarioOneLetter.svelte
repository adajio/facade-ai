<script lang="ts">
  import { Commands } from './commands';
  import { date } from './format';
  import { describe, id, type Api } from './http';
  import { projectV1, scopedUrl } from './workspace';
  import Notice from './Notice.svelte';

  type Kind = 'draft' | 'sent' | 'response';
  type Answer = 'answered' | 'closed' | 'refused';
  type Letter = { version: number; text: string; requests: { key: string; text: string }[];
    history: { version: number; kind: Kind; body: string; createdAt: string; requestKey?: string; responseState?: Answer }[] };
  let { api, projectId, reviewId, isCurrent }: { api: Api; projectId: string; reviewId: string; isCurrent: boolean } = $props();
  const commands = new Commands(() => api);
  const path = $derived(projectV1(projectId) + '/preliminary-package-reviews/' + id(reviewId) + '/scenario-one-letter');
  const labels: Record<Kind,string> = { draft: 'Редакция черновика', sent: 'Зафиксированная отправка', response: 'Ответ заказчика' };
  let letter = $state<Letter>();
  let text = $state('');
  let response = $state('');
  let requestKey = $state('');
  let responseState = $state<Answer>('answered');
  let status = $state('');
  let error = $state('');
  let pending = $state(false);
  let recordingResponse = $state(false);
  let changed = $derived(Boolean(letter && text !== letter.text));

  async function load(signal?: AbortSignal, replace = true) {
    try {
      const value = await api.json<Letter>(path,{signal});
      if (signal?.aborted) return;
      letter = value;
      if (replace) text = value.text;
      error = '';
    } catch (failure) {
      if (!signal?.aborted) error = describe(failure);
    }
  }
  $effect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
  });

  async function record(kind: Kind) {
    if (!letter || pending) return;
    pending = true;
    error = '';
    status = '';
    try {
      const body = kind === 'draft' ? text : kind === 'response' ? response : undefined;
      letter = await commands.send<Letter>(path,'POST',{kind,version:letter.version,body,
        ...(kind === 'response' && requestKey ? {requestKey,responseState} : {})});
      text = letter.text;
      if (kind === 'response') { response = ''; requestKey = ''; responseState = 'answered'; recordingResponse = false; }
      status = kind === 'draft' ? 'Редакция сохранена.' : kind === 'sent' ? 'Факт отправки сохранён.' : 'Ответ сохранён.';
    } catch (failure) {
      error = describe(failure);
    } finally { pending = false; }
  }

  async function copy() {
    try {
      await navigator.clipboard.writeText(text);
      status = 'Текст скопирован.';
    } catch { status = 'Выделите и скопируйте текст из поля.'; }
  }
</script>

<Notice kind="error" message={error} />
{#if letter}
  <label>Текст черновика
    <textarea bind:value={text} rows="14" disabled={pending} readonly={!isCurrent}></textarea>
  </label>
  <div class="actions">
    <button type="button" disabled={pending || !isCurrent || !changed || !text.trim()} onclick={() => record('draft')}>Сохранить редакцию</button>
    <button type="button" onclick={copy}>Скопировать текст</button>
    <button type="button" disabled={pending || changed || !isCurrent} onclick={() => record('sent')}>Отметить внешнюю отправку</button>
    <a href={scopedUrl(projectId,'receipts',{ upload: '1', analysisBase: reviewId })}>Загрузить досылку</a>
    {#if letter.history.some(event => event.kind === 'sent')}
      <button type="button" onclick={() => recordingResponse = !recordingResponse}>Записать ответ</button>
    {/if}
    <span role="status">{status}</span>
  </div>
  {#if recordingResponse}
    {#if letter.requests.length}
      <label>Пункт письма<select bind:value={requestKey}>
        <option value="">Ответ на письмо в целом</option>
        {#each letter.requests as request (request.key)}<option value={request.key}>{request.text}</option>{/each}
      </select></label>
    {/if}
    {#if requestKey}
      <label>Результат<select bind:value={responseState}>
        <option value="answered">Получено пояснение</option>
        <option value="closed">Инженер закрыл запрос</option>
        <option value="refused">Заказчик отказал</option>
      </select></label>
    {/if}
    <label>Ответ заказчика<textarea rows="4" bind:value={response}></textarea></label>
    <button type="button" disabled={pending || changed || !response.trim()} onclick={() => record('response')}>Сохранить ответ</button>
  {/if}
  {#if letter.history.length}
    <details>
      <summary>История черновика и переписки</summary>
      {#each letter.history as event (event.version)}
        <details>
          <summary>{labels[event.kind]} · {date(event.createdAt)}</summary>
          <p class="saved-text">{event.body}</p>
        </details>
      {/each}
    </details>
  {/if}
  {#if error}
    <button type="button" onclick={() => load(undefined, false)}>Получить текущую редакцию с сервера</button>
  {/if}
{/if}

<style>
  textarea { width: 100%; }
  .saved-text { white-space: pre-wrap; }
</style>
