<script module lang="ts">
  export type EditablePromotion = {
    id: string; code: string; name: string; discountRate: string; validFrom: string; validTo: string; version?: number;
    categoryIds?: string[]; productSkus?: string[]; customerTiers: string[];
  };
</script>

<script lang="ts">
  /**
   * Thêm / sửa chương trình khuyến mãi (POST /promotions, PATCH /promotions/:id kèm version).
   * Mã CTKM cố định sau khi tạo. Để trống nhóm hàng và mã hàng = mọi sản phẩm; không chọn cấp = mọi cấp khách.
   */
  import { untrack } from 'svelte';
  import { CircleAlert, Info } from 'lucide-svelte';
  import { m } from '$lib/paraglide/messages';
  import { api, ApiRequestError } from '$lib/api';
  import { todayIso } from '$lib/format';
  import { tierLabel } from '$lib/labels';
  import { parseSkus, validatePromotion, vnDateOnly, type PromotionDraft } from '$lib/pricing-config';
  import Dialog from './Dialog.svelte';
  import NumberInput from './NumberInput.svelte';

  type Category = { id: string; code: string; name: string; status?: string };

  let { open = $bindable(false), promotion = null, categories = [], cap, onsaved }: {
    open?: boolean;
    /** null = thêm mới. */
    promotion?: EditablePromotion | null;
    categories?: Category[];
    /** Trần chiết khấu hiện hành (%). */
    cap: number;
    onsaved?: (code: string, created: boolean) => void;
  } = $props();

  const TIERS = ['TIER_1', 'TIER_2', 'RETAIL'];
  let form = $state<PromotionDraft>({ code: '', name: '', discountRate: '', validFrom: '', validTo: '', categoryIds: [], productSkus: '', customerTiers: [] });
  let errors = $state<Record<string, string>>({});
  let error = $state('');
  let saving = $state(false);

  $effect(() => {
    if (!open) return;
    untrack(() => {
      form = promotion
        ? {
            code: promotion.code, name: promotion.name, discountRate: String(Number(promotion.discountRate)),
            validFrom: vnDateOnly(promotion.validFrom), validTo: vnDateOnly(promotion.validTo),
            categoryIds: [...(promotion.categoryIds ?? [])], productSkus: (promotion.productSkus ?? []).join(', '), customerTiers: [...promotion.customerTiers],
          }
        : { code: '', name: '', discountRate: '', validFrom: todayIso(), validTo: todayIso(30), categoryIds: [], productSkus: '', customerTiers: [] };
      errors = {};
      error = '';
    });
  });

  function toggle(list: string[], value: string) {
    const index = list.indexOf(value);
    if (index >= 0) list.splice(index, 1);
    else list.push(value);
  }

  async function submit(event: SubmitEvent) {
    event.preventDefault();
    errors = validatePromotion(form, cap, !promotion);
    error = '';
    if (Object.keys(errors).length) return;
    saving = true;
    const body = {
      name: form.name.trim(), discountRate: form.discountRate, validFrom: form.validFrom, validTo: form.validTo,
      categoryIds: form.categoryIds, productSkus: parseSkus(form.productSkus), customerTiers: form.customerTiers,
    };
    try {
      if (promotion) {
        await api(`/promotions/${promotion.id}`, { method: 'PATCH', body: JSON.stringify({ ...body, version: promotion.version ?? 0 }) });
      } else {
        await api('/promotions', { method: 'POST', body: JSON.stringify({ ...body, code: form.code.trim().toUpperCase() }) });
      }
      open = false;
      onsaved?.(promotion?.code ?? form.code.trim().toUpperCase(), !promotion);
    } catch (caught) {
      if (caught instanceof ApiRequestError) {
        const details = Array.isArray(caught.payload.details) ? (caught.payload.details as Array<{ path?: unknown[] }>) : [];
        for (const issue of details) {
          const key = issue.path?.[0];
          if (typeof key === 'string') errors[key] ??= caught.message;
        }
      }
      error = caught instanceof Error ? caught.message : m.crud_loi_luu();
    } finally {
      saving = false;
    }
  }
</script>

