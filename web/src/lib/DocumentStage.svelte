<script lang="ts">
  import { Commands } from './commands';
  import { ApiError, describe, query, type Api } from './http';
  import Notice from './Notice.svelte';

  type Saved = { stage: string | null; reason: string | null; actorId: string | null; actorName?: string; version: number;
    originalBasis?: { label: string; address: { locator?: { page?: number; sheet?: string; cell?: string } } } | null };
  let { api, path, pdf, page, editable, renew }: {
    api: Api; path: string; pdf: boolean; page: number; editable: boolean; renew: () => void;
  } = $props();
  const commands = new Commands(() => api);
  let expanded = $state(false);
  let target = $state<'document' | 'place'>('document');
  let anchor = $state('');
  let stage = $state('');
  let reason = $state('');
  let saved = $state<Saved>();
  let busy = $state(false);
  let message = $state('');
  let problem = $state('');
  let retry = $state(0);
  let validAnchor = $derived(pdf ? /^[1-9]\d{0,6}$/.test(anchor) : /^.+![A-Za-z]{1,3}[1-9]\d{0,6}$/.test(anchor));
  let lookup = $derived(target === 'document' ? path : validAnchor ? query(path, { pageOrAnchor: anchor.trim() }) : '');
  $effect(() => {
    const read = lookup;
    void retry;
    if (!expanded) return;
    saved = undefined;
    problem = '';
    message = '';
    if (!read) return;
    const stop = new AbortController();
    void api.json<Saved>(read, { signal: stop.signal }).then((value) => {
      if (!stop.signal.aborted) saved = value;
    }).catch((error) => { if (!stop.signal.aborted) problem = describe(error); });
    return () => stop.abort();
  });
  async function save(event: SubmitEvent) {
    event.preventDefault();
    if (!saved || !validAnchor || !stage.trim() || !reason.trim() || busy) return;
    busy = true;
    problem = '';
    try {
      saved = await commands.send<Saved>(path, 'PUT', { stage: stage.trim(), reason: reason.trim(), target, pageOrAnchor: anchor.trim() }, saved.version);
      message = 'Стадия сохранена.';
      renew();
    } catch (error) {
      problem = describe(error);
      if (error instanceof ApiError && error.status === 412) saved = undefined;
    } finally { busy = false; }
  }
</script>

<details bind:open={expanded} ontoggle={() => { if (expanded && pdf && !anchor) anchor = String(page); }}>
  <summary>Стадия документа или отдельного места</summary>
  <form onsubmit={save}>
    <label>К чему относится стадия
      <select bind:value={target} disabled={busy}><option value="document">Ко всей редакции</option><option value="place">{pdf ? 'К странице PDF' : 'К ячейке XLSX'}</option></select>
    </label>
    {#if editable || target === 'place'}
      <label>{pdf ? 'Страница с указанием стадии' : 'Лист и ячейка с указанием стадии'}
        <input bind:value={anchor} disabled={busy} placeholder={pdf ? '1' : 'Ведомость!I3'} maxlength="200" required />
      </label>
    {/if}
    {#if saved?.stage}
      <p>Подтверждённая стадия · <strong>{saved.stage}</strong>. {saved.reason}</p>
      <p class="meta">Подтверждение №{saved.version} · {saved.actorName ?? saved.actorId}</p>
      {#if saved.originalBasis}
        {@const location = saved.originalBasis.address.locator}
        <p>Оригинал · {saved.originalBasis.label} · {location?.page ? 'страница ' + location.page : location?.sheet + '!' + location?.cell}</p>
      {/if}
    {:else if saved}<p>Инженер ещё не подтверждал стадию для выбранного объекта.</p>{/if}
    {#if editable}
      <label>Обозначение стадии<input bind:value={stage} disabled={busy} maxlength="160" required placeholder="Например, РД" /></label>
      <label>Обоснование стадии<textarea bind:value={reason} disabled={busy} maxlength="500" required></textarea></label>
      <button disabled={!saved || !validAnchor || !reason.trim() || !stage.trim() || busy}>Сохранить стадию</button>
    {/if}
  </form>
  <Notice kind="error" message={problem} />
  {#if problem}<button type="button" disabled={busy} onclick={() => retry++}>Обновить подтверждение</button>{/if}
  {#if message}<p role="status">{message}</p>{/if}
</details>
