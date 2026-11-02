<script lang="ts">
  /**
   * Phiếu nhập kho đã ghi của một đơn mua / một lô hàng nhập + sửa số thực nhận / vị trí (PATCH /goods-receipts/:id — 20/10/2026).
   * Máy chủ ghi dòng chênh lệch trên thẻ kho vào ngày phiếu gốc, cập nhật số đã nhận của đơn mua, lô hàng và giá vốn bình quân.
   */
  import type { GoodsReceiptView } from '@inoxpran/contracts';
  import { CircleAlert, Pencil } from 'lucide-svelte';
  import { m } from '$lib/paraglide/messages';
  import { api } from '$lib/api';
  import { dateTime, num } from '$lib/format';
  import Dialog from './Dialog.svelte';
  import NumberInput from './NumberInput.svelte';

  let { purchaseOrderId, importShipmentId, canEdit = false, reload = 0, onchanged }: {
    purchaseOrderId?: string;
    importShipmentId?: string;
    canEdit?: boolean;
    /** Tăng lên để tải lại (VD sau khi lập phiếu nhập mới). */
    reload?: number;
    onchanged?: (code: string) => void;
  } = $props();

  let rows = $state<GoodsReceiptView[]>([]);
  let loading = $state(true);
  let error = $state('');
  let target = $state<GoodsReceiptView | null>(null);
  let open = $state(false);
  let draft = $state<Array<{ productId: string; sku: string; productName: string; unit: string; quantity: string; locationCode: string; max: number }>>([]);
  let reason = $state('');
  let formError = $state('');
  let saving = $state(false);

  async function load() {
    loading = true;
    error = '';
    try {
      const query = new URLSearchParams(purchaseOrderId ? { purchaseOrderId } : { importShipmentId: importShipmentId ?? '' });
      rows = await api<GoodsReceiptView[]>(`/goods-receipts?${query}`);
    } catch (caught) {
      error = caught instanceof Error ? caught.message : m.rw_loi_tai();
    } finally {
      loading = false;
    }
  }
  $effect(() => {
    void reload;
    void purchaseOrderId;
    void importShipmentId;
    void load();
  });

  function edit(row: GoodsReceiptView) {
    target = row;
    reason = '';
    formError = '';
    draft = row.lines.map((line) => {
      const order = row.orderLines.find((item) => item.productId === line.productId);
      // Tối đa = số đặt − đã nhận ở mọi phiếu + số của phiếu này; phiếu thuộc lô thì không quá số trong lô.
      const byOrder = order ? Number(order.ordered) - Number(order.received) + Number(line.quantity) : Number(line.quantity);
      const max = order?.shipmentQuantity !== undefined ? Math.min(byOrder, Number(order.shipmentQuantity)) : byOrder;
      return { productId: line.productId, sku: line.sku, productName: line.productName, unit: line.unit, quantity: String(Number(line.quantity)), locationCode: line.locationCode ?? '', max };
    });
    open = true;
  }

  async function save(event: SubmitEvent) {
    event.preventDefault();
    if (!target) return;
    formError = '';
    if (reason.trim().length < 3) {
      formError = m.inv_ghi_chu_toi_thieu();
      return;
    }
    const over = draft.find((line) => Number(line.quantity || 0) > line.max);
    if (over) {
      formError = `${over.sku}: ${m.gr_toi_da({ max: num(over.max) })}`;
      return;
    }
    saving = true;
    try {
      const saved = await api<GoodsReceiptView>(`/goods-receipts/${target.id}`, {
        method: 'PATCH',
        idempotentCommand: true,
        body: JSON.stringify({
          version: target.version,
          reason: reason.trim(),
          lines: draft.map((line) => ({ productId: line.productId, quantity: line.quantity || '0', ...(line.locationCode.trim() ? { locationCode: line.locationCode.trim().toUpperCase() } : {}) })),
        }),
      });
      open = false;
      await load();
      onchanged?.(saved.code);
    } catch (caught) {
      formError = caught instanceof Error ? caught.message : m.crud_loi_luu();
    } finally {
      saving = false;
    }
  }
</script>

