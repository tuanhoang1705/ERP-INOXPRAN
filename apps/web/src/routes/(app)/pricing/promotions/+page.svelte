<script lang="ts">
  /**
   * Chương trình khuyến mãi. Giám đốc / kế toán thêm, sửa, dừng hoặc chạy lại; không xóa vì CTKM đã dùng có mã trên dòng phiếu bán.
   * CTKM dừng / sửa chỉ ảnh hưởng phiếu lập (hoặc sửa) sau đó — phiếu đã lập giữ nguyên mức đã tính.
   */
  import { m } from '$lib/paraglide/messages';
  import { intlLocale } from '$lib/i18n';
  import { onMount } from 'svelte';
  import { CircleAlert, CircleCheck, Pause, Pencil, Play, Plus } from 'lucide-svelte';
  import { api } from '$lib/api';
  import { date } from '$lib/format';
  import { tierLabel } from '$lib/labels';
  import { can } from '$lib/permissions';
  import Dialog from '$lib/components/Dialog.svelte';
  import PromotionDialog, { type EditablePromotion } from '$lib/components/PromotionDialog.svelte';

  type Promotion = EditablePromotion & {
    status: string; categoryNames: string[]; state: 'RUNNING' | 'UPCOMING' | 'EXPIRED' | 'INACTIVE';
  };
  type Category = { id: string; code: string; name: string; status?: string };
  const stateLabel = { RUNNING: { label: m.dang_ap_dung(), tone: 'success' }, UPCOMING: { label: m.sap_dien_ra(), tone: '' }, EXPIRED: { label: m.da_ket_thuc(), tone: 'neutral' }, INACTIVE: { label: m.tam_dung(), tone: 'danger' } };
  let rows = $state<Promotion[]>([]);
  let categories = $state<Category[]>([]);
  let cap = $state(15);
  let loading = $state(true);
  let error = $state('');
  let success = $state('');
  const editable = $derived(can.editPricing());

  let dialogOpen = $state(false);
  let editing = $state<Promotion | null>(null);
  let stopOpen = $state(false);
  let stopTarget = $state<Promotion | null>(null);
  let busy = $state(false);

  async function load() {
    try {
      rows = await api<Promotion[]>('/promotions');
    } catch (caught) {
      error = caught instanceof Error ? caught.message : m.khong_tai_duoc_chuong_trinh_khuyen();
    } finally {
      loading = false;
    }
  }
  onMount(() => {
    void load();
    if (can.editPricing()) {
      void api<Category[]>('/product-categories?all=1').then((list) => (categories = list)).catch(() => undefined);
      void api<{ discountCapRate: string }>('/pricing/policy').then((policy) => (cap = Number(policy.discountCapRate))).catch(() => undefined);
    }
  });
  const daysLeft = (value: string) => Math.ceil((new Date(value).getTime() - Date.now()) / 86_400_000);

  async function setStatus(row: Promotion, action: 'stop' | 'resume') {
    busy = true;
    error = '';
    success = '';
    try {
      await api(`/promotions/${row.id}/${action}`, { method: 'POST' });
      success = action === 'stop' ? m.pc_da_dung({ code: row.code }) : m.pc_da_chay_lai({ code: row.code });
      stopOpen = false;
      await load();
    } catch (caught) {
      error = caught instanceof Error ? caught.message : m.crud_loi_luu();
    } finally {
      busy = false;
    }
  }
</script>

<svelte:head><title>{m.chuong_trinh_khuyen_mai_inoxpran_erp()}</title></svelte:head>

