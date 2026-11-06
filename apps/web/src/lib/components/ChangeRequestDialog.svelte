<script lang="ts">
  /**
   * Xem / duyệt / từ chối một đề nghị sửa / hủy / xóa phiếu BH (SAL-CHG-01). Đề nghị sửa hiện bảng so sánh
   * dòng hàng hiện tại với dòng theo đề nghị. Duyệt: hệ thống thực hiện ngay bằng tài khoản người duyệt.
   * Xin sửa phiếu (EDIT_GRANT — SAL-EDIT-GRANT-01, 06/11/2026): duyệt = cho phép người xin sửa một lần trong 24 giờ; đã sửa thì
   * hiện bảng trước → sau.
   */
  import { SALES_EDIT_GRANT_HOURS } from '$shared/sales-steps';
  import { CircleAlert } from 'lucide-svelte';
  import { m } from '$lib/paraglide/messages';
  import { api } from '$lib/api';
  import { dateTime, num, vnd } from '$lib/format';
  import { changeKindLabel, compareLines, type ChangeRequest } from '$lib/change-requests';
  import LineKindPill from './LineKindPill.svelte';
  import type { ZeroPriceKind } from '$shared/sales-line-kind';
  import Dialog from './Dialog.svelte';

  let { open = $bindable(false), request, action, ondone }: {
    open?: boolean;
    request: ChangeRequest | null;
    action: 'view' | 'approve' | 'reject';
    ondone?: (result: ChangeRequest) => void;
  } = $props();

  type CurrentOrder = { grandTotal: string; lines: Array<{ sku: string; productName: string; unit: string; quantity: string; gift?: boolean; zeroPriceKind?: ZeroPriceKind | undefined; unitPrice: string; lineTotal: string }> };
  let current = $state<CurrentOrder | null>(null);
  let note = $state('');
  let working = $state(false);
  let error = $state('');

  $effect(() => {
    if (open && request) {
      note = '';
      error = '';
      current = null;
      if (request.kind === 'EDIT') {
        void api<{ order: CurrentOrder }>(`/sales-change-requests/${request.id}`).then((row) => (current = row.order)).catch(() => undefined);
      }
    }
  });

  /** Bảng so sánh: đề nghị sửa cũ (hiện tại → theo đề nghị) hoặc quyền sửa đã dùng (trước → sau khi sửa). */
  const comparison = $derived.by(() => {
    if (request?.kind === 'EDIT_GRANT' && request.result) {
      const { before, after } = request.result;
      return { rows: compareLines(before.lines, after.lines), before: before.grandTotal, after: after.grandTotal, left: m.yc_truoc_khi_sua(), right: m.yc_sau_khi_sua() };
    }
    if (request?.kind === 'EDIT' && request.preview) {
      return { rows: current ? compareLines(current.lines, request.preview.lines) : [], before: current?.grandTotal ?? null, after: request.preview.grandTotal, left: m.yc_hien_tai(), right: m.yc_theo_de_nghi() };
    }
    return null;
  });
  const title = $derived(!request ? '' : action === 'approve' ? m.yc_duyet_tieu_de({ code: request.code }) : action === 'reject' ? m.yc_tu_choi_tieu_de({ code: request.code }) : m.yc_xem_tieu_de({ code: request.code }));

  async function submit() {
    if (!request) return;
    working = true;
    error = '';
    try {
      const result = await api<ChangeRequest>(`/sales-change-requests/${request.id}/${action}`, { method: 'POST', idempotentCommand: true, body: JSON.stringify(note.trim() ? { note: note.trim() } : {}) });
      open = false;
      ondone?.(result);
    } catch (caught) {
      error = caught instanceof Error ? caught.message : m.khong_the_hoan_tat_thao_tac();
    } finally {
      working = false;
    }
  }
</script>

