<script lang="ts">
  import { m } from '$lib/paraglide/messages';
  import { onMount } from 'svelte';
  import { CircleAlert, Download, ImageOff } from 'lucide-svelte';
  import { api, download } from '$lib/api';
  import { date, num, todayIso } from '$lib/format';
  import { availabilityLabel } from '$lib/labels';
  import { debounce, initialPageSize, pageQuery, rememberPageSize, type Paged } from '$lib/paging';
  import Pagination from '$lib/components/Pagination.svelte';

  type PriceRow = {
    productId: string; sku: string; model?: string; name: string; categoryName?: string; baseUnit: string; packSize?: number; specification?: string; imageId?: string;
    distributorPrice: string | null; dealerPrice: string | null; retailPrice: string; availability: string; clearance: boolean;
  };
  let rows = $state<PriceRow[]>([]);
  let categories = $state<Array<{ id: string; name: string }>>([]);
  let categoryId = $state('');
  let search = $state('');
  /** Bảng giá áp dụng tại ngày (LIST-DATE-01); trống = hiện hành. */
  let at = $state('');
  let loading = $state(true);
  let error = $state('');
  let total = $state(0);
  let page = $state(1);
  let pageSize = $state(initialPageSize());
  let exporting = $state(false);
  /** Ảnh đang phóng to (bấm vào ảnh nhỏ). */
  let zoom = $state<PriceRow | null>(null);
  const imageSrc = (row: PriceRow) => `/api/v1/attachments/products/${row.productId}/${row.imageId}`;

  /** File Excel "Bảng báo giá" theo mẫu công ty, kèm ảnh sản phẩm — cùng bộ lọc đang chọn (PRICE-IMG-01, 11/11/2026). */
  async function exportExcel() {
    exporting = true;
    error = '';
    try {
      await download(`/price-list/export?${new URLSearchParams({ ...(categoryId ? { categoryId } : {}), ...(search.trim() ? { search: search.trim() } : {}), ...(at ? { at } : {}) })}`, 'Bang_Bao_Gia_INOXPRAN.xlsx');
    } catch (caught) {
      error = caught instanceof Error ? caught.message : m.khong_tai_duoc_bang_gia();
    } finally {
      exporting = false;
    }
  }

  async function load() {
    loading = true;
    error = '';
    try {
      const result = await api<Paged<PriceRow>>(`/price-list?${pageQuery({ categoryId, search, at }, page, pageSize)}`);
      rows = result.rows;
      total = result.total;
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
  <div class="actions">
    <a class="btn" href="/pricing/tiers">{m.chinh_sach_chiet_khau()}</a>
    <button class="btn primary" disabled={exporting} onclick={exportExcel}><Download size={16} />{exporting ? m.bg_dang_xuat() : m.bg_xuat_bang_bao_gia()}</button>
  </div>
</section>

<section class="card filters">
  <div class="field"><label for="search">{m.tim_kiem()}</label><input id="search" bind:value={search} oninput={searchChanged} placeholder={m.ma_model_hoac_ten_san_pham()} /></div>
  <div class="field"><label for="price-at">{m.dr_bang_gia_ngay()}</label><input id="price-at" type="date" max={todayIso()} bind:value={at} onchange={refilter} /></div>
  <div class="field"><label for="category">{m.nhom_san_pham()}</label><select id="category" bind:value={categoryId} onchange={refilter}><option value="">{m.tat_ca_nhom()}</option>{#each categories as item}<option value={item.id}>{item.name}</option>{/each}</select></div>
</section>

{#if error}<div class="banner error"><CircleAlert size={17} />{error}</div>{/if}
{#if at}<div class="banner warning"><CircleAlert size={17} /><span>{m.dr_dang_xem_gia_ngay({ date: date(`${at}T00:00:00+07:00`) })}</span></div>{/if}

<section class="card">
  <div class="table-wrap">
    <table class="table">
      <thead><tr><th>{m.stt()}</th><th>{m.model()}</th><th class="name-col">{m.ten_san_pham()}</th><th class="img-col">{m.bg_hinh_anh()}</th><th class="spec-col">{m.bg_tinh_nang()}</th><th class="num">{m.sp_thung()}</th><th class="num">{m.gia_dai_ly()}</th><th class="num npp">{m.gia_net_npp()}</th><th class="num">{m.gia_ban_le()}</th><th>{m.tinh_trang()}</th></tr></thead>
      <tbody>
        {#if loading && !rows.length}<tr class="empty-row"><td colspan="10">{m.dang_tai_bang_gia()}</td></tr>
        {:else if rows.length}
          {#each rows as row, index (row.productId)}
            {@const info = availabilityLabel[row.availability] ?? { label: row.availability, tone: '' }}
            <tr>
              <td class="muted">{(page - 1) * pageSize + index + 1}</td>
              <td class="code">{row.sku}</td>
              <td class="name-col">{row.name}<small>{row.categoryName}</small></td>
              <td class="img-col">{#if row.imageId}<button class="thumb" onclick={() => (zoom = row)} aria-label={`${m.bg_hinh_anh()} ${row.sku}`}><img src={imageSrc(row)} alt={row.name} loading="lazy" /></button>{:else}<span class="no-img" title={m.bg_chua_co_anh()}><ImageOff size={18} /></span>{/if}</td>
              <td class="spec-col"><div class="spec">{row.specification ?? '—'}</div></td>
              <td class="num">{row.packSize ?? '—'}</td>
              <td class="num">{row.dealerPrice ? num(row.dealerPrice) : '—'}</td>
              <td class="num npp"><b>{row.distributorPrice ? num(row.distributorPrice) : '—'}</b></td>
              <td class="num">{num(row.retailPrice)}</td>
              <td><span class={`pill ${info.tone}`}>{info.label}</span>{#if row.clearance}<small>{m.ma_hang_clear()}</small>{/if}</td>
            </tr>
          {/each}
        {:else}<tr class="empty-row"><td colspan="10">{m.khong_co_ma_hang_phu_hop()}</td></tr>{/if}
      </tbody>
    </table>
  </div>
  <Pagination {page} {pageSize} {total} {loading} onchange={changePage} />
</section>

{#if zoom}
  <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
  <div class="zoom" role="dialog" aria-modal="true" aria-label={zoom.name} tabindex="-1" onclick={() => (zoom = null)} onkeydown={(event) => event.key === 'Escape' && (zoom = null)}>
    <figure><img src={imageSrc(zoom)} alt={zoom.name} /><figcaption>{zoom.sku} — {zoom.name}</figcaption></figure>
  </div>
{/if}

<style>
  .filters { grid-template-columns: 2fr 1fr 1fr; }
  th.npp { background: #eaf6e4; color: #3f7a2a; }
  td.npp { background: #f5fbf2; }
  /* Hình ảnh + tính năng sản phẩm như bảng báo giá của công ty (PRICE-IMG-01). */
  .name-col { min-width: 190px; }
  .img-col { width: 104px; text-align: center; }
  .thumb { display: inline-flex; padding: 0; border: 1px solid var(--line); border-radius: 6px; background: var(--surface); cursor: zoom-in; overflow: hidden; }
  .thumb img { display: block; width: 88px; height: 72px; object-fit: contain; }
  .no-img { display: inline-flex; color: var(--subtle); }
  .spec-col { min-width: 240px; max-width: 340px; }
  .spec { max-height: 9.5em; overflow: auto; white-space: pre-line; font-size: 12.5px; line-height: 1.45; color: var(--muted); }
  .zoom { position: fixed; inset: 0; z-index: 60; display: grid; place-items: center; padding: 24px; background: rgb(15 23 42 / 0.72); cursor: zoom-out; }
  .zoom figure { margin: 0; max-width: min(900px, 100%); text-align: center; }
  .zoom img { max-width: 100%; max-height: 80vh; border-radius: 8px; background: #fff; }
  .zoom figcaption { margin-top: 8px; color: #fff; font-size: 14px; }
</style>
