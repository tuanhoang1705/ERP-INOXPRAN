<script lang="ts">
  /**
   * Phiếu trả hàng: khách trả hàng (nhập kho, NK… — trước 31/10/2026 là TH…) và trả nhà máy (xuất kho, XT…).
   * Loại trả quyết định cột trên báo cáo tồn kho tháng (滞销退货 / 套餐搭配退回 / 进口不良 / 使用不良 / 库存退货返厂).
   */
  import { m } from '$lib/paraglide/messages';
  import type { StockReturn, Warehouse } from '@inoxpran/contracts';
  import { onMount } from 'svelte';
  import { ArrowLeftRight, Ban, CircleAlert, CircleCheck, FileCheck, History, PackageCheck, PackageMinus, PackagePlus, Pencil, Warehouse as WarehouseIcon } from 'lucide-svelte';
  import { api } from '$lib/api';
  import { dateTime, num, vnd } from '$lib/format';
  import { hasRole } from '$lib/labels';
  import { session } from '$lib/session.svelte';
  import Dialog from '$lib/components/Dialog.svelte';
  import { categoryLabel } from '$lib/inventory';
  import { initialPageSize, pageQuery, rememberPageSize, type Paged } from '$lib/paging';
  import { can } from '$lib/permissions';
  import Pagination from '$lib/components/Pagination.svelte';
  import StockReturnDialog from '$lib/components/StockReturnDialog.svelte';
  import ReturnAccountingDialog from '$lib/components/ReturnAccountingDialog.svelte';
  import ReturnCreditTargetDialog from '$lib/components/ReturnCreditTargetDialog.svelte';
  import SampleReturnDialog from '$lib/components/SampleReturnDialog.svelte';

  let rows = $state<StockReturn[]>([]);
  let total = $state(0);
  let page = $state(1);
  let pageSize = $state(initialPageSize());
  let kind = $state('');
  let warehouses = $state<Warehouse[]>([]);
  let loading = $state(true);
  let error = $state('');
  let success = $state('');
  let dialogOpen = $state(false);
  // Nhập lại hàng mẫu NVKD mượn (SAL-TYPE-01): thủ kho / quản lý kho.
  let sampleOpen = $state(false);
  const canSample = $derived(hasRole(session.user?.roles, ['WAREHOUSE', 'WAREHOUSE_MANAGER']));
  let dialogKind = $state<'CUSTOMER' | 'SUPPLIER'>('CUSTOMER');
  /** Sửa / hủy phiếu đã lưu (20/10/2026): người ghi kho; phiếu hàng mẫu nhập lại và phiếu đã hủy không sửa. */
  let editing = $state<StockReturn | null>(null);
  const revisable = (row: StockReturn) => editable && row.status !== 'VOIDED' && row.kind !== 'SAMPLE';
  /** Hủy được: phiếu sửa được, và hàng mẫu nhập lại không có phiếu xuất mẫu (nhập nhầm cả phiếu — 27/10/2026). */
  const voidable = (row: StockReturn) => editable && row.status !== 'VOIDED' && (row.kind !== 'SAMPLE' || (row.noSlip === true && !row.salesOrderCode));
  let voidTarget = $state<StockReturn | null>(null);
  let voidOpen = $state(false);
  let voidReason = $state('');
  let voidError = $state('');
  let voidSaving = $state(false);
  let historyTarget = $state<StockReturn | null>(null);
  let historyOpen = $state(false);
  /** Ngày nhận khác lúc lập phiếu (nhập bù / sửa ngày) thì ghi thêm giờ lập. */
  const backdated = (row: StockReturn) => Boolean(row.receivedAt) && Math.abs(new Date(row.receivedAt as string).getTime() - new Date(row.createdAt).getTime()) > 60_000;
  const changeLabel = (field: string) =>
    ({ partner: m.inv_doi_tac(), category: m.inv_loai_phat_sinh(), warehouse: m.kho(), source: m.inv_phieu_goc(), receivedAt: m.inv_ngay_nhan_hang(), note: m.ghi_chu(), lines: m.inv_hang_tra() } as Record<string, string>)[field] ?? field;
  const changeValue = (field: string, value: string) => (!value ? '—' : field === 'category' ? categoryLabel(value) : field === 'receivedAt' ? dateTime(value) : value);
  function openEdit(row: StockReturn) {
    editing = row;
    dialogKind = row.kind === 'SUPPLIER' ? 'SUPPLIER' : 'CUSTOMER';
    dialogOpen = true;
  }
  async function saveVoid(event: SubmitEvent) {
    event.preventDefault();
    if (!voidTarget) return;
    if (voidReason.trim().length < 3) {
      voidError = m.inv_ghi_chu_toi_thieu();
      return;
    }
    voidSaving = true;
    try {
      await api(`/inventory/returns/${voidTarget.id}/void`, { method: 'POST', idempotentCommand: true, body: JSON.stringify({ version: voidTarget.version ?? 0, reason: voidReason.trim() }) });
      success = m.inv_da_huy_phieu({ code: voidTarget.code });
      voidOpen = false;
      await load();
    } catch (caught) {
      voidError = caught instanceof Error ? caught.message : m.crud_loi_luu();
    } finally {
      voidSaving = false;
    }
  }
  const editable = $derived(can.editWarehouses());
  /** Kế toán xử lý công nợ phiếu khách trả: lập phiếu giảm nợ "Trả hàng" hoặc ghi không giảm (D1, 22/10/2026). */
  const accountant = $derived(hasRole(session.user?.roles, ['ACCOUNTANT']));
  let accountingOpen = $state(false);
  let accountingTarget = $state<StockReturn | null>(null);
  /** Đổi nơi trừ phiếu giảm nợ đã ghi: tổng công nợ ↔ một nhóm công nợ riêng (AR-RET-01). */
  let retargetOpen = $state(false);
  let retargetTarget = $state<StockReturn | null>(null);
  function retargeted(row: StockReturn & { partnerHoldReleased?: boolean }) {
    success = m.rct_da_doi({ code: row.creditNote?.code ?? row.code, target: row.creditNote?.segment ? m.rac_tru_nhom({ name: row.creditNote.segment }) : m.rac_tong_cong_no() }) + (row.partnerHoldReleased ? ` ${m.rac_mo_khoa()}` : '');
    void load();
  }
  function accounted(row: StockReturn & { partnerHoldReleased?: boolean }) {
    success = row.creditNote
      ? m.rac_da_lap({ code: row.code, payment: row.creditNote.code, amount: vnd(row.creditNote.amount) }) + (row.partnerHoldReleased ? ` ${m.rac_mo_khoa()}` : '')
      : m.rac_da_khong_giam({ code: row.code });
    void load();
  }

  async function load() {
    loading = true;
    error = '';
    try {
      const result = await api<Paged<StockReturn>>(`/inventory/returns?${pageQuery({ kind }, page, pageSize)}`);
      rows = result.rows;
      total = result.total;
    } catch (caught) {
      error = caught instanceof Error ? caught.message : m.inv_khong_tai_duoc();
    } finally {
      loading = false;
    }
  }
  onMount(() => {
    void load();
    void api<Warehouse[]>('/warehouses').then((list) => (warehouses = list)).catch(() => undefined);
  });
  function changePage(next: number, size: number) {
    if (size !== pageSize) rememberPageSize(size);
    page = next;
    pageSize = size;
    void load();
  }
  function openDialog(next: 'CUSTOMER' | 'SUPPLIER') {
    editing = null;
    dialogKind = next;
    dialogOpen = true;
  }
