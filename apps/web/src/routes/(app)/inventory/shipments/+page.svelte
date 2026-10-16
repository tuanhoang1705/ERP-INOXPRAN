<script lang="ts">
  import { partyName } from '$lib/slip-type';
  import { m } from '$lib/paraglide/messages';
  import type { SalesOrder } from '@inoxpran/contracts';
  import { onMount } from 'svelte';
  import { CircleAlert, CircleCheck, Printer } from 'lucide-svelte';
  import WarehouseIssueDialog from '$lib/components/WarehouseIssueDialog.svelte';
  import { api } from '$lib/api';
  import { dateTime, num } from '$lib/format';
  import { hasRole } from '$lib/labels';
  import { session } from '$lib/session.svelte';
  import { initialPageSize, rememberPageSize, type Paged } from '$lib/paging';
  import Pagination from '$lib/components/Pagination.svelte';

  type Order = SalesOrder & { warehouseKeeperId?: string; warehouseKeeperName?: string; province?: string; lineCount?: number; shippedAt?: string; confirmedAt?: string; confirmedByName?: string; receiverName?: string; carrier?: string };
  let waiting = $state<Order[]>([]);
  let checking = $state<Order[]>([]);
  let shipping = $state<Order[]>([]);
  /** "Đang giao hàng" có thể dài (mọi phiếu đã xuất chưa xác nhận giao) nên tải theo trang; hai hàng chờ còn lại ngắn. */
  let shippingTotal = $state(0);
  let shippingPage = $state(1);
  let shippingPageSize = $state(initialPageSize(20));
  let loading = $state(true);
  let working = $state('');
  let error = $state('');
  let success = $state('');
  let issueTarget = $state<Order | null>(null);
  const canShip = $derived(hasRole(session.user?.roles, ['WAREHOUSE', 'WAREHOUSE_MANAGER']));
  /** Nhân viên thủ kho: danh sách đã được máy chủ lọc theo phiếu giao cho mình. Quản lý kho xem toàn bộ. */
  const canDeliver = $derived(hasRole(session.user?.roles, ['WAREHOUSE', 'WAREHOUSE_MANAGER']));
  const keeperOnly = $derived(Boolean(session.user?.roles.includes('WAREHOUSE') && !hasRole(session.user.roles, ['DIRECTOR', 'ACCOUNTANT', 'SALES', 'SALES_MANAGER', 'AUDITOR', 'WAREHOUSE_MANAGER'])));
  /** Lập SWK / xác nhận giao chỉ cho thủ kho được giao phiếu (ADMIN luôn được). */
  const mine = (order: Order) => Boolean(session.user && (session.user.roles.includes('ADMIN') || order.warehouseKeeperId === session.user.sub));

  async function load() {
    loading = true;
    error = '';
    try {
      let shipped: Paged<Order>;
      [waiting, checking, shipped] = await Promise.all([
        api<Order[]>('/sales-orders?status=RESERVED&confirmation=CONFIRMED,NOT_REQUIRED'),
        api<Order[]>('/sales-orders?status=RESERVED&confirmation=PENDING'),
        api<Paged<Order>>(`/sales-orders?status=SHIPPED&page=${shippingPage}&pageSize=${shippingPageSize}`),
      ]);
      shipping = shipped.rows;
      shippingTotal = shipped.total;
    } catch (caught) {
      error = caught instanceof Error ? caught.message : m.khong_tai_duoc_danh_sach_xuat();
    } finally {
      loading = false;
    }
  }
  async function deliver(order: Order) {
    working = order.id;
    error = '';
    success = '';
    try {
      await api(`/sales-orders/${order.id}/deliver`, { method: 'POST', body: JSON.stringify({ version: order.version }), idempotentCommand: true });
      success = m.da_xac_nhan_giao_thanh_cong({ code: order.warehouseSlipNo ?? order.code });
      await load();
    } catch (caught) {
      error = caught instanceof Error ? caught.message : m.khong_the_hoan_tat_thao_tac();
    } finally {
      working = '';
    }
  }
  function changeShippingPage(next: number, size: number) {
    if (size !== shippingPageSize) rememberPageSize(size);
    shippingPage = next;
    shippingPageSize = size;
    void load();
  }
  function print(order: Order, type: 'BH' | 'SWK') {
    window.open(`/print/sales-issue/${order.id}?type=${type}`, '_blank', 'noopener');
  }
  onMount(load);
