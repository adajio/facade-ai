<script lang="ts">
  import { Commands } from '../lib/commands';
  import { conflictMessage } from '../lib/conflict';
  import { describe, id, query, type Api } from '../lib/http';
  import { renderAddress, type SourceAddress } from '../lib/copilot';
  import type { FacadeContext, FacadeObservation } from '../lib/facade-assessment';
  import { projectV1, type OpenEvidence, type WorkspaceProps } from '../lib/workspace';
  import Notice from '../lib/Notice.svelte';

  type Page = { version: number; items: FacadeObservation[]; nextCursor: string | null };
  let { api, context, facade, assessmentVersion, historical, open, refreshProject }: {
    api: Api; context: WorkspaceProps; facade: FacadeContext; assessmentVersion: number; historical: boolean;
    open: OpenEvidence; refreshProject: () => Promise<void>;
  } = $props();
  const commands = new Commands(() => api);
  const stateLabels = { confirmed: 'Подтверждён', unconfirmed: 'Требуется подтверждение', stale: 'Основание требует повторной сверки' };
  let candidates = $state<FacadeObservation[]>([]);
  let observationId = $state('');
  let reason = $state('');
  let problem = $state('');
  let loadProblem = $state('');
  let saved = $state(false);
  let pending = $state(false);
  let opened = $state(false);
  let loading = $state(false);
  let expectedVersion = $state<number>();
  let facadeType = $derived(facade.facadeType);
  let selected = $derived(candidates.find(({ id }) => id === observationId));

  $effect(() => {
    const version = assessmentVersion;
    const projectId = context.project.id;
    const facadeId = facade.facadeId;
    if (historical || !context.canEdit || !opened || !facadeId) return;
    const base = projectV1(projectId) + '/facade-assessment/' + id(version) + '/observations';
    const stop = new AbortController();
    loading = true;
    loadProblem = '';
    async function load() {
      const found: FacadeObservation[] = [];
      try {
        let cursor: string | null = null;
        do {
          const page: Page = await api.json<Page>(query(base, { facadeId, binding: 'identified', proposal: 'facadeKind', after: cursor, limit: 100 }), { signal: stop.signal });
          if (page.version !== version || page.nextCursor && page.nextCursor === cursor) throw new Error('Не удалось проверить версию опор');
          found.push(...page.items.filter((item) => item.proposedFacadeKind && item.facadeKindSourceVerified
            && item.revisionStatus === 'current' && item.binding.candidates.length === 1));
          cursor = page.nextCursor;
        } while (cursor);
        candidates = found;
      } catch (error) {
        if (!stop.signal.aborted) { loadProblem = describe(error); candidates = []; }
      } finally {
        if (!stop.signal.aborted) loading = false;
      }
    }
    void load();
    return () => stop.abort();
  });

  async function save(event: SubmitEvent) {
    event.preventDefault();
    if (!selected?.proposedFacadeKind || !facade.facadeId || pending || historical) return;
    const version = expectedVersion ?? context.project.version;
    pending = true;
    problem = '';
    saved = false;
    try {
      await commands.send(projectV1(context.project.id) + '/facade-assessment/facades/' + id(facade.facadeId) + '/kind',
        'PUT', { kind: selected.proposedFacadeKind, observationId: selected.id, reason }, version);
      reason = '';
      observationId = '';
      expectedVersion = undefined;
      opened = false;
      saved = true;
      await refreshProject();
    } catch (error) {
      problem = conflictMessage(error, version);
    } finally {
      pending = false;
    }
  }
</script>

{#if facadeType}
  <h3>Тип фасада</h3>
  <p>{facadeType.kind ? facadeType.kind + ' · ' : ''}{stateLabels[facadeType.state]}</p>
  {#if facadeType.basis}
    {@const basis = facadeType.basis}
    <p>Редакция {basis.revision} · {renderAddress(basis.address)}</p>
    {#if basis.quote}<blockquote>{basis.quote}</blockquote>{/if}
    <button type="button" onclick={(event) => open([{ evidenceId: basis.evidenceId, observationId: basis.id,
      versionId: basis.versionId, quote: basis.quote ?? undefined }], 0, event.currentTarget)}>Открыть опору типа</button>
  {/if}
  {#if context.canEdit && !historical}
    {#if opened}
      <form onsubmit={save}>
        <Notice kind="error" message={loadProblem} />
        {#if loading}<p role="status">Загружаем адресные опоры типа…</p>{/if}
        {#if !loading && !candidates.length && !loadProblem}
          <p>Для этого фасада ещё нет проверенной опоры типа в действующей редакции.</p>
        {:else if candidates.length}
          <label>Тип и адресная опора
            <select bind:value={observationId} required onchange={() => expectedVersion ??= context.project.version}>
              <option value="">Выберите адресную опору</option>
              {#each candidates as item (item.id)}
                <option value={item.id}>{item.proposedFacadeKind} · {item.revision ?? 'редакция не указана'} · {renderAddress(item.address as SourceAddress)}</option>
              {/each}
            </select>
          </label>
          {#if selected?.evidenceId}
            <button type="button" onclick={(event) => open([{ evidenceId: selected!.evidenceId!, observationId: selected!.id,
              versionId: selected!.versionId, quote: selected!.quote ?? undefined }], 0, event.currentTarget)}>Проверить выбранную опору</button>
          {/if}
          <label>Основание назначения типа
            <textarea required maxlength="2000" bind:value={reason} oninput={() => expectedVersion ??= context.project.version}></textarea>
          </label>
          <button class="primary" type="submit" disabled={pending || loading || !selected}>Сохранить тип фасада</button>
          {#if problem}
            <button type="button" disabled={pending} onclick={async () => { await refreshProject(); expectedVersion = undefined; problem = ''; }}>Сверить версию проекта</button>
          {/if}
        {/if}
        <button type="button" class="quiet" onclick={() => opened = false}>Закрыть выбор</button>
      </form>
    {:else}
      <button type="button" onclick={() => opened = true}>{facadeType.state === 'confirmed' ? 'Изменить тип фасада' : 'Подтвердить тип фасада'}</button>
    {/if}
  {/if}
  <Notice kind="error" message={problem} />
  {#if saved}<p role="status">Тип фасада сохранён.</p>{/if}
{/if}
