<script lang="ts">
  import { onMount } from 'svelte';
  import { describe, interrupted, query, type Api } from './http';
  import { projectV1, scopedUrl } from './workspace';
  import type { Project } from './contracts';
  import Notice from './Notice.svelte';

  type ProposalKind = 'stage' | 'facadeKind';
  type Observation = {
    id: string;
    evidenceHref: string;
    designStage: string | null;
    basis: { stage?: string };
    quote: string | null;
    proposedFacadeKind: string | null;
    binding: { candidates: { label: string }[] };
  };
  type Proposal = { value: string; quote: string; evidenceId: string; observationId: string; facades: string[] };
  type Summary = { version: number; observations: { href: string; proposalCounts: Record<ProposalKind, number> } };
  type Page = { version: number; items: Observation[]; nextCursor: string | null };
  let { api, project, disabled, showStage = true, onStageAvailability, confirmStage, confirmFacadeKinds }: {
    api: Api;
    project: Project;
    disabled: boolean;
    showStage?: boolean;
    onStageAvailability?: (available: boolean) => void;
    confirmStage: (stage: string, evidenceId: string) => Promise<void>;
    confirmFacadeKinds: (kinds: string[], evidenceIds: string[]) => Promise<void>;
  } = $props();

  let stages = $state<Proposal[]>([]);
  let types = $state<Proposal[]>([]);
  let selectedTypes = $state<string[]>([]);
  let problem = $state('');
  let loading = $state(true);
  let controller: AbortController | undefined;
  let chooseTypes = $derived(types.length > 1 || Boolean(project.confirmedFacadeKinds?.length));

  async function readProposals(summary: Summary, kind: ProposalKind, signal: AbortSignal) {
    const values = new Map<string, Proposal>();
    if (!summary.observations.proposalCounts?.[kind]) return [];
    const { version, observations: { href } } = summary;
    let cursor: string | null = null;
    do {
      const page: Page = await api.json<Page>(query(href, { proposal: kind, after: cursor, limit: 100 }), { signal });
      if (page.version !== version || (cursor && page.nextCursor && page.nextCursor <= cursor)) {
        throw new Error('Не удалось прочитать предложения из одной ревизии оценки.');
      }
      for (const item of page.items) {
        const value = kind === 'stage' ? item.designStage : item.proposedFacadeKind;
        const quote = kind === 'stage' ? item.basis.stage : item.quote;
        const evidenceId = /^\/api\/v1\/evidence\/([0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12})$/iu.exec(item.evidenceHref)?.[1];
        if (!value || !quote || !evidenceId) continue;
        if (values.has(value)) continue;
        values.set(value, { value, quote, evidenceId, observationId: item.id,
          facades: item.binding.candidates.map(({ label }) => label) });
      }
      cursor = page.nextCursor;
    } while (cursor);
    return [...values.values()];
  }

  async function load() {
    controller?.abort();
    const request = new AbortController();
    controller = request;
    const signal = request.signal;
    loading = true;
    problem = '';
    try {
      const summary = await api.json<Summary>(projectV1(project.id) + '/facade-assessment', { signal });
      const [stageOptions, typeOptions] = await Promise.all([
        readProposals(summary, 'stage', signal), readProposals(summary, 'facadeKind', signal),
      ]);
      if (signal.aborted) return;
      stages = stageOptions;
      onStageAvailability?.(stageOptions.length > 0);
      types = typeOptions;
      selectedTypes = types.filter(({ value }) => project.confirmedFacadeKinds?.includes(value)).map(({ value }) => value);
    } catch (error) {
      if (signal.aborted || interrupted(error)) return;
      stages = [];
      types = [];
      problem = describe(error);
    } finally {
      if (!signal.aborted) loading = false;
    }
  }

  onMount(() => {
    void load();
    return () => controller?.abort();
  });

  function confirmTypes(choices: Proposal[]) {
    const kinds = choices.map(({ value }) => value);
    selectedTypes = kinds;
    return confirmFacadeKinds(kinds, [...new Set(choices.map(({ evidenceId }) => evidenceId))]);
  }
</script>

{#snippet source(proposal: Proposal)}
  <blockquote>{proposal.quote}</blockquote>
  <a href={scopedUrl(project.id, 'members', { evidence: proposal.evidenceId, observation: proposal.observationId })}>
    Открыть основание для {proposal.value}
  </a>
{/snippet}

{#if loading}
  <p role="status">Ищем предложения в прочитанных исходниках…</p>
{:else}
  <Notice kind="error" message={problem} />
  {#if stages.length && showStage}
    <h3>{stages.length === 1 ? 'Предложенная стадия' : 'В исходниках указаны разные стадии'}</h3>
    <ul class="plain-list">
      {#each stages as proposal (proposal.value)}
        <li>
          <strong>{proposal.value}</strong>
          {@render source(proposal)}
          {#if project.stage !== proposal.value}
            <div class="actions">
              <button type="button" {disabled} onclick={() => confirmStage(proposal.value, proposal.evidenceId)}>
                Подтвердить стадию {proposal.value}
              </button>
            </div>
          {/if}
        </li>
      {/each}
    </ul>
  {:else if !stages.length && !problem}
    <p>В прочитанных исходниках пока нет предложения по стадии.</p>
  {/if}
  {#if types.length}
    <h3>Предложения по типам фасадов</h3>
    {#if chooseTypes}<p>Выберите полный набор типов фасадов проекта.</p>{/if}
    <ul class="plain-list">
      {#each types as proposal (proposal.value)}
        <li>
          {#if chooseTypes}
            <label><input type="checkbox" value={proposal.value} bind:group={selectedTypes} {disabled} /> {proposal.value}</label>
          {:else}
            <strong>{proposal.value}</strong>
          {/if}
          {#if proposal.facades.length}<p>{proposal.facades.join(', ')}</p>{/if}
          {@render source(proposal)}
        </li>
      {/each}
    </ul>
    <div class="actions">
      {#if chooseTypes}
        <button type="button" disabled={disabled || !selectedTypes.length}
          onclick={() => confirmTypes(types.filter(({ value }) => selectedTypes.includes(value)))}>
          Подтвердить выбранные типы фасадов
        </button>
      {:else}
        <button type="button" {disabled} onclick={() => confirmTypes(types)}>Подтвердить тип {types[0].value}</button>
      {/if}
    </div>
  {/if}
{/if}
<button type="button" class="quiet" disabled={disabled || loading} onclick={load}>Обновить предложения</button>
