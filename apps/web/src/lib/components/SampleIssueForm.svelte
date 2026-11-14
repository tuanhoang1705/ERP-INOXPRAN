<script lang="ts">
  /**
   * Phiếu xuất hàng mẫu do thủ kho lập (SWK-M — SAMPLE-ISSUE-01, 12/11/2026): không qua phiếu BH / 5 bước, lưu là xuất kho ngay.
   * Dùng cho cả lập mới và sửa phiếu đã xuất (bắt buộc lý do; kho không đổi; chênh lệch số lượng tự ghi thẻ kho).
   * "Gửi tới" vừa gõ tự do vừa chọn khách hàng; chọn khách thì tự điền địa chỉ.
   */
  import type { InventoryBalance, Product, SalesOrder, Warehouse } from '@inoxpran/contracts';
  import { onMount, untrack } from 'svelte';
  import { goto } from '$app/navigation';
  import { CircleAlert, Plus, X } from 'lucide-svelte';
  import { m } from '$lib/paraglide/messages';
  import { api } from '$lib/api';
  import { num } from '$lib/format';
  import { loadStaff, staffPick, withCurrent, type StaffOption } from '$lib/staff';
  import { defaultReturnDate, warehouseFitsSlip } from '$shared/sales-purpose';
  import NumberInput from './NumberInput.svelte';
  import ProductPicker from './ProductPicker.svelte';
  import StaffSelect from './StaffSelect.svelte';
  import SuggestInput, { type Suggestion } from './SuggestInput.svelte';

  type Customer = { id: string; code: string; name: string; phone?: string; address?: string; status?: string };
  type Line = { productId: string; quantity: string };

  let { existing = null }: { existing?: SalesOrder | null } = $props();

  let warehouses = $state<Warehouse[]>([]);
  let products = $state<Product[]>([]);
  let balances = $state<InventoryBalance[]>([]);
  let staff = $state<StaffOption[]>([]);
  let customers = $state<Customer[]>([]);
  let customersLoaded = $state(false);
  let warehouseId = $state('');
  let borrowerId = $state('');
  let destination = $state('');
  let recipientAddress = $state('');
  let autoAddress = '';
  /** Ngày hôm nay theo giờ Việt Nam (yyyy-mm-dd). */
  const todayVn = () => new Date(Date.now() + 7 * 3_600_000).toISOString().slice(0, 10);
  let expectedReturnDate = $state(defaultReturnDate(todayVn()));
  let note = $state('');
  let reason = $state('');
  let lines = $state<Line[]>([{ productId: '', quantity: '1' }]);
  let loadingStock = $state(false);
  let saving = $state(false);
  let error = $state('');

  const warehouseChoices = $derived(warehouses.filter((row) => (existing && row.id === existing.warehouseId) || (row.active && warehouseFitsSlip(row.purpose))));
  const recipientOptions = $derived.by(() => {
    const seen = new Set<string>();
    const options: Suggestion[] = [];
    for (const row of customers) {
      if (seen.has(row.name)) continue;
      seen.add(row.name);
      options.push({ value: row.name, detail: [row.code, row.phone].filter(Boolean).join(' · ') });
    }
    return options;
  });
  const recipient = $derived(destination.trim() ? customers.find((row) => row.name === destination.trim()) : undefined);
  $effect(() => {
    const address = recipient?.address ?? '';
    untrack(() => {
      if (address && (!recipientAddress.trim() || recipientAddress === autoAddress)) recipientAddress = address;
      autoAddress = address;
    });
  });
  const productFor = (id: string) => products.find((row) => row.id === id) ?? existingLine(id);
  /** Mã đã ngừng kinh doanh đang có trên phiếu vẫn hiện tên / đơn vị. */
  const existingLine = (id: string) => {
    const line = existing?.lines.find((row) => row.productId === id);
    return line ? ({ id, sku: line.sku, name: line.productName, baseUnit: line.unit } as unknown as Product) : undefined;
  };
  const productChoices = $derived.by(() => {
    const missing = (existing?.lines ?? []).filter((line) => !products.some((row) => row.id === line.productId)).map((line) => ({ id: line.productId, sku: line.sku, name: line.productName, baseUnit: line.unit }));
    return [...missing, ...products];
  });
  /** Khi sửa: tồn khả dụng cộng lại số phiếu này đã xuất. */
  const ownQuantity = (id: string) => (existing?.lines ?? []).filter((line) => line.productId === id).reduce((sum, line) => sum + Number(line.baseQuantity ?? line.quantity), 0);
  const availableOf = (id: string) => Number(balances.find((row) => row.productId === id)?.available ?? 0) + ownQuantity(id);
  const filled = $derived(lines.filter((line) => line.productId && Number(line.quantity) > 0));
  const overStock = $derived(filled.some((line) => Number(line.quantity) > availableOf(line.productId)));
  const totalQuantity = $derived(filled.reduce((sum, line) => sum + Number(line.quantity), 0));
  const ready = $derived(Boolean(warehouseId && borrowerId && filled.length && filled.length === lines.length && !overStock && (!existing || reason.trim().length >= 3)));

  onMount(async () => {
    try {
      const [warehouseRows, productRows, staffRows] = await Promise.all([api<Warehouse[]>('/warehouses'), api<Product[]>('/products?status=ACTIVE'), loadStaff()]);
      warehouses = warehouseRows;
      products = productRows;
      staff = existing ? withCurrent(staffRows, existing) : staffRows;
      if (existing) {
        warehouseId = existing.warehouseId;
        borrowerId = existing.staffUserId ?? existing.salesRepId ?? '';
        destination = existing.destination ?? '';
        recipientAddress = existing.recipientAddress ?? '';
        expectedReturnDate = existing.expectedReturnDate ?? '';
        note = existing.note ?? '';
        lines = existing.lines.map((line) => ({ productId: line.productId, quantity: String(Number(line.baseQuantity ?? line.quantity)) }));
      } else {
        // Kho mẫu (nếu có) là kho mặc định của phiếu xuất hàng mẫu; vẫn chọn được kho khác (WH-SAMPLE-02).
        warehouseId = (warehouseChoices.find((row) => row.purpose === 'SAMPLE') ?? warehouseChoices[0])?.id ?? '';
      }
      await loadStock();
    } catch (caught) {
      error = caught instanceof Error ? caught.message : m.khong_tai_duoc_du_lieu_danh();
    }
    void api<{ rows: Customer[] }>('/dealers?stage=CUSTOMER')
      .then((result) => (customers = result.rows.filter((row) => row.status !== 'INACTIVE')))
      .catch(() => undefined)
      .finally(() => (customersLoaded = true));
  });

  async function loadStock() {
    balances = [];
    if (!warehouseId) return;
    loadingStock = true;
    try {
      balances = await api<InventoryBalance[]>(`/inventory/balances?warehouseId=${warehouseId}`);
    } catch (caught) {
      error = caught instanceof Error ? caught.message : m.khong_doc_duoc_ton_kha_dung();
    } finally {
      loadingStock = false;
    }
  }

  async function submit(event: SubmitEvent) {
    event.preventDefault();
    if (!ready || saving) return;
    saving = true;
    error = '';
    try {
      const body = {
        warehouseId,
        ...staffPick(staff, borrowerId),
        ...(destination.trim() ? { destination: destination.trim() } : {}),
        ...(recipientAddress.trim() ? { recipientAddress: recipientAddress.trim() } : {}),
        ...(recipient ? { recipientCustomerId: recipient.id } : {}),
        ...(expectedReturnDate ? { expectedReturnDate } : {}),
        ...(note.trim() ? { note: note.trim() } : {}),
        lines: filled.map((line) => ({ productId: line.productId, unit: productFor(line.productId)?.baseUnit ?? '', quantity: String(Number(line.quantity)) })),
      };
      const saved = existing
        ? await api<{ id: string; code: string }>(`/sample-issues/${existing.id}`, { method: 'PATCH', idempotentCommand: true, body: JSON.stringify({ ...body, version: existing.version, reason: reason.trim() }) })
        : await api<{ id: string; code: string }>('/sample-issues', { method: 'POST', idempotentCommand: true, body: JSON.stringify(body) });
      await goto(`/inventory/sample-issues/${saved.id}?${existing ? 'saved' : 'created'}=1`);
    } catch (caught) {
      error = caught instanceof Error ? caught.message : m.khong_the_hoan_tat_thao_tac();
    } finally {
      saving = false;
    }
  }
