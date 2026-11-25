<script lang="ts">
  import { Commands } from './commands';
  import { conflictMessage, conflictVersion } from './conflict';
  import EvidenceButtons from './EvidenceButtons.svelte';
  import { date } from './format';
  import { describe, id, interrupted, type Api } from './http';
  import Notice from './Notice.svelte';
  import { V1, type AssessmentQuestion, type Citation, type OpenEvidence } from './workspace';

  type Proof = Citation & { observationId: string; versionId: string };
  type Options = {
    version: number; mayAddFirst: boolean;
    incoming: { citation: Proof; firstEligible: boolean }[];
    previous: Proof[];
  };
  type Record = {
    id: string; authorId: string; reason: string; createdAt: string;
    replaced: Proof[]; replacements: Proof[]; receiptIds: string[];
  };

  let { api, question, canEdit, refreshKey, open, renew }: {
    api: Api; question: AssessmentQuestion; canEdit: boolean;
    refreshKey: number; open: OpenEvidence; renew: () => void;
  } = $props();

  const commands = new Commands(() => api);
  let options = $state<Options | null>(null);
  let history = $state<Record[]>([]);
  let next = $state<string[]>([]);
  let prior = $state<string[]>([]);
  let reason = $state('');
  let confirmation = $state(false);
  let wantsFirst = $state(false);
  let basedOn = $state<number>();
  let pending = $state(false);
  let problem = $state('');
  let loadProblem = $state('');
  let receipt = $state<string>();
  let held = $derived(question.machine.limitations.includes('supplement_review_required'));
  let path = $derived(V1 + '/questions/' + id(question.id));
  let first = $derived(Boolean(options?.mayAddFirst && (wantsFirst || !options.previous.length)));
  let incoming = $derived(options?.incoming.filter((item) => !first || item.firstEligible).map(({ citation }) => citation) ?? []);
  let replacement = $derived(incoming.filter(({ observationId }) => next.includes(observationId)));
  let replacingVersions = $derived(new Set(replacement.map(({ versionId }) => versionId)));
  let previous = $derived(options?.previous.filter(({ versionId }) => !replacingVersions.has(versionId)) ?? []);
  let retired = $derived(first ? [] : previous.filter(({ observationId }) => prior.includes(observationId)));
  let stale = $derived(basedOn !== undefined && basedOn !== question.version);
  let ready = $derived(canEdit && held && options?.version === question.version && !pending && !stale &&
    replacement.some(({ branch }) => branch === 'A') && replacement.some(({ branch }) => branch === 'B') &&
    replacement.length <= 16 && (first || retired.length > 0 && retired.length <= 16) && Boolean(reason.trim()));

  $effect(() => {
    const target = path;
    const withOptions = canEdit && held;
    void question.version;
    void refreshKey;
    const controller = new AbortController();
    const { signal } = controller;
    loadProblem = '';
    if (!withOptions) options = null;
    api.json<{ replacements: Record[]; supplement?: Options | null }>(
      target + '/applicability' + (withOptions ? '?supplement=1' : ''), { signal },
    ).then(({ replacements, supplement }) => {
      if (!signal.aborted) {
        history = replacements;
        options = supplement ?? null;
      }
    }).catch((error) => {
      if (!signal.aborted && !interrupted(error)) loadProblem = describe(error);
    });
    return () => controller.abort();
  });

  function selectionChanged() {
    basedOn ??= question.version;
    confirmation = false;
  }

  function recheck() {
    basedOn = question.version;
    confirmation = false;
    next = [];
    prior = [];
  }

  function label(source: Proof) {
    const page = (source.address?.locator as { page?: number } | undefined)?.page;
    return [source.label ?? source.versionId, page ? 'Стр. ' + page : source.address?.unitId,
      source.value == null ? undefined : [source.value, source.unit].filter(Boolean).join(' '),
      source.branch ? 'ветвь ' + source.branch : undefined,
    ].filter(Boolean).join(' · ');
  }

  function reference({ observationId, evidenceId, versionId }: Proof) {
    return { observationId, evidenceId, versionId };
  }

  async function confirm(event: SubmitEvent) {
    event.preventDefault();
    if (!ready || !confirmation) return;
    const version = question.version;
    pending = true;
    problem = '';
    receipt = undefined;
    try {
      const result = await commands.send<{ id: string }>(path + '/source-replacements', 'POST', {
        replacements: replacement.map(reference), replaced: retired.map(reference), reason: reason.trim(),
      }, version);
      receipt = result.id;
      reason = '';
      next = [];
      prior = [];
      confirmation = false;
      basedOn = undefined;
      renew();
    } catch (error) {
      problem = conflictMessage(error, version);
      if (conflictVersion(error)) { confirmation = false; renew(); }
    } finally {
      pending = false;
    }
  }
