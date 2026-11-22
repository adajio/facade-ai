<script lang="ts">
  import { onMount } from 'svelte';
  import { Commands } from '../lib/commands';
  import { conflictMessage } from '../lib/conflict';
  import { type Catalog, type Project } from '../lib/contracts';
  import { describe, id, query, type Api } from '../lib/http';
  import { date, label } from '../lib/format';
  import { projectApi } from '../lib/workspace';
  import Notice from '../lib/Notice.svelte';

  type Member = { userId: string; login: string; role: string; expiresAt?: string; scopeId?: string; reason?: string };
  type Page = { members: Member[]; version: number; nextCursor?: string | null };
  let { api, project, refresh }: { api: Api; project: Project; refresh: () => Promise<void> } = $props();
  const commands = new Commands(() => api);
  let base = $derived(projectApi(project.id));
  let members = $state<Member[]>([]);
  let catalogs = $state<Catalog[]>([]);
  let version = $state<number>();
  let cursor = $state<string | null>(null);
  let userId = $state('');
  let role = $state('engineer');
  let expiresAt = $state('');
  let temporaryScope = $state('');
  let reason = $state('');
  let catalogVersionId = $state('');
  let busy = $state(false);
  let error = $state('');
  let status = $state('');

  async function load(next?: string) {
    try {
      const page = await api.json<Page>(query(base + '/members', { cursor: next }));
      if (next && page.version !== version) {
        members = page.members;
        await load();
        return;
      }
      members = next ? [...members, ...page.members] : page.members;
      cursor = page.nextCursor ?? null;
      version = page.version;
    } catch (problem) {
      error = describe(problem);
    }
  }

  onMount(() => {
    catalogVersionId = project.catalogVersionId ?? '';
    void load();
    void api.json<{ catalogs: Catalog[] }>('/api/catalogs').then((data) => catalogs = data.catalogs)
      .catch((problem) => error = describe(problem));
  });

  async function modify(path: string, method: string, body: unknown, message: string) {
    if (busy || version == null) return;
    const expected = version;
    error = '';
    status = '';
    busy = true;
    try {
      await commands.send(base + path, method, body, expected);
      status = message;
      await Promise.all([refresh(), load()]);
    } catch (problem) {
      error = conflictMessage(problem, expected);
    } finally {
      busy = false;
    }
  }
</script>

<section class="card table-card">
  <div class="card-header"><h2>Доступ к проекту</h2><button type="button" onclick={() => load()} disabled={busy}>Обновить назначения</button></div>
  {#if members.length}
    <div class="table-wrap">
      <table>
        <thead><tr><th>Логин</th><th>Роль</th><th>Доступ до</th><th>Действие</th></tr></thead>
        <tbody>{#each members as member (member.userId)}
          <tr><td>{member.login}</td><td>{label(member.role)}</td><td>{date(member.expiresAt)}</td>
            <td>{#if member.role !== 'project_manager'}<button type="button" disabled={busy}
              onclick={() => modify('/members/' + id(member.userId), 'DELETE', undefined, 'Доступ отозван.')}
              aria-label={'Отозвать доступ ' + member.login}>Отозвать</button>{/if}</td></tr>
        {/each}</tbody>
      </table>
    </div>
    {#if cursor}<div class="card-header"><button type="button" onclick={() => load(cursor ?? undefined)}>Ещё участники</button></div>{/if}
  {:else}<p class="empty">Назначения пока не загружены.</p>{/if}
</section>

<Notice kind="error" message={error} />
<Notice kind="success" message={status} />
<div class="split">
  <section class="card">
    <h2>Назначить участника</h2>
    <form onsubmit={(event) => {
      event.preventDefault();
      void modify('/members/' + id(userId.trim()), 'PUT', {
        role, scopeId: temporaryScope || undefined,
        expiresAt: expiresAt ? new Date(expiresAt).toISOString() : undefined, reason: reason || undefined,
      }, 'Назначение сохранено.');
    }}>
      <label>ID учётной записи<input required bind:value={userId} /></label>
      <label>Роль<select bind:value={role}><option value="engineer">Инженер</option><option value="viewer">Просматривающий</option></select></label>
      {#if role === 'viewer'}
        <label>Временный доступ до<input type="datetime-local" bind:value={expiresAt} /></label>
        {#if expiresAt}
          <label>Область<select bind:value={temporaryScope}><option value="">Весь проект</option>
            {#each project.scopes as scope (scope.id)}<option value={scope.id}>{scope.name}</option>{/each}</select></label>
          <label>Основание<input required bind:value={reason} /></label>
        {/if}
      {/if}
      <div class="actions"><button class="primary" disabled={busy || version == null}>Сохранить участника</button></div>
    </form>
  </section>
  <section class="card">
    <h2>Закреплённый каталог</h2>
    {#if project.catalog}<p>{project.catalog.name} · версия {project.catalog.revision}</p>{/if}
    <form onsubmit={(event) => {
      event.preventDefault();
      void modify('/catalog', 'PUT', { catalogVersionId }, 'Версия каталога закреплена.');
    }}>
      <label>Версия каталога
        <select required bind:value={catalogVersionId}>
          <option value="">Выберите каталог</option>
          {#each catalogs as catalog (catalog.id)}<option value={catalog.id}>{catalog.name} · {catalog.revision}</option>{/each}
        </select>
      </label>
      <div class="actions"><button class="primary" disabled={busy || version == null}>Закрепить каталог</button></div>
    </form>
  </section>
</div>
