<script lang="ts">
  /**
   * Màn kiểm kê 2 bước (STK-01): 1. kiểm tồn sản phẩm → 2. kiểm tồn số lượng → chốt.
   * Nhập nhanh: gõ / quét mã rồi Enter (bước 2: Enter sang ô số lượng, Enter lần nữa để thêm); mã mới nhất luôn ở đầu.
   * Số tồn ERP ẩn đến khi bấm "Kiểm tra" (đếm mù). Danh sách tự lưu nháp.
   */
  import { m } from '$lib/paraglide/messages';
  import type { StockCountRow, StockCountRowState, StockCountView, Warehouse } from '@inoxpran/contracts';
  import { page as appPage } from '$app/state';
  import { goto } from '$app/navigation';
  import { onDestroy, onMount, tick } from 'svelte';
  import { AlertTriangle, Check, CircleAlert, CircleCheck, ClipboardCheck, DatabaseZap, ListPlus, Plus, RotateCcw, ScanSearch, Trash2, Undo2, XCircle } from 'lucide-svelte';
  import { api, ApiRequestError } from '$lib/api';
  import { dateTime, num } from '$lib/format';
  import { can } from '$lib/permissions';
  import { session } from '$lib/session.svelte';
  import { buildCodeIndex, countStatusLabel, lookupCode, pushNewest, rowStateLabel, type CountProduct } from '$lib/stock-count';
  import ConfirmDialog from '$lib/components/ConfirmDialog.svelte';
  import Dialog from '$lib/components/Dialog.svelte';
  import NumberInput from '$lib/components/NumberInput.svelte';

  type SkuEntry = { productId: string; sku: string };
  type QtyEntry = { productId: string; sku: string; quantity: string };
  type DisplayRow = { productId: string; sku: string; name: string; state: StockCountRowState | null; erpOnHand: number | null; difference: number | null; moved: boolean; entered: boolean };

  const id = $derived(appPage.params.id ?? '');
  let count = $state<StockCountView | null>(null);
  let products = $state<CountProduct[]>([]);
  const index = $derived(buildCodeIndex(products));
  const nameOf = $derived(new Map(products.map((product) => [product.id, product.name])));
  let skuList = $state<SkuEntry[]>([]);
  let qtyList = $state<QtyEntry[]>([]);
  let codeInput = $state('');
  let qtyInput = $state('');
  let codeEl = $state<HTMLInputElement>();
  let qtyEl = $state<HTMLInputElement>();
  let inputError = $state('');
  let inputNotice = $state('');
  let flashId = $state('');
  let loading = $state(true);
  let busy = $state(false);
  let error = $state('');
  let success = $state('');
  let saving = $state(false);
  let savedAt = $state<Date | null>(null);
  let localChanged = $state(false);
  let saveTimer: ReturnType<typeof setTimeout> | undefined;
  let saveChain: Promise<void> = Promise.resolve();

  // Hộp xác nhận chung
  let confirmOpen = $state(false);
  let confirmTitle = $state('');
  let confirmMessage = $state('');
  let confirmLabel = $state('');
  let confirmTone = $state<'primary' | 'navy' | 'danger'>('primary');
  let confirmAction: () => Promise<void> = async () => {};
  // Nhập trùng ở bước 2
  let duplicateOpen = $state(false);
  let duplicate = $state<{ product: CountProduct; existing: string; incoming: string } | null>(null);
  let addButton = $state<HTMLButtonElement>();
  // Sửa ERP
  let fixOpen = $state(false);
  let fixRow = $state<DisplayRow | null>(null);
  let fixTarget = $state('');
  /** Phiếu gộp (KK-ALL-01): kho ghi phần chênh lệch khi sửa ERP — mặc định kho chính (không phải kho hàng lỗi). */
  let fixWarehouse = $state('');
  let warehouses = $state<Warehouse[]>([]);
  const combined = $derived(count?.scope === 'ALL');
  /** Tồn từng kho của mã theo lần kiểm tra gần nhất (phiếu gộp). */
  const stockOf = (productId: string) => shownCheck?.byWarehouse?.[productId] ?? lastCheck?.byWarehouse?.[productId] ?? [];
  let fixReason = $state('');
  let fixError = $state('');
  // Chốt
  let finishOpen = $state(false);
  let finishNote = $state('');
  let finishAck = $state(false);
  let finishError = $state('');

  const isOpen = $derived(count?.status === 'SKU_CHECK' || count?.status === 'QTY_CHECK');
  const step = $derived<'SKU' | 'QTY'>(count?.status === 'SKU_CHECK' ? 'SKU' : 'QTY');
  const editable = $derived(isOpen && can.editWarehouses());
  const lastCheck = $derived(step === 'SKU' ? count?.skuStep.lastCheck ?? null : count?.qtyStep.lastCheck ?? null);
  /** Kết quả kiểm tra còn đúng với danh sách hiện tại (chưa sửa gì sau lần kiểm tra). */
  const fresh = $derived(Boolean(count && lastCheck && !localChanged && count.checkedRevision === count.revision));
  const qtyById = $derived(new Map(qtyList.map((entry) => [entry.productId, entry])));
  const lockedIds = $derived(new Set((count?.skuStep.entries ?? []).map((entry) => entry.productId)));
  const shownCheck = $derived(isOpen ? (fresh ? lastCheck : null) : count?.qtyStep.lastCheck ?? count?.skuStep.lastCheck ?? null);
  const rows = $derived.by<DisplayRow[]>(() => {
    if (shownCheck) {
      const inList = new Set((step === 'SKU' && isOpen ? skuList : qtyList).map((entry) => entry.productId));
      return shownCheck.rows.map((row: StockCountRow) => ({
        productId: row.productId, sku: row.sku, name: nameOf.get(row.productId) ?? '', state: row.state, erpOnHand: row.erpOnHand,
        difference: row.difference, moved: row.movedSinceStart, entered: inList.has(row.productId),
      }));
    }
    return (step === 'SKU' ? skuList : qtyList).map((entry) => ({ productId: entry.productId, sku: entry.sku, name: nameOf.get(entry.productId) ?? '', state: null, erpOnHand: null, difference: null, moved: false, entered: true }));
  });
  const mismatched = $derived(shownCheck ? shownCheck.mismatched : 0);
  const movedCount = $derived(shownCheck ? shownCheck.rows.filter((row) => row.movedSinceStart && row.state !== 'MATCH').length : 0);

  function syncLists(view: StockCountView) {
    skuList = view.skuStep.entries.map((entry) => ({ productId: entry.productId, sku: entry.sku }));
    qtyList = view.qtyStep.entries.map((entry) => ({ productId: entry.productId, sku: entry.sku, quantity: entry.quantity }));
  }
  async function load() {
    loading = true;
    error = '';
    try {
      const [view, list] = await Promise.all([api<StockCountView>(`/inventory/stock-counts/${id}`), products.length ? Promise.resolve(products) : api<CountProduct[]>('/products')]);
      products = list;
      count = view;
      syncLists(view);
      localChanged = false;
    } catch (caught) {
      error = caught instanceof Error ? caught.message : m.kk_khong_tai_duoc();
    } finally {
      loading = false;
    }
    await tick();
    codeEl?.focus();
  }
  onMount(() => {
    void load();
    void api<Warehouse[]>('/warehouses').then((rows) => (warehouses = rows)).catch(() => undefined);
  });
  onDestroy(() => {
    if (localChanged) void saveNow();
  });

  // ---------- Tự lưu nháp ----------
  function changed() {
    localChanged = true;
    success = '';
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => void saveNow(), 800);
  }
  function saveNow(): Promise<void> {
    clearTimeout(saveTimer);
    saveChain = saveChain.then(async () => {
      if (!localChanged || !count || !isOpen) return;
      localChanged = false;
      const body = step === 'SKU'
        ? { step: 'SKU', version: count.version, entries: skuList.map((entry) => ({ productId: entry.productId })) }
        : { step: 'QTY', version: count.version, entries: qtyList.map((entry) => ({ productId: entry.productId, quantity: entry.quantity || '0' })) };
      saving = true;
      try {
        count = await api<StockCountView>(`/inventory/stock-counts/${id}/entries`, { method: 'PUT', body: JSON.stringify(body) });
        savedAt = new Date();
      } catch (caught) {
        localChanged = true;
        error = caught instanceof Error ? caught.message : m.crud_loi_luu();
        if (caught instanceof ApiRequestError && caught.payload.code === 'VERSION_CONFLICT') await load();
      } finally {
        saving = false;
      }
    });
    return saveChain;
  }

  // ---------- Nhập mã ----------
  function flash(productId: string) {
    flashId = productId;
    setTimeout(() => { if (flashId === productId) flashId = ''; }, 1600);
  }
  function resolveCode(): CountProduct | null {
    const code = codeInput.trim();
    if (!code) {
      codeEl?.focus();
      return null;
    }
    const product = lookupCode(index, code);
    if (!product) {
      inputError = m.kk_khong_co_ma({ code });
      inputNotice = '';
      codeEl?.select();
      return null;
    }
    inputError = '';
    return product;
  }
  function resetInputs() {
    codeInput = '';
    qtyInput = '';
    inputError = '';
    void tick().then(() => codeEl?.focus());
  }
  function addSku() {
    const product = resolveCode();
    if (!product) return;
    const existed = skuList.some((entry) => entry.productId === product.id);
    skuList = pushNewest(skuList, { productId: product.id, sku: product.sku });
    inputNotice = existed ? m.kk_da_co_dua_len({ sku: product.sku }) : m.kk_da_them({ sku: product.sku });
    flash(product.id);
    resetInputs();
    changed();
  }
  function addQty() {
    const product = resolveCode();
    if (!product) return;
    if (!/^\d+(\.\d{1,4})?$/.test(qtyInput)) {
      inputError = m.kk_nhap_so_luong();
      qtyEl?.focus();
      return;
    }
    const existing = qtyList.find((entry) => entry.productId === product.id);
    if (existing) {
      duplicate = { product, existing: existing.quantity, incoming: qtyInput };
      duplicateOpen = true;
      void tick().then(() => addButton?.focus());
      return;
    }
    commitQty(product, qtyInput);
  }
  function commitQty(product: CountProduct, quantity: string, note = '') {
    qtyList = pushNewest(qtyList, { productId: product.id, sku: product.sku, quantity });
    inputNotice = note || m.kk_da_them_so({ sku: product.sku, quantity: num(quantity) });
    flash(product.id);
    resetInputs();
    changed();
  }
  const plus = (a: string, b: string) => String(Number((Number(a) + Number(b)).toFixed(4)));
  function resolveDuplicate(mode: 'ADD' | 'REPLACE') {
    if (!duplicate) return;
    const { product, existing, incoming } = duplicate;
    const quantity = mode === 'ADD' ? plus(existing, incoming) : incoming;
    duplicateOpen = false;
    commitQty(product, quantity, mode === 'ADD' ? m.kk_da_cong_don({ sku: product.sku, added: num(incoming), total: num(quantity) }) : m.kk_da_thay({ sku: product.sku, quantity: num(quantity) }));
    duplicate = null;
  }
  function codeKeydown(event: KeyboardEvent) {
    if (event.key !== 'Enter') return;
    event.preventDefault();
    if (step === 'SKU') return addSku();
    if (resolveCode()) void tick().then(() => { qtyEl?.focus(); qtyEl?.select(); });
  }
  function qtyKeydown(event: KeyboardEvent) {
    if (event.key === 'Enter') {
      event.preventDefault();
      addQty();
    }
  }
  function removeRow(productId: string) {
    if (step === 'SKU') skuList = skuList.filter((entry) => entry.productId !== productId);
    else qtyList = qtyList.filter((entry) => entry.productId !== productId);
    changed();
  }
  function addToList(row: DisplayRow) {
    skuList = pushNewest(skuList, { productId: row.productId, sku: row.sku });
    flash(row.productId);
    changed();
  }
  function setQuantity(productId: string, quantity: string) {
    qtyList = qtyList.map((entry) => (entry.productId === productId ? { ...entry, quantity } : entry));
    changed();
  }
  function countThis(row: DisplayRow) {
    codeInput = row.sku;
    qtyInput = '';
    inputError = '';
    void tick().then(() => { qtyEl?.focus(); });
  }

  // ---------- Thao tác có xác nhận ----------
  function ask(options: { title: string; message: string; label: string; tone?: 'primary' | 'navy' | 'danger'; action: () => Promise<void> }) {
    confirmTitle = options.title;
    confirmMessage = options.message;
    confirmLabel = options.label;
    confirmTone = options.tone ?? 'primary';
    confirmAction = options.action;
    confirmOpen = true;
  }
  async function act(run: () => Promise<void>) {
    busy = true;
    error = '';
    success = '';
    try {
      await saveNow();
      await run();
    } catch (caught) {
      error = caught instanceof Error ? caught.message : m.crud_loi_luu();
      if (caught instanceof ApiRequestError && caught.payload.code === 'VERSION_CONFLICT') await load();
    } finally {
      busy = false;
    }
  }
  async function runCheck() {
    if (!count) return;
    count = await api<StockCountView>(`/inventory/stock-counts/${id}/check`, { method: 'POST', body: JSON.stringify({ version: count.version, step }) });
  }
  function askCheck() {
    ask({
      title: m.kk_kiem_tra(),
      message: step === 'SKU' ? m.kk_hoi_kiem_tra_sku({ count: skuList.length }) : m.kk_hoi_kiem_tra_qty({ count: qtyList.length }),
      label: m.kk_kiem_tra(),
      tone: 'navy',
      action: () => act(runCheck),
    });
  }
  function askBack() {
    ask({
      title: m.kk_tro_lai(),
      message: step === 'SKU' ? m.kk_hoi_tro_lai_sku() : m.kk_hoi_tro_lai_qty(),
      label: m.kk_tro_lai(),
      action: () => act(async () => {
        if (!count) return;
        if (step === 'SKU') {
          await goto('/inventory');
          return;
        }
        count = await api<StockCountView>(`/inventory/stock-counts/${id}/back`, { method: 'POST', body: JSON.stringify({ version: count.version }) });
        syncLists(count);
        success = m.kk_da_mo_lai_buoc_1();
      }),
    });
  }
  function askCancel() {
    ask({ title: m.kk_huy_phieu(), message: m.kk_hoi_huy(), label: m.kk_huy_phieu(), tone: 'danger', action: () => act(async () => {
      if (!count) return;
      count = await api<StockCountView>(`/inventory/stock-counts/${id}/cancel`, { method: 'POST', body: JSON.stringify({ version: count.version }) });
      // Phiếu đã hủy chỉ quản trị gốc còn mở được (DOC-HIDE-01): người khác về danh sách kèm thông báo.
      if (!session.user?.root) await goto(`/inventory/counts?cancelled=${encodeURIComponent(count.code)}`);
    }) });
  }

  // ---------- Sửa tồn ERP ----------
  function openFix(row: DisplayRow) {
    fixRow = row;
    fixReason = '';
    fixError = '';
    const counted = qtyById.get(row.productId)?.quantity;
    fixTarget = step === 'SKU' ? (row.state === 'ONLY_ERP' ? '0' : '') : counted ?? (row.state === 'ONLY_ERP' ? '0' : '');
    const stocks = stockOf(row.productId);
    fixWarehouse = stocks.find((item) => !item.defective)?.warehouseId ?? count?.warehouseIds.find((warehouseId) => warehouses.find((item) => item.id === warehouseId)?.purpose !== 'DEFECTIVE') ?? count?.warehouseIds[0] ?? '';
    fixOpen = true;
  }
  async function submitFix(event: SubmitEvent) {
    event.preventDefault();
    if (!fixRow || !count) return;
    if (!/^\d+(\.\d{1,4})?$/.test(fixTarget)) {
      fixError = m.kk_nhap_so_luong();
      return;
    }
    if (fixReason.trim().length < 5) {
      fixError = m.kk_ly_do_bat_buoc();
      return;
    }
    const row = fixRow;
    busy = true;
    fixError = '';
    try {
      await saveNow();
      count = await api<StockCountView>(`/inventory/stock-counts/${id}/erp-fix`, {
        method: 'POST', idempotentCommand: true,
        body: JSON.stringify({ version: count.version, step, productId: row.productId, targetOnHand: fixTarget, reason: fixReason.trim(), ...(combined && fixWarehouse ? { warehouseId: fixWarehouse } : {}) }),
      });
      fixOpen = false;
      await runCheck();
      success = m.kk_da_sua_erp({ sku: row.sku, quantity: num(fixTarget) });
    } catch (caught) {
      fixError = caught instanceof Error ? caught.message : m.crud_loi_luu();
    } finally {
      busy = false;
    }
  }

  // ---------- Chốt ----------
  function openFinish() {
    finishNote = '';
    finishAck = false;
    finishError = '';
    finishOpen = true;
  }
  async function submitFinish(event: SubmitEvent) {
    event.preventDefault();
    if (!count) return;
    if (mismatched > 0 && (!finishAck || finishNote.trim().length < 10)) {
      finishError = m.kk_can_ghi_chu_lech();
      return;
    }
    busy = true;
    finishError = '';
    try {
      await saveNow();
      const path = step === 'SKU' ? 'lock-skus' : 'close';
      count = await api<StockCountView>(`/inventory/stock-counts/${id}/${path}`, {
        method: 'POST', idempotentCommand: step === 'QTY',
        body: JSON.stringify({ version: count.version, ...(mismatched > 0 ? { acknowledgeVariance: true, note: finishNote.trim() } : {}) }),
      });
      finishOpen = false;
      syncLists(count);
      success = step === 'SKU' ? m.kk_da_chot_buoc_1() : count.variance?.qtyMismatches ? m.kk_da_chot_con_lech({ count: count.variance.qtyMismatches }) : m.kk_da_chot_khop();
      await tick();
      codeEl?.focus();
    } catch (caught) {
      finishError = caught instanceof Error ? caught.message : m.crud_loi_luu();
      if (caught instanceof ApiRequestError && caught.payload.code === 'STOCK_COUNT_RECHECK_REQUIRED') finishOpen = false;
    } finally {
      busy = false;
    }
  }

  const steps = $derived([
    { label: m.kk_buoc_1(), done: count?.status === 'QTY_CHECK' || count?.status === 'CLOSED', current: count?.status === 'SKU_CHECK' },
    { label: m.kk_buoc_2(), done: count?.status === 'CLOSED', current: count?.status === 'QTY_CHECK' },
    { label: m.kk_buoc_3(), done: count?.status === 'CLOSED', current: false },
  ]);
  const signed = (value: number | null) => (value === null ? '—' : value > 0 ? `+${num(value)}` : num(value));
