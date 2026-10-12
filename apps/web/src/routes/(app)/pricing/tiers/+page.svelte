<script lang="ts">
  /**
   * Chiết khấu theo bậc doanh số (Giải thuật 2). Giám đốc / kế toán sửa trực tiếp: trần chiết khấu, kỳ tính doanh số,
   * CK theo cấp khách và bảng bậc (PATCH /pricing/policy kèm version). Phiếu bán chỉ tính giá khi lập / sửa,
   * nên mức mới áp dụng cho phiếu lập sau khi lưu; phiếu đã lập giữ nguyên mức đã tính.
   */
  import { m } from '$lib/paraglide/messages';
  import { onMount } from 'svelte';
  import { CircleAlert, CircleCheck, Info, Pencil, Plus, Trash2 } from 'lucide-svelte';
  import { api, ApiRequestError } from '$lib/api';
  import { dateTime, num, rate, vnd } from '$lib/format';
  import { tierLabel } from '$lib/labels';
  import { can } from '$lib/permissions';
  import { validatePolicy, type PolicyDraft } from '$lib/pricing-config';
  import { periodText } from '$lib/server-text';
  import NumberInput from '$lib/components/NumberInput.svelte';

  type Policy = {
    taxRate: string; pricesIncludeTax?: boolean; discountCapRate: string; tierRates: Record<string, string>;
    salesTiers: Array<{ minimumRevenue: string; discountRate: string }>; salesTierPeriod: string; salesTierPeriodCode: string;
    version: number; updatedAt: string | null; updatedBy: string | null;
    approval: { orderValueThreshold: string; discountRateThreshold: string; purchaseOrderThreshold: string };
    dealerProgress: Array<{ code: string; name: string; tier: string; revenue: string; currentRate: string; nextThreshold: string | null; nextRate: string | null }>;
  };
  const TIERS = ['TIER_1', 'TIER_2', 'RETAIL'] as const;

  let policy = $state<Policy | null>(null);
  let error = $state('');
  let success = $state('');
  let editing = $state(false);
  let saving = $state(false);
  let conflict = $state(false);
  let draft = $state<PolicyDraft>({ discountCapRate: '', salesTierPeriod: 'ROLLING_90D', salesTiers: [], customerTierDiscounts: { TIER_1: '0', TIER_2: '0', RETAIL: '0' } });
  let errors = $state<Record<string, string>>({});
  const editable = $derived(can.editPricing());

  async function load() {
    try {
      policy = await api<Policy>('/pricing/policy');
    } catch (caught) {
      error = caught instanceof Error ? caught.message : m.khong_tai_duoc_chinh_sach_chiet();
    }
  }
  onMount(load);

  function startEdit() {
    if (!policy) return;
    draft = {
      discountCapRate: policy.discountCapRate,
      salesTierPeriod: policy.salesTierPeriodCode,
      salesTiers: policy.salesTiers.map((tier) => ({ minimumRevenue: tier.minimumRevenue, discountRate: tier.discountRate })),
      customerTierDiscounts: { TIER_1: policy.tierRates.TIER_1 ?? '0', TIER_2: policy.tierRates.TIER_2 ?? '0', RETAIL: policy.tierRates.RETAIL ?? '0' },
    };
    errors = {};
    error = '';
    success = '';
    conflict = false;
    editing = true;
  }

  function addTier() {
    const last = draft.salesTiers.at(-1);
    draft.salesTiers.push({ minimumRevenue: last ? String(Number(last.minimumRevenue) * 2) : '100000000', discountRate: last?.discountRate ?? '1' });
  }

  async function save() {
    if (!policy) return;
    errors = validatePolicy(draft);
    error = '';
    if (Object.keys(errors).length) return;
    saving = true;
    try {
      await api('/pricing/policy', {
        method: 'PATCH',
        body: JSON.stringify({
          version: policy.version,
          discountCapRate: draft.discountCapRate,
          salesTierPeriod: draft.salesTierPeriod,
          salesTiers: draft.salesTiers,
          customerTierDiscounts: draft.customerTierDiscounts,
        }),
      });
      editing = false;
      success = m.pc_da_luu();
      await load();
    } catch (caught) {
      if (caught instanceof ApiRequestError) {
        conflict = caught.payload.code === 'VERSION_CONFLICT';
        const details = Array.isArray(caught.payload.details) ? (caught.payload.details as Array<{ path?: unknown[]; message?: string }>) : [];
        for (const issue of details) if (issue.path?.length) errors[issue.path.join('.')] ??= issue.message ?? m.kh_gia_tri_khong_hop_le();
      }
      error = caught instanceof Error ? caught.message : m.crud_loi_luu();
    } finally {
      saving = false;
    }
  }

  async function reloadAfterConflict() {
    await load();
    startEdit();
  }
