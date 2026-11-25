<script lang="ts">
  import { untrack } from 'svelte';
  import { Commands } from '../lib/commands';
  import { conflictMessage } from '../lib/conflict';
  import { date } from '../lib/format';
  import { ApiError, describe, id, interrupted, query, type Api } from '../lib/http';
  import { V1, projectV1, scopedUrl, type Assessment, type AssessmentQuestion, type OpenEvidence, type WorkspaceProps } from '../lib/workspace';
  import type { InquirySupport } from '../lib/inquiry-supports';
  import EvidenceButtons from '../lib/EvidenceButtons.svelte';
  import Notice from '../lib/Notice.svelte';
  import SupportReplacementForm from '../lib/SupportReplacementForm.svelte';

  type Proof = { observationId: string; evidenceId: string; versionId: string };
  type Candidate = { source: InquirySupport; applicability: string };
  type Replacement = {
    id: string; createdAt: string; reason: string; authorId: string;
    catalogVersionId: string; scopeVersion: number; replaced: Proof[]; replacements: Proof[];
  };

  let { api, questionId, candidates, context, open, renew }: {
    api: Api; questionId: string; candidates: Candidate[]; context: WorkspaceProps;
    open: OpenEvidence; renew: () => void;
  } = $props();
  const commands = new Commands(() => api);
  let assessment = $state<Assessment>();
  let question = $state<AssessmentQuestion>();
  let history = $state<Replacement[]>([]);
  let pending = $state(false);
  let error = $state('');
  let result = $state('');
  let loadError = $state('');
  let fileNames = $state<Record<string, string>>({});
  let path = $derived(V1 + '/questions/' + id(questionId));
  let formats = $derived(question?.requirement.formats ?? []);
  let sourceMap = $derived(new Map(candidates.map(({ source }) => [source.observationId, source])));
  let previous = $derived((question?.machine.citations ?? []).flatMap((citation): InquirySupport[] => {
    if (!citation.observationId || !citation.versionId || citation.value == null) return [];
    const source = sourceMap.get(citation.observationId);
    return [{
      subject: question?.requirement.subject ?? '', property: question?.requirement.part ?? '',
      revision: 'effective', role: '', receiptId: '',
      ...source, ...citation, observationId: citation.observationId, versionId: citation.versionId,
      measurement: { value: citation.value, unit: citation.unit ?? '' },
    }];
  }));
  let previousMap = $derived(new Map(previous.map((source) => [source.observationId, source])));
  let incoming = $derived(candidates.flatMap(({ source, applicability }) => {
    if (source.assessmentQuestionId !== questionId || !source.measurement || source.revision !== 'effective') return [];
    const format = source.format?.toLowerCase().replace(/^\./, '');
    const blocked = format && !formats.includes(format)
      ? 'Формат ' + format.toUpperCase() + ' отсутствует в закреплённом требовании. Замена удержана.'
      : applicability !== 'verified'
        ? 'Опора ожидает проверки применимости в текущей оценке.' : undefined;
    const details = previousMap.get(source.observationId);
    return [{ source: { ...source, ...(details ?? {}), relativePath: details?.relativePath ?? source.relativePath ?? fileNames[source.versionId] }, blocked }];
  }));
  let editable = $derived(context.canEdit && !context.revision);
  let scope = $derived(assessment?.scope?.name ?? context.project.scopes.find(({ id }) => id === context.scopeId)?.name ?? '');
  let catalog = $derived.by(() => {
    const pinned = context.project.catalog;
    return pinned && assessment?.catalogVersionId === pinned.id
      ? pinned.name + ' · версия ' + pinned.revision
      : assessment?.catalogVersionId ?? '—';
  });

  $effect(() => {
    const assessmentPath = query(projectV1(context.project.id) + '/assessments/current', { scopeId: context.scopeId });
    const historyPath = path + '/applicability';
    const currentId = questionId;
    const editing = editable;
    void context.refreshKey;
    const controller = new AbortController();
    const signal = controller.signal;
    loadError = '';
    if (editing) {
      api.json<Assessment>(assessmentPath, { signal }).then((snapshot) => {
        assessment = snapshot;
        question = snapshot.questions.find((row) => row.id === currentId);
      }).catch((problem) => {
        if (!signal.aborted && !interrupted(problem)) loadError = describe(problem);
      });
    }
    api.json<{ replacements: Replacement[] }>(historyPath, { signal })
      .then(({ replacements }) => { history = replacements; })
      .catch((problem) => { if (!signal.aborted && !interrupted(problem)) loadError = describe(problem); });
    return () => controller.abort();
  });

  $effect(() => {
    if (!editable) return;
    const versions = new Map(candidates.filter(({ source }) => source.assessmentQuestionId === questionId && source.measurement)
      .map(({ source }) => [source.versionId, source]));
    const controller = new AbortController();
    const { signal } = controller;
    async function loadNames() {
      const queue = [...versions.values()].filter((source) => !source.label && !source.relativePath && !fileNames[source.versionId]);
      for (let offset = 0; offset < queue.length && !signal.aborted; offset += 4) {
        const results = await Promise.allSettled(queue.slice(offset, offset + 4).map(async (source) => {
          const evidence = await api.json<{ source: { relativePath?: string; name?: string } }>(
            V1 + '/evidence/' + id(source.evidenceId), { signal },
          );
          return [source.versionId, evidence.source.relativePath ?? evidence.source.name ?? ''] as const;
        }));
        if (signal.aborted) return;
        for (const result of results) if (result.status === 'fulfilled') fileNames[result.value[0]] = result.value[1];
      }
    }
    untrack(() => void loadNames());
    return () => controller.abort();
  });

  function proof(source: Proof) {
    return { observationId: source.observationId, evidenceId: source.evidenceId, versionId: source.versionId };
  }

  async function save(input: { next: string[]; prior: string[]; reason: string; version: number }) {
    if (pending || !editable) return false;
    const replacements = incoming.filter(({ source, blocked }) => !blocked && input.next.includes(source.observationId)).map(({ source }) => proof(source));
    const replaced = previous.filter((source) => input.prior.includes(source.observationId)).map(proof);
    if (replacements.length !== input.next.length || replaced.length !== input.prior.length) return false;
    pending = true;
    error = '';
    result = '';
    try {
      await commands.send(path + '/source-replacements', 'POST', { replacements, replaced, reason: input.reason }, input.version);
      result = 'Замена опор для этого вопроса сохранена.';
      renew();
      return true;
    } catch (problem) {
      error = conflictMessage(problem, input.version);
      if (problem instanceof ApiError && [409, 412].includes(problem.status)) renew();
      return false;
    } finally {
      pending = false;
    }
  }
