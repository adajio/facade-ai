<script lang="ts">
  import { describe, type Api } from './http';
  import type { Session } from './contracts';
  import Notice from './Notice.svelte';

  let { api, mode = 'login', token = '', finish }: {
    api: Api;
    mode?: 'login' | 'reset' | 'invite';
    token?: string;
    finish: (session?: Session) => Promise<void> | void;
  } = $props();

  let login = $state('');
  let password = $state('');
  let pending = $state(false);
  let message = $state('');
  let title = $derived({ login: 'Вход', reset: 'Новый пароль', invite: 'Принять приглашение' }[mode]);

  async function submit(event: SubmitEvent) {
    event.preventDefault();
    if (pending) return;
    pending = true;
    message = '';
    try {
      if (mode === 'login') {
        const session = await api.json<Session>('/api/sessions', {
          method: 'POST', json: { login, password },
        });
        password = '';
        await finish(session);
      } else {
        const resource = mode === 'invite' ? 'invitations' : 'password-resets';
        await api.json('/api/' + resource + '/complete', { method: 'POST', json: { token, password } });
        password = '';
        await finish();
      }
    } catch (error) {
      message = describe(error);
    } finally {
      pending = false;
    }
  }
</script>

<main class="auth-shell" id="main">
  <div class="auth-card">
    <div class="brand"><span class="brand-mark" aria-hidden="true"></span> Facade AI</div>
    <h1>{title}</h1>
    {#if mode !== 'login' && !token}
      <Notice kind="error" message="Откройте одноразовую ссылку, выданную администратором." />
      <a href="/login">Перейти ко входу</a>
    {:else}
      <form onsubmit={submit}>
        {#if mode === 'login'}
          <label>Логин <input bind:value={login} name="login" autocomplete="username" required /></label>
        {/if}
        <label>{mode === 'login' ? 'Пароль' : 'Новый пароль'}
          <input type="password" bind:value={password} name="password"
            autocomplete={mode === 'login' ? 'current-password' : 'new-password'} required />
        </label>
        <Notice kind="error" {message} />
        <button class="primary" disabled={pending}>{pending ? 'Проверяем…' : mode === 'login' ? 'Войти' : 'Сохранить пароль'}</button>
      </form>
      {#if mode !== 'login'}<a href="/login">Вернуться ко входу</a>{/if}
    {/if}
  </div>
</main>
