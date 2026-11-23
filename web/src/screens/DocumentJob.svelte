<script module lang="ts">
  export type Job = {
    id: string; state: string; branch: 'A' | 'B'; reason?: string; nextAction?: string;
    page?: number; unitId?: string; priority: number; leaseUntil?: string;
    actions: {
      priority: { reason?: string; min?: number; max?: number; version?: number };
      resume: { reason?: string; href?: string; version?: number };
    };
  };
</script>

<script lang="ts">
  import { untrack } from 'svelte';
  import { conflictMessage } from '../lib/conflict';
  import { date, label } from '../lib/format';
  import { ApiError } from '../lib/http';
  import Notice from '../lib/Notice.svelte';

  let { job, change }: {
    job: Job;
    change: (job: Job, action: 'priority' | 'resume', priority?: number) => Promise<void>;
  } = $props();
  let priority = $state<number | undefined>(untrack(() => job.priority));
  let saving = $state(false);
  let result = $state('');
  let error = $state('');

  async function run(action: 'priority' | 'resume') {
    if (saving) return;
    const version = job.actions[action].version;
    if (version === undefined) return;
    saving = true;
    error = '';
    result = '';
    try {
      await change(job, action, priority);
      result = action === 'priority' ? 'Приоритет сохранён.' : 'Запрос на продолжение принят.';
    } catch (problem) {
      error = problem instanceof ApiError && problem.status === 409
        ? problem.message : conflictMessage(problem, version);
    } finally {
      saving = false;
    }
  }
</script>

<details class="job" open={job.state === 'held' || undefined}>
  <summary>Ветвь {job.branch}
    {#if job.page} · Страница {job.page}{:else if job.unitId} · {job.unitId}{/if}
    · {label(job.state === 'ready' ? 'queued' : job.state)}
  </summary>
  <dl class="details">
    <dt>Текущий приоритет</dt><dd>{job.priority}</dd>
    {#if job.reason}<dt>Причина</dt><dd>{label(job.reason)}</dd>{/if}
    {#if job.nextAction}<dt>Следующий шаг</dt><dd>{label(job.nextAction)}</dd>{/if}
    {#if job.leaseUntil}<dt>Аренда до</dt><dd>{date(job.leaseUntil)}</dd>{/if}
  </dl>
  {#if job.actions.priority.version !== undefined}
    <form class="actions" onsubmit={(event) => { event.preventDefault(); void run('priority'); }}>
      <label>Новый приоритет
        <input type="number" min={job.actions.priority.min} max={job.actions.priority.max} step="1"
          required bind:value={priority} />
      </label>
      <button disabled={saving}>Изменить приоритет</button>
    </form>
  {:else if job.actions.priority.reason !== 'insufficient_permission'}
    <p class="meta">Приоритет · {label(job.actions.priority.reason)}</p>
  {/if}
  {#if job.actions.resume.href}
    <button type="button" disabled={saving} onclick={() => run('resume')}>Продолжить чтение</button>
  {:else if job.actions.resume.reason && job.actions.resume.reason !== 'insufficient_permission' && job.state === 'held'}
    <p class="meta">Продолжение · {label(job.actions.resume.reason)}</p>
  {/if}
  <Notice kind="error" message={error} />
  <Notice kind="success" message={result} />
</details>

<style>
  .job { margin-block: .6rem; }
</style>