</script>

<svelte:head><title>{m.inv_phieu_tra_hang()} · INOXPRAN ERP</title></svelte:head>

<section class="page-head">
  <div>
    <nav class="crumbs" aria-label={m.duong_dan()}><a href="/inventory">{m.kho_giao_hang()}</a><span>{m.inv_phieu_tra_hang()}</span></nav>
    <h1 class="page-title">{m.inv_phieu_tra_hang()}</h1>
    <p class="page-sub">{m.inv_phieu_tra_hang_mo_ta()}</p>
  </div>
  {#if editable}
    <div class="actions">
      {#if canSample}<button class="btn" onclick={() => (sampleOpen = true)}><PackageCheck size={16} />{m.lp_nhap_lai_hang_mau()}</button>{/if}
      <button class="btn" onclick={() => openDialog('SUPPLIER')}><PackageMinus size={16} />{m.inv_tra_nha_may()}</button>
      <button class="btn primary" onclick={() => openDialog('CUSTOMER')}><PackagePlus size={16} />{m.inv_khach_tra_hang()}</button>
    </div>
  {/if}
</section>

<section class="card filters">
  <div class="field">
    <label for="kind">{m.inv_loai_phieu()}</label>
    <select id="kind" bind:value={kind} onchange={() => { page = 1; void load(); }}>
      <option value="">{m.tat_ca()}</option>
      <option value="CUSTOMER">{m.inv_khach_tra_hang()}</option>
      <option value="SUPPLIER">{m.inv_tra_nha_may()}</option>
      <option value="SAMPLE">{m.lp_tra_hang_mau()}</option>
    </select>
  </div>
</section>

{#if error}<div class="banner error"><CircleAlert size={17} />{error}</div>{/if}
{#if success}<div class="banner success"><CircleCheck size={17} />{success}</div>{/if}

<section class="card">
  <!-- 21/10/2026: gộp 12 cột còn 6 để bảng vừa màn hình, không phải kéo ngang (phiếu · khách / kho / phiếu gốc · hàng trả · giá trị / kế toán · ghi chú · thao tác). -->
  <div class="table-wrap">
    <table class="table returns">
      <colgroup><col class="c-slip" /><col class="c-partner" /><col /><col class="c-acct" /><col class="c-note" />{#if editable}<col class="c-act" />{/if}</colgroup>
      <thead><tr><th>{m.chung_tu()}</th><th>{m.inv_doi_tac()}</th><th>{m.inv_hang_tra()}</th><th>{m.inv_gia_tri_bh()} · {m.inv_ke_toan()}</th><th>{m.ghi_chu()}</th>{#if editable}<th><span class="sr-only">{m.inv_hanh_dong()}</span></th>{/if}</tr></thead>
      <tbody>
        {#if loading && !rows.length}<tr class="empty-row"><td colspan={editable ? 6 : 5}>{m.dang_tai()}</td></tr>
        {:else if rows.length}
          {#each rows as row (row.id)}
            <tr class:voided={row.status === 'VOIDED'}>
              <td class="slip">
                <span class="code">{row.code}</span>
                {#if row.legacyCode}<small class="legacy">{m.inv_ma_cu({ code: row.legacyCode })}</small>{/if}
                <span class={`pill ${row.kind === 'CUSTOMER' ? 'success' : row.kind === 'SAMPLE' ? 'neutral' : 'orange'}`}>{categoryLabel(row.category)}</span>
                <!-- Phiếu đã hủy coi như đã xóa (27/10/2026): API chỉ trả về cho quản trị gốc. -->
                {#if row.status === 'VOIDED'}<span class="pill danger" title={m.inv_huy_chi_root()}>{m.inv_trang_thai_da_huy()}</span>{/if}
                <span class="when" title={m.inv_ngay_nhan_hang()}>{dateTime(row.receivedAt ?? row.createdAt)}</span>
                <small>{#if backdated(row)}{m.inv_lap_luc({ time: dateTime(row.createdAt) })} · {/if}{row.createdByName}</small>
                {#if row.revisions?.length}<button type="button" class="link-btn" onclick={() => { historyTarget = row; historyOpen = true; }}><History size={13} />{m.inv_da_sua_lan({ count: row.revisions.length })}</button>{/if}
              </td>
              <td>
                {#if row.partnerCode}<span class="code">{row.partnerCode}</span>{/if}
                <small class="partner">{row.partnerName}</small>
                <small class="where"><WarehouseIcon size={12} />{row.warehouseName}</small>
                {#if row.salesOrderCode ?? row.purchaseOrderCode}<small>{m.inv_phieu_goc()}: <b class="code">{row.salesOrderCode ?? row.purchaseOrderCode}</b></small>{/if}
              </td>
              <td>
                <div class="lines">
                  {#each row.lines as line}<div class="line"><span class="code">{line.sku}</span> × {num(line.quantity)} {line.unit.toLowerCase()}{#if line.note}<small class="reason">{line.note}</small>{/if}</div>{/each}
                </div>
              </td>
              <td>
                {#if row.value}<b class="money">{vnd(row.value.total)}</b><small>{m.inv_gia_tri_chi_tiet({ net: vnd(row.value.net), tax: vnd(row.value.tax) })}</small>{/if}
                {#if row.accountingStatus === 'PENDING'}
                  <span class="pill warning">{m.inv_cho_ke_toan()}</span>
                  {#if accountant}<button class="btn small acct" onclick={() => { accountingTarget = row; accountingOpen = true; }}><FileCheck size={14} />{m.rac_nut_mo()}</button>{/if}
                {:else if row.accountingStatus === 'DONE' && row.creditNote}
                  <span class="pill success">{m.rac_da_giam_no({ amount: vnd(row.creditNote.amount) })}</span>
                  <small>{#if row.partnerId}<a class="code" href={`/receivables/customers/${row.partnerId}`}>{row.creditNote.code}</a>{:else}{row.creditNote.code}{/if} · {row.accountingNote} · {row.accountingByName}</small>
                  {#if Number(row.creditNote.credit) > 0}<small>{m.rac_khach_tra_truoc({ amount: vnd(row.creditNote.credit) })}</small>{/if}
                  {#if row.creditNote.segment}<small>{m.rac_tru_nhom({ name: row.creditNote.segment })}</small>{/if}
                  {#if accountant}<button class="btn small acct" onclick={() => { retargetTarget = row; retargetOpen = true; }}><ArrowLeftRight size={14} />{m.rct_nut_mo()}</button>{/if}
                {:else if row.accountingStatus === 'DONE'}
                  <span class="pill success">{row.accountingMode === 'NONE' ? m.rac_khong_giam() : m.inv_ke_toan_xong()}</span><small>{row.accountingNote} · {row.accountingByName}</small>
                {:else if !row.value}<span class="muted">—</span>{/if}
                {#if row.previousAccounting}<small class="warn-text">{m.inv_ke_toan_truoc({ note: row.previousAccounting.note, name: row.previousAccounting.byName })}{#if row.previousAccounting.creditCode} · {m.rac_phieu_tu_huy({ code: row.previousAccounting.creditCode })}{/if}</small>{/if}
              </td>
              <td class="note">{row.note}{#if row.voidReason}<small class="warn-text">{m.inv_ly_do_huy()}: {row.voidReason}</small>{/if}</td>
              {#if editable}
                <td class="act">
                  {#if revisable(row)}
                    <button class="icon-btn" title={m.crud_sua()} aria-label={m.crud_sua()} onclick={() => openEdit(row)}><Pencil size={16} /></button>
                  {/if}
                  {#if voidable(row)}
                    <button class="icon-btn danger" title={m.inv_huy_phieu()} aria-label={m.inv_huy_phieu()} onclick={() => { voidTarget = row; voidReason = ''; voidError = ''; voidOpen = true; }}><Ban size={16} /></button>
                  {/if}
                </td>
              {/if}
            </tr>
          {/each}
        {:else}<tr class="empty-row"><td colspan={editable ? 6 : 5}>{m.inv_chua_co_phieu_tra()}</td></tr>{/if}
      </tbody>
    </table>
  </div>
  <Pagination {page} {pageSize} {total} {loading} onchange={changePage} />
</section>
<p class="hint">{m.inv_tra_hang_cong_no()}</p>

<ReturnAccountingDialog bind:open={accountingOpen} target={accountingTarget} onsaved={accounted} />
<ReturnCreditTargetDialog bind:open={retargetOpen} target={retargetTarget} onsaved={retargeted} />

<Dialog bind:open={voidOpen} title={m.inv_huy_phieu_tra({ code: voidTarget?.code ?? '' })}>
  <form id="void-form" class="acct-form" onsubmit={saveVoid}>
    {#if voidError}<div class="banner error"><CircleAlert size={17} /><span>{voidError}</span></div>{/if}
    <p class="hint">{m.inv_huy_phieu_ghi_chu()}</p>
    <div class="field">
      <label for="void-reason">{m.inv_ly_do_huy()} <span class="req">*</span></label>
      <input id="void-reason" bind:value={voidReason} maxlength="300" />
    </div>
  </form>
  {#snippet footer()}
    <button type="button" class="btn" onclick={() => (voidOpen = false)}>{m.huy()}</button>
    <button type="submit" class="btn danger" form="void-form" disabled={voidSaving}><Ban size={15} />{voidSaving ? m.kh_dang_luu() : m.inv_huy_phieu()}</button>
  {/snippet}
</Dialog>

<Dialog bind:open={historyOpen} title={`${m.inv_lich_su_sua()} — ${historyTarget?.code ?? ''}`} wide>
  <ol class="revisions">
    {#each [...(historyTarget?.revisions ?? [])].reverse() as revision}
      <li>
        <b>{revision.action === 'VOID' ? m.inv_rev_void() : m.inv_rev_edit()}</b> · {revision.byName} · {dateTime(revision.at)}
        <p>{revision.reason}</p>
        {#if revision.changes.length}
          <ul>
            {#each revision.changes as change}<li><span class="muted">{changeLabel(change.field)}:</span> {changeValue(change.field, change.from)} → <b>{changeValue(change.field, change.to)}</b></li>{/each}
          </ul>
        {/if}
      </li>
    {/each}
  </ol>
  {#snippet footer()}<button type="button" class="btn" onclick={() => (historyOpen = false)}>{m.dong()}</button>{/snippet}
</Dialog>

<StockReturnDialog bind:open={dialogOpen} kind={dialogKind} {warehouses} {editing}
  onsaved={(code) => { success = editing ? m.inv_da_sua_phieu({ code }) : m.inv_da_ghi_phieu({ code }); if (!editing) page = 1; editing = null; void load(); }} />
{#if canSample}<SampleReturnDialog bind:open={sampleOpen} {warehouses} onsaved={(code) => { success = m.smp_da_nhap({ code }); page = 1; void load(); }} />{/if}

<style>
  .filters { grid-template-columns: minmax(220px, 320px); }
  td small { display: block; color: var(--subtle); font-size: 12px; }
  /* Bảng phiếu trả hàng gọn (21/10/2026): ô đặt trên cùng, chữ ghi chú xuống dòng bình thường, cột hàng trả co giãn. */
  .returns { table-layout: fixed; min-width: 900px; }
  .returns td { padding: 10px 12px; vertical-align: top; }
  .returns th { padding: 10px 12px; white-space: normal; }
  .returns .c-slip { width: 178px; }
  .returns .c-partner { width: 210px; }
  .returns .c-acct { width: 200px; }
  .returns .c-note { width: 15%; }
  .returns .c-act { width: 52px; }
  .slip > * { display: block; width: fit-content; }
  .slip .pill { margin-top: 4px; }
  .slip .legacy { margin-top: 2px; color: var(--muted); font-size: 11.5px; }
  .slip .when { margin-top: 6px; color: var(--text); font-size: 13px; }
  .partner { overflow-wrap: anywhere; }
  .where { display: flex !important; align-items: flex-start; gap: 4px; margin-top: 4px !important; color: var(--muted) !important; }
  .lines { display: grid; grid-template-columns: repeat(auto-fill, minmax(124px, 1fr)); gap: 4px 14px; }
  .line { min-width: 0; white-space: nowrap; }
  .money { display: block; }
  td .pill + .acct, td small + .pill, .money + small + .pill { margin-top: 6px; }
  td .acct { display: flex; margin-top: 6px; white-space: nowrap; }
  td.note { color: var(--muted); overflow-wrap: anywhere; }
  td.act { padding-left: 4px; padding-right: 8px; }
  td.act .icon-btn { display: grid; margin-bottom: 4px; }
  .where :global(svg) { flex: none; margin-top: 2px; }
  /* Màn 1366–1500 px: thu cột khách / kế toán để cột hàng trả vẫn chia 2 cột con. */
  @media (max-width: 1500px) {
    .returns .c-slip { width: 160px; }
    .returns .c-partner { width: 176px; }
    .returns .c-acct { width: 190px; }
    .returns .c-note { width: 13%; }
  }
  .acct-form { display: grid; gap: 12px; }
  .acct-form p { margin: 0; }
  .req { color: var(--red); }
  .hint { color: var(--subtle); font-size: 12.5px; }
  .line small.reason { display: block; margin: 1px 0 4px; color: var(--muted); white-space: normal; }
  .warn-text { color: var(--amber) !important; }
  tr.voided td { color: var(--subtle); }
  tr.voided .line { text-decoration: line-through; }
  .slip .link-btn { display: flex; margin-top: 4px; }
  .link-btn { align-items: center; gap: 4px; padding: 0; border: 0; background: none; color: var(--navy-2); font: inherit; font-size: 12px; white-space: nowrap; cursor: pointer; }
  .revisions { display: grid; gap: 14px; margin: 0; padding-left: 20px; }
  .revisions p { margin: 4px 0; }
  .revisions ul { margin: 4px 0 0; padding-left: 18px; font-size: 13px; }
</style>
