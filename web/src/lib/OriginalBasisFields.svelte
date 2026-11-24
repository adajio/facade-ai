<script lang="ts">
  import { describe, query, type Api } from './http';
  import { originalUrl } from './copilot';
  import { projectV1 } from './workspace';
  import Notice from './Notice.svelte';

  type Original = { id: string; documentId: string; label: string; mediaType: string };
  type Page = { originals: Original[]; nextCursor: string | null; kinds?: string[] };
  let { api, projectId, versionId = $bindable(), anchor = $bindable(), kinds = $bindable([]), edit }: {
    api: Api; projectId: string; versionId: string; anchor: string; kinds?: string[]; edit: () => void;
  } = $props();
  let originals = $state<Original[]>([]);
  let nextCursor = $state<string | null>(null);
  let problem = $state('');
  let loading = $state(false);
  let selected = $derived(originals.find((item) => item.id === versionId));
  let isPdf = $derived(selected?.mediaType === 'application/pdf');
  let supported = $derived(isPdf || selected?.mediaType === 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');

  async function load(signal: AbortSignal, after?: string) {
    loading = true;
    problem = '';
    try {
      const result = await api.json<Page>(query(projectV1(projectId) + '/confirmation-originals', { after }), { signal });
      if (signal.aborted) return;
      originals = after ? [...originals, ...result.originals] : result.originals;
      nextCursor = result.nextCursor;
      if (result.kinds) kinds = result.kinds;
    } catch (error) {
      if (!signal.aborted) problem = describe(error);
    } finally {
      if (!signal.aborted) loading = false;
    }
  }

  let requests = $state<AbortController>();
  $effect(() => {
    void projectId;
    const stop = new AbortController();
    requests = stop;
    void load(stop.signal);
    return () => stop.abort();
  });
</script>

<Notice kind="error" message={problem} />
<div class="form-row">
  <label>Документ-основание
    <select bind:value={versionId} required onchange={() => { anchor = ''; edit(); }}>
      <option value="">{loading ? 'Загружаем оригиналы…' : 'Выберите принятый оригинал'}</option>
      {#each originals as item (item.id)}<option value={item.id}>{item.label}</option>{/each}
    </select>
  </label>
  <label>{isPdf ? 'Физическая страница PDF' : 'Страница / лист / ячейка'}
    <input required maxlength="200" disabled={!supported} inputmode={isPdf ? 'numeric' : 'text'}
      pattern={isPdf ? '[1-9][0-9]{0,6}' : '.+![A-Za-z]{1,3}[1-9][0-9]{0,6}'}
      placeholder={isPdf ? '1' : 'Имя листа!I3'} bind:value={anchor} oninput={edit} />
  </label>
</div>
{#if selected}
  <a class="button quiet" href={originalUrl(selected.documentId, selected.id, isPdf ? Number(anchor) : undefined)}
    target="_blank" rel="noopener noreferrer">Открыть оригинал</a>
  {#if !supported}<p class="meta">Адресное подтверждение доступно для PDF и XLSX.</p>{/if}
{/if}
{#if nextCursor && requests}
  <button type="button" class="quiet" disabled={loading} onclick={() => load(requests!.signal, nextCursor!)}>Ещё оригиналы</button>
{:else if !originals.length && !loading && !problem}
  <p class="meta">В проекте пока нет принятых оригиналов.</p>
{/if}
