<script lang="ts">
  import { onMount } from 'svelte';
  import AuthForm from './lib/AuthForm.svelte';
  import Notice from './lib/Notice.svelte';
  import { Api, denied, describe, id, interrupted } from './lib/http';
  import { projectOf, type Session, type Project, type ProjectRead } from './lib/contracts';
  import { readRoute, returnPath } from './lib/routes';
  import Projects from './screens/Projects.svelte';
  import Workspace from './screens/Workspace.svelte';
  import Administration from './screens/Administration.svelte';
  import Operator from './screens/Operator.svelte';

  const VIEW_LEASE = 30_000;
  const HEARTBEAT = 10_000;
  let route = $state(readRoute(window.location));
  let session = $state<Session>();
  let project = $state<Project>();
  let screenState = $state<'checking' | 'ready' | 'denied' | 'offline' | 'login'>('checking');
  let masked = $state(false);
  let sessionEpoch = $state(0);
  let notice = $state('');
  let lastVerified = 0;
  let activeLocation = window.location.pathname + window.location.search;
  let check: AbortController | undefined;
  let lease: ReturnType<typeof setTimeout> | undefined;
  let channel: BroadcastChannel | undefined;
  const api = new Api(expired);

  function clear() {
    check?.abort();
    clearTimeout(lease);
    api.reset();
    session = undefined;
    project = undefined;
    sessionEpoch += 1;
    lastVerified = 0;
  }

  function replace(path: string) {
    history.replaceState(null, '', path);
    activeLocation = path;
    route = readRoute(window.location);
  }

  function setDocumentPage(page?: number) {
    const url = new URL(window.location.href);
    const params = new URLSearchParams(route.params);
    for (const query of [url.searchParams, params]) {
      if (page === undefined) query.delete('page');
      else query.set('page', String(page));
    }
    history.replaceState(history.state, '', url);
    activeLocation = url.pathname + url.search;
    route = { ...route, params };
  }

  function expired() {
    const next = window.location.pathname + window.location.search;
    clear();
    screenState = 'login';
    masked = false;
    if (!['login', 'reset', 'invite'].includes(route.page)) replace('/login?next=' + encodeURIComponent(next));
  }

  function lockScreen(next: 'checking' | 'denied' | 'offline') {
    clear();
    screenState = next;
    masked = false;
  }

  async function verify(foreground = false) {
    if (['login', 'reset', 'invite', 'missing'].includes(route.page)) return;
    const projectId = route.projectId;
    const page = route.page;
    check?.abort();
    const controller = new AbortController();
    check = controller;
    const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(8000)]);
    if (foreground) masked = true;
    try {
      const fresh = await api.json<Session>('/api/me', { signal });
      if (session && session.user.id !== fresh.user.id) {
        clear();
        await verify(true);
        return;
      }
      api.setCsrf(fresh.csrfToken);
      const next = projectId
        ? projectOf(await api.json<ProjectRead>('/api/projects/' + id(projectId), { signal }))
        : undefined;
      const scopeLimit = fresh.projects.find((item) => item.id === projectId)?.scopeId;
      if (next && scopeLimit) next.scopes = next.scopes.filter((scope) => scope.id === scopeLimit);
      if (next) next.scopeId = scopeLimit;
      signal.throwIfAborted();
      if (page !== route.page || projectId !== route.projectId) return;
      if (project && next && project.id === next.id &&
          (project.scopeId !== next.scopeId || JSON.stringify(project.actions) !== JSON.stringify(next.actions))) {
        // Drop the mounted workspace and pending responses when role permissions change.
        api.reset();
        api.setCsrf(fresh.csrfToken);
        sessionEpoch += 1;
      }
      session = fresh;
      project = next;
      screenState = 'ready';
      masked = document.visibilityState === 'hidden';
      lastVerified = Date.now();
      clearTimeout(lease);
      lease = setTimeout(() => {
        if (Date.now() - lastVerified >= VIEW_LEASE) lockScreen('offline');
      }, VIEW_LEASE);
    } catch (error) {
      if (controller.signal.aborted || interrupted(error)) return;
      if (denied(error)) {
        lockScreen('denied');
      } else if (foreground || Date.now() - lastVerified >= VIEW_LEASE) {
        lockScreen('offline');
      }
    } finally {
      if (check === controller) check = undefined;
    }
  }

  async function signedIn(login?: Session) {
    clear();
    if (login) {
      api.setCsrf(login.csrfToken);
      const next = returnPath(route.params.get('next'));
      channel?.postMessage('changed');
      replace(next);
      await verify(true);
    } else {
      replace('/login');
    }
  }

  async function signOut() {
    try {
      await api.json('/api/sessions/current', { method: 'DELETE' });
      channel?.postMessage('changed');
      clear();
      replace('/login');
    } catch (error) {
      notice = describe(error);
    }
  }

  function routeChanged(foreground = false) {
    const last = route;
    activeLocation = window.location.pathname + window.location.search;
    route = readRoute(window.location);
    if (route.projectId !== last.projectId || route.page !== last.page) {
      lockScreen('checking');
      void verify(true);
    } else if (foreground) {
      void verify(true);
    }
  }

  function navigation(event: MouseEvent) {
    if (event.defaultPrevented || event.button !== 0 || event.shiftKey || event.altKey || event.ctrlKey || event.metaKey) return;
    const target = event.target instanceof Element ? event.target.closest('a[href]') : null;
    if (!(target instanceof HTMLAnchorElement) || target.hasAttribute('download') || target.target) return;
    const url = new URL(target.href);
    if (url.origin !== window.location.origin || url.pathname.startsWith('/api/') || url.hash) return;
    event.preventDefault();
    if (url.pathname === window.location.pathname && url.search === window.location.search) return;
    if (window.dispatchEvent(new Event('facade:navigate', { cancelable: true }))) {
      history.pushState(null, '', url.pathname + url.search);
      routeChanged();
      window.scrollTo(0, 0);
    }
  }

  onMount(() => {
    channel = typeof BroadcastChannel === 'undefined' ? undefined : new BroadcastChannel('facade-session');
    const authChanged = () => {
      lockScreen('checking');
      void verify(true);
    };
    if (channel) channel.onmessage = authChanged;
    const regain = () => {
      if (document.visibilityState === 'hidden') {
        masked = true;
        return;
      }
      void verify(true);
    };
    const pageHide = () => {
      masked = true;
      // Conceal the cached DOM synchronously before bfcache takes its snapshot.
      const content = document.getElementById('protected-content');
      if (content) content.hidden = true;
    };
    const pageShow = (event: PageTransitionEvent) => {
      if (event.persisted) void verify(true);
    };
    const pop = () => {
      const previous = activeLocation;
      if (!window.dispatchEvent(new Event('facade:navigate', { cancelable: true }))) {
        history.pushState(null, '', previous);
        return;
      }
      routeChanged(true);
    };
    const timer = setInterval(() => {
      if (document.visibilityState === 'visible' && !check) void verify();
    }, HEARTBEAT);
    document.addEventListener('click', navigation);
    document.addEventListener('visibilitychange', regain);
    window.addEventListener('pagehide', pageHide);
    window.addEventListener('pageshow', pageShow);
    window.addEventListener('popstate', pop);
    window.addEventListener('online', regain);
    void verify();

    return () => {
      channel?.close();
      document.removeEventListener('click', navigation);
      document.removeEventListener('visibilitychange', regain);
      window.removeEventListener('pagehide', pageHide);
      window.removeEventListener('pageshow', pageShow);
      window.removeEventListener('popstate', pop);
      window.removeEventListener('online', regain);
      clearInterval(timer);
      clear();
    };
  });
