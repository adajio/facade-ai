<script lang="ts">
  import CadDocument from '../screens/CadDocument.svelte';
  import { describe, id, type Api } from './http';
  import { V1 } from './workspace';
  import type { CadAddress, ReaderMap } from './cad';
  import Notice from './Notice.svelte';

  let { api, projectId, documentId, versionId, sha256, readerVersion, address }: {
    api: Api; projectId: string; documentId: string; versionId: string;
    sha256?: string; readerVersion?: string; address: CadAddress;
  } = $props();

  let expanded = $state(false);
  let map = $state<ReaderMap>();
  let error = $state('');
  let partId = $state<string>();
  let entity = $state<string>();
  const endpoint = $derived(V1 + '/documents/' + id(documentId) + '/versions/' + id(versionId) + '/reader/units');

  $effect(() => {
    const path = endpoint;
    const expected = { projectId, documentId, versionId, sha256, readerVersion, ...address };
    map = undefined;
    error = '';
    partId = expected.part;
    entity = expected.entity;
    if (!expanded) return;
    const stop = new AbortController();
    const signal = AbortSignal.any([stop.signal, AbortSignal.timeout(8000)]);
    void api.json<ReaderMap>(path, { signal }).then(value => {
      const unit = value.units.find(({ id }) => id === expected.part);
      if (value.format !== 'dwg' || !unit?.locator?.partSha256 ||
          value.source.projectId !== expected.projectId || value.source.documentId !== expected.documentId ||
          value.source.versionId !== expected.versionId || (expected.sha256 && value.source.sha256 !== expected.sha256) ||
          (expected.readerVersion && value.readerVersion !== expected.readerVersion) ||
          (expected.partSha256 && unit.locator.partSha256 !== expected.partSha256) ||
          (expected.derivativeSha256 && unit.locator.derivativeSha256 !== expected.derivativeSha256)) {
        error = 'Закреплённый адрес недоступен в текущей карте DWG.';
        return;
      }
      map = value;
    }).catch(problem => { if (!stop.signal.aborted) error = describe(problem); });
    return () => stop.abort();
  });
</script>

<details bind:open={expanded}>
  <summary>{address.entity ? 'Открыть объект DWG' : 'Открыть часть DWG'}</summary>
  {#if expanded}
    <Notice message={error} />
    {#if map}
      <CadDocument {api} {endpoint} units={map.units} readerVersion={map.readerVersion} {partId} {entity}
        select={(part, selected) => { partId = part; entity = selected; }} />
    {:else if !error}
      <p role="status">Проверяем адрес в карте DWG…</p>
    {/if}
  {/if}
</details>
