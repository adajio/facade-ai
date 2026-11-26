<script lang="ts" module>
  import type { SourceAddress } from './copilot';
  export type TerraReading = {
    enabled: boolean;
    receipt: { receiptId: string; receiptNumber: number; inventoryOpen: boolean; acceptedVersions: number; rootFiles: number; rootArchives: number; directChildren: number; deeperChildren: number; officeParts: number } | null;
    report: { id: string; createdAt: string; summary: { present: number; partial: number; notFound: number; unassessed: number }; draftAvailable: boolean } | null;
    progress: { totalWindows: number; mappedVersions: number; completed: number; covered: number; noMatch: number; refused: number; held: number; reading: number; queued: number; unassigned: number; heldReasons: { reason: string; count: number }[]; observations: number } | null;
    activity: { kind: string; documentId: string; versionId: string; label: string; anchor: SourceAddress | null; text: string | null; quote: string | null; value: string | null; unit: string | null; limitation: string | null; createdAt: string }[];
  };
</script>
<script lang="ts">
  import { originalUrl, renderAddress } from './copilot';
  import PreliminaryStatusBadge from './PreliminaryStatusBadge.svelte';
  import { count, date } from './format';
  import { scopedUrl } from './workspace';
  import type { WorkSlice } from './work-slice';
  let { data, slice, updatedAt, error, canEdit }: { data: TerraReading; slice: WorkSlice; updatedAt?: number; error: string; canEdit: boolean } = $props();
  const receipt = $derived(data.receipt);
  const progress = $derived(data.progress);
  const report = $derived(data.report);
  const total = $derived(report ? Object.values(report.summary).reduce((sum, value) => sum + value, 0) : 0);
  const evaluated = $derived(total - (report?.summary.unassessed ?? 0));
  const holdLabels: Record<string, string> = {
    turn_limit: 'Можно продолжить с сохранённого места',
    turn_limit_final: 'Исчерпан лимит шагов по участку',
    repeated_rejected_action: 'Действие модели требует проверки',
    package_structure_pending: 'Готовится карта документа',
    subscription_outcome_unknown: 'Требуется сверить ответ провайдера'
  };
