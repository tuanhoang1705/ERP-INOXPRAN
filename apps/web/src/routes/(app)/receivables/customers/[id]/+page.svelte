<script lang="ts">
  /**
   * Sổ chi tiết công nợ một khách (CN-KH-01, 16/10/2026) — giống sheet đối chiếu công nợ Excel của kế toán:
   * Tổng công nợ, Đã thanh toán, Phí vận chuyển (khách trả, trừ nợ, cột riêng), Trả hàng / giảm, Còn lại; từng dòng có số dư lũy kế.
   * Thu tiền theo khách (tự phân bổ chứng từ cũ nhất trước), ghi phí vận chuyển, bù trừ khoản trả trước, xuất Excel.
   * Nhóm công nợ tách riêng (CN-SEG-01, 17/10/2026): ô "Công nợ <nhóm>" + "Còn lại trừ nhóm", dòng phát sinh ghi "trong đó …",
   * chứng từ còn nợ chỉ báo quá hạn trên phần nợ thường; kế toán gắn tay cả chứng từ vào nhóm (VD "Hàng mẫu").
   */
  import { m } from '$lib/paraglide/messages';
  import { page } from '$app/state';
  import { onMount } from 'svelte';
  import { CircleAlert, CircleCheck, Download, HandCoins, Shuffle, Tags, Truck } from 'lucide-svelte';
  import { api, download } from '$lib/api';
  import { date, num, vnd } from '$lib/format';
  import { hasRole } from '$lib/labels';
  import { session } from '$lib/session.svelte';
  import DateRangeFilter from '$lib/components/DateRangeFilter.svelte';
  import CustomerPaymentDrawer, { type PostedPayment } from '$lib/components/CustomerPaymentDrawer.svelte';
  import Dialog from '$lib/components/Dialog.svelte';
  import SegmentItemsDialog, { type SegmentHolder } from '$lib/components/SegmentItemsDialog.svelte';

  type Row = {
    date: string; kind: 'DEBIT' | 'VOID' | 'RETURN' | 'FREIGHT' | 'RECEIPT'; refId: string; code: string; documentNo: string; description: string; detail?: string;
    salesOrderId?: string; sourceType?: string; segments?: Array<{ code: string; amount: string }>; debit: string; receipt: string; freight: string; returns: string; balance: string;
  };
  type SegmentInfo = { code: string; name: string; active: boolean; manualOnly: boolean; outstanding: string; scope: 'ALL' | 'SELECTED'; enabled: boolean; holding?: SegmentHolder };
  type Statement = {
    partner: { id: string; code: string; name: string; province?: string; salesRepName?: string; status: string; holdReason?: string; autoHoldExempt: boolean; paymentTermDays: number; creditLimit: string };
    opening: string; closing: string; rows: Row[]; totals: { debit: string; receipt: string; freight: string; returns: string };
    openDebt: string; prepayment: string;
    openDocuments: Array<{
      id: string; code: string; documentNo: string; outstanding: string; normalOutstanding: string; segmentOutstanding: string; segments: Array<{ code: string; outstanding: string }>;
      amount: string; dueDate: string; createdAt: string; daysOverdue: number; salesOrderId?: string; segmentTag?: string;
    }>;
    segments: SegmentInfo[];
    current: { balance: string; segment: string; normal: string };
    /** Đã xuất kho, chờ giao — chưa vào công nợ (AR-DLV-01). */
    pendingDelivery?: { count: number; amount: string; orders: Array<{ id: string; code: string; amount: string; shippedAt: string | null }> };
  };

  const id = $derived(page.params.id ?? '');
  let data = $state<Statement | null>(null);
  let from = $state('');
  let to = $state('');
  let loading = $state(true);
  let error = $state('');
  let success = $state('');
  let working = $state(false);
  let drawerOpen = $state(false);
  let drawerKind = $state<'RECEIPT' | 'FREIGHT'>('RECEIPT');
  const roles = $derived(session.user?.roles);
  const canCollect = $derived(hasRole(roles, ['ACCOUNTANT']));
  const isAdmin = $derived(Boolean(roles?.includes('ADMIN')) || Boolean(session.user?.root));
  const segmentName = (code: string) => data?.segments.find((segment) => segment.code === code)?.name ?? code;
  const openSegments = $derived(data?.segments.filter((segment) => Number(segment.outstanding) > 0) ?? []);
  // Gắn tay chứng từ vào nhóm (CN-SEG-01).
  let tagOpen = $state(false);
  // Hàng khách đang nợ của một nhóm (mã + số lượng).
  let itemsOpen = $state(false);
  let itemsSegment = $state<SegmentInfo | null>(null);
  let tagTarget = $state<{ id: string; label: string; current: string } | null>(null);
  let tagSegment = $state('');
  let tagReason = $state('');
  function openTag(id: string, label: string, current = '') {
    tagTarget = { id, label, current };
    tagSegment = current;
    tagReason = '';
    tagOpen = true;
  }
  async function saveTag(event: SubmitEvent) {
    event.preventDefault();
    if (!tagTarget) return;
    working = true;
    error = '';
    try {
      const result = await api<{ partnerHoldReleased?: boolean }>(`/receivables/${tagTarget.id}/segment-tag`, { method: 'PATCH', body: JSON.stringify({ segment: tagSegment || null, reason: tagReason }) });
      success = tagSegment ? m.seg_da_gan({ code: tagTarget.label, name: segmentName(tagSegment) }) : m.seg_da_go({ code: tagTarget.label });
      if (result.partnerHoldReleased) success += ` ${m.he_thong_tu_mo_khoa_dat()}`;
      tagOpen = false;
      await load();
    } catch (caught) {
      error = caught instanceof Error ? caught.message : m.crud_loi_luu();
    } finally {
      working = false;
    }
  }

  async function load() {
    loading = true;
    error = '';
    try {
      const query = new URLSearchParams({ ...(from ? { from } : {}), ...(to ? { to } : {}) });
      data = await api<Statement>(`/receivables/customers/${id}/statement?${query}`);
    } catch (caught) {
      error = caught instanceof Error ? caught.message : m.khong_tai_duoc_cong_no();
    } finally {
      loading = false;
    }
  }
  function posted(payment: PostedPayment, kind: 'RECEIPT' | 'FREIGHT') {
    success = kind === 'FREIGHT' ? m.cn_da_ghi_phi_vc({ code: payment.code }) : m.cn_da_lap_phieu_thu({ code: payment.code });
    if (Number(payment.prepayment) > 0) success += ` ${m.cn_thu_du_tra_truoc({ amount: vnd(payment.prepayment) })}`;
    if (payment.partnerHoldReleased) success += ` ${m.he_thong_tu_mo_khoa_dat()}`;
    void load();
  }
  async function offset() {
    if (!data || !confirm(m.cn_bu_tru_hoi({ amount: vnd(data.prepayment) }))) return;
    working = true;
    error = '';
    try {
      const result = await api<{ code: string; applied: string }>(`/receivables/customers/${id}/apply-credit`, { method: 'POST', idempotentCommand: true });
      success = m.cn_da_bu_tru({ amount: vnd(result.applied), code: result.code });
      await load();
    } catch (caught) {
      error = caught instanceof Error ? caught.message : m.crud_loi_luu();
    } finally {
      working = false;
    }
  }
  async function toggleAutoHold(event: Event) {
    if (!data) return;
    const exempt = (event.currentTarget as HTMLInputElement).checked;
    working = true;
    error = '';
    try {
      const result = await api<{ released: boolean }>(`/receivables/customers/${id}/auto-hold`, { method: 'PATCH', body: JSON.stringify({ exempt }) });
      success = exempt ? m.cn_da_bat_khong_tu_khoa({ name: data.partner.name }) + (result.released ? ` ${m.he_thong_tu_mo_khoa_dat()}` : '') : m.cn_da_tat_khong_tu_khoa({ name: data.partner.name });
      await load();
    } catch (caught) {
      error = caught instanceof Error ? caught.message : m.crud_loi_luu();
      await load();
    } finally {
      working = false;
    }
  }
  // Nhóm "chọn khách" (CN-SEG-01): Admin cho / thôi cho khách này nợ riêng nhóm — phân bổ lại ngay.
  async function toggleSegment(segment: SegmentInfo, event: Event) {
    if (!data) return;
    const enabled = (event.currentTarget as HTMLInputElement).checked;
    working = true;
    error = '';
    try {
      const result = await api<{ partnerHoldReleased?: boolean }>(`/receivables/segments/${segment.code}/partners/${id}`, { method: 'PUT', body: JSON.stringify({ enabled }) });
      success = enabled ? m.seg_da_bat_khach({ customer: data.partner.code, name: segment.name }) : m.seg_da_tat_khach({ customer: data.partner.code, name: segment.name });
      if (result.partnerHoldReleased) success += ` ${m.he_thong_tu_mo_khoa_dat()}`;
      await load();
    } catch (caught) {
      error = caught instanceof Error ? caught.message : m.crud_loi_luu();
      await load();
    } finally {
      working = false;
    }
  }
  async function exportExcel() {
    if (!data) return;
    const query = new URLSearchParams({ ...(from ? { from } : {}), ...(to ? { to } : {}) });
    try {
      await download(`/receivables/customers/${id}/statement/export?${query}`, `SoCongNo_${data.partner.code}.xlsx`);
    } catch (caught) {
      error = caught instanceof Error ? caught.message : m.khong_tai_duoc_tep();
    }
  }
  function rowLabel(row: Row): string {
    switch (row.kind) {
      case 'DEBIT':
        if (row.sourceType === 'HISTORY_IMPORT') return m.cn_dong_lich_su();
        if (row.sourceType === 'OPENING_BALANCE') return m.imp_chung_tu_dau_ky({ no: row.documentNo });
        if (row.sourceType === 'WARRANTY_SERVICE') return m.wr_service_fee_of({ code: row.documentNo });
        return row.salesOrderId ? m.cn_dong_xuat_ban() : row.description;
      case 'VOID': return m.cn_dong_huy();
      case 'RECEIPT': return m.cn_dong_thu_tien();
      case 'FREIGHT': return m.cn_dong_phi_vc();
      case 'RETURN': return m.cn_dong_tra_hang();
    }
  }
  const money = (value: string) => (Number(value) ? num(value) : '');
  onMount(load);
