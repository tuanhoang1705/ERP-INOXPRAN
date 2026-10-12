<script lang="ts">
  import { m } from '$lib/paraglide/messages';
  import type { Product } from '@inoxpran/contracts';
  import { goto } from '$app/navigation';
  import { page } from '$app/state';
  import { onMount } from 'svelte';
  import { CircleAlert } from 'lucide-svelte';
  import { api } from '$lib/api';
  import { dateTime, num } from '$lib/format';
  import { movementLabel } from '$lib/labels';
  import { categoryLabel, movementCategory } from '$lib/inventory';
  import { initialPageSize, rememberPageSize, type Paged } from '$lib/paging';
  import Pagination from '$lib/components/Pagination.svelte';

  type Movement = {
    id: string; movementType: string; direction: 'IN' | 'OUT'; quantity: string; referenceType: string; referenceId: string;
    reason?: string; salesOrderCode?: string; occurredAt: string; category?: string;
  };
  let products = $state<Product[]>([]);
  let productId = $state('');
  let rows = $state<Movement[]>([]);
  let loading = $state(false);
  let error = $state('');
  let total = $state(0);
  let pageNo = $state(1);
  let pageSize = $state(initialPageSize());

  const product = $derived(products.find((item) => item.id === productId));
  let onHand = $state(0);
  /** Tồn sau dòng đầu trang (máy chủ tính = tồn hiện tại − phát sinh của các trang trước). */
  let topBalance = $state(0);
  /** Thẻ kho: tính lùi từ tồn đầu trang để tồn cuối mỗi dòng luôn đúng kể cả khi lịch sử dài. */
  const ledger = $derived.by(() => {
    let balance = topBalance;
    return rows.map((row) => {
      const entry = { ...row, balance };
      balance -= (row.direction === 'IN' ? 1 : -1) * Number(row.quantity);
      return entry;
    });
  });

  async function load() {
    if (!productId) {
      rows = [];
      return;
    }
    loading = true;
    error = '';
    try {
      const result = await api<Paged<Movement> & { onHand: string; topBalance: string }>(`/inventory/movements?productId=${productId}&page=${pageNo}&pageSize=${pageSize}`);
      rows = result.rows;
      total = result.total;
      onHand = Number(result.onHand);
      topBalance = Number(result.topBalance);
    } catch (caught) {
      error = caught instanceof Error ? caught.message : m.khong_tai_duoc_the_kho();
    } finally {
      loading = false;
    }
  }
  onMount(async () => {
    products = await api<Product[]>('/products').catch(() => []);
    productId = page.url.searchParams.get('productId') ?? products[0]?.id ?? '';
    await load();
  });
  function changePage(next: number, size: number) {
    if (size !== pageSize) rememberPageSize(size);
    pageNo = next;
    pageSize = size;
    void load();
  }
  function choose(value: string) {
    productId = value;
    pageNo = 1;
    goto(`/inventory/movements?productId=${value}`, { replaceState: true, keepFocus: true, noScroll: true });
    load();
  }
</script>

<svelte:head><title>{m.the_kho_inoxpran_erp()}</title></svelte:head>

<section class="page-head">
  <div>
    <nav class="crumbs" aria-label={m.duong_dan()}><a href="/inventory">{m.kho_giao_hang()}</a><span>{m.the_kho()}</span></nav>
    <h1 class="page-title">{m.the_kho()}</h1>
    <p class="page-sub">{m.so_bien_dong_bat_bien_moi()}</p>
  </div>
</section>

<section class="card filters">
  <div class="field"><label for="product">{m.san_pham()}</label>
    <select id="product" value={productId} onchange={(event) => choose(event.currentTarget.value)}>
      {#each products as item}<option value={item.id}>{item.sku} — {item.name}</option>{/each}
    </select>
  </div>
  {#if product}<div class="meta"><span>{m.don_vi_tinh()}</span><b>{product.baseUnit}</b></div><div class="meta"><span>{m.ton_cuoi_hien_tai()}</span><b>{num(onHand)} {product.baseUnit.toLowerCase()}</b></div>{/if}
</section>

{#if error}<div class="banner error"><CircleAlert size={17} />{error}</div>{/if}

<section class="card">
  <div class="table-wrap">
    <table class="table">
      <thead><tr><th>{m.thoi_diem()}</th><th>{m.nghiep_vu()}</th><th>{m.chung_tu()}</th><th>{m.dien_giai()}</th><th class="num">{m.nhap_2()}</th><th class="num">{m.xuat()}</th><th class="num">{m.ton_cuoi()}</th></tr></thead>
      <tbody>
        {#if loading && !rows.length}<tr class="empty-row"><td colspan="7">{m.dang_doc_the_kho()}</td></tr>
        {:else if ledger.length}
          {#each ledger as row}
            <tr>
              <td class="muted">{dateTime(row.occurredAt)}</td>
              <td><span class={`pill ${row.direction === 'IN' ? 'success' : 'orange'}`} title={movementLabel[row.movementType] ?? row.movementType}>{categoryLabel(movementCategory(row))}</span></td>
              <td class="code">{row.referenceId}</td>
              <td class="muted">{row.salesOrderCode ? m.theo_don({ salesOrderCode: row.salesOrderCode }) : row.reason ?? '—'}</td>
              <td class="num">{row.direction === 'IN' ? num(row.quantity) : ''}</td>
              <td class="num">{row.direction === 'OUT' ? num(row.quantity) : ''}</td>
              <td class="num"><b>{num(row.balance)}</b></td>
            </tr>
          {/each}
        {:else}<tr class="empty-row"><td colspan="7">{m.chua_co_bien_dong_cho_ma()}</td></tr>{/if}
      </tbody>
    </table>
  </div>
  <Pagination page={pageNo} {pageSize} {total} {loading} onchange={changePage} />
</section>

<style>
  .filters { grid-template-columns: minmax(280px, 2fr) 1fr 1fr; }
  .meta { display: grid; gap: 4px; padding-bottom: 8px; }
  .meta span { color: var(--subtle); font-size: 12px; }
  @media (max-width: 800px) { .filters { grid-template-columns: 1fr; } }
</style>
