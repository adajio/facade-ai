<script lang="ts">
  import { tick } from 'svelte';
  import { denied, describe, endpoint, id, interrupted, type Api, type RecordData } from './http';
  import { V1, type Citation } from './workspace';
  import Notice from './Notice.svelte';

  type Box = { x: number; y: number; width: number; height: number };
  type Transform = { width: number; height: number; pixelsPerPoint: number; pixelOriginX: number; pixelOriginY: number };
  type Evidence = {
    id: string;
    source: { documentId: string; versionId: string; sha256: string; name?: string; relativePath?: string };
    readerVersion?: string;
    branch?: string;
    address: { unitId?: string; page?: number; box?: Box; locator?: Record<string, string | number> };
    transform?: Transform;
    limitations?: string[];
    mediaType?: string;
    contentUrl?: string;
    inputImage?: { transform: Transform; url?: string };
  };
  type Observation = Citation & { scope?: string; box?: Box; limitation?: string; address?: Evidence['address'] };

  let { api, refs, index, select, close, verify }: {
    api: Api; refs: Citation[]; index: number; select: (i: number) => void; close: () => void; verify: () => void;
  } = $props();

  const componentLabel = {
    value: 'Значение', unit: 'Единица', variant: 'Исполнение', revision: 'Редакция',
    identifier: 'Обозначение', relationship: 'Связь источников',
  } as const;
  let parent = $derived(refs[index]);
  let selected = $state<{ citation: Citation; index: number }>();
  let components = $derived(parent?.components ?? []);
  let component = $derived(selected?.citation === parent ? components[selected?.index ?? -1] : undefined);
  let citation: Citation = $derived(component ? {
    evidenceId: component.evidenceId, quote: component.quote, address: component.address,
    ...component.source, branch: parent.branch,
  } satisfies Citation : parent);
  let root: HTMLElement;
  let closeButton: HTMLButtonElement;
  let evidence = $state<Evidence>();
  let observation = $state<Observation>();
  let rows = $state<{ text: string; box?: Box }[]>([]);
  let image = $state('');
  let transform = $state<Transform>();
  let error = $state('');
  let previewError = $state('');
  let pending = $state(true);
  let zoom = $state(100);
  let full = $state(false);
  let viewport = $state<HTMLDivElement>();
  let selectedAddress = $derived(citation?.address as Evidence['address'] | undefined);
  let locator = $derived({ ...evidence?.address.locator, ...selectedAddress?.locator, ...observation?.address?.locator });
  let box = $derived(observation?.box ?? observation?.address?.box ?? selectedAddress?.box ?? evidence?.address?.box);

  $effect(() => {
    const ref = citation;
    if (!ref) return;
    evidence = undefined;
    observation = undefined;
    transform = undefined;
    rows = [];
    image = '';
    error = '';
    previewError = '';
    zoom = 100;
    pending = true;
    const stop = new AbortController();
    const signal = stop.signal;
    let imageUrl = '';
    async function load() {
      const path = V1 + '/evidence/' + id(ref.evidenceId);
      try {
        const meta = await api.json<Evidence>(path, { signal });
        if (ref.versionId && meta.source.versionId !== ref.versionId || ref.sha256 && meta.source.sha256 !== ref.sha256) {
          throw new Error('Открытое место не совпадает с закреплённой версией оригинала.');
        }
        evidence = meta;
        if (ref.observationId) {
          observation = await api.json<Observation>(V1 + '/observations/' + id(ref.observationId), { signal });
        }
        const response = await api.response(meta.contentUrl ?? path + '/content', { signal });
        if (response.headers.get('Content-Type')?.startsWith('image/')) {
          const body = await response.blob();
          signal.throwIfAborted();
          imageUrl = URL.createObjectURL(body);
          image = imageUrl;
          transform = meta.transform;
        } else {
          const result = await response.json() as RecordData;
          signal.throwIfAborted();
          rows = Array.isArray(result) ? result : Array.isArray(result.lines) ? result.lines : [];
          if (meta.inputImage?.url) {
            const raster = await api.response(meta.inputImage.url, { signal }).then((res) => res.blob());
            signal.throwIfAborted();
            imageUrl = URL.createObjectURL(raster);
            image = imageUrl;
            transform = meta.inputImage.transform;
          }
        }
      } catch (problem) {
        if (signal.aborted || interrupted(problem)) return;
        if (denied(problem)) verify();
        if (evidence && !denied(problem)) previewError = describe(problem);
        else {
          evidence = undefined;
          observation = undefined;
          error = describe(problem);
        }
      } finally {
        if (!signal.aborted) pending = false;
      }
    }
    void load();
    return () => {
      stop.abort();
      if (imageUrl) URL.revokeObjectURL(imageUrl);
    };
  });

  $effect(() => {
    void tick().then(() => closeButton?.focus());
  });

  function keyboard(event: KeyboardEvent) {
    if (event.key === 'Escape') {
      event.stopPropagation();
      if (full) full = false;
      else close();
      return;
    }
    if (!root?.contains(event.target as Node) || event.key !== 'Tab' || !(full || matchMedia('(max-width: 1140px)').matches)) return;
    const focusable = Array.from(root.querySelectorAll<HTMLElement>('button:not([disabled]), a[href], [tabindex="0"]'));
    const first = focusable[0];
    const last = focusable.at(-1);
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last?.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first?.focus();
    }
  }

  function selectPlace(next: number) {
    select(next);
    void tick().then(() => {
      if (!root?.contains(document.activeElement)) closeButton?.focus();
    });
  }

  function fitBox() {
    zoom = 200;
    if (!box || !transform) return;
    const coordinates = box;
    const map = transform;
    void tick().then(() => {
      const picture = viewport?.querySelector('img');
      if (!picture) return;
      viewport?.scrollTo({
        left: (coordinates.x * map.pixelsPerPoint - map.pixelOriginX) * picture.width / map.width - 45,
        top: (coordinates.y * map.pixelsPerPoint - map.pixelOriginY) * picture.height / map.height - 45,
      });
      viewport?.focus();
    });
  }

  function percent(value: number, length: number) {
    return 100 * value / length + '%';
  }
