<script lang="ts">
  import { m } from '$lib/paraglide/messages';
  import { onMount } from 'svelte';
  import { CircleAlert } from 'lucide-svelte';
  import { api } from '$lib/api';
  import { date, num } from '$lib/format';
  import { availabilityLabel } from '$lib/labels';
  import { debounce, initialPageSize, pageQuery, rememberPageSize, type Paged } from '$lib/paging';
  import Pagination from '$lib/components/Pagination.svelte';

  type PriceRow = {
    productId: string; sku: string; name: string; categoryName?: string; baseUnit: string; packSize?: number;
    distributorPrice: string | null; dealerPrice: string | null; retailPrice: string; availability: string; clearance: boolean;
  };
  type Book = { code: string; name: string; customerTier: string; version: number; validFrom: string; lineCount: number };
  let rows = $state<PriceRow[]>([]);
  let books = $state<Book[]>([]);
  let categories = $state<Array<{ id: string; name: string }>>([]);
  let categoryId = $state('');
  let search = $state('');
  let loading = $state(true);
  let error = $state('');
  let total = $state(0);
  let page = $state(1);
  let pageSize = $state(initialPageSize());

  async function load() {
    loading = true;
    error = '';
    try {
      const result = await api<Paged<PriceRow> & { books: Book[] }>(`/price-list?${pageQuery({ categoryId, search }, page, pageSize)}`);
      rows = result.rows;
      total = result.total;
      books = result.books;
    } catch (caught) {
      error = caught instanceof Error ? caught.message : m.khong_tai_duoc_bang_gia();
    } finally {
      loading = false;
    }
  }
  const refilter = () => {
    page = 1;
    void load();
  };
  const searchChanged = debounce(refilter);
  function changePage(next: number, size: number) {
    if (size !== pageSize) rememberPageSize(size);
    page = next;
    pageSize = size;
    void load();
  }
  onMount(async () => {
    categories = await api<Array<{ id: string; name: string }>>('/product-categories').catch(() => []);
    await load();
  });
</script>

<svelte:head><title>{m.bang_gia_theo_cap_inoxpran_erp()}</title></svelte:head>

<section class="page-head">
  <div>
    <nav class="crumbs" aria-label={m.duong_dan()}><a href="/pricing">{m.gia_khuyen_mai()}</a><span>{m.bang_gia_theo_cap()}</span></nav>
    <h1 class="page-title">{m.bang_gia_theo_cap_dai_ly()}</h1>
    <p class="page-sub">{m.gia_chua_vat_theo_bang_bao()}</p>
  </div>
  <div class="actions"><a class="btn" href="/pricing/tiers">{m.chinh_sach_chiet_khau()}</a></div>
</section>

<section class="books">
  {#each books as book}
    <article class="card book"><span>{book.customerTier === 'TIER_1' ? m.cap_1_npp() : book.customerTier === 'TIER_2' ? m.cap_2_dai_ly_2() : m.tat_ca()}</span><b>{book.name}</b><small>{book.code} {m.phien_ban()} {book.version} {m.hieu_luc_tu()} {date(book.validFrom)} · {book.lineCount} {m.ma_2()}</small></article>
  {/each}
  <article class="card book"><span>{m.khach_le()}</span><b>{m.gia_ban_le_niem_yet()}</b><small>{m.lay_tu_danh_muc_san_pham()}</small></article>
</section>

<section class="card filters">
  <div class="field"><label for="search">{m.tim_kiem()}</label><input id="search" bind:value={search} oninput={searchChanged} placeholder={m.ma_model_hoac_ten_san_pham()} /></div>
  <div class="field"><label for="category">{m.nhom_san_pham()}</label><select id="category" bind:value={categoryId} onchange={refilter}><option value="">{m.tat_ca_nhom()}</option>{#each categories as item}<option value={item.id}>{item.name}</option>{/each}</select></div>
</section>

{#if error}<div class="banner error"><CircleAlert size={17} />{error}</div>{/if}

<section class="card">
  <div class="table-wrap">
    <table class="table">
      <thead><tr><th>{m.stt()}</th><th>{m.model()}</th><th>{m.ten_san_pham()}</th><th class="num">{m.sp_thung()}</th><th class="num">{m.gia_dai_ly()}</th><th class="num npp">{m.gia_net_npp()}</th><th class="num">{m.gia_ban_le()}</th><th>{m.tinh_trang()}</th></tr></thead>
      <tbody>
        {#if loading && !rows.length}<tr class="empty-row"><td colspan="8">{m.dang_tai_bang_gia()}</td></tr>
        {:else if rows.length}
          {#each rows as row, index (row.productId)}
            {@const info = availabilityLabel[row.availability] ?? { label: row.availability, tone: '' }}
            <tr>
              <td class="muted">{(page - 1) * pageSize + index + 1}</td>
              <td class="code">{row.sku}</td>
              <td>{row.name}<small>{row.categoryName}</small></td>
              <td class="num">{row.packSize ?? '—'}</td>
              <td class="num">{row.dealerPrice ? num(row.dealerPrice) : '—'}</td>
              <td class="num npp"><b>{row.distributorPrice ? num(row.distributorPrice) : '—'}</b></td>
              <td class="num">{num(row.retailPrice)}</td>
              <td><span class={`pill ${info.tone}`}>{info.label}</span>{#if row.clearance}<small>{m.ma_hang_clear()}</small>{/if}</td>
            </tr>
          {/each}
        {:else}<tr class="empty-row"><td colspan="8">{m.khong_co_ma_hang_phu_hop()}</td></tr>{/if}
      </tbody>
    </table>
  </div>
  <Pagination {page} {pageSize} {total} {loading} onchange={changePage} />
</section>

<style>
  .books { display: grid; grid-template-columns: repeat(auto-fit, minmax(240px, 1fr)); gap: 14px; margin-bottom: 18px; }
  .book { display: grid; gap: 4px; padding: 16px 18px; }
  .book span { width: fit-content; padding: 2px 9px; border-radius: 999px; background: var(--blue-soft); color: var(--navy-2); font-size: 11.5px; font-weight: 700; }
  .book b { font-size: 15px; }
  .book small { color: var(--muted); font-size: 12px; }
  .filters { grid-template-columns: 2fr 1fr; }
  th.npp { background: #eaf6e4; color: #3f7a2a; }
  td.npp { background: #f5fbf2; }
</style>
