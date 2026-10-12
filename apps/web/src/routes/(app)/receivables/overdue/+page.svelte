<script lang="ts">
  import { m } from '$lib/paraglide/messages';
  import { onMount } from 'svelte';
  import { CircleAlert, CircleCheck } from 'lucide-svelte';
  import { api } from '$lib/api';
  import { dateTime, num, percent, vnd } from '$lib/format';
  import { hasRole, overdueLevel } from '$lib/labels';
  import { session } from '$lib/session.svelte';

  type Aging = {
    generatedAt: string;
    totals: { current: string; d1to30: string; d31to60: string; over60: string; total: string };
    partners: Array<{
      partnerId: string; code: string; name: string; province?: string; salesRepName?: string; status: string; holdReason?: string;
      creditLimit: string; current: string; d1to30: string; d31to60: string; over60: string; total: string; maxDays: number;
      level: string | null; documents: number; creditUsage: number | null;
    }>;
    lastReview: { reviewDate: string; ranAt: string; reminder: number; warning: number; danger: number; lockedPartners: string[] } | null;
  };
  let aging = $state<Aging | null>(null);
  let loading = $state(true);
  let running = $state(false);
  let error = $state('');
  let success = $state('');
  const canRun = $derived(hasRole(session.user?.roles, ['ACCOUNTANT', 'DIRECTOR']));

  async function load() {
    loading = true;
    error = '';
    try {
      aging = await api<Aging>('/receivables/aging');
    } catch (caught) {
      error = caught instanceof Error ? caught.message : m.khong_tai_duoc_tuoi_no();
    } finally {
      loading = false;
    }
  }
  async function runReview() {
    running = true;
    error = '';
    success = '';
    try {
      const result = await api<{ reminder: number; warning: number; danger: number; lockedPartners: string[]; releasedPartners: string[] }>('/receivables/overdue-review', { method: 'POST' });
      success = m.da_ra_soat_nhac_no_canh({ reminder: result.reminder, warning: result.warning, danger: result.danger, p3: result.lockedPartners.length ? m.tam_khoa_3({ p0: result.lockedPartners.join(', ') }) : '', p4: result.releasedPartners.length ? m.mo_khoa({ p0: result.releasedPartners.join(', ') }) : '' });
      await load();
    } catch (caught) {
      error = caught instanceof Error ? caught.message : m.khong_chay_duoc_ra_soat();
    } finally {
      running = false;
    }
  }
  onMount(load);

  const buckets = $derived(aging ? [
    { label: m.trong_han(), value: aging.totals.current, tone: 'green' },
    { label: m.qua_han_1_30_ngay_nhac(), value: aging.totals.d1to30, tone: 'blue' },
    { label: m.qua_han_31_60_ngay_canh(), value: aging.totals.d31to60, tone: 'amber' },
    { label: m.qua_han_tren_60_ngay_nguy(), value: aging.totals.over60, tone: 'red' },
  ] : []);
</script>

<svelte:head><title>{m.tuoi_no_canh_bao_inoxpran_erp()}</title></svelte:head>

<section class="page-head">
  <div>
    <nav class="crumbs" aria-label={m.duong_dan()}><a href="/receivables">{m.cong_no()}</a><span>{m.tuoi_no_canh_bao_qua_han()}</span></nav>
    <h1 class="page-title">{m.tuoi_no_canh_bao_qua_han()}</h1>
    <p class="page-sub">{m.giai_thuat_3_he_thong_tu()}</p>
  </div>
  {#if canRun}<div class="actions"><button class="btn primary" disabled={running} onclick={runReview}>{running ? m.dang_ra_soat() : m.chay_ra_soat_ngay()}</button></div>{/if}
</section>

{#if error}<div class="banner error"><CircleAlert size={17} />{error}</div>{/if}
{#if success}<div class="banner success"><CircleCheck size={17} />{success}</div>{/if}
{#if aging?.lastReview}<div class="banner">{m.lan_ra_soat_gan_nhat()} {dateTime(aging.lastReview.ranAt)} — {aging.lastReview.reminder} {m.nhac_no_2()} {aging.lastReview.warning} {m.canh_bao_2()} {aging.lastReview.danger} {m.nguy_hiem_2()}</div>{/if}

<section class="kpis">
  {#each buckets as bucket}
    <article class={`card kpi bucket ${bucket.tone}`}><p class="label">{bucket.label}</p><p class="value">{vnd(bucket.value)}</p><p class="note">{aging && Number(aging.totals.total) ? percent((Number(bucket.value) / Number(aging.totals.total)) * 100) : '—'} {m.tong_du_no()}</p></article>
  {/each}
</section>

<section class="card">
  <header class="card-head head"><h2>{m.tuoi_no_theo_dai_ly()}</h2><span class="muted">{m.tong_du_no_2()} <b>{vnd(aging?.totals.total ?? 0)}</b></span></header>
  <div class="table-wrap">
    <table class="table">
      <thead><tr><th>{m.dai_ly()}</th><th class="num">{m.trong_han()}</th><th class="num">{m.t_1_30_ngay()}</th><th class="num">{m.t_31_60_ngay()}</th><th class="num">{m.t_60_ngay()}</th><th class="num">{m.tong_du_no_3()}</th><th class="num">{m.dung_han_muc()}</th><th>{m.muc_canh_bao()}</th><th>{m.dat_hang()}</th></tr></thead>
      <tbody>
        {#if loading}<tr class="empty-row"><td colspan="9">{m.dang_tinh_tuoi_no()}</td></tr>
        {:else if aging?.partners.length}
          {#each aging.partners as row}
            {@const level = row.level ? overdueLevel[row.level] : null}
            <tr>
              <td class="dealer"><a class="code" href={`/receivables?partnerId=${row.partnerId}`}>{row.code} — {row.name}</a><small>{row.province ?? ''}{row.salesRepName ? ` · NV: ${row.salesRepName}` : ''}</small></td>
              <td class="num">{num(row.current)}</td>
              <td class="num">{num(row.d1to30)}</td>
              <td class="num" class:amber={Number(row.d31to60) > 0}>{num(row.d31to60)}</td>
              <td class="num" class:red={Number(row.over60) > 0}>{num(row.over60)}</td>
              <td class="num"><b>{num(row.total)}</b></td>
              <td class="num" class:red={(row.creditUsage ?? 0) > 100}>{row.creditUsage === null ? '—' : percent(row.creditUsage)}</td>
              <td>{#if level}<span class={`pill ${level.tone}`}>{level.label} · {row.maxDays} {m.ngay()}</span>{:else}<span class="pill success">{m.trong_han()}</span>{/if}</td>
              <td>{#if row.status === 'ON_HOLD'}<span class="pill danger">{m.tam_khoa_2()}</span>{:else}<span class="pill neutral">{m.binh_thuong()}</span>{/if}</td>
            </tr>
          {/each}
        {:else}<tr class="empty-row"><td colspan="9">{m.khong_co_cong_no_dang_mo()}</td></tr>{/if}
      </tbody>
    </table>
  </div>
</section>

<style>
  .bucket { border-top: 4px solid var(--green); }
  .bucket.blue { border-top-color: var(--navy-2); }
  .bucket.amber { border-top-color: var(--amber); }
  .bucket.red { border-top-color: var(--red); }
  .head { padding-bottom: 14px; }
  .dealer { min-width: 250px; white-space: nowrap; }
  td :global(.pill) { white-space: nowrap; }
  .amber { color: var(--amber); font-weight: 600; }
  .red { color: var(--red); font-weight: 700; }
</style>
