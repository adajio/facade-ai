<script lang="ts">
  import { untrack } from 'svelte';
  import { Commands } from '../lib/commands';
  import { describe, id, type Api } from '../lib/http';
  import { date, label } from '../lib/format';
  import Notice from '../lib/Notice.svelte';

  type Job = { id: string; kind: string; purpose: string; state: string; leaseEpoch: number; leaseUntil?: string; reason?: string; nextAction?: string };
  type Attempt = {
    id: string; jobId: string; state: string; routeId: string; reserveUsdNanos: number; spentUsdNanos: number;
    reason?: string; nextAction?: string; providerId?: string; createdAt?: string;
  };
  type Diagnostics = { jobs: Job[]; attempts: Attempt[] };

  let { api, masked }: { api: Api; masked: boolean } = $props();
  const commands = new Commands(() => api);
  let project = $state('');
  let selectedProject = $state('');
  let diagnostics = $state<Diagnostics>();
  let selected = $state<Attempt>();
  let resolution = $state<'unknown' | 'paid' | 'rejected'>('unknown');
  let reasonRef = $state('');
  let code = $state('');
  let evidenceRef = $state('');
  let providerId = $state('');
  let cost = $state<number>();
  let error = $state('');
  let notice = $state('');
  let busy = $state(false);
  let refreshing = $state(false);

  function path(projectId: string) {
    return '/api/operator/gateway/projects/' + id(projectId);
  }
  function usd(nanos: number) {
    return new Intl.NumberFormat('ru', { style: 'currency', currency: 'USD', maximumFractionDigits: 9 }).format(nanos / 1e9);
  }

  async function refresh(projectId = selectedProject, signal?: AbortSignal) {
    if (!projectId || refreshing || masked) return;
    refreshing = true;
    try {
      const result = await api.json<Diagnostics>(path(projectId), { signal });
      if (selectedProject === projectId) diagnostics = result;
    } catch (problem) {
      if (selectedProject === projectId && !signal?.aborted) {
        diagnostics = undefined;
        selected = undefined;
        error = describe(problem);
      }
    } finally {
      refreshing = false;
    }
  }

  $effect(() => {
    const projectId = selectedProject;
    if (masked || !projectId) return;
    const stop = new AbortController();
    untrack(() => void refresh(projectId, stop.signal));
    const timer = setInterval(() => refresh(projectId, stop.signal), 8000);
    return () => {
      stop.abort();
      clearInterval(timer);
    };
  });

  function load(event: SubmitEvent) {
    event.preventDefault();
    error = '';
    notice = '';
    selected = undefined;
    const projectId = project.trim();
    if (projectId === selectedProject) void refresh();
    else {
      diagnostics = undefined;
      selectedProject = projectId;
    }
  }

  async function reconcile(event: SubmitEvent) {
    event.preventDefault();
    if (!selected || !selectedProject || busy) return;
    busy = true;
    error = '';
    notice = '';
    const subject = selected;
    const body = resolution === 'paid' ? { state: resolution, reasonRef, evidenceRef, providerId, costUsdNanos: cost }
      : resolution === 'rejected' ? { state: resolution, reasonRef, code, evidenceRef } : { state: resolution, reasonRef, code };
    try {
      const result = await commands.send<{ state: string }>(path(selectedProject) + '/attempts/' + id(subject.id) + '/reconcile', 'POST', body);
      notice = 'Сверка зарегистрирована · ' + label(result.state);
      selected = undefined;
      await refresh();
    } catch (problem) {
      error = describe(problem);
    } finally {
      busy = false;
    }
  }
</script>

<main class="standalone" id="main">
  <div class="heading"><div><h1>Операции</h1><p>Очередь, резервы и сверка попыток</p></div></div>
  <section class="card">
    <form onsubmit={load}>
      <label>Служебный ID проекта<input bind:value={project} required /></label>
      <div class="actions"><button class="primary" disabled={refreshing}>Открыть диагностику</button></div>
    </form>
  </section>
  <Notice kind="error" message={error} />
  <Notice kind="success" message={notice} />
  {#if diagnostics}
    <section class="card table-card">
      <div class="card-header"><h2>Очередь</h2></div>
      {#if diagnostics.jobs.length}
        <div class="table-wrap">
          <table><thead><tr><th>Работа</th><th>Состояние</th><th>Аренда до</th><th>Причина</th><th>Действие</th></tr></thead>
            <tbody>{#each diagnostics.jobs as entry (entry.id)}
              <tr><td>{entry.id}<br><small>{entry.kind} · {entry.purpose}</small></td><td>{label(entry.state)}</td>
                <td>{date(entry.leaseUntil)}</td><td>{label(entry.reason)}</td><td>{label(entry.nextAction)}</td></tr>
            {/each}</tbody>
          </table>
        </div>
      {:else}<p class="empty">Работ в очереди пока нет.</p>{/if}
    </section>
    <section class="card table-card">
      <div class="card-header"><h2>Попытки</h2></div>
      {#if diagnostics.attempts.length}
        <div class="table-wrap">
          <table><thead><tr><th>Попытка</th><th>Состояние</th><th>Резерв</th><th>Расход</th><th>Допустимое действие</th></tr></thead>
            <tbody>{#each diagnostics.attempts as attempt (attempt.id)}
              <tr>
                <td>{attempt.id}<br><small>{attempt.routeId} · {date(attempt.createdAt)}</small></td>
                <td>{label(attempt.state)}<br><small>{label(attempt.reason)}</small></td>
                <td>{usd(attempt.reserveUsdNanos)}</td><td>{usd(attempt.spentUsdNanos)}</td>
                <td>{#if attempt.nextAction === 'operator_reconcile_attempt'}
                  <button type="button" onclick={() => { selected = attempt; providerId = attempt.providerId ?? ''; }}>Сверить попытку</button>
                {:else}{label(attempt.nextAction)}{/if}</td>
              </tr>
            {/each}</tbody>
          </table>
        </div>
      {:else}<p class="empty">Попытки пока отсутствуют.</p>{/if}
    </section>
  {/if}
  {#if selected}
    <section class="card">
      <h2>Сверка попытки</h2><p class="meta">{selected.id}</p>
      <form onsubmit={reconcile}>
        <label>Результат<select bind:value={resolution}>
          <option value="unknown">Оставить на сверке</option><option value="paid">Подтвердить оплату</option><option value="rejected">Подтвердить отказ</option>
        </select></label>
        <label>Ссылка на основание<input bind:value={reasonRef} required /></label>
        {#if resolution === 'paid'}
          <label>Квитанция провайдера<input bind:value={providerId} required /></label>
          <label>Расход в миллиардных долях доллара<input type="number" min="0" step="1" bind:value={cost} required /></label>
        {:else}
          <label>Код причины<input bind:value={code} required /></label>
        {/if}
        {#if resolution !== 'unknown'}<label>Ссылка на доказательство<input bind:value={evidenceRef} required /></label>{/if}
        <div class="actions"><button class="primary" disabled={busy}>Записать сверку</button>
          <button type="button" onclick={() => selected = undefined}>Закрыть</button></div>
      </form>
    </section>
  {/if}
</main>
