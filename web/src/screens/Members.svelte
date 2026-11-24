<script lang="ts">
  import OriginalBasisFields from '../lib/OriginalBasisFields.svelte';
  import { originalUrl, renderAddress } from '../lib/copilot';
  import { copy } from '../lib/copy';
  import { onMount } from 'svelte';
  import { Commands } from '../lib/commands';
  import { conflictMessage, conflictVersion } from '../lib/conflict';
  import { type Catalog, type Project } from '../lib/contracts';
  import { describe, id, query, type Api } from '../lib/http';
  import { date, label } from '../lib/format';
  import { projectApi, scopedUrl } from '../lib/workspace';
  import Notice from '../lib/Notice.svelte';
  import ProjectProposals from '../lib/ProjectProposals.svelte';

  type Member = { userId: string; login: string; role: string; expiresAt?: string; scopeId?: string; reason?: string };
  type Page = { members: Member[]; version: number; nextCursor?: string | null };
  type CatalogPage = { catalogs: Catalog[]; reason: string; nextCursor: string | null; version: number };
  const catalogReasons: Record<string, string> = {
    stage_unknown: 'Подтвердите стадию проекта.',
    facades_unconfirmed: 'Ожидается подтверждение типов фасадов.',
    no_approved_profile: 'Для установленной стадии и типов фасадов пока нет утверждённого профиля.',
    multiple_profiles: 'Подходит несколько утверждённых версий. Уточните исходные сведения или выберите версию.',
  };
  let { api, project, refresh }: { api: Api; project: Project; refresh: () => Promise<void> } = $props();
  const commands = new Commands(() => api);
  let base = $derived(projectApi(project.id));
  let members = $state<Member[]>([]);
  let catalogs = $state<Catalog[]>([]);
  let catalogReason = $state('');
  let catalogCursor = $state<string | null>(null);
  let catalogVersion = $state<number>();
  let version = $state<number>();
  let cursor = $state<string | null>(null);
  let userId = $state('');
  let role = $state('engineer');
  let expiresAt = $state('');
  let temporaryScope = $state('');
  let reason = $state('');
  let catalogVersionId = $state('');
  let stage = $state('');
  let stageReason = $state('');
  let stageOriginal = $state('');
  let stageAnchor = $state('');
  let stageVersion = $state<number>();
  let stageMode = $state<'machine' | 'manual'>();
  let stageOptions = $state<boolean>();
  let currentStageMode = $derived(stageMode ?? (stageOptions === false ? 'manual' : 'machine'));
  const editStage = () => { stageVersion ??= version; };
  let busy = $state(false);
  let error = $state('');
  let status = $state('');

  async function load(next?: string) {
    try {
      const page = await api.json<Page>(query(base + '/members', { cursor: next }));
      if (next && page.version !== version) {
        members = page.members;
        await load();
        return;
      }
      members = next ? [...members, ...page.members] : page.members;
      cursor = page.nextCursor ?? null;
      version = page.version;
    } catch (problem) {
      error = describe(problem);
    }
  }

  async function loadCatalogOptions(next?: string) {
    try {
      const page = await api.json<CatalogPage>(query(base + '/catalog-options', { cursor: next }));
      if (next && page.version !== catalogVersion) return await loadCatalogOptions();
      catalogs = next ? [...catalogs, ...page.catalogs] : page.catalogs;
      if (!next) {
        catalogReason = page.reason;
        catalogVersion = page.version;
        catalogVersionId = '';
      }
      catalogCursor = page.nextCursor;
    } catch (problem) {
      error = describe(problem);
    }
  }

  async function reload() {
    await Promise.all([load(), loadCatalogOptions()]);
  }

  onMount(() => {
    stage = project.stage ?? '';
    void reload();
  });

  async function modify(path: string, method: string, body: unknown, message: string, expected = version) {
    if (busy || expected == null) return;
    error = '';
    status = '';
    busy = true;
    try {
      await commands.send(base + path, method, body, expected);
      status = message;
      await Promise.all([refresh(), reload()]);
      if (path === '/stage') {
        stageReason = '';
        stageOriginal = '';
        stageAnchor = '';
        stageVersion = undefined;
      }
    } catch (problem) {
      error = conflictMessage(problem, expected);
      if (conflictVersion(problem, expected)) await Promise.all([refresh(), reload()]);
    } finally {
      busy = false;
    }
  }
