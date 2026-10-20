<script lang="ts" module>
  import type { ArEntryStatus } from '$lib/ar-history';
  export type ArCustomer = {
    code: string; name: string; partnerId: string; exempt: boolean; rows: number; included: number; skipped: number; afterCutoff: number;
    debit: string; receipt: string; freight: string; returns: string; balance: string; prepayment: string; fileBalance: string;
    expected?: { tongCongNo?: string; daThanhToan?: string; phiVanChuyen?: string; conLai?: string; sheet?: string; note?: string };
    overdue60: { amount: string; days: number } | null;
  };
  export type CommittedBatch = { id: string; code: string };
  export type ArAfterCutoff = { id: string; customerCode: string; date: string; type: string; typeLabel: string; documentNo: string; amount: string; status: ArEntryStatus; match?: string; description?: string };
</script>

<script lang="ts">
  /**
   * Nhập lịch sử công nợ theo khách (IMP-AR-01, 16/10/2026): file 04-cong-no-lich-su.xlsx (trích từ sổ công nợ cũ) → chạy thử với
   * ngày chốt (dòng sau ngày chốt so với ERP: phiếu BH đã có / khoản thu trùng thì bỏ qua) → xem cảnh báo tự khóa → ghi.
   */
  import { CircleAlert, FileSpreadsheet, ShieldCheck, Upload } from 'lucide-svelte';
  import { m } from '$lib/paraglide/messages';
  import { ApiRequestError, localizedErrorMessage } from '$lib/api';
  import { date, num } from '$lib/format';
  import { arStatusLabel as statusLabel, arStatusTone as statusTone } from '$lib/ar-history';
  import ErpTwinsTable, { type ErpTwin } from './ErpTwinsTable.svelte';

  type DryRun = {
    ok: boolean; cutoff: string; fileName: string;
    sheets: Array<{ name: string; title: string; rows: number; create: number; errors: number }>;
    totals: { customers: number; included: number; skipped: number; debit: string; receipt: string; freight: string; returns: string; balance: string; prepayment: string };
    customers: ArCustomer[]; afterCutoff: ArAfterCutoff[]; linked?: ErpTwin[]; twins?: ErpTwin[];
    flagged: Array<{ id: string; customerCode: string; date: string; type: string; amount: string; flags: string; source: string }>;
    warnings: string[];
    errors: Array<{ sheet: string; row: number; column: string; message: string }>;
    truncated: boolean;
  };
  let { oncommitted }: { oncommitted?: (batch: CommittedBatch) => void } = $props();

  let file = $state<File | null>(null);
  let cutoff = $state('2026-09-30');
  let result = $state<DryRun | null>(null);
  let busy = $state('');
  let error = $state('');
  let showFlags = $state(false);
  const diff = (ours: string, excel: string | undefined) => (excel === undefined ? null : Number(ours) - Number(excel));

  function csrf() {
    return decodeURIComponent(document.cookie.split('; ').find((entry) => entry.startsWith('erp_csrf='))?.split('=').slice(1).join('=') ?? '');
  }
  async function send<T>(path: string): Promise<T> {
    if (!file) throw new Error(m.imp_chon_file());
    const response = await fetch(`/api/v1${path}`, {
      method: 'POST',
      credentials: 'include',
      headers: {
        'content-type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'x-file-name': encodeURIComponent(file.name), 'x-cutoff': cutoff,
        'x-csrf-token': csrf(), 'idempotency-key': crypto.randomUUID(),
      },
      body: file,
    });
    const payload = await response.json().catch(() => ({ code: '', message: m.rw_loi_tai_len() }));
    if (!response.ok) throw new ApiRequestError(payload);
    return payload as T;
  }
  async function check() {
    busy = 'check';
    error = '';
    result = null;
    try {
      result = await send<DryRun>('/admin/import/ar-history/dry-run');
    } catch (caught) {
      error = caught instanceof ApiRequestError ? localizedErrorMessage(caught.payload) : caught instanceof Error ? caught.message : m.rw_loi_tai_len();
    } finally {
      busy = '';
    }
  }
  async function commit() {
    if (!result?.ok || !confirm(m.ar_ghi_hoi({ count: result.totals.included, customers: result.totals.customers, cutoff: date(`${result.cutoff}T12:00:00+07:00`) }))) return;
    busy = 'commit';
    error = '';
    try {
      const batch = await send<CommittedBatch>('/admin/import/ar-history/commit');
      result = null;
      file = null;
      oncommitted?.(batch);
    } catch (caught) {
      error = caught instanceof ApiRequestError ? localizedErrorMessage(caught.payload) : m.rw_loi_tai_len();
    } finally {
      busy = '';
    }
  }