</script>

<svelte:head><title>{count?.code ?? m.kk_title()} — INOXPRAN ERP</title></svelte:head>

<section class="page-head">
  <div>
    <nav class="crumbs" aria-label={m.duong_dan()}><a href="/inventory">{m.kho_giao_hang()}</a><span><a href="/inventory/counts">{m.kk_title()}</a></span><span>{count?.code ?? '…'}</span></nav>
    <h1 class="page-title">{count ? m.kk_tieu_de({ code: count.code, warehouse: count.scope === 'ALL' ? m.tat_ca_kho() : count.warehouseName }) : m.kk_title()}</h1>
    {#if count}<p class="page-sub">{m.kk_mo_ta_phieu({ by: count.startedByName, at: dateTime(count.startedAt), period: count.period.split('-').reverse().join('/') })} · <span class={`pill ${count.status === 'CLOSED' ? 'success' : count.status === 'CANCELLED' ? 'neutral' : 'warning'}`}>{countStatusLabel(count.status)}</span></p>{/if}
  </div>
  {#if editable}<div class="actions"><button class="btn" onclick={askCancel} disabled={busy}><XCircle size={16} />{m.kk_huy_phieu()}</button></div>{/if}
</section>

{#if error}<div class="banner error"><CircleAlert size={17} /><span>{error}</span></div>{/if}
{#if success}<div class="banner success"><CircleCheck size={17} /><span>{success}</span></div>{/if}

{#if loading && !count}
  <div class="card skeleton" style="height:240px"></div>
{:else if count}
  <ol class="card timeline" style="--steps:3" aria-label={m.kk_title()}>
    {#each steps as item}
      <li class:done={item.done} class:current={item.current}><span>{#if item.done}<Check size={14} strokeWidth={3} />{/if}</span><b>{item.label}</b></li>
    {/each}
  </ol>

  {#if count.status === 'QTY_CHECK' || (count.status === 'CLOSED' && count.skuStep.lockedAt)}
    <div class="banner">
      <ClipboardCheck size={17} />
      <span>{m.kk_buoc_1_da_chot({ count: count.skuStep.entries.length, by: count.skuStep.lockedByName ?? '', at: dateTime(count.skuStep.lockedAt ?? '') })}{#if count.skuStep.lockMismatches} — {m.kk_buoc_1_con_lech({ count: count.skuStep.lockMismatches, note: count.skuStep.lockNote ?? '' })}{/if}</span>
    </div>
  {/if}
  {#if count.status === 'CLOSED'}
    {#if count.variance?.qtyMismatches}
      <div class="banner error"><AlertTriangle size={17} /><span>{m.kk_ket_qua_con_lech({ count: count.variance.qtyMismatches, by: count.closedByName ?? '', at: dateTime(count.closedAt ?? ''), note: count.closeNote ?? '' })}</span></div>
    {:else}
      <div class="banner success"><CircleCheck size={17} /><span>{m.kk_ket_qua_khop({ by: count.closedByName ?? '', at: dateTime(count.closedAt ?? '') })}</span></div>
    {/if}
  {/if}

  <section class="card count-card">
    <header class="card-head head">
      <div>
        <h2>{isOpen ? (step === 'SKU' ? m.kk_buoc_1() : m.kk_buoc_2()) : m.kk_ket_qua_cuoi()}</h2>
        <p class="muted">{isOpen ? (step === 'SKU' ? m.kk_huong_dan_sku() : m.kk_huong_dan_qty()) : ''}</p>
      </div>
      {#if isOpen}
        <span class="muted save">{saving ? m.kk_dang_luu() : localChanged ? m.kk_chua_luu() : savedAt ? m.kk_da_luu({ at: dateTime(savedAt) }) : ''}</span>
      {/if}
    </header>

    {#if editable}
      <div class="entry" class:qty={step === 'QTY'}>
        <div class="field">
          <label for="count-code">{m.kk_ma_sp()}</label>
          <input id="count-code" bind:this={codeEl} bind:value={codeInput} onkeydown={codeKeydown} oninput={() => (inputError = '')} placeholder={m.kk_go_hoac_quet()} autocomplete="off" aria-invalid={inputError ? 'true' : undefined} />
        </div>
        {#if step === 'QTY'}
          <div class="field">
            <label for="count-qty">{m.kk_so_luong_dem()}</label>
            <NumberInput id="count-qty" bind:value={qtyInput} bind:element={qtyEl} decimals={4} onkeydown={qtyKeydown} placeholder="0" />
          </div>
        {/if}
        <button class="btn primary add" onclick={() => (step === 'SKU' ? addSku() : addQty())} disabled={busy}><Plus size={16} />{m.kk_them()}</button>
      </div>
      {#if inputError}<p class="input-msg error">{inputError}</p>{:else if inputNotice}<p class="input-msg">{inputNotice}</p>{/if}
      <p class="progress">{step === 'SKU' ? m.kk_da_nhap_ma({ count: skuList.length }) : m.kk_da_dem_ma({ counted: qtyList.filter((entry) => lockedIds.has(entry.productId)).length, total: lockedIds.size })}</p>
    {/if}

    {#if shownCheck}
      <div class={`banner ${mismatched ? 'error' : 'success'} result`}>
        {#if mismatched}<AlertTriangle size={17} /><span>{m.kk_co_lech({ count: mismatched, total: shownCheck.rows.length, at: dateTime(shownCheck.at) })}{#if movedCount} · {m.kk_co_phat_sinh({ count: movedCount })}{/if}</span>
        {:else}<CircleCheck size={17} /><span>{m.kk_khop_het({ total: shownCheck.rows.length, at: dateTime(shownCheck.at) })}</span>{/if}
      </div>
    {:else if isOpen && lastCheck}
      <div class="banner warning result"><RotateCcw size={17} /><span>{m.kk_can_kiem_tra_lai({ at: dateTime(lastCheck.at) })}</span></div>
    {/if}

    <div class="table-wrap list">
      <table class="table">
        <thead>
          <tr>
            <th class="num">#</th><th>{m.kk_ma_sp()}</th><th>{m.kk_ten_sp()}</th>
            {#if step === 'QTY'}<th class="num">{m.kk_thuc_dem()}</th>{/if}
            {#if shownCheck}<th class="num">{m.kk_ton_erp()}</th>{#if step === 'QTY'}<th class="num">{m.kk_chenh_lech()}</th>{/if}<th>{m.kk_ket_qua()}</th>{/if}
            {#if editable}<th class="actions-col"></th>{/if}
          </tr>
        </thead>
        <tbody>
          {#each rows as row, position (row.productId)}
            {@const entry = qtyById.get(row.productId)}
            <tr class:ok={row.state === 'MATCH'} class:bad={row.state !== null && row.state !== 'MATCH'} class:flash={flashId === row.productId}>
              <td class="num muted">{position + 1}</td>
              <td class="code">{row.sku}</td>
              <td>{row.name}</td>
              {#if step === 'QTY'}
                <td class="num">
                  {#if editable && entry}<NumberInput class="input qty-cell" value={entry.quantity} decimals={4} onvalue={(value: string) => setQuantity(row.productId, value)} aria-label={`${m.kk_so_luong_dem()} ${row.sku}`} />
                  {:else}{entry ? num(entry.quantity) : '—'}{/if}
                </td>
              {/if}
              {#if shownCheck}
                <td class="num">{row.erpOnHand === null ? '—' : num(row.erpOnHand)}{#if combined && stockOf(row.productId).length > 1}<small class="by-wh">{stockOf(row.productId).map((item) => `${item.defective ? m.kk_kho_loi_ngan() : m.kk_kho_chinh_ngan()} ${num(item.onHand)}`).join(' · ')}</small>{/if}</td>
                {#if step === 'QTY'}<td class="num diff">{signed(row.difference)}</td>{/if}
                <td>
                  <span class={`pill ${row.state === 'MATCH' ? 'success' : 'danger'}`}>{row.state ? rowStateLabel(row.state) : ''}</span>
                  {#if row.moved}<span class="moved" title={m.kk_phat_sinh_tooltip()}><AlertTriangle size={14} />{m.kk_phat_sinh()}</span>{/if}
                </td>
              {/if}
              {#if editable}
                <td><div class="acts">
                  {#if shownCheck && row.state === 'ONLY_ERP' && step === 'SKU'}
                    <button class="btn small" onclick={() => addToList(row)}><ListPlus size={14} />{m.kk_them_vao_ds()}</button>
                  {/if}
                  {#if step === 'QTY' && !row.entered}
                    <button class="btn small" onclick={() => countThis(row)}><ScanSearch size={14} />{m.kk_nhap_so()}</button>
                  {/if}
                  {#if shownCheck && row.state && row.state !== 'MATCH'}
                    <button class="btn small fix" onclick={() => openFix(row)}><DatabaseZap size={14} />{m.kk_sua_erp()}</button>
                  {/if}
                  {#if row.entered}
                    <button class="icon-btn danger" title={m.kk_bo_dong()} aria-label={`${m.kk_bo_dong()} ${row.sku}`} onclick={() => removeRow(row.productId)}><Trash2 size={15} /></button>
                  {/if}
                </div></td>
              {/if}
            </tr>
          {:else}
            <tr class="empty-row"><td colspan="8">{isOpen ? m.kk_chua_nhap() : m.kk_khong_co_du_lieu()}</td></tr>
          {/each}
        </tbody>
      </table>
    </div>

    {#if editable}
      <footer class="bar">
        <button class="btn" onclick={askBack} disabled={busy}><Undo2 size={16} />{m.kk_tro_lai()}</button>
        <div class="bar-right">
          <button class="btn navy" onclick={askCheck} disabled={busy || (step === 'SKU' ? !skuList.length : !qtyList.length && !lockedIds.size)}><ScanSearch size={16} />{m.kk_kiem_tra()}</button>
          <button class="btn primary" onclick={openFinish} disabled={busy || !fresh}><ClipboardCheck size={16} />{step === 'SKU' ? m.kk_chot_buoc_1() : m.kk_chot_kiem_ke()}</button>
        </div>
      </footer>
    {/if}
  </section>

  {#if count.adjustments.length}
    <section class="card">
      <header class="card-head head"><h2>{m.kk_lich_su_sua_erp()}</h2><span class="muted">{m.kk_lich_su_sua_erp_mo_ta()}</span></header>
      <div class="table-wrap">
        <table class="table">
          <thead><tr><th>{m.kk_thoi_gian()}</th><th>{m.kk_ma_sp()}</th><th class="num">{m.kk_erp_truoc()}</th><th class="num">{m.kk_erp_sau()}</th><th class="num">{m.kk_chenh_lech()}</th><th>{m.kk_ly_do()}</th><th>{m.kk_nguoi_sua()}</th></tr></thead>
          <tbody>
            {#each count.adjustments as item}
              <tr><td>{dateTime(item.at)}</td><td class="code">{item.sku}</td><td class="num">{num(item.before)}</td><td class="num">{num(item.after)}</td><td class="num">{signed(Number(item.delta))}</td><td>{item.reason}</td><td>{item.byName}</td></tr>
            {/each}
          </tbody>
        </table>
      </div>
    </section>
  {/if}
{/if}

<ConfirmDialog bind:open={confirmOpen} title={confirmTitle} message={confirmMessage} confirmLabel={confirmLabel} tone={confirmTone} onconfirm={() => confirmAction()} />

<Dialog bind:open={duplicateOpen} title={m.kk_ma_da_nhap()}>
  {#if duplicate}<p class="dup">{m.kk_hoi_trung({ sku: duplicate.product.sku, existing: num(duplicate.existing), incoming: num(duplicate.incoming) })}</p>{/if}
  {#snippet footer()}
    <button type="button" class="btn" onclick={() => { duplicateOpen = false; duplicate = null; }}>{m.huy()}</button>
    <button type="button" class="btn navy" onclick={() => resolveDuplicate('REPLACE')}>{m.kk_thay_bang({ quantity: duplicate ? num(duplicate.incoming) : '' })}</button>
    <button type="button" class="btn primary" bind:this={addButton} onclick={() => resolveDuplicate('ADD')}>{m.kk_cong_don({ total: duplicate ? num(plus(duplicate.existing, duplicate.incoming)) : '' })}</button>
  {/snippet}
</Dialog>

<Dialog bind:open={fixOpen} title={m.kk_sua_erp_tieu_de({ sku: fixRow?.sku ?? '' })}>
  <form id="kk-fix" class="fix-form" onsubmit={submitFix}>
    {#if fixError}<div class="banner error"><CircleAlert size={17} /><span>{fixError}</span></div>{/if}
    {#if fixRow}<p>{m.kk_sua_erp_mo_ta({ sku: fixRow.sku, name: fixRow.name, erp: fixRow.erpOnHand === null ? '—' : num(fixRow.erpOnHand) })}</p>{/if}
    <div class="field"><label for="kk-fix-target">{combined ? m.kk_tong_dung() : m.kk_ton_erp_moi()} <span class="req">*</span></label><NumberInput id="kk-fix-target" bind:value={fixTarget} decimals={4} /></div>
    {#if combined && fixRow}
      <fieldset class="fix-wh">
        <legend>{m.kk_kho_ghi_chenh()}</legend>
        {#each count?.warehouseIds ?? [] as warehouseId (warehouseId)}
          {@const stock = stockOf(fixRow.productId).find((item) => item.warehouseId === warehouseId)}
          <label><input type="radio" name="kk-fix-wh" value={warehouseId} bind:group={fixWarehouse} /><b>{warehouses.find((item) => item.id === warehouseId)?.name ?? stock?.warehouseName ?? warehouseId}</b><small>{m.kk_ton_kho_giu({ onHand: num(stock?.onHand ?? 0), reserved: num(stock?.reserved ?? 0) })}</small></label>
        {/each}
      </fieldset>
    {/if}
    <div class="field"><label for="kk-fix-reason">{m.kk_ly_do()} <span class="req">*</span></label><textarea id="kk-fix-reason" bind:value={fixReason} rows="3" maxlength="300" placeholder={m.kk_ly_do_goi_y()}></textarea><small class="hint">{m.kk_ly_do_luu_vet()}</small></div>
  </form>
  {#snippet footer()}
    <button type="button" class="btn" onclick={() => (fixOpen = false)}>{m.huy()}</button>
    <button type="submit" class="btn primary" form="kk-fix" disabled={busy}><DatabaseZap size={15} />{m.kk_sua_erp()}</button>
  {/snippet}
</Dialog>

<Dialog bind:open={finishOpen} title={step === 'SKU' ? m.kk_chot_buoc_1() : m.kk_chot_kiem_ke()}>
  <form id="kk-finish" class="fix-form" onsubmit={submitFinish}>
    {#if finishError}<div class="banner error"><CircleAlert size={17} /><span>{finishError}</span></div>{/if}
    {#if mismatched}
      <div class="banner warning"><AlertTriangle size={17} /><span>{step === 'SKU' ? m.kk_canh_bao_chot_sku({ count: mismatched }) : m.kk_canh_bao_chot_qty({ count: mismatched })}</span></div>
      <div class="field"><label for="kk-finish-note">{m.kk_ghi_chu_lech()} <span class="req">*</span></label><textarea id="kk-finish-note" bind:value={finishNote} rows="3" maxlength="500" placeholder={m.kk_ghi_chu_lech_goi_y()}></textarea></div>
      <label class="check"><input type="checkbox" bind:checked={finishAck} />{m.kk_xac_nhan_chot_lech()}</label>
    {:else}
      <p>{step === 'SKU' ? m.kk_hoi_chot_sku({ count: skuList.length }) : m.kk_hoi_chot_qty()}</p>
    {/if}
  </form>
  {#snippet footer()}
    <button type="button" class="btn" onclick={() => (finishOpen = false)}>{m.huy()}</button>
    <button type="submit" class={`btn ${mismatched ? 'danger' : 'primary'}`} form="kk-finish" disabled={busy}><ClipboardCheck size={15} />{step === 'SKU' ? m.kk_chot_buoc_1() : m.kk_chot_kiem_ke()}</button>
  {/snippet}
</Dialog>

<style>
  .timeline { display: grid; grid-template-columns: repeat(var(--steps), 1fr); margin: 0 0 18px; padding: 18px 20px; list-style: none; }
  .timeline li { position: relative; display: grid; align-content: start; justify-items: center; gap: 4px; text-align: center; }
  .timeline li::before { content: ''; position: absolute; top: 12px; left: -50%; width: 100%; height: 2px; background: var(--line); }
  .timeline li:first-child::before { display: none; }
  .timeline li.done::before { background: var(--green); }
  .timeline span { position: relative; z-index: 1; display: grid; width: 26px; height: 26px; place-items: center; border: 2px solid var(--line); border-radius: 50%; background: var(--surface); color: #fff; }
  .timeline .done span { border-color: var(--green); background: var(--green); }
  .timeline .current span { border-color: var(--orange); box-shadow: 0 0 0 4px var(--orange-soft); }
  .timeline .current b { color: var(--orange); }
  .timeline b { font-size: 13px; }
  .count-card { display: grid; }
  .head { align-items: flex-start; }
  .head h2 { margin: 0; }
  .head p { margin: 4px 0 0; font-size: 13px; }
  .save { font-size: 12.5px; white-space: nowrap; }
  .entry { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 12px; align-items: end; padding: 16px 20px 0; }
  .entry.qty { grid-template-columns: minmax(0, 1fr) 180px auto; }
  .entry input, .entry :global(input) { height: 46px; font-size: 17px; }
  .entry .add { height: 46px; padding: 0 22px; }
  .input-msg { margin: 8px 20px 0; font-size: 13px; color: var(--green); }
  .input-msg.error { color: var(--red); font-weight: 600; }
  .progress { margin: 6px 20px 0; color: var(--muted); font-size: 12.5px; }
  .result { margin: 14px 20px 0; }
  .list { margin-top: 14px; max-height: 62vh; overflow: auto; }
  tr.ok td { background: #eefaf1; }
  tr.bad td { background: #fdeeee; }
  tr.flash td { animation: flash 1.6s ease-out; }
  @keyframes flash { from { background: #fff3c4; } to { background: transparent; } }
  .diff { font-weight: 700; }
  .moved { display: inline-flex; align-items: center; gap: 3px; margin-left: 6px; color: #b4501f; font-size: 12px; }
  :global(.qty-cell) { width: 110px; text-align: right; }
  .acts { display: flex; gap: 6px; justify-content: flex-end; align-items: center; white-space: nowrap; }
  .actions-col { width: 1%; }
  .fix { color: #b4501f; }
  .bar { position: sticky; bottom: 0; z-index: 2; display: flex; justify-content: space-between; gap: 10px; padding: 14px 92px 14px 20px; border-top: 1px solid var(--line-soft); background: var(--surface); }
  .bar-right { display: flex; gap: 10px; }
  .fix-form { display: grid; gap: 12px; }
  .by-wh { display: block; color: var(--muted); font-size: 11.5px; white-space: nowrap; }
  .fix-wh { display: grid; gap: 8px; margin: 0; padding: 10px 12px; border: 1px solid var(--line); border-radius: 8px; }
  .fix-wh legend { padding: 0 4px; font-size: 13px; font-weight: 600; }
  .fix-wh label { display: grid; grid-template-columns: auto 1fr auto; align-items: center; gap: 8px; font-size: 13px; cursor: pointer; }
  .fix-wh small { color: var(--muted); }
  .fix-form p, .dup { margin: 0; line-height: 1.5; }
  .fix-form textarea { width: 100%; }
  .check { display: flex; gap: 8px; align-items: flex-start; font-size: 13.5px; }
  .req { color: var(--red); }
  @media (max-width: 720px) {
    .entry, .entry.qty { grid-template-columns: 1fr; }
    .bar { flex-direction: column; padding: 12px 16px 72px; }
    .bar-right { display: grid; grid-template-columns: 1fr 1fr; }
    .timeline { padding: 14px 8px; }
  }
</style>
