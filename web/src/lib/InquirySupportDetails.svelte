<script lang="ts">
  import { supportAddress, supportCitation, type InquirySupport } from './inquiry-supports';
  import type { OpenEvidence } from './workspace';
  import EvidenceButtons from './EvidenceButtons.svelte';

  let { source, open }: { source: InquirySupport; open: OpenEvidence } = $props();
  let address = $derived(supportAddress(source));
</script>

<dl class="details">
  {#if source.label || source.relativePath}<dt>Документ</dt><dd>{source.label ?? source.relativePath}</dd>{/if}
  {#if source.documentRevision?.label}<dt>Редакция документа</dt><dd>{source.documentRevision.label}</dd>{/if}
  <dt>Версия оригинала</dt><dd>{source.versionId}</dd>
  {#if address}<dt>Адрес</dt><dd>{address}</dd>{/if}
  {#if source.format}<dt>Формат</dt><dd>{source.format.toUpperCase()}</dd>{/if}
  {#if source.measurement}<dt>Значение</dt><dd>{source.measurement.value} {source.measurement.unit}</dd>{/if}
</dl>
{#if source.quote}<blockquote>{source.quote}</blockquote>{/if}
<EvidenceButtons citations={[{ ...supportCitation(source), sourceLabel: 'Открыть адрес опоры' }]} {open} />