</script>

<svelte:head><title>{m.chiet_khau_bac_doanh_so_inoxpran()}</title></svelte:head>

<section class="page-head">
  <div>
    <nav class="crumbs" aria-label={m.duong_dan()}><a href="/pricing">{m.gia_khuyen_mai()}</a><span>{m.chiet_khau_bac_doanh_so()}</span></nav>
    <h1 class="page-title">{m.chiet_khau_theo_bac_doanh_so()}</h1>
    <p class="page-sub">{m.giai_thuat_2_ck_tong_min()} {policy ? periodText(policy.salesTierPeriod) : m.quy_hien_tai()}{m.sau_chiet_khau_chua_vat()}</p>
  </div>
  {#if editable && policy && !editing}<div class="actions"><button class="btn primary" onclick={startEdit}><Pencil size={16} />{m.pc_sua_cau_hinh()}</button></div>{/if}
</section>

{#if error}
  <div class="banner error"><CircleAlert size={17} /><span>{error}</span>{#if conflict}<button class="btn small" onclick={reloadAfterConflict}>{m.pc_tai_lai()}</button>{/if}</div>
{/if}
{#if success}<div class="banner success"><CircleCheck size={17} />{success}</div>{/if}

{#if policy && editing}
  <section class="card edit-card" aria-label={m.pc_sua_cau_hinh()}>
    <header class="card-head head"><h2>{m.pc_sua_cau_hinh()}</h2></header>
    <p class="notice"><Info size={16} />{m.pc_ap_dung_ghi_chu()}</p>
    <div class="form-grid">
      <div class="field">
        <label for="pc-cap">{m.pc_tran_ck()}</label>
        <NumberInput id="pc-cap" decimals={2} bind:value={draft.discountCapRate} aria-invalid={Boolean(errors.discountCapRate)} />
        {#if errors.discountCapRate}<span class="error">{errors.discountCapRate}</span>{:else}<span class="hint">{m.tong_ck_mot_dong_hang_khong()}</span>{/if}
      </div>
      <div class="field">
        <label for="pc-period">{m.pc_ky_tinh()}</label>
        <select id="pc-period" bind:value={draft.salesTierPeriod}>
          <option value="ROLLING_90D">{m.ky_90_ngay_gan_nhat()}</option>
          <option value="QUARTER">{m.pc_ky_quy()}</option>
        </select>
      </div>
      {#each TIERS as tier}
        <div class="field">
          <label for={`pc-tier-${tier}`}>{m.chiet_khau_theo_cap()} · {tierLabel[tier] ?? tier} (%)</label>
          <NumberInput id={`pc-tier-${tier}`} decimals={2} bind:value={draft.customerTierDiscounts[tier]} aria-invalid={Boolean(errors[`customerTierDiscounts.${tier}`])} />
          {#if errors[`customerTierDiscounts.${tier}`]}<span class="error">{errors[`customerTierDiscounts.${tier}`]}</span>{/if}
        </div>
      {/each}
    </div>

    <div class="table-wrap">
      <table class="table tiers-edit">
        <thead><tr><th>{m.bac()}</th><th class="num">{m.doanh_so_luy_ke_tu()} (đ)</th><th class="num">{m.chiet_khau_them()} (%)</th><th class="actions-col"><span class="sr-only">{m.crud_thao_tac()}</span></th></tr></thead>
        <tbody>
          {#each draft.salesTiers as tier, index}
            <tr>
              <td>{m.bac()} {index + 1}</td>
              <td class="num">
                <NumberInput class="input right" bind:value={tier.minimumRevenue} aria-label={`${m.doanh_so_luy_ke_tu()} ${index + 1}`} aria-invalid={Boolean(errors[`salesTiers.${index}.minimumRevenue`])} />
                {#if errors[`salesTiers.${index}.minimumRevenue`]}<small class="error">{errors[`salesTiers.${index}.minimumRevenue`]}</small>{/if}
              </td>
              <td class="num">
                <NumberInput class="input right rate" decimals={2} bind:value={tier.discountRate} aria-label={`${m.chiet_khau_them()} ${index + 1}`} aria-invalid={Boolean(errors[`salesTiers.${index}.discountRate`])} />
                {#if errors[`salesTiers.${index}.discountRate`]}<small class="error">{errors[`salesTiers.${index}.discountRate`]}</small>{/if}
              </td>
              <td class="row-actions"><button class="icon-btn danger" title={m.pc_xoa_bac()} aria-label={`${m.pc_xoa_bac()} ${index + 1}`} onclick={() => draft.salesTiers.splice(index, 1)}><Trash2 size={15} /></button></td>
            </tr>
          {:else}<tr class="empty-row"><td colspan="4">{m.pc_chua_co_bac()}</td></tr>{/each}
        </tbody>
      </table>
    </div>
    {#if errors.salesTiers}<p class="error pad">{errors.salesTiers}</p>{/if}
    <footer class="edit-actions">
      <button class="btn small" onclick={addTier} disabled={draft.salesTiers.length >= 10}><Plus size={15} />{m.pc_them_bac()}</button>
      <span class="spacer"></span>
      <button class="btn" onclick={() => { editing = false; errors = {}; error = ''; }}>{m.huy()}</button>
      <button class="btn primary" onclick={save} disabled={saving}>{saving ? m.kh_dang_luu() : m.pc_luu_cau_hinh()}</button>
    </footer>
  </section>
{/if}

{#if policy}
  <section class="kpis">
    <article class="card kpi"><p class="label">{m.tran_chiet_khau()}</p><p class="value">{rate(policy.discountCapRate)}</p><p class="note">{m.tong_ck_mot_dong_hang_khong()}</p></article>
    <article class="card kpi"><p class="label">{m.thue_gtgt_mac_dinh()}</p><p class="value">{policy.taxRate === 'KCT' ? 'KCT' : `${policy.taxRate}%`}</p><p class="note">{policy.pricesIncludeTax === false ? m.gia_bang_gia_la_gia_chua() : m.gia_bang_gia_da_gom_thue()}</p></article>
    <article class="card kpi"><p class="label">{m.nguong_duyet_don_ban()}</p><p class="value">{vnd(policy.approval.orderValueThreshold)}</p><p class="note">{m.don_tu_muc_nay_chuyen_truong()}</p></article>
    <article class="card kpi"><p class="label">{m.nguong_duyet_don_mua()}</p><p class="value">{vnd(policy.approval.purchaseOrderThreshold)}</p><p class="note">{m.don_mua_tu_muc_nay_can()}</p></article>
  </section>

  <section class="split">
    <article class="card">
      <header class="card-head head"><h2>{m.bac_doanh_so_luy_ke()}{periodText(policy.salesTierPeriod)})</h2></header>
      <table class="table">
        <thead><tr><th>{m.bac()}</th><th class="num">{m.doanh_so_luy_ke_tu()}</th><th class="num">{m.chiet_khau_them()}</th></tr></thead>
        <tbody>
          <tr><td>{m.chua_dat_bac()}</td><td class="num">0</td><td class="num">0%</td></tr>
          {#each policy.salesTiers as tier, index}<tr><td>{m.bac()} {index + 1}</td><td class="num">{num(tier.minimumRevenue)}</td><td class="num"><b>{rate(tier.discountRate)}</b></td></tr>{/each}
        </tbody>
      </table>
      <header class="card-head head"><h2>{m.chiet_khau_theo_cap()}</h2></header>
      <table class="table">
        <tbody>
          {#each Object.entries(policy.tierRates) as [tier, value]}<tr><td>{tierLabel[tier] ?? tier}</td><td class="num">{rate(value)}</td></tr>{/each}
        </tbody>
      </table>
      <p class="hint">{m.chenh_lech_giua_cac_cap_da()}</p>
      {#if policy.updatedBy && policy.updatedAt}<p class="hint updated">{m.pc_cap_nhat_luc({ at: dateTime(policy.updatedAt), by: policy.updatedBy })}</p>{/if}
    </article>

    <article class="card">
      <header class="card-head head"><h2>{m.tien_do_dat_bac_cua_dai()}</h2></header>
      <div class="table-wrap">
        <table class="table">
          <thead><tr><th>{m.dai_ly()}</th><th>{m.cap()}</th><th class="num">{m.doanh_so_luy_ke()}</th><th class="num">{m.ck_hien_huong()}</th><th>{m.bac_ke_tiep()}</th></tr></thead>
          <tbody>
            {#each policy.dealerProgress as row}
              <tr>
                <td><span class="code">{row.code}</span><small>{row.name}</small></td>
                <td class="muted" style="white-space:nowrap">{tierLabel[row.tier] ?? row.tier}</td>
                <td class="num"><b>{num(row.revenue)}</b></td>
                <td class="num"><span class="pill" class:success={Number(row.currentRate) > 0} class:neutral={Number(row.currentRate) === 0}>{rate(row.currentRate)}</span></td>
                <td>
                  {#if row.nextThreshold}
                    <div class="progress"><span style={`width:${Math.min(100, (Number(row.revenue) / Number(row.nextThreshold)) * 100)}%`}></span></div>
                    <small>{m.con()} {num(Number(row.nextThreshold) - Number(row.revenue))} {m.de_dat()} {rate(row.nextRate)}</small>
                  {:else}<span class="pill success">{m.da_dat_bac_cao_nhat()}</span>{/if}
                </td>
              </tr>
            {:else}<tr class="empty-row"><td colspan="5">{m.chua_co_doanh_so_trong_ky()}</td></tr>{/each}
          </tbody>
        </table>
      </div>
    </article>
  </section>
{/if}

<style>
  .split { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1.6fr); gap: 18px; align-items: start; }
  .head { padding-bottom: 12px; }
  .hint { margin: 0; padding: 12px 20px 18px; color: var(--subtle); font-size: 12.5px; }
  .hint.updated { padding-top: 0; }
  .progress { width: 160px; height: 7px; border-radius: 4px; background: var(--line-soft); }
  .progress span { display: block; height: 100%; border-radius: 4px; background: var(--navy-2); }
  .edit-card { margin-bottom: 18px; }
  .notice { display: flex; align-items: flex-start; gap: 8px; margin: 0 20px 14px; padding: 10px 12px; border-radius: 8px; background: var(--blue-soft); color: var(--navy); font-size: 13px; }
  .notice :global(svg) { flex: none; margin-top: 2px; }
  .form-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(min(100%, 220px), 1fr)); gap: 14px 16px; padding: 0 20px 16px; }
  .tiers-edit td { vertical-align: top; }
  .tiers-edit td :global(.input) { display: block; max-width: 220px; margin-left: auto; }
  .tiers-edit td :global(.rate) { max-width: 120px; }
  .tiers-edit small.error { display: block; margin-top: 4px; }
  .actions-col { width: 60px; }
  .error.pad { margin: 8px 20px 0; }
  .edit-actions { display: flex; flex-wrap: wrap; align-items: center; gap: 10px; padding: 14px 20px 18px; border-top: 1px solid var(--line-soft); }
  .spacer { flex: 1; }
  @media (max-width: 1100px) { .split { grid-template-columns: 1fr; } }
</style>
