<script lang="ts" module>
  export type SegmentItem = { sku: string; name: string; unit: string; quantity: string; returned: string; amount: string };
  export type SegmentHolder = {
    partnerId: string;
    partner?: { id: string; code: string; name: string };
    outstanding: string; skuCount: number; quantity: string;
    items: SegmentItem[];
    documents: Array<{ id: string; code: string; date: string; outstanding: string }>;
  };
</script>

<script lang="ts">
  /**
   * Hàng khách đang nợ của một nhóm công nợ tách riêng (CN-SEG-01, 19/10/2026): theo chứng từ còn nợ — mã hàng, số lượng
   * (đã trừ hàng trả lại), phần còn nợ chia theo giá trị dòng; tổng = công nợ nhóm. Dùng ở trang Nhóm và sổ công nợ khách.
   */
  import { m } from '$lib/paraglide/messages';
  import { date, num } from '$lib/format';
  import Dialog from './Dialog.svelte';

  let { open = $bindable(false), title, holders = [] }: { open?: boolean; title: string; holders?: SegmentHolder[] } = $props();
  const day = (iso: string) => (iso ? date(`${iso}T12:00:00+07:00`) : '—');
  const qty = (value: string) => Number(value).toLocaleString('vi-VN', { maximumFractionDigits: 3 });
</script>

<Dialog bind:open {title} wide>
  {#each holders as holder (holder.partnerId)}
    <section class="holder">
      <h3>
        {#if holder.partner}<b>{holder.partner.code}</b> {holder.partner.name} · {/if}
        {m.seg_hang_tom_tat({ skus: holder.skuCount, quantity: qty(holder.quantity), amount: num(holder.outstanding) })}
      </h3>
      <div class="table-wrap">
        <table class="table compact segment-items">
          <thead><tr><th>{m.ma_sp()}</th><th>{m.ten_hang()}</th><th>{m.dvt()}</th><th class="num">{m.seg_so_luong_no()}</th>{#if holder.items.some((item) => Number(item.returned) > 0)}<th class="num">{m.seg_da_tra_lai()}</th>{/if}<th class="num">{m.seg_con_no()}</th></tr></thead>
          <tbody>
            {#each holder.items as item (item.sku)}
              <tr>
                <td class="code">{item.sku}</td>
                <td>{item.name || (item.sku === '—' ? m.seg_khong_chi_tiet() : '')}</td>
                <td>{item.unit}</td>
                <td class="num">{item.sku === '—' ? '' : qty(item.quantity)}</td>
                {#if holder.items.some((row) => Number(row.returned) > 0)}<td class="num">{Number(item.returned) > 0 ? qty(item.returned) : ''}</td>{/if}
                <td class="num">{num(item.amount)}</td>
              </tr>
            {/each}
          </tbody>
          <tfoot><tr><td colspan="3"><b>{m.seg_tong_hang()}</b></td><td class="num"><b>{qty(holder.quantity)}</b></td>{#if holder.items.some((item) => Number(item.returned) > 0)}<td></td>{/if}<td class="num"><b>{num(holder.outstanding)}</b></td></tr></tfoot>
        </table>
      </div>
      <p class="docs">{m.seg_chung_tu_con_no()}: {holder.documents.map((row) => `${row.code} (${day(row.date)}) ${num(row.outstanding)}`).join(' · ')}</p>
    </section>
  {:else}
    <p class="docs">{m.seg_khong_con_hang_no()}</p>
  {/each}
  {#snippet footer()}<button class="btn" onclick={() => (open = false)}>{m.dong()}</button>{/snippet}
</Dialog>

<style>
  .holder + .holder { margin-top: 18px; }
  h3 { margin: 0 0 8px; font-size: 14px; font-weight: 600; }
  .compact td, .compact th { padding: 6px 10px; }
  tfoot td { border-top: 1px solid var(--line); }
  .docs { margin: 8px 0 0; color: var(--muted); font-size: 12.5px; line-height: 1.5; }
</style>
