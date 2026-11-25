<script lang="ts">
  import { onMount } from 'svelte';
  import { Commands } from '../lib/commands';
  import { conflictMessage } from '../lib/conflict';
  import { describe, id, query, type Api } from '../lib/http';
  import { label } from '../lib/format';
  import CatalogFields, { type Requirement } from '../lib/CatalogFields.svelte';
  import Notice from '../lib/Notice.svelte';

  type User = {
    id: string; login: string; state: string; version: number;
    orgAdmin: boolean; canCreateProject: boolean; technicalOperator: boolean;
  };
  let { api }: { api: Api } = $props();
  const commands = new Commands(() => api);
  let users = $state<User[]>([]);
  let cursor = $state<string | null>(null);
  let login = $state('');
  let name = $state('');
  let key = $state('');
  let requirements = $state<Requirement[]>([]);
  let publishDefault = $state(false);
  let profileStage = $state('');
  let profileFacades = $state('');
  let approvalReference = $state('');
  let facadeKinds = $derived(profileFacades.split(',').map((kind) => kind.trim()).filter(Boolean));
  let editing = $state<User>();
  let link = $state('');
  let status = $state('');
  let error = $state('');
  let busy = $state(false);

  async function load(after?: string) {
    try {
      const page = await api.json<{ users: User[]; nextCursor?: string }>(query('/api/users', { cursor: after }));
      users = after ? [...users, ...page.users] : page.users;
      cursor = page.nextCursor ?? null;
    } catch (problem) {
      error = describe(problem);
    }
  }
  onMount(() => { void load(); });

  async function modify(path: string, method: string, body: unknown, success: string, version?: number, tokenMode?: string) {
    if (busy) return;
    busy = true;
    error = '';
    status = '';
    link = '';
    try {
      const result = await commands.send<{ token?: string }>(path, method, body, version);
      status = success;
      if (tokenMode && result.token) {
        link = new URL('/' + tokenMode + '#token=' + id(result.token), location.origin).href;
      } else if (tokenMode) {
        status = 'Операция зарегистрирована. Токен выдаётся один раз при создании ссылки.';
      }
      if (method === 'PATCH') editing = undefined;
      await load();
    } catch (problem) {
      error = conflictMessage(problem, version);
    } finally {
      busy = false;
    }
  }
</script>

<main class="standalone" id="main">
  <div class="heading"><h1>Администрирование</h1><button type="button" onclick={() => load()}>Обновить</button></div>
  <Notice kind="error" message={error} />
  <Notice kind="success" message={status} />
  {#if link}
    <div class="card">
      <label>Одноразовая ссылка<input readonly value={link} /></label>
      <button type="button" onclick={() => link = ''}>Скрыть ссылку</button>
    </div>
  {/if}
  <div class="split">
    <section class="card">
      <h2>Приглашение</h2>
      <form onsubmit={(event) => { event.preventDefault(); void modify('/api/users/invitations', 'POST', { login }, 'Приглашение создано.', undefined, 'invite'); }}>
        <label>Логин<input bind:value={login} required /></label>
        <div class="actions"><button class="primary" disabled={busy}>Выпустить ссылку</button></div>
      </form>
    </section>
    <section class="card">
      <h2>Новая версия каталога</h2>
      <form onsubmit={(event) => {
        event.preventDefault();
        const defaultProfile = publishDefault ? { stage: profileStage, facadeKinds, approvalReference } : undefined;
        void modify('/api/catalogs', 'POST', { name, key, requirements, defaultProfile }, 'Версия каталога опубликована.');
      }}>
        <div class="form-row"><label>Код каталога<input bind:value={key} required /></label><label>Название<input bind:value={name} required /></label></div>
        <CatalogFields bind:requirements />
        <label><input type="checkbox" bind:checked={publishDefault} /> Опубликовать утверждённый рабочий профиль</label>
        {#if publishDefault}
          <label>Код стадии<input required maxlength="200" bind:value={profileStage} /></label>
          <label>Коды подтверждённых типов фасадов через запятую<input required={profileStage.trim() !== 'Стадия 1'} bind:value={profileFacades} /></label>
          <label>Ссылка или номер решения об утверждении<input required maxlength="500" bind:value={approvalReference} /></label>
          {#if !requirements.length}<p>Добавьте утверждённые требования для рабочего профиля.</p>{/if}
        {/if}
        <div class="actions"><button class="primary" disabled={busy || (publishDefault &&
          (!requirements.length || (!facadeKinds.length && profileStage.trim() !== 'Стадия 1')))}>Опубликовать каталог</button></div>
      </form>
    </section>
  </div>
  <section class="card table-card">
    <div class="card-header"><h2>Учётные записи</h2></div>
    <div class="table-wrap">
      <table><thead><tr><th>Логин и ID</th><th>Состояние</th><th>Действия</th></tr></thead>
        <tbody>{#each users as user (user.id)}
          <tr><td><strong>{user.login}</strong><br><small>{user.id}</small></td><td>{label(user.state)}</td>
            <td><div class="actions">
              <button type="button" disabled={busy} onclick={() => editing = { ...user }}>Изменить назначения</button>
              <button type="button" disabled={busy} onclick={() => modify('/api/users/' + id(user.id) + '/password-resets', 'POST', {}, 'Ссылка сброса создана.', undefined, 'password-reset')}>Сброс пароля</button>
              <button type="button" disabled={busy} onclick={() => modify('/api/users/' + id(user.id) + '/revoke-sessions', 'POST', {}, 'Сеансы отозваны.')}>Отозвать сеансы</button>
            </div></td></tr>
        {/each}</tbody>
      </table>
    </div>
    {#if cursor}<div class="card-header"><button type="button" onclick={() => load(cursor ?? undefined)}>Ещё учётные записи</button></div>{/if}
  </section>
  {#if editing}
    <section class="card">
      <h2>Назначения · {editing.login}</h2>
      <form onsubmit={(event) => {
        event.preventDefault();
        const selected = editing;
        if (!selected) return;
        const { orgAdmin, canCreateProject, technicalOperator, state } = selected;
        void modify('/api/users/' + id(selected.id), 'PATCH', { orgAdmin, canCreateProject, technicalOperator, state }, 'Назначения сохранены.', selected.version);
      }}>
        <label><input type="checkbox" bind:checked={editing.orgAdmin} /> Администратор организации</label>
        <label><input type="checkbox" bind:checked={editing.canCreateProject} /> Может создавать проекты</label>
        <label><input type="checkbox" bind:checked={editing.technicalOperator} /> Технический оператор</label>
        <label>Состояние<select bind:value={editing.state}>
          {#if editing.state === 'invited'}<option value="invited">Приглашение выдано</option>{/if}
          <option value="active">Активная</option><option value="disabled">Отключена</option>
        </select></label>
        <div class="actions"><button class="primary" disabled={busy || editing.state === 'invited'}>Сохранить назначения</button>
          <button type="button" onclick={() => editing = undefined}>Закрыть</button></div>
      </form>
    </section>
  {/if}
</main>
