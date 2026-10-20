<script lang="ts">
  /**
   * Nhập lại hàng mẫu NVKD mượn (SAL-TYPE-01, bổ sung 17/10/2026) ngay trên trang Phiếu trả hàng:
   * - Theo phiếu xuất hàng mẫu / kiểm định đang mượn: chọn phiếu → số còn ở ngoài từng mã → nhập số về (API loan-returns có sẵn);
   *   phần không về thì "Chốt phần chưa trả" trên trang phiếu.
   * - Không có phiếu (mượn trước khi dùng ERP): người mượn + kho + dòng hàng → thẻ kho "Hàng mẫu nhập lại", không qua kế toán.
   */
  import type { Warehouse } from '@inoxpran/contracts';
  import { untrack } from 'svelte';
  import { CircleAlert, Plus, X } from 'lucide-svelte';
  import { m } from '$lib/paraglide/messages';
  import { api } from '$lib/api';
  import { date, num } from '$lib/format';
  import { loanAge, slipTypeShort } from '$lib/slip-type';
  import Dialog from './Dialog.svelte';
  import NumberInput from './NumberInput.svelte';

  type LoanRow = { id: string; code: string; purpose?: string; salesRepName?: string; destination?: string; shippedAt?: string; expectedReturnDate?: string; loanStatus?: string };
  type LoanLine = { productId: string; sku: string; productName: string; unit: string; shipped: string; returned: string; remaining: string };
  type LoanOrder = { id: string; code: string; version: number; loanLines?: LoanLine[] };
  type Employee = { id: string; code: string; name: string };
  type ProductOption = { id: string; sku: string; name: string; baseUnit: string };

  let { open = $bindable(false), warehouses = [], onsaved }: { open?: boolean; warehouses?: Warehouse[]; onsaved?: (code: string) => void } = $props();

  let tab = $state<'SLIP' | 'NOSLIP'>('SLIP');
  let loans = $state<LoanRow[]>([]);
  let loansLoading = $state(false);
  let chosen = $state<LoanOrder | null>(null);
  let quantities = $state<Record<string, string>>({});
  let note = $state('');
  let employees = $state<Employee[]>([]);
  let products = $state<ProductOption[]>([]);
  let free = $state({ borrowerId: '', warehouseId: '', note: '' });
  let lines = $state<Array<{ productId: string; quantity: string }>>([]);
  let error = $state('');
  let saving = $state(false);
  const active = $derived(warehouses.filter((row) => row.active && row.purpose !== 'DEFECTIVE'));
  const loanLines = $derived(chosen?.loanLines?.filter((line) => Number(line.remaining) > 0) ?? []);
  const returnLines = $derived(loanLines.filter((line) => Number(quantities[line.productId] || 0) > 0).map((line) => ({ productId: line.productId, quantity: String(Number(quantities[line.productId])) })));
  const overLimit = $derived(loanLines.some((line) => Number(quantities[line.productId] || 0) > Number(line.remaining)));
  const unitOf = (id: string) => products.find((row) => row.id === id)?.baseUnit ?? '';

  $effect(() => {
    if (!open) return;
    untrack(() => {
      tab = 'SLIP';
      chosen = null;
      note = '';
      error = '';
      free = { borrowerId: '', warehouseId: active[0]?.id ?? '', note: '' };
      lines = [{ productId: '', quantity: '' }];
      loansLoading = true;
      void api<{ rows: LoanRow[] }>('/sales-orders?loan=OUT&page=1&pageSize=200')
        .then((result) => (loans = result.rows))
        .catch(() => (loans = []))
        .finally(() => (loansLoading = false));
      if (!employees.length) void api<Employee[]>('/employees').then((rows) => (employees = rows)).catch(() => undefined);
      if (!products.length) void api<ProductOption[]>('/products?status=ACTIVE').then((rows) => (products = rows)).catch(() => undefined);
    });
  });

  async function choose(id: string) {
    error = '';
    try {
      chosen = await api<LoanOrder>(`/sales-orders/${id}`);
      quantities = Object.fromEntries((chosen.loanLines ?? []).map((line) => [line.productId, Number(line.remaining) > 0 ? String(Number(line.remaining)) : '']));
    } catch (caught) {
      error = caught instanceof Error ? caught.message : m.khong_the_hoan_tat_thao_tac();
    }
  }

  async function submit(event: SubmitEvent) {
    event.preventDefault();
    error = '';
    saving = true;
    try {
      if (tab === 'SLIP') {
        if (!chosen || !returnLines.length || overLimit) return;
        const result = await api<{ returnCode: string }>(`/sales-orders/${chosen.id}/loan-returns`, {
          method: 'POST', idempotentCommand: true,
          body: JSON.stringify({ version: chosen.version, lines: returnLines, ...(note.trim() ? { note: note.trim() } : {}) }),
        });
        open = false;
        onsaved?.(result.returnCode);
      } else {
        const filled = lines.filter((line) => line.productId && Number(line.quantity) > 0);
        if (!free.borrowerId || !free.warehouseId || !filled.length || free.note.trim().length < 5) {
          error = m.smp_thieu_thong_tin();
          return;
        }
        const result = await api<{ code: string }>('/inventory/returns/samples', {
          method: 'POST', idempotentCommand: true,
          body: JSON.stringify({ borrowerId: free.borrowerId, warehouseId: free.warehouseId, note: free.note.trim(), lines: filled }),
        });
        open = false;
        onsaved?.(result.code);
      }
    } catch (caught) {
      error = caught instanceof Error ? caught.message : m.khong_the_hoan_tat_thao_tac();
    } finally {
      saving = false;
    }
  }
