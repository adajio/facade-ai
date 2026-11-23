<script lang="ts">
  import { onMount } from 'svelte';
  import { describe, query, type Api } from '../lib/http';
  import { Commands } from '../lib/commands';
  import { type Project, type Session } from '../lib/contracts';
  import { projectUrl } from '../lib/routes';
  import { scopedUrl } from '../lib/workspace';
  import { date, label } from '../lib/format';
  import Notice from '../lib/Notice.svelte';

  let { api, session, refresh }: { api: Api; session: Session; refresh: () => Promise<void> } = $props();
  const commands = new Commands(() => api);
  let name = $state('');
  let filter = $state('');
  let extra = $state<Project[]>([]);
  let next = $state<string | null>();
  let paging = $state(false);
  let pageKey = $derived(next === undefined ? (session.nextCursor ?? null) : next);
  let creating = $state(false);
  let pending = $state(false);
  let error = $state('');
  let projects = $derived([...new Map([...session.projects, ...extra].map((project) => [project.id, project])).values()].filter((project) =>
    project.name.toLocaleLowerCase('ru').includes(filter.trim().toLocaleLowerCase('ru'))
  ));
  let canCreate = $derived(session.actions?.includes('organization:create-project') ?? false);


  async function more() {
    if (!pageKey || paging) return;
    paging = true;
    error = '';
    try {
      const value = await api.json<Session>(query('/api/me', { cursor: pageKey }));
      extra = [...extra, ...value.projects];
      next = value.nextCursor ?? null;
    } catch (problem) {
      error = describe(problem);
    } finally {
      paging = false;
    }
  }

  function show() {
    creating = true;
    error = '';
  }

  onMount(() => {
    if (canCreate && !session.projects.length) show();
  });

  async function submit(event: SubmitEvent) {
    event.preventDefault();
    if (pending) return;
    pending = true;
    error = '';
    try {
      const result = await commands.send<Project | { project: Project }>('/api/projects', 'POST', {
        name: name.trim(), mode: 'intake',
      });
      const project = 'project' in result ? result.project : result;
      window.location.assign(projectUrl(project.id));
    } catch (problem) {
      error = describe(problem);
    } finally {
      pending = false;
    }
  }
</script>

<main id="main" class="standalone projects">
  <div class="heading">
    <div><h1>Проекты</h1><p>Поступления и комплектность проектных данных</p></div>
    {#if canCreate}<button type="button" class="primary" onclick={show}>Создать проект</button>{/if}
  </div>

  {#if creating && canCreate}
    <section class="card">
      <h2>Новый проект</h2>
      <form onsubmit={submit}>
        <div class="form-row">
          <label>Название проекта <input name="project-name" maxlength="200" required bind:value={name} /></label>
        </div>
        <Notice kind="error" message={error} />
        <div class="actions">
          <button class="primary" disabled={pending || !name.trim()}>Сохранить проект</button>
          <button type="button" class="quiet" onclick={() => creating = false}>Отмена</button>
        </div>
      </form>
    </section>
  {/if}

  {#if !creating}<Notice kind="error" message={error} />{/if}
  <section class="card table-card" aria-labelledby="list-title">
    <div class="card-header">
      <h2 id="list-title">Доступные проекты</h2>
      <label class="inline-label">Поиск<input type="search" bind:value={filter} placeholder="Название проекта" /></label>
      <button type="button" class="quiet" onclick={refresh}>Обновить</button>
    </div>
    {#if projects.length}
      <div class="table-wrap">
        <table>
          <thead><tr><th>Проект</th><th>Роль</th><th>Каталог</th><th>Обновлено</th></tr></thead>
          <tbody>
            {#each projects as project (project.id)}
              <tr>
                <td><a class="row-link" href={project.scopeId
                  ? scopedUrl(project.id, 'fragments', { scope: project.scopeId })
                  : projectUrl(project.id)}>{project.name}</a></td>
                <td>{label(project.role)}</td>
                <td>{project.catalog ? project.catalog.name + ' · ' + project.catalog.revision : project.scopeId ? '—' : 'Нет рабочего каталога'}</td>
                <td>{date(project.updatedAt)}</td>
              </tr>
            {/each}
          </tbody>
        </table>
      </div>
    {:else}
      <p class="empty">{filter ? 'По этому названию проекты не найдены.' : 'Список проектов пока пуст.'}</p>
    {/if}
    {#if pageKey}<div class="card-header"><button type="button" onclick={more} disabled={paging}>Ещё проекты</button></div>{/if}
  </section>
</main>
