<script lang="ts">
  /**
   * Kế toán xử lý công nợ phiếu khách trả (D1, 22/10/2026):
   * - "Giảm công nợ": đơn giá từng dòng (gợi ý theo phiếu BH gốc / giá bán gần nhất) → phiếu giảm nợ "Trả hàng" (27/10/2026: bỏ khung
   *   xem trước "Trừ vào công nợ" theo yêu cầu kế toán — trừ vào đâu xem trên sổ công nợ khách).
   *   Mặc định trừ vào tổng công nợ (phiếu BH gốc trước, rồi nợ cũ nhất), không tự trừ vào nhóm công nợ riêng — kế toán chọn
   *   "Trừ vào nhóm …" khi cần (27/10/2026, AR-RET-01). Đơn giá CHƯA thuế + % thuế GTGT từng dòng (thuế dòng như MISA):
   *   tổng giảm nợ = cộng tiền hàng + tiền thuế GTGT;
   * - "Không giảm công nợ": đổi hàng, bảo hành, đã xử lý ngoài hệ thống — chỉ ghi nhận.
   */
  import { m } from '$lib/paraglide/messages';
  import type { StockReturn, StockReturnAccountingDraft } from '@inoxpran/contracts';
  import { untrack } from 'svelte';
  import { CircleAlert, FileCheck, HandCoins } from 'lucide-svelte';
  import { api } from '$lib/api';
  import { num, vnd } from '$lib/format';
  import Dialog from '$lib/components/Dialog.svelte';
  import NumberInput from '$lib/components/NumberInput.svelte';
  import { isVatRate, pricedLineAmounts, VAT_RATE_OPTIONS, type VatRate } from '$shared/sales-math';

  type Saved = StockReturn & { partnerHoldReleased?: boolean };
  let { open = $bindable(false), target, onsaved }: { open?: boolean; target: StockReturn | null; onsaved: (row: Saved) => void } = $props();

  let mode = $state<'CREDIT' | 'NONE'>('CREDIT');
  let draft = $state<StockReturnAccountingDraft | null>(null);
  /** Đơn giá CHƯA thuế và thuế suất GTGT theo mã hàng. */
  let prices = $state<Record<string, string>>({});
  let rates = $state<Record<string, VatRate>>({});
  let postedOn = $state('');
  let note = $state('');
  let error = $state('');
  let loading = $state(false);
  let saving = $state(false);
  /** Nhóm công nợ được chọn để trừ; '' = tổng công nợ. */
  let segment = $state('');
  let segments = $state<Array<{ code: string; name: string; active: boolean }>>([]);
  const segmentName = (code: string | null | undefined) => segments.find((item) => item.code === code)?.name ?? code ?? '';
  /** Nhóm của các mã hàng trả (gợi ý chọn khi muốn trừ vào nợ nhóm). */
  const lineGroups = $derived([...new Set((draft?.lines ?? []).map((line) => line.segment).filter((code): code is string => Boolean(code)))]);
  const today = new Date(Date.now() + 7 * 3_600_000).toISOString().slice(0, 10);

  /** Tiền hàng, tiền thuế, thành tiền của một dòng — cùng hàm máy chủ dùng khi lập phiếu giảm nợ. */
  const amountsOf = (line: { productId: string; quantity: string }) => {
    const price = prices[line.productId] ?? '';
    if (price === '') return { netAmount: 0, taxAmount: 0, amount: 0 };
    const result = pricedLineAmounts(line.quantity, price, rates[line.productId] ?? '8');
    return { netAmount: Number(result.netAmount), taxAmount: Number(result.taxAmount), amount: Number(result.amount) };
  };
  const totals = $derived((draft?.lines ?? []).map(amountsOf).reduce((sum, item) => ({ netAmount: sum.netAmount + item.netAmount, taxAmount: sum.taxAmount + item.taxAmount, amount: sum.amount + item.amount }), { netAmount: 0, taxAmount: 0, amount: 0 }));
  const total = $derived(totals.amount);
  const priced = $derived(Boolean(draft?.lines.length) && (draft?.lines ?? []).every((line) => (prices[line.productId] ?? '') !== ''));

  let loadedFor = '';
  async function loadDraft(id: string) {
    loading = true;
    error = '';
    draft = null;
    try {
      const [result, groups] = await Promise.all([
        api<StockReturnAccountingDraft>(`/inventory/returns/${id}/accounting-draft`),
        api<{ segments: Array<{ code: string; name: string; active: boolean }> }>('/receivables/segments').catch(() => ({ segments: [] })),
      ]);
      segments = groups.segments.filter((item) => item.active);
      draft = result;
      prices = Object.fromEntries(result.lines.map((line) => [line.productId, line.unitPrice ?? '']));
      rates = Object.fromEntries(result.lines.map((line) => [line.productId, isVatRate(line.vatRate) ? line.vatRate : '8']));
      postedOn = result.defaultPostedOn;
    } catch (caught) {
      error = caught instanceof Error ? caught.message : m.inv_khong_tai_duoc();
    } finally {
      loading = false;
    }
  }
  $effect(() => {
    const id = open ? target?.id : undefined;
    if (!id) {
      loadedFor = '';
      return;
    }
    if (id === loadedFor) return;
    loadedFor = id;
    untrack(() => {
      mode = 'CREDIT';
      note = '';
      segment = '';
      void loadDraft(id);
    });
  });

  async function save(event: SubmitEvent) {
    event.preventDefault();
    if (!target || !draft) return;
    if (note.trim().length < 3) {
      error = m.inv_ghi_chu_toi_thieu();
      return;
    }
    if (mode === 'CREDIT' && (!priced || total <= 0)) {
      error = m.rac_can_don_gia();
      return;
    }
    saving = true;
    error = '';
    try {
      const body = mode === 'CREDIT'
        ? { mode, note: note.trim(), postedOn, ...(segment ? { segment } : {}), lines: draft.lines.map((line) => ({ productId: line.productId, unitPrice: prices[line.productId], vatRate: rates[line.productId] ?? '8' })) }
        : { mode, note: note.trim() };
      const saved = await api<Saved>(`/inventory/returns/${target.id}/accounting`, { method: 'POST', idempotentCommand: true, body: JSON.stringify(body) });
      open = false;
      onsaved(saved);
    } catch (caught) {
      error = caught instanceof Error ? caught.message : m.crud_loi_luu();
    } finally {
      saving = false;
    }
  }
