<script lang="ts">
  import { m } from '$lib/paraglide/messages';
  import { intlLocale, templateDescription } from '$lib/i18n';
  /**
   * Form "Phiếu xuất kho bán hàng" (số BH) theo mẫu chứng từ thật của INOXPRAN.
   * Kế toán lập/sửa và phát hành phiếu; nhân viên kinh doanh có thể gửi đề nghị nháp cho kế toán.
   *
   * Mọi con số được tính ngay trên trình duyệt (không chờ máy chủ) từ bảng giá riêng của khách, bằng đúng hàm
   * máy chủ dùng khi lưu chứng từ — xem $lib/sales-issue và $shared/sales-math.
   */
  import type { Product, SalesOrder, SalesPriceSheet, Warehouse, WarehouseKeeper } from '@inoxpran/contracts';
  import { goto } from '$app/navigation';
  import { page } from '$app/state';
  import { onMount, tick } from 'svelte';
  import { CircleAlert, CircleCheck, Clock, Gift, Info, Lock, Pencil, Plus, RotateCcw, ScanLine, X } from 'lucide-svelte';
  import Dialog from './Dialog.svelte';
  import { api } from '$lib/api';
  import { num, todayIso, vnd } from '$lib/format';
  import { hasRole, tierLabel } from '$lib/labels';
  import { computeIssue, type IssueProduct } from '$lib/sales-issue';
  import CustomerCreateDialog, { CUSTOMER_CREATE_ROLES } from './CustomerCreateDialog.svelte';
  import { periodText } from '$lib/server-text';
  import { defaultWarehouseId, session } from '$lib/session.svelte';
  import { vndInWords } from '$lib/vnd-words';
  import { isVatRate, roundDong, VAT_RATE_OPTIONS, vatPercent, type VatRate } from '$shared/sales-math';
  import { expandSalesOrderCode, normalizeSalesOrderCode, periodOfDate, salesIssueTemplate, salesOrderCodeProblem } from '$shared/sales-templates';
  import NumberInput from './NumberInput.svelte';
  import CustomerPicker from './CustomerPicker.svelte';

  type ExistingOrder = SalesOrder & { codeMode?: 'AUTO' | 'MANUAL'; priceOverrideRequestId?: string; priceOverrideApprovedByName?: string; templateCode?: string; warehouseKeeperId?: string; contactName?: string; description?: string; deliveryLocation?: string; confirmationNote?: string; confirmationStatus?: string };
  type CatalogProduct = Product & { available?: string; categoryName?: string };
  type Dealer = {
    id: string; code: string; name: string; province?: string; address?: string; phone?: string; taxCode?: string; customerTier?: string;
    status: string; holdReason?: string; creditLimit: string; paymentTermDays: number; salesRepId?: string; outstanding: string; periodRevenue: string;
  };
  type Employee = { id: string; code: string; name: string; role: string };
  type Line = { productId: string; skuInput: string; unit: string; quantity: string; gift: boolean; overrideUnitPrice?: string | undefined };
  type Grant = { id: string; code?: string; status: 'PENDING' | 'APPROVED' | 'REJECTED' | 'CANCELLED'; decidedByName?: string; decisionNote?: string };

  let { existing = null }: { existing?: ExistingOrder | null } = $props();

  let dealers = $state<Dealer[]>([]);
  let dealerCodes = $state<string[]>([]);
  let dealersLoaded = $state(false);
  let customerDialogOpen = $state(false);
  const canCreateCustomer = $derived(hasRole(session.user?.roles, CUSTOMER_CREATE_ROLES));
  let products = $state<CatalogProduct[]>([]);
  let warehouses = $state<Warehouse[]>([]);
  let employees = $state<Employee[]>([]);

  /** Số phiếu: tự sinh BHyyyymm#### hoặc tự nhập (vd. theo số phiếu giấy). */
  let codeMode = $state<'AUTO' | 'MANUAL'>('AUTO');
  let manualCode = $state('');
  let codeInput = $state<HTMLInputElement>();
  /** Số sẽ lưu: chỉ gõ số hóa đơn ("104") → BH + năm + tháng của ngày chứng từ + 0104. */
  const expandedCode = $derived.by(() => (manualCode.trim() ? expandSalesOrderCode(normalizeSalesOrderCode(manualCode), periodOfDate(orderDate)) : ''));
  const manualCodeError = $derived.by(() => {
    if (codeMode !== 'MANUAL' || !manualCode.trim()) return '';
    const problem = salesOrderCodeProblem(expandedCode);
    return problem === 'FORMAT' ? m.bh_so_phieu_khong_hop_le() : problem === 'RESERVED' ? m.bh_so_phieu_trung_kieu_chung_tu_khac() : '';
  });
  async function chooseCodeMode(mode: 'AUTO' | 'MANUAL') {
    codeMode = mode;
    if (mode === 'MANUAL') {
      if (!manualCode && existing) manualCode = existing.code;
      await tick();
      codeInput?.focus();
      codeInput?.select();
    }
  }

  /**
   * Sửa đơn giá: kế toán bấm vào đơn giá → xin quyền kèm lý do → Admin / Giám đốc duyệt từ xa → ô giá mở khóa.
   * Quyền chỉ dùng cho phiên lập phiếu này (mã phiên bên dưới) hoặc phiếu nháp đang sửa; lập phiếu khác phải xin lại.
   */
  const formSessionId = crypto.randomUUID();
  let grant = $state<Grant | null>(null);
  let priceRequestOpen = $state(false);
  let priceRequestReason = $state('');
  let priceRequesting = $state(false);
  let editingPrice = $state<number | null>(null);
  let priceDraft = $state('');

  let customerId = $state('');
  let channel = $state<'B2B' | 'B2C'>('B2B');
  let orderDate = $state(todayIso());
  let salesRepId = $state('');
  let warehouseId = $state('');
  let keepers = $state<WarehouseKeeper[]>([]);
  let warehouseKeeperId = $state('');
  let paymentTermDays = $state(30);
  let requestedDeliveryDate = $state('');
  let contactName = $state('');
  let description = $state('');
  let deliveryLocation = $state('');
  let note = $state('');
  let vatRate = $state<VatRate>('8');
  let vatTouched = $state(false);
  let lines = $state<Line[]>([{ productId: '', skuInput: '', unit: '', quantity: '', gift: false }]);
  let scan = $state('');
  let scanInput = $state<HTMLInputElement>();

  let sheet = $state<SalesPriceSheet | null>(null);
  let sheetLoading = $state(false);
  let saving = $state(false);
  let error = $state('');
  let loadError = $state('');

  /** Mẫu chứng từ của form này: PXK-001 — một thuế suất GTGT cho cả phiếu. Phiếu cũ giữ nguyên mẫu đã lập. */
  const template = $derived(salesIssueTemplate(existing?.templateCode));
  const roles = $derived(session.user?.roles ?? []);
  const isAccountant = $derived(hasRole(roles, ['ACCOUNTANT']));
  const dealer = $derived(dealers.find((item) => item.id === customerId));
  const productById = $derived(new Map(products.map((product) => [product.id, product])));
  const basisById = $derived(new Map((sheet?.items ?? []).map((item) => [item.productId, item])));
  const issueProducts = $derived(new Map<string, IssueProduct>(products.map((product) => [product.id, product])));
  /** Toàn bộ phép tính của phiếu — chạy lại tức thì mỗi khi số lượng, đơn vị, hàng tặng, thuế suất hay bảng giá thay đổi. */
  const calc = $derived(computeIssue(lines, issueProducts, sheet, vatRate));
  const summary = $derived(calc.summary);
  const taxPercent = $derived(Number(vatPercent(vatRate)));
  const taxDivisor = $derived((1 + taxPercent / 100).toLocaleString(intlLocale(), { maximumFractionDigits: 2 }));
  const defaultVat = $derived(sheet?.defaultVatRate ?? '8');
  const termOptions = $derived([...new Set([0, 15, 21, 30, 45, 60, dealer?.paymentTermDays ?? 30])].sort((a, b) => a - b));
  const blocked = $derived(dealer?.status === 'ON_HOLD');
  const period = $derived(orderDate.slice(0, 7).replace('-', ''));
  /** Ô số phiếu ở chế độ Tự sinh: phiếu cũ giữ số tự sinh đang có; phiếu mới / phiếu đang mang số tự nhập sẽ được cấp số mới khi lưu. */
  const autoCodeText = $derived(existing && existing.codeMode !== 'MANUAL' ? existing.code : m.bh_tu_sinh({ period: period }));
  const hasLines = $derived(calc.lines.some((line) => line !== null));

  const price2 = (value: string | number) => Number(value).toLocaleString(intlLocale(), { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const dong = (value: string) => num(roundDong(value));

  const grantApproved = $derived(grant?.status === 'APPROVED');
  /** Quản trị gốc đang sửa phiếu đã phát hành: lưu qua /root, tồn kho / công nợ tự điều chỉnh theo chênh lệch. */
  const rootEdit = $derived(Boolean(existing && existing.status !== 'DRAFT' && session.user?.root));
  const shippedOrder = $derived(Boolean(existing && ['SHIPPED', 'PARTIALLY_SHIPPED', 'DELIVERED'].includes(existing.status)));
  /** Đơn giá chưa thuế dạng tiền 2 số lẻ gửi máy chủ ("480000", "123456.78"). */
  const money = (value: string) => String(Math.round(Number(value) * 100) / 100);

  function clickPrice(index: number, current: string) {
    if (!isAccountant) return;
    if (grantApproved) {
      editingPrice = index;
      priceDraft = lines[index]?.overrideUnitPrice ?? current;
      return;
    }
    if (grant?.status === 'PENDING') return;
    priceRequestReason = '';
    priceRequestOpen = true;
  }
  function applyPrice(index: number) {
    const line = lines[index];
    if (line && Number(priceDraft) > 0) line.overrideUnitPrice = money(priceDraft);
    editingPrice = null;
  }
  function resetPrice(index: number) {
    const line = lines[index];
    if (line) line.overrideUnitPrice = undefined;
  }
  async function requestPriceOverride() {
    if (priceRequestReason.trim().length < 5) return;
    priceRequesting = true;
    error = '';
    try {
      grant = await api<Grant>('/price-override-requests', {
        method: 'POST',
        idempotentCommand: true,
        body: JSON.stringify({ reason: priceRequestReason.trim(), formSessionId, ...(customerId ? { customerId } : {}), ...(existing ? { salesOrderId: existing.id } : {}) }),
      });
      priceRequestOpen = false;
    } catch (caught) {
      error = caught instanceof Error ? caught.message : m.khong_the_hoan_tat_thao_tac();
    } finally {
      priceRequesting = false;
    }
  }
  async function cancelPriceRequest() {
    if (!grant) return;
    try {
      await api(`/price-override-requests/${grant.id}/cancel`, { method: 'POST', body: '{}' });
    } catch {
      // Đã được xử lý trước đó: tải lại trạng thái ở lần hỏi kế tiếp.
    }
    grant = null;
  }
  // Đang chờ duyệt: hỏi lại mỗi 4 giây; Admin / Giám đốc duyệt xong thì ô giá tự mở khóa.
  $effect(() => {
    if (grant?.status !== 'PENDING') return;
    const id = grant.id;
    const timer = setInterval(async () => {
      try {
        const latest = await api<Grant>(`/price-override-requests/${id}`);
        if (latest.status !== 'PENDING' && grant?.id === id) grant = latest;
      } catch {
        // Mạng chập chờn: thử lại ở nhịp sau.
      }
    }, 4000);
    return () => clearInterval(timer);
  });

  onMount(async () => {
    if (existing?.priceOverrideRequestId) grant = { id: existing.priceOverrideRequestId, status: 'APPROVED', decidedByName: existing.priceOverrideApprovedByName ?? '' };
    // Đặt chế độ số phiếu ngay khi mở form (trước khi tải danh mục) để ô số không nháy "Tự sinh" rồi mới đổi.
    if (existing?.codeMode === 'MANUAL') {
      codeMode = 'MANUAL';
      manualCode = existing.code;
    }
    try {
      const [dealerResult, productRows, warehouseRows, employeeRows] = await Promise.all([
        api<{ rows: Dealer[] }>('/dealers?stage=CUSTOMER'),
        api<CatalogProduct[]>('/products?status=ACTIVE'),
        api<Warehouse[]>('/warehouses'),
        api<Employee[]>('/employees'),
      ]);
      setDealers(dealerResult.rows);
      products = productRows;
      warehouses = warehouseRows.filter((row) => row.active);
      employees = employeeRows.filter((row) => row.role === 'SALES' || row.role === 'SALES_MANAGER');
      if (existing) {
        customerId = existing.customerId;
        channel = existing.channel ?? 'B2B';
        orderDate = (existing.orderDate ?? existing.createdAt).slice(0, 10);
        salesRepId = existing.salesRepId ?? '';
        warehouseId = existing.warehouseId;
        warehouseKeeperId = existing.warehouseKeeperId ?? '';
        paymentTermDays = existing.paymentTermDays ?? 30;
        requestedDeliveryDate = existing.requestedDeliveryDate ?? '';
        contactName = existing.contactName ?? '';
        description = existing.description ?? '';
        deliveryLocation = existing.deliveryLocation ?? '';
        note = existing.note ?? '';
        if (isVatRate(existing.taxRate)) {
          vatRate = existing.taxRate;
          vatTouched = true;
        }
        lines = existing.lines.map((line) => ({
          productId: line.productId, skuInput: line.sku, unit: line.unit, quantity: String(Number(line.quantity)), gift: Boolean(line.gift),
          ...(line.pricingSource === 'MANUAL_PRICE' && !line.gift ? { overrideUnitPrice: money(String(line.unitPrice)) } : {}),
        }));
        await Promise.all([loadSheet(), loadKeepers()]);
      } else {
        warehouseId = warehouses.find((row) => row.id === defaultWarehouseId())?.id ?? warehouses[0]?.id ?? '';
        loadKeepers();
        const preset = page.url.searchParams.get('customer');
        const presetDealer = dealers.find((row) => row.code === preset || row.id === preset);
        if (presetDealer) chooseCustomer(presetDealer.id);
      }
    } catch (caught) {
      loadError = caught instanceof Error ? caught.message : m.khong_tai_duoc_du_lieu_danh();
    }
  });

  /** Tải bảng giá riêng của khách tại kho xuất (một lần); sau đó mọi phép tính diễn ra ngay trên trình duyệt. */
  let sheetSequence = 0;
  async function loadSheet() {
    const sequence = ++sheetSequence;
    if (!customerId || !warehouseId) {
      sheet = null;
      return;
    }
    sheetLoading = true;
    try {
      const result = await api<SalesPriceSheet>(`/sales-orders/price-sheet?customerId=${customerId}&warehouseId=${warehouseId}`);
      if (sequence !== sheetSequence) return;
      sheet = result;
      if (!vatTouched && isVatRate(result.defaultVatRate)) vatRate = result.defaultVatRate;
    } catch (caught) {
      if (sequence === sheetSequence) {
        sheet = null;
        error = caught instanceof Error ? caught.message : m.khong_tai_duoc_bang_gia_cua();
      }
    } finally {
      if (sequence === sheetSequence) sheetLoading = false;
    }
  }

  /** Tài khoản thủ kho của kho xuất — chỉ người được chọn thấy phiếu và lập phiếu SWK. */
  async function loadKeepers() {
    if (!warehouseId) {
      keepers = [];
      return;
    }
    try {
      keepers = await api<WarehouseKeeper[]>(`/sales-orders/warehouse-keepers?warehouseId=${warehouseId}`);
      if (!keepers.some((keeper) => keeper.id === warehouseKeeperId)) warehouseKeeperId = keepers.length === 1 ? (keepers[0]?.id ?? '') : '';
    } catch (caught) {
      keepers = [];
      error = caught instanceof Error ? caught.message : m.khong_tai_duoc_danh_sach_thu();
    }
  }

  function changeWarehouse() {
    loadSheet();
    loadKeepers();
  }

  function setDealers(rows: Dealer[]) {
    dealers = rows.filter((row) => row.status !== 'INACTIVE');
    dealerCodes = rows.map((row) => row.code);
    dealersLoaded = true;
  }

  /** Khách vừa tạo ở hộp thoại: tải lại danh sách (có dư nợ, doanh số) rồi chọn luôn khách đó. */
  async function customerCreated(partner: { id: string }) {
    try {
      setDealers((await api<{ rows: Dealer[] }>('/dealers?stage=CUSTOMER')).rows);
      chooseCustomer(partner.id);
    } catch (caught) {
      error = caught instanceof Error ? caught.message : m.khong_tai_duoc_du_lieu_danh();
    }
  }

  function chooseCustomer(id: string) {
    const previous = dealer;
    customerId = id;
    sheet = null;
    const selected = dealers.find((row) => row.id === id);
    if (!selected) return;
    channel = selected.customerTier === 'RETAIL' ? 'B2C' : 'B2B';
    paymentTermDays = selected.paymentTermDays;
    if (selected.salesRepId) salesRepId = selected.salesRepId;
    if (!description || description === `Bán hàng ${previous?.name ?? ''}`) description = `Bán hàng ${selected.name}`;
    loadSheet();
  }

  function chooseVat(value: string) {
    if (!isVatRate(value)) return;
    vatRate = value;
    vatTouched = true;
  }

  function unitsOf(product: CatalogProduct | undefined) {
    if (!product) return [];
    return [
      { value: product.baseUnit, label: product.baseUnit },
      ...product.unitConversions.map((conversion) => ({ value: conversion.unit, label: `${conversion.unit} (${num(conversion.factorToBase)})` })),
    ];
  }

  function setProduct(line: Line, product: CatalogProduct | undefined, unit?: string) {
    if (!product) {
      line.productId = '';
      return;
    }
    const duplicate = lines.find((other) => other !== line && other.productId === product.id && other.gift === line.gift);
    if (duplicate) {
      duplicate.quantity = String(Number(duplicate.quantity || 0) + 1);
      line.productId = '';
      line.skuInput = '';
      error = m.da_co_tren_phieu_da_cong({ sku: product.sku });
      return;
    }
    if (line.productId !== product.id) line.overrideUnitPrice = undefined;
    line.productId = product.id;
    line.skuInput = product.sku;
    line.unit = line.gift ? product.baseUnit : unit ?? product.baseUnit;
    if (!line.quantity) line.quantity = '1';
  }

  function lookup(code: string): { product?: CatalogProduct; unit?: string } {
    const value = code.trim().toUpperCase();
    if (!value) return {};
    const bySku = products.find((product) => product.sku === value);
    if (bySku) return { product: bySku };
    for (const product of products) {
      const conversion = product.unitConversions.find((item) => item.barcode === value);
      if (conversion) return { product, unit: conversion.unit };
    }
    return {};
  }

  function onSkuChange(line: Line) {
    const found = lookup(line.skuInput);
    setProduct(line, found.product, found.unit);
    if (!found.product && line.skuInput) error = m.khong_tim_thay_ma_trong_danh({ toUpperCase: line.skuInput.toUpperCase() });
  }

  function scanAdd(event: KeyboardEvent) {
    if (event.key !== 'Enter') return;
    event.preventDefault();
    const found = lookup(scan);
    if (!found.product) {
      error = m.khong_tim_thay_ma_hang_hoac({ scan: scan });
      return;
    }
    error = '';
    let target = lines.find((line) => !line.productId && !line.gift);
    if (!target) {
      lines.push({ productId: '', skuInput: '', unit: '', quantity: '', gift: false });
      target = lines[lines.length - 1] as Line;
    }
    setProduct(target, found.product, found.unit);
    scan = '';
  }

  /** Enter ở ô số lượng → quay lại ô quét mã để nhập dòng tiếp theo bằng bàn phím. */
  function quantityKey(event: KeyboardEvent) {
    if (event.key === 'Enter') {
      event.preventDefault();
      scanInput?.focus();
    }
  }

  function addLine(gift = false) {
    lines.push({ productId: '', skuInput: '', unit: '', quantity: '', gift });
  }
  /** Thêm nhanh dòng hàng tặng cùng mã (như phiếu thật: tặng 1 sản phẩm mỗi mã). */
  function addGiftFor(line: Line) {
    const product = productById.get(line.productId);
    if (!product) return;
    const existingGift = lines.find((other) => other.productId === product.id && other.gift);
    if (existingGift) existingGift.quantity = String(Number(existingGift.quantity || 0) + 1);
    else lines.push({ productId: product.id, skuInput: product.sku, unit: product.baseUnit, quantity: '1', gift: true });
  }
  function removeLine(index: number) {
    lines.splice(index, 1);
    if (!lines.length) addLine();
  }

  function payload() {
    const code = expandedCode;
    return {
      ...(codeMode === 'MANUAL' && code !== existing?.code ? { code } : {}),
      ...(codeMode === 'AUTO' && existing?.codeMode === 'MANUAL' ? { codeMode: 'AUTO' } : {}),
      formSessionId,
      ...(grantApproved && grant && calc.lines.some((line) => line?.overridden) ? { priceOverrideRequestId: grant.id } : {}),
      templateCode: template.code, customerId, warehouseId, channel, orderDate, paymentTermDays, taxRate: vatRate,
      ...(warehouseKeeperId ? { warehouseKeeperId } : {}),
      ...(salesRepId ? { salesRepId } : {}),
      ...(requestedDeliveryDate ? { requestedDeliveryDate } : {}),
      ...(contactName.trim() ? { contactName: contactName.trim() } : {}),
      ...(description.trim() ? { description: description.trim() } : {}),
      ...(deliveryLocation.trim() ? { deliveryLocation: deliveryLocation.trim() } : {}),
      ...(note.trim() ? { note: note.trim() } : {}),
      lines: calc.lines.flatMap((computed) => {
        const line = computed ? lines[computed.index] : undefined;
        return computed && line ? [{ productId: line.productId, unit: line.unit, quantity: computed.quantity, gift: line.gift, ...(computed.overridden && line.overrideUnitPrice ? { overrideUnitPrice: line.overrideUnitPrice } : {}) }] : [];
      }),
    };
  }

  async function save(issue: boolean) {
    error = '';
    if (codeMode === 'MANUAL' && isAccountant && (!manualCode.trim() || manualCodeError)) {
      error = manualCodeError || m.bh_nhap_so_phieu_truoc();
      codeInput?.focus();
      return;
    }
    if (!customerId || !warehouseId || !salesRepId) {
      error = m.chon_day_du_nguoi_mua_nhan();
      return;
    }
    if (isAccountant && !warehouseKeeperId) {
      error = m.chon_thu_kho_xuat_hang_chi();
      return;
    }
    const badLine = calc.lineErrors.findIndex((message) => message);
    if (badLine >= 0) {
      error = m.dong_2({ p0: badLine + 1, p1: calc.lineErrors[badLine] ?? "" });
      return;
    }
    if (calc.pending || sheetLoading) {
      error = m.dang_tai_bang_gia_cua_khach_2();
      return;
    }
    if (!calc.lines.some((line) => line && !lines[line.index]?.gift)) {
      error = m.phieu_can_it_nhat_mot_dong();
      return;
    }
    if (requestedDeliveryDate && requestedDeliveryDate < orderDate) {
      error = m.ngay_giao_du_kien_phai_lon();
      return;
    }
    saving = true;
    const expectedTotal = summary.grandTotal;
    try {
      const order = existing
        ? await api<SalesOrder>(`/sales-orders/${existing.id}${rootEdit ? '/root' : ''}`, { method: 'PATCH', idempotentCommand: true, body: JSON.stringify({ ...payload(), version: existing.version }) })
        : await api<SalesOrder>('/sales-orders', { method: 'POST', idempotentCommand: true, body: JSON.stringify(payload()) });
      if (issue) {
        await api(`/sales-orders/${order.id}/submit`, { method: 'POST', idempotentCommand: true, body: JSON.stringify({ version: order.version }) });
      }
      // Máy chủ tính lại bằng cùng công thức; chỉ lệch khi bảng giá/khuyến mãi vừa đổi trong lúc đang lập phiếu.
      const repriced = String(Number(order.grandTotal)) !== expectedTotal ? `&repriced=${expectedTotal}` : '';
      await goto(`/sales/orders/${order.id}?created=${rootEdit ? 'root-edited' : issue ? 'issued' : isAccountant ? 'draft' : 'requested'}${repriced}`);
    } catch (caught) {
      error = caught instanceof Error ? caught.message : m.khong_the_luu_phieu();
    } finally {
      saving = false;
    }
  }
</script>

<section class="page-head">
  <div>
    <nav class="crumbs" aria-label={m.duong_dan()}><a href="/sales/orders">{m.don_hang()}</a><span><a href="/sales/orders">{m.phieu_xuat_kho_ban_hang()}</a></span><span>{existing ? m.sua({ code: existing.code }) : isAccountant ? m.lap_phieu_moi() : m.de_nghi_xuat_ban()}</span></nav>
    <h1 class="page-title">{existing ? m.sua_phieu_xuat_kho_ban_hang({ code: existing.code }) : isAccountant ? m.lap_phieu_xuat_kho_ban_hang() : m.de_nghi_ke_toan_lap_phieu()}</h1>
    <p class="page-sub">
      <span class="pill template" title={templateDescription(template)}>{m.mau()} {template.code}</span>
      {#if isAccountant}{m.ke_toan_lap_phieu_bh_kinh()}{:else}{m.gui_de_nghi_de_ke_toan()}{/if}
    </p>
  </div>
  <div class="actions">
    <a class="btn" href={existing ? `/sales/orders/${existing.id}` : '/sales/orders'}>{m.huy_bo()}</a>
    {#if rootEdit}
      <button class="btn primary" disabled={saving} onclick={() => save(false)}>{saving ? m.dang_xu_ly() : m.root_luu_thay_doi()}</button>
    {:else if isAccountant}
      <button class="btn soft" disabled={saving} onclick={() => save(false)}>{m.luu_nhap()}</button>
      <button class="btn primary" disabled={saving || blocked} onclick={() => save(true)}>{saving ? m.dang_xu_ly() : m.phat_hanh_phieu_bh()}</button>
    {:else}
      <button class="btn primary" disabled={saving || blocked} onclick={() => save(false)}>{saving ? m.dang_gui() : existing ? m.luu_de_nghi() : m.gui_de_nghi_cho_ke_toan()}</button>
    {/if}
  </div>
</section>

{#if loadError}<div class="banner error"><CircleAlert size={17} />{loadError}</div>{/if}
{#if existing?.confirmationStatus === 'REVISION_REQUESTED' && existing.confirmationNote}
  <div class="banner warning"><CircleAlert size={17} /><span><b>{m.kinh_doanh_yeu_cau_sua()}</b> {existing.confirmationNote}</span></div>
{/if}
{#if rootEdit}<div class="banner warning"><CircleAlert size={17} /><span>{shippedOrder ? m.root_sua_phieu_da_xuat() : m.root_sua_phieu_da_phat_hanh()}</span></div>{/if}
{#if error}<div class="banner error"><CircleAlert size={17} /><span>{error}</span><button class="close" onclick={() => (error = '')} aria-label={m.dong()}><X size={15} /></button></div>{/if}
{#if blocked}<div class="banner error"><CircleAlert size={17} /><span><b>{dealer?.name}</b> {m.dang_tam_khoa_dat_hang()}{dealer?.holdReason === 'OVERDUE_60' ? m.do_co_cong_no_qua_han() : ''}{m.can_thu_hoi_cong_no_truoc()}</span></div>{/if}

<article class="card block">
  <header class="block-head"><span class="step">1</span><h2>{m.thong_tin_nguoi_mua()}</h2><small>(<span class="req">*</span>{m.truong_bat_buoc()}</small></header>
  <div class="grid">
    <div class="field">
      <div class="code-head">
        <label for="code">{m.so_phieu()}{#if codeMode === 'MANUAL' && isAccountant} <span class="req">*</span>{/if}</label>
        {#if isAccountant && !shippedOrder}<div class="code-mode" role="radiogroup" aria-label={m.bh_che_do_so_phieu()}>
          <button type="button" role="radio" aria-checked={codeMode === 'AUTO'} class:on={codeMode === 'AUTO'} onclick={() => chooseCodeMode('AUTO')}>{m.bh_che_do_tu_sinh()}</button>
          <button type="button" role="radio" aria-checked={codeMode === 'MANUAL'} class:on={codeMode === 'MANUAL'} onclick={() => chooseCodeMode('MANUAL')}>{m.bh_che_do_tu_nhap()}</button>
        </div>{/if}
      </div>
      {#if codeMode === 'MANUAL' && isAccountant}
        <input id="code" bind:this={codeInput} bind:value={manualCode} maxlength="40" autocomplete="off" spellcheck="false" placeholder={m.bh_vi_du_so_phieu_ngan()} class="code-manual" aria-invalid={Boolean(manualCodeError)} />
        {#if manualCodeError}<small class="error">{manualCodeError}</small>{:else if expandedCode && expandedCode !== normalizeSalesOrderCode(manualCode)}<small class="field-hint code-preview">{m.bh_so_se_la({ code: expandedCode })}</small>{/if}
      {:else}
        <input id="code" value={codeMode === 'MANUAL' ? (existing?.code ?? '') : autoCodeText} readonly />
      {/if}
    </div>
    <div class="field"><label for="date">{m.ngay_chung_tu()} <span class="req">*</span></label><input id="date" type="date" max={todayIso()} bind:value={orderDate} /></div>
    <div class="field wide">
      <label for="customer">{m.nguoi_mua_ma_khach_hang()} <span class="req">*</span></label>
      <CustomerPicker options={dealers} value={customerId} onchoose={chooseCustomer} loading={!dealersLoaded && !loadError} />
      {#if canCreateCustomer}<button type="button" class="add-customer" onclick={() => (customerDialogOpen = true)}><Plus size={14} />{m.them_khach_hang_moi()}</button>
      {:else if !existing}<small class="field-hint">{m.kh_khong_co_quyen_tao({ path: `${m.danh_muc()} → ${m.ho_so_dai_ly_khach_hang()}` })}</small>{/if}
    </div>
  </div>
  {#if dealer}
    <dl class="buyer">
      <div><dt>{m.dia_chi()}</dt><dd>{dealer.address ?? '—'}</dd></div>
      <div><dt>{m.dien_thoai()}</dt><dd>{dealer.phone ?? '—'}</dd></div>
      <div><dt>{m.ma_so_thue()}</dt><dd>{dealer.taxCode ?? '—'}</dd></div>
      <div><dt>{m.cap_han_muc()}</dt><dd>{tierLabel[dealer.customerTier ?? 'RETAIL']} · {dealer.customerTier === 'RETAIL' ? m.tra_ngay() : Number(dealer.creditLimit) > 0 ? vnd(dealer.creditLimit) : m.khong_cap_cong_no()}</dd></div>
      <div><dt>{m.du_no_hien_tai()}</dt><dd class:danger={Number(dealer.creditLimit) > 0 && Number(sheet?.customer.exposure ?? dealer.outstanding) > Number(dealer.creditLimit) && dealer.customerTier !== 'RETAIL'}>{vnd(sheet?.customer.exposure ?? dealer.outstanding)}</dd></div>
      <div><dt>{m.ck_bac_doanh_so()}</dt><dd>{sheet ? m.luy_ke({ salesTierRate: sheet.customer.salesTierRate, periodLabel: periodText(sheet.customer.periodLabel), p2: vnd(sheet.customer.periodRevenue) }) : sheetLoading ? m.dang_tai() : '—'}</dd></div>
    </dl>
  {/if}
  <div class="grid second">
    <div class="field"><label for="contact">{m.ten_khach_hang_nguoi_nhan_lien()}</label><input id="contact" bind:value={contactName} maxlength="120" placeholder={m.khong_bat_buoc()} /></div>
    <div class="field wide"><label for="description">{m.dien_giai()}</label><input id="description" bind:value={description} maxlength="300" /></div>
    <div class="field">
      <label for="rep">{m.nhan_vien_ban_hang()} <span class="req">*</span></label>
      <select id="rep" bind:value={salesRepId}><option value="">{m.chon_nhan_vien()}</option>{#each employees as row}<option value={row.id}>{row.name} ({row.code})</option>{/each}</select>
    </div>
    <div class="field">
      <label for="warehouse">{m.kho_xuat()} <span class="req">*</span></label>
      <select id="warehouse" bind:value={warehouseId} onchange={changeWarehouse} disabled={shippedOrder} title={shippedOrder ? m.root_khong_doi_kho() : ''}>{#each warehouses as row}<option value={row.id}>{row.code} — {row.name}</option>{/each}</select>
    </div>
    <div class="field">
      <label for="keeper">{m.thu_kho_xuat_hang()} {#if isAccountant}<span class="req">*</span>{/if}</label>
      <select id="keeper" bind:value={warehouseKeeperId} class:missing={isAccountant && !warehouseKeeperId} aria-describedby="keeper-hint">
        <option value="">{keepers.length ? m.chon_thu_kho_tiep_nhan() : m.kho_chua_co_tai_khoan_thu()}</option>
        {#each keepers as keeper}<option value={keeper.id}>{keeper.displayName}{keeper.title ? ` — ${keeper.title}` : ''}</option>{/each}
      </select>
      <small id="keeper-hint" class="field-hint">{isAccountant ? m.chi_thu_kho_duoc_chon_thay() : m.ke_toan_se_chon_khi_phat()}</small>
    </div>
    <div class="field wide"><label for="location">{m.dia_diem_giao_hang()}</label><input id="location" bind:value={deliveryLocation} maxlength="300" placeholder={m.de_trong_neu_khach_lay_tai()} /></div>
    <div class="field">
      <label for="term">{m.dieu_khoan_thanh_toan()}</label>
      <select id="term" bind:value={paymentTermDays}>{#each termOptions as days}<option value={days}>{days === 0 ? m.thanh_toan_ngay() : m.cong_no_ngay({ days: days })}</option>{/each}</select>
    </div>
    <div class="field"><label for="channel">{m.kenh_ban()}</label><select id="channel" bind:value={channel}><option value="B2B">{m.b2b_dai_ly_npp()}</option><option value="B2C">{m.b2c_khach_le()}</option></select></div>
    <div class="field"><label for="delivery">{m.ngay_giao_du_kien()}</label><input id="delivery" type="date" min={orderDate} bind:value={requestedDeliveryDate} /></div>
  </div>
</article>

<article class="card block">
  <header class="block-head">
    <span class="step">2</span><h2>{m.hang_hoa()}</h2>
    <label class="scan"><ScanLine size={16} /><input bind:this={scanInput} bind:value={scan} onkeydown={scanAdd} placeholder={m.quet_ma_vach_nhap_ma_hang()} aria-label={m.quet_ma_vach_hoac_nhap_ma()} /></label>
    <button class="btn soft small" onclick={() => addLine(false)}><Plus size={15} />{m.them_dong()}</button>
    <button class="btn small" onclick={() => addLine(true)}><Gift size={15} />{m.them_hang_tang()}</button>
  </header>
  {#if isAccountant && grant?.status === 'PENDING'}
    <div class="banner warning price-grant"><Clock size={16} /><span>{m.gia_dang_cho_duyet({ code: grant.code ?? '' })}</span><button type="button" class="link" onclick={cancelPriceRequest}>{m.gia_huy_yeu_cau()}</button></div>
  {:else if grantApproved}
    <div class="banner success price-grant"><Pencil size={16} /><span>{m.gia_da_duoc_cap_quyen({ by: grant?.decidedByName || '—' })}</span></div>
  {:else if isAccountant && grant?.status === 'REJECTED'}
    <div class="banner error price-grant"><CircleAlert size={16} /><span>{m.gia_bi_tu_choi({ by: grant.decidedByName ?? '—', note: grant.decisionNote ?? '' })}</span><button type="button" class="link" onclick={() => (grant = null)}>{m.gia_xin_lai()}</button></div>
  {/if}
  <datalist id="sku-list">{#each products as product}<option value={product.sku}>{product.name}</option>{/each}</datalist>
  <div class="table-wrap">
    <table class="table lines">
      <thead><tr><th>{m.stt()}</th><th>{m.ma_hang()}</th><th>{m.ten_hang()}</th><th>{m.don_vi()}</th><th class="num">{m.ton_kha_dung()}</th><th class="num">{m.so_luong()}</th><th class="num">{m.don_gia()}<small>{vatRate === 'KCT' ? m.khong_chiu_thue() : m.chua_thue_gtgt()}</small></th><th class="num">CK (%)</th><th class="num">{m.thanh_tien()}</th><th><span class="sr-only">{m.thao_tac()}</span></th></tr></thead>
      <tbody>
        {#each lines as line, index}
          {@const product = productById.get(line.productId)}
          {@const computed = calc.lines[index]}
          {@const basis = basisById.get(line.productId)}
          {@const demand = calc.demandByProduct.get(line.productId) ?? 0}
          {@const lineError = calc.lineErrors[index]}
          <tr class:gift-row={line.gift}>
            <td class="muted">{index + 1}</td>
            <td><input class="input sku" list="sku-list" bind:value={line.skuInput} onchange={() => onSkuChange(line)} placeholder="INP…" aria-label={m.ma_hang_dong({ p0: index + 1 })} /></td>
            <td class="name">{product?.name ?? ''}{#if line.gift}<span class="pill orange gift-tag">{m.hang_tang()}</span>{/if}</td>
            <td>
              {#if product}
                <select class="input unit" bind:value={line.unit} onchange={() => (line.overrideUnitPrice = undefined)} disabled={line.gift} aria-label={m.don_vi_dong({ p0: index + 1 })}>
                  {#each unitsOf(product) as unit}<option value={unit.value}>{unit.label}</option>{/each}
                </select>
              {/if}
            </td>
            <td class="num stock" class:out={basis !== undefined && demand > Number(basis.available)}>{product && basis ? num(basis.available) : ''}</td>
            <td class="num">
              <NumberInput class={lineError ? 'input qty invalid' : 'input qty'} decimals={4} bind:value={line.quantity} onkeydown={quantityKey} disabled={!product} aria-label={m.so_luong_dong({ p0: index + 1 })} aria-invalid={Boolean(lineError)} title={lineError ?? ''} />
            </td>
            <td class="num price">
              {#if computed && editingPrice === index}
                <NumberInput class="input price-input" decimals={2} bind:value={priceDraft} autofocus aria-label={m.gia_nhap_don_gia({ p0: index + 1 })}
                  onkeydown={(event: KeyboardEvent) => { if (event.key === 'Enter') { event.preventDefault(); applyPrice(index); } else if (event.key === 'Escape') editingPrice = null; }}
                  onblur={() => applyPrice(index)} />
              {:else if computed && isAccountant && !line.gift}
                <button type="button" class="price-btn" class:overridden={computed.overridden} onclick={() => clickPrice(index, computed.unitPrice)}
                  title={grantApproved ? m.gia_bam_de_sua() : grant?.status === 'PENDING' ? m.gia_dang_cho_duyet_ngan() : m.gia_bam_de_xin_quyen()}>
                  {price2(computed.unitPrice)}{#if grantApproved}<Pencil size={11} />{:else}<Lock size={11} />{/if}
                </button>
                {#if computed.overridden}<small class="orig">{m.gia_bang_gia({ price: price2(computed.originalUnitPrice) })}<button type="button" class="reset" onclick={() => resetPrice(index)} title={m.gia_ve_bang_gia()} aria-label={m.gia_ve_bang_gia()}><RotateCcw size={11} /></button></small>{/if}
              {:else if computed}
                <span title={line.gift ? m.hang_tang_don_gia_0() : m.gia_niem_yet_1({ p0: price2(computed.listPrice), p1: sheet?.pricesIncludeTax ? m.da_gom_thue() : '', discountRate: computed.discountRate, p3: sheet?.pricesIncludeTax && taxPercent ? ` ÷ ${taxDivisor}` : '', p4: price2(computed.unitPrice) })}>{price2(computed.unitPrice)}</span>
                {#if computed.overridden}<small class="orig">{m.gia_sua_tay()}</small>{/if}
              {:else if product && (sheetLoading || calc.pending)}<span class="muted">{m.dang_tai_2()}</span>{/if}
            </td>
            <td class="num">{#if computed && !line.gift}<span class="ck" title={m.bac_doanh_so_khuyen_mai_tran({ salesTierDiscountRate: computed.basis.salesTierDiscountRate, promotionDiscountRate: computed.basis.promotionDiscountRate, p2: computed.basis.promotionCode ? ` (${computed.basis.promotionCode})` : '', discountCapRate: sheet?.discountCapRate ?? "—" })}>{computed.discountRate}</span>{/if}</td>
            <td class="num"><b title={computed ? `${computed.quantity} × ${price2(computed.unitPrice)} = ${price2(computed.netAmount)}` : ''}>{computed ? dong(computed.netAmount) : ''}</b></td>
            <td><div class="row-actions">
              {#if product && !line.gift}<button class="icon gift" onclick={() => addGiftFor(line)} title={m.tang_kem_1_san_pham_cung()} aria-label={m.tang_kem({ sku: product.sku })}><Gift size={14} /></button>{/if}
              <button class="icon remove" onclick={() => removeLine(index)} aria-label={m.xoa_dong({ p0: index + 1 })}><X size={14} /></button>
            </div></td>
          </tr>
        {/each}
      </tbody>
      {#if hasLines}
        <tfoot><tr><td colspan="8">{m.cong()}</td><td class="num"><b>{dong(summary.netAmountSum)}</b></td><td></td></tr></tfoot>
      {/if}
    </table>
  </div>
  {#if calc.stockWarnings.length}
    <div class="warnings">{#each calc.stockWarnings as warning}<p class={warning.tone}><CircleAlert size={15} />{warning.text}</p>{/each}</div>
  {/if}
  <p class="hint">
    {#if sheet?.pricesIncludeTax}
      {m.bang_gia_da_gom_thue_gtgt()}{taxPercent ? ` ÷ ${taxDivisor}` : ''}{m.lam_tron_2_so_le_thanh()}
    {:else}
      {m.don_gia_tren_phieu_gia_niem()}
    {/if}
    {m.ck_bac_doanh_so_2()} {sheet ? m.luy_ke_2({ periodLabel: periodText(sheet.customer.periodLabel) }) : ''} {m.khuyen_mai_toi_da()} {sheet?.discountCapRate ?? '—'}{m.hang_tang_co_don_gia_0()}
  </p>
</article>

<section class="bottom">
  <article class="card block">
    <header class="block-head"><span class="step">3</span><h2>{m.ghi_chu_noi_bo()}</h2></header>
    <div class="field note">
      <label for="note">{m.ghi_chu_cho_ke_toan_kho()}</label>
      <textarea id="note" rows="4" maxlength="500" bind:value={note} placeholder={m.yeu_cau_dong_goi_gio_lay()}></textarea>
    </div>
  </article>

  <aside class="card summary" aria-live="polite">
    <h2>{m.tong_tien_phieu()}</h2>
    <dl>
      <div class="minor"><dt>{m.tien_hang_theo_gia_niem_yet()}</dt><dd>{vnd(summary.subtotal)}</dd></div>
      <div class="minor"><dt>{m.chiet_khau_bac_ds_ctkm()}</dt><dd>− {vnd(summary.discountTotal)}</dd></div>
      <div class="main"><dt>{m.cong_tien_hang()}</dt><dd>{vnd(summary.netTotal)}</dd></div>
      <div class="vat">
        <dt><label for="vat-rate">{m.thue_suat_thue_gtgt()}</label></dt>
        <dd>
          <select id="vat-rate" class="input vat-select" title={m.mau_2({ code: template.code, description: templateDescription(template) })} value={vatRate} onchange={(event) => chooseVat(event.currentTarget.value)}>
            {#each VAT_RATE_OPTIONS as option}<option value={option.value}>{option.value === 'KCT' ? m.kct_khong_chiu_thue() : option.label}{option.value === defaultVat ? m.mac_dinh() : ''}</option>{/each}
          </select>
        </dd>
      </div>
      <div><dt>{m.tien_thue_gtgt()}</dt><dd>{vatRate === 'KCT' ? m.khong_chiu_thue_2() : vnd(summary.taxTotal)}</dd></div>
      <div class="total"><dt>{m.tong_tien_thanh_toan()}</dt><dd>{vnd(summary.grandTotal)}</dd></div>
    </dl>
    <p class="words"><span>{m.so_tien_bang_chu()}</span> <b>{vndInWords(summary.grandTotal)}</b></p>
    {#if vatRate !== defaultVat && hasLines}
      <p class="credit info"><Info size={16} /><span>{m.khac_thue_suat_mac_dinh()} {defaultVat === 'KCT' ? 'KCT' : `${defaultVat}%`}. {sheet?.pricesIncludeTax ? m.bang_gia_da_gom_thue_nen() : m.tien_thue_va_tong_thanh_toan()} {m.kiem_tra_ma_hang_co_dung()}</span></p>
    {/if}
    {#if sheet && dealer && hasLines}
      {#if calc.creditRemainingAfter === null}
        <p class="credit ok"><CircleCheck size={16} />{sheet.customer.tier === 'RETAIL' ? m.khach_le_thanh_toan_ngay_khong() : m.khong_cap_cong_no_thanh_toan_ngay()}</p>
      {:else if calc.creditRemainingAfter >= 0}
        <p class="credit ok"><CircleCheck size={16} />{m.han_muc_con_lai_sau_phieu()} {vnd(calc.creditRemainingAfter)} / {vnd(sheet.customer.creditLimit)}</p>
      {:else}
        <p class="credit bad"><CircleAlert size={16} />{m.vuot_han_muc()} {vnd(-calc.creditRemainingAfter)} {m.phieu_se_chuyen_truong_phong_giam()}</p>
      {/if}
      {#if calc.needsApproval.overThreshold}
        <p class="credit warn"><CircleAlert size={16} />{m.gia_tri_tu()} {vnd(sheet.approvalThreshold)} {m.can_phe_duyet_truoc_khi_giu()}</p>
      {/if}
    {/if}
    {#if sheetLoading}<p class="quoting">{m.dang_tai_bang_gia_cua_khach()}</p>{/if}
  </aside>
</section>

<Dialog bind:open={priceRequestOpen} title={m.gia_xin_quyen_tieu_de()}>
  <p class="lead">{m.gia_xin_quyen_giai_thich()}</p>
  <div class="field">
    <label for="price-reason">{m.gia_ly_do()} <span class="req">*</span></label>
    <textarea id="price-reason" rows="3" maxlength="300" bind:value={priceRequestReason} placeholder={m.gia_ly_do_placeholder()}></textarea>
    {#if priceRequestReason.trim() && priceRequestReason.trim().length < 5}<small class="error">{m.bh_ly_do_toi_thieu()}</small>{/if}
  </div>
  {#snippet footer()}
    <button class="btn" onclick={() => (priceRequestOpen = false)}>{m.dong()}</button>
    <button class="btn primary" disabled={priceRequestReason.trim().length < 5 || priceRequesting} onclick={requestPriceOverride}>{m.gia_gui_yeu_cau()}</button>
  {/snippet}
</Dialog>

<CustomerCreateDialog bind:open={customerDialogOpen} existingCodes={dealerCodes} oncreated={customerCreated} />

<style>
  .banner .close { margin-left: auto; color: inherit; }
  .field-hint { color: var(--subtle); font-size: 11.5px; }
  .code-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
  .code-head label { color: var(--text); font-size: 13px; font-weight: 500; }
  .code-mode { display: inline-flex; padding: 2px; border: 1px solid var(--line); border-radius: 7px; background: var(--surface-2); }
  .code-mode button { padding: 2px 9px; border: 0; border-radius: 5px; background: transparent; color: var(--muted); font-size: 12px; cursor: pointer; }
  .code-mode button.on { background: var(--navy); color: #fff; }
  .code-manual { text-transform: uppercase; }
  .add-customer { display: inline-flex; align-items: center; gap: 4px; justify-self: start; color: var(--navy-2); font-size: 12.5px; font-weight: 600; }
  .add-customer:hover { text-decoration: underline; }
  select.missing { border-color: #f0b38f; }
  .template { margin-right: 6px; background: var(--navy); color: #fff; letter-spacing: 0.02em; }
  .block { margin-bottom: 18px; }
  .block-head { display: flex; align-items: center; gap: 12px; padding: 16px 22px; border-bottom: 1px solid var(--line-soft); }
  .block-head h2 { margin: 0; font-size: 14.5px; font-weight: 700; letter-spacing: 0.02em; text-transform: uppercase; }
  .block-head small { margin-left: auto; color: var(--subtle); font-size: 12.5px; }
  .step { display: grid; width: 24px; height: 24px; place-items: center; border-radius: 50%; background: var(--navy); color: #fff; font-size: 12.5px; font-weight: 700; }
  .grid { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); align-items: start; gap: 16px 22px; padding: 20px 22px 6px; }
  .grid.second { padding: 14px 22px 22px; }
  .wide { grid-column: span 2; }
  .buyer { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 10px 24px; margin: 14px 22px 4px; padding: 14px 16px; border-radius: 8px; background: var(--surface-2); }
  .buyer dt { color: var(--subtle); font-size: 11.5px; }
  .buyer dd { margin: 2px 0 0; font-size: 13.5px; font-weight: 500; }
  .buyer dd.danger { color: var(--red); }
  .scan { display: flex; align-items: center; gap: 7px; margin-left: auto; width: 290px; padding: 0 10px; border: 1px dashed #b9c7d4; border-radius: 8px; color: var(--muted); }
  .scan input { width: 100%; height: 32px; border: 0; outline: 0; background: transparent; font-size: 13px; }
  .lines th, .lines td { padding: 8px 8px; }
  .lines th:first-child, .lines td:first-child { padding-left: 16px; }
  .lines th small { display: block; font-size: 10.5px; font-weight: 500; text-transform: none; letter-spacing: 0; }
  .lines .input { min-height: 36px; padding: 6px 10px; }
  .lines tfoot td { padding-top: 12px; padding-bottom: 12px; border-top: 1px solid var(--line); background: var(--surface-2); font-weight: 700; }
  .sku { width: 108px; font-weight: 600; color: var(--navy); text-transform: uppercase; }
  .unit { width: 100px; }
  td :global(.qty) { width: 92px; text-align: center; font-weight: 600; }
  td :global(.qty.invalid) { border-color: var(--red); background: var(--red-soft); }
  .name { min-width: 190px; }
  .price span[title] { cursor: help; }
  .price-btn { display: inline-flex; align-items: center; gap: 4px; padding: 3px 6px; border: 1px dashed transparent; border-radius: 6px; background: transparent; color: inherit; font: inherit; cursor: pointer; }
  .price-btn:hover { border-color: var(--line); background: var(--surface-2); }
  .price-btn :global(svg) { color: var(--subtle); }
  .price-btn.overridden { border-color: var(--orange); background: var(--orange-soft); color: var(--orange); font-weight: 600; }
  .price small.orig { display: flex; align-items: center; justify-content: flex-end; gap: 4px; color: var(--subtle); font-size: 11px; }
  .price .reset { display: inline-grid; padding: 0; border: 0; background: transparent; color: var(--navy-2); cursor: pointer; }
  :global(.input.price-input) { width: 130px; text-align: right; }
  .price-grant { margin: 0 18px 12px; }
  .price-grant .link { margin-left: auto; border: 0; background: transparent; color: var(--navy-2); font-weight: 600; cursor: pointer; }
  .gift-row { background: #fffaf6; }
  .gift-tag { margin-left: 8px; }
  .stock { color: var(--green); font-weight: 600; }
  .stock.out { color: var(--red); }
  .ck { display: inline-block; min-width: 50px; padding: 6px 10px; border: 1px solid var(--line); border-radius: 7px; text-align: center; cursor: help; }
  .row-actions { display: flex; justify-content: flex-end; gap: 6px; }
  .icon { display: grid; width: 26px; height: 26px; place-items: center; border-radius: 50%; }
  .icon.gift { background: var(--orange-soft); color: var(--orange); }
  .icon.remove { background: var(--red-soft); color: var(--red); }
  .warnings { display: grid; gap: 6px; padding: 12px 22px 0; }
  .warnings p { display: flex; align-items: center; gap: 8px; width: fit-content; margin: 0; padding: 8px 14px; border-radius: 8px; font-size: 13px; }
  .warnings .warning { background: var(--orange-soft); color: #b4501f; }
  .warnings .error { background: var(--red-soft); color: var(--red); }
  .hint { margin: 0; padding: 12px 22px 18px; color: var(--subtle); font-size: 12.5px; }
  .bottom { display: grid; grid-template-columns: minmax(0, 1.5fr) minmax(360px, 1fr); gap: 18px; align-items: start; }
  .note { padding: 18px 22px 20px; }
  .summary { overflow: hidden; }
  .summary h2 { margin: 0; padding: 16px 22px; background: var(--navy); color: #fff; font-size: 14.5px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.02em; }
  dl { margin: 0; }
  .summary dl { padding: 10px 22px 6px; }
  .summary dl div { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 9px 0; }
  .summary dl .minor { padding: 4px 0; font-size: 12.5px; }
  .summary dl .main { margin-top: 6px; padding-top: 12px; border-top: 1px dashed var(--line); }
  .summary dt { color: var(--muted); }
  .summary dd { margin: 0; font-weight: 600; white-space: nowrap; font-variant-numeric: tabular-nums; }
  .vat-select { min-height: 36px; width: 210px; padding: 6px 10px; font-weight: 600; color: var(--navy); }
  .summary .total { margin-top: 4px; padding-top: 14px; border-top: 1px solid var(--line); }
  .summary .total dt { color: var(--text); font-weight: 700; text-transform: uppercase; }
  .summary .total dd { color: var(--orange); font-size: 22px; font-weight: 700; }
  .words { margin: 0 22px 14px; color: var(--muted); font-size: 13px; }
  .words b { color: var(--text); }
  .credit { display: flex; gap: 8px; margin: 0 22px 12px; padding: 10px 12px; border-radius: 8px; font-size: 12.5px; }
  .credit :global(svg) { flex: none; margin-top: 1px; }
  .credit.ok { background: var(--green-soft); color: var(--green); }
  .credit.bad { background: var(--red-soft); color: var(--red); }
  .credit.warn { background: var(--amber-soft); color: #8a6508; }
  .credit.info { background: #eaf2fb; color: var(--navy); }
  .quoting { margin: 0 22px 14px; color: var(--subtle); font-size: 12px; }
  @media (max-width: 1200px) { .grid { grid-template-columns: repeat(2, minmax(0, 1fr)); } .buyer { grid-template-columns: repeat(2, minmax(0, 1fr)); } }
  @media (max-width: 1000px) { .bottom { grid-template-columns: 1fr; } .block-head { flex-wrap: wrap; } .scan { width: 100%; margin-left: 0; } }
  @media (max-width: 640px) { .grid, .buyer { grid-template-columns: 1fr; } .wide { grid-column: auto; } .vat-select { width: 160px; } }
</style>
