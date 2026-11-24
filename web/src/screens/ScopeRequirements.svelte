<script lang="ts">
  import { Commands } from '../lib/commands';
  import { conflictMessage } from '../lib/conflict';
  import { describe, id, type Api } from '../lib/http';
  import { type Project } from '../lib/contracts';
  import { projectApi } from '../lib/workspace';
  import CatalogFields, { copy, type Requirement } from '../lib/CatalogFields.svelte';
  import Notice from '../lib/Notice.svelte';

  let { api, project, scopeId, saved }: {
    api: Api; project: Project; scopeId: string; saved: () => void;
  } = $props();
  const commands = new Commands(() => api);
  let requirements = $state<Requirement[]>([]);
  let version = $state<number>();
  let latestVersion = $state<number>();
  let pending = $state(false);
  let error = $state('');
  let success = $state('');
  const path = () => projectApi(project.id) + '/scopes/' + id(scopeId);

  async function load(event: Event) {
    if (!(event.currentTarget as HTMLDetailsElement).open || version !== undefined || pending) return;
    pending = true;
    try {
      const scope = await api.json<{ version: number; requirements?: Requirement[] | null }>(path());
      version = scope.version;
      requirements = copy(scope.requirements ?? (project.catalog?.requirements as Requirement[] | undefined) ?? []);
    } catch (problem) {
      error = describe(problem);
    } finally {
      pending = false;
    }
  }

  async function save(event: SubmitEvent) {
    event.preventDefault();
    if (version == null || pending) return;
    const usedVersion = version;
    pending = true;
    error = '';
    success = '';
    latestVersion = undefined;
    try {
      const result = await commands.send<{ version: number }>(path() + '/requirements', 'PUT', { requirements }, usedVersion);
      version = result.version;
      success = 'Требования области сохранены.';
      saved();
    } catch (problem) {
      error = conflictMessage(problem, usedVersion);
      const current = await api.json<{ version: number }>(path()).catch(() => undefined);
      if (current && current.version !== usedVersion) latestVersion = current.version;
    } finally {
      pending = false;
    }
  }
</script>

<details class="card" ontoggle={load}>
  <summary>Настроить требования области</summary>
  <Notice kind="error" message={error} />
  <Notice kind="success" message={success} />
  {#if version != null}
    <form onsubmit={save}>
      <CatalogFields bind:requirements />
      {#if latestVersion != null}
        <button type="button" onclick={() => { version = latestVersion; latestVersion = undefined; }}>Сверил требования с текущей версией {latestVersion}</button>
      {/if}
      <div class="actions"><button class="primary" disabled={pending}>Сохранить требования области</button></div>
    </form>
  {/if}
</details>
