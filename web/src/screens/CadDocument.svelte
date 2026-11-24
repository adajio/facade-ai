<script lang="ts">
  import { describe, type Api } from '../lib/http';
  import { label } from '../lib/format';
  import type { WorkspaceProps } from '../lib/workspace';
  import Notice from '../lib/Notice.svelte';

  type Unit = { id: string; label?: string; locator?: Record<string, string | number> };
  type Row = { id: string; text: string; locator: { derivativeHandle?: string; entityOrdinal?: number };
    details?: { entity?: string; entityOrdinal?: number; limitations?: string[] } };
  type Native = { lines: Row[]; limitations: string[]; derivativeSha256?: string };
  let { api, context, units, readerVersion, endpoint }: {
    api: Api; context: WorkspaceProps; units: Unit[]; readerVersion: string; endpoint: string;
  } = $props();

  const part = $derived(units.find(unit => unit.id === context.params.get('part')));
  const selector = $derived(context.params.get('entity') ?? '');
  const url = $derived(part ? endpoint + '/' + encodeURIComponent(part.id) : undefined);
  let native = $state<Native>();
  let selected = $state<Native>();
  let error = $state('');
  let objectError = $state('');
  let image = $state('');
  let imageError = $state('');
  let imageRequest = $state<string>();

  function parameters(address: string, representation: 'native' | 'render') {
    const query = new URLSearchParams({ readerVersion, representation });
    if (address.startsWith('h:')) query.set('derivativeHandle', address.slice(2));
    if (address.startsWith('o:')) query.set('entityOrdinal', address.slice(2));
    return '?' + query.toString();
  }

  function address(row: Row) {
    return row.locator.derivativeHandle ? 'h:' + row.locator.derivativeHandle : 'o:' + row.locator.entityOrdinal;
  }

  $effect(() => {
    const path = url;
    const query = parameters('', 'native');
    native = undefined;
    error = '';
    if (!path) return;
    const controller = new AbortController();
    void api.json<Native>(path + query, { signal: controller.signal }).then(value => {
      if (!controller.signal.aborted) native = value;
    }).catch(e => { if (!controller.signal.aborted) error = describe(e); });
    return () => controller.abort();
  });

  $effect(() => {
    const path = url;
    const addr = selector;
    const query = parameters(addr, 'native');
    selected = undefined;
    objectError = '';
    if (!path || !/^(h:[0-9A-F]{1,16}|o:[1-9]\d*)$/.test(addr)) return;
    const controller = new AbortController();
    void api.json<Native>(path + query, { signal: controller.signal }).then(value => {
      if (!controller.signal.aborted) selected = value;
    }).catch(e => { if (!controller.signal.aborted) objectError = describe(e); });
    return () => controller.abort();
  });

  $effect(() => {
    const path = url;
    const addr = selector;
    const key = path && path + '#' + addr;
    const query = parameters(addr, 'render');
    image = '';
    imageError = '';
    if (!path || !key || imageRequest !== key) return;
    const controller = new AbortController();
    let objectUrl: string | undefined;
    void api.response(path + query, { signal: controller.signal }).then(response => response.blob()).then(blob => {
      if (!controller.signal.aborted) image = objectUrl = URL.createObjectURL(blob);
    }).catch(e => { if (!controller.signal.aborted) imageError = describe(e); });
    return () => {
      controller.abort();
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  });
</script>

<section aria-label="Просмотр DWG">
  <label>
    Часть DWG
    <select value={part?.id ?? ''} onchange={(event) => context.setDocumentCad(event.currentTarget.value || undefined)}>
      <option value="">Выберите часть или лист</option>
      {#each units as unit (unit.id)}
        <option value={unit.id}>{unit.label ?? unit.id}</option>
      {/each}
    </select>
  </label>
  <Notice message={error} />
  {#if part}
    {#if !native && !error}<p role="status">Открываем часть DWG…</p>{/if}
    {#if native}
      <p>{native.lines.length} объектов · адреса производной</p>
      {#if native.limitations.length}<p>{native.limitations.map(value => label(value)).join(' · ')}</p>{/if}
      {#if native.lines.length}
        <label>
          Объект DWG
          <select value={selector} onchange={(event) => context.setDocumentCad(part?.id, event.currentTarget.value || undefined)}>
            <option value="">Выберите объект</option>
            {#each native.lines as row (row.id)}
              <option value={address(row)}>{row.details?.entity ?? 'Объект'} · {row.locator.derivativeHandle ?? row.locator.entityOrdinal}{row.text ? ' · ' + row.text : ''}</option>
            {/each}
          </select>
        </label>
      {/if}
      <Notice message={objectError} />
      {#if selected?.lines[0]}
        {@const row = selected.lines[0]}
        <div aria-label="Открытый объект DWG">
          <p>{row.details?.entity ?? 'Объект'} · {row.locator.derivativeHandle ?? row.locator.entityOrdinal}</p>
          {#if row.text}<p>{row.text}</p>{/if}
          {#if row.details?.limitations?.length}<p>{row.details.limitations.map(value => label(value)).join(' · ')}</p>{/if}
        </div>
      {/if}
      <button type="button" onclick={() => { imageRequest = url + '#' + selector; }}>Показать схему</button>
      <Notice message={imageError} />
      {#if image}<img src={image} alt="Схематическое представление DWG" />{/if}
    {/if}
  {/if}
</section>
<style>
  label { display: grid; gap: .25rem; margin-block: .5rem; }
  select { width: min(100%, 48rem); }
  img { display: block; max-width: 100%; max-height: 60dvh; margin-block: .75rem; }
</style>
