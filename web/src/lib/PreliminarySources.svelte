<script lang="ts">
  import { preliminarySourcePlace, preliminarySourceUrl, type PreliminarySource } from './preliminary-review';

  let { sources, label }: { sources: PreliminarySource[]; label?: string } = $props();

  const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/u;
  const sha256 = /^[a-f0-9]{64}$/u;
  const validId = (id: string) => typeof id === 'string' && id.length === 36 && uuid.test(id);
  const previewStates = new Map([
    ['observed', 'Наблюдение на фрагменте'],
    ['inconclusive', 'Требуется уточнение'],
    ['unreadable', 'Недостаточная читаемость'],
  ]);

  function drawingUnit(source: PreliminarySource) {
    if (!validId(source.documentId) || !validId(source.versionId)) return;
    try {
      const anchor = JSON.parse(source.anchor);
      if (anchor.drawingText?.origin !== 'dwg_native_geometry' || anchor.evidenceMode !== 'literal' ||
          typeof anchor.readerVersion !== 'string' || typeof anchor.unitId !== 'string') return;
      const query = new URLSearchParams({readerVersion:anchor.readerVersion, representation:'render'});
      return `/api/v1/documents/${source.documentId}/versions/${source.versionId}/reader/units/${encodeURIComponent(anchor.unitId)}?${query}`;
    } catch { return; }
  }

  function sheetPreview(source: PreliminarySource) {
    if (!validId(source.documentId) || !validId(source.versionId)) return;
    try {
      const preview = JSON.parse(source.anchor)?.sheetPreview;
      const state = previewStates.get(preview?.state);
      if (!state || typeof preview.sha256 !== 'string' || preview.sha256.length !== 64 || !sha256.test(preview.sha256)
        || typeof preview.title !== 'string' || !preview.title.trim()
        || typeof preview.observation !== 'string') return;
      return {
        href: `/api/v1/documents/${source.documentId}/versions/${source.versionId}/sheet-previews/${preview.sha256}`,
        state, title: preview.title, observation: preview.observation,
      };
    } catch {
      // Earlier reviews also contain plain-text addresses.
    }
  }
</script>

<ul aria-label={label}>
  {#each sources as source}
    {@const preview = sheetPreview(source)}
    {@const unit = drawingUnit(source)}
    <li>
      <a href={preliminarySourceUrl(source)} target="_blank" rel="noopener noreferrer">{source.label}</a>
      · {preliminarySourcePlace(source).label}
      {#if unit}<p class="meta"><a href={unit} target="_blank" rel="noopener noreferrer">Открыть участок чертежа</a></p>{/if}
      {#if source.quote?.trim()}<blockquote>{source.quote}</blockquote>{/if}
      {#if preview}
        <p class="meta">
          <a href={preview.href} target="_blank" rel="noopener noreferrer">Открыть фрагмент листа · {preview.title}</a>
          · {preview.state}
        </p>
        {#if preview.observation.trim()}<p>{preview.observation}</p>{/if}
      {/if}
      {#if source.limitation?.trim()}<p class="meta"><strong>Ограничение</strong> · {source.limitation}</p>{/if}
    </li>
  {/each}
</ul>

<style>
  ul { margin-block: .35rem; padding-inline-start: 1.25rem; overflow-wrap: anywhere; }
  li + li { margin-block-start: .35rem; }
  p { margin: .2rem 0; }
</style>
