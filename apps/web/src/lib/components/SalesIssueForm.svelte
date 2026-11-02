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
  import { CircleAlert, CircleCheck, Clock, Copy, Gift, Info, ListPlus, Lock, Pencil, Plus, RotateCcw, ScanLine, Trash2, X } from 'lucide-svelte';
  import Dialog from './Dialog.svelte';
  import { api } from '$lib/api';
  import { num, todayIso, vnd } from '$lib/format';
  import { hasRole, tierLabel, zeroPriceKindLabel, zeroPriceKindTone, zeroPriceRowClass } from '$lib/labels';
  import { computeIssue, type IssueProduct } from '$lib/sales-issue';
  import CustomerCreateDialog, { CUSTOMER_CREATE_ROLES } from './CustomerCreateDialog.svelte';
  import { periodText } from '$lib/server-text';
  import { can, defaultWarehouseId, session } from '$lib/session.svelte';
  import { can as canDo } from '$lib/permissions';
  import { provinceLabel } from '$shared/provinces';
  import { loadTerritories, territoryOwner } from '$lib/territories.svelte';
  import { vndInWords } from '$lib/vnd-words';
  import { isVatRate, roundDong, VAT_RATE_OPTIONS, vatPercent, type VatRate } from '$shared/sales-math';
  import { expandSalesOrderCode, NEW_SALES_ISSUE_TEMPLATE, normalizeSalesOrderCode, periodOfDate, SALES_ISSUE_TEMPLATES, salesIssueTemplate, salesOrderCodeProblem, type SalesIssueTemplate } from '$shared/sales-templates';
  import NumberInput from './NumberInput.svelte';
  import RowContextMenu, { type ContextMenuItem } from './RowContextMenu.svelte';
  import CustomerPicker from './CustomerPicker.svelte';
  import { SLIP_TYPE_OPTIONS, slipTypeLabel, slipTypeOf, type SalesSlipType } from '$lib/slip-type';
  import { defaultReturnDate } from '$shared/sales-purpose';
  import { ZERO_PRICE_KINDS, zeroPriceKindOf, type ZeroPriceKind } from '$shared/sales-line-kind';
  import { vnDate } from '$shared/warranty';

  type ExistingOrder = SalesOrder & { codeMode?: 'AUTO' | 'MANUAL'; priceOverrideRequestId?: string; priceOverrideApprovedByName?: string; templateCode?: string; warehouseKeeperId?: string; contactName?: string; description?: string; deliveryLocation?: string; confirmationNote?: string; confirmationStatus?: string };
  type LoanSource = SalesOrder & { loanRemainder?: Array<{ productId: string; sku: string; productName?: string; quantity: string }> };
  type CatalogProduct = Product & { available?: string; categoryName?: string };
  type Dealer = {
    id: string; code: string; name: string; province?: string; address?: string; phone?: string; taxCode?: string; customerTier?: string;
    status: string; holdReason?: string; creditLimit: string; paymentTermDays: number; salesRepId?: string; salesRepName?: string; outstanding: string; periodRevenue: string;
    provinceOldCode?: string; territoryChannel?: string;
  };
  type Employee = { id: string; code: string; name: string; role: string };
  /** name: tên hàng in trên phiếu — mặc định tên trong danh mục, kế toán sửa tay được (SAL-NAME-01). */
  /** vatRate: thuế suất GTGT của dòng (thuế dòng như MISA — 27/10/2026); trống = thuế suất mặc định. */
  type Line = { productId: string; skuInput: string; unit: string; quantity: string; gift: boolean; zeroPriceKind?: ZeroPriceKind | undefined; name?: string | undefined; overrideUnitPrice?: string | undefined; vatRate?: VatRate | undefined };
  type Grant = { id: string; code?: string; status: 'PENDING' | 'APPROVED' | 'REJECTED' | 'CANCELLED'; decidedByName?: string; decisionNote?: string };

  let { existing = null, requestMode = false }: { existing?: ExistingOrder | null; requestMode?: boolean } = $props();
  /** Đề nghị sửa (SAL-CHG-01): lý do bắt buộc, gửi cho Admin duyệt thay vì lưu thẳng. */
  let requestReason = $state('');

  let dealers = $state<Dealer[]>([]);
  let dealerCodes = $state<string[]>([]);
  let dealersLoaded = $state(false);
  let customerDialogOpen = $state(false);
  const canCreateCustomer = $derived(hasRole(session.user?.roles, CUSTOMER_CREATE_ROLES));
  let products = $state<CatalogProduct[]>([]);
  let warehouses = $state<Warehouse[]>([]);
  let allEmployees = $state<Employee[]>([]);

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
   * Sửa đơn giá: bấm vào đơn giá → xin quyền kèm lý do → người duyệt sửa giá duyệt từ xa → ô giá mở khóa. Người lập có sẵn
   * quyền duyệt (Admin, Kế toán — 29/10/2026) chỉ ghi lý do, quyền được cấp ngay.
   * Quyền chỉ dùng cho phiên lập phiếu này (mã phiên bên dưới) hoặc phiếu nháp đang sửa; lập phiếu khác phải xin lại.
   */
  const formSessionId = crypto.randomUUID();
  let grant = $state<Grant | null>(null);
  let priceRequestOpen = $state(false);
  let priceRequestReason = $state('');
  let priceRequesting = $state(false);
  const selfGrant = $derived(can('sales.price_override_approve'));
  let editingPrice = $state<number | null>(null);
  let priceDraft = $state('');

  let customerId = $state('');
  /** Loại phiếu (SAL-TYPE-01): bán B2B / bán lẻ B2C / xuất hàng mẫu / xuất kiểm định. Hàng mẫu / kiểm định: không khách, giá 0. */
  let slipType = $state<SalesSlipType>('B2B');
  const nonSale = $derived(slipType === 'SAMPLE' || slipType === 'INSPECTION' || slipType === 'GIFT');
  /** Hàng mẫu / kiểm định: có hẹn trả (mặc định hôm nay + 15 ngày) và theo dõi hàng mang về; xuất tặng thì không. */
  const loanType = $derived(slipType === 'SAMPLE' || slipType === 'INSPECTION');
  const gift = $derived(slipType === 'GIFT');
  const channel = $derived<'B2B' | 'B2C'>(slipType === 'B2C' ? 'B2C' : 'B2B');
  /** Phiếu bán: NVKD; phiếu hàng mẫu / kiểm định: bất kỳ nhân viên nào mượn hàng. */
  const employees = $derived(nonSale ? allEmployees : allEmployees.filter((row) => row.role === 'SALES' || row.role === 'SALES_MANAGER' || row.id === salesRepId));
  let destination = $state('');
  let expectedReturnDate = $state('');
  /** Lập phiếu bán từ phần hàng mẫu đại lý mua luôn (chốt "Đại lý mua luôn"). */
  let loanSource = $state<{ id: string; code: string } | null>(null);
  let orderDate = $state(todayIso());
  let salesRepId = $state('');
  let warehouseId = $state('');
  let keepers = $state<WarehouseKeeper[]>([]);
  let warehouseKeeperId = $state('');
  let paymentTermDays = $state(30);
  /** Đơn thanh toán ngay: chọn hình thức thu thì giao xong hệ thống tự ghi phiếu thu; để trống = chưa thu, ghi công nợ (AR-PAYNOW-01). */
  let payNowMethod = $state<'' | 'BANK_TRANSFER' | 'CASH'>('');
  let requestedDeliveryDate = $state('');
  let contactName = $state('');
  let description = $state('');
  let deliveryLocation = $state('');
  let note = $state('');
  /** PXK-001: thuế suất của cả phiếu; PXK-002: thuế suất mặc định cho dòng mới (mỗi dòng chọn lại ở cột "% thuế GTGT"). */
  let vatRate = $state<VatRate>('8');
  let vatTouched = $state(false);
  /** Mẫu chọn khi lập phiếu mới (27/10/2026): mặc định PXK-002 thuế từng dòng; phiếu đã lập giữ mẫu của nó. */
  let newTemplate = $state<SalesIssueTemplate>(NEW_SALES_ISSUE_TEMPLATE);
  let lines = $state<Line[]>([{ productId: '', skuInput: '', unit: '', quantity: '', gift: false }]);
  let scan = $state('');
  let scanInput = $state<HTMLInputElement>();

  let sheet = $state<SalesPriceSheet | null>(null);
  let sheetLoading = $state(false);
  let saving = $state(false);
  let error = $state('');
  let loadError = $state('');

  /** Mẫu chứng từ: PXK-001 — một thuế suất cho cả phiếu (mọi phiếu cũ, sửa vẫn giữ); PXK-002 — thuế suất từng dòng. */
  const template = $derived(existing ? salesIssueTemplate(existing.templateCode) : salesIssueTemplate(newTemplate));
  const lineVat = $derived(template.vatMode === 'LINE');
  /** Được phân công bước 2 — phát hành phiếu BH (SAL-STEP-01): lập phiếu để phát hành, chọn thủ kho, tự nhập số; không có thì gửi đề nghị. */
  const canIssue = $derived(can('sales.step.issue'));
  const dealer = $derived(dealers.find((item) => item.id === customerId));
  /** Phân vùng NVKD (PV-01): khách ở vùng đã giao thì NVKD của phiếu là NVKD của khách, chỉ Admin / quản trị gốc đổi được. */
  const repOwner = $derived(dealer?.salesRepId ? territoryOwner(dealer.provinceOldCode, dealer.territoryChannel) : null);
  const repLocked = $derived(Boolean(repOwner) && !canDo.overrideTerritory());
  const productById = $derived(new Map(products.map((product) => [product.id, product])));
  const basisById = $derived(new Map((sheet?.items ?? []).map((item) => [item.productId, item])));
  const issueProducts = $derived(new Map<string, IssueProduct>(products.map((product) => [product.id, product])));
  /** Toàn bộ phép tính của phiếu — chạy lại tức thì mỗi khi số lượng, đơn vị, hàng tặng, thuế suất hay bảng giá thay đổi. */
  const calc = $derived(computeIssue(lines, issueProducts, sheet, vatRate, template.vatMode));
  const summary = $derived(calc.summary);
  /** "1,08" — hệ số tách thuế khỏi bảng giá gồm thuế của một thuế suất. */
  const divisorOf = (rate: string) => (1 + Number(vatPercent(rate)) / 100).toLocaleString(intlLocale(), { maximumFractionDigits: 2 });
  const defaultVat = $derived(sheet?.defaultVatRate ?? '8');
  const termOptions = $derived([...new Set([0, 15, 21, 30, 45, 60, dealer?.paymentTermDays ?? 30])].sort((a, b) => a - b));
  const blocked = $derived(dealer?.status === 'ON_HOLD');
  const period = $derived(orderDate.slice(0, 7).replace('-', ''));
  /** Ô số phiếu ở chế độ Tự sinh: phiếu cũ giữ số tự sinh đang có; phiếu mới / phiếu đang mang số tự nhập sẽ được cấp số mới khi lưu. */
  const autoCodeText = $derived(existing && existing.codeMode !== 'MANUAL' ? existing.code : m.bh_tu_sinh({ period: period }));
  const hasLines = $derived(calc.lines.some((line) => line !== null));

  const price2 = (value: string | number) => Number(value).toLocaleString(intlLocale(), { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const dong = (value: string) => num(roundDong(value));

  /** Quản trị gốc đang sửa phiếu đã phát hành: lưu qua /root, tồn kho / công nợ tự điều chỉnh theo chênh lệch. */
  const rootEdit = $derived(Boolean(existing && existing.status !== 'DRAFT' && (requestMode || can('sales.edit_issued'))));
  /** Người sửa trực tiếp phiếu đã phát hành (`sales.edit_issued`) sửa đơn giá luôn, không cần xin quyền sửa giá (máy chủ cũng cho phép). */
  const grantApproved = $derived(grant?.status === 'APPROVED' || (rootEdit && !requestMode && can('sales.edit_issued')));
  const shippedOrder = $derived(Boolean(existing && ['SHIPPED', 'PARTIALLY_SHIPPED', 'DELIVERED'].includes(existing.status)));
  /** Đơn giá chưa thuế dạng tiền 2 số lẻ gửi máy chủ ("480000", "123456.78"). */
  const money = (value: string) => String(Math.round(Number(value) * 100) / 100);

  function clickPrice(index: number, current: string) {
    if (!canIssue) return;
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
    if (line && priceDraft.trim() !== '' && Number(priceDraft) >= 0) line.overrideUnitPrice = money(priceDraft);
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
  // Đang chờ duyệt: hỏi lại mỗi 4 giây; người duyệt sửa giá duyệt xong thì ô giá tự mở khóa.
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
    void loadTerritories();
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
      allEmployees = employeeRows;
      if (existing) {
        customerId = existing.customerId ?? '';
        slipType = slipTypeOf(existing);
        destination = existing.destination ?? '';
        expectedReturnDate = existing.expectedReturnDate ?? '';
        orderDate = vnDate(new Date(existing.orderDate ?? existing.createdAt));
        salesRepId = existing.salesRepId ?? '';
        warehouseId = existing.warehouseId;
        warehouseKeeperId = existing.warehouseKeeperId ?? '';
        paymentTermDays = existing.paymentTermDays ?? 30;
        payNowMethod = existing.payNowMethod ?? '';
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
          productId: line.productId, skuInput: line.sku, unit: line.unit, quantity: String(Number(line.quantity)), gift: Boolean(line.gift), name: line.productName,
          ...(zeroPriceKindOf(line) ? { zeroPriceKind: zeroPriceKindOf(line) } : {}),
          // PXK-002: thuế suất của từng dòng.
          ...(isVatRate(line.vatRate) ? { vatRate: line.vatRate } : {}),
          ...(line.pricingSource === 'MANUAL_PRICE' && !line.gift ? { overrideUnitPrice: money(String(line.unitPrice)) } : {}),
        }));
        await Promise.all([loadSheet(), loadKeepers()]);
      } else {
        warehouseId = warehouses.find((row) => row.id === defaultWarehouseId())?.id ?? warehouses[0]?.id ?? '';
        loadKeepers();
        // Đã chọn "Xuất hàng mẫu / kiểm định" trước khi danh sách kho tải xong: tải bảng giá 0 của kho vừa chọn.
        if (nonSale) loadSheet();
        const presetType = page.url.searchParams.get('type');
        if (presetType === 'SAMPLE' || presetType === 'INSPECTION' || presetType === 'GIFT') chooseSlipType(presetType);
        const preset = page.url.searchParams.get('customer');
        const presetDealer = dealers.find((row) => row.code === preset || row.id === preset);
        if (presetDealer) chooseCustomer(presetDealer.id);
        const fromLoan = page.url.searchParams.get('fromLoan');
        if (fromLoan) await prefillFromLoan(fromLoan);
      }
    } catch (caught) {
      loadError = caught instanceof Error ? caught.message : m.khong_tai_duoc_du_lieu_danh();
    }
  });

  /** Phần hàng mẫu đại lý mua luôn: điền sẵn các dòng, NVKD và ghi chú; kế toán chọn khách rồi phát hành như phiếu bán thường. */
  async function prefillFromLoan(id: string) {
    try {
      const source = await api<LoanSource>(`/sales-orders/${id}`);
      const remainder = source.loanRemainder ?? [];
      if (!remainder.length) return;
      loanSource = { id: source.id, code: source.code };
      lines = remainder.map((line) => ({ productId: line.productId, skuInput: line.sku, unit: productById.get(line.productId)?.baseUnit ?? '', quantity: String(Number(line.quantity)), gift: false, name: line.productName }));
      if (source.salesRepId) salesRepId = source.salesRepId;
      note = m.lp_lap_phieu_ban_tu_mau({ code: source.code });
    } catch (caught) {
      error = caught instanceof Error ? caught.message : m.khong_tai_duoc_du_lieu_danh();
    }
  }

  /** Đổi loại phiếu: hàng mẫu / kiểm định bỏ khách, hàng tặng, giá sửa tay; bảng giá tải lại theo loại. */
  function chooseSlipType(type: SalesSlipType) {
    const wasNonSale = nonSale;
    slipType = type;
    const nowNonSale = type === 'SAMPLE' || type === 'INSPECTION' || type === 'GIFT';
    // Hẹn trả mặc định 15 ngày cho hàng mẫu / kiểm định; loại khác không có hẹn trả.
    if (type === 'SAMPLE' || type === 'INSPECTION') {
      if (!expectedReturnDate) expectedReturnDate = defaultReturnDate(todayIso());
    } else expectedReturnDate = '';
    if (nowNonSale) {
      lines = lines.filter((line) => !line.gift).map((line) => ({ ...line, overrideUnitPrice: undefined }));
      if (!lines.length) addLine();
      editingPrice = null;
      if (description.startsWith('Bán hàng ')) description = '';
    } else if (wasNonSale && dealer) {
      description = `Bán hàng ${dealer.name}`;
    }
    if (nowNonSale !== wasNonSale) {
      sheet = null;
      loadSheet();
    }
  }

  /** Tải bảng giá riêng của khách tại kho xuất (một lần); sau đó mọi phép tính diễn ra ngay trên trình duyệt. */
  let sheetSequence = 0;
  async function loadSheet() {
    const sequence = ++sheetSequence;
    if (!warehouseId || (!nonSale && !customerId)) {
      sheet = null;
      return;
    }
    sheetLoading = true;
    try {
      // Phiếu hàng mẫu / kiểm định: bảng không khách (giá 0, chỉ tồn khả dụng).
      const result = await api<SalesPriceSheet>(`/sales-orders/price-sheet?${nonSale ? '' : `customerId=${customerId}&`}warehouseId=${warehouseId}`);
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

  function chooseVat(value: string) {
    if (!isVatRate(value)) return;
    vatRate = value;
    vatTouched = true;
  }

  function chooseCustomer(id: string) {
    const previous = dealer;
    customerId = id;
    sheet = null;
    const selected = dealers.find((row) => row.id === id);
    if (!selected) return;
    slipType = selected.customerTier === 'RETAIL' ? 'B2C' : 'B2B';
    paymentTermDays = selected.paymentTermDays;
    if (selected.salesRepId) salesRepId = selected.salesRepId;
    if (!description || description === `Bán hàng ${previous?.name ?? ''}`) description = `Bán hàng ${selected.name}`;
    loadSheet();
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
      line.name = '';
      return;
    }
    // Dòng hàng khác phải giữ riêng: người nhập có thể chọn loại SAU khi gõ mã.
    // Gộp ngay theo loại mặc định sẽ cộng nhầm vào hàng tặng trước khi đổi sang hàng đổi / bù.
    const duplicate = !line.gift ? lines.find((other) => other !== line && !other.gift && other.productId === product.id) : undefined;
    if (duplicate) {
      duplicate.quantity = String(Number(duplicate.quantity || 0) + 1);
      line.productId = '';
      line.skuInput = '';
      error = m.da_co_tren_phieu_da_cong({ sku: product.sku });
      return;
    }
    if (line.productId !== product.id) {
      line.overrideUnitPrice = undefined;
      line.name = product.name;
    }
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

  /** Chỉ gửi tên hàng khi khác tên trong danh mục (trống = tên danh mục). */
  function customName(line: Line): { productName?: string } {
    const name = line.name?.trim() ?? '';
    const product = productById.get(line.productId);
    return name && name !== product?.name ? { productName: name } : {};
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
    lines.push({ productId: '', skuInput: '', unit: '', quantity: '', gift, ...(gift ? { zeroPriceKind: 'GIFT' as const } : {}) });
  }
  /** Thêm nhanh dòng hàng tặng cùng mã (như phiếu thật: tặng 1 sản phẩm mỗi mã). */
  function addGiftFor(line: Line) {
    const product = productById.get(line.productId);
    if (!product) return;
    const existingGift = lines.find((other) => other.productId === product.id && zeroPriceKindOf(other) === 'GIFT');
    if (existingGift) existingGift.quantity = String(Number(existingGift.quantity || 0) + 1);
    else lines.push({ productId: product.id, skuInput: product.sku, unit: product.baseUnit, quantity: '1', gift: true, zeroPriceKind: 'GIFT', name: line.name || product.name });
  }
  function removeLine(index: number) {
    lines.splice(index, 1);
    if (!lines.length) addLine();
  }

  // ---------- Menu chuột phải trên dòng hàng (SAL-CTX-01, 27/10/2026 — kế toán: sao chép dòng như MISA) ----------
  let lineBody = $state<HTMLTableSectionElement>();
  let rowMenu = $state({ open: false, x: 0, y: 0, index: -1 });
  /** Chuột phải (hoặc phím menu) trên một dòng; giữ Shift thì để menu của trình duyệt (sao chép / dán chữ). */
  function openRowMenu(event: MouseEvent) {
    const row = (event.target as Element).closest<HTMLTableRowElement>('tr[data-line]');
    if (!row || event.shiftKey) return;
    event.preventDefault();
    // Mở bằng bàn phím: trình duyệt không có tọa độ chuột → đặt menu dưới ô đang chọn.
    const keyboard = event.clientX === 0 && event.clientY === 0;
    const rect = (event.target as Element).getBoundingClientRect();
    rowMenu = { open: true, x: keyboard ? rect.left : event.clientX, y: keyboard ? rect.bottom : event.clientY, index: Number(row.dataset.line) };
  }
  async function focusLine(index: number, selector: string) {
    await tick();
    lineBody?.rows[index]?.querySelector<HTMLInputElement>(selector)?.focus();
  }
  /** Chèn bản sao ngay dưới dòng (mã, tên, đơn vị, số lượng, loại hàng, giá sửa tay) — không gộp vào dòng cũ. */
  function duplicateLine(index: number) {
    const line = lines[index];
    if (!line) return;
    editingPrice = null;
    lines.splice(index + 1, 0, { ...$state.snapshot(line) });
    void focusLine(index + 1, 'input.qty');
  }
  function insertLineBelow(index: number) {
    editingPrice = null;
    lines.splice(index + 1, 0, { productId: '', skuInput: '', unit: '', quantity: '', gift: false });
    void focusLine(index + 1, 'input.sku');
  }
  const rowMenuItems = $derived.by((): ContextMenuItem[] => {
    const index = rowMenu.index;
    const line = lines[index];
    if (!line) return [];
    const product = productById.get(line.productId);
    return [
      { label: m.bh_ctx_sao_chep_dong(), icon: Copy, disabled: !product, action: () => duplicateLine(index) },
      { label: m.bh_ctx_them_dong_duoi(), icon: ListPlus, action: () => insertLineBelow(index) },
      ...(product && !line.gift && !nonSale ? [{ label: m.tang_kem({ sku: product.sku }), icon: Gift, action: () => addGiftFor(line) }] : []),
      { label: m.xoa_dong({ p0: index + 1 }), icon: Trash2, danger: true, action: () => removeLine(index) },
    ];
  });

  function payload() {
    const code = expandedCode;
    return {
      ...(codeMode === 'MANUAL' && code !== existing?.code ? { code } : {}),
      ...(codeMode === 'AUTO' && existing?.codeMode === 'MANUAL' ? { codeMode: 'AUTO' } : {}),
      formSessionId,
      ...(!nonSale && grantApproved && grant && calc.lines.some((line) => line?.overridden) ? { priceOverrideRequestId: grant.id } : {}),
      templateCode: template.code, warehouseId, orderDate, taxRate: vatRate,
      ...(nonSale
        ? { purpose: slipType, ...(destination.trim() ? { destination: destination.trim() } : {}), ...(loanType && expectedReturnDate ? { expectedReturnDate } : {}) }
        : { purpose: 'SALE', customerId, channel, paymentTermDays, ...(Number(paymentTermDays) === 0 && payNowMethod ? { payNowMethod } : {}) }),
      ...(warehouseKeeperId ? { warehouseKeeperId } : {}),
      ...(salesRepId ? { salesRepId } : {}),
      ...(requestedDeliveryDate ? { requestedDeliveryDate } : {}),
      ...(contactName.trim() ? { contactName: contactName.trim() } : {}),
      ...(description.trim() ? { description: description.trim() } : {}),
      ...(deliveryLocation.trim() ? { deliveryLocation: deliveryLocation.trim() } : {}),
      ...(note.trim() ? { note: note.trim() } : {}),
      lines: calc.lines.flatMap((computed) => {
        const line = computed ? lines[computed.index] : undefined;
        if (!computed || !line) return [];
        const name = customName(line);
        const rate = lineVat ? { vatRate: computed.vatRate } : {};
        if (nonSale) return [{ productId: line.productId, unit: line.unit, quantity: computed.quantity, gift: false, ...rate, ...name }];
        return [{ productId: line.productId, unit: line.unit, quantity: computed.quantity, gift: line.gift, ...rate, ...(line.gift ? { zeroPriceKind: zeroPriceKindOf(line) } : {}), ...name, ...(computed.overridden && line.overrideUnitPrice ? { overrideUnitPrice: line.overrideUnitPrice } : {}) }];
      }),
    };
  }

  async function save(issue: boolean) {
    error = '';
    if (codeMode === 'MANUAL' && canIssue && (!manualCode.trim() || manualCodeError)) {
      error = manualCodeError || m.bh_nhap_so_phieu_truoc();
      codeInput?.focus();
      return;
    }
    if (!warehouseId || !salesRepId || (!nonSale && !customerId)) {
      error = gift ? m.lp_chon_nguoi_phu_trach() : nonSale ? m.lp_chon_nguoi_muon() : m.chon_day_du_nguoi_mua_nhan();
      return;
    }
    if (loanType && expectedReturnDate && expectedReturnDate < orderDate) {
      error = m.ngay_giao_du_kien_phai_lon();
      return;
    }
    if (requestMode && requestReason.trim().length < 5) {
      error = m.bh_ly_do_toi_thieu();
      return;
    }
    if (canIssue && !warehouseKeeperId) {
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
    if (!calc.lines.some((line) => line && (nonSale || !lines[line.index]?.gift))) {
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
      if (existing && requestMode) {
        await api(`/sales-orders/${existing.id}/change-requests`, { method: 'POST', idempotentCommand: true, body: JSON.stringify({ kind: 'EDIT', version: existing.version, reason: requestReason.trim(), changes: { ...payload(), version: existing.version } }) });
        await goto(`/sales/orders/${existing.id}?created=change-requested`);
        return;
      }
      const order = existing
        ? await api<SalesOrder>(`/sales-orders/${existing.id}${rootEdit ? '/root' : ''}`, { method: 'PATCH', idempotentCommand: true, body: JSON.stringify({ ...payload(), version: existing.version }) })
        : await api<SalesOrder>('/sales-orders', { method: 'POST', idempotentCommand: true, body: JSON.stringify(payload()) });
      if (issue) {
        await api(`/sales-orders/${order.id}/submit`, { method: 'POST', idempotentCommand: true, body: JSON.stringify({ version: order.version }) });
      }
      // Máy chủ tính lại bằng cùng công thức; chỉ lệch khi bảng giá/khuyến mãi vừa đổi trong lúc đang lập phiếu.
      const repriced = String(Number(order.grandTotal)) !== expectedTotal ? `&repriced=${expectedTotal}` : '';
      await goto(`/sales/orders/${order.id}?created=${rootEdit ? 'root-edited' : issue ? 'issued' : canIssue ? 'draft' : 'requested'}${repriced}`);
    } catch (caught) {
      error = caught instanceof Error ? caught.message : m.khong_the_luu_phieu();
    } finally {
      saving = false;
    }
  }
</script>

<section class="page-head">
  <div>
    <nav class="crumbs" aria-label={m.duong_dan()}><a href="/sales/orders">{m.don_hang()}</a><span><a href="/sales/orders">{m.phieu_xuat_kho_ban_hang()}</a></span><span>{existing ? m.sua({ code: existing.code }) : canIssue ? m.lap_phieu_moi() : m.de_nghi_xuat_ban()}</span></nav>
    <h1 class="page-title">{existing ? m.sua_phieu_xuat_kho_ban_hang({ code: existing.code }) : slipType === 'SAMPLE' ? m.lp_lap_phieu_hang_mau() : slipType === 'INSPECTION' ? m.lp_lap_phieu_kiem_dinh() : gift ? m.lp_lap_phieu_xuat_tang() : canIssue ? m.lap_phieu_xuat_kho_ban_hang() : m.de_nghi_ke_toan_lap_phieu()}</h1>
    <p class="page-sub">
      {#if existing}<span class="pill template" title={templateDescription(template)}>{m.mau()} {template.code}</span>
      {:else}<select class="pill template template-select" bind:value={newTemplate} title={templateDescription(template)} aria-label={m.bh_chon_mau()}>{#each SALES_ISSUE_TEMPLATES as code}<option value={code}>{code === 'PXK-002' ? m.bh_mau_thue_dong() : m.bh_mau_thue_tong()}</option>{/each}</select>{/if}
      {#if nonSale}{m.lp_khong_tinh_tien_ngan()} · {slipTypeLabel(slipType)}{:else if canIssue}{m.ke_toan_lap_phieu_bh_kinh()}{:else}{m.gui_de_nghi_de_ke_toan()}{/if}
    </p>
  </div>
  <div class="actions">
    <a class="btn" href={existing ? `/sales/orders/${existing.id}` : '/sales/orders'}>{m.huy_bo()}</a>
    {#if requestMode}
      <button class="btn primary" disabled={saving || requestReason.trim().length < 5} onclick={() => save(false)}>{saving ? m.dang_gui() : m.yc_gui_de_nghi_sua()}</button>
    {:else if rootEdit}
      <button class="btn primary" disabled={saving} onclick={() => save(false)}>{saving ? m.dang_xu_ly() : m.root_luu_thay_doi()}</button>
    {:else if canIssue}
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
{#if requestMode}
  <div class="banner info request-reason">
    <CircleAlert size={17} />
    <div class="field">
      <label for="request-reason">{m.yc_sua_ghi_chu()}</label>
      <textarea id="request-reason" rows="2" maxlength="300" bind:value={requestReason} placeholder={m.yc_ly_do_sua()}></textarea>
    </div>
  </div>
{/if}
{#if error}<div class="banner error"><CircleAlert size={17} /><span>{error}</span><button class="close" onclick={() => (error = '')} aria-label={m.dong()}><X size={15} /></button></div>{/if}
{#if loanSource}<div class="banner info"><Info size={17} /><span>{m.lp_dien_san_tu_mau({ code: loanSource.code })}</span></div>{/if}
{#if nonSale}<div class="banner info"><Info size={17} /><span>{gift ? m.lp_khong_tinh_tien_tang() : m.lp_khong_tinh_tien()}</span></div>{/if}
{#if blocked && !nonSale}<div class="banner error"><CircleAlert size={17} /><span><b>{dealer?.name}</b> {m.dang_tam_khoa_dat_hang()}{dealer?.holdReason === 'OVERDUE_60' ? m.do_co_cong_no_qua_han() : ''}{m.can_thu_hoi_cong_no_truoc()}</span></div>{/if}

<article class="card block">
  <header class="block-head"><span class="step">1</span><h2>{gift ? m.lp_thong_tin_xuat_tang() : nonSale ? m.lp_thong_tin_nguoi_muon() : m.thong_tin_nguoi_mua()}</h2><small>(<span class="req">*</span>{m.truong_bat_buoc()}</small></header>
  <div class="slip-types" role="radiogroup" aria-label={m.lp_loai_phieu()}>
    <span class="slip-label">{m.lp_loai_phieu()}</span>
    {#each SLIP_TYPE_OPTIONS as type}
      <button type="button" role="radio" aria-checked={slipType === type} class:on={slipType === type} class:loan={type === 'SAMPLE' || type === 'INSPECTION' || type === 'GIFT'}
        disabled={Boolean(loanSource) && (type === 'SAMPLE' || type === 'INSPECTION' || type === 'GIFT')} onclick={() => chooseSlipType(type)}>{slipTypeLabel(type)}</button>
    {/each}
  </div>
  <div class="grid">
    <div class="field">
      <div class="code-head">
        <label for="code">{m.so_phieu()}{#if codeMode === 'MANUAL' && canIssue} <span class="req">*</span>{/if}</label>
        {#if canIssue && !shippedOrder}<div class="code-mode" role="radiogroup" aria-label={m.bh_che_do_so_phieu()}>
          <button type="button" role="radio" aria-checked={codeMode === 'AUTO'} class:on={codeMode === 'AUTO'} onclick={() => chooseCodeMode('AUTO')}>{m.bh_che_do_tu_sinh()}</button>
          <button type="button" role="radio" aria-checked={codeMode === 'MANUAL'} class:on={codeMode === 'MANUAL'} onclick={() => chooseCodeMode('MANUAL')}>{m.bh_che_do_tu_nhap()}</button>
        </div>{/if}
      </div>
      {#if codeMode === 'MANUAL' && canIssue}
        <input id="code" bind:this={codeInput} bind:value={manualCode} maxlength="40" autocomplete="off" spellcheck="false" placeholder={m.bh_vi_du_so_phieu_ngan()} class="code-manual" aria-invalid={Boolean(manualCodeError)} />
        {#if manualCodeError}<small class="error">{manualCodeError}</small>{:else if expandedCode && expandedCode !== normalizeSalesOrderCode(manualCode)}<small class="field-hint code-preview">{m.bh_so_se_la({ code: expandedCode })}</small>{/if}
      {:else}
        <input id="code" value={codeMode === 'MANUAL' ? (existing?.code ?? '') : autoCodeText} readonly />
      {/if}
    </div>
    <div class="field"><label for="date">{m.ngay_chung_tu()} <span class="req">*</span></label><input id="date" type="date" max={todayIso()} bind:value={orderDate} /></div>
    {#if nonSale}
      <div class="field">
        <label for="borrower">{gift ? m.lp_nguoi_phu_trach() : m.lp_nguoi_muon()} <span class="req">*</span></label>
        <select id="borrower" bind:value={salesRepId} class:missing={!salesRepId}><option value="">{gift ? m.lp_chon_nguoi_phu_trach() : m.lp_chon_nguoi_muon()}</option>{#each employees as row}<option value={row.id}>{row.name} ({row.code})</option>{/each}</select>
      </div>
      <div class="field"><label for="destination">{gift ? m.lp_tang_cho() : m.lp_gui_toi()}</label><input id="destination" bind:value={destination} maxlength="200" placeholder={gift ? m.lp_tang_cho_goi_y() : m.lp_gui_toi_goi_y()} /></div>
    {:else}
      <div class="field wide">
        <label for="customer">{m.nguoi_mua_ma_khach_hang()} <span class="req">*</span></label>
        <CustomerPicker options={dealers} value={customerId} onchoose={chooseCustomer} loading={!dealersLoaded && !loadError} />
        {#if canCreateCustomer}<button type="button" class="add-customer" onclick={() => (customerDialogOpen = true)}><Plus size={14} />{m.them_khach_hang_moi()}</button>
        {:else if !existing}<small class="field-hint">{m.kh_khong_co_quyen_tao({ path: `${m.danh_muc()} → ${m.ho_so_dai_ly_khach_hang()}` })}</small>{/if}
      </div>
    {/if}
  </div>
  {#if dealer && !nonSale}
    <dl class="buyer">
      <div><dt>{m.dia_chi()}</dt><dd>{dealer.address ?? '—'}</dd></div>
      <div><dt>{m.dien_thoai()}</dt><dd>{dealer.phone ?? '—'}</dd></div>
      <div><dt>{m.ma_so_thue()}</dt><dd>{dealer.taxCode ?? '—'}</dd></div>
      <div><dt>{m.cap_han_muc()}</dt><dd>{tierLabel[dealer.customerTier ?? 'RETAIL']} · {dealer.customerTier === 'RETAIL' ? m.tra_ngay() : Number(dealer.creditLimit) > 0 ? vnd(dealer.creditLimit) : m.khong_cap_cong_no()}</dd></div>
      <div><dt>{m.du_no_hien_tai()}</dt><dd class:danger={Number(dealer.creditLimit) > 0 && Number(sheet?.customer?.exposure ?? dealer.outstanding) > Number(dealer.creditLimit) && dealer.customerTier !== 'RETAIL'}>{vnd(sheet?.customer?.exposure ?? dealer.outstanding)}</dd></div>
      <div><dt>{m.ck_bac_doanh_so()}</dt><dd>{sheet?.customer ? m.luy_ke({ salesTierRate: sheet.customer.salesTierRate, periodLabel: periodText(sheet.customer.periodLabel), p2: vnd(sheet.customer.periodRevenue) }) : sheetLoading ? m.dang_tai() : '—'}</dd></div>
    </dl>
  {/if}
  <div class="grid second">
    {#if !nonSale}<div class="field"><label for="contact">{m.ten_khach_hang_nguoi_nhan_lien()}</label><input id="contact" bind:value={contactName} maxlength="120" placeholder={m.khong_bat_buoc()} /></div>{/if}
    <div class="field wide"><label for="description">{m.dien_giai()}</label><input id="description" bind:value={description} maxlength="300" /></div>
    {#if !nonSale}
      <div class="field">
        <label for="rep">{m.nhan_vien_ban_hang()} <span class="req">*</span></label>
        <select id="rep" bind:value={salesRepId} disabled={repLocked}><option value="">{m.chon_nhan_vien()}</option>{#each employees as row}<option value={row.id}>{row.name} ({row.code})</option>{/each}</select>
        {#if repOwner && dealer?.salesRepName}<span class="hint">{m.pv_nv_theo_khach({ name: dealer.salesRepName, region: provinceLabel(dealer.provinceOldCode) })}</span>{/if}
      </div>
    {/if}
    <div class="field">
      <label for="warehouse">{m.kho_xuat()} <span class="req">*</span></label>
      <select id="warehouse" bind:value={warehouseId} onchange={changeWarehouse} disabled={shippedOrder} title={shippedOrder ? m.root_khong_doi_kho() : ''}>{#each warehouses as row}<option value={row.id}>{row.code} — {row.name}</option>{/each}</select>
    </div>
    <div class="field">
      <label for="keeper">{m.thu_kho_xuat_hang()} {#if canIssue}<span class="req">*</span>{/if}</label>
      <select id="keeper" bind:value={warehouseKeeperId} class:missing={canIssue && !warehouseKeeperId} aria-describedby="keeper-hint">
        <option value="">{keepers.length ? m.chon_thu_kho_tiep_nhan() : m.kho_chua_co_tai_khoan_thu()}</option>
        {#each keepers as keeper}<option value={keeper.id}>{keeper.displayName}{keeper.title ? ` — ${keeper.title}` : ''}</option>{/each}
      </select>
      <small id="keeper-hint" class="field-hint">{canIssue ? m.chi_thu_kho_duoc_chon_thay() : m.ke_toan_se_chon_khi_phat()}</small>
    </div>
    {#if nonSale}
      {#if loanType}<div class="field"><label for="return-date">{m.lp_hen_tra()}</label><input id="return-date" type="date" min={orderDate} bind:value={expectedReturnDate} /></div>{/if}
    {:else}
      <div class="field wide"><label for="location">{m.dia_diem_giao_hang()}</label><input id="location" bind:value={deliveryLocation} maxlength="300" placeholder={m.de_trong_neu_khach_lay_tai()} /></div>
      <div class="field">
        <label for="term">{m.dieu_khoan_thanh_toan()}</label>
        <select id="term" bind:value={paymentTermDays}>{#each termOptions as days}<option value={days}>{days === 0 ? m.thanh_toan_ngay() : m.cong_no_ngay({ days: days })}</option>{/each}</select>
      </div>
      {#if Number(paymentTermDays) === 0}
        <div class="field">
          <label for="pay-now-method">{m.pn_hinh_thuc_thu()}</label>
          <select id="pay-now-method" bind:value={payNowMethod}><option value="">{m.pn_chua_thu()}</option><option value="BANK_TRANSFER">{m.pn_chuyen_khoan()}</option><option value="CASH">{m.pn_tien_mat()}</option></select>
          <small class="hint">{payNowMethod ? m.pn_tu_ghi_thu() : m.pn_chua_thu_giai_thich()}</small>
        </div>
      {/if}
      <div class="field"><label for="delivery">{m.ngay_giao_du_kien()}</label><input id="delivery" type="date" min={orderDate} bind:value={requestedDeliveryDate} /></div>
    {/if}
  </div>
</article>

<article class="card block">
  <header class="block-head">
    <span class="step">2</span><h2>{m.hang_hoa()}</h2>
    <label class="scan"><ScanLine size={16} /><input bind:this={scanInput} bind:value={scan} onkeydown={scanAdd} placeholder={m.quet_ma_vach_nhap_ma_hang()} aria-label={m.quet_ma_vach_hoac_nhap_ma()} /></label>
    <button class="btn soft small" onclick={() => addLine(false)}><Plus size={15} />{m.them_dong()}</button>
    {#if !nonSale}<button class="btn small" onclick={() => addLine(true)}><Gift size={15} />{m.bh_them_hang_khac()}</button>{/if}
  </header>
  {#if nonSale}<!-- Phiếu không tính tiền: không có quyền sửa giá. -->
  {:else if canIssue && grant?.status === 'PENDING'}
    <div class="banner warning price-grant"><Clock size={16} /><span>{m.gia_dang_cho_duyet({ code: grant.code ?? '' })}</span><button type="button" class="link" onclick={cancelPriceRequest}>{m.gia_huy_yeu_cau()}</button></div>
  {:else if grantApproved}
    <div class="banner success price-grant"><Pencil size={16} /><span>{grant?.decidedByName && grant.decidedByName === session.user?.displayName ? m.gia_da_tu_mo() : m.gia_da_duoc_cap_quyen({ by: grant?.decidedByName || session.user?.displayName || '—' })}</span></div>
  {:else if canIssue && grant?.status === 'REJECTED'}
    <div class="banner error price-grant"><CircleAlert size={16} /><span>{m.gia_bi_tu_choi({ by: grant.decidedByName ?? '—', note: grant.decisionNote ?? '' })}</span><button type="button" class="link" onclick={() => (grant = null)}>{m.gia_xin_lai()}</button></div>
  {/if}
  <datalist id="sku-list">{#each products as product}<option value={product.sku}>{product.name}</option>{/each}</datalist>
  <div class="table-wrap">
    <table class="table lines">
      <thead><tr><th>{m.stt()}</th><th>{m.ma_hang()}</th><th>{m.ten_hang()}</th><th>{m.don_vi()}</th><th class="num">{m.ton_kha_dung()}</th><th class="num">{m.so_luong()}</th><th class="num">{m.don_gia()}<small>{!lineVat && vatRate === 'KCT' ? m.khong_chiu_thue() : m.chua_thue_gtgt()}</small></th><th class="num">CK (%)</th><th class="num">{m.thanh_tien()}</th>{#if lineVat && !nonSale}<th class="num">{m.bh_phan_tram_thue()}</th><th class="num">{m.bh_tien_thue_dong()}</th>{/if}<th><span class="sr-only">{m.thao_tac()}</span></th></tr></thead>
      <tbody bind:this={lineBody} oncontextmenu={openRowMenu}>
        {#each lines as line, index}
          {@const product = productById.get(line.productId)}
          {@const computed = calc.lines[index]}
          {@const basis = basisById.get(line.productId)}
          {@const demand = calc.demandByProduct.get(line.productId) ?? 0}
          {@const lineError = calc.lineErrors[index]}
          <tr data-line={index} class={line.gift ? zeroPriceRowClass(zeroPriceKindOf(line) ?? 'GIFT') : ''}>
            <td class="muted">{index + 1}</td>
            <td><input class="input sku" list="sku-list" bind:value={line.skuInput} onchange={() => onSkuChange(line)} placeholder="INP…" aria-label={m.ma_hang_dong({ p0: index + 1 })} /></td>
            <td class="name">{#if product}<input class="input pname" bind:value={line.name} maxlength="300" onblur={() => { if (!line.name?.trim()) line.name = product.name; }} aria-label={m.ten_hang_dong({ p0: index + 1 })} title={line.name && line.name !== product.name ? m.ten_hang_danh_muc({ name: product.name }) : ''} />{/if}{#if line.gift}{@const kind = zeroPriceKindOf(line) ?? 'GIFT'}<select class={`kind-select ${zeroPriceKindTone(kind)}`} value={kind} onchange={(event) => (line.zeroPriceKind = event.currentTarget.value as ZeroPriceKind)} aria-label={m.bh_loai_hang_khac_dong({ row: index + 1 })}>{#each ZERO_PRICE_KINDS as option}<option value={option}>{zeroPriceKindLabel(option)}</option>{/each}</select>{/if}</td>
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
              {:else if computed && canIssue && !line.gift && !nonSale}
                <button type="button" class="price-btn" class:overridden={computed.overridden} onclick={() => clickPrice(index, computed.unitPrice)}
                  title={grantApproved ? m.gia_bam_de_sua() : grant?.status === 'PENDING' ? m.gia_dang_cho_duyet_ngan() : selfGrant ? m.gia_bam_de_tu_cap() : m.gia_bam_de_xin_quyen()}>
                  {price2(computed.unitPrice)}{#if grantApproved}<Pencil size={11} />{:else}<Lock size={11} />{/if}
                </button>
                {#if computed.overridden}<small class="orig">{m.gia_bang_gia({ price: price2(computed.originalUnitPrice) })}<button type="button" class="reset" onclick={() => resetPrice(index)} title={m.gia_ve_bang_gia()} aria-label={m.gia_ve_bang_gia()}><RotateCcw size={11} /></button></small>{/if}
              {:else if computed}
                <span title={line.gift ? m.bh_hang_khac_gia_0() : m.gia_niem_yet_1({ p0: price2(computed.listPrice), p1: sheet?.pricesIncludeTax ? m.da_gom_thue() : '', discountRate: computed.discountRate, p3: sheet?.pricesIncludeTax && Number(vatPercent(computed.vatRate)) ? ` ÷ ${divisorOf(computed.vatRate)}` : '', p4: price2(computed.unitPrice) })}>{price2(computed.unitPrice)}</span>
                {#if computed.overridden}<small class="orig">{m.gia_sua_tay()}</small>{/if}
              {:else if product && (sheetLoading || calc.pending)}<span class="muted">{m.dang_tai_2()}</span>{/if}
              {#if computed && !computed.overridden && !line.gift && computed.basis?.pricingSource === 'CUSTOMER_PRICE'}<small class="own-price" title={m.gr_nguon_gia()}>{m.gr_nhan_phieu()}</small>{/if}
            </td>
            <td class="num">{#if computed && !line.gift}<span class="ck" title={m.bac_doanh_so_khuyen_mai_tran({ salesTierDiscountRate: computed.basis.salesTierDiscountRate, promotionDiscountRate: computed.basis.promotionDiscountRate, p2: computed.basis.promotionCode ? ` (${computed.basis.promotionCode})` : '', discountCapRate: sheet?.discountCapRate ?? "—" })}>{computed.discountRate}</span>{/if}</td>
            <td class="num"><b title={computed ? `${computed.quantity} × ${price2(computed.unitPrice)} = ${price2(computed.netAmount)}` : ''}>{computed ? dong(computed.netAmount) : ''}</b></td>
            {#if lineVat && !nonSale}
              <td class="num">{#if product}<select class="input vat-line" value={line.vatRate ?? vatRate} onchange={(event) => { const value = event.currentTarget.value; if (isVatRate(value)) line.vatRate = value; }} aria-label={m.bh_thue_suat_dong({ row: index + 1 })}>{#each VAT_RATE_OPTIONS as option}<option value={option.value}>{option.value === 'KCT' ? 'KCT' : option.label}</option>{/each}</select>{/if}</td>
              <td class="num">{computed ? dong(computed.taxAmount) : ''}</td>
            {/if}
            <td><div class="row-actions">
              {#if product && !line.gift && !nonSale}<button class="icon gift" onclick={() => addGiftFor(line)} title={m.tang_kem_1_san_pham_cung()} aria-label={m.tang_kem({ sku: product.sku })}><Gift size={14} /></button>{/if}
              <button class="icon remove" onclick={() => removeLine(index)} aria-label={m.xoa_dong({ p0: index + 1 })}><X size={14} /></button>
            </div></td>
          </tr>
        {/each}
      </tbody>
      {#if hasLines}
        <tfoot><tr><td colspan="8">{m.cong()}</td><td class="num"><b>{dong(summary.netAmountSum)}</b></td>{#if lineVat && !nonSale}<td></td><td class="num"><b>{dong(summary.taxTotal)}</b></td>{/if}<td></td></tr></tfoot>
      {/if}
    </table>
  </div>
  <RowContextMenu bind:open={rowMenu.open} x={rowMenu.x} y={rowMenu.y} label={m.bh_ctx_menu_dong({ row: rowMenu.index + 1 })} items={rowMenuItems} />
  {#if calc.stockWarnings.length}
    <div class="warnings">{#each calc.stockWarnings as warning}<p class={warning.tone}><CircleAlert size={15} />{warning.text}</p>{/each}</div>
  {/if}
</article>

<section class="bottom">
  <article class="card block">
    <header class="block-head"><span class="step">3</span><h2>{m.ghi_chu()}</h2></header>
    <div class="field note">
      <label for="note">{m.bh_ghi_chu_in_phieu()}</label>
      <textarea id="note" rows="4" maxlength="500" bind:value={note} placeholder={m.yeu_cau_dong_goi_gio_lay()}></textarea>
    </div>
  </article>

  {#if nonSale}
    <aside class="card summary loan-summary" aria-live="polite">
      <h2>{m.lp_khong_tinh_tien_ngan()}</h2>
      <dl>
        <div class="main"><dt>{m.lp_loai_phieu()}</dt><dd>{slipTypeLabel(slipType)}</dd></div>
        <div><dt>{m.lp_tong_so_luong()}</dt><dd>{num(calc.lines.reduce((sum, line) => sum + (line ? Number(line.quantity) : 0), 0))}</dd></div>
        <div class="total"><dt>{m.tong_tien_thanh_toan()}</dt><dd>{vnd('0')}</dd></div>
      </dl>
      <p class="words"><span>{gift ? m.lp_khong_tinh_tien_tang() : m.lp_khong_tinh_tien()}</span></p>
    </aside>
  {:else}
  <aside class="card summary" aria-live="polite">
    <h2>{m.tong_tien_phieu()}</h2>
    <dl>
      <div class="minor"><dt>{m.tien_hang_theo_gia_niem_yet()}</dt><dd>{vnd(summary.subtotal)}</dd></div>
      <div class="minor"><dt>{m.chiet_khau_bac_ds_ctkm()}</dt><dd>− {vnd(summary.discountTotal)}</dd></div>
      <div class="main"><dt>{m.cong_tien_hang()}</dt><dd>{vnd(summary.netTotal)}</dd></div>
      {#if !lineVat}
        <!-- PXK-001: một thuế suất cho cả phiếu (như trước 27/10/2026). -->
        <div class="vat">
          <dt><label for="vat-rate">{m.thue_suat_thue_gtgt()}</label></dt>
          <dd>
            <select id="vat-rate" class="input vat-select" title={m.mau_2({ code: template.code, description: templateDescription(template) })} value={vatRate} onchange={(event) => chooseVat(event.currentTarget.value)}>
              {#each VAT_RATE_OPTIONS as option}<option value={option.value}>{option.value === 'KCT' ? m.kct_khong_chiu_thue() : option.label}{option.value === defaultVat ? m.mac_dinh() : ''}</option>{/each}
            </select>
          </dd>
        </div>
      {/if}
      <div><dt>{m.tien_thue_gtgt()}</dt><dd>{!lineVat && vatRate === 'KCT' ? m.khong_chiu_thue_2() : vnd(summary.taxTotal)}</dd></div>
      <div class="total"><dt>{m.tong_tien_thanh_toan()}</dt><dd>{vnd(summary.grandTotal)}</dd></div>
    </dl>
    <p class="words"><span>{m.so_tien_bang_chu()}</span> <b>{vndInWords(summary.grandTotal)}</b></p>
    {#if !lineVat && vatRate !== defaultVat && hasLines}
      <p class="credit info"><Info size={16} /><span>{m.khac_thue_suat_mac_dinh()} {defaultVat === 'KCT' ? 'KCT' : `${defaultVat}%`}. {sheet?.pricesIncludeTax ? m.bang_gia_da_gom_thue_nen() : m.tien_thue_va_tong_thanh_toan()} {m.kiem_tra_ma_hang_co_dung()}</span></p>
    {/if}
    {#if sheet?.customer && dealer && hasLines}
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
  {/if}
</section>

<Dialog bind:open={priceRequestOpen} title={selfGrant ? m.gia_tu_cap_tieu_de() : m.gia_xin_quyen_tieu_de()}>
  <p class="lead">{selfGrant ? m.gia_tu_cap_giai_thich() : m.gia_xin_quyen_giai_thich()}</p>
  <div class="field">
    <label for="price-reason">{m.gia_ly_do()} <span class="req">*</span></label>
    <textarea id="price-reason" rows="3" maxlength="300" bind:value={priceRequestReason} placeholder={m.gia_ly_do_placeholder()}></textarea>
    {#if priceRequestReason.trim() && priceRequestReason.trim().length < 5}<small class="error">{m.bh_ly_do_toi_thieu()}</small>{/if}
  </div>
  {#snippet footer()}
    <button class="btn" onclick={() => (priceRequestOpen = false)}>{m.dong()}</button>
    <button class="btn primary" disabled={priceRequestReason.trim().length < 5 || priceRequesting} onclick={requestPriceOverride}>{selfGrant ? m.gia_tu_cap_nut() : m.gia_gui_yeu_cau()}</button>
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
  .slip-types { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; padding: 16px 22px 0; }
  .slip-label { margin-right: 6px; color: var(--muted); font-size: 12.5px; font-weight: 600; }
  .slip-types button { padding: 7px 12px; border: 1px solid var(--line); border-radius: 999px; background: var(--surface); color: var(--text); font-size: 13px; cursor: pointer; }
  .slip-types button.on { border-color: var(--navy); background: var(--navy); color: #fff; }
  .slip-types button.loan.on { border-color: var(--orange); background: var(--orange); }
  .slip-types button:disabled { opacity: 0.45; cursor: not-allowed; }
  .loan-summary .words span { color: var(--muted); font-size: 12.5px; line-height: 1.5; }
  .grid.second { padding: 14px 22px 22px; }
  .wide { grid-column: span 2; }
  .buyer { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 10px 24px; margin: 14px 22px 4px; padding: 14px 16px; border-radius: 8px; background: var(--surface-2); }
  .buyer dt { color: var(--subtle); font-size: 11.5px; }
  .buyer dd { margin: 2px 0 0; font-size: 13.5px; font-weight: 500; }
  .buyer dd.danger { color: var(--red); }
  .scan { display: flex; align-items: center; gap: 7px; margin-left: auto; width: 290px; padding: 0 10px; border: 1px dashed #b9c7d4; border-radius: 8px; color: var(--muted); }
  .scan input { width: 100%; height: 32px; border: 0; outline: 0; background: transparent; font-size: 13px; }
  /* Bảng 12 cột (thêm % thuế GTGT / Tiền thuế GTGT — 27/10/2026) vừa màn 1366 px. */
  .lines th, .lines td { padding: 8px 5px; }
  .lines th:first-child, .lines td:first-child { padding-left: 16px; }
  .lines th small { display: block; font-size: 10.5px; font-weight: 500; text-transform: none; letter-spacing: 0; }
  .lines .input { min-height: 36px; padding: 6px 8px; }
  .lines tfoot td { padding-top: 12px; padding-bottom: 12px; border-top: 1px solid var(--line); background: var(--surface-2); font-weight: 700; }
  .sku { width: 102px; font-weight: 600; color: var(--navy); text-transform: uppercase; }
  .unit { width: 84px; }
  td :global(.qty) { width: 66px; text-align: center; font-weight: 600; }
  td :global(.qty.invalid) { border-color: var(--red); background: var(--red-soft); }
  .name { min-width: 150px; }
  .pname { width: 100%; min-width: 140px; }
  .price span[title] { cursor: help; }
  .price-btn { display: inline-flex; align-items: center; gap: 4px; padding: 3px 6px; border: 1px dashed transparent; border-radius: 6px; background: transparent; color: inherit; font: inherit; cursor: pointer; }
  .price-btn:hover { border-color: var(--line); background: var(--surface-2); }
  .price-btn :global(svg) { color: var(--subtle); }
  .price-btn.overridden { border-color: var(--orange); background: var(--orange-soft); color: var(--orange); font-weight: 600; }
  .price small.orig { display: flex; align-items: center; justify-content: flex-end; gap: 4px; color: var(--subtle); font-size: 11px; }
  .price small.own-price { display: block; color: var(--green); font-size: 11px; font-weight: 600; }
  .price .reset { display: inline-grid; padding: 0; border: 0; background: transparent; color: var(--navy-2); cursor: pointer; }
  :global(.input.price-input) { width: 130px; text-align: right; }
  .price-grant { margin: 0 18px 12px; }
  .price-grant .link { margin-left: auto; border: 0; background: transparent; color: var(--navy-2); font-weight: 600; cursor: pointer; }
  /* Loại hàng khác (SAL-KIND-01): ô chọn dạng nhãn, tô màu theo loại đang chọn — tặng cam, đổi xanh, bù tím (giống nhãn trên trang phiếu). */
  .kind-select { display: block; min-width: 112px; margin-top: 6px; padding: 3px 28px 3px 11px; border: 1px solid transparent; border-radius: 999px; appearance: none; background: var(--blue-soft) url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='10' height='6' fill='none'%3E%3Cpath d='M1 1l4 4 4-4' stroke='%235A6B7C' stroke-width='1.5' stroke-linecap='round' stroke-linejoin='round'/%3E%3C/svg%3E") no-repeat right 10px center; color: var(--navy-2); font: inherit; font-size: 12px; font-weight: 600; cursor: pointer; }
  .kind-select.orange { background-color: var(--orange-soft); color: var(--orange); }
  .kind-select.violet { background-color: var(--violet-soft); color: var(--violet); }
  .kind-select:hover { border-color: var(--line); }
  .kind-select:focus-visible { outline: 2px solid var(--navy-3); outline-offset: 1px; }
  .kind-select option { background: var(--surface); color: var(--text); }
  .stock { color: var(--green); font-weight: 600; }
  .stock.out { color: var(--red); }
  .ck { display: inline-block; min-width: 40px; padding: 6px 6px; border: 1px solid var(--line); border-radius: 7px; text-align: center; cursor: help; }
  .row-actions { display: flex; justify-content: flex-end; gap: 4px; }
  .icon { display: grid; width: 26px; height: 26px; place-items: center; border-radius: 50%; }
  .icon.gift { background: var(--orange-soft); color: var(--orange); }
  .icon.remove { background: var(--red-soft); color: var(--red); }
  .warnings { display: grid; gap: 6px; padding: 12px 22px 0; }
  .warnings p { display: flex; align-items: center; gap: 8px; width: fit-content; margin: 0; padding: 8px 14px; border-radius: 8px; font-size: 13px; }
  .warnings .warning { background: var(--orange-soft); color: #b4501f; }
  .warnings .error { background: var(--red-soft); color: var(--red); }
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
  /* % thuế GTGT của dòng (27/10/2026). */
  .vat-select { min-height: 36px; width: 210px; padding: 6px 10px; font-weight: 600; color: var(--navy); }
  .template-select { min-height: 24px; padding: 2px 24px 2px 10px; border: 0; appearance: none; background: var(--navy) url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='10' height='6' fill='none'%3E%3Cpath d='M1 1l4 4 4-4' stroke='%23ffffff' stroke-width='1.5' stroke-linecap='round' stroke-linejoin='round'/%3E%3C/svg%3E") no-repeat right 8px center; color: #fff; font: inherit; font-size: 12px; font-weight: 600; cursor: pointer; }
  .template-select option { background: var(--surface); color: var(--text); }
  .vat-line { width: 66px; min-height: 34px; padding: 4px 18px 4px 6px !important; background-position: right 5px center; font-weight: 600; text-align: left; }
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
  .request-reason { align-items: flex-start; }
  .request-reason .field { flex: 1; margin: 0; }
  .request-reason textarea { width: 100%; }
</style>
