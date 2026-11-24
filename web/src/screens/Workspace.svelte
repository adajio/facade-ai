<script lang="ts">
  import { tick, untrack } from 'svelte';
  import { available, type Project, type Session } from '../lib/contracts';
  import { ApiError, denied, describe, interrupted, query, type Api } from '../lib/http';
  import { Commands } from '../lib/commands';
  import { sections, type Route, type Section } from '../lib/routes';
  import { isEngineer, projectApi, scopedUrl, type Citation, type EventPage, type Projection } from '../lib/workspace';
  import Notice from '../lib/Notice.svelte';
  import EvidenceViewer from '../lib/EvidenceViewer.svelte';
  import DualEvidenceViewer from '../lib/DualEvidenceViewer.svelte';
  import NavRail from '../lib/NavRail.svelte';
  import SplitHandle from '../lib/SplitHandle.svelte';
  import { copy } from '../lib/copy';
  import type { CopilotBudget } from '../lib/copilot';
  import type { EvidenceActions } from '../lib/workspace';
  import { triageOptions, type Triage } from '../lib/triage';
  import Overview from './Overview.svelte';
  import Receipts from './Receipts.svelte';
  import Completeness from './Completeness.svelte';
  import FacadeAssessment from './FacadeAssessment.svelte';
  import Questions from './Questions.svelte';
  import Letters from './Letters.svelte';
  import Members from './Members.svelte';
  import Fragments from './Fragments.svelte';
  import Copilot from './Copilot.svelte';

  let { api, project, route, masked, session, signOut, navigate, refresh, onDenied, setDocumentPage }: {
    api: Api; project: Project; route: Route; masked: boolean; refresh: (foreground?: boolean) => Promise<void>;
    session: Session; signOut: () => void; navigate: (path: string) => boolean;
    onDenied: () => void; setDocumentPage: (page?: number) => void;
  } = $props();

  let section = $derived(route.section ?? 'overview');
  let isolatedSection = $derived(section === 'fragments' || section === 'copilot');
  let projectId = $derived(project.id);
  let scopes = $derived(project.scopes ?? []);
  let requestedScope = $derived(route.params.get('scope') ?? '');
  let scopeId = $derived(scopes.some((scope) => scope.id === requestedScope) ? requestedScope : (scopes[0]?.id ?? ''));
  let filter = $derived(route.params.get('filter') ?? '');
  let pinnedSlice = $derived(route.params.get('slice') ?? undefined);
  let revision = $derived(route.params.get('revision') ?? undefined);
  let objectId = $derived(route.objectId);
  let evidenceId = $derived(route.params.get('evidence'));
  let observationId = $derived(route.params.get('observation') ?? undefined);
  let evidenceComponent = $derived(route.params.get('component'));
  let projection = $state<Projection>();
  let copilotBudget = $state<CopilotBudget>();
  let synchronizedAt = $state<number>();
  let subscriptionError = $state('');
  let refreshKey = $state(0);
  let refs = $state<Citation[]>([]);
  let comparison = $state<{ actions?: EvidenceActions }>();
  let selected = $state(0);
  let componentIndex = $state<number>();
  let trigger: HTMLElement | undefined;
  let scopeName = $state('');
  let stage = $state('');
  let scopeForm = $state(false);
  let scopeBusy = $state(false);
  let scopeError = $state('');
  let loopRevision = $state(0);
  let collapsed = $state(localStorage.getItem('ui.railCollapsed') === 'true');
  let autoCollapsed = $state(false);
  let layoutWidth = $state<55 | 56>(55);
  let compact = $state(false);
  let splitWidth = $state<number>();
  let drawer = $state(false);
  let drawerWidth = $state(62);
  let triage = $state<Triage>();
  let lastMatrix = $state<string>();
  let reviewSection = $derived(section === 'completeness' || section === 'facts' || section === 'questions');
  let evidenceOpen = $derived(refs.length > 0 && !masked);
  let effectiveCollapsed = $derived(compact || autoCollapsed || collapsed);
  let width = $derived(splitWidth ?? layoutWidth);
  let navCounts = $derived({
    receipts: projection?.navCounts?.activeUploads,
    completeness: projection?.navCounts?.needsReview,
    letters: projection?.navCounts?.readyForLetter,
    members: projection?.navCounts?.members,
  });
  const commands = new Commands(() => api);

  function resize() {
    compact = matchMedia('(min-width: 851px) and (max-width: 1140px)').matches;
    layoutWidth = matchMedia('(max-width: 1366px)').matches ? 56 : 55;
  }
  resize();

  $effect(() => {
    const copilotSource = section === 'copilot' && route.params.has('source');
    autoCollapsed = (evidenceOpen || copilotSource) && layoutWidth === 56 && !compact;
    if (!evidenceOpen) drawer = false;
  });

  $effect(() => {
    const id = projectId;
    if (masked || !isEngineer(project)) return;
    const stop = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    async function refreshBudget() {
      try {
        copilotBudget = await api.json<CopilotBudget>(projectApi(id) + '/copilot/budget', { signal: stop.signal });
      } catch {
        if (!stop.signal.aborted) copilotBudget = { state: 'unavailable' };
      } finally {
        if (!stop.signal.aborted) timer = setTimeout(refreshBudget, 15_000);
      }
    }
    void refreshBudget();
    return () => { stop.abort(); clearTimeout(timer); copilotBudget = undefined; };
  });

  $effect(() => {
    void scopeId;
    triage = undefined;
    lastMatrix = undefined;
  });

  $effect(() => {
    if (section === 'completeness') {
      const link = scopedUrl(project.id, section, {
        scope: scopeId, context: route.params.get('context'), filter, revision, slice: pinnedSlice,
      }, objectId);
      lastMatrix = link;
    }
  });

  function toggleRail() {
    collapsed = !effectiveCollapsed;
    autoCollapsed = false;
    localStorage.setItem('ui.railCollapsed', String(collapsed));
  }

  function resizeViewer(value: number) {
    splitWidth = Math.max(35, Math.min(68, value));
  }

  function resizeDrawer(value: number) {
    drawerWidth = Math.max(35, Math.min(68, value));
  }

  function keyboard(event: KeyboardEvent) {
    if (event.defaultPrevented || event.altKey || event.isComposing ||
        (event.target instanceof HTMLElement && event.target.closest('input, textarea, select, [contenteditable]'))) return;
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'b' && !compact) {
      event.preventDefault();
      toggleRail();
    } else if (evidenceOpen && !event.metaKey && !event.ctrlKey && ['[', ']'].includes(event.key)) {
      event.preventDefault();
      if (compact) {
        drawer = true;
        resizeDrawer(drawerWidth + (event.key === ']' ? 5 : -5));
      } else resizeViewer(width + (event.key === ']' ? 5 : -5));
    } else if (reviewSection && !event.metaKey && !event.ctrlKey) {
      const tab = triageOptions[Number(event.key) - 1];
      if (tab && section === 'completeness' && !filter && !evidenceOpen) {
        event.preventDefault();
        triage = tab;
      } else if (!evidenceOpen && ['j', 'k', 'ArrowDown', 'ArrowUp'].includes(event.key) &&
          (event.target === document.body || event.target instanceof HTMLElement && event.target.closest('#main'))) {
        const rows = Array.from(document.querySelectorAll<HTMLElement>('[data-triage-row]'));
        if (!rows.length) return;
        const selected = rows.indexOf(document.activeElement as HTMLElement);
        if (event.key.startsWith('Arrow') && selected < 0) return;
        const direction = ['j', 'ArrowDown'].includes(event.key) ? 1 : -1;
        event.preventDefault();
        rows[selected < 0 ? 0 : Math.max(0, Math.min(rows.length - 1, selected + direction))]?.focus();
      }
    }
  }

  function scopeLink(next: Section = section, replacement = scopeId, sameContext = true) {
    return scopedUrl(project.id, next, {
      scope: replacement || undefined,
      ...(sameContext && next === section ? { filter, slice: pinnedSlice } : {}),
      ...(sameContext && project.intakeMode && !scopeId && reviewSection && (next === 'facts' || next === 'questions')
        ? { context: route.params.get('context') } : {}),
      ...(next === 'fragments' && section === 'fragments' && isEngineer(project) ? {
        document: route.params.get('document'), version: route.params.get('version'), page: route.params.get('page'),
      } : {}),
    });
  }

  function renew() {
    refreshKey += 1;
    loopRevision += 1;
  }

  $effect(() => {
    const base = projectApi(projectId);
    const activeScope = scopeId;
    if (masked || isolatedSection) return;
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
            synchronizedAt = Date.now();
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
        synchronizedAt = Date.now();
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
          subscriptionError = copy.snapshotRequired;
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
    void projectId;
    void scopeId;
    projection = undefined;
    subscriptionError = '';
    synchronizedAt = undefined;
  });

  $effect(() => {
    void section;
    void scopeId;
    void objectId;
    const evidence = isolatedSection ? null : evidenceId;
    const observation = observationId;
    const component = evidenceComponent;
    untrack(() => {
      refs = evidence ? [{ evidenceId: evidence, observationId: observation }] : [];
      comparison = undefined;
      selected = 0;
      componentIndex = component && /^\d{1,2}$/u.test(component) ? Number(component) : undefined;
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
      if (ref.observationId && componentIndex !== undefined) url.searchParams.set('component', String(componentIndex));
      else url.searchParams.delete('component');
    } else {
      url.searchParams.delete('evidence');
      url.searchParams.delete('observation');
      url.searchParams.delete('component');
    }
    history.replaceState(history.state, '', url);
  }

  function openEvidence(entries: Citation[], index: number, source: HTMLElement, options?: { actions?: EvidenceActions }) {
    refs = entries;
    comparison = options;
    selected = index;
    componentIndex = undefined;
    trigger = source;
    address(index);
    void tick().then(() => {
      const pane = source.closest('.section-content');
      if (!pane || !matchMedia('(min-width: 851px)').matches) return;
      window.scrollTo(0, 0);
      const row = pane.querySelector('[data-triage-row][aria-current="true"], [data-triage-row][aria-pressed="true"]') ?? source;
      pane.scrollTop += row.getBoundingClientRect().top - pane.getBoundingClientRect().top - 24;
    });
  }

  function closeEvidence() {
    refs = [];
    comparison = undefined;
    componentIndex = undefined;
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
      if (created.id) navigate(link);
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
    if (!navigate(url)) select.value = scopeId;
  }

  let context = $derived({
    project, scopeId, sliceId: pinnedSlice ?? projection?.sliceId, filter, revision,
    params: route.params, cursor: projection?.cursor, objectId, canEdit: isEngineer(project), masked, refreshKey, setDocumentPage,
  });
</script>

<svelte:window onresize={resize} onkeydown={keyboard} />

<header class="topbar">
  <nav aria-label="Путь к проекту" class="crumbs">
    <a class="brand" href="/projects"><span class="brand-mark" aria-hidden="true"></span> Facade AI</a>
    <a class="projects-crumb" href="/projects">Проекты</a>
    <span class="project-name" title={project.name}>{project.name}</span>
  </nav>
  {#if section !== 'members' && scopes.length}
    <select class="scope-select" aria-label="Стадия и область" value={scopeId} onchange={chooseScope}>
      {#each scopes as scope (scope.id)}<option value={scope.id}>{scope.name} · {scope.stage}</option>{/each}
    </select>
  {/if}
  <div class="topbar-actions">
    {#if !isolatedSection}
      {#if pinnedSlice && projection && pinnedSlice !== projection.sliceId}
        {@const currentQuery = Object.fromEntries([...route.params].filter(([key]) => key !== 'slice'))}
        <a class="sync pending-data" title={copy.newData} href={scopedUrl(project.id, section, currentQuery, route.objectId)}>Есть новые данные</a>
      {:else}
        <details class="sync-menu">
          <summary class="sync" class:sync-error={Boolean(subscriptionError)}><span aria-hidden="true"></span>
            {subscriptionError ? 'Нет связи' : synchronizedAt ? 'Синхр. OK' : 'Синхронизация…'}
          </summary>
          <div class="sync-details">
            {#if projection}<p>Проверка №{projection.projectionVersion}</p>{/if}
            {#if synchronizedAt}<p class="meta">Обновлено {new Date(synchronizedAt).toLocaleTimeString('ru-RU')}</p>{/if}
            {#if subscriptionError}<Notice message={subscriptionError} />{/if}
            <button type="button" onclick={renew}>{subscriptionError ? 'Повторить' : 'Обновить сейчас'}</button>
          </div>
        </details>
      {/if}
    {/if}
    {#if session.actions?.includes('organization:admin')}<a class="global-action" href="/admin">Администрирование</a>{/if}
    {#if session.actions?.includes('operator:diagnose')}<a class="global-action" href="/operator">Операции</a>{/if}
    <span class="user-name">{session.user.displayName ?? session.user.name ?? session.user.login}</span>
    <button type="button" class="quiet" onclick={signOut}>Выйти</button>
  </div>
</header>
<div class="workspace" class:collapsed={effectiveCollapsed}>
  <NavRail {project} {section} collapsed={effectiveCollapsed} toggle={toggleRail} link={scopeLink} counts={navCounts}
    budget={copilotBudget} />
  <main id="main" class="work-main" tabindex="-1">
    <div class="heading">
      <div>
        <h1>{reviewSection ? 'Комплектность' : sections[section]}</h1>
        {#if project.catalog}<p>{project.catalog.name} · версия {project.catalog.revision}</p>{/if}
      </div>
      {#if section !== 'members' && available(project, 'project:manage') && (!project.intakeMode || scopes.length)}
        <button type="button" onclick={() => scopeForm = !scopeForm}>Добавить область</button>
      {/if}
    </div>
    {#if section !== 'members'}
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
    {/if}
    {#if reviewSection}
      <nav class="review-nav actions" aria-label="Представление проверки">
        <a class="button quiet" aria-current={section === 'completeness' ? 'page' : undefined}
          href={lastMatrix ?? scopeLink('completeness')}>Матрица позиций</a>
        <a class="button quiet" aria-current={section === 'facts' ? 'page' : undefined}
          href={scopeLink('facts')}>Все сведения</a>
        <a class="button quiet" aria-current={section === 'questions' ? 'page' : undefined}
          href={scopeLink('questions')}>Внутренние вопросы</a>
      </nav>
    {/if}
    <div class:with-evidence={evidenceOpen} class:drawer class="project-content"
      style:--evidence-share={width / (100 - width) + 'fr'} style:--drawer-width={drawerWidth + 'vw'}>
      <div class="section-content">
        {#key section + '/' + scopeId}
          {#if section === 'overview'}
            <Overview {api} {context} {projection} {renew} open={openEvidence} />
          {:else if section === 'receipts'}
            <Receipts {api} {context} {projection} {renew} open={openEvidence} />
          {:else if section === 'completeness'}
            {#if project.intakeMode && (!scopeId || route.params.has('context')) && !project.scopeId}
              <FacadeAssessment {api} {context} {renew} {triage} chooseTriage={(value) => triage = value}
                refreshProject={() => refresh()} open={openEvidence} />
            {:else}
              <Completeness {api} {context} {renew} {triage} chooseTriage={(value) => triage = value} open={openEvidence} />
            {/if}
          {:else if section === 'questions' || section === 'facts'}
            {#if project.intakeMode && !scopeId && !project.scopeId}
              <FacadeAssessment {api} {context} {renew} mode={section} refreshProject={() => refresh()} open={openEvidence} />
            {:else}
              <Questions {api} {context} mode={section} {renew} open={openEvidence} />
            {/if}
          {:else if section === 'fragments'}
            <Fragments {api} {context} />
          {:else if section === 'copilot'}
            <Copilot {api} {context} {navigate} budget={copilotBudget} />
          {:else if section === 'letters'}
            <Letters {api} {context} {renew} open={openEvidence} />
          {:else if section === 'members' && available(project, 'project:manage')}
            <Members {api} {project} {refresh} />
          {:else}
            <Notice kind="error" message="Ресурс недоступен." />
          {/if}
        {/key}
      </div>
      {#if evidenceOpen}
        {#if !compact}<SplitHandle value={width} change={resizeViewer} />{/if}
        <div class="evidence-dock" id="workspace-evidence">
          {#if compact}
            {#if drawer}<SplitHandle value={drawerWidth} change={resizeDrawer} drawer />{/if}
            <button class="quiet layout-toggle" type="button" onclick={() => drawer = !drawer}>
              {drawer ? 'Показать снизу' : 'Показать сбоку'}
            </button>
          {/if}
          {#if comparison}
            <DualEvidenceViewer {api} projectId={project.id} {refs} close={closeEvidence} verify={() => refresh()} actions={comparison.actions} />
          {:else}
            <EvidenceViewer {api} projectId={project.id} {refs} index={selected} {componentIndex} close={closeEvidence} verify={() => refresh()}
              select={(index) => { selected = index; componentIndex = undefined; address(index); }}
              selectComponent={(index) => { componentIndex = index; address(selected); }} />
          {/if}
        </div>
      {/if}
    </div>
  </main>
</div>

<style>
  .topbar { position: sticky; top: 0; z-index: 4; display: flex; align-items: center; gap: 12px;
    min-height: 52px; padding: 4px 16px; background: var(--surface); border-bottom: 1px solid var(--line); }
  .crumbs, .topbar-actions { display: flex; align-items: center; gap: 12px; min-width: 0; }
  .crumbs a, .global-action { text-decoration: none; }
  .project-name, .user-name { text-overflow: ellipsis; white-space: nowrap; overflow: hidden; max-width: 22ch; }
  .project-name { font-weight: 650; }
  .topbar-actions { margin-inline-start: auto; font-size: .87rem; }
  .scope-select { width: auto; max-width: min(30vw, 38ch); }
  .sync-menu { position: relative; }
  .sync { display: inline-flex; align-items: center; gap: 6px; white-space: nowrap; min-height: 40px; }
  .sync span { width: 8px; height: 8px; border-radius: 50%; background: var(--accent); }
  .sync-error span { background: var(--danger); }
  .pending-data { color: var(--warn-text); }
  .sync-details { position: absolute; top: 100%; right: 0; width: max-content; max-width: min(320px, 75vw); padding: 12px;
    border: 1px solid var(--line); border-radius: 6px; background: var(--surface); }
  .sync-details p { margin-bottom: 6px; }
  .workspace { min-height: calc(100dvh - 52px); }
  .workspace.collapsed { grid-template-columns: 56px minmax(0, 1fr); }
  .work-main { max-width: 1440px; }
  .work-main:has(.with-evidence) { max-width: none; padding-inline: 12px; }
  .section-content { min-width: 0; }
  .review-nav { margin-block: 0 12px; border-bottom: 1px solid var(--line); }
  .review-nav [aria-current] { color: var(--accent-text); border-bottom-color: var(--accent); background: #e5f2ef; }
  .evidence-dock { min-width: 0; }
  @media (min-width: 851px) {
    .work-main:has(.with-evidence) { display: flex; flex-direction: column; height: calc(100dvh - 52px); padding-block: 12px; }
    .with-evidence { flex: 1; min-height: 0; }
    .with-evidence .section-content { min-height: 0; overflow: auto; padding: 4px; }
    .with-evidence .section-content :global(.split) { grid-template-columns: minmax(0, 1fr); }
    .evidence-dock { display: flex; flex-direction: column; min-height: 0; align-self: stretch; }
    .evidence-dock > :global(.evidence-panel:not(.full)), .evidence-dock > :global(.comparison:not(.full)) { flex: 1; min-height: 0; max-height: 100%; }
  }
  @media (min-width: 1141px) {
    .with-evidence { display: grid; grid-template-columns: minmax(0, 1fr) 6px minmax(0, var(--evidence-share)); gap: 8px; }
    .with-evidence > :global(.handle) { align-self: stretch; }
  }
  @media (min-width: 851px) and (max-width: 1140px) {
    .with-evidence { display: grid; grid-template-rows: minmax(0, 36fr) minmax(0, 64fr); gap: 8px; }
    .with-evidence.drawer { display: block; }
    .drawer .evidence-dock { position: fixed; inset: 64px 12px 12px auto; width: var(--drawer-width); z-index: 8; }
    .drawer .section-content { height: 100%; margin-right: calc(var(--drawer-width) - 56px); }
    .evidence-dock { position: relative; }
    .layout-toggle { align-self: start; background: var(--surface); flex: none; }
  }
  .evidence-dock:has(:global(.full)) { z-index: 12; }
  @media (max-width: 1050px) {
    .projects-crumb, .user-name { display: none; }
  }
  @media (max-width: 850px) {
    .topbar { position: static; flex-wrap: wrap; }
    .crumbs { flex: 1; }
    .scope-select { max-width: 100%; flex: 1; }
    .topbar-actions { flex-wrap: wrap; }
    .global-action { font-size: .82rem; }
  }
</style>
