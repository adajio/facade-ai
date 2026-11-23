<script lang="ts">
  import { onDestroy, tick } from 'svelte';
  import { Commands } from '../lib/commands';
  import { ApiError, describe, id, interrupted, query, type Api } from '../lib/http';
  import { date, bytes, count, label } from '../lib/format';
  import {
    fileChecksum, itemPath, pendingReceipt, receiptPath, relativePath, sendFile, sendManifestFile,
    type Capabilities, type Inventory, type ManifestItem, type NewInput, type Occurrence, type Receipt, type Upload, type UploadProgress,
  } from '../lib/intake';
  import { projectApi, scopedUrl, type OpenEvidence, type Page, type Projection, type WorkspaceProps } from '../lib/workspace';
  import { workReceiptFilters, workSliceApi, type WorkReceiptFilter } from '../lib/work-slice';
  import Notice from '../lib/Notice.svelte';
  import Document from './Document.svelte';
  import IntakeHolds from './IntakeHolds.svelte';

  type ReceiptList = { receipts: Receipt[]; nextCursor?: number | string | null };
  type ReceiptSelection = 'present' | 'filtered' | 'missing';
  type WorkReceiptList = ReceiptList & {
    total: number; workSliceId: string; filter: WorkReceiptFilter; selection?: ReceiptSelection; selectedReceipt?: Receipt;
  };
  type PinnedInventory = Inventory & { workSliceId: string; historical: boolean };
  type Link = { id: string; receiptId: string; letterId: string; sentId: string; itemId?: string };
  type ImportEntry = { id: string; relativePath?: string; path?: string; status?: string; reason?: string; restriction?: string };

  let { api, context, projection, renew, open }: { api: Api; context: WorkspaceProps; projection?: Projection; renew: () => void; open: OpenEvidence } = $props();
  const commands = new Commands(() => api);
  const receiptFilters = Object.entries(workReceiptFilters) as [WorkReceiptFilter, string][];
  let list = $state<Receipt[]>([]);
  let nextCursor = $state<ReceiptList['nextCursor']>(null);
  let resolvedWorkSlice = $state('');
  let totalReceipts = $state<number>();
  let selection = $state<ReceiptSelection>();
  let selectedReceipt = $state<Receipt>();
  let sliceRefreshed = $state(false);
  let inventoryUnavailable = $state(false);
  let refreshingInventory = $state(false);
  let inventory = $state<Inventory>();
  let technicalEntries = $state<ImportEntry[]>([]);
  let entriesCursor = $state<string | null>(null);
  let capabilities = $state<Capabilities>();
  let formats = $state<Capabilities>();
  let links = $state<Link[]>([]);
  let error = $state('');
  let detailError = $state('');
  let importError = $state('');
  let operationError = $state('');
  let success = $state('');
  let loading = $state(false);
  let paging = $state(false);
  let technicalPaging = $state(false);
  let form = $state(false);
  let leaveOpen = $state(false);
  let resumeItems = $state(false);
  let excludingItem = $state('');
  let exclusionReason = $state('');
  let continuation = $state('');
  let navigationLink: HTMLAnchorElement;
  let openInventoryLink = $state('');
  let draft: { receiptId: string; version?: number; items: NewInput[]; mode: 'once' | 'open' } | undefined;
  let channel = $state<'file' | 'folder' | 'link'>('file');
  let files = $state<File[]>([]);
  let linkUrl = $state('');
  let declareScope = $state(false);
  let replacements = $state('');
  let existing = $state('');
  let active = $state('');
  let activeReceipt = $derived(active || context.objectId || '');
  let activeDocument = $derived(context.params.get('document') ?? '');
  let activeRow = $derived(context.params.get('row') ?? '');
  let selectedDocument = $derived(
    inventory?.receiptId === activeReceipt && inventory.projectId === context.project.id && activeDocument
      ? inventory.occurrences.find((item) => item.versionId === activeDocument && (!activeRow || item.occurrenceId === activeRow))
      : undefined,
  );
  let pendingItems = $derived(inventory?.manifest?.items.filter(item => !['accepted', 'excluded'].includes(item.status)) ?? []);
  let lastFocused = '';
  $effect(() => {
    const row = !activeDocument && inventory?.receiptId === activeReceipt ? activeRow : '';
    if (!row) { lastFocused = ''; return; }
    if (lastFocused === row) return;
    void tick().then(() => {
      const element = document.getElementById('occurrence-' + row);
      if (element && !context.params.has('document')) {
        lastFocused = row;
        element.focus();
      }
    });
  });
  let priorObjectId: string | undefined;
  $effect(() => {
    if (context.objectId !== priorObjectId) {
      priorObjectId = context.objectId;
      active = '';
      continuation = '';
    }
  });
  let priorUpload: string | null;
  $effect(() => {
    const upload = context.params.get('upload');
    if (upload !== priorUpload) {
      priorUpload = upload;
      if (upload === '1' || upload === 'link') startNew(upload === 'link' ? 'link' : 'file');
    }
  });
  $effect(() => {
    const project = context.project.id;
    const opened = context.objectId;
    const stored = pendingReceipt(project);
    if (!stored || opened === stored) return;
    const stop = new AbortController();
    api.json<Inventory>(receiptPath(stored) + '/inventory', { signal: stop.signal })
      .then((value) => {
        if (value.projectId !== project || value.receiptId !== stored || !value.manifest) return;
        continuation = stored;
      })
      .catch(() => {});
    return () => stop.abort();
  });
  let pending = $state(false);
  let progress = $state<Parameters<UploadProgress>[0]>();
  let workingFile = $state('');
  let uploadSignal: AbortController | undefined;
  let batch = new Map<File, string>();
  let finished = new Set<File>();
  let projectId = $derived(context.project.id);
  let filter = $derived<WorkReceiptFilter>(
    context.filter === 'processing' ? 'processing' : context.filter === 'open' || context.filter === 'uploading' ? 'open' : 'all',
  );
  let workScope = $derived(context.project.intakeMode && !context.project.scopeId ? undefined : context.scopeId);
  let requestedWorkSlice = $derived(context.params.get('workSlice') ?? '');
  let usesWorkSlice = $derived(Boolean(requestedWorkSlice) || filter === 'processing');
  let receiptSelection = $derived(usesWorkSlice ? context.objectId : undefined);
  let listRefresh = $derived(usesWorkSlice ? 0 : context.refreshKey);
  let listContext = $derived(JSON.stringify([
    context.project.id, context.scopeId, filter, requestedWorkSlice, receiptSelection, context.params.get('slice'),
  ]));
  let detailWorkSlice = $derived(
    usesWorkSlice && selectedReceipt?.receiptId === activeReceipt && selectedReceipt.inventoryOpen === false
      ? resolvedWorkSlice : '',
  );
  let awaitingReceiptSelection = $derived(
    usesWorkSlice && activeReceipt === receiptSelection && selectedReceipt?.receiptId !== activeReceipt,
  );
  let inventoryRefresh = $derived(detailWorkSlice ? 0 : context.refreshKey);
  let previousListContext = '';
  let retainedWorkSlice = '';
  let listRequest: AbortController | undefined;
  let linkedLetter = $derived(context.params.get('letter') ?? '');
  let linkedSent = $derived(context.params.get('sent') ?? '');
  let linkedItem = $derived(context.params.get('item') ?? '');

  $effect(() => {
    const path = projectApi(context.project.id);
    const stop = new AbortController();
    api.json<Capabilities>(path + '/intake/capabilities', { signal: stop.signal }).then((value) => capabilities = value)
      .catch((problem) => { if (!interrupted(problem)) error = describe(problem); });
    api.json<Capabilities>('/api/imports/capabilities', { signal: stop.signal }).then((value) => formats = value)
      .catch((problem) => { if (!interrupted(problem)) importError = describe(problem); });
    return () => stop.abort();
  });

  $effect(() => {
    const project = projectId;
    const selectedFilter = filter;
    const scope = workScope;
    const pinned = requestedWorkSlice;
    const sliced = usesWorkSlice;
    const receipt = receiptSelection;
    const location = listContext;
    void listRefresh;
    const stop = new AbortController();
    listRequest = stop;
    loading = true;
    paging = false;
    error = '';
    nextCursor = null;
    let slice = pinned;
    if (previousListContext !== location) {
      list = [];
      retainedWorkSlice = pinned;
      resolvedWorkSlice = '';
      totalReceipts = undefined;
      selection = undefined;
      selectedReceipt = undefined;
      sliceRefreshed = false;
    } else {
      slice = retainedWorkSlice;
    }
    previousListContext = location;

    async function openList() {
      if (!sliced) {
        const page = await readLegacyReceipts(project, selectedFilter, stop.signal);
        applyPage(page, false, stop.signal, location);
        return;
      }
      let refreshed = false;
      const current = slice || await currentWorkSlice(project, scope, stop.signal);
      let page: WorkReceiptList;
      try {
        page = await readWorkReceipts(project, current, selectedFilter, stop.signal, { receiptId: receipt });
      } catch (problem) {
        if (!needsCurrentSlice(problem)) throw problem;
        page = await readCurrentReceipts(project, scope, selectedFilter, stop.signal, receipt);
        refreshed = true;
      }
      if (applyPage(page, false, stop.signal, location) && refreshed) sliceRefreshed = true;
    }

    void openList().catch((problem) => {
      if (!stop.signal.aborted) error = describe(problem);
    }).finally(() => {
      if (!stop.signal.aborted) loading = false;
    });
    return () => stop.abort();
  });

  let previousInventoryPath = '';
  $effect(() => {
    const receipt = activeReceipt;
    const project = projectId;
    const slice = detailWorkSlice;
    void inventoryRefresh;
    const path = !receipt || awaitingReceiptSelection ? '' : inventoryPath(project, receipt, slice);
    if (previousInventoryPath !== path) {
      inventory = undefined;
      links = [];
      technicalEntries = [];
      entriesCursor = null;
    }
    previousInventoryPath = path;
    inventoryUnavailable = false;
    detailError = '';
    if (!path) return;

    const stop = new AbortController();
    const { signal } = stop;
    void api.json<Inventory | PinnedInventory>(path, { signal }).then((value) => {
      if (signal.aborted) return;
      if (value.projectId !== project || value.receiptId !== receipt || (slice &&
          (!('workSliceId' in value) || value.workSliceId !== slice || !value.historical ||
           !value.sealed || value.inventoryOpen))) {
        inventory = undefined;
        detailError = 'Сервер не подтвердил выбранную опись.';
        return;
      }
      inventory = value;
      if (value.manifest && pendingReceipt(project) === receipt) {
        pendingReceipt(project, null);
        continuation = '';
      }
    }).catch((problem) => {
      if (signal.aborted) return;
      inventory = undefined;
      inventoryUnavailable = Boolean(slice) && (needsCurrentSlice(problem) ||
        problem instanceof ApiError && problem.status === 409 && problem.code === 'inventory_snapshot_unavailable');
      detailError = inventoryUnavailable ? 'Закреплённая опись недоступна.' : describe(problem);
    });
    if (!slice) {
      api.json<{ items: Link[] }>(query(projectApi(project) + '/supplements/links', { receiptId: receipt }), { signal })
        .then((page) => { if (!signal.aborted) links = page.items; })
        .catch(() => { if (!signal.aborted) links = []; });
      api.json<Page<ImportEntry> & { entries?: ImportEntry[] }>(receiptPath(receipt) + '/import-inventory', { signal })
        .then((page) => {
          if (signal.aborted) return;
          technicalEntries = page.entries ?? page.items ?? [];
          entriesCursor = page.nextCursor ?? null;
        })
        .catch(() => { if (!signal.aborted) { technicalEntries = []; entriesCursor = null; } });
    }
    return () => stop.abort();
  });

  onDestroy(() => uploadSignal?.abort());

  function intakeStatus(status: string) {
    switch (status) {
      case 'accepted': return 'Принят';
      case 'declared': return 'Ожидает передачи';
      case 'excluded': return 'Исключён из состава';
      case 'expired': return 'Срок докачки истёк';
      case 'paused': return 'Приостановлено';
      case 'limited': return 'С ограничением';
      default: return label(status);
    }
  }

  function url(receipt?: string, params: Record<string, unknown> = {}) {
    return scopedUrl(context.project.id, 'receipts', {
      scope: context.scopeId, filter: context.filter, slice: context.params.get('slice'),
      workSlice: resolvedWorkSlice || requestedWorkSlice, ...params,
    }, receipt);
  }

  function inventoryPath(project: string, receipt: string, slice?: string) {
    return (slice ? workSliceApi(project, slice) + '/receipts/' + id(receipt) : receiptPath(receipt)) + '/inventory';
  }

  async function navigateToInventory(href: string) {
    openInventoryLink = href;
    await tick();
    navigationLink?.click();
  }

  async function enterInventory(receiptId: string) {
    if (context.objectId === receiptId) return;
    if (usesWorkSlice) {
      // A newly created receipt belongs to a new slice.
      try {
        const fresh = await currentWorkSlice(projectId, workScope, AbortSignal.timeout(5000));
        await navigateToInventory(url(receiptId, { workSlice: fresh, filter }));
        return;
      } catch {
        await navigateToInventory(url(receiptId, { workSlice: '', filter: filter === 'open' ? 'open' : '' }));
        return;
      }
    }
    await navigateToInventory(url(receiptId));
  }

  async function openCurrentInventory() {
    if (refreshingInventory || !receiptSelection) return;
    const receipt = receiptSelection;
    const location = listContext;
    refreshingInventory = true;
    try {
      const fresh = await currentWorkSlice(projectId, workScope, AbortSignal.timeout(5000));
      if (listContext !== location) return;
      if (fresh === resolvedWorkSlice) {
        detailError = selection === 'missing'
          ? 'Поступление отсутствует и в актуальном срезе.'
          : 'Актуальный срез пока не подтвердил опись.';
        return;
      }
      const params = Object.fromEntries(context.params);
      await navigateToInventory(url(receipt, { ...params, workSlice: fresh, filter }));
    } catch (problem) {
      if (listContext === location) detailError = describe(problem);
    } finally {
      refreshingInventory = false;
    }
  }

  function needsCurrentSlice(problem: unknown) {
    return problem instanceof ApiError && problem.status === 409 && problem.code === 'snapshot_required';
  }

  function readLegacyReceipts(project: string, selectedFilter: WorkReceiptFilter, signal: AbortSignal, cursor?: string | number) {
    const state = selectedFilter === 'open' ? 'uploading' : undefined;
    return api.json<ReceiptList>(query(projectApi(project) + '/receipts', { state, cursor }), { signal });
  }

  async function currentWorkSlice(project: string, scopeId: string | undefined, signal: AbortSignal) {
    const path = query(workSliceApi(project), { scopeId });
    const current = await api.json<{ workSliceId: string }>(path, { signal });
    return current.workSliceId;
  }

  async function readWorkReceipts(
    project: string, slice: string, selectedFilter: WorkReceiptFilter, signal: AbortSignal,
    after: { cursor?: string | number; receiptId?: string } = {},
  ) {
    const path = query(workSliceApi(project, slice) + '/receipts', { filter: selectedFilter, ...after });
    const page = await api.json<WorkReceiptList>(path, { signal });
    if (page.workSliceId !== slice || page.filter !== selectedFilter) {
      throw new ApiError(502, 'work_slice_mismatch', 'Сервер вернул список другого среза или фильтра.');
    }
    return page;
  }

  async function readCurrentReceipts(
    project: string, scopeId: string | undefined, selectedFilter: WorkReceiptFilter, signal: AbortSignal, receiptId?: string,
  ) {
    return readWorkReceipts(project, await currentWorkSlice(project, scopeId, signal), selectedFilter, signal, { receiptId });
  }

  function applyPage(page: ReceiptList | WorkReceiptList, append: boolean, signal: AbortSignal, location: string) {
    if (signal.aborted || listContext !== location) return false;
    if ('workSliceId' in page) {
      retainedWorkSlice = page.workSliceId;
      resolvedWorkSlice = page.workSliceId;
      totalReceipts = page.total;
      if (!append) {
        selection = page.selection;
        selectedReceipt = page.selectedReceipt;
      }
    }
    if (append) {
      const prior = new Set(list.map(item => item.receiptId));
      list = [...list, ...page.receipts.filter(item => !prior.has(item.receiptId))];
    } else {
      list = page.receipts;
    }
    nextCursor = page.nextCursor ?? null;
    return true;
  }

  async function loadMore() {
    const signal = listRequest?.signal;
    const cursor = nextCursor;
    if (!signal || signal.aborted || paging || cursor == null) return;
    const location = listContext;
    const project = context.project.id;
    const selectedFilter = filter;
    const scope = workScope;
    const slice = resolvedWorkSlice;
    const receipt = receiptSelection;
    paging = true;
    error = '';
    try {
      const page = slice
        ? await readWorkReceipts(project, slice, selectedFilter, signal, { cursor })
        : await readLegacyReceipts(project, selectedFilter, signal, cursor);
      applyPage(page, true, signal, location);
    } catch (problem) {
      if (signal.aborted || location !== listContext) return;
      if (!slice || !needsCurrentSlice(problem)) {
        error = describe(problem);
        return;
      }
      try {
        const fresh = await readCurrentReceipts(project, scope, selectedFilter, signal, receipt);
        if (applyPage(fresh, false, signal, location)) sliceRefreshed = true;
      } catch (refreshError) {
        if (!signal.aborted && location === listContext) error = describe(refreshError);
      }
    } finally {
      if (!signal.aborted && location === listContext) paging = false;
    }
  }

  async function loadTechnical() {
    if (!entriesCursor || technicalPaging || detailWorkSlice) return;
    const observed = context.refreshKey;
    const receipt = activeReceipt;
    technicalPaging = true;
    try {
      const page = await api.json<{ entries: ImportEntry[]; nextCursor?: string }>(
        query(receiptPath(receipt) + '/import-inventory', { cursor: entriesCursor }),
      );
      if (observed !== context.refreshKey || receipt !== activeReceipt || detailWorkSlice) return;
      technicalEntries = [...technicalEntries, ...page.entries];
      entriesCursor = page.nextCursor ?? null;
    } catch (problem) {
      if (receipt === activeReceipt && !detailWorkSlice) importError = describe(problem);
    } finally {
      technicalPaging = false;
    }
  }

  function selectFiles(event: Event) {
    files = Array.from((event.currentTarget as HTMLInputElement).files ?? []);
    draft = undefined;
    batch = new Map();
    finished = new Set();
  }

  function folder(input: HTMLInputElement) {
    input.setAttribute('webkitdirectory', '');
  }

  function resume(upload: Upload) {
    active = inventory?.receiptId ?? '';
    existing = upload.uploadId;
    resumeItems = false;
    channel = 'file';
    form = true;
    files = [];
    finished = new Set();
    batch = new Map();
  }

  function startNew(method: 'file' | 'link' = 'file') {
    form = true;
    active = '';
    existing = '';
    resumeItems = false;
    leaveOpen = false;
    draft = undefined;
    linkUrl = '';
    declareScope = false;
    channel = method;
    files = [];
    batch = new Map();
    finished = new Set();
    operationError = '';
    success = '';
  }

  function selectManifestFiles() {
    draft = undefined;
    operationError = '';
    active = inventory?.receiptId ?? '';
    resumeItems = true;
    existing = '';
    channel = 'file';
    files = [];
    form = true;
  }

  function addToReceipt() {
    draft = undefined;
    operationError = '';
    linkUrl = '';
    active = inventory?.receiptId ?? '';
    existing = '';
    resumeItems = false;
    channel = 'file';
    files = [];
    batch = new Map();
    finished = new Set();
    form = true;
  }

  async function readInventory(receiptId: string, signal: AbortSignal) {
    const value = await api.json<Inventory>(inventoryPath(projectId, receiptId), { signal });
    if (value.projectId !== projectId || value.receiptId !== receiptId) throw new Error('Поступление недоступно.');
    inventory = value;
    active = receiptId;
    return value;
  }

  async function transferManifest(signal: AbortSignal) {
    const project = context.project.id;
    const current = active && inventory?.receiptId === active ? inventory : undefined;
    const selected = [];
    for (const file of channel === 'link' ? [] : files) {
      workingFile = relativePath(file);
      const sha256 = await fileChecksum(file, signal, (value) => progress = value);
      selected.push({ file, sha256 });
    }
    let view: Inventory;
    let submittedItems: Set<string> | undefined;
    if (resumeItems && current) {
      view = await readInventory(current.receiptId, signal);
    } else {
      const scopeIds = declareScope && context.scopeId ? [context.scopeId] : undefined;
      draft ??= {
        receiptId: current?.receiptId ?? crypto.randomUUID(),
        version: current?.manifest?.version,
        mode: leaveOpen ? 'open' : 'once',
        items: channel === 'link'
          ? [{ itemId: crypto.randomUUID(), kind: 'link', url: linkUrl.trim(), scopeIds }]
          : selected.map(({ file, sha256 }) => ({
              itemId: crypto.randomUUID(), kind: 'file', relativePath: relativePath(file),
              size: file.size, mediaType: file.type || undefined, sha256, scopeIds,
            })),
      };
      const declaration = draft;
      if (declaration.version === undefined) pendingReceipt(project, declaration.receiptId);
      try {
        if (declaration.version === undefined) {
          await api.mutate(projectApi(project) + '/receipts', 'POST', {
            receiptId: declaration.receiptId, mode: declaration.mode, items: declaration.items,
          }, { key: declaration.receiptId }, signal);
        } else {
          await commands.send(receiptPath(declaration.receiptId) + '/manifest', 'POST', {
            manifestVersion: declaration.version, items: declaration.items,
          }, undefined, signal);
        }
        view = await readInventory(declaration.receiptId, signal);
      } catch (problem) {
        // A read settles the outcome of a declaration whose response didn't arrive.
        try {
          view = await readInventory(declaration.receiptId, AbortSignal.timeout(5000));
        } catch {
          throw problem;
        }
        if (!declaration.items.every(item => view.manifest?.items.some(saved => saved.itemId === item.itemId))) {
          const committedCreate = declaration.version === undefined && view.manifest;
          if (!committedCreate) { draft = undefined; throw problem; }
          draft = undefined;
          throw new Error('Состав уже сохранён. Продолжите передачу из описи.');
        }
        if (signal.aborted) throw signal.reason;
      }
      submittedItems = new Set(declaration.items.map(item => item.itemId));
      draft = undefined;
    }

    const remaining = view.manifest?.items.filter(item =>
      item.kind !== 'link' && item.status !== 'excluded' && (!submittedItems || submittedItems.has(item.itemId)),
    ) ?? [];
    remaining.sort((a, b) => Number(a.status === 'accepted') - Number(b.status === 'accepted'));
    for (const { file, sha256 } of selected) {
      const index = remaining.findIndex(item =>
        item.relativePath === relativePath(file) && item.size === file.size && item.sha256 === sha256,
      );
      if (index < 0) throw new Error('Выбранный файл не совпадает с составом поступления.');
      const [item] = remaining.splice(index, 1);
      if (item.status === 'accepted') continue;
      workingFile = relativePath(file);
      await sendManifestFile({
        api, commands, receiptId: view.receiptId, item, file, checksum: sha256, signal,
        onProgress: (value) => progress = value,
      });
    }
    success = channel === 'link' ? 'Ссылка сохранена. Раскрытие источника выполняется в фоне.'
      : 'Передача завершена. Принятые оригиналы доступны в описи.';
  }

  async function transfer(event: SubmitEvent) {
    event.preventDefault();
    if (pending) return;
    operationError = '';
    success = '';
    progress = undefined;
    const controller = new AbortController();
    const signal = controller.signal;
    uploadSignal = controller;
    pending = true;
    const managed = !linkedLetter && !existing && (!active || Boolean(inventory?.manifest));
    try {
      if (managed) {
        await transferManifest(signal);
        form = false;
        files = [];
        linkUrl = '';
        return;
      }
      if (!active) {
        const result = await commands.send<Receipt>(projectApi(context.project.id) + '/receipts', 'POST', {
          source: channel === 'link' ? 'import' : 'upload',
        }, undefined, signal);
        active = result.receiptId;
      }
      const receiptId = active;
      const base = receiptPath(receiptId);
      const scopeId = declareScope ? context.scopeId : '';
      if (linkedLetter && linkedSent) {
        await commands.send(projectApi(context.project.id) + '/supplements/links', 'POST', {
          receiptId, letterId: linkedLetter, sentId: linkedSent, itemId: linkedItem || null,
        }, undefined, signal);
      }
      if (channel === 'link') {
        await commands.send(base + '/imports', 'POST', {
          url: linkUrl.trim(), scopeIds: scopeId ? [scopeId] : undefined,
        }, undefined, signal);
        await commands.send(base + '/seal', 'POST', {}, undefined, signal);
        linkUrl = '';
        success = 'Ссылка принята. Загрузка поставлена в очередь.';
        form = false;
        return;
      }
      const selected = existing ? (inventory?.uploads ?? []).find((upload) => upload.uploadId === existing) : undefined;
      if (existing && (!selected || files.length !== 1)) throw new Error('Выберите исходный файл для этой передачи.');
      for (const file of files) {
        if (finished.has(file)) continue;
        workingFile = relativePath(file);
        const recoveredId = batch.get(file);
        const previous = recoveredId ? await api.json<Upload>('/api/uploads/' + id(recoveredId), { signal }) : selected;
        let acrossNavigation = previous;
        if (!acrossNavigation && inventory?.receiptId === receiptId) {
          const occurrence = inventory.occurrences.find((item) => item.relativePath === relativePath(file));
          if (occurrence) acrossNavigation = inventory.uploads.find((item) => item.occurrenceId === occurrence.occurrenceId && item.status === 'uploading');
        }
        await sendFile({
          api, commands, receiptId, file, scopeId, previous: acrossNavigation, replacements, signal,
          remember: (uploadId) => batch.set(file, uploadId),
          onProgress: (value) => progress = value,
        });
        finished.add(file);
      }
      success = 'Файлы приняты. Опись доступна до завершения чтения.';
      existing = '';
      files = [];
      form = false;
      replacements = '';
    } catch (problem) {
      operationError = interrupted(problem) ? 'Передача приостановлена. Уже принятые части сохранены.'
        : problem instanceof Error && !(problem instanceof TypeError) && !(problem instanceof ApiError)
          ? problem.message : describe(problem);
    } finally {
      pending = false;
      workingFile = '';
      if (managed && active && context.objectId !== active) {
        const received = active;
        form = false;
        draft = undefined;
        await enterInventory(received);
      }
      renew();
    }
  }

  async function exclude(event: SubmitEvent, item: ManifestItem) {
    event.preventDefault();
    if (!inventory?.manifest) return;
    const done = await mutate(itemPath(inventory.receiptId, item.itemId) + '/exclude', 'Вход исключён из состава.', {
      manifestVersion: inventory.manifest.version, uploadId: item.uploadId, importId: item.importId,
      reason: exclusionReason,
    });
    if (done) excludingItem = '';
  }

  async function mutate(path: string, message: string, body: unknown = {}) {
    if (pending) return;
    pending = true;
    operationError = '';
    try {
      await commands.send(path, 'POST', body);
      success = message;
      return true;
    } catch (problem) {
      operationError = describe(problem);
    } finally {
      pending = false;
      renew();
    }
  }
