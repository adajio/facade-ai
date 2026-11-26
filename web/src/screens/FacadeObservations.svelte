<script lang="ts">
  import { tick } from 'svelte';
  import { Commands } from '../lib/commands';
  import { observationLabels, type Binding, type FacadeAssessment, type FacadeObservation, type FactEquivalentsPage } from '../lib/facade-assessment';
  import { date, label } from '../lib/format';
  import { denied, describe, id, interrupted, query, type Api } from '../lib/http';
  import { supportAddress } from '../lib/inquiry-supports';
  import { projectV1, scopedUrl, type Citation, type OpenEvidence, type WorkspaceProps } from '../lib/workspace';
  import FactReviewControl from '../lib/FactReviewControl.svelte';
  import Notice from '../lib/Notice.svelte';

  type Place = NonNullable<FacadeObservation['engineeringReview']>['places'][number];
  type ObservationPage = { version: number; items: FacadeObservation[]; nextCursor: string | null };
  let { api, context, summary, open, renew, facts = false, preselectedFacade }: {
    api: Api; context: WorkspaceProps; summary: FacadeAssessment; open: OpenEvidence; renew?: () => void;
    facts?: boolean; preselectedFacade?: string | null;
  } = $props();
  const commands = new Commands(() => api);
  let binding = $derived(context.params.get('binding') ?? '');
  let facadeId = $derived(preselectedFacade ?? context.params.get('facadeId') ?? '');
  let savedSelection = $state<string>();
  let selection = $derived(facts ? context.params.get('fact') || savedSelection : undefined);
  let highWaterMark = $derived(context.params.get('observedVersion'));
  let resetPage = $derived(Boolean(!selection && highWaterMark && highWaterMark !== String(summary.version)));
  let after = $derived(selection || resetPage ? '' : context.params.get('after') ?? '');
  let editable = $derived(facts && context.canEdit && !context.params.has('revision'));
  let observations = $state<ObservationPage>();
  let problem = $state('');
  let error = $state('');
  let status = $state('');
  let busy = $state(false);
  let heading = $state<HTMLHeadingElement>();
  let focused = '';
  let focusedSelection = '';
  let paramsKey = '';
  let loadedObservationSelection = '';
  $effect(() => {
    const current = context.params.toString();
    if (paramsKey === current) return;
    paramsKey = current;
    savedSelection = undefined;
  });
  const decisionNames: Record<string, string> = {
    confirm: 'Значение подтверждено', select_variant: 'Вариант выбран', correct: 'Число или единица исправлены',
    exclude: 'Ложная находка исключена', merge: 'Эквивалентные записи объединены',
  };

  $effect(() => {
    const version = summary.version;
    const path = projectV1(context.project.id) + '/facade-assessment/' + id(version) + '/observations';
    const stop = new AbortController();
    const selectionKey = JSON.stringify([context.project.id, binding, facadeId, after, selection, facts]);
    if (loadedObservationSelection !== selectionKey) { observations = undefined; problem = ''; }
    void api.json<ObservationPage>(query(path, { binding, facadeId, after, observationId: selection, grouped: facts ? '1' : undefined }), {
      signal: stop.signal,
    }).then((result) => {
      if (stop.signal.aborted) return;
      if (result.version === version) {
        observations = result;
        loadedObservationSelection = selectionKey;
        problem = '';
        if (!selection) focusedSelection = '';
        else if (selection !== focusedSelection && result.items.some(({ id }) => id === selection)) {
          focusedSelection = selection;
          void tick().then(() => document.getElementById('finding-' + selection)?.focus());
        }
      } else problem = 'Получены сведения другой ревизии оценки.';
    }).catch((failure) => {
      if (stop.signal.aborted || interrupted(failure)) return;
      if (denied(failure) || loadedObservationSelection !== selectionKey) observations = undefined;
      problem = describe(failure);
    });
    return () => stop.abort();
  });

  $effect(() => {
    const location = JSON.stringify([facts, context.params.toString(), facadeId]);
    if (!facts || !heading || location === focused) return;
    if (!selection) heading.focus();
    focused = location;
  });

  function href(cursor?: string | null, fact?: string) {
    const revision = context.params.get('revision');
    return scopedUrl(context.project.id, facts ? 'facts' : 'completeness', {
      binding, facadeId, context: context.params.get('context'), revision, observedVersion: revision || fact ? undefined : summary.version, after: cursor, fact,
    });
  }

  function originalEvidence(item: Place): Citation | undefined {
    const evidenceId = item.evidenceId ?? ('evidenceHref' in item && typeof item.evidenceHref === 'string'
      ? /^\/api\/v1\/evidence\/([a-f\d-]{36})$/iu.exec(item.evidenceHref)?.[1] : undefined);
    if (!evidenceId) return undefined;
    return { evidenceId, observationId: item.id, branch: item.branch, documentId: item.documentId,
      versionId: item.versionId, sha256: item.sha256, address: item.address, quote: item.quote ?? undefined, documentRevision:
        item.revision ? { label: item.revision } : undefined };
  }

  function address(item: Place) {
    const evidence = originalEvidence(item);
    return evidence ? supportAddress(evidence) : item.address?.unitId;
  }

  function area(item: FacadeObservation) {
    if (item.binding.state === 'common') return 'common';
    return item.binding.state === 'identified' && item.binding.candidates.length === 1 ? item.binding.candidates[0].id : null;
  }

  function term(input?: string | null) {
    return (input ?? '').normalize('NFKC').trim().toLowerCase().replace(/ё/g, 'е').replace(/\s+/g, ' ');
  }

  function mergeAvailable(item: FacadeObservation) {
    return Boolean(area(item) && item.attribute && item.value !== null && item.revisionStatus === 'current' &&
      item.engineeringReview?.state !== 'review_required');
  }

  function loadEquivalents(observationId: string, version: number, contextId: string | null, after: string | null, signal: AbortSignal) {
    const path = projectV1(context.project.id) + '/package-facts/' + id(observationId) + '/equivalents';
    return api.json<FactEquivalentsPage>(query(path, { version, contextId, after }), { signal });
  }

  function variants(item: FacadeObservation) {
    const scope = area(item);
    const values = (observations?.items ?? []).filter((other) => other.revisionStatus !== 'superseded' &&
      (other.id === item.id || scope && area(other) === scope && term(other.attribute) === term(item.attribute)))
      .flatMap(({ variant }) => variant ? [variant] : []);
    return [...new Set(values)].sort();
  }

  async function save(observationId: string, body: Record<string, unknown>, expectedVersion: number) {
    if (busy || !editable || observations?.version !== summary.version) return false;
    busy = true;
    error = '';
    status = '';
    try {
      await commands.send(projectV1(context.project.id) + '/package-facts/' + id(observationId) + '/reviews', 'POST', body, expectedVersion);
      savedSelection = observationId;
      history.replaceState(history.state, '', href(undefined, observationId));
      renew?.();
      status = 'Решение по сведению сохранено.';
      return true;
    } catch (failure) {
      error = describe(failure);
      renew?.();
      return false;
    } finally {
      busy = false;
    }
  }
