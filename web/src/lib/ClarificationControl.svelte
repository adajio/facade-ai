<script lang="ts">
  import { Commands } from './commands';
  import { conflictMessage } from './conflict';
  import { date } from './format';
  import { id, type Api } from './http';
  import { V1, type AssessmentQuestion } from './workspace';
  import ClarificationDetails from './ClarificationDetails.svelte';
  import Notice from './Notice.svelte';

  let { api, question, editable, refresh }: {
    api: Api; question: AssessmentQuestion; editable: boolean; refresh: () => void;
  } = $props();
  const commands = new Commands(() => api);
  let reason = $state('');
  let checked = $state(false);
  let version = $state<number>();
  let pending = $state(false);
  let problem = $state('');
  let saved = $derived(question.decision?.action === 'request_clarification' ? question.decision : undefined);
  let basis = $derived(saved?.clarification ?? question.clarification);

  async function confirm(event: SubmitEvent) {
    event.preventDefault();
    if (!editable || !basis || !checked || !reason.trim() || pending) return;
    const expected = version ?? question.version;
    pending = true;
    problem = '';
    try {
      await commands.send(V1 + '/questions/' + id(question.id) + '/decisions', 'POST',
        { action: 'request_clarification', requestExternal: true, reason: reason.trim() }, expected);
      reason = '';
      checked = false;
      version = undefined;
      refresh();
    } catch (error) {
      problem = conflictMessage(error, expected);
    } finally {
      pending = false;
    }
  }
</script>

{#if basis}
  <section class="clarification">
    <h3>Запрос на уточнение</h3>
    <ClarificationDetails {basis} />
    {#if saved}
      <p>Инженер подтвердил запрос для письма · {date(saved.createdAt)}</p>
      <p>{saved.reason}</p>
    {:else if editable}
      <form onsubmit={confirm}>
        <label><input type="checkbox" required bind:checked onchange={() => version ??= question.version} />
          Подтверждаю проверку закрытых описей, относящихся мест и допустимых аналогов</label>
        <label>Комментарий к запросу
          <textarea required maxlength="2000" bind:value={reason} oninput={() => version ??= question.version}></textarea>
        </label>
        <div class="actions">
          <button class="primary" disabled={pending || !checked || !reason.trim()}>Подтвердить запрос на уточнение</button>
          {#if version !== undefined && version !== question.version}
            <button type="button" onclick={() => { version = question.version; checked = false; problem = ''; }}>Уточнить по текущей проверке</button>
          {/if}
        </div>
      </form>
    {/if}
    <Notice kind="error" message={problem} />
  </section>
{/if}

<style>
  .clarification { border-block-start: 1px solid var(--line); margin-block-start: 16px; padding-block-start: 12px; }
  form { margin-block: 12px; }
</style>
