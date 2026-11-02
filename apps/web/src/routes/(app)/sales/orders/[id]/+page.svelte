<script lang="ts">
  import { m } from '$lib/paraglide/messages';
  import { intlLocale, templateDescription } from '$lib/i18n';
  import type { SalesOrder, SalesStepOwners, Warehouse } from '@inoxpran/contracts';
  import { vndInWords } from '$lib/vnd-words';
  import { vatLabel } from '$shared/sales-math';
  import { salesIssueTemplate } from '$shared/sales-templates';
  import { canDeliverOrder, canShipOrder } from '$shared/sales-steps';
  import { zeroPriceKindOf } from '$shared/sales-line-kind';
  import { page } from '$app/state';
  import { onMount } from 'svelte';
  import { Ban, Check, CircleAlert, CircleCheck, Hourglass, MessageSquareWarning, Paperclip, Pencil, Printer, Send, ShieldAlert, ShieldCheck, Trash2, Warehouse as WarehouseIcon } from 'lucide-svelte';
  import { goto } from '$app/navigation';
  import ChangeRequestDialog from '$lib/components/ChangeRequestDialog.svelte';
  import ConfirmDialog from '$lib/components/ConfirmDialog.svelte';
  import { deliveryConfirmation } from '$lib/delivery';
  import CustomerConfirmationDialog from '$lib/components/CustomerConfirmationDialog.svelte';
  import Dialog from '$lib/components/Dialog.svelte';
  import WarehouseIssueDialog from '$lib/components/WarehouseIssueDialog.svelte';
  import { api } from '$lib/api';
  import { date, dateTime, num, vnd } from '$lib/format';
  import { approvalReason, hasRole, orderStage, tierLabel, zeroPriceRowClass } from '$lib/labels';
  import LineKindPill from '$lib/components/LineKindPill.svelte';
  import { can, session, stepActor } from '$lib/session.svelte';
  import { changeKindLabel, type ChangeKind, type ChangeRequest } from '$lib/change-requests';
  import LoanPanel, { type LoanLine, type LoanReturnRow } from '$lib/components/LoanPanel.svelte';
  import { isLoanPurpose, isNonSalePurpose, loanAge, partyName, slipTypeOf, slipTypeShort } from '$lib/slip-type';

  type Line = SalesOrder['lines'][number] & {
    netAmount?: string; salesTierDiscountRate?: string; promotionDiscountRate?: string; promotionCode?: string; gift?: boolean;
  };
  type Order = Omit<SalesOrder, 'lines'> & {
    lines: Line[]; province?: string; customerTier?: string; templateCode?: string;
    requestedByName?: string; issuedAt?: string; issuedByName?: string; approvedAt?: string; approvedByName?: string;
    confirmedAt?: string; confirmedByName?: string; revisionRequestedAt?: string; revisionRequestedByName?: string;
    shippedAt?: string; shippedByName?: string; receiverName?: string; carrier?: string; warehouseNote?: string; deliveredAt?: string; deliveredByName?: string;
    warehouseKeeperId?: string; warehouseKeeperName?: string;
    loanLines?: LoanLine[]; loanReturns?: LoanReturnRow[];
    confirmationEvidence?: Array<{ id: string; fileName: string; contentType: string; size: number; sha256: string; uploadedAt: string; uploadedByName: string; decision?: string; scan?: { result: string; engine: string; scannedAt: string } }>;
  };
  /** `owner`: người được phân công bước chưa làm (SAL-STEP-01); `warn`: bước chưa có ai được phân công. */
  type Step = { label: string; who?: string | undefined; at?: string | undefined; done: boolean; current?: boolean; cancelled?: boolean; owner?: string | undefined; warn?: boolean };

  let order = $state<Order | null>(null);
  let warehouses = $state<Warehouse[]>([]);
  let reasons = $state<string[]>([]);
  let loading = $state(true);
  let working = $state(false);
  let error = $state('');
  let success = $state('');
  let repricedNote = $state('');
  let revisionOpen = $state(false);
  let revisionNote = $state('');
  let issueTarget = $state<Order | null>(null);
  let confirmTarget = $state<Order | null>(null);
  /** Bỏ phiếu: nháp → xóa hẳn; đã phát hành chưa xuất kho → hủy (giữ số). Chỉ kế toán / Admin, bắt buộc lý do. */
  let discardOpen = $state(false);
  let discardReason = $state('');

  const roles = $derived(session.user?.roles ?? []);
  const stage = $derived(order ? orderStage(order) : null);
  // 5 bước phiếu BH theo người được Admin phân công (SAL-STEP-01): lập / phát hành / đối chiếu / xuất kho (thủ kho của phiếu) / xác nhận giao.
  const canCreate = $derived(can('sales.step.create'));
  const canIssue = $derived(can('sales.step.issue'));
  const canConfirm = $derived(can('sales.step.confirm'));
  const canShipThis = $derived(Boolean(order && canShipOrder(stepActor(), order.warehouseKeeperId)));
  const canDeliverThis = $derived(Boolean(order && canDeliverOrder(stepActor(), order.warehouseKeeperId)));
  let owners = $state<SalesStepOwners | null>(null);
  /** "Chờ: <người được phân công>" cho bước chưa làm; không có ai thì cảnh báo. */
  const ownerOf = (key: 'ISSUE' | 'CONFIRM' | 'SHIP' | 'DELIVER'): { owner?: string; warn?: boolean } => {
    const item = owners?.steps?.[key];
    if (!item) return {};
    if (!item.names.length) return { owner: m.sst_chua_ai(), warn: true };
    return { owner: m.sst_cho({ names: `${item.names.join(', ')}${item.more ? ` +${item.more}` : ''}` }) };
  };
  const evidence = $derived(order?.confirmationEvidence ?? []);
  /** Phiếu xuất hàng mẫu / kiểm định (SAL-TYPE-01): không khách, không tiền; hàng mang về nhập lại theo phiếu. */
  const nonSale = $derived(isNonSalePurpose(order?.purpose));
  const gift = $derived(order?.purpose === 'GIFT');
  const age = $derived(order && nonSale ? loanAge(order) : { days: 0, overdue: 0 });
  // Quyền nghiệp vụ (PERM-01): làm trực tiếp, hoặc gửi đề nghị để Admin duyệt (SAL-CHG-01).
  const canDiscard = $derived(can('sales.discard'));
  const canEditIssued = $derived(can('sales.edit_issued'));
  const canVoid = $derived(can('sales.void_shipped'));
  const canRequestChange = $derived(can('sales.change_request'));
  const canApproveChange = $derived(can('sales.change_approve'));
  const canDelete = $derived(Boolean(order && order.status === 'DRAFT' && canDiscard));
  const issuedStage = $derived(Boolean(order && order.status !== 'DRAFT' && order.status !== 'CANCELLED'));
  let pendingChange = $state<ChangeRequest | null>(null);
  let changeOpen = $state(false);
  let changeKind = $state<ChangeKind>('CANCEL');
  let changeReason = $state('');
  let decideOpen = $state(false);
  let decideAction = $state<'view' | 'approve' | 'reject'>('view');
  function openChange(kind: ChangeKind) {
    changeKind = kind;
    changeReason = '';
    changeOpen = true;
  }
  async function sendChange() {
    if (!order || changeReason.trim().length < 5) return;
    working = true;
    error = '';
    success = '';
    try {
      const created = await api<ChangeRequest>(`/sales-orders/${order.id}/change-requests`, { method: 'POST', idempotentCommand: true, body: JSON.stringify({ kind: changeKind, version: order.version, reason: changeReason.trim() }) });
      changeOpen = false;
      success = m.yc_da_gui({ code: created.code });
      await load();
    } catch (caught) {
      error = caught instanceof Error ? caught.message : m.khong_the_hoan_tat_thao_tac();
      changeOpen = false;
    } finally {
      working = false;
    }
  }
  async function withdrawChange() {
    if (!pendingChange) return;
    working = true;
    error = '';
    try {
      await api(`/sales-change-requests/${pendingChange.id}/withdraw`, { method: 'POST', idempotentCommand: true });
      success = m.yc_da_rut({ code: pendingChange.code });
      await load();
    } catch (caught) {
      error = caught instanceof Error ? caught.message : m.khong_the_hoan_tat_thao_tac();
    } finally {
      working = false;
    }
  }
  async function changeDecided(result: ChangeRequest) {
    if (result.status === 'FAILED') error = m.yc_khong_thuc_hien({ code: result.code, error: result.error ?? '' });
    else success = result.status === 'APPLIED' ? m.yc_da_duyet({ code: result.code }) : m.yc_da_tu_choi({ code: result.code });
    if (result.status === 'APPLIED' && result.kind === 'DELETE') {
      await goto(`/sales/orders?deleted=${encodeURIComponent(result.orderCode)}`);
      return;
    }
    if (result.status === 'APPLIED' && (result.kind === 'VOID' || result.kind === 'CANCEL') && (await leftCancelled(result.orderCode))) return;
    await load();
  }
  /** Phiếu vừa hủy chỉ quản trị gốc còn mở được (DOC-HIDE-01): người khác về danh sách kèm thông báo. */
  async function leftCancelled(code: string) {
    if (session.user?.root) return false;
    await goto(`/sales/orders?cancelled=${encodeURIComponent(code)}`);
    return true;
  }
  const shippedStage = $derived(Boolean(order && ['SHIPPED', 'PARTIALLY_SHIPPED', 'DELIVERED'].includes(order.status)));
  /** Phiếu có thuế dòng (27/10/2026) → hiện cột % thuế GTGT / Tiền thuế GTGT; phiếu cũ thuế tính một lần cho cả phiếu. */
  const lineTax = $derived(Boolean(order?.lines.some((line) => line.taxAmount !== undefined && line.taxAmount !== null)));
  // Đơn thanh toán ngay (AR-PAYNOW-01): kế toán bỏ phiếu thu tự động khi khách thực tế chưa trả.
  const canUndoPayNow = $derived(Boolean(order?.payNowReceipt) && hasRole(roles, ['ACCOUNTANT']));
  let payNowOpen = $state(false);
  let payNowReason = $state('');
  async function undoPayNow() {
    if (!order?.payNowReceipt || payNowReason.trim().length < 5) return;
    payNowOpen = false;
    const receipt = order.payNowReceipt.code;
    await command('pay-now/undo', { reason: payNowReason.trim() }, m.pn_da_bo_ghi_thu({ codes: receipt, code: order.code }));
    payNowReason = '';
  }
  let voidOpen = $state(false);
  let voidReason = $state('');
  async function voidOrder() {
    if (!order || voidReason.trim().length < 5) return;
    voidOpen = false;
    await command('void', { reason: voidReason.trim() }, m.root_da_huy_phieu_da_giao(), true);
    voidReason = '';
  }
  const cancellable = $derived(Boolean(order && ['PENDING_APPROVAL', 'APPROVED', 'RESERVED'].includes(order.status) && !order.warehouseSlipNo));
  const canCancel = $derived(cancellable && canDiscard);
  const netTotal = $derived(order ? order.netTotal ?? String(Number(order.subtotal) - Number(order.discountTotal)) : '0');
  const steps = $derived.by((): Step[] => {
    if (!order) return [];
    const cancelled = order.status === 'CANCELLED';
    // Phiếu đã hủy: hiện các bước đã đi qua (theo trạng thái trước khi hủy) rồi bước "Đã hủy".
    const status = cancelled ? order.statusBeforeCancel ?? 'RESERVED' : order.status;
    const { confirmationStatus } = order;
    const rank = ['DRAFT', 'PENDING_APPROVAL', 'RESERVED', 'SHIPPED', 'DELIVERED'].indexOf(status);
    const list: Step[] = [
      { label: order.requestedByName ? m.kd_de_nghi_xuat() : m.lap_phieu(), who: order.requestedByName, at: order.createdAt, done: true },
      { label: m.kt_phat_hanh_phieu_bh(), who: order.issuedByName, at: order.issuedAt, done: rank >= 1, current: status === 'DRAFT', ...(rank < 1 ? ownerOf('ISSUE') : {}) },
    ];
    if (order.approvalStatus !== 'NOT_REQUIRED') {
      list.push({ label: m.duyet_ngoai_le(), who: order.approvedByName, at: order.approvedAt, done: rank >= 2, current: status === 'PENDING_APPROVAL' });
    }
    const keeperOwner = rank < 3 ? ownerOf('SHIP') : {};
    const keeperStep = {
      label: m.kho_lap_swk_xuat(),
      who: order.warehouseSlipNo ? `${order.warehouseSlipNo} · ${order.shippedByName ?? ''}` : order.warehouseKeeperName && !keeperOwner.warn ? m.thu_kho_3({ warehouseKeeperName: order.warehouseKeeperName }) : keeperOwner.owner,
      at: order.shippedAt, done: rank >= 3, current: status === 'RESERVED' && confirmationStatus !== 'PENDING',
      ...(keeperOwner.warn ? { owner: order.warehouseKeeperName ? m.sst_thu_kho_mat_quyen({ name: order.warehouseKeeperName }) : keeperOwner.owner, warn: true } : order.warehouseKeeperName || rank >= 3 ? {} : keeperOwner),
    };
    if (order.purpose === 'GIFT') {
      // Xuất tặng: không đối chiếu khách, không thu hồi — xong khi kho xuất.
      list.push(keeperStep);
    } else if (isNonSalePurpose(order.purpose)) {
      // Hàng mẫu / kiểm định: không qua bước KD đối chiếu khách; bước cuối là hàng mang về / chốt.
      const loanDone = order.loanStatus === 'RETURNED' || order.loanStatus === 'CLOSED';
      list.push(keeperStep, {
        label: order.loanStatus === 'CLOSED' ? m.lp_da_chot() : order.loanStatus === 'RETURNED' ? m.lp_da_ve_du() : order.loanStatus === 'PARTIAL' ? m.lp_ve_mot_phan() : m.lp_mang_ve(),
        who: order.salesRepName, at: order.loanClosedAt, done: loanDone, current: !loanDone && rank >= 3,
      });
    } else {
      list.push(
        { label: m.kd_doi_chieu_voi_khach(), who: order.confirmedByName ? `${order.confirmedByName}${evidence.length ? m.anh_3({ length: evidence.filter((item) => item.decision !== 'REVISION_REQUESTED').length }) : ''}` : undefined, at: order.confirmedAt, done: rank >= 3 || confirmationStatus === 'CONFIRMED', current: status === 'RESERVED' && confirmationStatus === 'PENDING', ...(rank >= 3 || confirmationStatus === 'CONFIRMED' ? {} : ownerOf('CONFIRM')) },
        keeperStep,
        // Bước 5: người xác nhận giao (phiếu cũ trước 26/10/2026 không lưu → hiện thủ kho); chưa giao → người được phân công.
        { label: m.giao_hang_thanh_cong(), who: order.deliveredByName ?? (order.warehouseKeeperName ? m.thu_kho_3({ warehouseKeeperName: order.warehouseKeeperName }) : undefined), at: order.deliveredAt, done: rank >= 4, current: status === 'SHIPPED', ...(rank < 4 ? ownerOf('DELIVER') : {}) },
      );
    }
    if (cancelled) {
      return [
        ...list.filter((step) => step.done).map((step) => ({ ...step, current: false })),
        { label: m.da_huy(), who: order.cancelledByName, at: order.cancelledAt, done: true, cancelled: true },
      ];
    }
    return list;
  });

  async function load() {
    loading = true;
    error = '';
    try {
      order = await api<Order>(`/sales-orders/${page.params.id}`);
      owners = await api<SalesStepOwners>(`/sales-orders/${page.params.id}/step-owners`).catch(() => null);
      pendingChange = canRequestChange || canApproveChange
        ? (await api<ChangeRequest[]>(`/sales-change-requests?orderId=${page.params.id}&status=PENDING`).catch(() => []))[0] ?? null
        : null;
      if (order.status === 'PENDING_APPROVAL') {
        const pending = await api<Array<{ entityId: string; reasons: string[] }>>('/approval-requests?status=PENDING').catch(() => []);
        reasons = pending.find((item) => item.entityId === order?.id)?.reasons ?? [];
      }
    } catch (caught) {
      error = caught instanceof Error ? caught.message : m.khong_tai_duoc_phieu();
    } finally {
      loading = false;
    }
  }

  onMount(async () => {
    const created = page.url.searchParams.get('created');
    if (created === 'draft') success = m.da_luu_nhap_phieu_kiem_tra();
    if (created === 'requested') success = m.da_gui_de_nghi_ke_toan();
    if (created === 'issued') success = m.da_phat_hanh_phieu_bh_va();
    if (created === 'root-edited') success = m.root_da_luu_thay_doi();
    if (created === 'change-requested') success = m.yc_da_gui_chung();
    const repriced = page.url.searchParams.get('repriced');
    if (repriced) repricedNote = m.bang_gia_hoac_khuyen_mai_vua({ p0: vnd(repriced) });
    warehouses = await api<Warehouse[]>('/warehouses').catch(() => []);
    await load();
  });

  async function command(path: string, body: Record<string, unknown>, message: string, cancels = false) {
    if (!order) return;
    working = true;
    error = '';
    success = '';
    try {
      await api(`/sales-orders/${order.id}/${path}`, { method: 'POST', body: JSON.stringify({ version: order.version, ...body }), idempotentCommand: true });
      if (cancels && (await leftCancelled(order.code))) return;
      success = message;
      await load();
    } catch (caught) {
      error = caught instanceof Error ? caught.message : m.khong_the_hoan_tat_thao_tac();
    } finally {
      working = false;
    }
  }

  const issue = () => command('submit', {}, m.da_phat_hanh_phieu_bh_phieu());
  const approve = () => command('approve', {}, m.da_duyet_phieu_va_giu_ton());
  const deliver = () => command('deliver', {}, m.da_xac_nhan_giao_hang_thanh());
  /** Hỏi lại trước khi xác nhận giao: lúc này mới ghi doanh thu và công nợ (AR-DLV-01). */
  let deliverAsk = $state(false);
  const deliverText = $derived(order ? deliveryConfirmation(order) : null);
  async function requestRevision() {
    if (!revisionNote.trim()) return;
    revisionOpen = false;
    await command('customer-confirmation', { decision: 'REVISION_REQUESTED', note: revisionNote.trim() }, m.da_tra_phieu_ve_ke_toan());
    revisionNote = '';
  }
  async function discard() {
    if (!order || discardReason.trim().length < 5) return;
    working = true;
    error = '';
    success = '';
    try {
      if (order.status === 'DRAFT') {
        await api(`/sales-orders/${order.id}`, { method: 'DELETE', idempotentCommand: true, body: JSON.stringify({ version: order.version, reason: discardReason.trim() }) });
        discardOpen = false;
        await goto(`/sales/orders?deleted=${encodeURIComponent(order.code)}`);
        return;
      }
      await api(`/sales-orders/${order.id}/cancel`, { method: 'POST', idempotentCommand: true, body: JSON.stringify({ version: order.version, reason: discardReason.trim() }) });
      discardOpen = false;
      discardReason = '';
      if (await leftCancelled(order.code)) return;
      success = m.bh_da_huy_phieu();
      await load();
    } catch (caught) {
      error = caught instanceof Error ? caught.message : m.khong_the_hoan_tat_thao_tac();
      discardOpen = false;
    } finally {
      working = false;
    }
  }
  function printSlip(type: 'BH' | 'SWK') {
    if (order) window.open(`/print/sales-issue/${order.id}?type=${type}`, '_blank', 'noopener');
  }
