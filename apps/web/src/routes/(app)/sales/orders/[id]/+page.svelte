<script lang="ts">
  import { m } from '$lib/paraglide/messages';
  import { intlLocale, templateDescription } from '$lib/i18n';
  import type { SalesOrder, Warehouse } from '@inoxpran/contracts';
  import { vndInWords } from '$lib/vnd-words';
  import { vatLabel } from '$shared/sales-math';
  import { salesIssueTemplate } from '$shared/sales-templates';
  import { page } from '$app/state';
  import { onMount } from 'svelte';
  import { Ban, Check, CircleAlert, CircleCheck, MessageSquareWarning, Paperclip, Pencil, Printer, ShieldAlert, ShieldCheck, Trash2, Warehouse as WarehouseIcon } from 'lucide-svelte';
  import { goto } from '$app/navigation';
  import CustomerConfirmationDialog from '$lib/components/CustomerConfirmationDialog.svelte';
  import Dialog from '$lib/components/Dialog.svelte';
  import WarehouseIssueDialog from '$lib/components/WarehouseIssueDialog.svelte';
  import { api } from '$lib/api';
  import { date, dateTime, num, vnd } from '$lib/format';
  import { approvalReason, hasRole, orderStage, tierLabel } from '$lib/labels';
  import { session } from '$lib/session.svelte';

  type Line = SalesOrder['lines'][number] & {
    netAmount?: string; salesTierDiscountRate?: string; promotionDiscountRate?: string; promotionCode?: string; gift?: boolean;
  };
  type Order = Omit<SalesOrder, 'lines'> & {
    lines: Line[]; province?: string; customerTier?: string; templateCode?: string;
    requestedByName?: string; issuedAt?: string; issuedByName?: string; approvedAt?: string; approvedByName?: string;
    confirmedAt?: string; confirmedByName?: string; revisionRequestedAt?: string; revisionRequestedByName?: string;
    shippedAt?: string; shippedByName?: string; receiverName?: string; carrier?: string; warehouseNote?: string; deliveredAt?: string;
    warehouseKeeperId?: string; warehouseKeeperName?: string;
    confirmationEvidence?: Array<{ id: string; fileName: string; contentType: string; size: number; sha256: string; uploadedAt: string; uploadedByName: string; decision?: string; scan?: { result: string; engine: string; scannedAt: string } }>;
  };
  type Step = { label: string; who?: string | undefined; at?: string | undefined; done: boolean; current?: boolean; cancelled?: boolean };

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
  const isAccountant = $derived(hasRole(roles, ['ACCOUNTANT']));
  const isSales = $derived(hasRole(roles, ['SALES', 'SALES_MANAGER']));
  const isWarehouse = $derived(hasRole(roles, ['WAREHOUSE', 'WAREHOUSE_MANAGER']));
  /** Hai bước cuối chỉ do thủ kho được giao phiếu thực hiện (ADMIN luôn được). */
  const isAssignedKeeper = $derived(Boolean(order && (roles.includes('ADMIN') || (isWarehouse && order.warehouseKeeperId === session.user?.sub))));
  const evidence = $derived(order?.confirmationEvidence ?? []);
  const canDelete = $derived(Boolean(order && order.status === 'DRAFT' && isAccountant));
  const canCancel = $derived(Boolean(order && ['PENDING_APPROVAL', 'APPROVED', 'RESERVED'].includes(order.status) && !order.warehouseSlipNo && isAccountant));
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
      { label: m.kt_phat_hanh_phieu_bh(), who: order.issuedByName, at: order.issuedAt, done: rank >= 1, current: status === 'DRAFT' },
    ];
    if (order.approvalStatus !== 'NOT_REQUIRED') {
      list.push({ label: m.duyet_ngoai_le(), who: order.approvedByName, at: order.approvedAt, done: rank >= 2, current: status === 'PENDING_APPROVAL' });
    }
    list.push(
      { label: m.kd_doi_chieu_voi_khach(), who: order.confirmedByName ? `${order.confirmedByName}${evidence.length ? m.anh_3({ length: evidence.filter((item) => item.decision !== 'REVISION_REQUESTED').length }) : ''}` : undefined, at: order.confirmedAt, done: rank >= 3 || confirmationStatus === 'CONFIRMED', current: status === 'RESERVED' && confirmationStatus === 'PENDING' },
      { label: m.kho_lap_swk_xuat(), who: order.warehouseSlipNo ? `${order.warehouseSlipNo} · ${order.shippedByName ?? ''}` : order.warehouseKeeperName ? m.thu_kho_3({ warehouseKeeperName: order.warehouseKeeperName }) : undefined, at: order.shippedAt, done: rank >= 3, current: status === 'RESERVED' && confirmationStatus !== 'PENDING' },
      { label: m.giao_hang_thanh_cong(), who: order.warehouseKeeperName ? m.thu_kho_3({ warehouseKeeperName: order.warehouseKeeperName }) : undefined, at: order.deliveredAt, done: rank >= 4, current: status === 'SHIPPED' },
    );
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
    const repriced = page.url.searchParams.get('repriced');
    if (repriced) repricedNote = m.bang_gia_hoac_khuyen_mai_vua({ p0: vnd(repriced) });
    warehouses = await api<Warehouse[]>('/warehouses').catch(() => []);
    await load();
  });

  async function command(path: string, body: Record<string, unknown>, message: string) {
    if (!order) return;
    working = true;
    error = '';
    success = '';
    try {
      await api(`/sales-orders/${order.id}/${path}`, { method: 'POST', body: JSON.stringify({ version: order.version, ...body }), idempotentCommand: true });
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
    <h1 class="page-title">{order ? `${order.code} — ${order.customerName}` : m.phieu_xuat_kho_ban_hang()}</h1>
    {#if order && stage}
      <p class="page-sub">
        <span class="pill template" title={templateDescription(salesIssueTemplate(order.templateCode))}>{m.mau()} {salesIssueTemplate(order.templateCode).code}</span>
        {#if order.codeMode === 'MANUAL'}<span class="pill neutral" title={m.bh_so_tu_nhap_goi_y()}>{m.bh_so_tu_nhap()}</span>{/if}
        <span class={`pill ${stage.tone}`}>{stage.label}</span>
        {#if order.warehouseSlipNo}<span class="slip">SWK: <b>{order.warehouseSlipNo}</b></span>{/if}
        {m.ngay_chung_tu_2()} {date(order.orderDate ?? order.createdAt)} {m.phien_ban()} {order.version}
      </p>
    {/if}
  </div>
  {#if order}
    <div class="actions">
      {#if order.status !== 'DRAFT' && order.status !== 'CANCELLED'}<button class="btn" onclick={() => printSlip('BH')}><Printer size={16} />{m.in_phieu_bh()}</button>{/if}
      {#if order.warehouseSlipNo}<button class="btn" onclick={() => printSlip('SWK')}><Printer size={16} />{m.in_phieu_swk()}</button>{/if}
      {#if order.status === 'DRAFT' && (isAccountant || isSales)}<a class="btn soft" href={`/sales/orders/${order.id}/edit`}><Pencil size={15} />{m.sua_phieu()}</a>{/if}
      {#if order.status === 'DRAFT' && isAccountant}<button class="btn primary" disabled={working} onclick={issue}>{m.phat_hanh_phieu_bh()}</button>{/if}
      {#if order.status === 'PENDING_APPROVAL' && hasRole(roles, ['SALES_MANAGER', 'DIRECTOR'])}<button class="btn primary" disabled={working} onclick={approve}>{m.duyet_giu_hang()}</button>{/if}
      {#if order.status === 'RESERVED' && order.confirmationStatus === 'PENDING' && (isAccountant || isSales)}
        <button class="btn danger-soft" disabled={working} onclick={() => (revisionOpen = true)}><MessageSquareWarning size={16} />{m.yeu_cau_sua()}</button>
        <button class="btn primary" disabled={working} onclick={() => (confirmTarget = order)}><Paperclip size={16} />{m.xac_nhan_doi_chieu_kem_anh()}</button>
      {/if}
      {#if order.status === 'RESERVED' && order.confirmationStatus !== 'PENDING' && isAssignedKeeper}<button class="btn primary" disabled={working} onclick={() => (issueTarget = order)}>{m.lap_phieu_swk_xuat_kho()}</button>{/if}
      {#if order.status === 'SHIPPED' && isAssignedKeeper}<button class="btn navy" disabled={working} onclick={deliver}>{m.xac_nhan_da_giao()}</button>{/if}
      {#if canDelete}<button class="btn danger-soft" disabled={working} onclick={() => { discardReason = ''; discardOpen = true; }}><Trash2 size={15} />{m.bh_xoa_phieu()}</button>{/if}
      {#if canCancel}<button class="btn danger-soft" disabled={working} onclick={() => { discardReason = ''; discardOpen = true; }}><Ban size={15} />{m.bh_huy_phieu()}</button>{/if}
    </div>
  {/if}
</section>

{#if error}<div class="banner error"><CircleAlert size={17} />{error}</div>{/if}
{#if success}<div class="banner success"><CircleCheck size={17} />{success}</div>{/if}
{#if repricedNote}<div class="banner warning"><CircleAlert size={17} /><span>{repricedNote}</span></div>{/if}

{#if loading && !order}
  <div class="card skeleton" style="height:240px"></div>
{:else if order}
  <ol class="card timeline" style={`--steps:${steps.length}`} aria-label={m.tien_trinh_phieu_xuat_kho()}>
    {#each steps as step}
      <li class:done={step.done} class:current={step.current} class:cancelled={step.cancelled}>
        <span>{#if step.done}<Check size={14} strokeWidth={3} />{/if}</span>
        <b>{step.label}</b>
        <small>{step.done && step.at ? dateTime(step.at) : step.current ? m.dang_cho() : '—'}</small>
        {#if step.who && (step.done || step.current)}<small class="who">{step.who}</small>{/if}
      </li>
    {/each}
  </ol>

  {#if order.status === 'CANCELLED'}
    <div class="banner error"><Ban size={17} /><span>{m.bh_phieu_da_huy({ at: order.cancelledAt ? dateTime(order.cancelledAt) : '—', by: order.cancelledByName ?? '—' })} <b>{m.bh_ly_do()}:</b> {order.cancelReason ?? '—'}</span></div>
  {/if}
  {#if order.confirmationStatus === 'REVISION_REQUESTED' && order.confirmationNote && order.status !== 'CANCELLED'}
    <div class="banner warning"><MessageSquareWarning size={17} /><span><b>{order.revisionRequestedByName ?? 'Kinh doanh'} {m.yeu_cau_sua_2()}{order.revisionRequestedAt ? ` (${dateTime(order.revisionRequestedAt)})` : ''}:</b> {order.confirmationNote}</span></div>
  {/if}
  {#if order.status === 'RESERVED' && order.confirmationStatus === 'PENDING'}
    <div class="banner info"><CircleAlert size={17} /><span>{m.hang_da_duoc_giu_in_phieu()} <b>{m.ma_hang_va_so_luong()}</b> {m.voi_khach_roi_bam()} <b>{m.xac_nhan_doi_chieu()}</b> {m.va_dinh_kem()} <b>{m.anh_chup_man_hinh_xac_nhan()}</b> {m.vd_tin_nhan_zalo_sau_buoc()}{order.warehouseKeeperName ? ` ${order.warehouseKeeperName}` : ''}.</span></div>
  {/if}
  {#if order.status === 'RESERVED' && order.confirmationStatus === 'CONFIRMED' && !isAssignedKeeper && (isAccountant || isSales)}
    <div class="banner info"><WarehouseIcon size={17} /><span>{m.da_doi_chieu_xong_phan_viec()} <b>{order.warehouseKeeperName ?? '—'}</b>.</span></div>
  {/if}
  {#if reasons.length}
    <div class="banner warning"><CircleAlert size={17} /><span>{m.ly_do_can_duyet_2()} {reasons.map((reason) => approvalReason[reason] ?? reason).join(' · ')}</span></div>
  {/if}

  <section class="layout">
    <div>
      <article class="card info">
        <dl>
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
          <div><dt>{m.dieu_khoan()}</dt><dd>{order.paymentTermDays ? m.cong_no_ngay_2({ paymentTermDays: order.paymentTermDays }) : m.thanh_toan_ngay()} · <span class="tag" class:b2c={order.channel === 'B2C'}>{order.channel ?? 'B2B'}</span></dd></div>
          <div class="wide2"><dt>{m.thu_kho_xuat_hang()}</dt><dd>{order.warehouseKeeperName ?? (order.status === 'DRAFT' ? m.ke_toan_chon_khi_phat_hanh() : '—')}</dd></div>
          {#if order.warehouseSlipNo}
            <div><dt>{m.so_phieu_swk()}</dt><dd class="code">{order.warehouseSlipNo}</dd></div>
            <div><dt>{m.nguoi_lap_swk()}</dt><dd>{order.shippedByName ?? '—'}</dd></div>
            <div class="wide2"><dt>{m.nguoi_nhan_hang()}</dt><dd>{order.receiverName ?? '—'}</dd></div>
            <div class="wide2"><dt>{m.van_chuyen()}</dt><dd>{order.carrier ?? '—'}</dd></div>
          {/if}
          {#if order.note || order.warehouseNote}
            <div class="wide"><dt>{m.ghi_chu_noi_bo()}</dt><dd>{[order.note, order.warehouseNote ? `Kho: ${order.warehouseNote}` : ''].filter(Boolean).join(' · ')}</dd></div>
          {/if}
        </dl>
      </article>

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
        <header class="card-head lines-head"><h2>{m.hang_hoa()}</h2><span class="muted">{order.lines.length} {m.dong_3()} {order.lines.filter((line) => line.gift).length} {m.dong_hang_tang()}</span></header>
        <div class="table-wrap">
          <table class="table">
            <thead><tr><th>{m.stt()}</th><th>{m.ma_hang()}</th><th>{m.ten_hang()}</th><th>{m.don_vi()}</th><th class="num">{m.so_luong()}</th><th class="num">{m.don_gia()}</th><th class="num">CK (%)</th><th class="num">{m.thanh_tien()}</th></tr></thead>
            <tbody>
              {#each order.lines as line, index}
                <tr class:gift-row={line.gift}>
                  <td class="muted">{index + 1}</td>
                  <td class="code">{line.sku}</td>
                  <td>{line.productName}{#if line.gift}<span class="pill orange gift-tag">{m.hang_tang()}</span>{/if}{#if line.promotionCode}<small>{m.khuyen_mai()} {line.promotionCode}</small>{/if}</td>
                  <td>{line.unit}</td>
                  <td class="num">{num(line.quantity)}</td>
                  <td class="num">{Number(line.unitPrice).toLocaleString(intlLocale(), { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</td>
                  <td class="num" title={m.bac_doanh_so_khuyen_mai({ p0: line.salesTierDiscountRate ?? 0, p1: line.promotionDiscountRate ?? 0 })}>{line.gift ? '' : Number(line.discountRate).toLocaleString(intlLocale())}</td>
                  <td class="num"><b>{num(line.netAmount ?? line.lineTotal)}</b></td>
                </tr>
              {/each}
            </tbody>
          </table>
        </div>
      </article>
    </div>

    <aside class="card summary">
      <h2>{m.tong_tien_phieu()}</h2>
      <dl>
        <div class="minor"><dt>{m.tien_hang_theo_gia_niem_yet()}</dt><dd>{vnd(order.subtotal)}</dd></div>
        <div class="minor"><dt>{m.chiet_khau_bac_ds_ctkm()}</dt><dd>− {vnd(order.discountTotal)}</dd></div>
        <div><dt>{m.cong_tien_hang()}</dt><dd>{vnd(netTotal)}</dd></div>
        <div><dt>{m.thue_suat_gtgt()}</dt><dd>{vatLabel(order.taxRate ?? '10')}</dd></div>
        <div><dt>{m.tien_thue_gtgt()}</dt><dd>{order.taxRate === 'KCT' ? m.khong_chiu_thue_2() : vnd(order.taxTotal)}</dd></div>
        <div class="total"><dt>{m.tong_tien_thanh_toan()}</dt><dd>{vnd(order.grandTotal)}</dd></div>
      </dl>
      <p class="words">{m.bang_chu()} <b>{vndInWords(order.grandTotal)}</b></p>
    </aside>
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

<CustomerConfirmationDialog bind:order={confirmTarget} ondone={(count) => { success = m.da_xac_nhan_doi_chieu_kem({ count: count, p1: order?.warehouseKeeperName ?? '' }); load(); }} />

<WarehouseIssueDialog bind:order={issueTarget} ondone={(result) => { success = m.da_lap_phieu_tru_ton_va_2({ shipmentCode: result.shipmentCode }); load(); }} />

<style>
  .page-sub { display: flex; align-items: center; flex-wrap: wrap; gap: 8px; }
  .slip { color: var(--muted); }
  .template { margin-right: 6px; background: var(--navy); color: #fff; }
  .slip b { color: var(--navy); }
  .btn.danger-soft { border-color: #f3c9c9; background: var(--red-soft); color: var(--red); }
  .timeline li.cancelled b { color: var(--red); }
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
  .gift-row { background: #fffaf6; }
  .gift-tag { margin-left: 8px; }
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
</style>
