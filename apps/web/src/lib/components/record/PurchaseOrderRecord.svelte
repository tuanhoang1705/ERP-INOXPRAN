<script lang="ts">
  /**
   * Đơn mua / hợp đồng nhập hàng dạng cửa sổ chứng từ (theo hợp đồng MSC… của công ty mẹ):
   * điều khoản (tiền tệ + tỷ giá, Incoterms, thanh toán, cọc), vận chuyển (cảng, ETD / ETA), dòng hàng sửa trực tiếp
   * (LineGrid: nhập mã / quét mã vạch, số thùng / CBM / kg tự tính), tổng theo tiền tệ hợp đồng + quy VND, gợi ý container,
   * nhận hàng, tiền đã trả NCC, lô hàng, đính kèm, lịch sử, bản in hợp đồng / packing list song ngữ Anh – Trung.
   * Đơn nháp sửa được; đã gửi duyệt thì chỉ xem.
   */
  import { untrack } from 'svelte';
  import { goto } from '$app/navigation';
  import { CircleAlert, CircleCheck, FileText, PackageCheck, Plus, RefreshCw, Send, ShieldCheck, Ship, Trash2, XCircle } from 'lucide-svelte';
  import { CURRENCIES } from '$shared/currency';
  import { PRODUCT_CREATE_ROLES } from '$shared/catalog-access';
  import { m } from '$lib/paraglide/messages';
  import { api, ApiRequestError } from '$lib/api';
  import { date, dateTime, num, todayIso, vnd } from '$lib/format';
  import { hasRole, purchaseStatus } from '$lib/labels';
  import { session } from '$lib/session.svelte';
  import { productName } from '$lib/product';
  import {
    conversionFactor, draftLineTotal, draftPacking, draftTotals, money, paymentKindLabel, shippingMethodLabel,
    type DraftLine, type PurchaseOrderDetail, type PurchaseProduct,
  } from '$lib/purchase';
  import Dialog from '$lib/components/Dialog.svelte';
  import NumberInput from '$lib/components/NumberInput.svelte';
  import ProductDialog from '$lib/components/ProductDialog.svelte';
  import RecordWindow from './RecordWindow.svelte';
  import RecordSection from './RecordSection.svelte';
  import LineGrid, { type GridColumn } from './LineGrid.svelte';
  import HistoryPanel from './HistoryPanel.svelte';
  import AttachmentsPanel from './AttachmentsPanel.svelte';
  import RelatedTable from './RelatedTable.svelte';

  let { id = '' }: { id?: string } = $props();

  type Option = { id: string; code: string; name: string; status?: string; paymentTermDays?: number };
  const HEADER_FIELDS = ['supplierId', 'warehouseId', 'expectedDate', 'note', 'supplierContractNo', 'contractDate', 'currency', 'exchangeRate', 'incoterm', 'paymentTerms', 'depositPercent', 'portOfLoading', 'portOfDischarge', 'shippingMethod', 'etd', 'eta', 'shippingMark'] as const;
  type HeaderKey = (typeof HEADER_FIELDS)[number];
  const CLEARABLE: HeaderKey[] = ['expectedDate', 'note', 'supplierContractNo', 'contractDate', 'exchangeRate', 'incoterm', 'paymentTerms', 'depositPercent', 'portOfLoading', 'portOfDischarge', 'shippingMethod', 'etd', 'eta', 'shippingMark'];

  let order = $state<PurchaseOrderDetail | null>(null);
  let suppliers = $state<Option[]>([]);
  let warehouses = $state<Option[]>([]);
  let products = $state<PurchaseProduct[]>([]);
  let header = $state<Record<HeaderKey, string>>(Object.fromEntries(HEADER_FIELDS.map((key) => [key, ''])) as Record<HeaderKey, string>);
  let partial = $state(true);
  let lines = $state<DraftLine[]>([]);
  let baseline = $state('');
  let tab = $state('main');
  let loading = $state(true);
  let saving = $state(false);
  let working = $state(false);
  let error = $state('');
  let conflict = $state(false);
  let success = $state('');
  let historyReload = $state(0);
  let attachmentCount = $state<number | undefined>(undefined);
  let receipt = $state<Record<string, string>>({});
  let reference = $state('');
  let paymentOpen = $state(false);
  let payment = $state({ kind: 'DEPOSIT', amount: '', paidOn: todayIso(), reference: '', note: '' });
  let paymentError = $state('');

  const isNew = $derived(!id);
  const roles = $derived(session.user?.roles ?? []);
  /** Tạo mã sản phẩm ngay trên đơn mua (PO-NEWSKU-01): không phải sang Danh mục rồi quay lại chọn. */
  const canCreateProduct = $derived(hasRole(roles, [...PRODUCT_CREATE_ROLES]));
  let newProductOpen = $state(false);
  let newProductInitial = $state<{ sku?: string } | null>(null);
  let productCategories = $state<Array<{ id: string; code: string; name: string; status?: string }>>([]);
  function createProduct(code: string) {
    newProductInitial = code ? { sku: code } : null;
    newProductOpen = true;
    if (!productCategories.length) void api<typeof productCategories>('/product-categories').then((rows) => (productCategories = rows)).catch(() => undefined);
  }
  function productCreated(saved: unknown) {
    const product = saved as PurchaseProduct;
    products = [...products, product];
    const problem = addCode(product.sku);
    success = problem ? '' : m.po_da_tao_ma_them_dong({ sku: product.sku });
  }
  const draft = $derived(isNew || order?.status === 'DRAFT');
  const editable = $derived(draft && hasRole(roles, ['PROCUREMENT', 'PROCUREMENT_MANAGER']));
  const productById = $derived(new Map(products.map((product) => [product.id, product])));
  const currency = $derived(header.currency || 'VND');
  const totals = $derived(draftTotals(lines, productById, currency, header.exchangeRate));
  const snapshot = () => JSON.stringify({ header, partial, lines });
  const dirty = $derived(editable && (isNew ? lines.length > 0 || Boolean(header.supplierId) : JSON.stringify({ header, partial, lines }) !== baseline));
  const text = (value: unknown) => (value === undefined || value === null ? '' : String(value));

  function fill(source: PurchaseOrderDetail) {
    header = Object.fromEntries(HEADER_FIELDS.map((key) => [key, text((source as unknown as Record<string, unknown>)[key])])) as Record<HeaderKey, string>;
    header.currency ||= 'VND';
    partial = source.partialShipment ?? true;
    lines = source.lines.map((line) => ({ productId: line.productId, sku: line.sku, productName: line.productName, unit: line.unit, quantity: String(Number(line.quantity)), unitCost: String(Number(line.unitCost)), note: line.note ?? '' }));
    receipt = Object.fromEntries(source.lines.map((line) => [line.productId, String(Math.max(0, Number(line.baseQuantity) - Number(line.receivedBaseQuantity)))]));
    baseline = snapshot();
  }

  async function load() {
    loading = true;
    error = '';
    conflict = false;
    try {
      if (id) {
        order = await api<PurchaseOrderDetail>(`/purchase-orders/${id}`);
        fill(order);
      } else {
        header.currency = 'VND';
        header.expectedDate = '';
        baseline = snapshot();
      }
    } catch (caught) {
      error = caught instanceof Error ? caught.message : m.rw_loi_tai();
    } finally {
      loading = false;
    }
  }
  // untrack: load() đọc / ghi dữ liệu form — effect chỉ chạy lại khi đổi bản ghi (id).
  $effect(() => {
    void id;
    untrack(() => {
      success = '';
      void load();
    });
  });
  $effect(() => {
    void Promise.all([api<Option[]>('/partners?kind=SUPPLIER'), api<Option[]>('/warehouses'), api<PurchaseProduct[]>('/products?status=ACTIVE')])
      .then(([supplierRows, warehouseRows, productRows]) => {
        suppliers = supplierRows;
        warehouses = warehouseRows;
        products = productRows;
        if (!id && !header.warehouseId) header.warehouseId = warehouseRows[0]?.id ?? '';
      })
      .catch(() => undefined);
  });

  /** Giá mua mặc định: cùng tiền tệ với giá mua khai báo trên hồ sơ, đơn VND thì lấy giá vốn. */
  function defaultCost(product: PurchaseProduct, unit: string): string {
    const factor = conversionFactor(product, unit);
    if (product.purchasePrice && (product.purchaseCurrency ?? 'VND') === currency) return String(Number(product.purchasePrice) * factor);
    if (currency === 'VND') return String(Math.round(Number(product.standardCost ?? product.listPrice) * factor));
    return '';
  }

  function addCode(code: string): string | null {
    const value = code.trim().toUpperCase();
    let unit = '';
    const product = products.find((item) => {
      if (item.sku.toUpperCase() === value || item.barcode?.toUpperCase() === value || item.supplierItemCode?.toUpperCase() === value) return true;
      const carton = item.unitConversions.find((conversion) => conversion.barcode?.toUpperCase() === value);
      if (carton) unit = carton.unit;
      return Boolean(carton);
    });
    if (!product) return m.po_khong_tim_thay_ma({ code });
    unit ||= product.baseUnit;
    const existing = lines.find((line) => line.productId === product.id && line.unit === unit);
    if (existing) existing.quantity = String(Number(existing.quantity || 0) + 1);
    else lines.push({ productId: product.id, sku: product.sku, productName: productName(product), unit, quantity: '1', unitCost: defaultCost(product, unit), note: '' });
    return null;
  }

  const columns = $derived<Array<GridColumn<DraftLine>>>([
    { key: 'sku', label: m.ma_sp(), value: (row) => row.sku, required: true, width: '110px' },
    { key: 'name', label: m.ten_san_pham(), value: (row) => row.productName },
    { key: 'supplierCode', label: m.sp_ma_hang_ncc(), value: (row) => productById.get(row.productId)?.supplierItemCode ?? '', hiddenByDefault: true },
    {
      key: 'unit', label: m.dvt(), value: (row) => row.unit, width: '110px',
      edit: {
        get: (row) => row.unit,
        set: (row, value) => { row.unit = value; const product = productById.get(row.productId); if (product) row.unitCost = defaultCost(product, value) || row.unitCost; },
        options: (row) => { const product = productById.get(row.productId); return product ? [{ value: product.baseUnit, label: product.baseUnit }, ...product.unitConversions.map((item) => ({ value: item.unit, label: `${item.unit} (${num(item.factorToBase)})` }))] : [{ value: row.unit, label: row.unit }]; },
      },
    },
    { key: 'quantity', label: m.so_luong(), value: (row) => num(row.quantity), align: 'right', required: true, width: '100px', edit: { get: (row) => row.quantity, set: (row, value) => (row.quantity = value), decimals: 3 }, total: (rows) => num(rows.reduce((sum, row) => sum + Number(row.quantity || 0), 0)) },
    { key: 'unitCost', label: `${m.sp_don_gia()} (${currency})`, value: (row) => row.unitCost, align: 'right', width: '130px', edit: { get: (row) => row.unitCost, set: (row, value) => (row.unitCost = value), decimals: 4 } },
    { key: 'amount', label: `${m.thanh_tien()} (${currency})`, value: (row) => money(draftLineTotal(row), currency), align: 'right', total: () => money(totals.total, currency) },
    { key: 'cartons', label: m.po_so_thung(), value: (row) => num(draftPacking(row, productById.get(row.productId)).cartons), align: 'right', width: '80px', total: () => num(totals.packing.cartons) },
    { key: 'cbm', label: 'CBM', value: (row) => String(draftPacking(row, productById.get(row.productId)).cbm), align: 'right', width: '80px', total: () => String(totals.packing.cbm) },
    { key: 'grossKg', label: m.po_kg_ca_bi(), value: (row) => String(draftPacking(row, productById.get(row.productId)).grossKg), align: 'right', width: '90px', total: () => String(totals.packing.grossKg) },
    { key: 'note', label: m.ghi_chu(), value: (row) => row.note, edit: { get: (row) => row.note, set: (row, value) => (row.note = value) }, hiddenByDefault: false },
  ]);

  function validate(): string | null {
    if (!header.supplierId || !header.warehouseId) return m.chon_nha_cung_cap_kho_nhan();
    if (!lines.length) return m.po_chua_co_dong();
    if (lines.some((line) => !(Number(line.quantity) > 0))) return m.po_so_luong_khong_hop_le();
    if (lines.some((line) => !/^\d+(\.\d{1,4})?$/.test(line.unitCost))) return m.po_don_gia_khong_hop_le();
    if (currency !== 'VND' && !(Number(header.exchangeRate) > 0)) return m.po_can_ty_gia();
    return null;
  }

  function body(): Record<string, unknown> {
    const before = baseline ? (JSON.parse(baseline) as { header: Record<HeaderKey, string>; partial: boolean; lines: DraftLine[] }) : null;
    const result: Record<string, unknown> = {};
    const clear: string[] = [];
    for (const key of HEADER_FIELDS) {
      const value = header[key].trim();
      if (!isNew && before && value === before.header[key].trim()) continue;
      if (value === '') {
        if (!isNew && CLEARABLE.includes(key)) clear.push(key);
        continue;
      }
      result[key] = value;
    }
    if (isNew || partial !== before?.partial) result.partialShipment = partial;
    if (isNew || JSON.stringify(lines) !== JSON.stringify(before?.lines)) {
      result.lines = lines.map((line) => ({ productId: line.productId, unit: line.unit, quantity: line.quantity, unitCost: line.unitCost, ...(line.note.trim() ? { note: line.note.trim() } : {}) }));
    }
    return { ...result, ...(clear.length ? { clear } : {}) };
  }

  async function save() {
    error = '';
    success = '';
    const problem = validate();
    if (problem) {
      error = problem;
      return;
    }
    saving = true;
    try {
      if (isNew) {
        const created = await api<{ id: string }>('/purchase-orders', { method: 'POST', idempotentCommand: true, body: JSON.stringify(body()) });
        baseline = snapshot();
        await goto(`/procurement/${created.id}`);
        return;
      }
      if (!order) return;
      const changes = body();
      if (Object.keys(changes).length) {
        await api(`/purchase-orders/${order.id}`, { method: 'PATCH', body: JSON.stringify({ ...changes, version: order.version }) });
        success = m.crud_da_luu({ name: order.code });
        historyReload += 1;
      }
      await load();
    } catch (caught) {
      conflict = caught instanceof ApiRequestError && caught.payload.code === 'VERSION_CONFLICT';
      error = caught instanceof Error ? caught.message : m.khong_the_luu_don_mua();
    } finally {
      saving = false;
    }
  }

  async function transition(action: 'submit' | 'approve' | 'cancel') {
    if (!order) return;
    if (action === 'cancel' && !confirm(m.po_huy_hoi({ code: order.code }))) return;
    working = true;
    error = '';
    success = '';
    try {
      await api(`/purchase-orders/${order.id}/${action}`, { method: 'POST', body: JSON.stringify({ version: order.version }), idempotentCommand: true });
      success = action === 'submit' ? m.da_gui_don_mua_vao_luong() : action === 'approve' ? m.don_mua_da_duoc_duyet_cho() : m.po_da_huy({ code: order.code });
      historyReload += 1;
      await load();
    } catch (caught) {
      error = caught instanceof Error ? caught.message : m.khong_hoan_tat_duoc_thao_tac();
    } finally {
      working = false;
    }
  }

  async function receive() {
    if (!order) return;
    const receiptLines = order.lines.map((line) => ({ productId: line.productId, quantity: receipt[line.productId] ?? '0' })).filter((line) => Number(line.quantity) > 0);
    if (!receiptLines.length) {
      error = m.nhap_it_nhat_mot_so_luong();
      return;
    }
    working = true;
    error = '';
    success = '';
    try {
      await api('/goods-receipts', { method: 'POST', idempotentCommand: true, body: JSON.stringify({ purchaseOrderId: order.id, supplierDocumentReference: reference || undefined, lines: receiptLines }) });
      success = m.da_lap_phieu_nhap_kho_ton();
      reference = '';
      historyReload += 1;
      await load();
    } catch (caught) {
      error = caught instanceof Error ? caught.message : m.khong_the_ghi_nhan_nhap_kho();
    } finally {
      working = false;
    }
  }

  async function addPayment(event: SubmitEvent) {
    event.preventDefault();
    if (!order) return;
    paymentError = '';
    try {
      await api(`/purchase-orders/${order.id}/payments`, {
        method: 'POST',
        idempotentCommand: true,
        body: JSON.stringify({ kind: payment.kind, amount: payment.amount.replace(',', '.'), paidOn: payment.paidOn, ...(payment.reference.trim() ? { reference: payment.reference.trim() } : {}), ...(payment.note.trim() ? { note: payment.note.trim() } : {}) }),
      });
      paymentOpen = false;
      payment = { kind: 'BALANCE', amount: '', paidOn: todayIso(), reference: '', note: '' };
      historyReload += 1;
      await load();
    } catch (caught) {
      paymentError = caught instanceof Error ? caught.message : m.crud_loi_luu();
    }
  }
  async function removePayment(paymentId: string) {
    if (!order || !confirm(m.po_xoa_thanh_toan_hoi())) return;
    try {
      await api(`/purchase-orders/${order.id}/payments/${paymentId}`, { method: 'DELETE' });
      historyReload += 1;
      await load();
    } catch (caught) {
      error = caught instanceof Error ? caught.message : m.crud_loi_luu();
    }
  }

  const status = $derived(order ? (purchaseStatus[order.status] ?? { label: order.status, tone: '' }) : null);
  const canReceive = $derived(Boolean(order) && ['APPROVED', 'PARTIALLY_RECEIVED'].includes(order?.status ?? '') && hasRole(roles, ['WAREHOUSE', 'WAREHOUSE_MANAGER', 'DIRECTOR']));
  const canPay = $derived(Boolean(order) && order?.status !== 'DRAFT' && order?.status !== 'CANCELLED' && hasRole(roles, ['ACCOUNTANT', 'DIRECTOR', 'PROCUREMENT_MANAGER']));
  const canShip = $derived(Boolean(order) && ['APPROVED', 'PARTIALLY_RECEIVED'].includes(order?.status ?? '') && hasRole(roles, ['PROCUREMENT', 'PROCUREMENT_MANAGER', 'DIRECTOR']));
  const remaining = (line: { baseQuantity: string; receivedBaseQuantity: string }) => Math.max(0, Number(line.baseQuantity) - Number(line.receivedBaseQuantity));
  const title = $derived(isNew ? m.lap_don_mua_hang() : order ? `${order.code} — ${order.supplierName}` : m.dang_tai());
  const tabs = $derived([
    { id: 'main', label: m.po_dieu_khoan() },
    { id: 'lines', label: m.po_hang_hoa(), badge: lines.length },
    { id: 'receive', label: m.tien_do_nhan_hang(), hidden: isNew || draft },
    { id: 'payments', label: m.po_thanh_toan_ncc(), badge: order?.payments?.length, hidden: isNew || draft },
    { id: 'shipments', label: m.po_lo_hang(), hidden: isNew || draft || (order?.currency ?? 'VND') === 'VND' },
    { id: 'attachments', label: m.rw_dinh_kem(), badge: attachmentCount, hidden: isNew },
    { id: 'history', label: m.rw_lich_su(), hidden: isNew },
  ]);
  const fieldLabels = $derived<Record<string, string>>({
    supplierId: m.nha_cung_cap(), supplierName: m.nha_cung_cap(), warehouseId: m.kho_nhan(), expectedDate: m.ngay_du_kien_ve(), note: m.ghi_chu(), status: m.trang_thai(),
    supplierContractNo: m.po_so_hop_dong(), contractDate: m.po_ngay_hop_dong(), currency: m.po_tien_te(), exchangeRate: m.po_ty_gia(), incoterm: m.po_dieu_kien_giao(),
    paymentTerms: m.po_dieu_kien_thanh_toan(), depositPercent: m.po_phan_tram_coc(), portOfLoading: m.po_cang_di(), portOfDischarge: m.po_cang_den(), shippingMethod: m.po_phuong_thuc(),
    etd: 'ETD', eta: 'ETA', partialShipment: m.po_giao_tung_phan(), shippingMark: m.po_ky_ma_hieu(), lines: m.po_hang_hoa(), total: m.tong_don(), totalVnd: m.po_quy_vnd(), payments: m.po_thanh_toan_ncc(),
  });
  const actionLabels = $derived<Record<string, string>>({
    PURCHASE_ORDER_CREATED: m.rw_tao_moi(), PURCHASE_ORDER_UPDATED: m.rw_cap_nhat(), PURCHASE_ORDER_SUBMITTED_FOR_APPROVAL: m.gui_duyet(), PURCHASE_ORDER_AUTO_APPROVED: m.po_tu_duyet(),
    PURCHASE_ORDER_APPROVED: m.duyet_don_mua(), PURCHASE_ORDER_CANCELLED: m.po_huy_don(), SUPPLIER_PAYMENT_RECORDED: m.po_ghi_thanh_toan(), SUPPLIER_PAYMENT_DELETED: m.po_xoa_thanh_toan(),
    PURCHASE_FILE_UPLOADED: m.rw_tai_len_file(), PURCHASE_FILE_DELETED: m.rw_xoa_file(), PURCHASE_FILE_MALWARE_BLOCKED: m.rw_chan_ma_doc(),
  });