<Dialog bind:open title={promotion ? m.pc_sua_ctkm({ code: promotion.code }) : m.pc_them_ctkm()} wide>
  <form id="promotion-form" class="grid" onsubmit={submit} novalidate>
    {#if error}<div class="banner error span"><CircleAlert size={17} /><span>{error}</span></div>{/if}
    <p class="notice span"><Info size={16} />{m.pc_ap_dung_ghi_chu()}</p>
    <div class="field">
      <label for="km-code">{m.ma_ctkm()} {#if !promotion}<span class="req">*</span>{/if}</label>
      <input id="km-code" value={form.code} readonly={Boolean(promotion)} maxlength="40" autocomplete="off" aria-invalid={Boolean(errors.code)} oninput={(event) => (form.code = event.currentTarget.value.toUpperCase())} placeholder="KM-TET-2027" />
      {#if errors.code}<span class="error">{errors.code}</span>{:else if promotion}<span class="hint">{m.pc_ma_ctkm_co_dinh()}</span>{/if}
    </div>
    <div class="field">
      <label for="km-rate">{m.muc_giam()} (%) <span class="req">*</span></label>
      <NumberInput id="km-rate" decimals={2} bind:value={form.discountRate} aria-invalid={Boolean(errors.discountRate)} />
      {#if errors.discountRate}<span class="error">{errors.discountRate}</span>{:else}<span class="hint">{m.pc_muc_giam_goi_y({ cap: String(cap) })}</span>{/if}
    </div>
    <div class="field span">
      <label for="km-name">{m.ten_chuong_trinh()} <span class="req">*</span></label>
      <input id="km-name" bind:value={form.name} maxlength="200" aria-invalid={Boolean(errors.name)} />
      {#if errors.name}<span class="error">{errors.name}</span>{/if}
    </div>
    <div class="field">
      <label for="km-from">{m.pc_tu_ngay()} <span class="req">*</span></label>
      <input id="km-from" type="date" bind:value={form.validFrom} aria-invalid={Boolean(errors.validFrom)} />
      {#if errors.validFrom}<span class="error">{errors.validFrom}</span>{/if}
    </div>
    <div class="field">
      <label for="km-to">{m.pc_den_ngay()} <span class="req">*</span></label>
      <input id="km-to" type="date" bind:value={form.validTo} min={form.validFrom} aria-invalid={Boolean(errors.validTo)} />
      {#if errors.validTo}<span class="error">{errors.validTo}</span>{/if}
    </div>
    <fieldset class="field span choices">
      <legend>{m.pc_nhom_hang_ap_dung()}</legend>
      <div class="checks">
        {#each categories.filter((row) => row.status !== 'INACTIVE' || form.categoryIds.includes(row.id)) as category (category.id)}
          <label class="check"><input type="checkbox" checked={form.categoryIds.includes(category.id)} onchange={() => toggle(form.categoryIds, category.id)} />{category.name}</label>
        {/each}
      </div>
      {#if errors.categoryIds}<span class="error">{errors.categoryIds}</span>{/if}
    </fieldset>
    <div class="field span">
      <label for="km-skus">{m.pc_ma_hang_ap_dung()}</label>
      <input id="km-skus" value={form.productSkus} maxlength="2000" autocomplete="off" placeholder="INP6001, INP6002" aria-invalid={Boolean(errors.productSkus)} oninput={(event) => (form.productSkus = event.currentTarget.value.toUpperCase())} />
      {#if errors.productSkus}<span class="error">{errors.productSkus}</span>{:else}<span class="hint">{m.pc_ma_hang_goi_y()}</span>{/if}
    </div>
    <fieldset class="field span choices">
      <legend>{m.cap_khach()}</legend>
      <div class="checks">
        {#each TIERS as tier}
          <label class="check"><input type="checkbox" checked={form.customerTiers.includes(tier)} onchange={() => toggle(form.customerTiers, tier)} />{tierLabel[tier] ?? tier}</label>
        {/each}
      </div>
      <span class="hint">{m.pc_cap_khach_goi_y()}</span>
    </fieldset>
  </form>
  {#snippet footer()}
    <button type="button" class="btn" onclick={() => (open = false)}>{m.huy()}</button>
    <button type="submit" class="btn primary" form="promotion-form" disabled={saving}>{saving ? m.kh_dang_luu() : m.crud_luu()}</button>
  {/snippet}
</Dialog>

<style>
  .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 14px 16px; align-items: start; }
  .span { grid-column: 1 / -1; }
  .req { color: var(--red); }
  .notice { display: flex; align-items: flex-start; gap: 8px; margin: 0; padding: 10px 12px; border-radius: 8px; background: var(--blue-soft); color: var(--navy); font-size: 13px; }
  .notice :global(svg) { flex: none; margin-top: 2px; }
  .choices { margin: 0; padding: 0; border: 0; }
  .choices legend { margin-bottom: 6px; padding: 0; font-size: 13px; font-weight: 500; }
  .checks { display: flex; flex-wrap: wrap; gap: 6px 18px; }
  .check { display: flex; align-items: center; gap: 8px; min-height: 30px; font-size: 13.5px; }
  .check input { width: 16px; height: 16px; accent-color: var(--navy); }
  @media (max-width: 640px) { .grid { grid-template-columns: 1fr; } }
</style>
