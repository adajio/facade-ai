<script lang="ts">
  import { onDestroy } from 'svelte';
  import { Commands } from '../lib/commands';
  import { describe, id, query, type Api } from '../lib/http';
  import { date, label } from '../lib/format';
  import { originalUrl, renderAddress, representations, sourceVersions,
    type CopilotQuestion, type OriginalSource, type SearchResult, type SourceDetail, type VersionDetail } from '../lib/copilot';
  import { projectApi, scopedUrl, type WorkspaceProps } from '../lib/workspace';
  import Notice from '../lib/Notice.svelte';

  let { api, context }: { api: Api; context: WorkspaceProps } = $props();
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
    budget_exhausted: 'Свободная сумма в журнале шлюза исчерпана.',
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
  let versionId = $derived(context.params.get('version'));
  let unitId = $derived(context.params.get('unit'));
  let boxText = $derived(context.params.get('box'));
  let address = $derived(unitId ? (boxText ? unitId + ' · область ' + boxText + ' пт' : unitId) : 'Карта готовится');
  let page = $derived(version?.mediaType === 'application/pdf' && unitId && /^[1-9][0-9]{0,7}$/.test(unitId) ? Number(unitId) : undefined);

  function projectLink(source?: string | null, questionId = context.objectId) {
    return scopedUrl(context.project.id, 'copilot', { scope: context.scopeId, source }, questionId);
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
    void context.refreshKey;
    const q = submittedSearch;
    const path = query(base + '/search', { q, scopeId: context.scopeId });
    if (!q) return;
    return poll((signal) => api.json<SearchResult>(path, { signal }), (value, problem) => {
      search = value;
      searchProblem = problem;
    });
  });

  $effect(() => {
    void context.refreshKey;
    const key = context.objectId;
    const path = base;
    question = undefined;
    questionProblem = '';
    if (!context.canEdit || !key) return;
    return poll((signal) => api.json<CopilotQuestion>(path + '/questions/' + id(key), { signal }), (value, problem) => {
      question = value;
      questionProblem = problem;
    });
  });

  $effect(() => {
    void context.refreshKey;
    const key = sourceId;
    const path = base;
    source = undefined;
    sourceProblem = '';
    if (!key) return;
    return poll((signal) => api.json<SourceDetail>(query(path + '/sources', { id: key, scopeId: context.scopeId }), { signal }), (value, problem) => {
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
    if (busy || !questionText.trim()) return;
    busy = true;
    submissionProblem = '';
    try {
      const created = await commands.send<{ id: string }>(base + '/questions', 'POST',
        { question: questionText.trim() }, undefined, mounted.signal);
      if (!mounted.signal.aborted) window.location.assign(projectLink(null, created.id));
    } catch (error) {
      if (!mounted.signal.aborted) submissionProblem = describe(error);
    } finally {
      busy = false;
    }
  }
</script>

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
        <a href={projectLink(item.id)}>{item.label} · {renderAddress(item.address)}</a>
        <p class="meta">{sourceVersions[item.version]} · {item.window ? 'Осталось проверить' : representations[item.representation]}</p>
        {#if item.text}<blockquote>{item.text}</blockquote>{/if}
        {@render limits(item.limitations)}
      </li>
    {/each}
  </ul>
{/snippet}

{#if context.canEdit}
  <section class="card">
    <h2>Задать вопрос по комплекту</h2>
    <form onsubmit={ask}>
      <label>Вопрос инженера<textarea required maxlength="2000" bind:value={questionText}></textarea></label>
      <button type="submit" class="primary" disabled={busy}>Спросить помощника</button>
    </form>
    <Notice kind="error" message={submissionProblem} />
    {#if context.objectId}
      <Notice kind="error" message={questionProblem} />
      {#if !question && !questionProblem}<p role="status">Загружаем вопрос…</p>{/if}
      {#if question}
        <h3>{question.question}</h3>
        <p role="status"><strong>{statuses[question.state]}</strong>{#if question.reason} · {reasons[question.reason] ?? label(question.reason)}{/if}</p>
        {#if question.state === 'historical'}
          <p>Ответ сохранён по срезу от {date(question.asOf)}.</p>
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
              <li><a href={projectLink(citation.id)}>{citation.label} · {renderAddress(citation.address)}</a></li>
            {/each}
          </ul>
        {/each}
        {#if question.citations?.length}
          <h4>Открытые источники</h4>
          {@render sources(question.citations)}
        {/if}
        {#if question.partialSources?.length}
          <h4>Места, открытые до остановки</h4>
          <ul class="plain-list">
            {#each question.partialSources as source (source.id)}
              <li><a href={projectLink(source.id)}>{source.label} · {renderAddress(source.address)}</a> · {representations[source.representation]}</li>
            {/each}
          </ul>
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
  <section class="card">
    <div class="card-header"><h2>{context.canEdit ? 'Адрес в оригинале' : 'Опубликованный фрагмент'}</h2><a href={projectLink()}>Закрыть</a></div>
    <Notice kind="error" message={sourceProblem} />
    {#if source?.mode === 'originals'}
      {@const item = source.source}
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
      <a href={originalUrl(item.documentId, item.versionId, item.address.locator?.page)} target="_blank" rel="noopener noreferrer">Открыть оригинал этой версии</a>
    {:else if source?.mode === 'publications'}
      <p>Страница {source.source.page}</p>
      <blockquote>{source.source.quote}</blockquote>
    {:else if !sourceProblem}
      <p role="status">Проверяем доступ к источнику…</p>
    {/if}
  </section>
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

<style>
  .copilot-sources li { border-top: 1px solid var(--line, #d7dce0); padding-block: .5rem; }
  .copilot-sources p { margin-block: .3rem; }
  blockquote, .answer { white-space: pre-wrap; overflow-wrap: anywhere; }
</style>
