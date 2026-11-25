<script lang="ts">
  import { available, type Project } from '../lib/contracts';
  import { date } from '../lib/format';
  import { projectStageLabel } from '../lib/project-stages';
  import { scopedUrl } from '../lib/workspace';
  import CatalogSummary from '../lib/CatalogSummary.svelte';
  let { project }: { project: Project } = $props();
</script>

<section class="card">
  <h2>Правила проверки проекта</h2>
  <dl class="details">
    <dt>Стадия проекта</dt><dd>{project.stage ? projectStageLabel(project.stage) : 'Ожидает подтверждения'}</dd>
    <dt>Перечень требований</dt><dd>{project.catalog ? project.catalog.name + ' · версия ' + project.catalog.revision : 'Не назначен'}</dd>
    {#if project.catalog}
      <dt>Стадия применения</dt><dd>{project.catalog.stage ?? 'В записи не указана'}</dd>
      <dt>Публикация версии</dt><dd>{project.catalog.publisher ?? 'Автор не указан'} · {date(project.catalog.publishedAt)}</dd>
      <dt>Назначение проекту</dt><dd>{project.catalogAssignment
        ? (project.catalogAssignment.automatic ? 'Автоматически' : 'Выбор владельца') + ' · ' + date(project.catalogAssignment.at) + (project.catalogAssignment.actor ? ' · ' + project.catalogAssignment.actor : '')
        : 'Сведения о назначении в записи отсутствуют'}</dd>
    {/if}
  </dl>
  {#if project.catalog}<CatalogSummary catalog={project.catalog} />
  {:else}<p>Можно принять файлы и начать первичное чтение. Для проверки требований понадобится применимый каталог.</p>{/if}
  {#if available(project, 'project:manage')}
    <a class="button" href={scopedUrl(project.id, 'members', {})}>Изменить назначение каталога и участников</a>
  {/if}
</section>