</script>

<svelte:head><title>{order?.code ?? m.phieu_xuat_kho()} | INOXPRAN ERP</title></svelte:head>

<section class="page-head">
  <div>
    <nav class="crumbs" aria-label={m.duong_dan()}><a href="/sales/orders">{m.don_hang()}</a><span><a href="/sales/orders">{m.phieu_xuat_kho_ban_hang()}</a></span><span>{order?.code ?? '…'}</span></nav>
    <h1 class="page-title">{order ? `${order.code} — ${partyName(order)}` : m.phieu_xuat_kho_ban_hang()}</h1>
    {#if order && stage}
      <p class="page-sub">
        <span class="pill template" title={templateDescription(salesIssueTemplate(order.templateCode))}>{m.mau()} {salesIssueTemplate(order.templateCode).code}</span>
        {#if order.codeMode === 'MANUAL'}<span class="pill neutral" title={m.bh_so_tu_nhap_goi_y()}>{m.bh_so_tu_nhap()}</span>{/if}
        <span class="pill type" class:loan={nonSale}>{slipTypeShort(slipTypeOf(order))}</span>
        <span class={`pill ${stage.tone}`}>{stage.label}</span>
        {#if order.warehouseSlipNo}<span class="slip">SWK: <b>{order.warehouseSlipNo}</b></span>{/if}
        {m.ngay_chung_tu_2()} {date(order.orderDate ?? order.createdAt)} {m.phien_ban()} {order.version}
      </p>
    {/if}
  </div>
  {#if order}
    <div class="actions">
      {#if order.status !== 'DRAFT' && order.status !== 'CANCELLED'}<button class="btn" onclick={() => printSlip('BH')}><Printer size={16} />{m.in_phieu_bh()}</button>{/if}
      {#if order.warehouseSlipNo && order.status !== 'CANCELLED'}<button class="btn" onclick={() => printSlip('SWK')}><Printer size={16} />{m.in_phieu_swk()}</button>{/if}
      {#if order.status === 'DRAFT' && (canCreate || canIssue)}<a class="btn soft" href={`/sales/orders/${order.id}/edit`}><Pencil size={15} />{m.sua_phieu()}</a>{/if}
      {#if order.status === 'DRAFT' && canIssue}<button class="btn primary" disabled={working} onclick={issue}>{m.phat_hanh_phieu_bh()}</button>{/if}
      {#if order.status === 'PENDING_APPROVAL' && hasRole(roles, ['SALES_MANAGER', 'DIRECTOR'])}<button class="btn primary" disabled={working} onclick={approve}>{m.duyet_giu_hang()}</button>{/if}
      {#if order.status === 'RESERVED' && order.confirmationStatus === 'PENDING' && canConfirm}
        <button class="btn danger-soft" disabled={working} onclick={() => (revisionOpen = true)}><MessageSquareWarning size={16} />{m.yeu_cau_sua()}</button>
        <button class="btn primary" disabled={working} onclick={() => (confirmTarget = order)}><Paperclip size={16} />{m.xac_nhan_doi_chieu_kem_anh()}</button>
      {/if}
      {#if order.status === 'RESERVED' && order.confirmationStatus !== 'PENDING' && canShipThis}<button class="btn primary" disabled={working} onclick={() => (issueTarget = order)}>{m.lap_phieu_swk_xuat_kho()}</button>{/if}
      {#if order.status === 'SHIPPED' && canDeliverThis && !nonSale}<button class="btn navy" disabled={working} onclick={() => (deliverAsk = true)}>{m.xac_nhan_da_giao()}</button>{/if}
      {#if canDelete}<button class="btn danger-soft" disabled={working} onclick={() => { discardReason = ''; discardOpen = true; }}><Trash2 size={15} />{m.bh_xoa_phieu()}</button>{/if}
      {#if canCancel}<button class="btn danger-soft" disabled={working} onclick={() => { discardReason = ''; discardOpen = true; }}><Ban size={15} />{m.bh_huy_phieu()}</button>{/if}
      {#if canEditIssued && issuedStage}<a class="btn soft root" href={`/sales/orders/${order.id}/edit`}><Pencil size={15} />{m.root_sua_phieu()}</a>{/if}
      {#if canVoid && shippedStage}<button class="btn danger-soft" disabled={working} onclick={() => { voidReason = ''; voidOpen = true; }}><Ban size={15} />{m.root_huy_phieu_da_giao()}</button>{/if}
      {#if canRequestChange && !pendingChange}
        {#if !canEditIssued && issuedStage}<a class="btn soft" href={`/sales/orders/${order.id}/edit?request=1`}><Send size={15} />{m.yc_de_nghi_sua()}</a>{/if}
        {#if !canVoid && shippedStage}<button class="btn danger-soft" disabled={working} onclick={() => openChange('VOID')}><Send size={15} />{m.yc_de_nghi_huy()}</button>{/if}
        {#if !canDiscard && cancellable}<button class="btn danger-soft" disabled={working} onclick={() => openChange('CANCEL')}><Send size={15} />{m.yc_de_nghi_huy()}</button>{/if}
        {#if !canDiscard && order.status === 'DRAFT'}<button class="btn danger-soft" disabled={working} onclick={() => openChange('DELETE')}><Send size={15} />{m.yc_de_nghi_xoa()}</button>{/if}
      {/if}
    </div>
  {/if}
</section>

{#if error}<div class="banner error"><CircleAlert size={17} />{error}</div>{/if}
{#if success}<div class="banner success"><CircleCheck size={17} />{success}</div>{/if}
{#if repricedNote}<div class="banner warning"><CircleAlert size={17} /><span>{repricedNote}</span></div>{/if}
{#if pendingChange}
  <div class="banner warning change-banner">
    <Hourglass size={17} />
    <span>{m.yc_dang_cho({ code: pendingChange.code, kind: changeKindLabel(pendingChange.kind), who: pendingChange.requestedByName, at: dateTime(pendingChange.requestedAt) })} <b>{m.bh_ly_do()}:</b> {pendingChange.reason}</span>
    <span class="change-actions">
      {#if pendingChange.kind === 'EDIT'}<button class="btn small" onclick={() => { decideAction = 'view'; decideOpen = true; }}>{m.yc_xem_thay_doi()}</button>{/if}
      {#if pendingChange.requestedById === session.user?.sub}<button class="btn small" disabled={working} onclick={withdrawChange}>{m.yc_rut()}</button>{/if}
      {#if canApproveChange}
        <button class="btn small danger-soft" disabled={working} onclick={() => { decideAction = 'reject'; decideOpen = true; }}>{m.yc_tu_choi()}</button>
        <button class="btn small primary" disabled={working} onclick={() => { decideAction = 'approve'; decideOpen = true; }}>{m.yc_duyet()}</button>
      {/if}
    </span>
  </div>
{/if}

{#if loading && !order}
  <div class="card skeleton" style="height:240px"></div>
{:else if order}
  <ol class="card timeline" style={`--steps:${steps.length}`} aria-label={m.tien_trinh_phieu_xuat_kho()}>
    {#each steps as step}
      <li class:done={step.done} class:current={step.current} class:cancelled={step.cancelled}>
        <span>{#if step.done}<Check size={14} strokeWidth={3} />{/if}</span>
        <b>{step.label}</b>
        <small>{step.done && step.at ? dateTime(step.at) : step.current ? m.dang_cho() : '—'}</small>
        {#if step.who && (step.done || step.current) && !step.owner}<small class="who">{step.who}</small>
        {:else if step.owner && !step.done}<small class="who owner" class:warn={step.warn}>{step.owner}</small>{/if}
      </li>
    {/each}
  </ol>
  {#if steps.some((step) => step.warn && !step.done) && roles.includes('ADMIN')}
    <div class="banner warning"><CircleAlert size={17} /><span>{m.sst_phieu_thieu_nguoi()} <a href="/admin/users?tab=steps">{m.sst_tab()}</a></span></div>
  {/if}

  {#if order.priceOverrideApprovedByName && order.lines.some((line) => line.pricingSource === 'MANUAL_PRICE')}
    <div class="banner info"><Pencil size={17} /><span>{m.gia_phieu_co_sua_gia({ by: order.priceOverrideApprovedByName, reason: order.priceOverrideReason ?? '—' })}</span></div>
  {/if}
  {#if order.rootEditedAt && order.status !== 'CANCELLED'}
    <div class="banner info"><Pencil size={17} /><span>{m.root_da_sua_luc({ at: dateTime(order.rootEditedAt), by: order.rootEditedByName ?? '—' })}</span></div>
  {/if}
  {#if order.status === 'CANCELLED'}
    <div class="banner error"><Ban size={17} /><span>{m.bh_phieu_da_huy({ at: order.cancelledAt ? dateTime(order.cancelledAt) : '—', by: order.cancelledByName ?? '—' })} <b>{m.bh_ly_do()}:</b> {order.cancelReason ?? '—'}</span></div>
  {/if}
  {#if order.confirmationStatus === 'REVISION_REQUESTED' && order.confirmationNote && order.status !== 'CANCELLED'}
    <div class="banner warning"><MessageSquareWarning size={17} /><span><b>{order.revisionRequestedByName ?? 'Kinh doanh'} {m.yeu_cau_sua_2()}{order.revisionRequestedAt ? ` (${dateTime(order.revisionRequestedAt)})` : ''}:</b> {order.confirmationNote}</span></div>
  {/if}
  {#if order.status === 'RESERVED' && order.confirmationStatus === 'PENDING'}
    <div class="banner info"><CircleAlert size={17} /><span>{m.hang_da_duoc_giu_in_phieu()} <b>{m.ma_hang_va_so_luong()}</b> {m.voi_khach_roi_bam()} <b>{m.xac_nhan_doi_chieu()}</b> {m.va_dinh_kem()} <b>{m.anh_chup_man_hinh_xac_nhan()}</b> {m.vd_tin_nhan_zalo_sau_buoc()}{order.warehouseKeeperName ? ` ${order.warehouseKeeperName}` : ''}.</span></div>
  {/if}
  {#if order.status === 'RESERVED' && order.confirmationStatus === 'CONFIRMED' && !canShipThis && (canCreate || canIssue || canConfirm)}
    <div class="banner info"><WarehouseIcon size={17} /><span>{m.da_doi_chieu_xong_phan_viec()} <b>{order.warehouseKeeperName ?? '—'}</b>.</span></div>
  {/if}
  {#if reasons.length}
    <div class="banner warning"><CircleAlert size={17} /><span>{m.ly_do_can_duyet_2()} {reasons.map((reason) => approvalReason[reason] ?? reason).join(' · ')}</span></div>
  {/if}

  <section class="layout">
    <div>
      <article class="card info">
        <dl>
          {#if nonSale}
          <div class="wide2"><dt>{gift ? m.lp_nguoi_phu_trach() : m.lp_nguoi_muon()}</dt><dd>{order.salesRepName ?? '—'}</dd></div>
          <div class="wide2"><dt>{gift ? m.lp_tang_cho() : m.lp_gui_toi()}</dt><dd>{order.destination ?? '—'}</dd></div>
          {#if !gift}<div class="wide2"><dt>{m.lp_hen_tra()}</dt><dd>{order.expectedReturnDate ? date(order.expectedReturnDate) : '—'}{#if order.shippedAt && (order.loanStatus === 'OUT' || order.loanStatus === 'PARTIAL')} · <span class:overdue={age.overdue > 0}>{age.overdue > 0 ? m.lp_qua_hen({ days: age.overdue }) : m.lp_da_muon_ngay({ days: age.days })}</span>{/if}</dd></div>{/if}
          <div class="wide2"><dt>{m.dien_giai()}</dt><dd>{order.description ?? '—'}</dd></div>
          <div><dt>{m.kho_xuat()}</dt><dd>{warehouses.find((item) => item.id === order?.warehouseId)?.name ?? '—'}</dd></div>
          <div><dt>{m.lp_loai_phieu()}</dt><dd>{slipTypeShort(slipTypeOf(order))} · {m.lp_khong_tinh_tien_ngan()}</dd></div>
          {:else}
          <div class="wide2"><dt>{m.nguoi_mua()}</dt><dd>{order.buyer?.name ?? order.customerName}</dd></div>
          <div><dt>{m.ma_khach_hang()}</dt><dd class="code">{order.customerCode}</dd></div>
          <div><dt>{m.cap_khach_hang()}</dt><dd>{tierLabel[order.customerTier ?? ''] ?? '—'}</dd></div>
          <div class="wide2"><dt>{m.dia_chi()}</dt><dd>{order.buyer?.address ?? order.province ?? '—'}</dd></div>
          <div><dt>{m.dien_thoai()}</dt><dd>{order.buyer?.phone ?? '—'}</dd></div>
          <div><dt>{m.ma_so_thue()}</dt><dd>{order.buyer?.taxCode ?? '—'}</dd></div>
          <div class="wide2"><dt>{m.dien_giai()}</dt><dd>{order.description ?? '—'}</dd></div>
          <div><dt>{m.ten_khach_hang_lien_he()}</dt><dd>{order.contactName ?? '—'}</dd></div>
          <div><dt>{m.nhan_vien_ban_hang()}</dt><dd>{order.salesRepName ?? '—'}</dd></div>
          <div class="wide2"><dt>{m.dia_diem_giao_hang()}</dt><dd>{order.deliveryLocation ?? m.khach_lay_tai_kho()}</dd></div>
          <div><dt>{m.kho_xuat()}</dt><dd>{warehouses.find((item) => item.id === order?.warehouseId)?.name ?? '—'}</dd></div>
          <div><dt>{m.dieu_khoan()}</dt><dd>{order.paymentTermDays ? m.cong_no_ngay_2({ paymentTermDays: order.paymentTermDays }) : `${m.thanh_toan_ngay()}${order.payNowMethod ? ` (${order.payNowMethod === 'CASH' ? m.pn_tien_mat() : m.pn_chuyen_khoan()})` : ''}`} · <span class="tag" class:b2c={order.channel === 'B2C'}>{order.channel ?? 'B2B'}</span></dd></div>
          {#if order.payNowReceipt}
            <div class="wide pay-now"><dt>{m.pn_hinh_thuc_thu()}</dt><dd><CircleCheck size={15} />{m.pn_da_tu_ghi_thu({ amount: vnd(order.payNowReceipt.amount), code: order.payNowReceipt.code, method: order.payNowReceipt.method === 'CASH' ? m.pn_tien_mat() : m.pn_chuyen_khoan(), date: date(order.payNowReceipt.receivedAt) })}{#if canUndoPayNow}<button class="btn small" disabled={working} onclick={() => { payNowReason = ''; payNowOpen = true; }}>{m.pn_bo_ghi_thu()}</button>{/if}</dd></div>
          {:else if order.payNowUndone}
            <div class="wide pay-now undone"><dt>{m.pn_hinh_thuc_thu()}</dt><dd>{m.pn_da_bo_truoc_do({ name: order.payNowUndone.byName, date: date(order.payNowUndone.at), reason: order.payNowUndone.reason })}</dd></div>
          {/if}
          {/if}
          <div class="wide2"><dt>{m.thu_kho_xuat_hang()}</dt><dd>{order.warehouseKeeperName ?? (order.status === 'DRAFT' ? m.ke_toan_chon_khi_phat_hanh() : '—')}</dd></div>
          {#if order.warehouseSlipNo}
            <div><dt>{m.so_phieu_swk()}</dt><dd class="code">{order.warehouseSlipNo}</dd></div>
            <div><dt>{m.nguoi_lap_swk()}</dt><dd>{order.shippedByName ?? '—'}</dd></div>
            <div class="wide2"><dt>{m.nguoi_nhan_hang()}</dt><dd>{order.receiverName ?? '—'}</dd></div>
            <div class="wide2"><dt>{m.van_chuyen()}</dt><dd>{order.carrier ?? '—'}</dd></div>
          {/if}
          {#if order.note || order.warehouseNote}
            <div class="wide"><dt>{m.ghi_chu()}</dt><dd class="order-note">{[order.note, order.warehouseNote ? `Kho: ${order.warehouseNote}` : ''].filter(Boolean).join(' · ')}</dd></div>
          {/if}
        </dl>
      </article>

      {#if isLoanPurpose(order.purpose) && order.loanStatus}
        <LoanPanel order={order} canReturn={hasRole(roles, ['WAREHOUSE', 'WAREHOUSE_MANAGER'])} canClose={hasRole(roles, ['ACCOUNTANT', 'WAREHOUSE_MANAGER'])} onchanged={(message) => { success = message; error = ''; load(); }} />
      {/if}

      {#if evidence.length || order.confirmationStatus === 'CONFIRMED'}
        <article class="card evidence">
          <header class="card-head lines-head"><h2><Paperclip size={16} /> {m.bang_chung_doi_chieu_voi_khach()}</h2><span class="muted">{evidence.length} {m.anh_da_quet_ma_doc_luu()}</span></header>
          {#if evidence.length}
            <ul class="evidence-grid">
              {#each evidence as item}
                <li>
                  <a href={`/api/v1/sales-orders/${order.id}/attachments/${item.id}`} target="_blank" rel="noopener" title={m.mo_anh_goc()}>
                    <img src={`/api/v1/sales-orders/${order.id}/attachments/${item.id}`} alt={item.fileName} loading="lazy" />
                  </a>
                  <div>
                    <b title={item.fileName}>{item.fileName}</b>
                    <small>{item.uploadedByName} · {dateTime(item.uploadedAt)}</small>
                    <small title={item.sha256}>SHA-256 {item.sha256.slice(0, 12)}… · {Math.max(1, Math.round(item.size / 1024))} KB</small>
                    {#if item.scan?.result === 'CLEAN'}<small class="scan clean" title={m.quet_luc({ engine: item.scan.engine, p1: dateTime(item.scan.scannedAt) })}><ShieldCheck size={12} /> {m.da_quet_ma_doc_sach()}</small>
                    {:else if item.scan}<small class="scan skipped"><ShieldAlert size={12} /> {m.chua_quet_ma_doc_may_dev()}</small>{/if}
                    {#if item.decision === 'REVISION_REQUESTED'}<span class="pill danger">{m.kem_yeu_cau_sua()}</span>{:else}<span class="pill success">{m.xac_nhan_doi_chieu()}</span>{/if}
                  </div>
                </li>
              {/each}
            </ul>
          {:else}
            <p class="no-evidence">{m.phieu_du_lieu_mau_duoc_xac()}</p>
          {/if}
        </article>
      {/if}

      <article class="card">
        <header class="card-head lines-head"><h2>{m.hang_hoa()}</h2><span class="muted">{order.lines.length} {m.dong_3()} {order.lines.filter((line) => line.gift).length} {m.bh_dong_hang_khac()}</span></header>
        <div class="table-wrap">
          <table class="table">
            <thead><tr><th>{m.stt()}</th><th>{m.ma_hang()}</th><th>{m.ten_hang()}</th><th>{m.don_vi()}</th><th class="num">{m.so_luong()}</th><th class="num">{m.don_gia()}</th><th class="num">CK (%)</th><th class="num">{m.thanh_tien()}</th>{#if lineTax}<th class="num">{m.bh_phan_tram_thue()}</th><th class="num">{m.bh_tien_thue_dong()}</th>{/if}</tr></thead>
            <tbody>
              {#each order.lines as line, index}
                <tr class={line.gift ? zeroPriceRowClass(zeroPriceKindOf(line) ?? 'GIFT') : ''}>
                  <td class="muted">{index + 1}</td>
                  <td class="code">{line.sku}</td>
                  <td>{line.productName}{#if line.gift}<LineKindPill kind={zeroPriceKindOf(line) ?? 'GIFT'} />{/if}{#if line.promotionCode}<small>{m.khuyen_mai()} {line.promotionCode}</small>{/if}</td>
                  <td>{line.unit}</td>
                  <td class="num">{num(line.quantity)}</td>
                  <td class="num">{Number(line.unitPrice).toLocaleString(intlLocale(), { minimumFractionDigits: 2, maximumFractionDigits: 2 })}{#if line.pricingSource === 'CUSTOMER_PRICE'}<small class="own-price">{m.gr_nguon_gia()}</small>{/if}{#if line.pricingSource === 'MANUAL_PRICE'}<small class="manual-price">{m.gia_dong_sua_tay({ price: Number(line.originalUnitPrice ?? 0).toLocaleString(intlLocale(), { minimumFractionDigits: 2, maximumFractionDigits: 2 }) })}</small>{/if}</td>
                  <td class="num" title={m.bac_doanh_so_khuyen_mai({ p0: line.salesTierDiscountRate ?? 0, p1: line.promotionDiscountRate ?? 0 })}>{line.gift ? '' : Number(line.discountRate).toLocaleString(intlLocale())}</td>
                  <td class="num"><b>{num(line.netAmount ?? line.lineTotal)}</b></td>
                  {#if lineTax}<td class="num">{vatLabel(line.vatRate ?? order.taxRate ?? '8', '')}</td><td class="num">{num(line.taxAmount ?? 0)}</td>{/if}
                </tr>
              {/each}
            </tbody>
          </table>
        </div>
      </article>
    </div>

    {#if nonSale}
    <aside class="card summary">
      <h2>{m.lp_khong_tinh_tien_ngan()}</h2>
      <dl>
        <div><dt>{m.lp_tong_so_luong()}</dt><dd>{num(order.lines.reduce((sum, line) => sum + Number(line.quantity), 0))}</dd></div>
        <div class="total"><dt>{m.tong_tien_thanh_toan()}</dt><dd>{vnd('0')}</dd></div>
      </dl>
      <p class="words">{gift ? m.lp_khong_tinh_tien_tang() : m.lp_khong_tinh_tien()}</p>
    </aside>
    {:else}
    <aside class="card summary">
      <h2>{m.tong_tien_phieu()}</h2>
      <dl>
        <div class="minor"><dt>{m.tien_hang_theo_gia_niem_yet()}</dt><dd>{vnd(order.subtotal)}</dd></div>
        <div class="minor"><dt>{m.chiet_khau_bac_ds_ctkm()}</dt><dd>− {vnd(order.discountTotal)}</dd></div>
        <div><dt>{m.cong_tien_hang()}</dt><dd>{vnd(netTotal)}</dd></div>
        <div><dt>{m.thue_suat_gtgt()}</dt><dd>{order.taxRate === 'MIXED' ? m.thue_theo_dong() : vatLabel(order.taxRate ?? '10')}</dd></div>
        <div><dt>{m.tien_thue_gtgt()}</dt><dd>{order.taxRate === 'KCT' ? m.khong_chiu_thue_2() : vnd(order.taxTotal)}</dd></div>
        <div class="total"><dt>{m.tong_tien_thanh_toan()}</dt><dd>{vnd(order.grandTotal)}</dd></div>
      </dl>
      <p class="words">{m.bang_chu()} <b>{vndInWords(order.grandTotal)}</b></p>
    </aside>
    {/if}
  </section>
{/if}

<Dialog bind:open={revisionOpen} title={m.yeu_cau_ke_toan_sua_phieu()}>
  <p class="lead">{m.phieu_se_quay_ve_trang_thai()}</p>
  <div class="field">
    <label for="revision-note">{m.noi_dung_can_sua()} <span class="req">*</span></label>
    <textarea id="revision-note" rows="4" maxlength="500" bind:value={revisionNote} placeholder={m.vd_khach_doi_inp6004_tu_15()}></textarea>
  </div>
  {#snippet footer()}
    <button class="btn" onclick={() => (revisionOpen = false)}>{m.huy()}</button>
    <button class="btn primary" disabled={!revisionNote.trim() || working} onclick={requestRevision}>{m.gui_yeu_cau_sua()}</button>
  {/snippet}
</Dialog>

<Dialog bind:open={discardOpen} title={order?.status === 'DRAFT' ? m.bh_xoa_tieu_de({ code: order?.code ?? '' }) : m.bh_huy_tieu_de({ code: order?.code ?? '' })}>
  <p class="lead">{order?.status === 'DRAFT' ? m.bh_xoa_giai_thich() : m.bh_huy_giai_thich()}</p>
  <div class="field">
    <label for="discard-reason">{m.bh_ly_do()} <span class="req">*</span></label>
    <textarea id="discard-reason" rows="3" maxlength="300" bind:value={discardReason} placeholder={m.bh_ly_do_placeholder()}></textarea>
    {#if discardReason.trim() && discardReason.trim().length < 5}<small class="error">{m.bh_ly_do_toi_thieu()}</small>{/if}
  </div>
  {#snippet footer()}
    <button class="btn" onclick={() => (discardOpen = false)}>{m.dong()}</button>
    <button class="btn danger" disabled={discardReason.trim().length < 5 || working} onclick={discard}>{order?.status === 'DRAFT' ? m.bh_xoa_phieu() : m.bh_huy_phieu()}</button>
  {/snippet}
</Dialog>

<Dialog bind:open={payNowOpen} title={m.pn_bo_ghi_thu()}>
  <p class="lead">{m.pn_bo_ghi_thu_giai_thich({ code: order?.payNowReceipt?.code ?? '' })}</p>
  <div class="field">
    <label for="pay-now-reason">{m.pn_ly_do()} <span class="req">*</span></label>
    <textarea id="pay-now-reason" rows="3" maxlength="300" bind:value={payNowReason}></textarea>
    {#if payNowReason.trim() && payNowReason.trim().length < 5}<small class="error">{m.bh_ly_do_toi_thieu()}</small>{/if}
  </div>
  {#snippet footer()}
    <button class="btn" onclick={() => (payNowOpen = false)}>{m.dong()}</button>
    <button class="btn danger" disabled={payNowReason.trim().length < 5 || working} onclick={undoPayNow}>{m.pn_bo_ghi_thu()}</button>
  {/snippet}
</Dialog>

<Dialog bind:open={voidOpen} title={m.root_huy_tieu_de({ code: order?.code ?? '' })}>
  <p class="lead">{m.root_huy_giai_thich()}</p>
  <div class="field">
    <label for="void-reason">{m.bh_ly_do()} <span class="req">*</span></label>
    <textarea id="void-reason" rows="3" maxlength="300" bind:value={voidReason} placeholder={m.root_huy_ly_do_placeholder()}></textarea>
    {#if voidReason.trim() && voidReason.trim().length < 5}<small class="error">{m.bh_ly_do_toi_thieu()}</small>{/if}
  </div>
  {#snippet footer()}
    <button class="btn" onclick={() => (voidOpen = false)}>{m.dong()}</button>
    <button class="btn danger" disabled={voidReason.trim().length < 5 || working} onclick={voidOrder}>{m.root_huy_phieu_da_giao()}</button>
  {/snippet}
</Dialog>

<Dialog bind:open={changeOpen} title={m.yc_tieu_de({ kind: changeKindLabel(changeKind), code: order?.code ?? '' })}>
  <p class="lead">{m.yc_giai_thich()}</p>
  <div class="field">
    <label for="change-reason">{m.bh_ly_do()} <span class="req">*</span></label>
    <textarea id="change-reason" rows="3" maxlength="300" bind:value={changeReason} placeholder={m.bh_ly_do_placeholder()}></textarea>
    {#if changeReason.trim() && changeReason.trim().length < 5}<small class="error">{m.bh_ly_do_toi_thieu()}</small>{/if}
  </div>
  {#snippet footer()}
    <button class="btn" onclick={() => (changeOpen = false)}>{m.dong()}</button>
    <button class="btn primary" disabled={changeReason.trim().length < 5 || working} onclick={sendChange}><Send size={15} />{m.yc_gui()}</button>
  {/snippet}
</Dialog>

<ChangeRequestDialog bind:open={decideOpen} request={pendingChange} action={decideAction} ondone={changeDecided} />

<CustomerConfirmationDialog bind:order={confirmTarget} ondone={(count) => { success = m.da_xac_nhan_doi_chieu_kem({ count: count, p1: order?.warehouseKeeperName ?? '' }); load(); }} />

{#if deliverText}<ConfirmDialog bind:open={deliverAsk} title={deliverText.title} message={deliverText.message} confirmLabel={deliverText.confirmLabel} tone="navy" onconfirm={deliver} />{/if}

<WarehouseIssueDialog bind:order={issueTarget} ondone={(result) => { success = m.da_lap_phieu_tru_ton_va_2({ shipmentCode: result.shipmentCode }); load(); }} />

<style>
  .page-sub { display: flex; align-items: center; flex-wrap: wrap; gap: 8px; }
  .slip { color: var(--muted); }
  .template { margin-right: 6px; background: var(--navy); color: #fff; }
  .slip b { color: var(--navy); }
  .pill.type { background: var(--surface-2); color: var(--navy); font-weight: 600; }
  .pill.type.loan { background: var(--orange-soft); color: #b4501f; }
  .overdue { color: var(--red); font-weight: 600; }
  .btn.danger-soft { border-color: #f3c9c9; background: var(--red-soft); color: var(--red); }
  .timeline li.cancelled b { color: var(--red); }
  .timeline .who.owner { color: var(--muted); font-style: italic; }
  .timeline .who.owner.warn { color: var(--red); font-style: normal; font-weight: 600; }
  .btn.root { border-color: var(--navy-2); color: var(--navy); }
  .manual-price { display: block; color: var(--orange); font-size: 11px; font-weight: 600; white-space: nowrap; }
  .own-price { display: block; color: var(--green); font-size: 11px; font-weight: 600; white-space: nowrap; }
  .timeline li.cancelled span { border-color: var(--red) !important; background: var(--red) !important; color: #fff; }
  .banner.info { background: #eaf2fb; color: var(--navy); }
  .evidence h2 { display: flex; align-items: center; gap: 8px; }
  .evidence-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(260px, 1fr)); gap: 12px; margin: 0; padding: 0 22px 20px; list-style: none; }
  .evidence-grid li { display: grid; grid-template-columns: 96px minmax(0, 1fr); gap: 12px; align-items: start; padding: 10px; border: 1px solid var(--line); border-radius: 10px; }
  .evidence-grid img { width: 96px; height: 96px; border-radius: 6px; object-fit: cover; object-position: top; background: var(--surface-2); }
  .evidence-grid div { display: grid; gap: 3px; min-width: 0; }
  .evidence-grid b { overflow: hidden; font-size: 13px; white-space: nowrap; text-overflow: ellipsis; }
  .evidence-grid small { color: var(--muted); font-size: 11.5px; }
  .evidence-grid .pill { width: fit-content; margin-top: 4px; }
  .evidence-grid .scan { display: flex; align-items: center; gap: 4px; }
  .evidence-grid .scan.clean { color: var(--green); }
  .evidence-grid .scan.skipped { color: #b4501f; }
  .no-evidence { margin: 0; padding: 0 22px 20px; color: var(--subtle); font-size: 13px; }
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
  .timeline small { color: var(--muted); font-size: 11.5px; }
  .timeline .who { color: var(--text); font-weight: 500; }
  .layout { display: grid; grid-template-columns: minmax(0, 1fr) 340px; gap: 18px; align-items: start; }
  .layout > div { display: grid; grid-template-columns: minmax(0, 1fr); gap: 18px; min-width: 0; }
  .info dl { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 16px 22px; margin: 0; padding: 20px 22px; }
  .info .wide { grid-column: 1 / -1; }
  .info .wide2 { grid-column: span 2; }
  .info dt { color: var(--subtle); font-size: 12px; }
  .info dd { margin: 4px 0 0; font-weight: 500; }
  .lines-head { padding-bottom: 14px; }
  .order-note { white-space: pre-wrap; overflow-wrap: anywhere; }
  .pay-now dd { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; color: var(--green); font-weight: 500; }
  .pay-now dd .btn { margin-left: auto; }
  .pay-now.undone dd { color: var(--amber); font-weight: 400; }
  .summary { position: sticky; top: calc(var(--topbar) + 20px); overflow: hidden; }
  .summary h2 { margin: 0; padding: 16px 22px; background: var(--navy); color: #fff; font-size: 14.5px; font-weight: 700; text-transform: uppercase; }
  .summary dl { margin: 0; padding: 10px 22px 6px; }
  .summary dl div { display: flex; justify-content: space-between; gap: 12px; padding: 9px 0; }
  .summary dl .minor { padding: 5px 0; font-size: 12.5px; }
  .summary dl .minor + div:not(.minor) { margin-top: 6px; padding-top: 12px; border-top: 1px dashed var(--line); }
  .summary dt { color: var(--muted); }
  .summary dd { margin: 0; font-weight: 600; white-space: nowrap; }
  .summary .total { margin-top: 4px; padding-top: 14px; border-top: 1px solid var(--line); }
  .summary .total dt { color: var(--text); font-weight: 700; text-transform: uppercase; }
  .summary .total dd { color: var(--orange); font-size: 21px; font-weight: 700; }
  .words { margin: 0 22px 18px; color: var(--muted); font-size: 13px; }
  .words b { color: var(--text); }
  .lead { margin: 0; color: var(--muted); font-size: 13.5px; }
  @media (max-width: 1100px) { .layout { grid-template-columns: minmax(0, 1fr); } .summary { position: static; } .info dl { grid-template-columns: repeat(2, 1fr); } }
  @media (max-width: 640px) { .summary dd { white-space: normal; text-align: right; } .timeline { grid-template-columns: 1fr; gap: 10px; } .timeline li::before { display: none; } .info dl { grid-template-columns: 1fr; } .info .wide2 { grid-column: auto; } }
  .change-banner { flex-wrap: wrap; }
  .change-banner > span:first-of-type { flex: 1 1 320px; }
  .change-actions { display: flex; flex-wrap: wrap; gap: 6px; margin-left: auto; }
</style>
