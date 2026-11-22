<script lang="ts">
  import { Commands } from '../lib/commands';
  import { conflictMessage } from '../lib/conflict';
  import { count, date, label } from '../lib/format';
  import { ApiError, describe, id, interrupted, query, type Api } from '../lib/http';
  import type { Occurrence } from '../lib/intake';
  import { V1, type Citation, type OpenEvidence, type WorkspaceProps } from '../lib/workspace';
  import EvidenceButtons from '../lib/EvidenceButtons.svelte';
  import Notice from '../lib/Notice.svelte';

  type Unit = { id: string; label?: string; locator?: Record<string, string | number> };
  type Job = {
    id: string; documentId: string; cursor: string; version?: number; status?: string; state?: string;
    reason?: string; nextAction?: string; priority?: number; leaseUntil?: string; owner?: string;
    branch?: 'A' | 'B'; evidence?: Citation[];
  };
  type Work = {
    jobs: Job[];
    observations?: Citation[];
    branches?: { branch: string; completed: number; total: number; outcome?: string }[];
    review?: string; application?: string; previous?: string;
  };

  let { api, context, occurrence, open, renew }: {
    api: Api; context: WorkspaceProps;
    occurrence: Occurrence & { documentId: string; versionId: string };
    open: OpenEvidence; renew: () => void;
  } = $props();
  const commands = new Commands(() => api);
  let units = $state<Unit[]>([]);
  let work = $state<Work>();
  let readerError = $state('');
  let workError = $state('');
  let operationError = $state('');
  let status = $state('');
  let saving = $state(false);
  let priority = $state(0);

  let path = $derived('/api/documents/' + id(occurrence.documentId));
  let original = $derived(path + '/versions/' + id(occurrence.versionId) + '/content');

  $effect(() => {
    const read = V1 + path.slice(4) + '/versions/' + id(occurrence.versionId) + '/reader/units';
    const workPath = query(path + '/work', { versionId: occurrence.versionId });
    void context.refreshKey;
    const job = new AbortController();
    const signal = job.signal;
    readerError = '';
    workError = '';
    api.json<{ units: Unit[] }>(read, { signal }).then((value) => units = value.units ?? [])
      .catch((error) => {
        if (!interrupted(error)) readerError = error instanceof ApiError && error.status === 404
          ? 'Карта физических единиц ещё недоступна.' : describe(error);
      });
    api.json<Work>(workPath, { signal }).then((value) => work = value)
      .catch((error) => { if (!interrupted(error)) workError = describe(error); });
    return () => job.abort();
  });

  async function change(job: Job, action: 'priority' | 'resume') {
    if (saving) return;
    saving = true;
    operationError = '';
    status = '';
    try {
      await commands.send(path + '/' + action, action === 'priority' ? 'PATCH' : 'POST', {
        jobId: job.id, cursor: job.cursor, ...(action === 'priority' ? { priority } : {}),
      }, job.version);
      status = action === 'priority' ? 'Приоритет сохранён.' : 'Продолжение поставлено в очередь.';
    } catch (error) {
      operationError = conflictMessage(error, job.version);
    } finally {
      saving = false;
      renew();
    }
  }
</script>

<section class="card" aria-labelledby="document-heading">
  <div class="card-header"><h2 id="document-heading">{occurrence.relativePath}</h2>
    <a class="button" href={original} target="_blank" rel="noopener">Скачать оригинал</a>
  </div>
  <dl class="details">
    <dt>Редакция</dt><dd>{occurrence.versionId}</dd>
    <dt>SHA-256</dt><dd>{occurrence.sha256 ?? '—'}</dd>
    <dt>Фактический тип</dt><dd>{occurrence.mediaType ?? '—'}</dd>
    <dt>Верификация</dt><dd>{label(work?.review)}</dd>
    <dt>Применение</dt><dd>{label(work?.application)}</dd>
    {#if work?.previous}<dt>Предыдущий результат</dt><dd>{label(work.previous)}</dd>{/if}
  </dl>
  <h3>Физические единицы</h3>
  <Notice message={readerError} />
  {#if units.length}
    <ul class="plain-list">{#each units as unit (unit.id)}
      <li>{unit.label ?? (unit.locator?.page ? 'Страница ' + unit.locator.page : unit.id)}</li>
    {/each}</ul>
  {/if}
  <Notice message={workError && 'Состояние чтения · ' + workError} />
  {#if work?.branches?.length}
    <h3>Охват чтения</h3>
    <ul class="plain-list">{#each work.branches as branch (branch.branch)}
      <li>Ветвь {branch.branch} · {count(branch.completed)} из {count(branch.total)} · {label(branch.outcome)}</li>
    {/each}</ul>
  {/if}
  <EvidenceButtons citations={work?.observations} {open} />
  <Notice kind="error" message={operationError} />
  <Notice kind="success" message={status} />
  {#each work?.jobs ?? [] as job (job.id)}
    <section class="card">
      <h3>Работа {job.branch ?? ''}</h3>
      <dl class="details">
        <dt>Состояние</dt><dd>{label(job.status ?? job.state)}</dd>
        <dt>Адрес продолжения</dt><dd>{job.cursor || '—'}</dd>
        <dt>Приоритет</dt><dd>{job.priority ?? '—'}</dd>
        {#if job.reason}<dt>Причина</dt><dd>{label(job.reason)}</dd>{/if}
        {#if job.owner}<dt>Ответственный</dt><dd>{job.owner}</dd>{/if}
        {#if job.leaseUntil}<dt>До</dt><dd>{date(job.leaseUntil)}</dd>{/if}
      </dl>
      <EvidenceButtons citations={job.evidence} {open} />
      {#if context.canEdit}
        <div class="actions">
          <label>Новый приоритет<input type="number" bind:value={priority} /></label>
          <button type="button" disabled={saving || !Number.isInteger(priority)} onclick={() => change(job, 'priority')}>Изменить приоритет</button>
          {#if job.nextAction === 'resume'}
            <button type="button" disabled={saving} onclick={() => change(job, 'resume')}>Продолжить</button>
          {:else if job.nextAction}
            <span class="meta">{label(job.nextAction)}</span>
          {/if}
        </div>
      {/if}
    </section>
  {/each}
</section>
