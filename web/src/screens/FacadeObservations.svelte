<script lang="ts">
  import { observationLabels, type Binding, type FacadeAssessment, type FacadeObservation } from '../lib/facade-assessment';
  import { label } from '../lib/format';
  import { describe, id, interrupted, query, type Api } from '../lib/http';
  import { projectV1, scopedUrl, type OpenEvidence, type WorkspaceProps } from '../lib/workspace';
  import Notice from '../lib/Notice.svelte';

  let { api, context, summary, open, facts = false, preselectedFacade }: {
    api: Api; context: WorkspaceProps; summary: FacadeAssessment; open: OpenEvidence;
    facts?: boolean; preselectedFacade?: string | null;
  } = $props();
  let binding = $derived(context.params.get('binding') ?? '');
  let facadeId = $derived(context.params.get('facadeId') ?? preselectedFacade ?? '');
  let after = $derived(context.params.get('after') ?? '');
  type ObservationPage = { version: number; items: FacadeObservation[]; nextCursor: string | null };
  let observations = $state<ObservationPage>();
  let problem = $state('');

  $effect(() => {
    const version = summary.version;
    const path = projectV1(context.project.id) + '/facade-assessment/' + id(version) + '/observations';
    const stop = new AbortController();
    observations = undefined;
    problem = '';
    void api.json<ObservationPage>(query(path, { binding, facadeId, after }), {
      signal: stop.signal,
    }).then((result) => {
      if (result.version === version) observations = result;
      else problem = 'Получены сведения другой ревизии оценки.';
    }).catch((error) => {
      if (stop.signal.aborted || interrupted(error)) return;
      problem = describe(error);
    });
    return () => stop.abort();
  });

  function href(cursor?: string | null) {
    return scopedUrl(context.project.id, facts ? 'facts' : 'completeness',
      { binding, facadeId, context: context.params.get('context'), revision: summary.version, after: cursor });
  }

  function evidenceId(href: string) {
    return /^\/api\/v1\/evidence\/([0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12})$/iu.exec(href)?.[1];
  }
</script>

<section aria-labelledby="observations-heading">
  <div class="card-header">
    <h3 id="observations-heading">{observationLabels[binding as Binding] ?? 'Сведения'}</h3>
    {#if after}<a href={href()}>Первая страница</a>{/if}
  </div>
  <Notice kind="error" message={problem} />
  {#if observations?.items.length}
    <ul class="plain-list">
      {#each observations.items as item (item.id)}
        {@const evidence = evidenceId(item.evidenceHref)}
        <li>
          <strong>{item.attribute ?? 'Сведение'}{#if item.value != null} · {item.value} {item.unit ?? ''}{/if}</strong>
          {#if item.quote}<blockquote>{item.quote}</blockquote>{/if}
          {#if item.binding.candidates.length}<p>{item.binding.candidates.map(({ label }) => label).join(', ')}</p>{/if}
          {#if item.binding.reason}<p class="meta">{label(item.binding.reason)}</p>{/if}
          {#if evidence}
            <button type="button" onclick={(event) => open([{
              evidenceId: evidence, observationId: item.id, branch: item.branch, documentId: item.documentId,
              versionId: item.versionId, sha256: item.sha256, address: item.address, quote: item.quote ?? undefined,
            }], 0, event.currentTarget)}>Открыть основание</button>
          {/if}
        </li>
      {/each}
    </ul>
  {:else if observations}
    <p class="empty">В выбранной группе нет сведений.</p>
  {:else if !problem}
    <p role="status">Загружаем сведения…</p>
  {/if}
  {#if observations?.nextCursor}<a class="button" href={href(observations.nextCursor)}>Следующая страница</a>{/if}
</section>