</script>

<Dialog bind:open title={m.rac_tieu_de({ code: target?.code ?? '' })} wide>
  <form id="return-accounting-form" class="ra" onsubmit={save}>
    {#if error}<div class="banner error"><CircleAlert size={17} /><span>{error}</span></div>{/if}
    {#if loading}<p class="muted">{m.dang_tai()}</p>{/if}
    {#if draft}
      <p class="facts">
        <span><b>{draft.partnerName}</b></span>
        <span>{#if draft.salesOrderCode}{m.inv_phieu_goc()}: <b class="code">{draft.salesOrderCode}</b>{:else}{m.rac_khong_co_bh()}{/if}</span>
        <span>{m.rac_khach_dang_no()}: <b>{vnd(draft.openDebt)}</b></span>
      </p>
      <div class="modes" role="radiogroup" aria-label={m.rac_tieu_de({ code: target?.code ?? '' })}>
        <label class:on={mode === 'CREDIT'}><input type="radio" name="ra-mode" value="CREDIT" bind:group={mode} /><span><b>{m.rac_giam_cong_no()}</b><small>{m.rac_giam_cong_no_mo_ta()}</small></span></label>
        <label class:on={mode === 'NONE'}><input type="radio" name="ra-mode" value="NONE" bind:group={mode} /><span><b>{m.rac_khong_giam()}</b><small>{m.rac_khong_giam_mo_ta()}</small></span></label>
      </div>
      {#if mode === 'CREDIT'}
        <div class="table-wrap">
          <table class="table compact">
            <thead><tr><th>{m.inv_hang_tra()}</th><th class="num">{m.so_luong()}</th><th class="num">{m.rac_don_gia_chua_thue()}</th><th class="num">{m.rac_thanh_tien()}</th><th class="num">{m.bh_phan_tram_thue()}</th><th class="num">{m.bh_tien_thue_dong()}</th></tr></thead>
            <tbody>
              {#each draft.lines as line (line.productId)}
                {@const amounts = amountsOf(line)}
                <tr>
                  <td><span class="code">{line.sku}</span>{#if line.segment}<span class="pill neutral seg">{m.rac_nhom({ code: line.segment })}</span>{/if}<small>{line.productName}</small></td>
                  <td class="num">{num(line.quantity)} {line.unit.toLowerCase()}</td>
                  <td class="num price">
                    <NumberInput decimals={2} bind:value={prices[line.productId]} aria-label={`${m.rac_don_gia_chua_thue()} ${line.sku}`} />
                    <small>{line.priceSource === 'ORDER' ? m.rac_gia_theo_bh({ code: line.priceOrderCode ?? '' }) : line.priceSource === 'LAST_SALE' ? m.rac_gia_ban_gan_nhat({ code: line.priceOrderCode ?? '' }) : m.rac_chua_co_gia()}</small>
                  </td>
                  <td class="num">{vnd(amounts.netAmount)}</td>
                  <td class="num"><select class="input vat-line" bind:value={rates[line.productId]} aria-label={`${m.bh_phan_tram_thue()} ${line.sku}`}>{#each VAT_RATE_OPTIONS as option}<option value={option.value}>{option.value === 'KCT' ? 'KCT' : option.label}</option>{/each}</select></td>
                  <td class="num">{vnd(amounts.taxAmount)}</td>
                </tr>
              {/each}
            </tbody>
            <tfoot>
              <tr class="sub"><td colspan="3">{m.rac_tien_hang()}</td><td class="num">{vnd(totals.netAmount)}</td><td></td><td class="num">{vnd(totals.taxAmount)}</td></tr>
              <tr><td colspan="5">{m.rac_tong_giam_no()}</td><td class="num"><b>{vnd(total)}</b></td></tr>
            </tfoot>
          </table>
        </div>
        <div class="when-where">
          <div class="field date">
            <label for="ra-date">{m.rac_ngay_ghi()}</label>
            <input id="ra-date" type="date" bind:value={postedOn} max={today} required />
          </div>
          <div class="field target">
            <label for="ra-target">{m.seg_tru_vao()}</label>
            <select id="ra-target" bind:value={segment}>
              <option value="">{m.rac_tong_cong_no()}</option>
              {#each segments as item (item.code)}<option value={item.code}>{m.rac_tru_nhom({ name: item.name })}</option>{/each}
            </select>
            {#if lineGroups.length && !segment}<small class="field-hint">{m.rac_goi_y_nhom({ names: lineGroups.map(segmentName).join(', ') })}</small>{/if}
          </div>
        </div>
      {:else}
        <p class="hint">{m.rac_khong_giam_huong_dan()}</p>
      {/if}
      <div class="field">
        <label for="ra-note">{m.rac_ghi_chu()} <span class="req">*</span></label>
        <input id="ra-note" bind:value={note} maxlength="300" placeholder={m.inv_so_chung_tu_goi_y()} />
      </div>
    {/if}
  </form>
  {#snippet footer()}
    <button type="button" class="btn" onclick={() => (open = false)}>{m.huy()}</button>
    {#if mode === 'CREDIT'}
      <button type="submit" class="btn primary" form="return-accounting-form" disabled={saving || !draft || !priced || total <= 0}><HandCoins size={15} />{saving ? m.kh_dang_luu() : m.rac_nut_lap({ amount: vnd(total) })}</button>
    {:else}
      <button type="submit" class="btn primary" form="return-accounting-form" disabled={saving || !draft}><FileCheck size={15} />{saving ? m.kh_dang_luu() : m.rac_nut_khong_giam()}</button>
    {/if}
  {/snippet}
</Dialog>

<style>
  .ra { display: grid; gap: 14px; }
  .facts { display: flex; flex-wrap: wrap; gap: 6px 18px; margin: 0; color: var(--muted); font-size: 13.5px; }
  .facts b { color: var(--text); }
  .modes { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 10px; }
  .modes label { display: flex; align-items: flex-start; gap: 10px; padding: 10px 12px; border: 1px solid var(--line); border-radius: 8px; cursor: pointer; }
  .modes label.on { border-color: var(--navy-2); background: var(--soft, #f3f7fb); }
  .modes input { margin-top: 3px; }
  .modes small { display: block; color: var(--muted); font-size: 12.5px; }
  td small { display: block; color: var(--subtle); font-size: 12px; }
  .seg { margin-left: 6px; }
  .price :global(input) { width: 140px; text-align: right; }
  .vat-line { width: 76px; min-height: 34px; padding: 4px 22px 4px 8px; background-position: right 7px center; font-weight: 600; }
  tfoot tr.sub td { font-weight: 500; color: var(--muted); }
  tfoot td { font-weight: 600; }
  .when-where { display: grid; grid-template-columns: minmax(160px, 220px) minmax(220px, 1fr); gap: 12px; align-items: start; }
  .target select { width: 100%; }
  @media (max-width: 640px) { .when-where { grid-template-columns: 1fr; } }
  .hint { margin: 0; color: var(--subtle); font-size: 13px; }
  .req { color: var(--red); }
</style>