</script>

<a href={openInventoryLink} bind:this={navigationLink} hidden>К описи</a>
<div class="actions receipt-actions">
  {#if context.canEdit}<button type="button" class="primary" disabled={pending} onclick={() => startNew()}>Загрузить комплект</button>{/if}
  {#if continuation && continuation !== activeReceipt}
    <a class="button" href={url(continuation)}>Открыть сохранённое поступление</a>
  {/if}
  {#if usesWorkSlice}
    <nav class="actions" aria-label="Фильтры поступлений">
      {#each receiptFilters as [candidate, title] (candidate)}
        <a class="button" aria-current={filter === candidate ? 'page' : undefined}
          href={url(context.objectId, { filter: candidate, row: activeRow })}>{title}</a>
      {/each}
    </nav>
  {:else}
    <a class="button" href={url(undefined, { filter: filter === 'open' ? '' : 'open' })}>
      {filter === 'open' ? 'Все поступления' : 'Открытые описи'}
    </a>
  {/if}
</div>

{#if context.canEdit && (form || (linkedLetter && linkedSent))}
  <section class="card" aria-labelledby="upload-title">
    <div class="card-header">
      <h2 id="upload-title">{existing || resumeItems ? 'Продолжить передачу' : linkedLetter ? 'Досылка к письму' : active ? 'Добавить исходные данные' : 'Новое поступление'}</h2>
      {#if capabilities?.maxReceiptBytes}<span class="meta">До {bytes(capabilities.maxReceiptBytes)} на поступление</span>{/if}
    </div>
    {#if capabilities?.partSize || capabilities?.uploadTtlSeconds}
      <p class="meta">{[
        capabilities?.partSize ? 'Размер части ' + bytes(capabilities.partSize) : '',
        capabilities?.uploadTtlSeconds ? 'Докачка в течение ' + count(capabilities.uploadTtlSeconds) + ' с' : '',
      ].filter(Boolean).join(' · ')}</p>
    {/if}
    {#if formats?.archiveFormats?.length}
      <p class="meta">Архивы · {formats.archiveFormats.map((format) => format.toUpperCase()).join(', ')}
        {#if formats.archiveIsolationConfigured === false} · Раскрытие архивов на этом стенде ограничено{/if}
      </p>
    {/if}
    <form onsubmit={transfer} aria-label="Передача исходных данных">
      {#if !existing}
        <label>Способ передачи<select aria-label="Способ передачи" bind:value={channel} onchange={() => { draft = undefined; files = []; }} disabled={pending}>
          <option value="file">Файлы или архивы</option>
          <option value="folder">Папка</option>
          {#if !resumeItems}<option value="link">Публичная ссылка Яндекс.Диска</option>{/if}
        </select></label>
      {/if}
      {#if channel === 'link'}
        <label>Публичная ссылка<input type="url" bind:value={linkUrl} oninput={() => draft = undefined} required disabled={pending} /></label>
        <Notice message={importError} />
      {:else if channel === 'folder'}
        <label>Папка<input type="file" use:folder multiple required onchange={selectFiles} disabled={pending} /></label>
      {:else}
        <label>{existing ? 'Исходный файл' : 'Файлы или архивы'}<input type="file" multiple={!existing} required onchange={selectFiles} disabled={pending} /></label>
      {/if}
      {#if !active && !resumeItems && !linkedLetter}
        <label><input type="checkbox" bind:checked={leaveOpen} onchange={() => draft = undefined} disabled={pending} /> Оставить приём открытым</label>
      {/if}
      {#if context.scopeId && !existing && !resumeItems}
        <label><input type="checkbox" bind:checked={declareScope} onchange={() => draft = undefined} disabled={pending} /> Применимость ограничена выбранной областью</label>
      {/if}
      {#if resumeItems}<p class="meta">Выберите исходные файлы или папку из сохранённого состава.</p>{/if}
      {#if files.length}<p class="meta">{files.length} файлов · {bytes(files.reduce((sum, file) => sum + file.size, 0))}</p>{/if}
      {#if progress}
        <div role="status">
          <p>{progress.phase === 'hashing' ? 'Проверка контрольной суммы' : 'Подтверждено сервером'} · {workingFile || 'Файл'} · {bytes(progress.bytes)} из {bytes(progress.total)}</p>
          <progress value={progress.bytes} max={progress.total || 1}></progress>
        </div>
      {/if}
      <div class="actions">
        <button class="primary" disabled={pending}>{existing || resumeItems ? 'Продолжить передачу' : channel === 'link' ? 'Принять ссылку' : 'Начать передачу'}</button>
        {#if pending}<button type="button" onclick={() => uploadSignal?.abort()}>Приостановить</button>
        {:else if !linkedLetter}<button type="button" class="quiet" onclick={() => { form = false; existing = ''; resumeItems = false; }}>Закрыть</button>{/if}
      </div>
    </form>
  </section>
{/if}

<Notice kind="error" message={operationError} />
<Notice kind="success" message={success} />
<Notice kind="error" message={error} />
{#if sliceRefreshed}
  <p class="notice" role="status">Срез устарел. Список перечитан с актуального среза.
    <a href={url(context.objectId, { ...Object.fromEntries(context.params), workSlice: resolvedWorkSlice, filter })}>Ссылка на актуальный срез</a>
  </p>
{/if}

{#if selection === 'filtered'}
  <Notice message="Выбранное поступление не входит в этот фильтр." />
{:else if selection === 'missing'}
  <Notice message="Выбранное поступление отсутствует в этом срезе." />
{/if}

{#if loading && !list.length}<p role="status">Открываем список поступлений…</p>{/if}
{#if list.length || (!loading && !error)}
  <section class="card table-card">
    <div class="card-header">
      <h2>{filter === 'processing' ? 'Поступления в обработке' : filter === 'open' ? 'Открытые описи' : 'Реестр поступлений'}</h2>
      {#if totalReceipts !== undefined}<span class="meta">Всего · {count(totalReceipts)}</span>{/if}
    </div>
    {#if list.length}
      <div class="table-wrap">
        <table><thead><tr><th>Поступление</th><th>Канал</th><th>Опись</th><th>Принято</th></tr></thead>
          <tbody>
            {#each list as receipt (receipt.receiptId)}
              <tr>
                <td><a class="row-link" href={url(receipt.receiptId)} aria-current={receipt.receiptId === activeReceipt ? 'true' : undefined}>Поступление №{receipt.number}</a></td>
                <td>{receipt.source === 'import' ? 'Ссылка' : 'Файлы'}</td>
                <td>{receipt.inventoryOpen ? 'Открыта' : 'Зафиксирована'}</td>
                <td>{date(receipt.createdAt)}</td>
              </tr>
            {/each}
          </tbody>
        </table>
      </div>
      {#if nextCursor != null}<div class="card-header"><button type="button" onclick={loadMore} disabled={paging}>Ещё поступления</button></div>{/if}
    {:else}
      <p class="empty">В этом списке поступлений пока нет.</p>
    {/if}
  </section>
{/if}

<IntakeHolds {api} {context} {projection} {renew} receiptId={activeReceipt} />
<Notice kind="error" message={detailError} />
{#if selection === 'missing' || inventoryUnavailable}
  <button type="button" disabled={refreshingInventory} onclick={openCurrentInventory}>Открыть актуальную опись</button>
{/if}
{#if inventory && inventory.receiptId === activeReceipt && inventory.projectId === context.project.id}
  <section class="card" aria-labelledby="receipt-title">
    <div class="card-header">
      <h2 id="receipt-title">Поступление №{inventory.number}</h2>
      <span class="pill">{inventory.inventoryOpen ? 'Опись открыта' : 'Опись зафиксирована'}</span>
    </div>
    {#if inventory.manifest}
      <p>{inventory.sealed ? 'Приём завершён' : inventory.manifest.mode === 'open' ? 'Приём оставлен открытым' : 'Разовая передача'}
        · Осталось входов: {count(pendingItems.length)}</p>
      {#if context.canEdit && !inventory.sealed}
        <div class="actions">
          {#if !(form && resumeItems) && pendingItems.some(item => item.kind !== 'link')}
            <button type="button" disabled={pending} onclick={selectManifestFiles}>Продолжить передачу</button>
          {/if}
          {#if inventory.manifest.mode === 'open'}
            <button type="button" disabled={pending} onclick={addToReceipt}>Добавить ещё</button>
            <button type="button" disabled={pending || pendingItems.length > 0}
              onclick={() => mutate(receiptPath(inventory!.receiptId) + '/seal', 'Приём завершён.', {
                manifestVersion: inventory!.manifest!.version,
              })}>Завершить приём</button>
          {/if}
        </div>
      {/if}
      <h3>Объявленный состав</h3>
      <ul class="plain-list">
        {#each inventory.manifest.items as item (item.itemId)}
          <li>
            <strong>{item.relativePath ?? 'Публичная ссылка Яндекс.Диска'}</strong>
            <p class="meta">
              {intakeStatus(item.status)}
              {item.size === null ? '' : ' · ' + bytes(item.confirmedBytes) + ' из ' + bytes(item.size)}
              {item.status === 'uploading' ? ' · докачка до ' + date(item.expiresAt) : ''}
              {item.reason && item.status !== 'expired' ? ' · ' + label(item.reason) : ''}
            </p>
            {#if context.canEdit && !inventory.sealed && !['accepted', 'excluded'].includes(item.status)}
              <div class="actions">
                {#if item.canRetry}
                  <button type="button" disabled={pending}
                    onclick={() => mutate(itemPath(inventory!.receiptId, item.itemId) + '/retry', 'Получение источника возобновлено.', { importId: item.importId })}>Повторить получение</button>
                {/if}
                {#if item.uploadId && item.status === 'uploading' && item.confirmedBytes === item.size}
                  <button type="button" disabled={pending}
                    onclick={() => mutate('/api/uploads/' + id(item.uploadId!) + '/complete', 'Оригинал принят.')}>Подтвердить сохранённый файл</button>
                {/if}
                {#if item.status !== 'running'}
                  <button type="button" disabled={pending} onclick={() => { excludingItem = item.itemId; exclusionReason = ''; }}>Исключить вход</button>
                {/if}
              </div>
              {#if excludingItem === item.itemId}
                <form onsubmit={(event) => exclude(event, item)}>
                  <label>Причина исключения<input bind:value={exclusionReason} required maxlength="1000" /></label>
                  <div class="actions">
                    <button class="primary" disabled={pending}>Подтвердить исключение</button>
                    <button type="button" disabled={pending} onclick={() => excludingItem = ''}>Отмена</button>
                  </div>
                </form>
              {/if}
            {/if}
          </li>
        {/each}
      </ul>
    {:else if context.canEdit && !inventory.sealed}
      <div class="actions">
        <button type="button" disabled={pending} onclick={addToReceipt}>Добавить файлы</button>
        <button type="button" disabled={pending} onclick={() => mutate(receiptPath(inventory!.receiptId) + '/seal', 'Объявление входов завершено.')}>Завершить объявление входов</button>
      </div>
    {/if}
    {#if !inventory.manifest && inventory.uploads.length}
      <h3>Передача</h3>
      <ul class="plain-list">
        {#each inventory.uploads as upload (upload.uploadId)}
          <li>
            <strong>{inventory.occurrences.find((item) => item.occurrenceId === upload.occurrenceId)?.relativePath ?? 'Файл'}</strong>
            <p class="meta">{label(upload.status)} · {bytes(upload.confirmedBytes)} из {bytes(upload.size)}{upload.status === 'uploading' ? ' · докачка до ' + date(upload.expiresAt) : ''}</p>
            {#if context.canEdit && upload.status === 'uploading'}
              <div class="actions">
                <button type="button" disabled={pending} onclick={() => resume(upload)}>Докачать файл</button>
                <button type="button" disabled={pending} onclick={() => mutate('/api/uploads/' + id(upload.uploadId) + '/cancel', 'Пустая передача отменена.')}>Отменить декларацию</button>
              </div>
            {/if}
          </li>
        {/each}
      </ul>
    {/if}
    {#if inventory.imports.length}
      <h3>Импорт</h3>
      <ul class="plain-list">
        {#each inventory.imports as item (item.importId)}
          <li>{label(item.status)} {item.reason ? ' · ' + label(item.reason) : ''}
            {#if context.canEdit && !inventory.manifest && !['completed', 'cancelled'].includes(item.status)}
              <button type="button" disabled={pending} onclick={() => mutate(receiptPath(inventory!.receiptId) + '/imports/' + id(item.importId) + '/cancel', 'Импорт отменён.')}>Отменить пустой импорт</button>
            {/if}
            {#if context.canEdit && ['limited', 'failed', 'paused'].includes(item.status)}
              <button type="button" disabled={pending} onclick={() => { startNew(); }}>Загрузить файлы напрямую</button>
            {/if}
          </li>
        {/each}
      </ul>
    {/if}
    {#if links.length}
      <h3>Переписка</h3>
      <ul class="plain-list">{#each links as link (link.id)}
        <li><a href={scopedUrl(context.project.id, 'letters', { scope: context.scopeId, sent: link.sentId }, link.letterId)}>Снимок отправки</a></li>
      {/each}</ul>
    {/if}
  </section>

  {#if !activeDocument}
  <section class="card table-card">
    <div class="card-header"><h2>Опись</h2></div>
    {#if inventory.occurrences.length}
      <div class="table-wrap">
        <table><thead><tr><th>Путь</th><th>Размер</th><th>Состояние</th><th>Оригинал</th></tr></thead>
          <tbody>{#each inventory.occurrences as item (item.occurrenceId)}
            <tr id={'occurrence-' + item.occurrenceId} tabindex="-1">
              <td>{item.relativePath}</td>
              <td>{bytes(item.size)}</td>
              <td>{intakeStatus(item.status)}{item.inventoryPending ? ' · раскрывается' : ''}{item.restriction ? ' · ' + label(item.restriction) : ''}</td>
              <td>{#if item.documentId && item.versionId}
                <a href={url(inventory.receiptId, { document: item.versionId, row: item.occurrenceId })}>Карточка документа</a>
              {/if}</td>
            </tr>
          {/each}</tbody>
        </table>
      </div>
    {:else}<p class="empty">В описи пока нет вхождений.</p>{/if}
  </section>
  {#if technicalEntries.length}
    <section class="card">
      <h2>Состав контейнеров</h2>
      <ul class="plain-list">{#each technicalEntries as item, index (item.id ?? index)}
        <li>{item.relativePath ?? item.path} · {label(item.status)} {item.reason ?? item.restriction ?? ''}</li>
      {/each}</ul>
      {#if entriesCursor}<button type="button" onclick={loadTechnical} disabled={technicalPaging}>Ещё элементы</button>{/if}
    </section>
  {/if}
  {:else}
    <p><a href={url(inventory.receiptId, { row: selectedDocument?.occurrenceId ?? activeRow })}>К описи</a></p>
    {#if selectedDocument?.documentId && selectedDocument.versionId}
      {#key selectedDocument.occurrenceId}
        <Document {api} {context} {renew} {open} occurrence={selectedDocument as Occurrence & { documentId: string; versionId: string }} />
      {/key}
    {:else}
      <Notice message="Документ недоступен." />
    {/if}
  {/if}
{/if}

<style>
  .receipt-actions { margin-bottom: .8rem; }
</style>
