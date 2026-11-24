<script lang="ts">
  import type { OpenEvidence } from './workspace';
  import { wordingFields, type TextRange, type WordingReview, type WordingSource } from './wording';
  import EvidenceButtons from './EvidenceButtons.svelte';
  import Notice from './Notice.svelte';

  let { wording, hash, scope, subject, action, formats, sources, open, publish }: {
    wording: string;
    hash: string;
    scope: string;
    subject: string;
    action: string;
    formats: string[];
    sources: WordingSource[];
    open: OpenEvidence;
    publish: (value?: WordingReview) => void;
  } = $props();

  const fields = ['scope', 'subject', 'action'] as const;
  type RequiredField = typeof fields[number];
  let saved: HTMLTextAreaElement;
  let common = $state<Partial<Record<RequiredField, TextRange>>>({});
  let addresses = $state<Record<string, TextRange>>({});
  let values = $state<Record<string, TextRange>>({});
  let confirmed = $state(false);
  let error = $state('');
  let expected = $derived({ scope, subject, action });
  let ready = $derived(fields.every((field) => common[field]) && sources.every((source) => {
    const { observationId, value } = source.address;
    return Boolean(addresses[observationId]) && (value == null || Boolean(values[observationId]));
  }));

  function emit() {
    if (!ready || !confirmed || !common.scope || !common.subject || !common.action) {
      publish();
      return;
    }
    publish({
      wordingSha256: hash, scope: common.scope, subject: common.subject, action: common.action,
      citations: sources.map(({ address }) => ({
        observationId: address.observationId, reference: addresses[address.observationId],
        ...(address.value == null ? {} : { value: values[address.observationId] }),
      })),
    });
  }

  function mark(field: RequiredField | 'reference' | 'value', observationId?: string) {
    const { selectionStart: start, selectionEnd: end } = saved;
    const excerpt = wording.slice(start, end);
    if (start === end || !excerpt.trim()) {
      error = 'Выделите нужный фрагмент в сохранённом тексте.';
      saved.focus();
      return;
    }
    error = '';
    const range = { start, end };
    if (field === 'reference' && observationId) addresses[observationId] = range;
    else if (field === 'value' && observationId) values[observationId] = range;
    else if (field !== 'reference' && field !== 'value') common[field] = range;
    confirmed = false;
    publish();
  }

  function marked(range?: TextRange) {
    return range ? wording.slice(range.start, range.end) : 'Фрагмент ещё не выделен';
  }
</script>

<fieldset class="review">
  <legend>Сверка авторского текста</legend>
  <label>Сохранённая формулировка
    <textarea bind:this={saved} value={wording} readonly rows="5" spellcheck="false"></textarea>
  </label>
  <p class="meta">Выделите фрагмент мышью или клавишами со стрелками с Shift, затем нажмите действие рядом с основанием.</p>
  <Notice kind="error" message={error} />
  <ul class="plain-list">
    {#each fields as field (field)}
      <li>
        <strong>{wordingFields[field]}</strong> · {expected[field]}
        {#if field === 'action' && formats.length}<span class="meta"> · форматы {formats.join(', ')}</span>{/if}
        <p class="meta">{marked(common[field])}</p>
        <button type="button" onclick={() => mark(field)}>Отметить {field === 'scope' ? 'область' : field === 'subject' ? 'предмет' : 'действие'}</button>
      </li>
    {/each}
    {#each sources as source, index (source.address.observationId)}
      {@const observation = source.address.observationId}
      <li>
        <strong>Источник {index + 1}</strong> · {source.label}
        {#if source.address.value != null}<p>Значение · {source.address.value} {source.address.unit ?? ''}</p>{/if}
        <EvidenceButtons citations={[source.address]} {open} />
        <p class="meta">Обозначение · {marked(addresses[observation])}</p>
        <button type="button" onclick={() => mark('reference', observation)}>Отметить источник {index + 1}</button>
        {#if source.address.value != null}
          <p class="meta">Значение · {marked(values[observation])}</p>
          <button type="button" onclick={() => mark('value', observation)}>Отметить значение источника {index + 1}</button>
        {/if}
      </li>
    {/each}
  </ul>
  <label><input type="checkbox" checked={confirmed} disabled={!ready} onchange={(event) => { confirmed = event.currentTarget.checked; emit(); }} /> Сверил смысл всей формулировки с актуальными основаниями</label>
</fieldset>

<style>
  .review { margin-block: .7rem; }
  .review p { margin-block: .35rem; }
</style>
