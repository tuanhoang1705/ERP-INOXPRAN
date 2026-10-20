<script lang="ts" module>
  export type PostedPayment = { code: string; prepayment: string; partnerHoldReleased?: boolean };
</script>

<script lang="ts">
  /**
   * Thu tiền theo khách / ghi phí vận chuyển khách trả (CN-KH-01, 16/10/2026): NPP trả gối đầu một số tiền, hệ thống tự phân bổ
   * vào chứng từ còn nợ cũ nhất trước (xem trước trước khi ghi); thu dư thành khoản khách trả trước.
   * Phí vận chuyển khách / NPP trả thay công ty được trừ vào nợ nhưng nằm ở cột riêng, không tính là tiền thu.
   * Nhóm công nợ tách riêng (CN-SEG-01): mặc định trừ nợ thường trước; "Thu cho nhóm …" khi NPP trả riêng tiền hàng của nhóm.
   */
  import { m } from '$lib/paraglide/messages';
  import { CircleAlert, X } from 'lucide-svelte';
  import { api } from '$lib/api';
  import { date, num, todayIso, vnd } from '$lib/format';
  import { debounce } from '$lib/paging';
  import type { CustomerOption } from '$lib/customer-search';
  import CustomerPicker from './CustomerPicker.svelte';
  import NumberInput from './NumberInput.svelte';

  type Preview = {
    allocations: Array<{ receivableId: string; segment?: string | null; code: string; documentNo: string; amount: string; outstanding: string; dueDate?: string; createdAt?: string }>;
    leftover: string;
    openDebt: string;
  };

  let {
    open = $bindable(false),
    partnerId = '',
    partnerName = '',
    kind = $bindable<'RECEIPT' | 'FREIGHT'>('RECEIPT'),
    onposted,
  }: {
    open?: boolean;
    /** Có = thu cho đúng khách này (trang sổ chi tiết); trống = chọn khách trong drawer. */
    partnerId?: string;
    partnerName?: string;
    kind?: 'RECEIPT' | 'FREIGHT';
    onposted?: (payment: PostedPayment, kind: 'RECEIPT' | 'FREIGHT') => void;
  } = $props();

  let chosenId = $state('');
  let customers = $state<CustomerOption[]>([]);
  let customersLoading = $state(false);
  let amount = $state('');
  let method = $state<'BANK_TRANSFER' | 'CASH' | 'OTHER'>('BANK_TRANSFER');
  let receivedOn = $state(todayIso());
  let reference = $state('');
  let note = $state('');
  let preview = $state<Preview | null>(null);
  let previewing = $state(false);
  let saving = $state(false);
  let error = $state('');
  let segment = $state('');
  let segments = $state<Array<{ code: string; name: string; active: boolean }>>([]);
  const segmentName = (code: string | null | undefined) => segments.find((item) => item.code === code)?.name ?? code ?? '';
  const targetId = $derived(partnerId || chosenId);
  const targetName = $derived(partnerName || customers.find((row) => row.id === chosenId)?.name || '');

  $effect(() => {
    if (!open) return;
    amount = '';
    reference = '';
    note = '';
    error = '';
    preview = null;
    receivedOn = todayIso();
    segment = '';
    void api<{ segments: Array<{ code: string; name: string; active: boolean }> }>('/receivables/segments')
      .then((result) => (segments = result.segments.filter((item) => item.active)))
      .catch(() => (segments = []));
    if (!partnerId && !customers.length && !customersLoading) {
      customersLoading = true;
      void api<CustomerOption[]>('/partners?kind=CUSTOMER')
        .then((rows) => (customers = rows))
        .catch(() => undefined)
        .finally(() => (customersLoading = false));
    }
  });

  async function loadPreview() {
    if (!targetId) {
      preview = null;
      return;
    }
    previewing = true;
    try {
      const value = Number(amount) > 0 ? amount : '0.01';
      preview = await api<Preview>(`/receivables/customer-payments/preview?partnerId=${targetId}&amount=${encodeURIComponent(value)}${segment ? `&segment=${encodeURIComponent(segment)}` : ''}`);
      if (!(Number(amount) > 0)) preview = { ...preview, allocations: [], leftover: '0.00' };
    } catch (caught) {
      error = caught instanceof Error ? caught.message : m.khong_tai_duoc_cong_no();
    } finally {
      previewing = false;
    }
  }
  const previewLater = debounce(() => void loadPreview(), 300);
  $effect(() => {
    void targetId;
    if (open) void loadPreview();
  });

  async function post(event: SubmitEvent) {
    event.preventDefault();
    if (!targetId || !(Number(amount) > 0)) return;
    saving = true;
    error = '';
    try {
      const result = await api<PostedPayment>('/receivables/customer-payments', {
        method: 'POST',
        idempotentCommand: true,
        body: JSON.stringify({
          partnerId: targetId, amount, kind, method: kind === 'FREIGHT' ? 'OTHER' : method,
          receivedAt: new Date(`${receivedOn}T12:00:00+07:00`).toISOString(),
          ...(reference.trim() ? { reference: reference.trim() } : {}),
          ...(note.trim() ? { note: note.trim() } : {}),
          ...(segment ? { segment } : {}),
        }),
      });
      open = false;
      onposted?.(result, kind);
    } catch (caught) {
      error = caught instanceof Error ? caught.message : m.khong_the_ghi_nhan_thanh_toan();
    } finally {
      saving = false;
    }
  }
