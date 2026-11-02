<script lang="ts">
  /**
   * Phải trả nhà cung cấp (D2, 22/10/2026): mỗi nhà cung cấp × tiền tệ — giá trị đặt, đã nhận hàng, trả nhà máy, đã trả, còn phải trả
   * (âm = đã trả trước / đặt cọc). Tính từ đơn mua + phiếu nhập kho + phiếu trả nhà máy + tiền đã trả ghi trên đơn.
   */
  import { m } from '$lib/paraglide/messages';
  import type { PayableSupplierRow } from '@inoxpran/contracts';
  import { onMount } from 'svelte';
  import { CircleAlert } from 'lucide-svelte';
  import { api } from '$lib/api';
  import { date, vnd } from '$lib/format';
  import { debounce } from '$lib/paging';
  import { money } from '$lib/purchase';

  let rows = $state<PayableSupplierRow[]>([]);
  let search = $state('');
  let loading = $state(true);
  let error = $state('');
  const totalVnd = $derived(rows.reduce((sum, row) => sum + Number(row.balanceVnd), 0));

  async function load() {
    loading = true;
    error = '';
    try {
      rows = await api<PayableSupplierRow[]>(`/payables${search.trim() ? `?search=${encodeURIComponent(search.trim())}` : ''}`);
    } catch (caught) {
      error = caught instanceof Error ? caught.message : m.apb_khong_tai_duoc();
    } finally {
      loading = false;
    }
  }
  const searchChanged = debounce(() => void load());
  onMount(load);
</script>

<svelte:head><title>{m.apb_title()} · INOXPRAN ERP</title></svelte:head>

<section class="page-head">
  <div>
    <nav class="crumbs" aria-label={m.duong_dan()}><a href="/receivables">{m.cong_no()}</a><span>{m.apb_title()}</span></nav>
    <h1 class="page-title">{m.apb_title()}</h1>
    <p class="page-sub">{m.apb_sub()}</p>
  </div>
</section>

<section class="card filters">
  <div class="field"><label for="search">{m.tim_kiem()}</label><input id="search" bind:value={search} oninput={searchChanged} placeholder={m.apb_tim_ncc()} /></div>
  <div class="total"><span>{m.apb_tong_con_phai_tra()}</span><b class:credit={totalVnd < 0}>{vnd(totalVnd)}</b></div>
</section>

{#if error}<div class="banner error"><CircleAlert size={17} />{error}</div>{/if}

<section class="card">
  <div class="table-wrap">
    <table class="table compact">
      <thead><tr>
        <th>{m.nha_cung_cap()}</th><th class="num">{m.apb_gia_tri_dat()}</th><th class="num">{m.apb_da_nhan()}</th><th class="num">{m.apb_tra_nha_may()}</th>
        <th class="num">{m.po_da_tra()}</th><th class="num">{m.apb_con_phai_tra()}</th><th>{m.apb_don_dang_mo()}</th>
      </tr></thead>
      <tbody>
        {#if loading && !rows.length}<tr class="empty-row"><td colspan="7">{m.dang_tai()}</td></tr>
        {:else if rows.length}
          {#each rows as row (`${row.supplierId}-${row.currency}`)}
            <tr>
              <td>
                <a class="link name" href={`/payables/${row.supplierId}`}>{row.supplierName}</a>
                <small>{row.supplierCode}{row.currency !== 'VND' ? ` · ${row.currency}` : ''}{row.lastActivity ? ` · ${m.apb_phat_sinh_gan_nhat({ date: date(row.lastActivity) })}` : ''}</small>
              </td>
              <td class="num muted">{money(row.ordered, row.currency)}</td>
              <td class="num">{money(row.received, row.currency)}</td>
              <td class="num muted">{Number(row.returned) ? money(row.returned, row.currency) : '—'}</td>
              <td class="num muted">{money(row.paid, row.currency)}</td>
              <td class="num">
                <b class:credit={Number(row.balance) < 0}>{money(row.balance, row.currency)}</b>
                {#if Number(row.balance) < 0}<small>{m.apb_tra_truoc()}</small>{/if}
                {#if row.currency !== 'VND'}<small>≈ {vnd(row.balanceVnd)}</small>{/if}
              </td>
              <td>{row.openOrders ? m.apb_so_don({ count: row.openOrders }) : '—'}</td>
            </tr>
          {/each}
        {:else}<tr class="empty-row"><td colspan="7">{m.apb_chua_co()}</td></tr>{/if}
      </tbody>
    </table>
  </div>
</section>
<p class="hint">{m.apb_giai_thich()}</p>

<style>
  .filters { grid-template-columns: 1.6fr 1fr; }
  .total { display: grid; gap: 4px; padding-bottom: 6px; text-align: right; }
  .total span { color: var(--subtle); font-size: 12px; }
  .total b { font-size: 18px; }
  .name { font-weight: 600; }
  .credit { color: var(--green); }
  td small { display: block; color: var(--subtle); font-size: 11.5px; }
  .hint { color: var(--subtle); font-size: 12.5px; }
  @media (max-width: 800px) { .filters { grid-template-columns: 1fr; } .total { text-align: left; } }
</style>