<section class="page-head">
  <div>
    <nav class="crumbs" aria-label={m.duong_dan()}><a href="/pricing">{m.gia_khuyen_mai()}</a><span>{m.chuong_trinh_khuyen_mai()}</span></nav>
    <h1 class="page-title">{m.chuong_trinh_khuyen_mai()}</h1>
    <p class="page-sub">{m.chuong_trinh_gan_voi_nhom_san()}</p>
  </div>
  {#if editable}<div class="actions"><button class="btn primary" onclick={() => { editing = null; dialogOpen = true; }}><Plus size={16} />{m.pc_them_ctkm()}</button></div>{/if}
</section>

{#if error}<div class="banner error"><CircleAlert size={17} />{error}</div>{/if}
{#if success}<div class="banner success"><CircleCheck size={17} />{success}</div>{/if}

<section class="card">
  <div class="table-wrap">
    <table class="table">
      <thead><tr><th>{m.ma_ctkm()}</th><th>{m.ten_chuong_trinh()}</th><th class="num">{m.muc_giam()}</th><th>{m.ap_dung_cho_nhom_hang()}</th><th>{m.cap_khach()}</th><th>{m.hieu_luc()}</th><th>{m.trang_thai()}</th>{#if editable}<th class="actions-col"><span class="sr-only">{m.crud_thao_tac()}</span></th>{/if}</tr></thead>
      <tbody>
        {#if loading}<tr class="empty-row"><td colspan="8">{m.dang_tai()}</td></tr>
        {:else if rows.length}
          {#each rows as row (row.id)}
            {@const info = stateLabel[row.state]}
            {@const left = daysLeft(row.validTo)}
            {@const scope = [...row.categoryNames, ...(row.productSkus ?? [])]}
            <tr>
              <td class="code">{row.code}</td>
              <td>{row.name}</td>
              <td class="num"><b>{Number(row.discountRate).toLocaleString(intlLocale())}%</b></td>
              <td>{scope.length ? scope.join(', ') : m.tat_ca_san_pham()}</td>
              <td class="muted">{row.customerTiers.length ? row.customerTiers.map((tier) => tierLabel[tier] ?? tier).join(', ') : m.moi_cap_khach_hang()}</td>
              <td>{date(row.validFrom)} – {date(row.validTo)}{#if row.state === 'RUNNING' && left <= 7}<small class="soon">{m.con()} {left} {m.ngay()}</small>{/if}</td>
              <td><span class={`pill ${info.tone}`}>{info.label}</span></td>
              {#if editable}
                <td class="row-actions">
                  <button class="icon-btn" title={m.crud_sua()} aria-label={`${m.crud_sua()} ${row.code}`} onclick={() => { editing = row; dialogOpen = true; }}><Pencil size={15} /></button>
                  {#if row.status === 'ACTIVE'}
                    <button class="icon-btn danger" title={m.pc_dung()} aria-label={`${m.pc_dung()} ${row.code}`} onclick={() => { stopTarget = row; stopOpen = true; }}><Pause size={15} /></button>
                  {:else}
                    <button class="icon-btn" title={m.pc_chay_lai()} aria-label={`${m.pc_chay_lai()} ${row.code}`} disabled={busy} onclick={() => setStatus(row, 'resume')}><Play size={15} /></button>
                  {/if}
                </td>
              {/if}
            </tr>
          {/each}
        {:else}<tr class="empty-row"><td colspan="8">{m.chua_co_chuong_trinh_khuyen_mai()}</td></tr>{/if}
      </tbody>
    </table>
  </div>
</section>
<p class="hint">{m.khi_nhieu_chuong_trinh_cung_hieu()}</p>
{#if editable}<p class="hint">{m.pc_ap_dung_ghi_chu()}</p>{/if}

<PromotionDialog bind:open={dialogOpen} promotion={editing} {categories} {cap}
  onsaved={(code, created) => { success = created ? m.pc_da_them_ctkm({ code }) : m.pc_da_luu_ctkm({ code }); error = ''; void load(); }} />

<Dialog bind:open={stopOpen} title={m.pc_dung_ctkm()}>
  <p class="confirm">{stopTarget ? m.pc_xac_nhan_dung({ code: stopTarget.code }) : ''}</p>
  {#snippet footer()}
    <button type="button" class="btn" onclick={() => (stopOpen = false)}>{m.huy()}</button>
    <button type="button" class="btn danger" disabled={busy || !stopTarget} onclick={() => stopTarget && setStatus(stopTarget, 'stop')}><Pause size={15} />{m.pc_dung()}</button>
  {/snippet}
</Dialog>

<style>
  .soon { color: var(--orange) !important; font-weight: 600; }
  .hint { color: var(--subtle); font-size: 12.5px; }
  .actions-col { width: 80px; }
  .confirm { margin: 0; font-size: 14px; line-height: 1.5; }
</style>