</script>

{#if open}
  <button class="scrim" onclick={() => (open = false)} aria-label={m.dong()}></button>
  <aside class="drawer" aria-label={kind === 'FREIGHT' ? m.cn_ghi_phi_vc() : m.cn_thu_theo_khach()}>
    <header>
      <div><h2>{kind === 'FREIGHT' ? m.cn_ghi_phi_vc() : m.cn_thu_theo_khach()}</h2>{#if targetName}<p>{targetName}</p>{/if}</div>
      <button onclick={() => (open = false)} aria-label={m.dong()}><X size={20} /></button>
    </header>
    <form class="body" onsubmit={post}>
      <div class="segmented" role="tablist">
        <button type="button" role="tab" aria-selected={kind === 'RECEIPT'} class:active={kind === 'RECEIPT'} onclick={() => (kind = 'RECEIPT')}>{m.cn_loai_thu_tien()}</button>
        <button type="button" role="tab" aria-selected={kind === 'FREIGHT'} class:active={kind === 'FREIGHT'} onclick={() => (kind = 'FREIGHT')}>{m.cn_loai_phi_vc()}</button>
      </div>
      {#if kind === 'FREIGHT'}<p class="note">{m.cn_phi_vc_giai_thich()}</p>{/if}
      {#if !partnerId}
        <div class="field"><label for="cp-customer">{m.khach_hang()}</label>
          <CustomerPicker id="cp-customer" options={customers} value={chosenId} loading={customersLoading} placeholder={m.cn_chon_khach()} onchoose={(id) => (chosenId = id)} />
        </div>
      {/if}
      {#if preview}<div class="balance"><span>{m.cn_chung_tu_con_no()}</span><b>{vnd(preview.openDebt)}</b></div>{/if}
      <div class="field"><label for="cp-amount">{kind === 'FREIGHT' ? m.cn_so_tien_phi_vc() : m.so_tien_thu_vnd()}</label><NumberInput id="cp-amount" bind:value={amount} onvalue={previewLater} /></div>
      <div class="row2">
        <div class="field"><label for="cp-date">{kind === 'FREIGHT' ? m.cn_ngay_phat_sinh_vc() : m.ngay_thu()}</label><input id="cp-date" type="date" max={todayIso()} bind:value={receivedOn} /></div>
        {#if kind === 'RECEIPT'}
          <div class="field"><label for="cp-method">{m.hinh_thuc()}</label><select id="cp-method" bind:value={method}><option value="BANK_TRANSFER">{m.chuyen_khoan()}</option><option value="CASH">{m.tien_mat()}</option><option value="OTHER">{m.khac()}</option></select></div>
        {/if}
      </div>
      {#if segments.length}
        <div class="field"><label for="cp-segment">{m.seg_tru_vao()}</label>
          <select id="cp-segment" bind:value={segment} onchange={() => void loadPreview()}>
            <option value="">{m.seg_no_thuong_truoc()}</option>
            {#each segments as item (item.code)}<option value={item.code}>{m.seg_thu_cho_nhom({ name: item.name })}</option>{/each}
          </select>
          <span class="hint">{m.seg_giai_thich_thu()}</span>
        </div>
      {/if}
      {#if kind === 'RECEIPT'}<div class="field"><label for="cp-ref">{m.ma_giao_dich_ngan_hang()}</label><input id="cp-ref" bind:value={reference} maxlength="100" placeholder={m.vi_du_ft26100012345()} /></div>{/if}
      <div class="field"><label for="cp-note">{m.ghi_chu()}</label><input id="cp-note" bind:value={note} maxlength="300" placeholder={kind === 'FREIGHT' ? m.cn_ghi_chu_vc_vi_du() : ''} /></div>

      {#if preview && Number(amount) > 0}
        <section class="plan" aria-live="polite">
          <h3>{m.cn_phan_bo_du_kien()}</h3>
          {#if preview.allocations.length}
            <table>
              <thead><tr><th>{m.chung_tu()}</th><th>{m.han_thanh_toan()}</th><th class="num">{m.con_lai()}</th><th class="num">{m.cn_phan_bo()}</th></tr></thead>
              <tbody>
                {#each preview.allocations as row (`${row.receivableId}-${row.segment ?? ''}`)}
                  <tr><td>{row.documentNo}<small>{row.code}{row.segment ? ` · ${m.seg_phan_nhom({ name: segmentName(row.segment) })}` : ''}</small></td><td>{row.dueDate ? date(row.dueDate) : '—'}</td><td class="num">{num(row.outstanding)}</td><td class="num"><b>{num(row.amount)}</b></td></tr>
                {/each}
              </tbody>
            </table>
          {:else}<p class="note">{m.cn_khong_co_chung_tu_con_no()}</p>{/if}
          {#if Number(preview.leftover) > 0}<p class="leftover">{m.cn_thu_du_tra_truoc({ amount: vnd(preview.leftover) })}</p>{/if}
        </section>
      {/if}
      {#if error}<p class="err"><CircleAlert size={15} />{error}</p>{/if}
      <button class="btn primary" disabled={saving || previewing || !targetId || !(Number(amount) > 0)}>{saving ? m.dang_ghi_so() : kind === 'FREIGHT' ? m.cn_ghi_phi_vc() : m.lap_phieu_thu()}</button>
      <p class="note">{m.phieu_thu_duoc_bao_ve_chong()}</p>
    </form>
  </aside>
{/if}

<style>
  .scrim { position: fixed; inset: 0; z-index: 70; border: 0; background: rgba(18, 39, 59, 0.45); }
  .drawer { position: fixed; top: 0; right: 0; z-index: 71; display: grid; grid-template-rows: auto 1fr; width: min(480px, 100vw); height: 100vh; background: var(--surface); box-shadow: -20px 0 50px rgba(18, 59, 94, 0.2); }
  .drawer header { display: flex; justify-content: space-between; gap: 12px; padding: 22px 24px 8px; }
  .drawer header button { border: 0; background: none; cursor: pointer; color: var(--muted); }
  .drawer h2 { margin: 0; font-size: 20px; }
  .drawer header p { margin: 4px 0 0; color: var(--muted); }
  .body { display: grid; align-content: start; gap: 14px; overflow-y: auto; padding: 8px 24px 24px; }
  .segmented { display: grid; grid-template-columns: 1fr 1fr; padding: 3px; border-radius: 8px; background: var(--surface-2, #eef2f6); }
  .segmented button { padding: 8px; border: 0; border-radius: 6px; background: transparent; color: var(--muted); font: inherit; font-weight: 600; cursor: pointer; }
  .segmented button.active { background: var(--surface); color: var(--navy); box-shadow: 0 1px 3px rgba(18, 59, 94, 0.15); }
  .row2 { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
  .balance { display: grid; gap: 4px; padding: 12px 16px; border-left: 4px solid var(--orange); border-radius: 0 8px 8px 0; background: var(--orange-soft); }
  .balance span { color: var(--muted); font-size: 12.5px; }
  .balance b { color: var(--orange); font-size: 19px; }
  .plan { display: grid; gap: 8px; padding: 12px; border: 1px solid var(--line); border-radius: 8px; }
  .plan h3 { margin: 0; font-size: 13.5px; }
  .plan table { width: 100%; border-collapse: collapse; font-size: 12.5px; }
  .plan th { color: var(--subtle); font-weight: 500; text-align: left; padding: 4px 6px; border-bottom: 1px solid var(--line); }
  .plan td { padding: 6px; border-bottom: 1px solid var(--line); vertical-align: top; }
  .plan td small { display: block; color: var(--subtle); }
  .plan .num { text-align: right; white-space: nowrap; }
  .leftover { margin: 0; color: var(--green); font-weight: 600; font-size: 13px; }
  .note { margin: 0; color: var(--subtle); font-size: 12.5px; }
  .hint { color: var(--subtle); font-size: 12px; }
  .err { display: flex; align-items: center; gap: 6px; margin: 0; color: var(--red); font-size: 13px; }
  @media (max-width: 480px) { .row2 { grid-template-columns: 1fr; } }
</style>
