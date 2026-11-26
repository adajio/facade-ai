<script lang="ts">
  import { tick } from 'svelte';
  import { denied, describe, id, interrupted, type Api, type RecordData } from './http';
  import { approvalEvidence, V1, type Citation } from './workspace';
  import Notice from './Notice.svelte';
  import CadEvidence from './CadEvidence.svelte';
  import { cadAddress } from './cad';
  import { pageCache } from './page-cache';

  type Box = { x: number; y: number; width: number; height: number };
  type Transform = { width: number; height: number; pixelsPerPoint: number; pixelOriginX: number; pixelOriginY: number };
  type Evidence = {
    id: string;
    source: { projectId: string; documentId: string; versionId: string; sha256: string; name?: string; relativePath?: string };
    readerVersion?: string;
    branch?: string;
    address: { unitId?: string; page?: number; box?: Box; locator?: Record<string, string | number> };
    transform?: Transform;
    limitations?: string[];
    mediaType?: string;
    inputImage?: { transform: Transform };
  };
  type EvidenceLine = { id?: string; text: string; box?: Box; locator?: Record<string, string | number> };
  type Observation = Citation & { scope?: string; box?: Box; limitation?: string; address?: Evidence['address'] };

  let { api, projectId, refs, index, componentIndex, select, selectComponent, openLine, close, verify, embedded = false, slotLabel }: {
    api: Api; projectId: string; refs: Citation[]; index: number; select: (i: number) => void; close: () => void; verify: () => void;
    componentIndex?: number; selectComponent: (index?: number) => void;
    openLine?: (ref: Citation, trigger: HTMLElement) => void;
    embedded?: boolean; slotLabel?: string;
  } = $props();

  const componentLabel = {
    value: 'Значение', unit: 'Единица', variant: 'Исполнение', revision: 'Редакция',
    identifier: 'Обозначение', relationship: 'Связь источников',
  } as const;
  let parent = $derived(refs[index]);
  let loadedObservation = $state<{ id: string; evidenceId: string; observation: Observation }>();
  let parentObservation = $derived(loadedObservation?.id === parent?.observationId &&
    loadedObservation?.evidenceId === parent?.evidenceId ? loadedObservation?.observation : undefined);
  let components = $derived(parent?.components ?? parentObservation?.components ?? []);
  let component = $derived(components[componentIndex ?? -1]);
  let observation = $derived(component ? undefined : parentObservation);
  let citation: Citation = $derived(component ? {
    evidenceId: component.evidenceId, quote: component.quote, address: component.address,
    ...component.source, branch: parent.branch,
  } satisfies Citation : parent);
  let root: HTMLElement;
  let closeButton = $state<HTMLButtonElement>();
  let evidence = $state<Evidence>();
  let rows = $state<EvidenceLine[]>([]);
  let approval = $derived(approvalEvidence(parent));
  let addressedLine = $derived.by(() => {
    if (!citation?.lineId) return;
    const sameId = rows.filter(({ id }) => id === citation.lineId);
    return sameId.length === 1 ? sameId[0] : undefined;
  });
  let image = $state('');
  let transform = $state<Transform>();
  let error = $state('');
  let previewError = $state('');
  let fullOriginal = $state('');
  let pending = $state(true);
  let zoom = $state(100);
  let full = $state(false);
  const headingId = $props.id();
  let viewport = $state<HTMLDivElement>();
  let selectedAddress = $derived(citation?.address as Evidence['address'] | undefined);
  let locator = $derived({ ...evidence?.address.locator, ...selectedAddress?.locator, ...observation?.address?.locator, ...addressedLine?.locator });
  let cad = $derived.by(() => {
    const address = evidence?.address;
    if (!address?.unitId) return;
    return cadAddress(address.unitId, {
      ...address.locator,
      ...(selectedAddress?.unitId === address.unitId ? selectedAddress.locator : undefined),
      ...(observation?.address?.unitId === address.unitId ? observation.address.locator : undefined),
    });
  });
  let box = $derived.by(() => {
    const placed = citation?.lineId ? addressedLine?.box ?? selectedAddress?.box :
      observation?.box ?? observation?.address?.box ?? selectedAddress?.box ?? evidence?.address?.box;
    return placed && [placed.x, placed.y, placed.width, placed.height].every(Number.isFinite) &&
      placed.width > 0 && placed.height > 0 ? placed : undefined;
  });

  $effect(() => {
    const ref = parent;
    if (!ref?.observationId) return;
    const key = ref.observationId;
    const stop = new AbortController();
    void api.json<Observation>(V1 + '/observations/' + id(key), { signal: stop.signal }).then((value) => {
      if (!stop.signal.aborted && value.evidenceId === ref.evidenceId) {
        loadedObservation = { id: key, evidenceId: ref.evidenceId, observation: value };
      }
    }).catch((problem) => {
      if (!stop.signal.aborted && denied(problem)) verify();
    });
    return () => stop.abort();
  });

  $effect(() => {
    const ref = citation;
    if (!ref) return;
    evidence = undefined;
    transform = undefined;
    rows = [];
    image = '';
    error = '';
    previewError = '';
    fullOriginal = '';
    zoom = 100;
    pending = true;
    const stop = new AbortController();
    const signal = stop.signal;
    const generation = pageCache.generation;
    let transient: string | undefined;
    function showImage(blob: Blob, key: string) {
      image = pageCache.add(key, blob, generation) ?? (transient = pageCache.temporary(blob, generation)) ?? '';
    }
    async function load() {
      const path = V1 + '/evidence/' + id(ref.evidenceId);
      try {
        const meta = await api.json<Evidence>(path, { signal });
        if (meta.id !== ref.evidenceId || meta.source.projectId !== projectId ||
            ref.documentId && meta.source.documentId !== ref.documentId ||
            ref.versionId && meta.source.versionId !== ref.versionId || ref.sha256 && meta.source.sha256 !== ref.sha256) {
          error = 'Открытое место не совпадает с закреплённой версией оригинала.';
          return;
        }
        evidence = meta;
        const imageKey = [projectId, meta.id, meta.source.versionId, meta.source.sha256].join('/');
        const cached = generation === pageCache.generation ? pageCache.get(imageKey) : undefined;
        if (cached) {
          image = cached;
          transform = meta.mediaType?.startsWith('image/') ? meta.transform : meta.inputImage?.transform;
        }
        const original = '/api/documents/' + id(meta.source.documentId) + '/versions/' + id(meta.source.versionId) + '/content';
        void api.response(original, { method: 'HEAD', signal }).then((response) => {
          if (!signal.aborted && response.headers.get('ETag') === '"sha256-' + meta.source.sha256 + '"') {
            const page = meta.address.locator?.page ?? meta.address.page;
            fullOriginal = original + (typeof page === 'number' && Number.isSafeInteger(page) && page > 0 &&
              response.headers.get('Content-Type')?.startsWith('application/pdf') ? '#page=' + page : '');
          }
        }).catch(() => { /* Full-source access is independent of the addressed fragment. */ });
        if (cached && !ref.lineId) return;
        const response = await api.response(path + '/content', { signal });
        if (/^image\/(png|jpeg|webp)(?:;|$)/u.test(response.headers.get('Content-Type') ?? '')) {
          const body = await response.blob();
          signal.throwIfAborted();
          if (generation !== pageCache.generation) return;
          showImage(body, imageKey);
          transform = meta.transform;
        } else {
          const result = await response.json() as RecordData;
          signal.throwIfAborted();
          rows = Array.isArray(result) ? result : Array.isArray(result.lines) ? result.lines : [];
          if (meta.inputImage && !cached) {
            const raster = await api.response(path + '/ocr-input', { signal }).then((res) => res.blob());
            signal.throwIfAborted();
            if (generation !== pageCache.generation) return;
            showImage(raster, imageKey);
            transform = meta.inputImage.transform;
          }
        }
      } catch (problem) {
        if (signal.aborted || interrupted(problem)) return;
        if (denied(problem)) verify();
        if (evidence && !denied(problem)) previewError = describe(problem);
        else {
          evidence = undefined;
          error = describe(problem);
        }
      } finally {
        if (!signal.aborted) pending = false;
      }
    }
    void load();
    return () => {
      stop.abort();
      if (transient) pageCache.release(transient);
    };
  });

  $effect(() => {
    if (!embedded) void tick().then(() => closeButton?.focus({ preventScroll: true }));
  });

  function keyboard(event: KeyboardEvent) {
    if (embedded || event.defaultPrevented) return;
    if (event.key === 'Escape') {
      event.preventDefault();
      if (full) full = false;
      else close();
      return;
    }
    if (!root?.contains(event.target as Node) || event.key !== 'Tab' || !(full || matchMedia('(max-width: 850px)').matches)) return;
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

<aside class:full class:embedded bind:this={root} class="evidence-panel" aria-labelledby={headingId} role="region">
  <div class="card-header">
    <h2 id={headingId}>{slotLabel ?? 'Оригинал и основание'}</h2>
    {#if !embedded}<button type="button" bind:this={closeButton} onclick={close} aria-label="Закрыть просмотр оригинала">Закрыть</button>{/if}
  </div>
  {#if !embedded && citation?.value != null}
    <p class="mobile-context numeric">{citation.value} {citation.unit ?? ''}{#if locator.page || evidence?.address.page} · с. {locator.page ?? evidence?.address.page}{/if}</p>
  {/if}
  {#if refs.length > 1}
    <div class="actions fragment-nav">
      <button type="button" disabled={index < 1} onclick={() => selectPlace(index - 1)}>Предыдущее место</button>
      <span aria-live="polite">{index + 1} из {refs.length}</span>
      <button type="button" disabled={index >= refs.length - 1} onclick={() => selectPlace(index + 1)}>Следующее место</button>
    </div>
  {/if}
  {#if components.length}
    <div class="actions fragment-nav" aria-label="Компоненты доказательства">
      <button type="button" aria-pressed={!component} onclick={() => selectComponent()}>Основная цитата</button>
      {#each components as part, partIndex (`${part.evidenceId}:${part.lineId}:${partIndex}`)}
        <button type="button" aria-pressed={component === part} onclick={() => selectComponent(partIndex)}>
          {componentLabel[part.role]} · {part.literal}
        </button>
      {/each}
    </div>
  {/if}
  {#if approval && openLine}
    <div class="actions">
      <button type="button" onclick={(event) => openLine?.(approval!, event.currentTarget)}>Открыть строку подписи</button>
    </div>
  {/if}
  {#if pending}<p role="status">Открываем сохранённый адрес…</p>{/if}
  <Notice kind="error" message={error} />
  {#if evidence && citation.lineId && !addressedLine}
    {#if !pending}<p class="meta">Закреплённая строка недоступна в этом фрагменте.</p>{/if}
  {:else if evidence}
    {#snippet sourceDetails(meta: Evidence)}
    <dl class="details">
      {#if meta.source.name || meta.source.relativePath}<dt>Файл</dt><dd>{meta.source.name ?? meta.source.relativePath}</dd>{/if}
      {#if citation.documentRevision?.label}<dt>Редакция документа</dt><dd>{citation.documentRevision.label}</dd>{/if}
      <dt>Версия оригинала</dt><dd class="numeric">{meta.source.versionId}</dd>
      <dt>Ветвь</dt><dd>{observation?.branch ?? meta.branch ?? '—'}</dd>
      {#if citation.lineId && !locator.line}<dt>Строка оригинала</dt><dd>{citation.lineId}</dd>{/if}
      {#if observation?.scope}<dt>Область</dt><dd>{observation.scope}</dd>{/if}
      {#if locator.page || meta.address.page}
        <dt>Физическая страница</dt><dd>{locator.page ?? meta.address.page}</dd>
      {:else if meta.address.unitId}
        <dt>Физическая единица</dt><dd>{meta.address.unitId}</dd>
      {/if}
      {#each Object.entries(locator).filter(([key]) => key !== 'page') as [key, value] (key)}
        <dt>{({sheet: 'Лист', range: 'Ячейки', cell: 'Ячейка', line: 'Строка', row: 'Строка таблицы', column: 'Столбец', paragraph: 'Абзац', section: 'Раздел', handle: 'Объект', layout: 'Вид'} as Record<string, string>)[key] ?? key}</dt><dd>{value}</dd>
      {/each}
    </dl>
    {#if addressedLine}<blockquote>{addressedLine.text}</blockquote>
    {:else if observation?.quote || citation.quote}<blockquote>{observation?.quote ?? citation.quote}</blockquote>{/if}
    {#if (observation?.value ?? citation.value) != null}
      <p class="numeric">{observation?.value ?? citation.value} {observation?.unit ?? citation.unit ?? ''}
        {#if (observation?.normalizedValue ?? citation.normalizedValue) != null}
          · Нормализовано {observation?.normalizedValue ?? citation.normalizedValue}
        {/if}
      </p>
    {/if}
    {/snippet}
    {#if embedded}
      <div class="actions embedded-tools">
        <details><summary>Адрес и редакция</summary>{@render sourceDetails(evidence)}</details>
        {#if fullOriginal}<a class="button quiet" target="_blank" rel="noopener" href={fullOriginal}>Открыть оригинал</a>{/if}
      </div>
    {:else}
      {@render sourceDetails(evidence)}
      {#if fullOriginal}<a class="button" target="_blank" rel="noopener" href={fullOriginal}>Открыть оригинал</a>{/if}
    {/if}
    {#if cad}
      {#key evidence.id}
        <CadEvidence {api} {projectId} documentId={evidence.source.documentId} versionId={evidence.source.versionId}
          sha256={evidence.source.sha256} readerVersion={evidence.readerVersion} address={cad} />
      {/key}
    {/if}
    <Notice message={observation?.limitation ?? evidence.limitations?.join(' · ') ?? ''} />
    <Notice kind="error" message={previewError} />
    {#if image}
      <div class="actions image-controls">
        <button aria-label="Уменьшить изображение" disabled={zoom <= 50} type="button" onclick={() => zoom -= 25}>−</button>
        <output aria-label="Масштаб">{zoom}%</output>
        <button aria-label="Увеличить изображение" disabled={zoom >= 400} type="button" onclick={() => zoom += 25}>+</button>
        {#if box && transform}<button type="button" onclick={fitBox}>К выделенному месту</button>{/if}
        {#if !embedded}<button type="button" onclick={() => full = !full}>{full ? 'Свернуть' : 'На весь экран'}</button>{/if}
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
        <details open={embedded || Boolean(citation.lineId)}>
        <summary>Текст представления</summary>
        <ul class="plain-list">{#each rows as row}<li>{#if row === addressedLine}<mark>{row.text}</mark>{:else}{row.text}{/if}</li>{/each}</ul>
      </details>
    {:else if !pending}
      <p class="meta">Доступность изображения для этого адреса ограничена.</p>
    {/if}
  {/if}
</aside>

<style>
  .evidence-panel { min-width: 0; max-height: calc(100dvh - 76px); overflow: auto; background: var(--surface);
    border: 1px solid var(--line); border-radius: .5rem; padding: .8rem; }
  .fragment-nav, .image-controls { margin-block: .65rem; }
  .viewport { border: 1px solid var(--line); max-height: calc(100dvh - 180px); overflow: auto; background: var(--field); }
  .picture { position: relative; }
  .picture img { width: 100%; display: block; }
  .highlight { position: absolute; border: 2px solid var(--warn); background: #ffb64b2b; pointer-events: none; }
  .full { position: fixed; inset: 12px; z-index: 10; max-height: none; box-shadow: 0 0 0 100vmax #172b3582; }
  .embedded { position: static; max-height: none; box-shadow: none; }
  .embedded .viewport { max-height: min(32dvh, calc(100dvh - 180px)); }
  .embedded-tools { align-items: baseline; }
  .embedded-tools details[open] { flex: 1 0 100%; }
  .mobile-context { display: none; }
  @media (min-width: 851px) and (max-width: 1140px) {
    .evidence-panel:not(.full):not(.embedded) { max-height: 60dvh; }
  }
  @media (max-width: 850px) {
    .evidence-panel:not(.embedded) { position: fixed; inset: 0; z-index: 10; max-height: none; border-radius: 0; }
    .evidence-panel:not(.embedded) > .card-header { position: sticky; top: 0; z-index: 1; background: var(--surface); }
    .mobile-context { display: block; padding-block: 6px; border-block: 1px solid var(--line); }
  }
</style>
