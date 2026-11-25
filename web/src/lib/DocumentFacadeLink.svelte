<script lang="ts">
  import { Commands } from './commands';
  import { originalUrl, renderAddress } from './copilot';
  import type { DocumentFacadeLink } from './facade-assessment';
  import { ApiError, describe, type Api } from './http';
  import Notice from './Notice.svelte';
  import { scopedUrl } from './workspace';

  type Snapshot = { version: number; current: boolean; editable: boolean; links: DocumentFacadeLink[];
    candidates: { id: string; label: string }[]; assessmentVersion?: number };
  let { api, path, projectId, pdf, page, editable }: {
    api: Api; path: string; projectId: string; pdf: boolean; page: number; editable: boolean;
  } = $props();
  const commands = new Commands(() => api);
  let expanded = $state(false);
  let result = $state<Snapshot>();
  let busy = $state(false);
  let retry = $state(0);
  let needsRefresh = $state(false);
  let problem = $state('');
  let savedVersion = $state<number>();
  let target = $state<'document' | 'place'>('document');
  let anchor = $state('');
  let facade = $state('');
  let facadeName = $state('');
  let reason = $state('');
  let newFacade = $derived(facade === 'new' || result?.candidates.length === 0);
  let validAnchor = $derived((pdf ? /^[1-9]\d{0,6}$/u : /^.+![A-Za-z]{1,3}[1-9]\d{0,6}$/u).test(anchor.trim()));

  $effect(() => {
    void retry;
    if (!expanded) return;
    const stop = new AbortController();
    void api.json<Snapshot>(path, { signal: stop.signal }).then((snapshot) => {
      if (stop.signal.aborted) return;
      result = snapshot;
      needsRefresh = false;
      problem = '';
    }).catch((error) => {
      if (!stop.signal.aborted) problem = describe(error);
    });
    return () => stop.abort();
  });

  async function save(event: SubmitEvent) {
    event.preventDefault();
    if (!result?.editable || !editable || !validAnchor || !reason.trim() || busy || needsRefresh) return;
    const choice = newFacade ? { facadeName: facadeName.trim() } : { facadeId: facade };
    if (newFacade ? !choice.facadeName : !choice.facadeId) return;
    busy = true;
    problem = '';
    savedVersion = undefined;
    try {
      const snapshot = await commands.send<Snapshot>(path, 'PUT', { target, pageOrAnchor: anchor.trim(), reason: reason.trim(), ...choice }, result.version);
      result = snapshot;
      savedVersion = snapshot.assessmentVersion;
      facade = '';
      facadeName = '';
      reason = '';
    } catch (error) {
      needsRefresh = error instanceof ApiError && (error.status === 412 || error.status === 404);
      problem = describe(error);
    } finally { busy = false; }
  }
</script>

<details bind:open={expanded} ontoggle={() => { if (expanded && pdf && !anchor) anchor = String(page); }}>
  <summary>Принадлежность документа или отдельного места фасаду</summary>
  {#if result && !result.current}<p>Историческая редакция. Связи доступны для просмотра.</p>{/if}
  {#if result?.links.length}
    <ul class="plain-list">
      {#each result.links as link (link.version)}
        <li>
          <strong>{link.facadeLabel}</strong> · {link.target === 'document' ? 'Вся редакция' : 'Указанное место'}
          <p>{link.reason}</p>
          <p class="meta">Решение №{link.version} · {link.authorName}</p>
          <div class="actions">
            <a href={originalUrl(link.basis.documentId, link.basis.versionId, link.basis.address.locator?.page)} target="_blank" rel="noopener noreferrer">Открыть оригинал · {renderAddress(link.basis.address)}</a>
            {#if result.current}<a href={scopedUrl(projectId, 'completeness', { context: link.assessmentContextId })}>Открыть область проверки</a>{/if}
          </div>
        </li>
      {/each}
    </ul>
  {:else if result}<p>Инженер ещё не установил принадлежность по этому оригиналу.</p>{/if}
  {#if editable && result?.editable}
    <form onsubmit={save}>
      <label>Объект привязки
        <select bind:value={target} disabled={busy}><option value="document">Вся редакция</option><option value="place">{pdf ? 'Страница PDF' : 'Ячейка XLSX'}</option></select>
      </label>
      <label>{pdf ? 'Страница с обозначением фасада' : 'Лист и ячейка с обозначением фасада'}
        <input bind:value={anchor} disabled={busy} inputmode={pdf ? 'numeric' : 'text'} placeholder={pdf ? '1' : 'Ведомость!I3'} maxlength="200" required />
      </label>
      {#if result.candidates.length}
        <label>Фасад
          <select bind:value={facade} disabled={busy} required>
            <option value="">Выберите фасад</option>
            {#each result.candidates as choice (choice.id)}<option value={choice.id}>{choice.label}</option>{/each}
            <option value="new">Указать новый фасад</option>
          </select>
        </label>
      {/if}
      {#if newFacade}
        <label>Обозначение нового фасада<input bind:value={facadeName} disabled={busy} maxlength="160" required /></label>
      {/if}
      <label>Обоснование принадлежности<textarea bind:value={reason} disabled={busy} maxlength="2000" required></textarea></label>
      <button disabled={busy || needsRefresh || !validAnchor || !reason.trim() || (newFacade ? !facadeName.trim() : !facade)}>Сохранить принадлежность</button>
    </form>
  {/if}
  <Notice kind="error" message={problem} />
  {#if problem}<button type="button" disabled={busy} onclick={() => retry++}>Обновить принадлежность</button>{/if}
  {#if savedVersion}<p role="status">Принадлежность сохранена. Оценка комплекта №{savedVersion} обновлена.</p>{/if}
</details>