</script>

<svelte:window onkeydown={keyboard} />

<aside class:full bind:this={root} class="evidence-panel" aria-labelledby="evidence-title" role="region">
  <div class="card-header">
    <h2 id="evidence-title">Оригинал и основание</h2>
    <button type="button" bind:this={closeButton} onclick={close} aria-label="Закрыть просмотр оригинала">Закрыть</button>
  </div>
  {#if refs.length > 1}
    <div class="actions fragment-nav">
      <button type="button" disabled={index < 1} onclick={() => selectPlace(index - 1)}>Предыдущее место</button>
      <span aria-live="polite">{index + 1} из {refs.length}</span>
      <button type="button" disabled={index >= refs.length - 1} onclick={() => selectPlace(index + 1)}>Следующее место</button>
    </div>
  {/if}
  {#if components.length}
    <div class="actions fragment-nav" aria-label="Компоненты доказательства">
      <button type="button" aria-pressed={!component} onclick={() => selected = undefined}>Основная цитата</button>
      {#each components as part, componentIndex (`${part.evidenceId}:${part.lineId}:${componentIndex}`)}
        <button type="button" aria-pressed={component === part} onclick={() => selected = { citation: parent, index: componentIndex }}>
          {componentLabel[part.role]} · {part.literal}
        </button>
      {/each}
    </div>
  {/if}
  {#if pending}<p role="status">Открываем сохранённый адрес…</p>{/if}
  <Notice kind="error" message={error} />
  {#if evidence}
    <dl class="details">
      {#if evidence.source.name || evidence.source.relativePath}<dt>Файл</dt><dd>{evidence.source.name ?? evidence.source.relativePath}</dd>{/if}
      {#if citation.documentRevision?.label}<dt>Редакция документа</dt><dd>{citation.documentRevision.label}</dd>{/if}
      <dt>Версия оригинала</dt><dd>{evidence.source.versionId}</dd>
      <dt>Ветвь</dt><dd>{observation?.branch ?? evidence.branch ?? '—'}</dd>
      {#if observation?.scope}<dt>Область</dt><dd>{observation.scope}</dd>{/if}
      {#if locator.page || evidence.address.page}
        <dt>Физическая страница</dt><dd>{locator.page ?? evidence.address.page}</dd>
      {:else if evidence.address.unitId}
        <dt>Физическая единица</dt><dd>{evidence.address.unitId}</dd>
      {/if}
      {#each Object.entries(locator).filter(([key]) => key !== 'page') as [key, value] (key)}
        <dt>{({sheet: 'Лист', range: 'Ячейки', cell: 'Ячейка', line: 'Строка', row: 'Строка таблицы', column: 'Столбец', paragraph: 'Абзац', section: 'Раздел', handle: 'Объект', layout: 'Вид'} as Record<string, string>)[key] ?? key}</dt><dd>{value}</dd>
      {/each}
    </dl>
    {#if observation?.quote || citation.quote}<blockquote>{observation?.quote ?? citation.quote}</blockquote>{/if}
    {#if (observation?.value ?? citation.value) != null}
      <p>{observation?.value ?? citation.value} {observation?.unit ?? citation.unit ?? ''}
        {#if (observation?.normalizedValue ?? citation.normalizedValue) != null}
          · Нормализовано {observation?.normalizedValue ?? citation.normalizedValue}
        {/if}
      </p>
    {/if}
    <a class="button" target="_blank" rel="noopener" href={endpoint('/api/documents/' + id(evidence.source.documentId) + '/versions/' + id(evidence.source.versionId) + '/content')}>Открыть оригинал</a>
    <Notice message={observation?.limitation ?? evidence.limitations?.join(' · ') ?? ''} />
    <Notice kind="error" message={previewError} />
    {#if image}
      <div class="actions image-controls">
        <button aria-label="Уменьшить изображение" disabled={zoom <= 50} type="button" onclick={() => zoom -= 25}>−</button>
        <output aria-label="Масштаб">{zoom}%</output>
        <button aria-label="Увеличить изображение" disabled={zoom >= 400} type="button" onclick={() => zoom += 25}>+</button>
        {#if box && transform}<button type="button" onclick={fitBox}>К выделенному месту</button>{/if}
        <button type="button" onclick={() => full = !full}>{full ? 'Свернуть' : 'На весь экран'}</button>
      </div>
      <!-- svelte-ignore a11y_no_noninteractive_tabindex (A scrollable image viewport needs keyboard focus.) -->
      <div bind:this={viewport} class="viewport" tabindex="0" role="region" aria-label="Изображение оригинала. Для прокрутки используйте клавиши со стрелками.">
        <div class="picture" style:width={zoom + '%'}>
          <img src={image} alt="Сохранённое изображение участка оригинала" />
          {#if box && transform}
            <span class="highlight" aria-label="Рамка сохранённого адреса" role="img"
              style:left={percent(box.x * transform.pixelsPerPoint - transform.pixelOriginX, transform.width)}
              style:top={percent(box.y * transform.pixelsPerPoint - transform.pixelOriginY, transform.height)}
              style:width={percent(box.width * transform.pixelsPerPoint, transform.width)}
              style:height={percent(box.height * transform.pixelsPerPoint, transform.height)}></span>
          {/if}
        </div>
      </div>
    {:else if rows.length}
      <details>
        <summary>Текст представления</summary>
        <ul class="plain-list">{#each rows as row}<li>{row.text}</li>{/each}</ul>
      </details>
    {:else if !pending}
      <p class="meta">Доступность изображения для этого адреса ограничена.</p>
    {/if}
  {/if}
</aside>

<style>
  .evidence-panel { position: sticky; top: 1rem; align-self: start; min-width: 0; max-height: calc(100dvh - 2rem); overflow: auto; background: white; border: 1px solid var(--line); border-radius: .66rem; padding: .9rem; }
  .fragment-nav, .image-controls { margin-block: .65rem; }
  .viewport { border: 1px solid var(--line); max-height: 58dvh; overflow: auto; background: var(--field); }
  .picture { position: relative; }
  .picture img { width: 100%; display: block; }
  .highlight { position: absolute; border: 2px solid #9d4800; background: #ffb64b2b; }
  .full { position: fixed; inset: 1rem; z-index: 10; max-height: none; box-shadow: 0 0 0 100vmax #172b3582; }
  @media (max-width: 1140px) {
    .evidence-panel { position: fixed; inset: .5rem; z-index: 10; max-height: none; box-shadow: 0 0 0 100vmax #172b3582; }
  }
</style>
