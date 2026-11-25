<script lang="ts">
  import { supportAddress, type InquirySupport } from './inquiry-supports';
  import type { OpenEvidence } from './workspace';
  import InquirySupportDetails from './InquirySupportDetails.svelte';
  import Notice from './Notice.svelte';

  type Choice = { source: InquirySupport; blocked?: string };

  let {
    assessmentVersion, version, subject, scope, catalog, formats, incoming, previous, pending, problem, result, reviewHref, open, save,
  }: {
    assessmentVersion: number;
    version: number;
    subject: string;
    scope: string;
    catalog: string;
    formats: string[];
    incoming: Choice[];
    previous: InquirySupport[];
    pending: boolean;
    problem: string;
    result: string;
    reviewHref: string;
    open: OpenEvidence;
    save: (input: { next: string[]; prior: string[]; reason: string; version: number }) => Promise<boolean>;
  } = $props();

  let next = $state<string[]>([]);
  let prior = $state<string[]>([]);
  let reason = $state('');
  let confirmed = $state(false);
  let basedOn = $state<number>();
  let selected = $derived(incoming.filter((item) => next.includes(item.source.observationId)));
  let selectedVersions = $derived(new Set(selected.map(({ source }) => source.versionId)));
  let previousChoices = $derived(previous.filter((source) => !selectedVersions.has(source.versionId)));
  let linked = $derived(previousChoices.filter((source) => prior.includes(source.observationId)));
  let blocked = $derived(selected.some((item) => item.blocked));
  let bothBranches = $derived(['A', 'B'].every((branch) => selected.some(({ source }) => source.branch === branch)));
  let stale = $derived(basedOn != null && basedOn !== version);
  let ready = $derived(!pending && !stale && !blocked && bothBranches && selected.length <= 16
    && linked.length > 0 && linked.length <= 16 && Boolean(reason.trim()));

  function selectionChanged() {
    basedOn ??= version;
    confirmed = false;
  }

  function info(source: InquirySupport) {
    return [
      source.label ?? source.relativePath, source.documentRevision?.label, supportAddress(source),
      source.measurement && [source.measurement.value, source.measurement.unit].join(' '),
    ].filter(Boolean).join(' · ') || source.versionId;
  }

  function reviewVersion() {
    prior = linked.map((source) => source.observationId);
    next = selected.map(({ source }) => source.observationId);
    basedOn = version;
    confirmed = false;
  }

  async function submit(event: SubmitEvent) {
    event.preventDefault();
    if (!ready || !confirmed) return;
    if (await save({ next: selected.map(({ source }) => source.observationId), prior: linked.map((source) => source.observationId), reason: reason.trim(), version: basedOn ?? version })) {
      next = [];
      prior = [];
      reason = '';
      confirmed = false;
      basedOn = undefined;
    }
  }
</script>

<section class="card" aria-labelledby="replace-supports-title">
  <h2 id="replace-supports-title">Замена опор вопроса</h2>
  <dl class="details">
    <dt>Предмет</dt><dd>{subject}</dd>
    <dt>Область</dt><dd>{scope}</dd>
    <dt>Закреплённый каталог</dt><dd>{catalog}</dd>
    {#if formats.length}<dt>Допустимые формы по каталогу</dt><dd>{formats.map((format) => format.toUpperCase()).join(', ')}</dd>{/if}
    <dt>Версия оценки</dt><dd>{assessmentVersion}</dd>
    <dt>Версия строки для подтверждения</dt><dd>{basedOn ?? version}</dd>
  </dl>
  <Notice kind="error" message={problem} />
  <Notice kind="success" message={result} />
  {#if incoming.length}
    <form onsubmit={submit}>
      <fieldset>
        <legend>Новые опоры обеих ветвей</legend>
        {#each incoming as option (option.source.observationId)}
          {@const source = option.source}
          <label><input type="checkbox" bind:group={next} value={source.observationId} onchange={selectionChanged} disabled={pending || Boolean(option.blocked)} />
            {info(source)}{source.branch ? ' · ветвь ' + source.branch : ''}</label>
          <Notice message={option.blocked ?? ''} />
          <details open={next.includes(source.observationId)}>
            <summary>Адрес и редакция новой опоры</summary>
            <InquirySupportDetails {source} {open} />
          </details>
        {/each}
      </fieldset>
      <fieldset>
        <legend>Прежние опоры, которые нужно заменить</legend>
        {#if !previous.length}
          <Notice message="В текущей версии оценки прежние опоры отсутствуют. Повторно сверьте эту строку, чтобы продолжить замену." />
          <p><a href={reviewHref}>Открыть строку для сверки</a></p>
        {/if}
        {#each previousChoices as source (source.observationId)}
          <label><input type="checkbox" bind:group={prior} value={source.observationId} onchange={selectionChanged} disabled={pending} /> {info(source)}{source.branch ? ' · ветвь ' + source.branch : ''}</label>
          <details>
            <summary>Адрес и редакция прежней опоры</summary>
            <InquirySupportDetails {source} {open} />
          </details>
        {/each}
      </fieldset>
      <label>Причина замены<textarea bind:value={reason} oninput={selectionChanged} maxlength="2000" rows="3" required disabled={pending}></textarea></label>
      <label><input type="checkbox" bind:checked={confirmed} disabled={!ready} /> Подтверждаю замену выбранных опор только для этого вопроса</label>
      {#if stale}
        <p class="notice">Появилась версия {version}. Проверьте актуальные опоры и сохранённую причину.</p>
        <button type="button" onclick={reviewVersion}>Сверил выбор с актуальной версией</button>
      {/if}
      <div class="actions"><button type="submit" class="primary" disabled={!ready || !confirmed}>Подтвердить замену</button></div>
    </form>
  {:else}
    <p class="muted">Для замены нужны новые опоры обеих ветвей и прежние опоры этого вопроса.</p>
  {/if}
</section>
