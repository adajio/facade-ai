<script lang="ts">
  import { describe, type Api } from '../lib/http';
  import { label } from '../lib/format';
  import { cadEntity, type CadUnit } from '../lib/cad';
  import Notice from '../lib/Notice.svelte';

  type Font = { name: string; sha256?: string };
  type Row = { id: string; text: string; locator: { derivativeHandle?: string; entityOrdinal?: number };
    details?: { entity?: string; entityOrdinal?: number; limitations?: string[]; fonts?: Font[] } };
  type Native = { lines: Row[]; limitations: string[]; derivativeSha256?: string };
  let { api, units, readerVersion, endpoint, partId, entity, select }: {
    api: Api; units: CadUnit[]; readerVersion: string; endpoint: string;
    partId?: string | null; entity?: string | null; select: (part?: string, entity?: string) => void;
  } = $props();

  const part = $derived(units.find(unit => unit.id === partId));
  const selector = $derived(entity ?? '');
  const url = $derived(part ? endpoint + '/' + encodeURIComponent(part.id) : undefined);
  let native = $state<Native>();
  let selected = $state<Native>();
  let error = $state('');
  let objectError = $state('');
  let image = $state('');
  let imageError = $state('');
  let imageRequest = $state<{ key: string; textFont?: string }>();

  function show(textFont?: string) {
    if (url) imageRequest = { key: url + '?' + readerVersion + '#' + selector, textFont };
  }

  function parameters(address: string, representation: 'native' | 'render', textFont?: string) {
    const query = new URLSearchParams({ readerVersion, representation });
    if (address.startsWith('h:')) query.set('derivativeHandle', address.slice(2));
    if (address.startsWith('o:')) query.set('entityOrdinal', address.slice(2));
    if (textFont) query.set('textFont', textFont);
    return '?' + query.toString();
  }

  function address(row: Row) {
    return cadEntity({ entityOrdinal: row.details?.entityOrdinal, ...row.locator }) ?? '';
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
    const key = path && path + '?' + readerVersion + '#' + addr;
    const query = parameters(addr, 'render', imageRequest?.textFont);
    image = '';
    imageError = '';
    if (!path || !key || imageRequest?.key !== key) return;
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
    <select value={part?.id ?? ''} onchange={(event) => select(event.currentTarget.value || undefined)}>
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
          <select value={selector} onchange={(event) => select(part?.id, event.currentTarget.value || undefined)}>
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
          {#each row.details?.fonts?.filter(font => font.sha256) ?? [] as font (font.name)}
            <button type="button" title={font.sha256} onclick={() => show(font.sha256)}>Приблизить подпись · {font.name}</button>
          {/each}
          {#if row.details?.limitations?.length}<p>{row.details.limitations.map(value => label(value)).join(' · ')}</p>{/if}
        </div>
      {/if}
      <button type="button" onclick={() => show()}>Показать схему</button>
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
