<script lang="ts">
  /**
   * Phiếu trả hàng (POST /inventory/returns):
   * - Khách trả (nhập kho): hàng bán chậm, hàng tặng / combo trả lại, hàng lỗi nhập khẩu, hàng lỗi do sử dụng.
   *   Hàng lỗi mặc định nhập kho hàng lỗi. Ghi số phiếu BH gốc thì máy chủ kiểm tra mã hàng và số lượng còn được trả.
   * - Trả nhà máy (xuất kho): chặn xuất quá tồn khả dụng; ghi số đơn mua gốc thì không trả quá số đã nhận.
   * Chỉ ghi kho; điều chỉnh công nợ / hóa đơn do kế toán xử lý riêng.
   */
  import type { Warehouse } from '@inoxpran/contracts';
  import { untrack } from 'svelte';
  import { CircleAlert, Plus, X } from 'lucide-svelte';
  import { m } from '$lib/paraglide/messages';
  import { api, ApiRequestError } from '$lib/api';
  import { categoryLabel } from '$lib/inventory';
  import { CUSTOMER_RETURN_CATEGORIES, DEFECT_RETURN_CATEGORIES, type CustomerReturnCategory } from '$shared/inventory-categories';
  import Dialog from './Dialog.svelte';
  import NumberInput from './NumberInput.svelte';
  import CustomerPicker from './CustomerPicker.svelte';
  import type { CustomerOption } from '$lib/customer-search';

  type Kind = 'CUSTOMER' | 'SUPPLIER';
  type ProductOption = { id: string; sku: string; name: string; baseUnit: string };
  type PartnerOption = CustomerOption;
  type Line = { productId: string; quantity: string };

  let { open = $bindable(false), kind = 'CUSTOMER', warehouses = [], onsaved }: {
    open?: boolean;
    kind?: Kind;
    warehouses?: Warehouse[];
    onsaved?: (code: string) => void;
  } = $props();

  let products = $state<ProductOption[]>([]);
  let partners = $state<PartnerOption[]>([]);
  let partnersLoading = $state(false);
  let form = $state({ partnerId: '', category: 'SLOW_RETURN_IN' as CustomerReturnCategory, warehouseId: '', sourceCode: '', note: '' });
  let lines = $state<Line[]>([]);
  let errors = $state<Record<string, string>>({});
  let error = $state('');
  let saving = $state(false);
  const customer = $derived(kind === 'CUSTOMER');
  const active = $derived(warehouses.filter((row) => row.active));

  function defaultWarehouse(category: CustomerReturnCategory | null) {
    const defect = category !== null && DEFECT_RETURN_CATEGORIES.includes(category);
    return (defect ? active.find((row) => row.purpose === 'DEFECTIVE') : undefined)?.id ?? active.find((row) => row.purpose !== 'DEFECTIVE')?.id ?? active[0]?.id ?? '';
  }

  $effect(() => {
    if (!open) return;
    untrack(() => {
      form = { partnerId: '', category: 'SLOW_RETURN_IN', warehouseId: defaultWarehouse(customer ? 'SLOW_RETURN_IN' : null), sourceCode: '', note: '' };
      lines = [{ productId: '', quantity: '' }];
      errors = {};
      error = '';
      partners = [];
      partnersLoading = true;
      // Khách: toàn bộ khách chính thức (như ô Người mua của phiếu BH, kèm SĐT / tỉnh); NCC: danh mục nhà cung cấp.
      const source = customer
        ? api<{ rows: PartnerOption[] }>('/dealers?stage=CUSTOMER').then((result) => result.rows)
        : api<PartnerOption[]>(`/partners?kind=${kind}`);
      void source
        .then((rows) => (partners = rows.filter((row) => row.status !== 'INACTIVE')))
        .catch(() => undefined)
        .finally(() => (partnersLoading = false));
      if (!products.length) void api<ProductOption[]>('/products?status=ACTIVE').then((rows) => (products = rows)).catch(() => undefined);
    });
  });

  const unitOf = (id: string) => products.find((row) => row.id === id)?.baseUnit ?? '';

  async function submit(event: SubmitEvent) {
    event.preventDefault();
    errors = {};
    error = '';
    const filled = lines.filter((line) => line.productId && line.quantity);
    if (!form.partnerId) errors.partnerId = m.kh_bat_buoc_chon();
    if (!form.warehouseId) errors.warehouseId = m.kh_bat_buoc_chon();
    if (form.note.trim().length < 3) errors.note = m.inv_ghi_chu_toi_thieu();
    if (!filled.length || filled.some((line) => !(Number(line.quantity) > 0))) errors.lines = m.inv_can_dong_hang();
    if (Object.keys(errors).length) return;
    saving = true;
    try {
      const source = form.sourceCode.trim().toUpperCase();
      const saved = await api<{ code: string }>('/inventory/returns', {
        method: 'POST',
        idempotentCommand: true,
        body: JSON.stringify({
          kind,
          partnerId: form.partnerId,
          warehouseId: form.warehouseId,
          note: form.note.trim(),
          lines: filled,
          ...(customer ? { category: form.category, ...(source ? { salesOrderCode: source } : {}) } : source ? { purchaseOrderCode: source } : {}),
        }),
      });
      open = false;
      onsaved?.(saved.code);
    } catch (caught) {
      if (caught instanceof ApiRequestError) {
        const details = Array.isArray(caught.payload.details) ? (caught.payload.details as Array<{ path?: unknown[] }>) : [];
        for (const issue of details) {
          const key = issue.path?.[0];
          if (typeof key === 'string') errors[key === 'salesOrderCode' || key === 'purchaseOrderCode' ? 'sourceCode' : key] ??= caught.message;
        }
      }
      error = caught instanceof Error ? caught.message : m.crud_loi_luu();
    } finally {
      saving = false;
    }
  }