</script>

<Notice kind="error" message={loadError} />
{#if editable && assessment && question && (previous.length || incoming.length || result)}
  <SupportReplacementForm assessmentVersion={assessment.version} version={question.version} subject={question.requirement.subject}
    reviewHref={scopedUrl(context.project.id, 'completeness', { scope: context.scopeId }, question.id)}
    {scope} {catalog} {formats} {incoming} {previous} {pending} problem={error} {result} {open} {save} />
{/if}

{#if history.length}
  <section class="card" aria-labelledby="replacement-history-title">
    <h2 id="replacement-history-title">История замены опор</h2>
    <ul class="plain-list">
      {#each history as record (record.id)}
        <li>
          <strong>{record.reason}</strong>
          <p class="meta">{date(record.createdAt)} · Автор {record.authorId} · Каталог {record.catalogVersionId} · Версия области {record.scopeVersion}</p>
          <details>
            <summary>Адреса и версии до и после замены</summary>
            <h3>Прежние опоры</h3>
            <ul class="plain-list">
              {#each record.replaced as source, index (source.observationId)}
                <li>
                  <p class="meta">Версия оригинала · {source.versionId}</p>
                  <EvidenceButtons citations={[{ ...source, sourceLabel: 'Открыть прежнюю опору ' + (index + 1) }]} {open} />
                </li>
              {/each}
            </ul>
            <h3>Новые опоры</h3>
            <ul class="plain-list">
              {#each record.replacements as source, index (source.observationId)}
                <li>
                  <p class="meta">Версия оригинала · {source.versionId}</p>
                  <EvidenceButtons citations={[{ ...source, sourceLabel: 'Открыть новую опору ' + (index + 1) }]} {open} />
                </li>
              {/each}
            </ul>
          </details>
        </li>
      {/each}
    </ul>
  </section>
{/if}