</script>

<svelte:head><title>{title} · INOXPRAN ERP</title></svelte:head>

{#snippet field(key: HeaderKey, label: string, options: { type?: string; maxlength?: number; span?: boolean; hint?: string; decimals?: number } = {})}
  <div class="field" class:span={options.span}>
    <label for={`po-${key}`}>{label}</label>
    {#if options.decimals !== undefined}
      <NumberInput id={`po-${key}`} bind:value={header[key]} decimals={options.decimals} readonly={!editable} />
    {:else}
      <input id={`po-${key}`} type={options.type ?? 'text'} bind:value={header[key]} readonly={!editable} maxlength={options.maxlength ?? 120} />
    {/if}
    {#if options.hint}<span class="hint">{options.hint}</span>{/if}
  </div>
{/snippet}
{#snippet choice(key: HeaderKey, label: string, options: Array<{ value: string; label: string }>, blank = true, required = false)}
  <div class="field">
    <label for={`po-${key}`}>{label}{#if required} <span class="req">*</span>{/if}</label>
    <select id={`po-${key}`} bind:value={header[key]} disabled={!editable}>
      {#if blank}<option value="">—</option>{/if}
      {#each options as option}<option value={option.value}>{option.label}</option>{/each}
    </select>
  </div>
{/snippet}

{#if error && !order && !isNew}
  <div class="banner error"><CircleAlert size={17} /><span>{error}</span></div>
{:else if isNew || order}
  <RecordWindow
    {title}
    crumbs={[{ href: '/procurement', label: m.nhap_kho_don_mua() }]}
    listKey={isNew ? '' : 'purchase-orders'}
    recordId={order?.id ?? ''}
    detailHref={(target) => `/procurement/${target}`}
    {dirty}
    {saving}
    {tabs}
    bind:tab
    onsave={editable ? save : undefined}
    onreset={editable && !isNew ? () => { if (order) fill(order); error = ''; } : undefined}
    onnew={hasRole(roles, ['PROCUREMENT', 'PROCUREMENT_MANAGER']) && !isNew ? () => goto('/procurement/new') : undefined}
    onprint={order ? () => window.open(`/print/purchase-contract/${order?.id}`, '_blank') : undefined}
  >
    {#snippet badges()}
      {#if status}<span class={`pill ${status.tone}`}>{status.label}</span>{/if}
      {#if order}<span class="muted">{m.lap()} {dateTime(order.createdAt)}</span>{/if}
    {/snippet}
    {#snippet extra()}
      {#if order}
        <a class="tool-link" href={`/print/packing-list/${order.id}`} target="_blank" rel="noopener"><FileText size={15} />Packing list</a>
        {#if order.status === 'DRAFT' && hasRole(roles, ['PROCUREMENT', 'PROCUREMENT_MANAGER'])}<button class="btn small primary" disabled={working || dirty} onclick={() => transition('submit')}><Send size={14} />{m.gui_duyet()}</button>{/if}
        {#if order.status === 'PENDING_APPROVAL' && hasRole(roles, ['PROCUREMENT_MANAGER', 'DIRECTOR'])}<button class="btn small primary" disabled={working} onclick={() => transition('approve')}><ShieldCheck size={14} />{m.duyet_don_mua()}</button>{/if}
        {#if ['DRAFT', 'PENDING_APPROVAL', 'APPROVED'].includes(order.status) && hasRole(roles, ['PROCUREMENT_MANAGER', 'DIRECTOR'])}<button class="btn small" disabled={working} onclick={() => transition('cancel')}><XCircle size={14} />{m.po_huy_don()}</button>{/if}
      {/if}
    {/snippet}
    {#snippet children(active)}
      {#if error}<div class="banner error"><CircleAlert size={17} /><span>{error}</span>{#if conflict}<button class="btn small" onclick={load}><RefreshCw size={14} />{m.rw_tai_lai()}</button>{/if}</div>{/if}
      {#if success}<div class="banner success"><CircleCheck size={17} />{success}</div>{/if}

      <div class="kpis">
        <div class="card kpi"><p class="label">{m.po_gia_tri_don()} ({currency})</p><p class="value">{money(totals.total, currency)}</p><p class="note">{currency === 'VND' ? m.po_don_trong_nuoc() : totals.vnd ? `≈ ${vnd(totals.vnd)}` : m.po_can_ty_gia()}</p></div>
        <div class="card kpi"><p class="label">{m.po_so_thung()}</p><p class="value">{num(totals.packing.cartons)}</p><p class="note">{m.po_dong_thieu_quy_cach({ count: totals.packing.incompleteLines })}</p></div>
        <div class="card kpi"><p class="label">CBM / kg</p><p class="value">{totals.packing.cbm} m³</p><p class="note">{num(totals.packing.grossKg)} kg {m.po_ca_bi()}</p></div>
        <div class="card kpi"><p class="label">{m.po_goi_y_container()}</p><p class="value">{totals.container}</p><p class="note">{order?.paidTotal ? `${m.po_da_tra()} ${money(order.paidTotal, currency)}` : m.po_chua_tra()}</p></div>
      </div>

      {#if active === 'main'}
        <RecordSection id="po-contract" title={m.po_hop_dong()}>
          <div class="grid">
            <div class="field span2">
              <label for="po-supplierId">{m.nha_cung_cap()} <span class="req">*</span></label>
              <select id="po-supplierId" bind:value={header.supplierId} disabled={!editable}>
                <option value="">{m.chon_nha_cung_cap()}</option>
                {#each suppliers.filter((row) => row.status !== 'INACTIVE' || row.id === header.supplierId) as row}<option value={row.id}>{row.code} — {row.name}</option>{/each}
              </select>
            </div>
            {@render choice('warehouseId', m.kho_nhan(), warehouses.map((row) => ({ value: row.id, label: `${row.code} — ${row.name}` })), false, true)}
            {@render field('supplierContractNo', m.po_so_hop_dong(), { maxlength: 60, hint: m.po_so_hop_dong_goi_y() })}
            {@render field('contractDate', m.po_ngay_hop_dong(), { type: 'date' })}
            {@render field('expectedDate', m.ngay_du_kien_ve(), { type: 'date' })}
            {@render choice('currency', m.po_tien_te(), CURRENCIES.map((value) => ({ value, label: value })), false)}
            {#if currency !== 'VND'}{@render field('exchangeRate', m.po_ty_gia(), { decimals: 4, hint: m.po_ty_gia_goi_y({ currency }) })}{/if}
            {@render choice('incoterm', m.po_dieu_kien_giao(), ['EXW', 'FOB', 'CFR', 'CIF', 'DAP', 'DDP'].map((value) => ({ value, label: value })))}
            {@render field('paymentTerms', m.po_dieu_kien_thanh_toan(), { maxlength: 300, span: true, hint: m.po_dieu_kien_thanh_toan_goi_y() })}
            {@render field('depositPercent', m.po_phan_tram_coc(), { decimals: 2 })}
          </div>
        </RecordSection>
        <RecordSection id="po-shipping" title={m.po_van_chuyen()}>
          <div class="grid">
            {@render choice('shippingMethod', m.po_phuong_thuc(), ['SEA', 'AIR', 'ROAD', 'RAIL', 'EXPRESS'].map((value) => ({ value, label: shippingMethodLabel(value) })))}
            {@render field('portOfLoading', m.po_cang_di(), { hint: m.po_cang_di_goi_y() })}
            {@render field('portOfDischarge', m.po_cang_den(), { hint: m.po_cang_den_goi_y() })}
            {@render field('etd', 'ETD', { type: 'date' })}
            {@render field('eta', 'ETA', { type: 'date' })}
            <label class="check"><input type="checkbox" bind:checked={partial} disabled={!editable} />{m.po_giao_tung_phan()}</label>
            {@render field('shippingMark', m.po_ky_ma_hieu(), { maxlength: 300, span: true })}
            <div class="field span3"><label for="po-note">{m.ghi_chu()}</label><textarea id="po-note" rows="2" bind:value={header.note} readonly={!editable} maxlength="500"></textarea></div>
          </div>
        </RecordSection>
      {:else if active === 'lines'}
        <section class="card">
          <LineGrid bind:rows={lines} {columns} gridKey="purchase-order-lines" readonly={!editable} exportName={order?.code ?? 'don-mua'}
            suggestions={products.map((product) => ({ value: product.sku, label: productName(product) }))}
            onadd={editable ? addCode : undefined} oncreate={editable && canCreateProduct ? createProduct : undefined} onremove={editable ? (index) => lines.splice(index, 1) : undefined} />
        </section>
      {:else if active === 'receive' && order}
        <section class="card">
          <div class="table-wrap">
            <table class="table">
              <thead><tr><th>{m.ma_sp()}</th><th>{m.ten_san_pham()}</th><th class="num">{m.so_luong_dat()}</th><th class="num">{m.da_nhan_dv_co_so()}</th>{#if canReceive}<th class="num">{m.thuc_nhan_lan_nay()}</th>{/if}</tr></thead>
              <tbody>
                {#each order.lines as line}
                  <tr>
                    <td class="code">{line.sku}</td>
                    <td>{line.productName}</td>
                    <td class="num">{num(line.quantity)} {line.unit}</td>
                    <td class="num"><span class:done={remaining(line) === 0}>{num(line.receivedBaseQuantity)} / {num(line.baseQuantity)}</span></td>
                    {#if canReceive}<td class="num"><NumberInput class="input qty" decimals={3} bind:value={receipt[line.productId]} aria-label={m.thuc_nhan({ sku: line.sku })} /></td>{/if}
                  </tr>
                {/each}
              </tbody>
            </table>
          </div>
          {#if canReceive}
            <footer class="receive">
              <div class="field"><label for="reference">{m.so_phieu_giao_hang_cua_ncc()}</label><input id="reference" bind:value={reference} placeholder={m.tuy_chon()} /></div>
              <button class="btn primary" disabled={working} onclick={receive}><PackageCheck size={16} />{working ? m.dang_ghi_so() : m.lap_phieu_nhap_kho()}</button>
            </footer>
          {/if}
        </section>
        {#if (order.currency ?? 'VND') !== 'VND'}<p class="hint">{m.po_nhan_theo_lo_ghi_chu()}</p>{/if}
      {:else if active === 'payments' && order}
        <section class="card">
          <header class="card-head head"><h2>{m.po_thanh_toan_ncc()}</h2>{#if canPay}<button class="btn small primary" onclick={() => { paymentError = ''; payment = { kind: order?.payments?.length ? 'BALANCE' : 'DEPOSIT', amount: '', paidOn: todayIso(), reference: '', note: '' }; paymentOpen = true; }}><Plus size={14} />{m.po_ghi_thanh_toan()}</button>{/if}</header>
          <div class="table-wrap">
            <table class="table">
              <thead><tr><th>{m.ngay()}</th><th>{m.po_loai()}</th><th class="num">{m.crm_so_tien()} ({order.currency ?? 'VND'})</th><th>{m.po_chung_tu_ngan_hang()}</th><th>{m.ghi_chu()}</th><th>{m.rw_nguoi_thuc_hien()}</th>{#if canPay}<th></th>{/if}</tr></thead>
              <tbody>
                {#each order.payments ?? [] as row (row.id)}
                  <tr><td>{date(row.paidOn)}</td><td>{paymentKindLabel(row.kind)}</td><td class="num"><b>{money(row.amount, order.currency ?? 'VND')}</b></td><td>{row.reference ?? '—'}</td><td class="muted">{row.note ?? ''}</td><td class="muted">{row.recordedByName ?? ''}</td>{#if canPay}<td class="row-actions"><button class="icon-btn danger" aria-label={m.crud_xoa()} onclick={() => removePayment(row.id)}><Trash2 size={15} /></button></td>{/if}</tr>
                {:else}<tr class="empty-row"><td colspan="7">{m.po_chua_tra()}</td></tr>{/each}
              </tbody>
              {#if order.payments?.length}<tfoot><tr><td colspan="2">{m.po_da_tra()}</td><td class="num">{money(order.paidTotal, order.currency ?? 'VND')}</td><td colspan="4">{m.po_con_lai()} {money(Number(order.total) - Number(order.paidTotal ?? 0), order.currency ?? 'VND')}</td></tr></tfoot>{/if}
            </table>
          </div>
        </section>
        <p class="hint">{m.po_thanh_toan_ghi_chu()}</p>
      {:else if active === 'shipments' && order}
        {#if canShip}<div class="ship-actions"><a class="btn small primary" href={`/procurement/shipments/new?po=${order.id}`}><Ship size={15} />{m.po_tao_lo_hang()}</a></div>{/if}
        <RelatedTable endpoint={`/import-shipments?purchaseOrderId=${order.id}`} empty={m.po_chua_co_lo()} columns={[
          { label: m.po_so_lo(), value: (row: { id: string; code?: string }) => text(row.code), href: (row: { id: string }) => `/procurement/shipments/${row.id}` },
          { label: 'Container', value: (row: { id: string; containerNo?: string; containerType?: string }) => `${text(row.containerNo) || '—'} ${text(row.containerType)}` },
          { label: 'B/L', value: (row: { id: string; billOfLading?: string }) => text(row.billOfLading) || '—' },
          { label: 'ETA', value: (row: { id: string; eta?: string }) => (row.eta ? date(row.eta) : '—') },
          { label: m.trang_thai(), value: (row: { id: string; status?: string }) => text(row.status) },
        ]} />
      {:else if active === 'attachments' && order}
        <AttachmentsPanel type="purchase-orders" id={order.id} onchange={(count) => (attachmentCount = count)} purposes={[{ purpose: 'PURCHASE_DOCUMENT', label: m.po_chung_tu_dinh_kem(), pdf: true }]} />
      {:else if active === 'history' && order}
        <HistoryPanel type="purchase-orders" id={order.id} {fieldLabels} {actionLabels} reload={historyReload} />
      {/if}
    {/snippet}
  </RecordWindow>

  <Dialog bind:open={paymentOpen} title={m.po_ghi_thanh_toan()}>
    <form id="payment-form" class="pay" onsubmit={addPayment}>
      {#if paymentError}<div class="banner error"><CircleAlert size={17} /><span>{paymentError}</span></div>{/if}
      <div class="field"><label for="pay-kind">{m.po_loai()}</label><select id="pay-kind" bind:value={payment.kind}><option value="DEPOSIT">{m.po_dat_coc()}</option><option value="BALANCE">{m.po_thanh_toan_con_lai()}</option><option value="OTHER">{m.po_khac()}</option></select></div>
      <div class="field"><label for="pay-amount">{m.crm_so_tien()} ({order?.currency ?? 'VND'}) <span class="req">*</span></label><NumberInput id="pay-amount" decimals={2} bind:value={payment.amount} required /></div>
      <div class="field"><label for="pay-date">{m.ngay()}</label><input id="pay-date" type="date" bind:value={payment.paidOn} max={todayIso()} /></div>
      <div class="field"><label for="pay-ref">{m.po_chung_tu_ngan_hang()}</label><input id="pay-ref" bind:value={payment.reference} maxlength="80" /></div>
      <div class="field"><label for="pay-note">{m.ghi_chu()}</label><input id="pay-note" bind:value={payment.note} maxlength="300" /></div>
    </form>
    {#snippet footer()}
      <button type="button" class="btn" onclick={() => (paymentOpen = false)}>{m.huy()}</button>
      <button type="submit" class="btn primary" form="payment-form">{m.crud_luu()}</button>
    {/snippet}
  </Dialog>
{:else if loading}
  <div class="card skeleton" style="height: 320px"></div>
{/if}

<ProductDialog bind:open={newProductOpen} product={null} initial={newProductInitial} categories={productCategories} onsaved={productCreated} />

<style>
  .grid { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 14px 16px; align-items: start; }
  .span { grid-column: span 2; }
  .span2 { grid-column: span 2; }
  .span3 { grid-column: 1 / -1; }
  .check { display: flex; align-items: center; gap: 8px; min-height: 42px; margin-top: 22px; font-size: 13.5px; }
  .check input { width: 17px; height: 17px; accent-color: var(--navy); }
  .head { padding-bottom: 12px; }
  .done { color: var(--green); font-weight: 700; }
  td :global(.qty) { width: 110px; text-align: center; }
  .receive { display: flex; align-items: flex-end; justify-content: flex-end; gap: 14px; padding: 16px 20px; border-top: 1px solid var(--line-soft); }
  .receive .field { width: 280px; }
  .ship-actions { display: flex; justify-content: flex-end; margin-bottom: 12px; }
  .pay { display: grid; gap: 14px; }
  .tool-link { display: inline-flex; align-items: center; gap: 6px; min-height: 34px; padding: 0 10px; border-radius: 7px; font-size: 13px; font-weight: 600; }
  .tool-link:hover { background: var(--surface-2); color: var(--navy); }
  .banner .btn { margin-left: auto; }
  .hint { margin: 0 0 12px; color: var(--subtle); font-size: 12.5px; }
  @media (max-width: 900px) { .grid { grid-template-columns: 1fr 1fr; } .span, .span2 { grid-column: 1 / -1; } }
  @media (max-width: 640px) { .grid { grid-template-columns: 1fr; } }
</style>