</script>

<Dialog bind:open title={m.smp_tieu_de()} wide>
  <form id="sample-return-form" class="form" onsubmit={submit} novalidate>
    <div class="segmented" role="tablist">
      <button type="button" role="tab" aria-selected={tab === 'SLIP'} class:active={tab === 'SLIP'} onclick={() => (tab = 'SLIP')}>{m.smp_theo_phieu()}</button>
      <button type="button" role="tab" aria-selected={tab === 'NOSLIP'} class:active={tab === 'NOSLIP'} onclick={() => (tab = 'NOSLIP')}>{m.smp_khong_phieu()}</button>
    </div>
    {#if error}<div class="banner error"><CircleAlert size={17} /><span>{error}</span></div>{/if}

    {#if tab === 'SLIP'}
      {#if !chosen}
        <p class="note">{m.smp_chon_phieu()}</p>
        <div class="table-wrap">
          <table class="table compact">
            <thead><tr><th>{m.chung_tu()}</th><th>{m.smp_nguoi_muon()}</th><th>{m.lp_hen_tra()}</th><th></th></tr></thead>
            <tbody>
              {#if loansLoading}<tr class="empty-row"><td colspan="4">{m.dang_tai()}</td></tr>
              {:else}
                {#each loans as row (row.id)}
                  {@const age = loanAge(row)}
                  <tr>
                    <td><span class="code">{row.code}</span><small>{slipTypeShort(row.purpose === 'INSPECTION' ? 'INSPECTION' : 'SAMPLE')}{row.shippedAt ? ` · ${date(row.shippedAt)}` : ''}</small></td>
                    <td>{row.salesRepName ?? '—'}{#if row.destination}<small>→ {row.destination}</small>{/if}</td>
                    <td>{row.expectedReturnDate ? date(`${row.expectedReturnDate}T12:00:00+07:00`) : '—'}<small class:overdue={age.overdue > 0}>{age.overdue > 0 ? m.lp_qua_hen({ days: age.overdue }) : m.lp_da_muon_ngay({ days: age.days })}</small></td>
                    <td class="num"><button type="button" class="btn small soft" onclick={() => choose(row.id)}>{m.smp_chon()}</button></td>
                  </tr>
                {:else}<tr class="empty-row"><td colspan="4">{m.smp_khong_co_phieu_dang_muon()}</td></tr>{/each}
              {/if}
            </tbody>
          </table>
        </div>
      {:else}
        <div class="chosen"><b class="code">{chosen.code}</b><button type="button" class="link-btn" onclick={() => (chosen = null)}>{m.smp_doi_phieu()}</button><a class="link" href={`/sales/orders/${chosen.id}`}>{m.smp_xem_phieu()}</a></div>
        <div class="table-wrap">
          <table class="table compact">
            <thead><tr><th>{m.ten_san_pham()}</th><th class="num">{m.smp_con_ngoai()}</th><th class="qty">{m.smp_so_ve()}</th></tr></thead>
            <tbody>
              {#each loanLines as line (line.productId)}
                <tr>
                  <td><span class="code">{line.sku}</span><small>{line.productName}</small></td>
                  <td class="num">{num(line.remaining)} {line.unit}</td>
                  <td class="qty"><NumberInput class="input" decimals={4} aria-label={`${m.smp_so_ve()} ${line.sku}`} bind:value={quantities[line.productId]} /></td>
                </tr>
              {/each}
            </tbody>
          </table>
        </div>
        {#if overLimit}<p class="err">{m.smp_vuot()}</p>{/if}
        <div class="field"><label for="smp-note">{m.ghi_chu()}</label><input id="smp-note" bind:value={note} maxlength="300" /></div>
      {/if}
    {:else}
      <p class="note">{m.smp_giai_thich_khong_phieu()}</p>
      <div class="grid">
        <div class="field"><label for="smp-borrower">{m.smp_nguoi_muon()} <span class="req">*</span></label>
          <select id="smp-borrower" bind:value={free.borrowerId}><option value="">—</option>{#each employees as row (row.id)}<option value={row.id}>{row.name} ({row.code})</option>{/each}</select>
        </div>
        <div class="field"><label for="smp-warehouse">{m.inv_nhap_vao_kho()} <span class="req">*</span></label>
          <select id="smp-warehouse" bind:value={free.warehouseId}>{#each active as row (row.id)}<option value={row.id}>{row.name}</option>{/each}</select>
        </div>
        <div class="field span"><label for="smp-free-note">{m.ghi_chu()} <span class="req">*</span></label><input id="smp-free-note" bind:value={free.note} maxlength="500" placeholder={m.smp_ghi_chu_vi_du()} /></div>
      </div>
      <div class="lines">
        <table class="table">
          <thead><tr><th>{m.ten_san_pham()}</th><th class="qty">{m.so_luong()}</th><th></th></tr></thead>
          <tbody>
            {#each lines as line, index}
              <tr>
                <td>
                  <select class="input" aria-label={`${m.ten_san_pham()} ${index + 1}`} bind:value={line.productId}>
                    <option value="">—</option>
                    {#each products as product (product.id)}<option value={product.id}>{product.sku} — {product.name}</option>{/each}
                  </select>
                </td>
                <td class="qty"><span class="qty-box"><NumberInput class="input" decimals={4} aria-label={`${m.so_luong()} ${index + 1}`} bind:value={line.quantity} /><small>{unitOf(line.productId)}</small></span></td>
                <td><button type="button" class="icon-btn danger" aria-label={m.crud_xoa()} disabled={lines.length === 1} onclick={() => lines.splice(index, 1)}><X size={15} /></button></td>
              </tr>
            {/each}
          </tbody>
        </table>
        <button type="button" class="btn small" onclick={() => lines.push({ productId: '', quantity: '' })}><Plus size={15} />{m.crud_them_dong()}</button>
      </div>
    {/if}
  </form>
  {#snippet footer()}
    <button type="button" class="btn" onclick={() => (open = false)}>{m.huy()}</button>
    <button type="submit" class="btn primary" form="sample-return-form" disabled={saving || (tab === 'SLIP' && (!chosen || !returnLines.length || overLimit))}>{saving ? m.kh_dang_luu() : m.lp_nhap_lai_hang_mau()}</button>
  {/snippet}
</Dialog>

<style>
  .form { display: grid; gap: 14px; }
  .segmented { display: grid; grid-template-columns: 1fr 1fr; padding: 3px; border-radius: 8px; background: var(--surface-2, #eef2f6); }
  .segmented button { padding: 8px; border: 0; border-radius: 6px; background: transparent; color: var(--muted); font: inherit; font-weight: 600; cursor: pointer; }
  .segmented button.active { background: var(--surface); color: var(--navy); box-shadow: 0 1px 3px rgba(18, 59, 94, 0.15); }
  .note { margin: 0; color: var(--muted); font-size: 12.5px; }
  .err { margin: 0; color: var(--red); font-size: 13px; }
  .compact td, .compact th { padding: 6px 10px; }
  td small { display: block; color: var(--subtle); font-size: 11.5px; }
  small.overdue { color: var(--red); }
  .chosen { display: flex; flex-wrap: wrap; align-items: center; gap: 12px; }
  .link-btn { padding: 0; border: 0; background: none; color: var(--navy-2); font: inherit; font-size: 13px; text-decoration: underline; cursor: pointer; }
  .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 14px 16px; }
  .span { grid-column: 1 / -1; }
  .req { color: var(--red); }
  .lines { display: grid; gap: 10px; justify-items: start; }
  .lines table { width: 100%; }
  .lines td { padding: 6px 8px; }
  .qty { width: 170px; }
  .qty-box { display: flex; align-items: center; gap: 6px; }
  @media (max-width: 640px) { .grid { grid-template-columns: 1fr; } }
</style>
