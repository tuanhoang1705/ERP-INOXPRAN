<script lang="ts">
  /**
   * Sửa phiếu hàng mẫu / hàng kiểm định nhập lại (INV-RET-SAMPLE-EDIT-01, 12/11/2026) trên trang Phiếu trả hàng.
   * - Theo phiếu xuất mẫu: các mã của phiếu mẫu, số về tối đa = số còn ở ngoài + số của chính phiếu này; kho giữ theo phiếu mẫu.
   * - Không có phiếu xuất mẫu: đổi người mượn, kho, dòng hàng, ghi chú.
   * Bắt buộc ghi lý do sửa; thẻ kho được đảo và ghi lại ở máy chủ.
   */
  import type { StockReturn, Warehouse } from '@inoxpran/contracts';
  import { untrack } from 'svelte';
  import { CircleAlert, Plus, X } from 'lucide-svelte';
  import { m } from '$lib/paraglide/messages';
  import { api } from '$lib/api';
  import { num } from '$lib/format';
  import { loadStaff, staffPick, withCurrent, type StaffOption } from '$lib/staff';
  import Dialog from './Dialog.svelte';
  import NumberInput from './NumberInput.svelte';
  import ProductPicker from './ProductPicker.svelte';
  import StaffSelect from './StaffSelect.svelte';

  type LoanLine = { productId: string; sku: string; productName: string; unit: string; shipped: string; returned: string; remaining: string };
  type ProductOption = { id: string; sku: string; name: string; baseUnit: string };

  let { open = $bindable(false), target = null, warehouses = [], onsaved }: { open?: boolean; target?: StockReturn | null; warehouses?: Warehouse[]; onsaved?: (code: string) => void } = $props();

  const linked = $derived(Boolean(target?.salesOrderCode));
  let loading = $state(false);
  let loanLines = $state<Array<LoanLine & { max: number }>>([]);
  let quantities = $state<Record<string, string>>({});
  let staff = $state<StaffOption[]>([]);
  let products = $state<ProductOption[]>([]);
  let form = $state({ borrowerId: '', warehouseId: '', note: '', reason: '' });
  let lines = $state<Array<{ productId: string; quantity: string }>>([]);
  let error = $state('');
  let saving = $state(false);

  // Mọi kho đang hoạt động trừ kho hàng lỗi (WH-SAMPLE-02); kho đang ghi trên phiếu luôn giữ trong danh sách.
  const warehouseChoices = $derived.by(() => {
    const list = warehouses.filter((row) => row.active && row.purpose !== 'DEFECTIVE');
    const current = warehouses.find((row) => row.id === target?.warehouseId);
    return current && !list.some((row) => row.id === current.id) ? [current, ...list] : list;
  });
  const linkedLines = $derived(loanLines.filter((line) => Number(quantities[line.productId] || 0) > 0).map((line) => ({ productId: line.productId, quantity: String(Number(quantities[line.productId])) })));
  const overLimit = $derived(loanLines.some((line) => Number(quantities[line.productId] || 0) > line.max));
  const unitOf = (id: string) => products.find((row) => row.id === id)?.baseUnit ?? '';

  $effect(() => {
    if (!open || !target) return;
    const row = target;
    untrack(() => {
      error = '';
      form = { borrowerId: row.staffUserId ?? row.salesRepId ?? '', warehouseId: row.warehouseId, note: row.note, reason: '' };
      lines = row.lines.map((line) => ({ productId: line.productId, quantity: String(Number(line.quantity)) }));
      loanLines = [];
      quantities = {};
      if (row.salesOrderCode) {
        // Số còn ở ngoài của phiếu mẫu đã trừ chính phiếu này → cộng lại số của phiếu để ra số tối đa được nhập.
        const own = new Map(row.lines.map((line) => [line.productId, Number(line.quantity)]));
        loading = true;
        void (row.salesOrderId ? api<{ loanLines?: LoanLine[] }>(`/sales-orders/${row.salesOrderId}`) : Promise.resolve({ loanLines: [] as LoanLine[] }))
          .then((order) => {
            const fromLoan = (order.loanLines ?? []).map((line) => ({ ...line, max: Number(line.remaining) + (own.get(line.productId) ?? 0) })).filter((line) => line.max > 0);
            // Không đọc được phiếu mẫu (ngoài phạm vi kho…): vẫn cho sửa giảm trên các dòng đang có.
            loanLines = fromLoan.length ? fromLoan : row.lines.map((line) => ({ productId: line.productId, sku: line.sku, productName: line.productName, unit: line.unit, shipped: line.quantity, returned: line.quantity, remaining: '0', max: Number(line.quantity) }));
            quantities = Object.fromEntries(loanLines.map((line) => [line.productId, own.has(line.productId) ? String(own.get(line.productId)) : '']));
          })
          .catch((caught) => (error = caught instanceof Error ? caught.message : m.khong_the_hoan_tat_thao_tac()))
          .finally(() => (loading = false));
      } else {
        void loadStaff().then((rows) => (staff = withCurrent(rows, { salesRepId: row.salesRepId, staffUserId: row.staffUserId, salesRepName: row.borrowerName }))).catch(() => undefined);
        if (!products.length) void api<ProductOption[]>('/products?status=ACTIVE').then((rows) => (products = rows)).catch(() => undefined);
      }
    });
  });

  // Mã đã ngừng kinh doanh đang có trên phiếu vẫn hiện trong ô chọn.
  const productChoices = $derived.by(() => {
    const missing = (target?.lines ?? []).filter((line) => !products.some((row) => row.id === line.productId)).map((line) => ({ id: line.productId, sku: line.sku, name: line.productName, baseUnit: line.unit }));
    return [...missing, ...products];
  });

  async function submit(event: SubmitEvent) {
    event.preventDefault();
    if (!target) return;
    error = '';
    const filled = linked ? linkedLines : lines.filter((line) => line.productId && Number(line.quantity) > 0).map((line) => ({ productId: line.productId, quantity: String(Number(line.quantity)) }));
    if (!filled.length || form.note.trim().length < 3 || (!linked && (!form.borrowerId || !form.warehouseId))) {
      error = linked ? m.smp_sua_thieu() : m.smp_thieu_thong_tin();
      return;
    }
    if (form.reason.trim().length < 3) {
      error = m.inv_ly_do_toi_thieu();
      return;
    }
    if (linked && overLimit) return;
    const pick = staffPick(staff, form.borrowerId);
    saving = true;
    try {
      const saved = await api<{ code: string }>(`/inventory/returns/${target.id}/sample`, {
        method: 'PATCH', idempotentCommand: true,
        body: JSON.stringify({
          version: target.version ?? 0, reason: form.reason.trim(), note: form.note.trim(), lines: filled,
          ...(linked ? {} : { warehouseId: form.warehouseId, ...(pick.staffUserId ? { borrowerUserId: pick.staffUserId } : { borrowerId: pick.salesRepId }) }),
        }),
      });
      open = false;
      onsaved?.(saved.code);
    } catch (caught) {
      error = caught instanceof Error ? caught.message : m.khong_the_hoan_tat_thao_tac();
    } finally {
      saving = false;
    }
  }