</script>

<section class="card ar">
  <header class="card-head"><div><h2>{m.ar_tieu_de()}</h2><p class="sub">{m.ar_mo_ta()}</p></div></header>
  <div class="upload">
    <label class="btn file">
      <FileSpreadsheet size={16} />{file ? file.name : m.imp_chon_file()}
      <input type="file" accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" onchange={(event) => { file = event.currentTarget.files?.[0] ?? null; result = null; }} />
    </label>
    <label class="cutoff"><span>{m.ar_ngay_chot()}</span><input type="date" bind:value={cutoff} onchange={() => (result = null)} /></label>
    <button class="btn navy" disabled={!file || busy !== ''} onclick={check}><ShieldCheck size={16} />{busy === 'check' ? m.imp_dang_kiem_tra() : m.imp_kiem_tra()}</button>
    <button class="btn primary" disabled={!result?.ok || busy !== ''} onclick={commit}><Upload size={16} />{busy === 'commit' ? m.imp_dang_ghi() : m.imp_ghi()}</button>
  </div>
  <p class="hint">{m.ar_goi_y_khong_tu_khoa()}</p>
  {#if error}<div class="banner error"><CircleAlert size={17} /><span>{error}</span></div>{/if}

  {#if result}
    <div class="summary">
      <h3>{m.imp_ket_qua_kiem_tra({ file: result.fileName })} {#if result.ok}<span class="pill success">{m.imp_hop_le()}</span>{:else}<span class="pill danger">{m.imp_so_loi({ count: result.errors.length })}</span>{/if}</h3>
      <p>{m.ar_tong_ket({ customers: result.totals.customers, included: result.totals.included, skipped: result.totals.skipped, debit: num(result.totals.debit), receipt: num(result.totals.receipt), freight: num(result.totals.freight), returns: num(result.totals.returns), balance: num(result.totals.balance) })}</p>
    </div>

    {#if result.warnings.length}
      <div class="warnings">{#each result.warnings as text}<p><CircleAlert size={14} />{text}</p>{/each}</div>
    {/if}

    {#if result.errors.length}
      <div class="table-wrap errors">
        <table class="table compact">
          <thead><tr><th>Sheet</th><th class="num">{m.imp_dong()}</th><th>{m.imp_cot()}</th><th>{m.imp_loi()}</th></tr></thead>
          <tbody>{#each result.errors as row}<tr><td>{row.sheet}</td><td class="num">{row.row || '—'}</td><td>{row.column}</td><td class="bad">{row.message}</td></tr>{/each}</tbody>
        </table>
      </div>
    {/if}

    <h3>{m.ar_theo_khach()}</h3>
    <div class="table-wrap">
      <table class="table compact">
        <thead><tr><th>{m.khach_hang()}</th><th class="num">{m.ar_but_toan()}</th><th class="num">{m.cn_phat_sinh()}</th><th class="num">{m.cn_da_thu()}</th><th class="num">{m.cn_phi_vc()}</th><th class="num">{m.cn_tra_hang_giam()}</th><th class="num">{m.cn_con_lai()}</th><th class="num">{m.ar_so_cu_con_lai()}</th><th>{m.ar_canh_bao()}</th></tr></thead>
        <tbody>
          {#each result.customers as row (row.code)}
            {@const delta = diff(row.fileBalance, row.expected?.conLai)}
            <tr>
              <td class="who"><b>{row.code}</b> {row.name}{#if row.exempt}<span class="pill neutral">{m.cn_khong_tu_khoa()}</span>{/if}</td>
              <td class="num">{row.included}{#if row.skipped}<small>{m.ar_bo_qua_ngan({ count: row.skipped })}</small>{/if}</td>
              <td class="num">{num(row.debit)}</td>
              <td class="num">{num(row.receipt)}</td>
              <td class="num">{num(row.freight)}</td>
              <td class="num">{num(row.returns)}</td>
              <td class="num"><b>{num(row.balance)}</b>{#if Number(row.prepayment) > 0}<small class="credit">{m.cn_tra_truoc_ngan({ amount: num(row.prepayment) })}</small>{/if}</td>
              <td class="num">{#if row.expected?.conLai !== undefined}{num(row.expected.conLai)}{#if delta !== null && Math.abs(delta) >= 1}<small class={Math.abs(delta) <= 10 ? 'muted' : 'bad'}>{m.ar_lech({ amount: num(String(delta)) })}</small>{/if}{:else}—{/if}</td>
              <td>{#if row.overdue60 && !row.exempt}<span class="pill danger">{m.ar_se_bi_khoa({ days: row.overdue60.days })}</span>{:else if row.overdue60}<span class="pill neutral">{m.ar_qua_han_khong_khoa({ days: row.overdue60.days })}</span>{/if}</td>
            </tr>
          {/each}
        </tbody>
      </table>
    </div>

    <ErpTwinsTable linked={result.linked} twins={result.twins} />

    {#if result.afterCutoff.length}
      <h3>{m.ar_sau_ngay_chot({ cutoff: date(`${result.cutoff}T12:00:00+07:00`), count: result.afterCutoff.length })}</h3>
      <div class="table-wrap">
        <table class="table compact">
          <thead><tr><th>{m.ar_ma_dong()}</th><th>{m.imp_ma_kh()}</th><th>{m.cn_ngay()}</th><th>{m.ar_loai()}</th><th>{m.chung_tu()}</th><th class="num">{m.crm_so_tien()}</th><th>{m.trang_thai()}</th></tr></thead>
          <tbody>
            {#each result.afterCutoff as row (row.id)}
              <tr><td class="code">{row.id}</td><td>{row.customerCode}</td><td>{date(`${row.date}T12:00:00+07:00`)}</td><td>{row.typeLabel}</td><td>{row.documentNo || '—'}</td><td class="num">{num(row.amount)}</td><td><span class={`pill ${statusTone[row.status]}`}>{statusLabel(row.status)}</span>{#if row.match}<small>{row.match}</small>{/if}</td></tr>
            {/each}
          </tbody>
        </table>
      </div>
    {/if}

    {#if result.flagged.length}
      <h3><button class="link-btn" onclick={() => (showFlags = !showFlags)}>{m.ar_dong_gan_co({ count: result.flagged.length })}</button></h3>
      {#if showFlags}
        <div class="table-wrap flags">
          <table class="table compact">
            <thead><tr><th>{m.ar_ma_dong()}</th><th>{m.imp_ma_kh()}</th><th>{m.cn_ngay()}</th><th class="num">{m.crm_so_tien()}</th><th>{m.ar_co()}</th><th>{m.ar_nguon()}</th></tr></thead>
            <tbody>{#each result.flagged as row (row.id)}<tr><td class="code">{row.id}</td><td>{row.customerCode}</td><td>{date(`${row.date}T12:00:00+07:00`)}</td><td class="num">{num(row.amount)}</td><td>{row.flags}</td><td class="muted">{row.source}</td></tr>{/each}</tbody>
          </table>
        </div>
      {/if}
    {/if}
  {/if}
</section>

<style>
  .ar { margin-bottom: 16px; }
  .ar .sub { margin: 4px 0 0; color: var(--muted); font-size: 13px; }
  .upload { display: flex; flex-wrap: wrap; align-items: flex-end; gap: 10px; padding: 0 20px; }
  .file { position: relative; cursor: pointer; max-width: 420px; overflow: hidden; text-overflow: ellipsis; }
  .file input { position: absolute; inset: 0; opacity: 0; cursor: pointer; }
  .cutoff { display: grid; gap: 4px; font-size: 12.5px; color: var(--muted); }
  .hint { margin: 10px 20px 0; color: var(--subtle); font-size: 12.5px; }
  .summary { padding: 12px 20px 0; }
  .summary h3, .ar h3 { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; margin: 14px 20px 8px; font-size: 14px; }
  .summary h3 { margin: 0 0 6px; }
  .summary p { margin: 0; font-size: 13px; }
  .warnings { display: grid; gap: 4px; margin: 10px 20px 0; padding: 10px 12px; border-radius: 8px; background: var(--amber-soft); color: var(--amber); font-size: 12.5px; }
  .warnings p { display: flex; gap: 6px; margin: 0; }
  .errors, .flags { max-height: 360px; overflow-y: auto; }
  .bad { color: var(--red); font-weight: 600; }
  .credit { color: var(--green); }
  td small { display: block; color: var(--subtle); font-size: 11.5px; }
  td .pill { margin-left: 4px; }
  .compact td, .compact th { padding: 6px 10px; }
  .who { min-width: 240px; }
  .link-btn { padding: 0; border: 0; background: none; color: var(--navy-2); font: inherit; font-weight: 600; cursor: pointer; text-decoration: underline; }
  .banner { margin: 10px 20px 0; }
</style>
