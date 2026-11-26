<script lang="ts">
  import { originalUrl } from './copilot';
  import { count, date, label } from './format';
  import { denied, describe, id, interrupted, query, type Api } from './http';
  import { preliminarySourcePlace } from './preliminary-review';
  import { projectV1 } from './workspace';

  type FileReading = {
    versionId: string; documentId: string; label: string; mediaType: string;
    preparation: { kind: string; state: string; reason: string | null } | null;
    mapUnits: number | null;
    index: { processed: number; total: number; native: number; graphics: number; ocr: number; rasterOcr: number; reason: string | null } | null;
    openings: { units: number; rendered: number; ocr: number; latestId: string | null; latestRenderId: string | null; latestOcrId: string | null; latestOcrInputId: string | null };
    windows: { total: number; checked: number; limited: number; held: number; queued: number; reading: number } | null;
    citations: { count: number; examples: { key: string; title: string; anchor: string }[] } | null;
    pixels: { confirmedImages: number; partialImages: number; latest: { id: string; partsDelivered: number; partsExpected: number } } | null;
  };
  type Chain = {
    receiptId: string; receiptNumber: number; reviewId: string | null; historical: boolean; inventoryOpen: boolean;
    preparationId: string | null; cutoff: string | null;
    latest: { stage: string; status: string; reason: string | null; at: string } | null;
    request: { status: string; requestBytes?: number; selectedFiles?: number; totalFiles?: number;
      coveredFiles?: number; selectedLines?: number; totalLines?: number; remainingLines?: number;
      inputTokens?: number; estimatedInputTokens?: number } | null;
    items: FileReading[]; nextCursor: string | null;
  };
  let { api, projectId, receiptId, reviewId, refreshKey }: {
    api: Api; projectId: string; receiptId: string; reviewId?: string; refreshKey: number;
  } = $props();

  let data = $state<Chain>();
  let error = $state('');
  let cursors = $state<(string | null)[]>([null]);
  let page = $state(0);
  let retry = $state(0);
  const resource = $derived(projectV1(projectId) + '/receipts/' + id(receiptId) + '/evidence-chain');
  const after = $derived(cursors[page]);
  const requestUrl = $derived(query(resource, { reviewId, after }));
  let loadedUrl = $state('');
  const waiting = $derived(loadedUrl !== requestUrl);

  const statusText: Record<string, string> = {
    waiting: 'Ожидает начала', received: 'Опись открыта', sealed: 'Опись закрыта',
    mapped: 'Карта сохранена', limited: 'Подготовлено с ограничениями', ready: 'В очереди', leased: 'Читается',
    held: 'Чтение приостановлено', covered: 'Получены наблюдения', reviewed_no_match: 'По участку нет совпадений',
    final_refusal: 'Чтение участка завершилось отказом', sending: 'Идёт запрос. Ответ ещё не получен',
    completed: 'Ответ получен. Результат готовится к публикации',
    unknown: 'Исход запроса неизвестен',
    rejected: 'Запрос остановлен', published: 'Результат сохранён',
    partial: 'Обработана часть материалов. Остались следующие пакеты',
  };
  const reasons: Record<string, string> = {
    catalog_exceeds_preliminary_input: 'Каталог превышает предел входа.',
    preliminary_input_limit: 'Объём запроса превышает предел.',
    primary_request_limit: 'Размер или оценка токенов превышает предел запроса.',
    revision_request_limit: 'Размер или оценка токенов превышает предел запроса.',
    prepared_input_changed: 'Подготовленная опись изменилась.',
    held_legacy_attempt: 'Требуется сверка сохранённой попытки.',
    adapter_unavailable: 'Подключение к сервису временно недоступно.',
    adapter_failed_after_start: 'Связь с сервисом прервалась после начала запроса.',
    model_request_failed_or_unknown: 'Исход запроса нужно сверить.',
    model_outcome_unknown: 'Исход предыдущего запроса нужно сверить.',
    invalid_adapter_json: 'Выход сервиса не удалось разобрать.',
    invalid_model_response: 'Ответ сервиса не прошёл проверку.',
    revision_scope_changed: 'Опись или область проверки изменилась.',
    request_too_large: 'Объём запроса превышает предел.',
    context_limit: 'Содержимое запроса превышает доступный контекст.',
    context_length_exceeded: 'Содержимое запроса превышает доступный контекст.',
    codex_context_limit: 'Содержимое запроса превышает доступный контекст.',
    codex_request_too_large: 'Объём запроса превышает предел.',
    codex_usage_limit: 'Достигнут лимит обращений к сервису.',
    codex_login_required: 'Требуется восстановить подключение к сервису.',
    preparation_pending: 'Подготовка пакета продолжается.',
    inventory_open: 'Опись ещё открыта.',
    reader_index_pending: 'Подготовка текстового индекса продолжается.',
    previous_attempt_unknown: 'Требуется сверка предыдущей попытки.',
    previous_attempt_unsettled: 'Требуется сверка предыдущей попытки.',
    no_readable_documents: 'В описи нет документов, доступных для чтения.',
  };

  function stageName(stage: string) {
    if (stage === 'primary_review') return 'Первичный обзор';
    if (stage === 'revision') return 'Уточнение по новым наблюдениям';
    if (stage === 'review_saved') return 'Предварительный разбор';
    if (stage === 'intake') return 'Приём поступления';
    if (stage === 'archive') return 'Раскрытие архива';
    if (stage === 'file_map') return 'Подготовка карты файла';
    if (stage === 'index') return 'Текстовый индекс';
    if (stage === 'preparation') return 'Подготовка пакета';
    if (stage === 'detailed_reading') return 'Подробное чтение';
    return 'Обработка пакета';
  }

  $effect(() => {
    const url = requestUrl;
    void refreshKey;
    void retry;
    const controller = new AbortController();
    let inFlight = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    async function load() {
      if (inFlight) return;
      inFlight = true;
      clearTimeout(timer);
      try {
        const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(15000)]);
        const result = await api.json<Chain>(url, { signal });
        if (controller.signal.aborted) return;
        data = result;
        loadedUrl = url;
        error = '';
      } catch (failure) {
        if (controller.signal.aborted || interrupted(failure)) return;
        if (denied(failure)) { data = undefined; loadedUrl = ''; }
        error = describe(failure);
      } finally {
        inFlight = false;
        if (!controller.signal.aborted && !data?.historical && document.visibilityState === 'visible') {
          timer = setTimeout(load, 15_000);
        }
      }
    }
    void load();
    const onVisible = () => { if (document.visibilityState === 'visible' && !data?.historical) void load(); };
    document.addEventListener('visibilitychange', onVisible);
    return () => { controller.abort(); clearTimeout(timer); document.removeEventListener('visibilitychange', onVisible); };
  });

  function eventStatus(stage: string, status: string) {
    if (stage === 'index' && status === 'completed') return 'Индекс сохранён';
    if (stage === 'preparation' && status === 'published') return 'Подготовленный состав сохранён';
    if (stage === 'detailed_reading' && status === 'partial') return 'Участок прочитан частично';
    return statusText[status] ?? 'Состояние уточняется';
  }

  function nextPage() {
    if (!data?.nextCursor) return;
    cursors = [...cursors.slice(0, page + 1), data.nextCursor];
    page += 1;
  }

  function evidenceContent(evidenceId: string, part: 'content' | 'ocr-input' = 'content') {
    return '/api/v1/evidence/' + id(evidenceId) + '/' + part;
  }

  function citationPlace(file: FileReading, anchor: string) {
    return preliminarySourcePlace({ ...file, anchor });
  }
