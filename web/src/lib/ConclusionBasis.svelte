<script lang="ts">
  import { describe, query, type Api } from './http';
  import { originalUrl, renderAddress } from './copilot';
  import { projectV1, scopedUrl, type Assessment, type Citation, type ConclusionInput, type InventoryLimitation, type OpenEvidence } from './workspace';
  import OriginalBasisFields from './OriginalBasisFields.svelte';
  import EvidenceButtons from './EvidenceButtons.svelte';
  import Notice from './Notice.svelte';
  let { api, projectId, assessmentContextId, citations = [], saved, input = $bindable(), edit, open }: {
    api: Api; projectId: string; assessmentContextId?: string; citations?: Citation[]; saved?: Assessment['conclusion'];
    input?: ConclusionInput; edit?: () => void; open: OpenEvidence;
  } = $props();
  let mode = $state('original');
  let versionId = $state(''), anchor = $state(''), evidenceId = $state(''), occurrenceId = $state('');
  let limits = $state<InventoryLimitation[]>([]), next = $state<string | null>(null), problem = $state('');
  let controller = $state<AbortController>();
  async function load(signal: AbortSignal, after?: string) {
    try {
      const page = await api.json<{ items: InventoryLimitation[]; nextCursor: string | null }>(query(projectV1(projectId) + '/inventory-limitations', { after, assessmentContextId }), { signal });
      if (!signal.aborted) { limits = after ? [...limits, ...page.items] : page.items; next = page.nextCursor; problem = ''; }
    } catch (e) { if (!signal.aborted) problem = describe(e); }
  }
  $effect(() => {
    if (mode !== 'inventory' || !edit) return;
    const stop = new AbortController();
    controller = stop;
    void load(stop.signal);
    return () => stop.abort();
  });
  $effect(() => {
    if (!edit) return;
    const row = limits.find((item) => item.occurrenceId === occurrenceId);
    if (mode === 'original') input = versionId && anchor.trim() ? { kind: 'original', versionId, anchor: anchor.trim() } : undefined;
    else if (mode === 'citation') input = evidenceId ? { kind: 'citation', evidenceId } : undefined;
    else input = row ? { kind: 'inventory', occurrenceId, inventoryRevision: row.inventoryRevision } : undefined;
  });
</script>

{#if saved?.basis}
  {@const basis = saved.basis}
  {#if basis.kind === 'citation'}<EvidenceButtons citations={[basis.citation]} {open} />
  {:else if basis.kind === 'original'}<a href={originalUrl(basis.original.documentId, basis.original.versionId, basis.original.address.locator?.page)} target="_blank" rel="noopener noreferrer">{basis.original.label} · {renderAddress(basis.original.address)}</a>
  {:else}<p>Опись №{basis.number} · {basis.label} · {basis.restriction} · версия {basis.inventoryRevision}</p>
    <a href={scopedUrl(projectId, 'receipts', {}, basis.receiptId)}>Открыть поступление</a>{/if}
{/if}
{#if edit}
  <label>Основание заключения по материалам
    <select bind:value={mode} onchange={edit}><option value="original">Место в принятом оригинале</option>
      {#if citations.length}<option value="citation">Источник проверенного требования</option>{/if}
      <option value="inventory">Ограничение в описи</option>
    </select>
  </label>
  {#if mode === 'original'}<OriginalBasisFields {api} {projectId} {assessmentContextId} bind:versionId bind:anchor {edit} />
  {:else if mode === 'citation'}<label>Источник<select bind:value={evidenceId} required onchange={edit}>
    <option value="">Выберите место</option>
    {#each citations as item}<option value={item.evidenceId}>{item.label ?? item.sourceLabel} · {item.quote}</option>{/each}
  </select></label>
  {:else}<Notice message={problem} /><label>Строка описи<select required bind:value={occurrenceId} onchange={edit}>
    <option value="">Выберите ограничение</option>
    {#each limits as item}<option value={item.occurrenceId}>Опись №{item.number} · {item.label} · {item.restriction}</option>{/each}
  </select></label>{#if next && controller}<button type="button" onclick={() => load(controller!.signal, next!)}>Ещё строки описи</button>{/if}{/if}
{/if}