<section class="card receipts">
  <header class="card-head"><h2>{m.gr_phieu_da_nhap()}</h2></header>
  {#if error}<div class="banner error"><CircleAlert size={17} /><span>{error}</span></div>{/if}
  <div class="table-wrap">
    <table class="table">
      <thead><tr><th>{m.chung_tu()}</th><th>{m.thoi_diem()}</th>{#if importShipmentId}<th>{m.ls_don_mua()}</th>{/if}<th>{m.gr_hang_nhap()}</th><th></th></tr></thead>
      <tbody>
        {#if loading && !rows.length}<tr class="empty-row"><td colspan="5">{m.dang_tai()}</td></tr>
        {:else if rows.length}
          {#each rows as row (row.id)}
            <tr>
              <td class="code">{row.code}{#if row.corrections.length}<small>{m.inv_da_sua_lan({ count: row.corrections.length })}</small>{/if}</td>
              <td class="muted nowrap">{dateTime(row.postedAt)}</td>
              {#if importShipmentId}<td class="code">{row.purchaseOrderCode}</td>{/if}
              <td>
                {#each row.lines as line}<div class="line"><span class="code">{line.sku}</span> × {num(line.quantity)} {line.unit.toLowerCase()}{#if line.locationCode} · {line.locationCode}{/if}</div>{/each}
                {#each row.corrections.slice(-1) as correction}
                  <small class="last">{correction.byName} · {dateTime(correction.at)} — {correction.reason}{#each correction.costChanges ?? [] as cost}<br />{m.gr_gia_von({ sku: cost.sku, before: cost.before ?? '—', after: cost.after })}{/each}</small>
                {/each}
              </td>
              <td class="nowrap">{#if canEdit}<button class="btn small" onclick={() => edit(row)}><Pencil size={14} />{m.gr_sua()}</button>{/if}</td>
            </tr>
          {/each}
        {:else}<tr class="empty-row"><td colspan="5">{m.gr_chua_co()}</td></tr>{/if}
      </tbody>
    </table>
  </div>
</section>

<Dialog bind:open title={m.gr_sua_title({ code: target?.code ?? '' })} wide>
  <form id="receipt-correction" class="form" onsubmit={save}>
    {#if formError}<div class="banner error"><CircleAlert size={17} /><span>{formError}</span></div>{/if}
    <div class="table-wrap">
      <table class="table">
        <thead><tr><th>{m.ma_sp()}</th><th>{m.ten_san_pham()}</th><th class="num">{m.gr_so_thuc_nhan()}</th><th>{m.gr_vi_tri()}</th></tr></thead>
        <tbody>
          {#each draft as line}
            <tr>
              <td class="code">{line.sku}</td>
              <td>{line.productName}</td>
              <td class="num"><NumberInput class="input qty" decimals={3} bind:value={line.quantity} aria-label={`${m.gr_so_thuc_nhan()} ${line.sku}`} /><small>{m.gr_toi_da({ max: num(line.max) })} {line.unit.toLowerCase()}</small></td>
              <td><input class="input loc" bind:value={line.locationCode} maxlength="40" aria-label={`${m.gr_vi_tri()} ${line.sku}`} /></td>
            </tr>
          {/each}
        </tbody>
      </table>
    </div>
    <div class="field">
      <label for="gr-reason">{m.inv_ly_do_sua()} <span class="req">*</span></label>
      <input id="gr-reason" bind:value={reason} maxlength="300" placeholder={m.inv_ly_do_sua_goi_y()} />
    </div>
    <p class="hint">{m.gr_sua_ghi_chu()}</p>
  </form>
  {#snippet footer()}
    <button type="button" class="btn" onclick={() => (open = false)}>{m.huy()}</button>
    <button type="submit" class="btn primary" form="receipt-correction" disabled={saving}>{saving ? m.kh_dang_luu() : m.inv_luu_thay_doi()}</button>
  {/snippet}
</Dialog>

<style>
  .receipts { margin-top: 16px; }
  td small { display: block; color: var(--subtle); font-size: 12px; }
  .line { white-space: nowrap; }
  .last { margin-top: 4px; color: var(--muted) !important; }
  .form { display: grid; gap: 12px; }
  .form :global(.qty) { width: 120px; }
  .loc { width: 120px; }
  .req { color: var(--red); }
  .hint { margin: 0; color: var(--subtle); font-size: 12.5px; }
</style>