</script>

<svelte:head><title>{data ? `${data.partner.code} · ` : ''}{m.cn_so_khach_title()} · INOXPRAN ERP</title></svelte:head>

<section class="page-head">
  <div>
    <nav class="crumbs" aria-label={m.duong_dan()}><a href="/receivables">{m.cong_no()}</a><a href="/receivables/customers">{m.cn_theo_khach_title()}</a><span>{data?.partner.code ?? '…'}</span></nav>
    <h1 class="page-title">{data?.partner.name ?? m.cn_so_khach_title()}</h1>
    {#if data}
      <p class="page-sub">
        {data.partner.code}{data.partner.province ? ` · ${data.partner.province}` : ''}{data.partner.salesRepName ? ` · ${m.nv_ban_hang()}: ${data.partner.salesRepName}` : ''}
        · {m.kh_so_ngay_no()}: {data.partner.paymentTermDays} · {m.kh_han_muc_cong_no()}: {Number(data.partner.creditLimit) ? vnd(data.partner.creditLimit) : '—'}
        {#if data.partner.status === 'ON_HOLD'}<span class="pill danger">{m.cn_dang_khoa()}</span>{/if}
      </p>
    {/if}
  </div>
  <div class="actions">
    <a class="btn" href={`/catalog/dealers/${id}`}>{m.cn_ho_so_khach()}</a>
    <button class="btn" onclick={exportExcel} disabled={!data}><Download size={16} />{m.xuat_excel()}</button>
    {#if canCollect}
      {#if data && Number(data.prepayment) > 0 && Number(data.openDebt) > 0}<button class="btn" onclick={offset} disabled={working}><Shuffle size={16} />{m.cn_bu_tru_tra_truoc()}</button>{/if}
      <button class="btn" onclick={() => { drawerKind = 'FREIGHT'; drawerOpen = true; }}>{m.cn_ghi_phi_vc()}</button>
      <button class="btn primary" onclick={() => { drawerKind = 'RECEIPT'; drawerOpen = true; }}><HandCoins size={16} />{m.cn_thu_tien()}</button>
    {/if}
  </div>
</section>

{#if error}<div class="banner error"><CircleAlert size={17} />{error}</div>{/if}
{#if success}<div class="banner success"><CircleCheck size={17} />{success}</div>{/if}

{#if data}
  <section class="kpis">
    {#if from}<div class="card kpi"><p class="label">{m.cn_so_du_dau_ky()}</p><p class="value">{vnd(data.opening)}</p></div>{/if}
    <div class="card kpi"><p class="label">{m.cn_tong_cong_no()}</p><p class="value">{vnd(data.totals.debit)}</p></div>
    <div class="card kpi"><p class="label">{m.cn_da_thanh_toan()}</p><p class="value">{vnd(data.totals.receipt)}</p></div>
    <div class="card kpi"><p class="label">{m.cn_phi_vc()}</p><p class="value">{vnd(data.totals.freight)}</p></div>
    <div class="card kpi"><p class="label">{m.cn_tra_hang_giam()}</p><p class="value">{vnd(data.totals.returns)}</p></div>
    <div class="card kpi main"><p class="label">{m.cn_con_lai()}</p><p class="value">{vnd(data.closing)}</p>{#if Number(data.prepayment) > 0}<p class="note">{m.cn_tra_truoc_ngan({ amount: num(data.prepayment) })}</p>{/if}</div>
  </section>
  {#if data.pendingDelivery?.count}
    <!-- AR-DLV-01: phiếu đã lập SWK nhưng chưa xác nhận giao — chưa tính vào công nợ, vẫn tính vào hạn mức khi duyệt phiếu mới. -->
    <div class="banner warning pending-delivery">
      <Truck size={17} />
      <span>
        {m.cn_cho_giao({ count: data.pendingDelivery.count, amount: vnd(data.pendingDelivery.amount) })}
        {#each data.pendingDelivery.orders as order, index (order.id)}{index ? ', ' : ' '}<a href={`/sales/orders/${order.id}`}>{order.code}</a>{/each}
      </span>
    </div>
  {/if}
  {#if openSegments.length}
    <!-- Giống sheet đối chiếu của kế toán: "Công nợ quạt" + "Còn lại công nợ (trừ quạt)" — số hiện tại, không theo kỳ. -->
    <section class="kpis segments">
      {#each openSegments as segment (segment.code)}
        <div class="card kpi segment">
          <p class="label">{m.seg_cong_no_nhom({ name: segment.name })}{from || to ? ` (${m.seg_hien_tai()})` : ''}</p><p class="value">{vnd(segment.outstanding)}</p><p class="note muted">{m.seg_khong_tinh_qua_han()}</p>
          {#if segment.holding}<button type="button" class="link-btn items-link" onclick={() => { itemsSegment = segment; itemsOpen = true; }}>{m.seg_hang_tom_tat_ngan({ skus: segment.holding.skuCount, quantity: Number(segment.holding.quantity).toLocaleString('vi-VN') })} — {m.seg_xem_ma_hang()}</button>{/if}
        </div>
      {/each}
      <div class="card kpi normal"><p class="label">{m.seg_con_lai_tru_nhom()}{from || to ? ` (${m.seg_hien_tai()})` : ''}</p><p class="value">{vnd(data.current.normal)}</p></div>
    </section>
  {/if}

  {#if isAdmin}
    <label class="exempt card">
      <input type="checkbox" checked={data.partner.autoHoldExempt} disabled={working} onchange={toggleAutoHold} />
      <span><b>{m.cn_khong_tu_khoa()}</b><small>{m.cn_khong_tu_khoa_giai_thich()}</small></span>
    </label>
  {:else if data.partner.autoHoldExempt}
    <p class="exempt-note">{m.cn_khong_tu_khoa()} — {m.cn_khong_tu_khoa_giai_thich()}</p>
  {/if}
  {#if isAdmin}
    {#each data.segments.filter((segment) => segment.active && !segment.manualOnly && segment.scope === 'SELECTED') as segment (segment.code)}
      <label class="exempt card">
        <input type="checkbox" checked={segment.enabled} disabled={working} onchange={(event) => toggleSegment(segment, event)} />
        <span><b>{m.seg_cho_no_rieng({ name: segment.name })}</b><small>{m.seg_cho_no_rieng_giai_thich()}</small></span>
      </label>
    {/each}
  {/if}
{/if}

<section class="card filters">
  <DateRangeFilter bind:from bind:to label={m.cn_ky_so()} id="statement-date" onchange={load} />
</section>

<section class="card">
  <div class="table-wrap">
    <table class="table ledger">
      <thead><tr>
        <th>{m.cn_ngay()}</th><th>{m.chung_tu()}</th><th>{m.dien_giai()}</th><th class="num">{m.cn_phat_sinh_no()}</th><th class="num">{m.cn_da_thu()}</th>
        <th class="num">{m.cn_phi_vc()}</th><th class="num">{m.cn_tra_hang_giam()}</th><th class="num">{m.cn_con_no_luy_ke()}</th>
      </tr></thead>
      <tbody>
        {#if loading && !data}<tr class="empty-row"><td colspan="8">{m.dang_doc_so_cong_no()}</td></tr>
        {:else if data}
          {#if from}<tr class="opening"><td colspan="7">{m.cn_so_du_dau_ky()}</td><td class="num"><b>{num(data.opening)}</b></td></tr>{/if}
          {#each data.rows as row (`${row.kind}-${row.refId}`)}
            <tr class:void={row.kind === 'VOID'}>
              <td class="nowrap">{date(row.date)}</td>
              <td>{#if row.salesOrderId}<a class="link code" href={`/sales/orders/${row.salesOrderId}`}>{row.documentNo}</a>{:else}<span class="code">{row.documentNo}</span>{/if}{#if row.code !== row.documentNo}<small>{row.code}</small>{/if}</td>
              <td>
                {rowLabel(row)}{#if row.detail}<small>{row.detail}</small>{/if}
                {#each row.segments ?? [] as part (part.code)}<small class="segment-note">{m.seg_trong_do({ name: segmentName(part.code), amount: num(part.amount) })}</small>{/each}
                {#if canCollect && row.kind === 'DEBIT' && data.segments.some((segment) => segment.active)}<button class="link-btn tag" onclick={() => openTag(row.refId, row.documentNo, data?.openDocuments.find((doc) => doc.id === row.refId)?.segmentTag ?? '')}><Tags size={12} />{m.seg_gan_nhom()}</button>{/if}
              </td>
              <td class="num">{money(row.debit)}</td>
              <td class="num">{money(row.receipt)}</td>
              <td class="num">{money(row.freight)}</td>
              <td class="num">{money(row.returns)}</td>
              <td class="num"><b>{num(row.balance)}</b></td>
            </tr>
          {:else}<tr class="empty-row"><td colspan="8">{m.cn_khong_phat_sinh()}</td></tr>{/each}
        {/if}
      </tbody>
      {#if data && data.rows.length}
        <tfoot><tr><td colspan="3">{m.cn_cong_phat_sinh()}</td><td class="num">{num(data.totals.debit)}</td><td class="num">{num(data.totals.receipt)}</td><td class="num">{num(data.totals.freight)}</td><td class="num">{num(data.totals.returns)}</td><td class="num"><b>{num(data.closing)}</b></td></tr></tfoot>
      {/if}
    </table>
  </div>
</section>

{#if data && data.openDocuments.length}
  <section class="card">
    <header class="card-head"><h2>{m.cn_chung_tu_con_no()}</h2><span class="muted">{vnd(data.openDebt)}</span></header>
    <div class="table-wrap">
      <table class="table">
        <thead><tr><th>{m.chung_tu()}</th><th>{m.ngay_phat_sinh()}</th><th>{m.han_thanh_toan()}</th><th class="num">{m.gia_tri()}</th><th class="num">{m.con_lai()}</th><th>{m.cn_qua_han()}</th></tr></thead>
        <tbody>
          {#each data.openDocuments as doc (doc.id)}
            <tr>
              <td>{#if doc.salesOrderId}<a class="link code" href={`/sales/orders/${doc.salesOrderId}`}>{doc.documentNo}</a>{:else}<span class="code">{doc.documentNo}</span>{/if}<small>{doc.code}</small></td>
              <td>{date(doc.createdAt)}</td>
              <td>{date(doc.dueDate)}</td>
              <td class="num muted">{num(doc.amount)}</td>
              <td class="num"><b>{num(doc.outstanding)}</b>{#each doc.segments as part (part.code)}<small>{m.seg_phan_nhom({ name: segmentName(part.code) })}: {num(part.outstanding)}{doc.segmentTag === part.code ? ` · ${m.seg_gan_tay()}` : ''}</small>{/each}</td>
              <td>{#if doc.daysOverdue > 0}<span class={`pill ${doc.daysOverdue > 60 ? 'danger' : doc.daysOverdue > 30 ? 'warning' : 'orange'}`}>{m.qua_han()} {doc.daysOverdue} {m.ngay()}</span>{:else if Number(doc.normalOutstanding) <= 0 && Number(doc.segmentOutstanding) > 0}<span class="pill neutral">{m.seg_khong_tinh_qua_han()}</span>{:else}<span class="muted">{m.cn_trong_han()}</span>{/if}</td>
            </tr>
          {/each}
        </tbody>
      </table>
    </div>
  </section>
{/if}

<CustomerPaymentDrawer bind:open={drawerOpen} bind:kind={drawerKind} partnerId={id} partnerName={data?.partner.name ?? ''} onposted={posted} />

<Dialog bind:open={tagOpen} title={m.seg_gan_nhom_tieu_de({ code: tagTarget?.label ?? '' })}>
  <form id="tag-form" class="tag-form" onsubmit={saveTag}>
    <p class="muted">{m.seg_gan_nhom_giai_thich()}</p>
    <div class="field"><label for="tag-segment">{m.seg_nav()}</label>
      <select id="tag-segment" bind:value={tagSegment}>
        <option value="">{m.seg_tu_dong()}</option>
        {#each data?.segments.filter((segment) => segment.active) ?? [] as segment (segment.code)}<option value={segment.code}>{segment.name}</option>{/each}
      </select>
    </div>
    <div class="field"><label for="tag-reason">{m.seg_ly_do()}</label><input id="tag-reason" bind:value={tagReason} required minlength="5" maxlength="300" /></div>
  </form>
  {#snippet footer()}
    <button type="button" class="btn" onclick={() => (tagOpen = false)}>{m.huy()}</button>
    <button class="btn primary" form="tag-form" disabled={working || tagReason.trim().length < 5}>{working ? m.kh_dang_luu() : m.crud_luu()}</button>
  {/snippet}
</Dialog>

<SegmentItemsDialog bind:open={itemsOpen} title={itemsSegment ? m.seg_hang_dang_no_tieu_de({ name: itemsSegment.name }) : ''} holders={itemsSegment?.holding ? [itemsSegment.holding] : []} />

<style>
  .items-link { margin-top: 6px; padding: 0; border: 0; background: none; color: var(--blue); font-size: 12.5px; cursor: pointer; text-align: left; }
  .items-link:hover { text-decoration: underline; }
  .kpis { display: grid; grid-template-columns: repeat(auto-fit, minmax(160px, 1fr)); gap: 12px; margin-bottom: 16px; }
  .pending-delivery { margin-bottom: 16px; }
  .pending-delivery a { color: inherit; font-weight: 700; text-decoration: underline; }
  .kpi .value { font-size: 18px; }
  /* Màn hẹp: số tiền tỷ đồng phải hiện đủ, không cắt "…". */
  @media (max-width: 480px) {
    .kpis { grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 10px; }
    .kpi { padding: 12px 14px; }
    .kpi .value { font-size: 15px; font-variant-numeric: tabular-nums; white-space: normal; overflow-wrap: anywhere; }
  }
  .kpi.main { border-left: 4px solid var(--orange); }
  .kpi.main .value { color: var(--orange); }
  .kpis.segments { margin-top: -4px; }
  .kpi.segment { border-left: 4px solid var(--navy-2); }
  .kpi.normal { border-left: 4px solid var(--green); }
  .kpi.normal .value { color: var(--green); }
  .ledger td small.segment-note { color: var(--navy-2); }
  .link-btn.tag { display: inline-flex; align-items: center; gap: 4px; margin-top: 2px; padding: 0; border: 0; background: none; color: var(--navy-2); font: inherit; font-size: 11.5px; cursor: pointer; }
  .link-btn.tag:hover { text-decoration: underline; }
  .tag-form { display: grid; gap: 14px; }
  .tag-form p { margin: 0; font-size: 13px; }
  td small { display: block; color: var(--subtle); font-size: 11.5px; }
  .kpi .note { margin: 4px 0 0; color: var(--green); font-size: 12px; }
  .exempt { display: flex; align-items: flex-start; gap: 10px; margin-bottom: 16px; padding: 12px 16px; cursor: pointer; }
  .exempt input { width: 17px; height: 17px; margin-top: 2px; accent-color: var(--navy); }
  .exempt span { display: grid; gap: 2px; }
  .exempt small, .exempt-note { color: var(--muted); font-size: 12.5px; }
  .exempt-note { margin: 0 0 16px; }
  .filters { grid-template-columns: minmax(0, 420px); }
  .ledger td small { display: block; color: var(--subtle); font-size: 11.5px; }
  .ledger tr.void td { color: var(--muted); }
  .ledger tr.opening td { background: var(--line-soft); font-weight: 600; }
  tfoot td { font-weight: 600; }
  .page-sub .pill { margin-left: 6px; }
</style>
