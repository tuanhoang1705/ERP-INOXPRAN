<script lang="ts">
  import { partyName } from '$lib/slip-type';
  import { m } from '$lib/paraglide/messages';
  /** Kho lập phiếu xuất kho bán hàng số SWK từ phiếu BH đã được khách xác nhận. */
  import { CircleAlert } from 'lucide-svelte';
  import Dialog from './Dialog.svelte';
  import { api } from '$lib/api';
  import { vnd } from '$lib/format';
  import { warehouseSlipNumber } from '$shared/sales-templates';

  type Target = { id: string; code: string; version: number; customerName?: string | undefined; purpose?: string | undefined; salesRepName?: string | undefined; destination?: string | undefined; grandTotal: string; contactName?: string | undefined; deliveryLocation?: string | undefined };
  let { order = $bindable(null), ondone }: { order?: Target | null; ondone: (result: { id: string; shipmentCode: string }) => void } = $props();

  let open = $state(false);
  let receiverName = $state('');
  let carrier = $state('');
  let note = $state('');
  let working = $state(false);
  let error = $state('');

  $effect(() => {
    if (order) {
      receiverName = order.contactName ?? '';
      carrier = order.deliveryLocation ? '' : m.khach_tu_lay_tai_kho();
      note = '';
      error = '';
      open = true;
    }
  });
  $effect(() => {
    if (!open) order = null;
  });

  async function submit() {
    if (!order) return;
    working = true;
    error = '';
    try {
      const result = await api<{ id: string; shipmentCode: string }>(`/sales-orders/${order.id}/ship`, {
        method: 'POST',
        idempotentCommand: true,
        body: JSON.stringify({
          version: order.version,
          ...(receiverName.trim() ? { receiverName: receiverName.trim() } : {}),
          ...(carrier.trim() ? { carrier: carrier.trim() } : {}),
          ...(note.trim() ? { note: note.trim() } : {}),
        }),
      });
      open = false;
      ondone(result);
    } catch (caught) {
      error = caught instanceof Error ? caught.message : m.khong_lap_duoc_phieu_swk();
    } finally {
      working = false;
    }
  }
</script>

<Dialog bind:open title={order ? m.lap_phieu_swk_cho({ code: order.code }) : m.lap_phieu_swk()}>
  {#if order}
    <p class="lead">{m.xuat_kho_cho()} <b>{partyName(order)}</b> {m.tong_thanh_toan()} <b>{vnd(order.grandTotal)}</b>{m.he_thong_se_cap_so_swk_cung_so({ swk: warehouseSlipNumber(order.code) })}</p>
    {#if order.deliveryLocation}<p class="lead">{m.dia_diem_giao()} <b>{order.deliveryLocation}</b></p>{/if}
    <div class="field"><label for="receiver">{m.nguoi_nhan_hang()}</label><input id="receiver" bind:value={receiverName} maxlength="120" placeholder={m.ho_ten_nguoi_nhan_lai_xe()} /></div>
    <div class="field"><label for="carrier">{m.phuong_tien_don_vi_van_chuyen()}</label><input id="carrier" bind:value={carrier} maxlength="120" placeholder={m.vd_xe_cong_ty_29c_123()} /></div>
    <div class="field"><label for="warehouse-note">{m.ghi_chu_kho()}</label><textarea id="warehouse-note" rows="3" maxlength="500" bind:value={note}></textarea></div>
    {#if error}<div class="banner error"><CircleAlert size={17} />{error}</div>{/if}
  {/if}
  {#snippet footer()}
    <button class="btn" onclick={() => (open = false)}>{m.huy()}</button>
    <button class="btn primary" disabled={working} onclick={submit}>{working ? m.dang_ghi_so() : m.lap_swk_xuat_kho()}</button>
  {/snippet}
</Dialog>

<style>
  .lead { margin: 0; color: var(--muted); font-size: 13.5px; }
  .lead b { color: var(--text); }
</style>