</script>

<a class="skip" href="#main">К содержимому</a>
{#if route.page === 'login' || route.page === 'reset' || route.page === 'invite'}
  {#key route.page}
    <AuthForm {api} mode={route.page} token={route.params.get('token') ?? ''} finish={signedIn} />
  {/key}
{:else if route.page === 'missing'}
  <main class="standalone" id="main"><h1>Страница недоступна</h1><a href="/projects">К проектам</a></main>
{:else}
  <header class="app-header">
    <a class="brand" href="/projects"><span class="brand-mark" aria-hidden="true"></span> Facade AI</a>
    <nav aria-label="Основная навигация">
      <a href="/projects" aria-current={route.page === 'projects' ? 'page' : undefined}>Проекты</a>
      {#if !masked && session?.actions?.includes('organization:admin')}<a href="/admin">Администрирование</a>{/if}
      {#if !masked && session?.actions?.includes('operator:diagnose')}<a href="/operator">Операции</a>{/if}
    </nav>
    {#if !masked && session}
      <div class="identity">
        <span>{session.user.displayName ?? session.user.name ?? session.user.login}</span>
        <button type="button" class="quiet" onclick={signOut}>Выйти</button>
      </div>
    {/if}
  </header>

  <Notice kind="error" message={notice} />
  {#if masked || screenState === 'checking'}
    <main class="standalone" id="verification" aria-busy="true"><h1>Проверяем доступ</h1></main>
  {:else if screenState === 'denied'}
    <main class="standalone" id="main"><h1>Ресурс недоступен</h1><a href="/projects">К проектам</a></main>
  {:else if screenState === 'offline'}
    <main class="standalone" id="main">
      <h1>Доступ требует проверки</h1>
      <p>Соединение с сервером прервано.</p>
      <button type="button" onclick={() => verify(true)}>Проверить доступ</button>
    </main>
  {/if}
  {#if screenState === 'ready' && session}
    <div id="protected-content" hidden={masked}>
      {#key sessionEpoch}
        {#if route.page === 'projects'}
          <Projects {api} {session} refresh={verify} />
        {:else if route.page === 'project' && project}
          {#key project.id}
            <Workspace {api} {project} {route} {masked} {setDocumentPage} refresh={verify}
              onDenied={() => lockScreen('denied')} />
          {/key}
        {:else if route.page === 'admin' && session.actions?.includes('organization:admin')}
          <Administration {api} />
        {:else if route.page === 'operator' && session.actions?.includes('operator:diagnose')}
          <Operator {api} {masked} />
        {:else}
          <main class="standalone" id="main"><h1>Ресурс недоступен</h1><a href="/projects">К проектам</a></main>
        {/if}
      {/key}
    </div>
  {/if}
{/if}