</script>

<section class="card" aria-label="Как обработаны файлы">
  <h2>Как обработаны файлы</h2>
  {#if error}
    <p role="alert">Не удалось обновить состояние. {error}{data ? ' Показаны последние полученные сведения.' : ''}</p>
    <button type="button" onclick={() => retry += 1}>Повторить</button>
  {/if}
  {#if data}
    {#if data.historical}
      <p class="meta">История поступления №{count(data.receiptNumber)}{data.cutoff ? ' · На ' + date(data.cutoff) : ''}.</p>
    {/if}
    {#if data.latest}
      <p><strong>{stageName(data.latest.stage)}.</strong> {eventStatus(data.latest.stage, data.latest.status)}.{#if data.latest.reason} {reasons[data.latest.reason] ?? label(data.latest.reason).replaceAll('_', ' ') + '.'}{/if}</p>
      <p class="meta">{date(data.latest.at)}</p>
    {:else if data.reviewId}
      <p>Предварительный результат сохранён.</p>
    {:else if data.inventoryOpen}
      <p>Первичный обзор ждёт закрытия описи.</p>
    {:else if !data.preparationId}
      <p>Первичный обзор ждёт подготовки файлов.</p>
    {:else}
      <p>Предварительный результат ещё не опубликован. Состояние запроса пока неизвестно.</p>
    {/if}
    {#if data.request}
      {@const request = data.request}
      <p class="request">
        <strong>Объём первичного запроса{request.status === 'waiting' || request.status === 'rejected' ? ' при подготовке' : ''}.</strong>
        {#if request.requestBytes !== undefined}{count(request.requestBytes)} байт.{/if}
        {#if request.selectedFiles !== undefined && request.totalFiles !== undefined} Файлов в запросе {count(request.selectedFiles)} из {count(request.totalFiles)}.{/if}
        {#if request.coveredFiles !== undefined} Файлов с текстом {count(request.coveredFiles)}.{/if}
        {#if request.selectedLines !== undefined && request.totalLines !== undefined} Индексных строк {count(request.selectedLines)} из {count(request.totalLines)}.{/if}
        {#if request.remainingLines !== undefined && request.remainingLines > 0} За пределами запроса {count(request.remainingLines)} строк.{/if}
        {#if request.inputTokens !== undefined} Входных токенов {count(request.inputTokens)}.
        {:else if request.estimatedInputTokens !== undefined} Оценка входа {count(request.estimatedInputTokens)} токенов.{/if}
      </p>
    {/if}
    <details>
      <summary>Состояние по файлам</summary>
      {#if data.items.length}
        <div class="table-wrap">
          <table aria-busy={waiting}>
            <thead><tr><th>Файл</th><th>Открытие и OCR</th><th>Передача изображений</th><th>Использован в требованиях</th><th>Осталось</th></tr></thead>
            <tbody>
              {#each data.items as file (file.versionId)}
                <tr>
                  <th scope="row">
                    <a href={originalUrl(file.documentId, file.versionId)} target="_blank" rel="noopener">{file.label}</a>
                    {#if file.preparation?.state === 'excluded'}<p class="meta">{file.preparation.kind === 'archive' ? 'Контейнер' : 'Исключён из чтения'}</p>{/if}
                  </th>
                  <td>
                    {#if file.mapUnits !== null}<p>В карте · {count(file.mapUnits)} частей</p>{/if}
                    {#if file.openings.latestId}
                      <p><a href={evidenceContent(file.openings.latestId)} target="_blank" rel="noopener">Открыто частей · {count(file.openings.units)}</a></p>
                    {:else if file.index?.processed}<p>Обработано индексом · {count(file.index.processed)} частей</p>
                    {:else}<p>Открытие не зафиксировано</p>{/if}
                    {#if file.openings.latestRenderId}<p><a href={evidenceContent(file.openings.latestRenderId)} target="_blank" rel="noopener">Рендер оригинала · {count(file.openings.rendered)} частей</a></p>{/if}
                    {#if file.openings.latestOcrId}
                      <p><a href={evidenceContent(file.openings.latestOcrId)} target="_blank" rel="noopener">Выдача OCR · {count(file.openings.ocr)} частей</a></p>
                      {:else if file.index?.rasterOcr}<p>OCR при индексировании · {count(file.index.rasterOcr)} частей</p>
                    {:else}<p>Выдача OCR не зафиксирована</p>{/if}
                    {#if file.openings.latestOcrInputId}<p><a href={evidenceContent(file.openings.latestOcrInputId, 'ocr-input')} target="_blank" rel="noopener">Вход OCR</a></p>{/if}
                  </td>
                  <td>
                    {#if file.pixels}
                      {#if file.pixels.confirmedImages}<p>Подтверждено · {count(file.pixels.confirmedImages)}</p>{/if}
                      {#if file.pixels.partialImages}<p>Переданы отдельные фрагменты · {count(file.pixels.partialImages)}</p>{/if}
                      {#if file.pixels.latest.partsDelivered < file.pixels.latest.partsExpected}
                        <p>Последнее изображение · {count(file.pixels.latest.partsDelivered)} из {count(file.pixels.latest.partsExpected)} фрагментов</p>
                      {/if}
                      <p><a href={evidenceContent(file.pixels.latest.id)} target="_blank" rel="noopener">Исходный рендер для последней передачи</a></p>
                    {:else}<p>Передача не подтверждена</p>{/if}
                  </td>
                  <td>
                    {#if file.citations?.count}
                      <ul>
                        {#each file.citations.examples as source}
                          {@const place = citationPlace(file, source.anchor)}
                          <li><a href={originalUrl(file.documentId, file.versionId, file.mediaType === 'application/pdf' ? place.page : undefined)} target="_blank" rel="noopener">{source.title} · {place.label}</a></li>
                        {/each}
                      </ul>
                      {#if file.citations.count > file.citations.examples.length}
                        <p class="meta">Других ссылок в разборе · {count(file.citations.count - file.citations.examples.length)}</p>
                      {/if}
                    {:else if data.reviewId}<p>Ссылок в разборе нет</p>
                    {:else}<p>Разбор ещё недоступен</p>{/if}
                  </td>
                  <td>
                    {#if file.preparation?.reason}<p>{label(file.preparation.reason)}</p>{/if}
                    {#if file.index}
                      {#if file.index.processed < file.index.total}<p>Индекс · {count(file.index.total - file.index.processed)} частей в работе</p>{/if}
                      {#if file.index.reason}<p>{label(file.index.reason)}</p>{/if}
                      {#if file.index.graphics || file.index.ocr || file.index.native}
                        <p>Ограничения индекса · {[
                          file.index.native ? 'текст ' + count(file.index.native) : '',
                          file.index.graphics ? 'графика ' + count(file.index.graphics) : '',
                          file.index.ocr ? 'OCR ' + count(file.index.ocr) : '',
                        ].filter(Boolean).join(', ')}</p>
                      {/if}
                    {/if}
                    {#if file.windows}
                      <p>Подробное чтение · {count(file.windows.checked)} из {count(file.windows.total)} участков с завершённой проверкой</p>
                      {#if file.windows.queued}<p>В очереди · {count(file.windows.queued)}</p>{/if}
                      {#if file.windows.reading}<p>Читается · {count(file.windows.reading)}</p>{/if}
                      {#if file.windows.limited}<p>Частично прочитано или недоступно · {count(file.windows.limited)}</p>{/if}
                      {#if file.windows.held}<p>Приостановлено · {count(file.windows.held)}</p>{/if}
                    {:else if !file.preparation?.reason && !file.index?.reason && !file.index?.graphics && !file.index?.ocr && !file.index?.native}
                      <p>Остаток подробного чтения неизвестен</p>
                    {/if}
                  </td>
                </tr>
              {/each}
            </tbody>
          </table>
        </div>
        {#if page || data.nextCursor}
          <nav class="actions" aria-label="Страницы файлов">
            <button type="button" disabled={!page || waiting} onclick={() => page -= 1}>Предыдущая</button>
            <span>Страница {page + 1}</span>
            <button type="button" disabled={!data.nextCursor || waiting} onclick={nextPage}>Следующая</button>
          </nav>
        {/if}
      {:else}<p>В описи ещё нет принятых файлов.</p>{/if}
    </details>
  {:else if !error}<p role="status">Загружается состояние обработки.</p>{/if}
</section>

<style>
  h2 { margin-block-start: 0; }
  p { margin: .35rem 0; }
  .request { margin-block: .7rem; }
  details { margin-top: .8rem; }
  table { width: 100%; }
  td, th { min-width: 8.5rem; max-width: 19rem; overflow-wrap: anywhere; vertical-align: top; }
  tbody th { font-weight: 550; }
  ul { margin: .35rem 0; padding-inline-start: 1rem; }
  li + li { margin-block-start: .3rem; }
</style>