<Dialog bind:open {title} wide>
  {#if request}
    <dl class="facts">
      <div><dt>{m.yc_cot_loai()}</dt><dd><b>{changeKindLabel(request.kind)}</b> · <a class="link" href={`/sales/orders/${request.orderId}`}>{request.orderCode}</a>{request.customerName ? ` — ${request.customerName}` : ''}</dd></div>
      <div><dt>{m.yc_cot_nguoi()}</dt><dd>{request.requestedByName} · {dateTime(request.requestedAt)}</dd></div>
      <div><dt>{m.bh_ly_do()}</dt><dd class="reason">{request.reason}</dd></div>
      {#if request.kind === 'EDIT_GRANT' && request.decidedByName && request.status !== 'PENDING'}<div><dt>{m.yc_nguoi_duyet()}</dt><dd>{request.decidedByName}{request.decidedAt ? ` · ${dateTime(request.decidedAt)}` : ''}{request.expiresAt && request.status === 'GRANTED' ? ` — ${m.yc_han_sua({ at: dateTime(request.expiresAt) })}` : ''}</dd></div>{/if}
      {#if request.appliedAt}<div><dt>{m.yc_da_sua_luc()}</dt><dd>{dateTime(request.appliedAt)}</dd></div>{/if}
    </dl>
    {#if comparison}
      <div class="table-wrap">
        <table class="table compare">
          <thead>
            <tr><th rowspan="2">{m.ma_sp()}</th><th colspan="2" class="num">{comparison.left}</th><th colspan="2" class="num">{comparison.right}</th></tr>
            <tr><th class="num">SL × {m.don_gia()}</th><th class="num">{m.thanh_tien()}</th><th class="num">SL × {m.don_gia()}</th><th class="num">{m.thanh_tien()}</th></tr>
          </thead>
          <tbody>
            {#each comparison.rows as row (row.sku + (row.zeroPriceKind ?? 'SALE'))}
              <tr class:changed={row.changed}>
                <td><b class="code">{row.sku}</b>{#if row.gift}<LineKindPill kind={row.zeroPriceKind ?? 'GIFT'} />{/if}<small>{row.productName}</small></td>
                <td class="num">{row.before ? `${num(row.before.quantity)} × ${row.before.unitPrice === '' ? m.yc_nhieu_gia() : vnd(row.before.unitPrice)}` : '—'}</td>
                <td class="num">{row.before ? vnd(row.before.lineTotal) : '—'}</td>
                <td class="num"><b>{row.after ? `${num(row.after.quantity)} × ${row.after.unitPrice === '' ? m.yc_nhieu_gia() : vnd(row.after.unitPrice)}` : '—'}</b></td>
                <td class="num"><b>{row.after ? vnd(row.after.lineTotal) : '—'}</b></td>
              </tr>
            {/each}
          </tbody>
          <tfoot><tr><td>{m.yc_tong()}</td><td></td><td class="num">{comparison.before !== null ? vnd(comparison.before) : '…'}</td><td></td><td class="num"><b>{vnd(comparison.after)}</b></td></tr></tfoot>
        </table>
      </div>
    {/if}
    {#if action === 'approve'}<p class="lead">{request.kind === 'EDIT_GRANT' ? m.yc_duyet_xin_sua_giai_thich({ who: request.requestedByName, hours: SALES_EDIT_GRANT_HOURS }) : m.yc_duyet_giai_thich()}</p>{/if}
    {#if action !== 'view'}
      <div class="field">
        <label for="change-note">{action === 'reject' ? m.yc_ly_do_tu_choi() : m.yc_ghi_chu()}{#if action === 'reject'} <span class="req">*</span>{/if}</label>
        <textarea id="change-note" rows="3" maxlength="300" bind:value={note}></textarea>
        {#if action === 'reject' && note.trim() && note.trim().length < 5}<small class="error">{m.bh_ly_do_toi_thieu()}</small>{/if}
      </div>
    {/if}
    {#if error}<div class="banner error"><CircleAlert size={17} /><span>{error}</span></div>{/if}
  {/if}
  {#snippet footer()}
    <button class="btn" onclick={() => (open = false)}>{m.dong()}</button>
    {#if action === 'approve'}<button class="btn primary" disabled={working} onclick={submit}>{m.yc_duyet()}</button>{/if}
    {#if action === 'reject'}<button class="btn danger" disabled={working || note.trim().length < 5} onclick={submit}>{m.yc_tu_choi()}</button>{/if}
  {/snippet}
</Dialog>

<style>
  .facts { display: grid; gap: 6px; margin: 0 0 12px; }
  .facts div { display: grid; grid-template-columns: 130px 1fr; gap: 10px; font-size: 13.5px; }
  .facts dt { color: var(--muted); }
  .facts dd { margin: 0; min-width: 0; }
  .facts .reason { white-space: pre-wrap; }
  .compare td small { display: block; color: var(--muted); font-size: 12px; }
  .compare tr.changed td { background: var(--amber-soft); }
  .compare tfoot td { font-weight: 600; border-top: 1px solid var(--line); }
  .lead { margin: 12px 0; color: var(--muted); font-size: 13px; }
  @media (max-width: 640px) { .facts div { grid-template-columns: 1fr; gap: 2px; } }
</style>
