<script lang="ts" module>
  export type ErpTwin = {
    id: string; customerCode: string; date: string; documentNo: string; amount: string;
    order: { code: string; orderDate: string; debt: string };
    sameAmount?: boolean; sameLines?: boolean;
  };
</script>

<script lang="ts">
  /**
   * Chứng từ bán ở sổ cũ trùng phiếu BH trên ERP (IMP-AR-01, 19/10/2026): dòng kế toán đã ghép (ô "Phiếu ERP (trùng)", không nhập)
   * và dòng nghi trùng chưa ghép (vẫn nhập — kiểm chứng từ xuất rồi ghép). Dùng ở chạy thử nhập, hộp thay lô và hộp đối chiếu.
   */
  import { m } from '$lib/paraglide/messages';
  import { date, num } from '$lib/format';

  let { linked = [], twins = [] }: { linked?: ErpTwin[]; twins?: ErpTwin[] } = $props();
  const rows = $derived([...twins.map((row) => ({ ...row, linked: false })), ...linked.map((row) => ({ ...row, linked: true }))]);
  const day = (iso: string) => (iso ? date(`${iso}T12:00:00+07:00`) : '—');
  const money = (value: string) => Number(value).toLocaleString('vi-VN', { maximumFractionDigits: 2 });
</script>

{#if rows.length}
  <h3>{m.twin_tieu_de({ count: rows.length })}</h3>
  {#if twins.length}<p class="twin-hint">{m.twin_huong_dan()}</p>{/if}
  <div class="table-wrap">
    <table class="table compact erp-twins">
      <thead><tr><th>{m.imp_ma_kh()}</th><th>{m.twin_so_cu()}</th><th class="num">{m.crm_so_tien()}</th><th>{m.twin_phieu_erp()}</th><th class="num">{m.twin_cong_no_erp()}</th><th>{m.trang_thai()}</th></tr></thead>
      <tbody>
        {#each rows as row (row.id)}
          <tr class:changed={!row.linked}>
            <td>{row.customerCode}</td>
            <td><span class="code">{row.id}</span> {row.documentNo || '—'}<small>{day(row.date)}</small></td>
            <td class="num">{money(row.amount)}</td>
            <td><span class="code">{row.order.code}</span><small>{day(row.order.orderDate)}</small></td>
            <td class="num">{num(row.order.debt)}</td>
            <td>
              {#if row.linked}<span class="pill success">{m.twin_da_ghep()}</span>
              {:else}<span class="pill warning">{m.twin_nghi_trung()}</span><small>{[row.sameLines ? m.twin_cung_dong_hang() : '', row.sameAmount ? m.twin_cung_so_tien() : ''].filter(Boolean).join(' · ')}</small>{/if}
            </td>
          </tr>
        {/each}
      </tbody>
    </table>
  </div>
{/if}

<style>
  h3 { margin: 14px 0 8px; font-size: 14px; }
  .twin-hint { margin: 0 0 8px; color: var(--muted); font-size: 12.5px; line-height: 1.5; }
  td small { display: block; color: var(--subtle); }
  tr.changed td { background: var(--amber-soft); }
</style>
