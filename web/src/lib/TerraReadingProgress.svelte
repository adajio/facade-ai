<script lang="ts" module>
  import type { SourceAddress } from './copilot';
  export type TerraReading = {
    enabled: boolean;
    receipt: { receiptId: string; receiptNumber: number; inventoryOpen: boolean; acceptedVersions: number; rootFiles: number; rootArchives: number; directChildren: number; deeperChildren: number; officeParts: number;
      preparation?: { available: number; total: number; archives: number; technical: number } | null;
      primaryRequest?: { status: string; totalFiles?: number; evidenceFiles?: number; visualFiles?: number } | null } | null;
    report: { id: string; createdAt: string; summary: { present: number; partial: number; notFound: number; unassessed: number }; draftAvailable: boolean; hasQuestions?: boolean | null } | null;
    progress: { totalWindows: number; mappedVersions: number; completed: number; covered: number; partial?: number; noMatch: number; refused: number; held: number; reading: number; queued: number; unassigned: number; heldReasons: { reason: string; count: number }[]; observations: number;
      deep?: { status: string; reason: string | null; started: number; limit: number } | null;
      directed?: { mode: 'ordinary' | 'waiting_report' | 'waiting_index' | 'planning' | 'enough_evidence' | 'no_new_targets' | 'directed'; openRequirements: number;
        indexPendingVersions: number; indexCompleteVersions: number; indexPendingUnits: number; indexUnknownVersions: number; pendingTargets: number };
    } | null;
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
  const deep = $derived(progress?.deep);
  const directed = $derived(progress?.directed);
  const outstandingWindows = $derived(progress ? progress.totalWindows - progress.completed : 0);
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
  {#if receipt?.preparation}
    <p>Готово к чтению {count(receipt.preparation.available)} из {count(receipt.preparation.total)} документов.{#if receipt.preparation.archives} Архивов в описи · {count(receipt.preparation.archives)}.{/if}{#if receipt.preparation.technical} Служебных файлов · {count(receipt.preparation.technical)}.{/if}</p>
  {/if}
  {#if receipt?.primaryRequest?.evidenceFiles !== undefined && ['completed', 'published', 'partial'].includes(receipt.primaryRequest.status)}
    <p>В первичном запросе переданы текст или изображения из {count(receipt.primaryRequest.evidenceFiles)} файлов{receipt.primaryRequest.totalFiles !== undefined ? ' из ' + count(receipt.primaryRequest.totalFiles) : ''}.{#if receipt.primaryRequest.visualFiles} С изображениями · {count(receipt.primaryRequest.visualFiles)}.{/if}</p>
  {/if}
  {#if receipt?.primaryRequest?.status === 'unknown'}
    <p>Ответ первичного запроса не подтверждён. Сохранённые результаты отдельных участков доступны по требованиям.</p>
  {/if}
  {#if report}
    <p class="lead">Предварительные результаты есть по <strong>{count(evaluated)} из {count(total)}</strong> требований.</p>
    <dl class="outcomes" aria-label="Результаты по требованиям">
      <div><dt><PreliminaryStatusBadge status="present" /></dt><dd>{count(report.summary.present)}</dd></div>
      <div><dt><PreliminaryStatusBadge status="partial" /></dt><dd>{count(report.summary.partial)}</dd></div>
      <div><dt><PreliminaryStatusBadge status="not_found" /></dt><dd>{count(report.summary.notFound)}</dd></div>
      {#if report.summary.unassessed}<div><dt><PreliminaryStatusBadge status="unassessed" /></dt><dd>{count(report.summary.unassessed)}</dd></div>{/if}
    </dl>
    <p>Инженеру нужно сверить основания по требованиям и решить, какие вопросы включить в письмо заказчику.</p>
    <div class="actions"><a class="button primary" href={scopedUrl(slice.projectId, 'completeness', { scope: slice.scopeId, context: slice.assessment?.contextId })}>Открыть требования и источники</a>{#if report.draftAvailable}<a class="button" href={scopedUrl(slice.projectId, 'letters', { scope: slice.scopeId })}>{report.hasQuestions === false ? 'Посмотреть, почему в письме пока нет вопросов' : 'Открыть черновик письма'}</a>{/if}</div>
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
    {#if deep}
      <p data-deep-reading>
        {#if deep.reason === 'target_limit'}Адресное чтение остановлено с частичным результатом. Достигнут лимит в {count(deep.limit)} участка на поступление.
        {:else if deep.reason === 'no_new_targets'}Адресное чтение завершено. Для оставшихся вопросов система не нашла новых участков.
        {:else if deep.reason === 'no_readable_windows'}Адресное чтение остановлено. В подготовленном пакете нет доступных участков для уточнения требований.
        {:else if deep.reason === 'enough_evidence'}Адресное чтение завершено. Для автоматической оценки требований собрано достаточно подтверждений.
        {:else if deep.status === 'held'}Ожидается сверка ответа по приостановленному участку. Сохранённые результаты доступны.
        {:else}Начато адресное чтение. Выбрано участков · {count(deep.started)} из {count(deep.limit)} разрешённых.{/if}
      </p>
    {/if}
    {#if directed?.indexPendingVersions}
      <p>Текстовый индекс готов для {count(directed.indexCompleteVersions)} из {count(directed.indexCompleteVersions + directed.indexPendingVersions)} доступных редакций.
        {#if directed.indexPendingUnits} Ожидают индексации {count(directed.indexPendingUnits)} участков.{/if}
        {#if directed.indexUnknownVersions} Для {count(directed.indexUnknownVersions)} редакций объём ещё не определён.{/if}
      </p>
    {/if}
    {#if progress && progress.totalWindows}
      <p data-reading-progress>Результат чтения по <strong>{count(progress.completed)} из {count(progress.totalWindows)}</strong> участков. Сохранено наблюдений <strong>{count(progress.observations)}</strong>.</p>
      {#if progress.reading}<p>Система читает документ.</p>
      {:else if (progress.queued || directed?.pendingTargets) && (!deep || deep.status === 'running')}<p>Есть адресные участки, ожидающие чтения.</p>
      {:else if directed && !deep}
        {#if directed.mode === 'planning'}<p>Система выбирает адреса для уточнения открытых требований.</p>
        {:else if directed.mode === 'waiting_index'}<p>Новые адреса для чтения будут выбраны после подготовки текстового индекса.</p>
        {:else if directed.mode === 'ordinary' || directed.mode === 'waiting_report'}<p>Выбор участков начнётся по предварительному разбору.</p>
        {:else if directed.mode === 'enough_evidence'}<p>Предварительных опор достаточно для автоматического обзора. Остаток по участкам виден ниже.</p>
        {:else if directed.openRequirements > 0}<p>Для автоматического чтения новых адресов не выбрано. Требований с открытыми вопросами · {count(directed.openRequirements)}.</p>{/if}
      {:else if !deep && progress.unassigned}<p>Есть участки, ожидающие чтения.</p>{/if}
      {#if directed && outstandingWindows > 0}<p>Участков без завершённого чтения · {count(outstandingWindows)}.</p>{/if}
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
        <p>С находками · {count(progress.covered)}. Без совпадений · {count(progress.noMatch)}. Чтение завершилось отказом · {count(progress.refused)}.{#if progress.partial !== undefined} Частично прочитано · {count(progress.partial)}.{/if}</p>
        <p>Читается · {count(progress.reading)}. В очереди · {count(progress.queued)}. {#if directed && !deep}Новые адресные участки · {count(directed.pendingTargets)}. Без назначения · {count(progress.unassigned)}.{:else}Без назначения · {count(progress.unassigned)}.{/if}</p>
        {#each progress.heldReasons as item}<p>{holdLabels[item.reason] ?? item.reason} · {count(item.count)}</p>{/each}
      </details>
    {:else if !deep}<p>Карта участков для чтения пока не готова.</p>{/if}
    {#if updatedAt}<p class="meta">Данные обновлены {new Date(updatedAt).toLocaleTimeString('ru-RU')}.</p>{/if}
  </section>
  <details class="card terra">
    <summary>Что принято и подготовлено к чтению</summary>
    <p>Поступление №{count(receipt.receiptNumber)}. {receipt.inventoryOpen ? 'Опись открыта.' : 'Опись закрыта.'}</p>
    <p>На верхнем уровне архивов · {count(receipt.rootArchives)}, отдельных файлов · {count(receipt.rootFiles)}. Вложений первого уровня · {count(receipt.directChildren)}, более глубоких вложений · {count(receipt.deeperChildren)}.</p>
    {#if receipt.officeParts}<p>При распаковке документа Word в опись попали его служебные части · {count(receipt.officeParts)}. Они входят в общее число принятых версий.</p>{/if}
    {#if slice.files}<p>Файлов проекта с картой страниц, листов или других адресуемых частей · {count(slice.files.prepared)} из {count(slice.files.documents ?? slice.files.accepted)} документов проекта.</p>{/if}
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
