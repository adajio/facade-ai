<script lang="ts">
  import { onDestroy, tick } from 'svelte';
  import { Commands } from '../lib/commands';
  import { describe, id, query, type Api } from '../lib/http';
  import { date, label } from '../lib/format';
  import { formatBudget, originalUrl, renderAddress, representations, sourceVersions,
    type CopilotBudget, type CopilotQuestion, type OriginalSource, type SearchResult, type SourceDetail, type VersionDetail } from '../lib/copilot';
  import { projectApi, scopedUrl, type WorkspaceProps } from '../lib/workspace';
  import Notice from '../lib/Notice.svelte';
  import CadEvidence from '../lib/CadEvidence.svelte';
  import { cadAddress } from '../lib/cad';

  let { api, context, navigate, budget }: {
    api: Api; context: WorkspaceProps; navigate: (path: string) => boolean; budget?: CopilotBudget;
  } = $props();
  const commands = new Commands(() => api);
  const mounted = new AbortController();
  onDestroy(() => mounted.abort());

  const statuses = {
    pending: 'Вопрос принят', queued: 'Помощник исследует вопрос', research_queued: 'Адресное исследование в очереди',
    answered: 'Ответ помощника', historical: 'Исторический ответ · требуется пересмотр', limited: 'Для полного ответа нужны дополнительные сведения', held: 'Работа приостановлена',
  };
  const reasons: Record<string, string> = {
    model_unavailable: 'Модель недоступна. Поиск по источникам работает.',
    route_denied: 'Для этого проекта модельный маршрут недоступен. Поиск по источникам работает.',
    route_data_unapproved: 'Для этого состава оригиналов требуется допуск маршрута.',
    analysis_replay_only: 'Шлюз может воспроизвести только ранее учтённые ходы.',
    budget_exhausted: 'Лимит обработки исчерпан. Сохранённые ответы и поиск по источникам доступны.',
    copilot_budget_exhausted: 'Лимит Помощника исчерпан. Сохранённые ответы и поиск по источникам доступны.',
    budget_frozen: 'Технический оператор сверяет журнал шлюза.',
    unknown_charge: 'Техническому оператору нужно сверить исход отправки.',
    journal_unavailable: 'Журнал шлюза недоступен.',
    memory_index_pending: 'Индексирование исходных материалов продолжается.',
    pdf_non_native_unreviewed: 'Графика и растровый текст PDF требуют проверки.',
    pdf_native_empty: 'В этом месте не обнаружен нативный текст.',
    memory_scope_publications_only: 'Область поиска ограничена опубликованными фрагментами.',
    sources_unavailable: 'Часть оснований недоступна. Ответ скрыт.',
    inputs_changed: 'Состав источников изменился. Откройте актуальные источники или задайте новый вопрос.',
    access_changed: 'Изменились права доступа к исходным материалам.',
    turn_limit: 'Достигнут предел ходов для этого вопроса.',
    copilot_turn_budget: 'Исчерпан предел модельных ходов для этого вопроса. Достигнутый результат сохранён.',
    copilot_research_budget: 'Исчерпан предел адресов или опор. Следующий запрос на дочитывание сохранён.',
    copilot_address_budget: 'Исчерпан предел адресов шлюза для этого вопроса. Оставшиеся действия сохранены.',
    copilot_no_progress: 'Последние ходы не добавили новых адресов или опор. Помощник приостановлен.',
    model_response_invalid: 'Модель не вернула проверяемый ответ.',
    research_unavailable: 'Дочитывание по этому адресу сейчас недоступно.',
    model_rejected: 'Маршрут отклонил запрос.',
    no_generation: 'Готовим карту принятых материалов. Поиск доступен по уже добавленным источникам.',
  };

  let searchText = $state('');
  let submittedSearch = $state('');
  let questionText = $state('');
  let search = $state<SearchResult>();
  let question = $state<CopilotQuestion>();
  let source = $state<SourceDetail>();
  let version = $state<VersionDetail>();
  let versionProblem = $state('');
  let busy = $state(false);
  let searchProblem = $state('');
  let questionProblem = $state('');
  let submissionProblem = $state('');
  let sourceProblem = $state('');
  let base = $derived(projectApi(context.project.id) + '/copilot');
  let sourceId = $derived(context.params.get('source'));
  let questionId = $derived(context.objectId);
  let scopeId = $derived(context.scopeId);
  let refreshKey = $derived(context.refreshKey);
  let canEdit = $derived(context.canEdit);
  let versionId = $derived(context.params.get('version'));
  let unitId = $derived(context.params.get('unit'));
  let boxText = $derived(context.params.get('box'));
  let address = $derived(unitId ? (boxText ? unitId + ' · область ' + boxText + ' пт' : unitId) : 'Карта готовится');
  let page = $derived(version?.mediaType === 'application/pdf' && unitId && /^[1-9][0-9]{0,7}$/.test(unitId) ? Number(unitId) : undefined);
  let sourceFocus: HTMLElement | undefined;
  let budgetHeld = $derived(budget?.state === 'frozen' || (budget?.state === 'ready' && budget.remainingUsdNanos === 0));
  let closeSourceButton = $state<HTMLButtonElement>();

  function projectLink(source?: string | null, questionId = context.objectId) {
    return scopedUrl(context.project.id, 'copilot', { scope: context.scopeId, source }, questionId);
  }

  function openSource(event: MouseEvent, key: string) {
    if (event.button !== 0 || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    sourceFocus = event.currentTarget as HTMLElement;
    if (navigate(projectLink(key))) void tick().then(() => closeSourceButton?.focus({ preventScroll: true }));
  }

  function closeSource() {
    if (navigate(projectLink())) void tick().then(() => sourceFocus?.focus());
  }

  function keyboard(event: KeyboardEvent) {
    if (event.key !== 'Escape' || event.defaultPrevented || !sourceId) return;
    event.preventDefault();
    closeSource();
  }

  function requestSearch(event: SubmitEvent) {
    event.preventDefault();
    submittedSearch = searchText.trim();
    search = undefined;
    reload += 1;
  }

  let reload = $state(0);
  $effect(() => {
    void reload;
    void refreshKey;
    const q = submittedSearch;
    const path = query(base + '/search', { q, scopeId });
    if (!q) return;
    return poll((signal) => api.json<SearchResult>(path, { signal }), (value, problem) => {
      search = value;
      searchProblem = problem;
    });
  });

  $effect(() => {
    void refreshKey;
    const key = questionId;
    const path = base;
    question = undefined;
    questionProblem = '';
    if (!canEdit || !key) return;
    return poll((signal) => api.json<CopilotQuestion>(path + '/questions/' + id(key), { signal }), (value, problem) => {
      question = value;
      questionProblem = problem;
    });
  });

  $effect(() => {
    void refreshKey;
    const key = sourceId;
    const path = base;
    source = undefined;
    sourceProblem = '';
    if (!key) return;
    return poll((signal) => api.json<SourceDetail>(query(path + '/sources', { id: key, scopeId }), { signal }), (value, problem) => {
      source = value;
      sourceProblem = problem;
    });
  });

  $effect(() => {
    const path = base;
    const key = versionId;
    if (!context.canEdit || !key) return;
    version = undefined;
    versionProblem = '';
    return poll((signal) => api.json<VersionDetail>(path + '/versions/' + id(key), { signal }), (value, problem) => {
      version = value;
      versionProblem = problem;
    });
  });

  function poll<T>(load: (signal: AbortSignal) => Promise<T>, show: (value: T | undefined, problem: string) => void) {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    async function update() {
      try {
        const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(8000)]);
        const value = await load(signal);
        if (!signal.aborted) show(value, '');
      } catch (error) {
        if (!controller.signal.aborted) show(undefined, describe(error));
      } finally {
        if (!controller.signal.aborted) timer = setTimeout(update, 3500);
      }
    }
    void update();
    return () => { controller.abort(); clearTimeout(timer); };
  }

  async function ask(event: SubmitEvent) {
    event.preventDefault();
    if (busy || budgetHeld || !questionText.trim()) return;
    busy = true;
    submissionProblem = '';
    try {
      const created = await commands.send<{ id: string }>(base + '/questions', 'POST',
        { question: questionText.trim() }, undefined, mounted.signal);
      if (!mounted.signal.aborted && navigate(projectLink(null, created.id))) questionText = '';
    } catch (error) {
      if (!mounted.signal.aborted) submissionProblem = describe(error);
    } finally {
      busy = false;
    }
  }