</script>

{#if held || history.length || receipt || loadProblem}
  <section class="supplement-review" aria-label="Сверка досылки по требованию">
    <h3>Сверка досылки по требованию</h3>
    <Notice kind="error" message={loadProblem} />
    <Notice kind="error" message={problem} />
    {#if receipt}<Notice kind="success" message={'Сверка сохранена. Квитанция ' + receipt} />{/if}
    {#if held && canEdit && options}
      <p>Редакция вопроса · {options.version}</p>
      {#if options.mayAddFirst && options.previous.length}
        <label><input type="checkbox" bind:checked={wantsFirst} onchange={selectionChanged} disabled={pending} />
          Добавить первую опору к отправленному запросу на уточнение</label>
      {:else if first}
        <p>Добавьте первую опору к отправленному запросу на уточнение.</p>
      {/if}
      {#if incoming.length}
        <form onsubmit={confirm}>
          <fieldset>
            <legend>Адреса досылки обеих ветвей</legend>
            {#each incoming as source (source.observationId)}
              <label><input type="checkbox" value={source.observationId} bind:group={next} onchange={selectionChanged} disabled={pending} /> {label(source)}</label>
              <EvidenceButtons citations={[{ ...source, sourceLabel: 'Открыть адрес досылки' }]} {open} />
            {/each}
          </fieldset>
          {#if !first}
            <fieldset>
              <legend>Прежние опоры для замены</legend>
              {#if !previous.length}<p>Прежние опоры для замены отсутствуют.</p>{/if}
              {#each previous as source (source.observationId)}
                <label><input type="checkbox" value={source.observationId} bind:group={prior} onchange={selectionChanged} disabled={pending} /> {label(source)}</label>
                <EvidenceButtons citations={[{ ...source, sourceLabel: 'Открыть прежнюю опору' }]} {open} />
              {/each}
            </fieldset>
          {/if}
          <label>Причина сверки<textarea required maxlength="2000" bind:value={reason} oninput={selectionChanged} disabled={pending}></textarea></label>
          <label><input type="checkbox" bind:checked={confirmation} disabled={!ready} /> Подтверждаю выбранные опоры этого требования</label>
          {#if stale}
            <p>Появилась редакция {question.version}. Сверьте выбранные адреса заново.</p>
            <button type="button" onclick={recheck}>Выбрать опоры в текущей редакции</button>
          {/if}
          <button class="primary" disabled={!ready || !confirmation}>{first ? 'Подтвердить первую опору' : 'Подтвердить замену опор'}</button>
        </form>
      {:else}
        <p>Ожидаются применимые адреса из закрытой досылки.</p>
      {/if}
    {/if}
    {#if history.length}
      <details>
        <summary>История сверки досылок ({history.length})</summary>
        <ul class="plain-list">
          {#each history as item (item.id)}
            <li>
              <strong>{item.replaced.length ? 'Замена опор' : 'Первая опора'} · {date(item.createdAt)}</strong>
              <p>{item.reason}</p>
              <p class="meta">Квитанция {item.id} · Автор {item.authorId}</p>
              {#each item.replaced as source (source.observationId)}
                <EvidenceButtons citations={[{ ...source, sourceLabel: 'Прежняя опора · ' + source.versionId }]} {open} />
              {/each}
              {#each item.replacements as source (source.observationId)}
                <EvidenceButtons citations={[{ ...source, sourceLabel: 'Опора досылки · ' + source.versionId }]} {open} />
              {/each}
            </li>
          {/each}
        </ul>
      </details>
    {/if}
  </section>
{/if}

<style>
  .supplement-review { border-block-start: 1px solid var(--line); margin-block-start: 16px; padding-block-start: 12px; }
  fieldset, textarea { margin-block-end: 12px; }
</style>