</script>

<Dialog bind:open title={customer ? m.inv_khach_tra_hang() : m.inv_tra_nha_may()} wide>
  <form id="stock-return-form" class="grid" onsubmit={submit} novalidate>
    {#if error}<div class="banner error span"><CircleAlert size={17} /><span>{error}</span></div>{/if}
    <div class="field">
      <label for="sr-partner">{customer ? m.khach_hang() : m.nha_cung_cap()} <span class="req">*</span></label>
      <CustomerPicker id="sr-partner" options={partners} value={form.partnerId} loading={partnersLoading} invalid={Boolean(errors.partnerId)}
        placeholder={customer ? m.kh_tim_nguoi_mua() : m.kh_tim_ncc()} emptyText={customer ? m.kh_khong_tim_thay_khach() : m.kh_khong_tim_thay_ncc()}
        onchoose={(id) => { form.partnerId = id; errors.partnerId = ''; }} />
      {#if errors.partnerId}<span class="error">{errors.partnerId}</span>{/if}
    </div>
    {#if customer}
      <div class="field">
        <label for="sr-category">{m.inv_loai_tra()} <span class="req">*</span></label>
        <select id="sr-category" bind:value={form.category} onchange={() => (form.warehouseId = defaultWarehouse(form.category))}>
          {#each CUSTOMER_RETURN_CATEGORIES as code}<option value={code}>{categoryLabel(code)}</option>{/each}
        </select>
      </div>
    {/if}
    <div class="field">
      <label for="sr-warehouse">{customer ? m.inv_nhap_vao_kho() : m.inv_xuat_tu_kho()} <span class="req">*</span></label>
      <select id="sr-warehouse" bind:value={form.warehouseId} aria-invalid={Boolean(errors.warehouseId)}>
        {#each active as row (row.id)}<option value={row.id}>{row.name}</option>{/each}
      </select>
      {#if errors.warehouseId}<span class="error">{errors.warehouseId}</span>{:else if customer && DEFECT_RETURN_CATEGORIES.includes(form.category)}<span class="hint">{m.inv_hang_loi_goi_y()}</span>{/if}
    </div>
    <div class="field">
      <label for="sr-source">{customer ? m.inv_so_phieu_bh_goc() : m.inv_so_don_mua_goc()}</label>
      <input id="sr-source" value={form.sourceCode} maxlength="40" autocomplete="off" placeholder={customer ? 'BH2026100001' : 'PO2610-00001'} aria-invalid={Boolean(errors.sourceCode)}
        oninput={(event) => (form.sourceCode = event.currentTarget.value.toUpperCase())} />
      {#if errors.sourceCode}<span class="error">{errors.sourceCode}</span>{:else}<span class="hint">{customer ? m.inv_so_phieu_bh_goi_y() : m.inv_so_don_mua_goi_y()}</span>{/if}
    </div>
    <div class="field span">
      <label for="sr-note">{m.ghi_chu()} <span class="req">*</span></label>
      <input id="sr-note" bind:value={form.note} maxlength="500" placeholder={customer ? m.inv_ghi_chu_khach_tra() : m.inv_ghi_chu_tra_nha_may()} aria-invalid={Boolean(errors.note)} />
      {#if errors.note}<span class="error">{errors.note}</span>{/if}
    </div>
    <div class="span lines">
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
      {#if errors.lines}<span class="error">{errors.lines}</span>{/if}
      <button type="button" class="btn small" onclick={() => lines.push({ productId: '', quantity: '' })}><Plus size={15} />{m.crud_them_dong()}</button>
    </div>
    <p class="note span">{customer ? m.inv_khach_tra_ghi_chu() : m.inv_tra_nha_may_ghi_chu()}</p>
    {#if customer}<p class="note span hint-sample">{m.smp_goi_y_khach_tra()}</p>{/if}
  </form>
  {#snippet footer()}
    <button type="button" class="btn" onclick={() => (open = false)}>{m.huy()}</button>
    <button type="submit" class="btn primary" form="stock-return-form" disabled={saving}>{saving ? m.kh_dang_luu() : m.inv_ghi_phieu()}</button>
  {/snippet}
</Dialog>

<style>
  .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 14px 16px; align-items: start; }
  .span { grid-column: 1 / -1; }
  .req { color: var(--red); }
  .lines { display: grid; gap: 10px; justify-items: start; }
  .lines table { width: 100%; }
  .lines td { padding: 6px 8px; }
  .qty { width: 170px; }
  .qty-box { display: flex; align-items: center; gap: 6px; }
  .note { margin: 0; color: var(--muted); font-size: 12.5px; }
  .hint-sample { color: var(--navy-2); }
  @media (max-width: 640px) { .grid { grid-template-columns: 1fr; } }
</style>