</script>

<svelte:window onkeydown={keyboard} />

{#snippet limits(items: string[])}
  {#if items.length}
    <ul class="plain-list">
      {#each items as item}<li>{reasons[item] ?? label(item)}</li>{/each}
    </ul>
  {/if}
{/snippet}

{#snippet sources(items: OriginalSource[])}
  <ul class="plain-list copilot-sources">
    {#each items as item (item.id)}
      <li>
        <a class="source-chip" href={projectLink(item.id)} onclick={(event) => openSource(event, item.id)}>{item.label} · {renderAddress(item.address)}</a>
        <p class="meta">{sourceVersions[item.version]} · {item.window ? 'Осталось проверить' : representations[item.representation]}</p>
        {#if item.text}<blockquote>{item.text}</blockquote>{/if}
        {@render limits(item.limitations)}
      </li>
    {/each}
  </ul>
{/snippet}

<div class="copilot-layout">
{#if context.canEdit}
  <section class="card">
    <h2>Задать вопрос по комплекту</h2>
    {#if budget?.state === 'ready'}
      <p class="meta">Остаток лимита помощника <strong class="numeric">{formatBudget(budget.remainingUsdNanos)}</strong></p>
      {#if budgetHeld}<Notice message={reasons.copilot_budget_exhausted} />{/if}
    {:else if budget?.state === 'frozen'}
      <Notice message={reasons.budget_frozen} />
    {:else if budget?.state === 'unconfigured'}
      <p class="meta">Лимит Помощника для проекта ещё не установлен.</p>
    {:else if budget?.state === 'unavailable'}
      <p class="meta">Остаток лимита пока недоступен.</p>
    {/if}
    <form onsubmit={ask}>
      <label>Вопрос инженера<textarea required maxlength="2000" bind:value={questionText}></textarea></label>
      <button type="submit" class="primary" disabled={busy || budgetHeld}>Спросить помощника</button>
    </form>
    <Notice kind="error" message={submissionProblem} />
    {#if context.objectId}
      <Notice kind="error" message={questionProblem} />
      {#if !question && !questionProblem}<p role="status">Загружаем вопрос…</p>{/if}
      {#if question}
        <h3>{question.question}</h3>
        <p role="status"><strong>{statuses[question.state]}</strong>{#if question.reason} · {reasons[question.reason] ?? label(question.reason)}{/if}</p>
        {#if question.state === 'historical'}
          <p>Ответ сохранён по данным от {date(question.asOf)}.</p>
          <Notice message="Чтобы проверить действующие материалы, отправьте новый вопрос. Действует общий лимит шлюза." />
          <button type="button" onclick={() => questionText = question?.question ?? ''}>Подставить вопрос</button>
        {/if}
        {#if question.researchSourceId}
          <p><a href={projectLink(question.researchSourceId)}>
            {question.state === 'research_queued' ? 'Открыть адрес дочитывания' : 'Последний адрес дочитывания'}
          </a></p>
        {/if}
        {#each question.claims ?? [] as claim}
          <p class="answer">{claim.text}</p>
          <ul class="plain-list">
            {#each (question.citations ?? []).filter(({ id }) => claim.sources.includes(id)) as citation (citation.id)}
              <li><a class="source-chip" href={projectLink(citation.id)} onclick={(event) => openSource(event, citation.id)}>
                {citation.label} · {renderAddress(citation.address)}</a></li>
            {/each}
          </ul>
        {/each}
        {#if question.citations?.length}
          <h4>Открытые источники</h4>
          {@render sources(question.citations)}
        {/if}
        {#if question.partialSources?.length}
          <h4>Открытые места для проверки</h4>
          <ul class="plain-list">
            {#each question.partialSources as source (source.id)}
              <li><a href={projectLink(source.id)}>{source.label} · {renderAddress(source.address)}</a> · {representations[source.representation]}</li>
            {/each}
          </ul>
        {/if}
        {#if question.readActions?.length}
          <h4>Действия группы поиска и чтения</h4>
          <ol class="plain-list">
            {#each question.readActions as action}
              <li>
                {action.completed ? 'Выполнено' : 'Ожидает'} ·
                {#if action.operation === 'search_sources'}
                  Поиск «{action.query}»
                {:else if action.sourceId}
                  <a href={projectLink(action.sourceId)}>Открытие источника</a>
                {:else}
                  Открытие источника
                {/if}
              </li>
            {/each}
          </ol>
        {/if}
        {#if question.limitations?.length}
          <h4>Границы ответа</h4>
          {@render limits(question.limitations)}
        {/if}
      {/if}
    {/if}
  </section>
{/if}

{#if sourceId}
  <aside class="card source-panel" aria-label="Источник помощника">
    <div class="card-header"><h2>{context.canEdit ? 'Адрес в оригинале' : 'Опубликованный фрагмент'}</h2>
      <button class="quiet" type="button" bind:this={closeSourceButton} onclick={closeSource}>Закрыть</button>
    </div>
    <Notice kind="error" message={sourceProblem} />
    {#if source?.mode === 'originals'}
      {@const item = source.source}
      {@const cad = cadAddress(item.address.unitId, item.address.locator)}
      <h3>{item.label}</h3>
      <p>{renderAddress(item.address)}</p>
      <p class="meta">{sourceVersions[item.version]} · {item.window ? 'Осталось проверить' : representations[item.representation]} · версия {item.versionId}</p>
      {#if item.text}<blockquote>{item.text}</blockquote>{/if}
      {#if item.context?.length}
        <details>
          <summary>Контекст по соседним адресам</summary>
          <dl class="details">
            {#each item.context as line (line.id)}
              <dt>{renderAddress(line.address)}</dt><dd>{line.text}</dd>
            {/each}
          </dl>
        </details>
      {/if}
      {@render limits(item.limitations)}
      {#if typeof item.address.locator?.page === 'number' && item.address.locator.page > 0}
        <iframe title={'Страница оригинала · ' + item.label} src={originalUrl(item.documentId, item.versionId, item.address.locator.page)}></iframe>
      {/if}
      <a href={originalUrl(item.documentId, item.versionId, item.address.locator?.page)} target="_blank" rel="noopener noreferrer">Открыть оригинал этой версии</a>
      {#if cad}
        {#key item.id}
          <CadEvidence {api} projectId={context.project.id} documentId={item.documentId} versionId={item.versionId}
            sha256={item.sha256} readerVersion={item.readerVersion} address={cad} />
        {/key}
      {/if}
    {:else if source?.mode === 'publications'}
      <p>Страница {source.source.page}</p>
      <blockquote>{source.source.quote}</blockquote>
    {:else if !sourceProblem}
      <p role="status">Проверяем доступ к источнику…</p>
    {/if}
  </aside>
{/if}

{#if versionId && context.canEdit}
  <section class="card">
    <div class="card-header"><h2>Адрес проверки</h2><a href={projectLink()}>Закрыть</a></div>
    <Notice kind="error" message={versionProblem} />
    {#if version}
      <p><strong>{version.label}</strong> · {page ? 'стр. ' : unitId ? 'место ' : ''}{address}</p>
      <p class="meta">{sourceVersions[version.version]} · версия {version.versionId}</p>
      <a href={originalUrl(version.documentId, version.versionId, page)} target="_blank" rel="noopener noreferrer">Открыть оригинал этой версии</a>
      <p><a href={scopedUrl(context.project.id, 'receipts',
        { document: version.versionId, row: version.occurrenceId, page }, version.receiptId)}>Карточка документа и работа по нему</a></p>
    {:else if !versionProblem}
      <p role="status">Проверяем доступ к версии…</p>
    {/if}
  </section>
{/if}

<section class="card">
  <h2>{context.canEdit ? 'Поиск по источникам' : 'Поиск по опубликованным фрагментам'}</h2>
  {#if !context.canEdit && context.scopeId}
    <a href={scopedUrl(context.project.id, 'fragments', { scope: context.scopeId })}>Открыть опубликованные фрагменты</a>
  {/if}
  <form onsubmit={requestSearch}>
    <label>Слово или точная фраза<input type="search" required maxlength="200" bind:value={searchText} /></label>
    <button type="submit">Найти</button>
  </form>
  <Notice kind="error" message={searchProblem} />
  {#if search}
    <p class="meta">Результаты поиска без модели по запросу «{submittedSearch}»</p>
    {#if !search.sources.length}
      <p>В доступных для поиска материалах совпадений нет.</p>
    {:else if search.mode === 'originals'}
      {@render sources(search.sources)}
    {:else}
      <ul class="plain-list copilot-sources">
        {#each search.sources as item (item.id)}
          <li>
            <a href={projectLink(item.id)}>Опубликованный фрагмент · стр. {item.page}</a>
            <blockquote>{item.quote}</blockquote>
          </li>
        {/each}
      </ul>
    {/if}
    {#if search.mode === 'originals' && search.windows?.length}
      <h3>Адреса с остатком проверки</h3>
      {@render sources(search.windows)}
    {/if}
    {@render limits(search.limitations)}
  {:else if submittedSearch && !searchProblem}
    <p role="status">Ищем совпадения…</p>
  {/if}
</section>
</div>

<style>
  .copilot-sources li { border-top: 1px solid var(--line, #d7dce0); padding-block: .5rem; }
  .copilot-sources p { margin-block: .3rem; }
  blockquote, .answer { white-space: pre-wrap; overflow-wrap: anywhere; }
  .source-chip { display: inline-flex; align-items: center; min-height: 40px; padding: 4px 10px;
    border: 1px solid var(--line); background: var(--field); border-radius: 6px; }
  .source-panel { min-width: 0; overflow-wrap: anywhere; }
  .source-panel iframe { display: block; width: 100%; min-height: 45dvh; border: 1px solid var(--line); margin-block: 8px; }
  @media (min-width: 1141px) {
    .copilot-layout:has(.source-panel) { display: grid; grid-template-columns: minmax(0, 45fr) minmax(0, 55fr); gap: 12px; align-items: start; }
    .source-panel { position: sticky; top: 64px; grid-column: 2; grid-row: 1 / span 4; max-height: calc(100dvh - 76px); overflow: auto; }
  }
  @media (max-width: 850px) {
    .source-panel { position: fixed; inset: 0; z-index: 10; border-radius: 0; margin: 0; overflow: auto; }
  }
</style>