</script>
<section class="card terra" aria-labelledby="terra-title">
  <p class="meta">Стадия 1. Распознавание входящих документов{receipt ? ' · Поступление №' + count(receipt.receiptNumber) : ''}</p>
  <h2 id="terra-title">Комплектность поступления</h2>
  {#if error}<p role="alert">Не удалось обновить данные. {error}. Показаны последние полученные сведения.</p>{/if}
  {#if report}
    <p class="lead">Система оценила <strong>{count(evaluated)} из {count(total)}</strong> требований.</p>
    <dl class="outcomes" aria-label="Результаты по требованиям">
      <div><dt><PreliminaryStatusBadge status="present" /></dt><dd>{count(report.summary.present)}</dd></div>
      <div><dt><PreliminaryStatusBadge status="partial" /></dt><dd>{count(report.summary.partial)}</dd></div>
      <div><dt><PreliminaryStatusBadge status="not_found" /></dt><dd>{count(report.summary.notFound)}</dd></div>
      {#if report.summary.unassessed}<div><dt><PreliminaryStatusBadge status="unassessed" /></dt><dd>{count(report.summary.unassessed)}</dd></div>{/if}
    </dl>
    <p>Инженеру нужно сверить основания по требованиям и решить, какие вопросы включить в письмо заказчику.</p>
    <div class="actions"><a class="button primary" href={scopedUrl(slice.projectId, 'completeness', { scope: slice.scopeId, context: slice.assessment?.contextId })}>Открыть требования и источники</a>{#if report.draftAvailable}<a class="button" href={scopedUrl(slice.projectId, 'letters', { scope: slice.scopeId })}>Открыть черновик письма</a>{/if}</div>
    <p class="meta">Предварительный разбор сохранён {date(report.createdAt)}.</p>
  {:else if receipt}
    <p>Разбор по требованиям ещё не готов.</p>
    <a href={scopedUrl(slice.projectId, 'receipts', { scope: slice.scopeId }, receipt.receiptId)}>Открыть поступление</a>
  {:else}
    <p>Поступлений пока нет.</p>
    {#if canEdit}<a class="button primary" href={scopedUrl(slice.projectId, 'receipts', { scope: slice.scopeId, upload: 1 })}>Загрузить первый комплект</a>{/if}
  {/if}
</section>
{#if receipt}
  <section class="card terra" aria-labelledby="reading-title">
    <h2 id="reading-title">Подробное чтение документов</h2>
    {#if progress && progress.totalWindows}
      <p data-reading-progress>Завершено участков чтения <strong>{count(progress.completed)} из {count(progress.totalWindows)}</strong>. Сохранено наблюдений <strong>{count(progress.observations)}</strong>.</p>
      {#if progress.reading}<p>Система читает документ.</p>{:else if progress.queued || progress.unassigned}<p>Есть участки, ожидающие чтения.</p>{/if}
      {#if progress.held}<p>Приостановлено участков · {count(progress.held)}.</p>{/if}
      <a href={scopedUrl(slice.projectId, 'facts', { scope: slice.scopeId })}>Все найденные сведения</a>
      <!-- svelte-ignore a11y_no_noninteractive_tabindex: Keyboard users can scroll the bounded reading excerpt. -->
      <div class="latest-reading" role="region" tabindex="0" aria-label="Последняя запись чтения">
        <h3>Последняя запись</h3>
        {#if data.activity.length}
        {@const item = data.activity[0]}
        {#if item.quote || item.text}<blockquote>{item.quote || item.text}</blockquote>{/if}
        {#if item.value}<p>{item.value}{item.unit ? ' ' + item.unit : ''}</p>{/if}
        {#if item.limitation}<p>{item.limitation}</p>{/if}
        <a href={originalUrl(item.documentId, item.versionId, item.anchor?.locator?.page)} target="_blank" rel="noopener">{item.label}{item.anchor ? ' · ' + renderAddress(item.anchor) : ''}</a>
        {:else}<p>Записей чтения пока нет.</p>{/if}
      </div>
      <details>
        <summary>Ход чтения по участкам</summary>
        <p>С находками · {count(progress.covered)}. Без совпадений · {count(progress.noMatch)}. Чтение завершилось отказом · {count(progress.refused)}.</p>
        <p>Читается · {count(progress.reading)}. В очереди · {count(progress.queued)}. Ожидают назначения · {count(progress.unassigned)}.</p>
        {#each progress.heldReasons as item}<p>{holdLabels[item.reason] ?? item.reason} · {count(item.count)}</p>{/each}
      </details>
    {:else}<p>Карта участков для чтения пока не готова.</p>{/if}
    {#if updatedAt}<p class="meta">Данные обновлены {new Date(updatedAt).toLocaleTimeString('ru-RU')}.</p>{/if}
  </section>
  <details class="card terra">
    <summary>Что принято и подготовлено к чтению</summary>
    <p>Поступление №{count(receipt.receiptNumber)}. {receipt.inventoryOpen ? 'Опись открыта.' : 'Опись закрыта.'}</p>
    <p>На верхнем уровне архивов · {count(receipt.rootArchives)}, отдельных файлов · {count(receipt.rootFiles)}. Вложений первого уровня · {count(receipt.directChildren)}, более глубоких вложений · {count(receipt.deeperChildren)}.</p>
    {#if receipt.officeParts}<p>При распаковке документа Word в опись попали его служебные части · {count(receipt.officeParts)}. Они входят в общее число принятых версий.</p>{/if}
    {#if slice.files}<p>Файлов проекта с картой страниц, листов или других адресуемых частей · {count(slice.files.prepared)} из {count(slice.files.accepted)} принятых версий.</p>{/if}
    <a href={scopedUrl(slice.projectId, 'receipts', { scope: slice.scopeId }, receipt.receiptId)}>Открыть опись поступления</a>
  </details>
{/if}
<style>
  .terra > :first-child { margin-top: 0; }
  .terra p { margin: .4rem 0; }
  .terra h2 { margin: .3rem 0 .7rem; }
  .terra h3 { margin: 1rem 0 .3rem; font-size: 1rem; }
  .lead { font-size: 1.1rem; }
  .outcomes { display: flex; flex-wrap: wrap; gap: 1rem 2rem; margin: 1rem 0; }
  .outcomes dt { font-size: .9rem; }
  .outcomes dd { font-variant-numeric: tabular-nums; font-size: 1.75rem; font-weight: 650; line-height: 1.2; margin: .15rem 0 0; }
  .actions { margin: .8rem 0; }
  .terra details { margin-top: .9rem; }
  .latest-reading { height: 10rem; overflow: auto; overscroll-behavior: contain; }
  blockquote { margin: .4rem 0; padding-left: .8rem; border-left: 3px solid var(--line); }
</style>
