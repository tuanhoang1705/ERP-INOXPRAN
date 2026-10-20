<script lang="ts">
  /**
   * Phiếu trả hàng: khách trả hàng (nhập kho, TH…) và trả nhà máy (xuất kho, XT…).
   * Loại trả quyết định cột trên báo cáo tồn kho tháng (滞销退货 / 套餐搭配退回 / 进口不良 / 使用不良 / 库存退货返厂).
   */
  import { m } from '$lib/paraglide/messages';
  import type { StockReturn, Warehouse } from '@inoxpran/contracts';
  import { onMount } from 'svelte';
  import { CircleAlert, CircleCheck, FileCheck, PackageCheck, PackageMinus, PackagePlus } from 'lucide-svelte';
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
  const editable = $derived(can.editWarehouses());
  /** Kế toán / Giám đốc xác nhận đã giảm công nợ / xuất hóa đơn điều chỉnh cho phiếu khách trả. */
  const accountant = $derived(hasRole(session.user?.roles, ['ACCOUNTANT', 'DIRECTOR']));
  let accountingOpen = $state(false);
  let accountingTarget = $state<StockReturn | null>(null);
  let accountingNote = $state('');
  let accountingError = $state('');
  let accountingSaving = $state(false);
  async function saveAccounting(event: SubmitEvent) {
    event.preventDefault();
    if (!accountingTarget) return;
    if (accountingNote.trim().length < 3) {
      accountingError = m.inv_ghi_chu_toi_thieu();
      return;
    }
    accountingSaving = true;
    try {
      await api(`/inventory/returns/${accountingTarget.id}/accounting`, { method: 'POST', body: JSON.stringify({ note: accountingNote.trim() }) });
      success = m.inv_da_xu_ly_ke_toan({ code: accountingTarget.code });
      accountingOpen = false;
      await load();
    } catch (caught) {
      accountingError = caught instanceof Error ? caught.message : m.crud_loi_luu();
    } finally {
      accountingSaving = false;
    }
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
  <div class="table-wrap">
    <table class="table">
      <thead><tr><th>{m.chung_tu()}</th><th>{m.thoi_diem()}</th><th>{m.inv_loai_phat_sinh()}</th><th>{m.inv_doi_tac()}</th><th>{m.kho()}</th><th>{m.inv_phieu_goc()}</th><th>{m.inv_hang_tra()}</th><th class="num">{m.inv_gia_tri_bh()}</th><th>{m.inv_ke_toan()}</th><th>{m.ghi_chu()}</th><th>{m.inv_nguoi_lap()}</th></tr></thead>
      <tbody>
        {#if loading && !rows.length}<tr class="empty-row"><td colspan="11">{m.dang_tai()}</td></tr>
        {:else if rows.length}
          {#each rows as row (row.id)}
            <tr>
              <td class="code">{row.code}</td>
              <td class="muted nowrap">{dateTime(row.createdAt)}</td>
              <td><span class={`pill ${row.kind === 'CUSTOMER' ? 'success' : row.kind === 'SAMPLE' ? 'neutral' : 'orange'}`}>{categoryLabel(row.category)}</span></td>
              <td>{#if row.partnerCode}<span class="code">{row.partnerCode}</span>{/if}<small>{row.partnerName}</small></td>
              <td>{row.warehouseName}</td>
              <td class="code">{row.salesOrderCode ?? row.purchaseOrderCode ?? '—'}</td>
              <td>{#each row.lines as line}<div class="line"><span class="code">{line.sku}</span> × {num(line.quantity)} {line.unit.toLowerCase()}</div>{/each}</td>
              <td class="num">{#if row.value}<b>{vnd(row.value.total)}</b><small>{m.inv_gia_tri_chi_tiet({ net: vnd(row.value.net), tax: vnd(row.value.tax) })}</small>{:else}—{/if}</td>
              <td>
                {#if row.accountingStatus === 'PENDING'}
                  <span class="pill warning">{m.inv_cho_ke_toan()}</span>
                  {#if accountant}<button class="btn small acct" onclick={() => { accountingTarget = row; accountingNote = ''; accountingError = ''; accountingOpen = true; }}><FileCheck size={14} />{m.inv_da_dieu_chinh()}</button>{/if}
                {:else if row.accountingStatus === 'DONE'}
                  <span class="pill success">{m.inv_ke_toan_xong()}</span><small>{row.accountingNote} · {row.accountingByName}</small>
                {:else}<span class="muted">—</span>{/if}
              </td>
              <td class="muted">{row.note}</td>
              <td class="muted">{row.createdByName}</td>
            </tr>
          {/each}
        {:else}<tr class="empty-row"><td colspan="11">{m.inv_chua_co_phieu_tra()}</td></tr>{/if}
      </tbody>
    </table>
  </div>
  <Pagination {page} {pageSize} {total} {loading} onchange={changePage} />
</section>
<p class="hint">{m.inv_tra_hang_cong_no()}</p>

<Dialog bind:open={accountingOpen} title={m.inv_xac_nhan_ke_toan({ code: accountingTarget?.code ?? '' })}>
  <form id="accounting-form" class="acct-form" onsubmit={saveAccounting}>
    {#if accountingError}<div class="banner error"><CircleAlert size={17} /><span>{accountingError}</span></div>{/if}
    {#if accountingTarget?.value}<p>{m.inv_gia_tri_can_dieu_chinh({ amount: vnd(accountingTarget.value.total), customer: accountingTarget.partnerName })}</p>{/if}
    <div class="field">
      <label for="acct-note">{m.inv_so_chung_tu_dieu_chinh()} <span class="req">*</span></label>
      <input id="acct-note" bind:value={accountingNote} maxlength="300" placeholder={m.inv_so_chung_tu_goi_y()} />
    </div>
  </form>
  {#snippet footer()}
    <button type="button" class="btn" onclick={() => (accountingOpen = false)}>{m.huy()}</button>
    <button type="submit" class="btn primary" form="accounting-form" disabled={accountingSaving}><FileCheck size={15} />{accountingSaving ? m.kh_dang_luu() : m.inv_da_dieu_chinh()}</button>
  {/snippet}
</Dialog>

<StockReturnDialog bind:open={dialogOpen} kind={dialogKind} {warehouses} onsaved={(code) => { success = m.inv_da_ghi_phieu({ code }); page = 1; void load(); }} />
{#if canSample}<SampleReturnDialog bind:open={sampleOpen} {warehouses} onsaved={(code) => { success = m.smp_da_nhap({ code }); page = 1; void load(); }} />{/if}

<style>
  .filters { grid-template-columns: minmax(220px, 320px); }
  td small { display: block; color: var(--subtle); font-size: 12px; }
  .line { white-space: nowrap; }
  td .acct { margin-top: 6px; }
  .acct-form { display: grid; gap: 12px; }
  .acct-form p { margin: 0; }
  .req { color: var(--red); }
  .hint { color: var(--subtle); font-size: 12.5px; }
</style>