</script>

<section aria-labelledby="observations-heading">
  <div class="card-header">
    <h3 id="observations-heading" bind:this={heading} tabindex="-1">{observationLabels[binding as Binding] ?? 'Сведения'}</h3>
    {#if selection}<a href={href()}>К списку сведений</a>
    {:else if after}<a href={href()}>Первая страница</a>{/if}
  </div>
  <Notice kind="error" message={problem} />
  <Notice kind="error" message={error} />
  <Notice kind="success" message={status} />
  {#if resetPage}<p role="status">Версия сведений изменилась. Показана первая страница.</p>{/if}
  {#if observations?.items.length}
    <ul class="plain-list">
      {#each observations.items as item (item.id)}
        {@const review = item.engineeringReview}
        {@const places = review?.places ?? [item]}
        {@const normalized = review?.normalized ?? item.normalized}
        <li id={'finding-' + item.id} tabindex="-1">
          {#if selection}<strong>{item.attribute ?? 'Сведение'}</strong>
          {:else}<a href={href(undefined, item.id)}>{item.attribute ?? 'Сведение'}</a>{/if}
          <p>{item.binding.candidates.map(({ label }) => label).join(', ') || (item.binding.state === 'common' ? 'Весь комплект' : 'Область не установлена')}</p>
          {#if item.binding.reason}<p class="meta">{label(item.binding.reason)}</p>{/if}
          {#if normalized}<p>Нормализованное значение · {normalized.value} {normalized.unit ?? ''}</p>{/if}
          {#if review?.variant ?? item.variant}<p>Вариант · {review?.variant ?? item.variant}</p>{/if}
          {#if review}
            <p>{decisionNames[review.decision.action]} · {review.state === 'stale' ? 'Основание устарело' : review.state === 'review_required'
              ? 'Сведения сохранены, зависимый вывод требует сверки' : 'Решение применено'}</p>
            <p>{review.reason} · автор {review.authorId} · {date(review.createdAt)} · оценка {review.assessmentVersion}</p>
          {/if}
          <ul aria-label="Места в оригиналах" class="plain-list">
            {#each places as place (place.id)}
              {@const evidence = originalEvidence(place)}
              <li>
                <p class="meta">Ветвь {place.branch} · редакция {place.revision ?? 'уточняется'} · {address(place) ?? 'адрес уточняется'}</p>
                {#if place.value !== null}<p>Буквальное значение · {place.value} {place.unit ?? ''}</p>{/if}
                {#if place.variant}<p>Исходный вариант · {place.variant}</p>{/if}
                {#if place.quote}<blockquote>{place.quote}</blockquote>{/if}
                {#if evidence}<button type="button" onclick={(event) => open([evidence], 0, event.currentTarget)}>Открыть основание</button>{/if}
              </li>
            {/each}
          </ul>
          {#if editable && item.revisionStatus !== 'superseded'}
            <FactReviewControl {item} canMerge={mergeAvailable(item)} contextId={context.params.get('context')}
              {loadEquivalents} otherVariants={variants(item)} version={observations.version}
              busy={busy || Boolean(problem) || observations.version !== summary.version} submit={save} />
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
