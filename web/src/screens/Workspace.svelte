<script lang="ts">
  import { tick, untrack } from 'svelte';
  import { available, type Project } from '../lib/contracts';
  import { ApiError, denied, describe, interrupted, query, type Api } from '../lib/http';
  import { Commands } from '../lib/commands';
  import { sections, type Route, type Section } from '../lib/routes';
  import { isEngineer, projectApi, scopedUrl, type Citation, type EventPage, type Projection } from '../lib/workspace';
  import Notice from '../lib/Notice.svelte';
  import EvidenceViewer from '../lib/EvidenceViewer.svelte';
  import Overview from './Overview.svelte';
  import Receipts from './Receipts.svelte';
  import Completeness from './Completeness.svelte';
  import Questions from './Questions.svelte';
  import Letters from './Letters.svelte';
  import Members from './Members.svelte';

  let { api, project, route, masked, refresh, onDenied }: {
    api: Api; project: Project; route: Route; masked: boolean; refresh: (foreground?: boolean) => Promise<void>;
    onDenied: () => void;
  } = $props();

  let section = $derived(route.section ?? 'overview');
  let scopes = $derived(project.scopes ?? []);
  let requestedScope = $derived(route.params.get('scope') ?? '');
  let scopeId = $derived(scopes.some((scope) => scope.id === requestedScope) ? requestedScope : (scopes[0]?.id ?? ''));
  let filter = $derived(route.params.get('filter') ?? '');
  let pinnedSlice = $derived(route.params.get('slice') ?? undefined);
  let revision = $derived(route.params.get('revision') ?? undefined);
  let projection = $state<Projection>();
  let subscriptionError = $state('');
  let refreshKey = $state(0);
  let refs = $state<Citation[]>([]);
  let selected = $state(0);
  let trigger: HTMLElement | undefined;
  let scopeName = $state('');
  let stage = $state('');
  let scopeForm = $state(false);
  let scopeBusy = $state(false);
  let scopeError = $state('');
  let loopRevision = $state(0);
  const commands = new Commands(() => api);
  const nav = Object.entries(sections) as [Section, string][];

  function scopeLink(next: Section = section, replacement = scopeId, sameContext = true) {
    return scopedUrl(project.id, next, {
      scope: replacement || undefined,
      ...(sameContext && next === section ? { filter, slice: pinnedSlice } : {}),
    });
  }

  function renew() {
    refreshKey += 1;
    loopRevision += 1;
  }

  $effect(() => {
    const base = projectApi(project.id);
    const activeScope = scopeId;
    if (masked) return;
    void loopRevision;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    let cursor: string | undefined;
    const signal = controller.signal;

    async function watch() {
      let events: EventPage['events'] = [];
      try {
        const requestSignal = AbortSignal.any([signal, AbortSignal.timeout(12_000)]);
        if (cursor !== undefined) {
          let position = cursor;
          for (;;) {
            const eventPath = query(base + '/events', { after: position, scopeId: activeScope, limit: 100 });
            const page = await api.json<EventPage>(eventPath, { signal: requestSignal });
            events = [...events, ...page.events].slice(-10);
            if (page.hasMore && page.cursor === position) throw new Error('Курсор не продвинулся');
            position = page.cursor;
            if (!page.hasMore) break;
          }
          if (!events.length) {
            subscriptionError = '';
            return;
          }
        }
        const before = cursor;
        const fresh = await api.json<Projection>(query(base + '/snapshot', { scopeId: activeScope }), {
          signal: requestSignal,
        });
        cursor = events.at(-1)?.cursor ?? fresh.cursor;
        const known = new Map((projection?.changes ?? []).map((item) => [item.cursor, item]));
        for (const item of events) known.set(item.cursor, item);
        projection = { ...fresh, changes: Array.from(known.values()).slice(-10).reverse() };
        subscriptionError = '';
        if (before !== cursor || before === undefined) refreshKey += 1;
      } catch (error) {
        if (signal.aborted || interrupted(error)) return;
        if (denied(error)) {
          // A missing route and a hidden project both return 404. Verify the
          // project itself before making either inference.
          if (error instanceof ApiError && error.status === 403) onDenied();
          else void refresh();
        }
        if (error instanceof ApiError && error.code === 'snapshot_required') {
          cursor = undefined;
          subscriptionError = 'Курсор устарел. Обновляем срез, ввод сохранён.';
        } else {
          cursor = undefined;
          subscriptionError = describe(error);
        }
      } finally {
        if (!signal.aborted) timer = setTimeout(watch, 2500);
      }
    }
    void watch();
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  });

  $effect(() => {
    void section;
    void scopeId;
    void route.objectId;
    const evidence = route.params.get('evidence');
    untrack(() => {
      refs = evidence ? [{ evidenceId: evidence, observationId: route.params.get('observation') ?? undefined }] : [];
      selected = 0;
      trigger = undefined;
    });
  });

  function address(index?: number) {
    const url = new URL(window.location.href);
    const ref = index === undefined ? undefined : refs[index];
    if (ref) {
      url.searchParams.set('evidence', ref.evidenceId);
      if (ref.observationId) url.searchParams.set('observation', ref.observationId);
      else url.searchParams.delete('observation');
    } else {
      url.searchParams.delete('evidence');
      url.searchParams.delete('observation');
    }
    history.replaceState(history.state, '', url);
  }

  function openEvidence(entries: Citation[], index: number, source: HTMLElement) {
    refs = entries;
    selected = index;
    trigger = source;
    address(index);
  }

  function closeEvidence() {
    refs = [];
    address();
    void tick().then(() => (trigger?.isConnected ? trigger : document.getElementById('main'))?.focus());
  }

  async function addScope(event: SubmitEvent) {
    event.preventDefault();
    if (scopeBusy) return;
    scopeError = '';
    scopeBusy = true;
    try {
      const created = await commands.send<{ id: string }>(projectApi(project.id) + '/scopes', 'POST', { name: scopeName, stage });
      await refresh();
      scopeForm = false;
      const link = scopeLink(section, created.id, false);
      if (created.id) window.location.assign(link);
      else renew();
    } catch (error) {
      scopeError = describe(error);
    } finally {
      scopeBusy = false;
    }
  }

  function chooseScope(event: Event) {
    const select = event.currentTarget as HTMLSelectElement;
    const url = scopeLink(section, select.value, false);
    if (!window.dispatchEvent(new Event('facade:navigate', { cancelable: true }))) select.value = scopeId;
    else window.location.assign(url);
  }

  let context = $derived({
    project, scopeId, sliceId: pinnedSlice ?? projection?.sliceId, filter, revision,
    params: route.params, cursor: projection?.cursor, objectId: route.objectId, canEdit: isEngineer(project), refreshKey,
  });