</script>

<svelte:head><title>{m.xuat_kho_giao_hang_inoxpran_erp()}</title></svelte:head>

<section class="page-head">
  <div>
    <nav class="crumbs" aria-label={m.duong_dan()}><a href="/inventory">{m.kho_giao_hang()}</a><span>{m.xuat_kho_giao_hang()}</span></nav>
    <h1 class="page-title">{m.lap_phieu_swk_theo_doi_giao()}</h1>
    <p class="page-sub">
      {#if keeperOnly}{m.chi_hien_thi_phieu_ke_toan()} <b>{session.user?.displayName}</b> {m.lam_thu_kho_xuat_hang()}{:else}{m.moi_phieu_bh_duoc_giao_cho()}{/if}
      {m.kho_chi_xuat_hang_cho_phieu()}
    </p>
  </div>
  <div class="actions"><button class="btn" onclick={load}>{m.lam_moi()}</button></div>
</section>

{#if error}<div class="banner error"><CircleAlert size={17} />{error}</div>{/if}
{#if success}<div class="banner success"><CircleCheck size={17} />{success}</div>{/if}

<section class="card block">
  <header class="card-head head"><h2>{m.cho_kho_lap_phieu_swk()} <span class="pill">{waiting.length}</span></h2><span class="muted">{m.khach_da_xac_nhan_dung_ma()}</span></header>
  <div class="table-wrap">
    <table class="table">
      <thead><tr><th>{m.so_phieu_bh()}</th><th>{m.khach_hang()}</th><th>{m.dia_diem_giao_2()}</th><th class="num">{m.so_dong()}</th><th class="num">{m.tong_thanh_toan_vnd()}</th><th>{m.kd_xac_nhan()}</th><th></th></tr></thead>
      <tbody>
        {#if loading}<tr class="empty-row"><td colspan="7">{m.dang_tai()}</td></tr>
        {:else if waiting.length}
          {#each waiting as order}
            <tr>
              <td><a class="code" href={`/sales/orders/${order.id}`}>{order.code}</a></td>
              <td>{partyName(order)}<small>{order.customerCode ?? ''}{order.province ? ` · ${order.province}` : ''}{!keeperOnly && order.warehouseKeeperName ? m.thu_kho({ warehouseKeeperName: order.warehouseKeeperName }) : ''}</small></td>
              <td>{order.deliveryLocation ?? m.khach_lay_tai_kho()}</td>
              <td class="num">{order.lineCount ?? order.lines.length}</td>
              <td class="num"><b>{num(order.grandTotal)}</b></td>
              <td class="muted">{order.confirmedAt ? dateTime(order.confirmedAt) : '—'}{#if order.confirmedByName}<small>{order.confirmedByName}</small>{/if}</td>
              <td class="actions-cell"><div class="row-actions">
                <button class="btn small" onclick={() => print(order, 'BH')} title={m.in_phieu_bh_de_soan_hang()}><Printer size={14} /></button>
                {#if canShip && mine(order)}<button class="btn primary small" onclick={() => (issueTarget = order)}>{m.lap_swk_xuat()}</button>{:else if order.warehouseKeeperName}<span class="assigned">{m.thu_kho_2()} {order.warehouseKeeperName}</span>{/if}
              </div></td>
            </tr>
          {/each}
        {:else}<tr class="empty-row"><td colspan="7">{m.khong_co_phieu_nao_cho_xuat()}</td></tr>{/if}
      </tbody>
    </table>
  </div>
</section>

<section class="card block">
  <header class="card-head head"><h2>{m.dang_giao_hang()} <span class="pill neutral">{shippingTotal}</span></h2></header>
  <div class="table-wrap">
    <table class="table">
      <thead><tr><th>{m.so_phieu_swk()}</th><th>{m.so_phieu_bh()}</th><th>{m.khach_hang()}</th><th>{m.nguoi_nhan_van_chuyen()}</th><th class="num">{m.tong_thanh_toan_vnd()}</th><th>{m.thoi_diem_xuat()}</th><th></th></tr></thead>
      <tbody>
        {#if loading}<tr class="empty-row"><td colspan="7">{m.dang_tai()}</td></tr>
        {:else if shipping.length}
          {#each shipping as order}
            <tr>
              <td class="code">{order.warehouseSlipNo ?? '—'}</td>
              <td><a class="code" href={`/sales/orders/${order.id}`}>{order.code}</a></td>
              <td>{partyName(order)}{#if order.province}<small>{order.province}</small>{/if}</td>
              <td>{order.receiverName ?? '—'}{#if order.carrier}<small>{order.carrier}</small>{/if}</td>
              <td class="num"><b>{num(order.grandTotal)}</b></td>
              <td class="muted">{dateTime(order.shippedAt ?? order.updatedAt)}</td>
              <td class="actions-cell"><div class="row-actions">
                {#if order.warehouseSlipNo}<button class="btn small" onclick={() => print(order, 'SWK')} title={m.in_phieu_swk()}><Printer size={14} /></button>{/if}
                {#if canDeliver && mine(order)}<button class="btn navy small" disabled={working === order.id} onclick={() => deliver(order)}>{m.da_giao()}</button>{:else if order.warehouseKeeperName}<span class="assigned">{m.thu_kho_2()} {order.warehouseKeeperName}</span>{/if}
              </div></td>
            </tr>
          {/each}
        {:else}<tr class="empty-row"><td colspan="7">{m.khong_co_phieu_nao_dang_giao()}</td></tr>{/if}
      </tbody>
    </table>
  </div>
  {#if shippingTotal > shippingPageSize || shippingPage > 1}<Pagination page={shippingPage} pageSize={shippingPageSize} total={shippingTotal} {loading} onchange={changeShippingPage} />{/if}
</section>

{#if checking.length}
  <section class="card block">
    <header class="card-head head"><h2>{m.da_giu_hang_cho_kd_doi()} <span class="pill warning">{checking.length}</span></h2><span class="muted">{m.chua_duoc_xuat_kho_co_the()}</span></header>
    <div class="table-wrap">
      <table class="table">
        <thead><tr><th>{m.so_phieu_bh()}</th><th>{m.khach_hang()}</th><th>{m.nhan_vien_ban_hang()}</th><th class="num">{m.so_dong()}</th><th class="num">{m.tong_thanh_toan_vnd()}</th></tr></thead>
        <tbody>
          {#each checking as order}
            <tr>
              <td><a class="code" href={`/sales/orders/${order.id}`}>{order.code}</a></td>
              <td>{partyName(order)}</td>
              <td>{order.salesRepName ?? '—'}</td>
              <td class="num">{order.lineCount ?? order.lines.length}</td>
              <td class="num">{num(order.grandTotal)}</td>
            </tr>
          {/each}
        </tbody>
      </table>
    </div>
  </section>
{/if}

<WarehouseIssueDialog bind:order={issueTarget} ondone={(result) => { success = m.da_lap_phieu_tru_ton_va({ shipmentCode: result.shipmentCode }); load(); }} />

<style>
  .block { margin-bottom: 18px; }
  .head { padding-bottom: 14px; }
  .head h2 { display: flex; align-items: center; gap: 8px; }
  .actions-cell { width: 1%; }
  .row-actions { display: flex; justify-content: flex-end; align-items: center; gap: 6px; white-space: nowrap; }
  .assigned { color: var(--muted); font-size: 12.5px; }
</style>