</script>

<form id="sample-issue-form" onsubmit={submit} oninput={() => (error = '')} novalidate>
  {#if error}<div class="banner error"><CircleAlert size={17} /><span>{error}</span></div>{/if}
  <section class="card block">
    <header class="card-head"><h2>{m.lp_thong_tin_nguoi_muon()}</h2></header>
    <div class="grid">
      <div class="field">
        <label for="si-warehouse">{m.kho_xuat()} <span class="req">*</span></label>
        <select id="si-warehouse" bind:value={warehouseId} onchange={loadStock} disabled={Boolean(existing)} title={existing ? m.root_khong_doi_kho() : ''}>
          {#each warehouseChoices as row (row.id)}<option value={row.id}>{row.code} — {row.name}</option>{/each}
        </select>
      </div>
      <div class="field">
        <label for="si-borrower">{m.lp_nguoi_muon()} <span class="req">*</span></label>
        <StaffSelect id="si-borrower" bind:value={borrowerId} options={staff} missing={!borrowerId} placeholder={m.lp_chon_nguoi_muon()} />
      </div>
      <div class="field">
        <label for="si-destination">{m.lp_gui_toi()}</label>
        <SuggestInput id="si-destination" bind:value={destination} options={recipientOptions} maxlength={200} placeholder={m.xm_gui_toi_goi_y()} toggleLabel={m.kh_mo_danh_sach()} loading={!customersLoaded} />
      </div>
      <div class="field">
        <label for="si-return">{m.lp_hen_tra()}</label>
        <input id="si-return" type="date" min={todayVn()} bind:value={expectedReturnDate} />
      </div>
      <div class="field span">
        <label for="si-address">{m.dia_chi()}</label>
        <input id="si-address" bind:value={recipientAddress} maxlength="300" placeholder={m.xm_dia_chi_goi_y()} />
      </div>
    </div>
  </section>

  <section class="card block">
    <header class="card-head head"><h2>{m.xm_hang_mau()}</h2><button type="button" class="btn soft small" onclick={() => lines.push({ productId: '', quantity: '1' })}><Plus size={15} />{m.them_dong()}</button></header>
    <div class="table-wrap">
      <table class="table">
        <thead><tr><th>{m.san_pham()}</th><th class="num">{m.kha_dung()}</th><th class="num">{m.so_luong()}</th><th></th></tr></thead>
        <tbody>
          {#each lines as line, index}
            {@const product = productFor(line.productId)}
            <tr>
              <td class="product"><ProductPicker id={`si-product-${index + 1}`} label={m.san_pham_dong({ p0: index + 1 })} products={productChoices} value={line.productId} onchoose={(id) => (line.productId = id)} loading={!products.length} /></td>
              <td class="num" class:bad={Boolean(product) && Number(line.quantity) > availableOf(line.productId)}>{product ? `${num(String(availableOf(line.productId)))} ${product.baseUnit.toLowerCase()}` : ''}</td>
              <td class="num"><NumberInput class="input qty" decimals={4} aria-label={m.so_luong_dong({ p0: index + 1 })} bind:value={line.quantity} /></td>
              <td><button type="button" class="remove" disabled={lines.length === 1} onclick={() => lines.splice(index, 1)} aria-label={m.xoa_dong({ p0: index + 1 })}><X size={14} /></button></td>
            </tr>
          {/each}
        </tbody>
        <tfoot><tr><td colspan="2"><b>{m.lp_tong_so_luong()}</b></td><td class="num"><b>{num(String(totalQuantity))}</b></td><td></td></tr></tfoot>
      </table>
    </div>
    {#if overStock}<p class="warn">{m.xm_vuot_ton()}</p>{/if}
    {#if loadingStock}<p class="hint pad">{m.dang_doc_ton_kha_dung()}</p>{/if}
    <div class="grid">
      <div class="field span"><label for="si-note">{m.ghi_chu()}</label><input id="si-note" bind:value={note} maxlength="500" placeholder={m.khong_bat_buoc()} /></div>
      {#if existing}
        <div class="field span"><label for="si-reason">{m.inv_ly_do_sua()} <span class="req">*</span></label><input id="si-reason" bind:value={reason} maxlength="300" placeholder={m.inv_ly_do_sua_goi_y()} /></div>
      {/if}
    </div>
  </section>
  <p class="hint">{existing ? m.xm_luu_sua_ghi_chu() : m.xm_luu_ghi_chu()}</p>
  <div class="actions end">
    <a class="btn" href={existing ? `/inventory/sample-issues/${existing.id}` : '/inventory/sample-issues'}>{m.huy()}</a>
    <button type="submit" class="btn primary" disabled={!ready || saving}>{saving ? m.dang_ghi_so() : existing ? m.crud_luu() : m.xm_luu_va_xuat()}</button>
  </div>
</form>

<style>
  .block { margin-bottom: 18px; }
  .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 14px 16px; padding: 16px 20px 20px; }
  .span { grid-column: 1 / -1; }
  .head { padding-bottom: 14px; }
  .req { color: var(--red); }
  .product { min-width: 300px; }
  td :global(.qty) { width: 110px; text-align: center; }
  .bad { color: var(--red); font-weight: 700; }
  .warn { margin: 10px 20px 0; color: var(--red); font-size: 13px; }
  .pad { padding: 0 20px; }
  .hint { color: var(--subtle); font-size: 12.5px; }
  .remove { display: grid; width: 26px; height: 26px; place-items: center; border-radius: 50%; background: var(--red-soft); color: var(--red); }
  .remove:disabled { opacity: 0.35; }
  .end { display: flex; justify-content: flex-end; gap: 10px; margin-top: 12px; }
  @media (max-width: 760px) {
    .grid { grid-template-columns: 1fr; }
    .product { min-width: 150px; }
    td :global(.qty) { width: 84px; }
  }
</style>