</script>

<Dialog bind:open title={m.inv_sua_phieu_tra({ code: target?.code ?? '' })} wide>
  <form id="sample-edit-form" class="form" onsubmit={submit} oninput={() => (error = '')} novalidate>
    {#if error}<div class="banner error"><CircleAlert size={17} /><span>{error}</span></div>{/if}
    {#if linked}
      <p class="note">{m.smp_sua_theo_phieu({ code: target?.salesOrderCode ?? '' })}</p>
      <div class="table-wrap">
        <table class="table compact">
          <thead><tr><th>{m.ten_san_pham()}</th><th class="num">{m.smp_toi_da()}</th><th class="qty">{m.smp_so_ve()}</th></tr></thead>
          <tbody>
            {#if loading}<tr class="empty-row"><td colspan="3">{m.dang_tai()}</td></tr>
            {:else}
              {#each loanLines as line (line.productId)}
                <tr>
                  <td><span class="code">{line.sku}</span><small>{line.productName}</small></td>
                  <td class="num">{num(String(line.max))} {line.unit}</td>
                  <td class="qty"><NumberInput class="input" decimals={4} aria-label={`${m.smp_so_ve()} ${line.sku}`} bind:value={quantities[line.productId]} /></td>
                </tr>
              {/each}
            {/if}
          </tbody>
        </table>
      </div>
      {#if overLimit}<p class="err">{m.smp_vuot()}</p>{/if}
    {:else}
      <div class="grid">
        <div class="field"><label for="sme-borrower">{m.smp_nguoi_muon()} <span class="req">*</span></label>
          <StaffSelect id="sme-borrower" bind:value={form.borrowerId} options={staff} />
        </div>
        <div class="field"><label for="sme-warehouse">{m.inv_nhap_vao_kho()} <span class="req">*</span></label>
          <select id="sme-warehouse" bind:value={form.warehouseId}>{#each warehouseChoices as row (row.id)}<option value={row.id}>{row.name}</option>{/each}</select>
        </div>
      </div>
      <div class="lines">
        <table class="table">
          <thead><tr><th>{m.ten_san_pham()}</th><th class="qty">{m.so_luong()}</th><th></th></tr></thead>
          <tbody>
            {#each lines as line, index}
              <tr>
                <td class="product">
                  <ProductPicker id={`sme-product-${index + 1}`} label={`${m.ten_san_pham()} ${index + 1}`} products={productChoices} value={line.productId} onchoose={(id) => (line.productId = id)} loading={!products.length} />
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
    <div class="field"><label for="sme-note">{m.ghi_chu()} <span class="req">*</span></label><input id="sme-note" bind:value={form.note} maxlength="500" /></div>
    <div class="field">
      <label for="sme-reason">{m.inv_ly_do_sua()} <span class="req">*</span></label>
      <input id="sme-reason" bind:value={form.reason} maxlength="300" placeholder={m.inv_ly_do_sua_goi_y()} />
    </div>
  </form>
  {#snippet footer()}
    <button type="button" class="btn" onclick={() => (open = false)}>{m.huy()}</button>
    <button type="submit" class="btn primary" form="sample-edit-form" disabled={saving || loading || (linked && overLimit)}>{saving ? m.kh_dang_luu() : m.crud_luu()}</button>
  {/snippet}
</Dialog>

<style>
  .form { display: grid; gap: 14px; }
  .note { margin: 0; color: var(--muted); font-size: 12.5px; }
  .err { margin: 0; color: var(--red); font-size: 13px; }
  .compact td, .compact th { padding: 6px 10px; }
  td small { display: block; color: var(--subtle); font-size: 11.5px; }
  .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 14px 16px; }
  .req { color: var(--red); }
  .lines { display: grid; gap: 10px; justify-items: start; }
  .lines table { width: 100%; }
  .lines td { padding: 6px 8px; }
  .product { min-width: 220px; }
  .qty { width: 170px; }
  .qty-box { display: flex; align-items: center; gap: 6px; }
  @media (max-width: 640px) {
    .grid { grid-template-columns: 1fr; }
    .qty { width: 118px; }
    .product { min-width: 140px; }
  }
</style>