</script>

<div class="workspace">
  <aside class="project-nav">
    <a class="subtle" href="/projects">‹ Все проекты</a>
    <h2>{project.name}</h2>
    <nav aria-label="Разделы проекта">
      {#each nav as [key, name] (key)}
        {#if key !== 'members' || available(project, 'project:manage')}
          <a href={scopeLink(key)} aria-current={key === section ? 'page' : undefined}>{name}</a>
        {/if}
      {/each}
    </nav>
  </aside>
  <main id="main" class="work-main" tabindex="-1">
    <div class="heading">
      <div>
        <h1>{sections[section]}</h1>
        {#if project.catalog}<p>{project.catalog.name} · версия {project.catalog.revision}</p>{/if}
      </div>
      <button type="button" onclick={renew}>Обновить</button>
    </div>
    {#if section !== 'members'}
      <div class="toolbar">
        {#if scopes.length}
          <label>Стадия и область
            <select aria-label="Стадия и область" value={scopeId} onchange={chooseScope}>
              {#each scopes as scope (scope.id)}<option value={scope.id}>{scope.stage} · {scope.name}</option>{/each}
            </select>
          </label>
        {/if}
        {#if available(project, 'project:manage')}
          <button type="button" onclick={() => scopeForm = !scopeForm}>Добавить область</button>
        {/if}
        {#if projection}<span class="meta">Срез {projection.projectionVersion}</span>{/if}
      </div>
      {#if scopeForm}
        <form class="card" onsubmit={addScope}>
          <div class="form-row">
            <label>Название области<input bind:value={scopeName} required /></label>
            <label>Стадия<input bind:value={stage} required /></label>
          </div>
          <Notice kind="error" message={scopeError} />
          <div class="actions"><button class="primary" disabled={scopeBusy}>Сохранить область</button></div>
        </form>
      {/if}
      {#if subscriptionError}<Notice message={'Синхронизация проекта · ' + subscriptionError} />{/if}
      {#if pinnedSlice && projection && pinnedSlice !== projection.sliceId}
        <p class="notice">Появился новый срез. <a href={scopedUrl(project.id, section, { scope: scopeId, filter }, route.objectId)}>Открыть актуальный</a></p>
      {/if}
    {/if}
    <div class:with-evidence={refs.length > 0} class="project-content">
      <div class="section-content">
        {#key section + '/' + scopeId}
          {#if section === 'overview'}
            <Overview {api} {context} {projection} />
          {:else if section === 'receipts'}
            <Receipts {api} {context} {projection} {renew} open={openEvidence} />
          {:else if section === 'completeness'}
            <Completeness {api} {context} {renew} open={openEvidence} />
          {:else if section === 'questions' || section === 'facts'}
            <Questions {api} {context} mode={section} {renew} open={openEvidence} />
          {:else if section === 'letters'}
            <Letters {api} {context} {renew} open={openEvidence} />
          {:else if section === 'members' && available(project, 'project:manage')}
            <Members {api} {project} {refresh} />
          {:else}
            <Notice kind="error" message="Ресурс недоступен." />
          {/if}
        {/key}
      </div>
      {#if refs.length}
        <EvidenceViewer {api} {refs} index={selected} close={closeEvidence} verify={() => refresh(true)}
          select={(index) => { selected = index; address(index); }} />
      {/if}
    </div>
  </main>
</div>

<style>
  .section-content { min-width: 0; }
  @media (min-width: 1141px) {
    .with-evidence { display: grid; grid-template-columns: minmax(0, 1fr) minmax(330px, .85fr); gap: .9rem; }
  }
</style>