</script>

<section class="card table-card">
  <div class="card-header"><h2>Доступ к проекту</h2><button type="button" onclick={() => reload()} disabled={busy}>Обновить назначения</button></div>
  {#if members.length}
    <div class="table-wrap">
      <table>
        <thead><tr><th>Логин</th><th>Роль</th><th>Доступ до</th><th>Действие</th></tr></thead>
        <tbody>{#each members as member (member.userId)}
          <tr><td>{member.login}</td><td>{label(member.role)}</td><td>{date(member.expiresAt)}</td>
            <td>{#if member.role !== 'project_manager'}<button type="button" disabled={busy}
              onclick={() => modify('/members/' + id(member.userId), 'DELETE', undefined, 'Доступ отозван.')}
              aria-label={'Отозвать доступ ' + member.login}>Отозвать</button>{/if}</td></tr>
        {/each}</tbody>
      </table>
    </div>
    {#if cursor}<div class="card-header"><button type="button" onclick={() => load(cursor ?? undefined)}>Ещё участники</button></div>{/if}
  {:else}<p class="empty">Назначения пока не загружены.</p>{/if}
</section>

<Notice kind="error" message={error} />
<Notice kind="success" message={status} />
<div class="split">
  <section class="card">
    <h2>Назначить участника</h2>
    <form onsubmit={(event) => {
      event.preventDefault();
      void modify('/members/' + id(userId.trim()), 'PUT', {
        role, scopeId: temporaryScope || undefined,
        expiresAt: expiresAt ? new Date(expiresAt).toISOString() : undefined, reason: reason || undefined,
      }, 'Назначение сохранено.');
    }}>
      <label>ID учётной записи<input required bind:value={userId} /></label>
      <label>Роль<select bind:value={role}><option value="engineer">Инженер</option><option value="viewer">Просматривающий</option></select></label>
      {#if role === 'viewer'}
        <label>Временный доступ до<input type="datetime-local" bind:value={expiresAt} /></label>
        {#if expiresAt}
          <label>Область<select bind:value={temporaryScope}><option value="">Весь проект</option>
            {#each project.scopes as scope (scope.id)}<option value={scope.id}>{scope.name}</option>{/each}</select></label>
          <label>Основание<input required bind:value={reason} /></label>
        {/if}
      {/if}
      <div class="actions"><button class="primary" disabled={busy || version == null}>Сохранить участника</button></div>
    </form>
  </section>
  <section class="card">
    <h2>Рабочий каталог</h2>
    {#if project.catalog}
      <p>{project.catalog.name} · версия {project.catalog.revision}</p>
      {#if project.catalogState === 'legacy_empty'}<p>В исторической версии нет требований.</p>{/if}
    {:else}
      <p>Нет рабочего каталога.</p>
    {/if}
    {#if catalogReasons[catalogReason]}<p>{catalogReasons[catalogReason]}</p>{/if}
    {#if catalogs.length}
      <form onsubmit={(event) => {
        event.preventDefault();
        void modify('/catalog', 'PUT', { catalogVersionId }, 'Версия каталога закреплена.', catalogVersion);
      }}>
        <label>Версия каталога
          <select required bind:value={catalogVersionId}>
            <option value="">Выберите каталог</option>
            {#each catalogs as catalog (catalog.id)}<option value={catalog.id}>{catalog.name} · {catalog.revision}</option>{/each}
          </select>
        </label>
        {#if catalogCursor}<button type="button" disabled={busy} onclick={() => loadCatalogOptions(catalogCursor ?? undefined)}>Ещё версии</button>{/if}
        <div class="actions"><button class="primary" disabled={busy || catalogVersion == null || !catalogVersionId}>Назначить рабочий каталог</button></div>
      </form>
    {/if}
  </section>
  <section class="card">
    <h2>Стадия проекта</h2>
    {#if project.stage}
      <p>Подтверждённая стадия: {project.stage}</p>
      {#if project.stageBasis?.provenanceKind === 'engineer_override'}
        {@const basis = project.stageBasis}
        <span class="pill good">Установлено инженером</span>
        <a href={originalUrl(basis.documentId, basis.versionId, basis.address.locator?.page)}
          target="_blank" rel="noopener noreferrer">{basis.label} · {renderAddress(basis.address)}</a>
      {:else if project.stageBasis?.provenanceKind === 'machine_verified'}
        <span class="pill">Подтверждено по цитате</span>
        {#each project.stageBasis.evidenceIds as evidence, index (evidence)}
          <a href={scopedUrl(project.id, 'members', { evidence })}>Открыть подтверждение {index + 1}</a>
        {/each}
      {/if}
    {:else if project.stageStatus === 'legacy_unconfirmed'}
      <p>Стадия проекта не подтверждена. Исторические стадии указаны в областях.</p>
    {:else}
      <p>Стадия уточняется.</p>
    {/if}
    {#if project.confirmedFacadeKinds?.length}<p>Подтверждённые типы фасадов: {project.confirmedFacadeKinds.join(', ')}</p>{/if}
    {#if project.intakeMode}
      <div class="actions" role="group" aria-label="Способ подтверждения стадии">
        <button type="button" aria-pressed={currentStageMode === 'machine'} onclick={() => stageMode = 'machine'}>Из найденных опор</button>
        <button type="button" aria-pressed={currentStageMode === 'manual'} onclick={() => stageMode = 'manual'}>Указать вручную по оригиналу</button>
      </div>
      <ProjectProposals {api} {project} disabled={busy || version == null} showStage={currentStageMode === 'machine'}
        onStageAvailability={(available) => stageOptions = available}
        confirmStage={(stage, evidenceId) => modify('/stage', 'PUT', {
          stage, reason: 'Подтверждено по исходному документу.', evidenceIds: [evidenceId],
        }, 'Стадия проекта сохранена.')}
        confirmFacadeKinds={(facadeKinds, evidenceIds) => modify('/facade-assessment/facade-kinds', 'PUT', {
          facadeKinds, reason: 'Подтверждено по исходным документам.', evidenceIds,
        }, 'Типы фасадов сохранены.')} />
    {/if}
    {#snippet stageForm()}
      <form onsubmit={(event) => {
        event.preventDefault();
        if (project.intakeMode && (!stageOriginal || !stageAnchor.trim())) return;
        void modify('/stage', 'PUT', { stage, reason: stageReason,
          ...(project.intakeMode ? { provenanceKind: 'engineer_override', documentVersionId: stageOriginal, pageOrAnchor: stageAnchor.trim() } : {}),
        }, 'Стадия проекта сохранена.', stageVersion ?? version);
      }}>
        <label>Код стадии<input required maxlength="200" bind:value={stage} oninput={editStage} /></label>
        {#if project.intakeMode}
          <OriginalBasisFields {api} projectId={project.id} bind:versionId={stageOriginal} bind:anchor={stageAnchor} edit={editStage} />
        {/if}
        <label>Комментарий инженера<textarea required maxlength={project.intakeMode ? 2000 : 500}
          bind:value={stageReason} oninput={editStage}></textarea></label>
        <div class="actions">
          <button class="primary" disabled={busy || version == null || !stage.trim() || !stageReason.trim() ||
            (project.intakeMode && (!stageOriginal || !stageAnchor.trim()))}>Подтвердить стадию проекта</button>
          {#if stageVersion !== undefined && stageVersion !== version}
            <button type="button" onclick={() => { stageVersion = version; }}>{copy.refreshAndCompare}</button>
          {/if}
        </div>
      </form>
    {/snippet}
    {#if project.intakeMode}
      {#if currentStageMode === 'manual'}{@render stageForm()}{/if}
    {:else}
      <details><summary>Указать стадию вручную</summary>{@render stageForm()}</details>
    {/if}
  </section>
</div>
