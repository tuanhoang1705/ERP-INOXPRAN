<script lang="ts">
  /**
   * Nhập dữ liệu ban đầu từ Excel (giai đoạn 5): tải file mẫu → chạy thử (báo lỗi theo dòng / cột) → ghi vào hệ thống
   * → đối chiếu số liệu → kế toán và Giám đốc xác nhận. Mỗi lần ghi là một lô, hoàn tác được khi chưa phát sinh chứng từ.
   */
  import { onMount } from 'svelte';
  import { CircleAlert, CircleCheck, Download, FileSpreadsheet, RotateCcw, ShieldCheck, Upload } from 'lucide-svelte';
  import { m } from '$lib/paraglide/messages';
  import { api, ApiRequestError, download, localizedErrorMessage } from '$lib/api';
  import { dateTime, num, vnd } from '$lib/format';
  import { hasRole } from '$lib/labels';
  import { session } from '$lib/session.svelte';
  import Dialog from '$lib/components/Dialog.svelte';
  import Pagination from '$lib/components/Pagination.svelte';

  type SheetSummary = { name: string; title: string; rows: number; create: number; update: number; errors: number };
  type Totals = { stockQuantity: string; stockValue: string; stockWithoutCost: number; receivablesAmount: string; receivablesByCustomer: Array<{ code: string; amount: string }> };
  type DryRun = { ok: boolean; fileName: string; sha256: string; sheets: SheetSummary[]; totals: Totals; errors: Array<{ sheet: string; row: number; column: string; message: string }>; truncated: boolean };
  type Batch = {
    id: string; code: string; fileName: string; status: 'COMMITTED' | 'ROLLED_BACK'; sheets: SheetSummary[]; totals: Totals;
    createdCount: number; updatedCount: number; openingCount: number; receivableCount: number; createdByName: string; createdAt: string;
    confirmations: Array<{ role: string; name: string; at: string }>; rolledBackAt?: string; rolledBackByName?: string;
  };
  type Report = {
    batch: Batch;
    records: Array<{ collection: string; expected: number; actual: number; ok: boolean }>;
    stock: Array<{ warehouse: string; lines: number; importedQuantity: string; currentQuantity: string; importedValue: string; ok: boolean }>;
    receivables: { fileTotal: string; imported: string; outstanding: string; documents: number; ok: boolean; byCustomer: Array<{ code: string; amount: string }> };
  };

  const roles = $derived(session.user?.roles ?? []);
  const canImport = $derived(hasRole(roles, ['DIRECTOR']));
  // Trang chỉ dành cho quản trị gốc: quản trị gốc ghi nhận đã đối chiếu.
  const canConfirm = $derived(Boolean(session.user?.root) || roles.includes('DIRECTOR') || roles.includes('ACCOUNTANT'));
  let file = $state<File | null>(null);
  let result = $state<DryRun | null>(null);
  let busy = $state('');
  let error = $state('');
  let success = $state('');
  let batches = $state<Batch[]>([]);
  let total = $state(0);
  let page = $state(1);
  let pageSize = $state(20);
  let report = $state<Report | null>(null);
  let reportOpen = $state(false);
  const collectionLabel = (value: string) => ({ product_categories: m.imp_nhom_hang(), regions: m.imp_khu_vuc(), employees: m.imp_nvkd(), partners: m.imp_doi_tac(), products: m.imp_san_pham() })[value] ?? value;
  const roleLabel = (value: string) => (value === 'ROOT' ? m.imp_role_root() : value === 'DIRECTOR' ? m.ban_giam_doc() : m.imp_ke_toan());

  async function loadBatches() {
    try {
      const data = await api<{ rows: Batch[]; total: number }>(`/admin/import/batches?page=${page}&pageSize=${pageSize}`);
      batches = data.rows;
      total = data.total;
    } catch (caught) {
      error = caught instanceof Error ? caught.message : m.rw_loi_tai();
    }
  }
  onMount(loadBatches);

  function csrf() {
    return decodeURIComponent(document.cookie.split('; ').find((entry) => entry.startsWith('erp_csrf='))?.split('=').slice(1).join('=') ?? '');
  }
  async function send<T>(path: string): Promise<T> {
    if (!file) throw new Error(m.imp_chon_file());
    const response = await fetch(`/api/v1${path}`, {
      method: 'POST',
      credentials: 'include',
      headers: { 'content-type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'x-file-name': encodeURIComponent(file.name), 'x-csrf-token': csrf(), 'idempotency-key': crypto.randomUUID() },
      body: file,
    });
    const payload = await response.json().catch(() => ({ code: '', message: m.rw_loi_tai_len() }));
    if (!response.ok) throw new ApiRequestError(payload);
    return payload as T;
  }

  async function check() {
    busy = 'check';
    error = '';
    success = '';
    result = null;
    try {
      result = await send<DryRun>('/admin/import/dry-run');
    } catch (caught) {
      error = caught instanceof ApiRequestError ? localizedErrorMessage(caught.payload) : caught instanceof Error ? caught.message : m.rw_loi_tai_len();
    } finally {
      busy = '';
    }
  }
  async function commit() {
    if (!result?.ok || !confirm(m.imp_ghi_hoi())) return;
    busy = 'commit';
    error = '';
    try {
      const batch = await send<Batch>('/admin/import/commit');
      success = m.imp_da_ghi({ code: batch.code });
      result = null;
      file = null;
      page = 1;
      await loadBatches();
      await openReport(batch);
    } catch (caught) {
      error = caught instanceof ApiRequestError ? localizedErrorMessage(caught.payload) : m.rw_loi_tai_len();
    } finally {
      busy = '';
    }
  }
  async function openReport(batch: Batch) {
    try {
      report = await api<Report>(`/admin/import/batches/${batch.id}/report`);
      reportOpen = true;
    } catch (caught) {
      error = caught instanceof Error ? caught.message : m.rw_loi_tai();
    }
  }
  async function confirmBatch() {
    if (!report) return;
    try {
      await api(`/admin/import/batches/${report.batch.id}/confirm`, { method: 'POST' });
      await openReport(report.batch);
      await loadBatches();
    } catch (caught) {
      error = caught instanceof Error ? caught.message : m.crud_loi_luu();
    }
  }
  async function rollback(batch: Batch) {
    if (!confirm(m.imp_hoan_tac_hoi({ code: batch.code }))) return;
    busy = batch.id;
    error = '';
    success = '';
    try {
      await api(`/admin/import/batches/${batch.id}/rollback`, { method: 'POST' });
      success = m.imp_da_hoan_tac({ code: batch.code });
      await loadBatches();
    } catch (caught) {
      error = caught instanceof Error ? caught.message : m.crud_loi_luu();
    } finally {
      busy = '';
    }
  }
</script>

<svelte:head><title>{m.imp_title()} · INOXPRAN ERP</title></svelte:head>

<section class="page-head">
  <div>
    <nav class="crumbs" aria-label={m.duong_dan()}><a href="/admin/system">{m.quan_tri()}</a><span>{m.imp_title()}</span></nav>
    <h1 class="page-title">{m.imp_title()}</h1>
    <p class="page-sub">{m.imp_mo_ta()}</p>
  </div>
  {#if canImport}<div class="actions"><button class="btn" onclick={() => download('/admin/import/template', 'INOXPRAN-nhap-du-lieu.xlsx')}><Download size={16} />{m.imp_tai_mau()}</button></div>{/if}
</section>

{#if error}<div class="banner error"><CircleAlert size={17} /><span>{error}</span></div>{/if}
{#if success}<div class="banner success"><CircleCheck size={17} />{success}</div>{/if}

{#if canImport}
  <section class="card steps">
    <ol>
      <li><b>1</b>{m.imp_buoc_1()}</li>
      <li><b>2</b>{m.imp_buoc_2()}</li>
      <li><b>3</b>{m.imp_buoc_3()}</li>
      <li><b>4</b>{m.imp_buoc_4()}</li>
    </ol>
    <div class="upload">
      <label class="btn">
        <FileSpreadsheet size={16} />{file ? file.name : m.imp_chon_file()}
        <input type="file" accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" onchange={(event) => { file = event.currentTarget.files?.[0] ?? null; result = null; }} />
      </label>
      <button class="btn navy" disabled={!file || busy !== ''} onclick={check}><ShieldCheck size={16} />{busy === 'check' ? m.imp_dang_kiem_tra() : m.imp_kiem_tra()}</button>
      <button class="btn primary" disabled={!result?.ok || busy !== ''} onclick={commit}><Upload size={16} />{busy === 'commit' ? m.imp_dang_ghi() : m.imp_ghi()}</button>
    </div>
  </section>

  {#if result}
    <section class="card result">
      <header class="card-head"><h2>{m.imp_ket_qua_kiem_tra({ file: result.fileName })}</h2>{#if result.ok}<span class="pill success">{m.imp_hop_le()}</span>{:else}<span class="pill danger">{m.imp_so_loi({ count: result.errors.length })}</span>{/if}</header>
      <div class="table-wrap">
        <table class="table">
          <thead><tr><th>Sheet</th><th class="num">{m.imp_so_dong()}</th><th class="num">{m.imp_them_moi()}</th><th class="num">{m.imp_cap_nhat()}</th><th class="num">{m.imp_loi()}</th></tr></thead>
          <tbody>
            {#each result.sheets as sheet}<tr><td><b>{sheet.title}</b><small>{sheet.name}</small></td><td class="num">{num(sheet.rows)}</td><td class="num">{num(sheet.create)}</td><td class="num">{num(sheet.update)}</td><td class="num" class:bad={sheet.errors > 0}>{num(sheet.errors)}</td></tr>
            {:else}<tr class="empty-row"><td colspan="5">{m.imp_file_trong()}</td></tr>{/each}
          </tbody>
        </table>
      </div>
      <div class="totals">
        <span>{m.imp_tong_ton({ quantity: num(result.totals.stockQuantity), value: vnd(result.totals.stockValue) })}</span>
        {#if result.totals.stockWithoutCost}<span class="warn">{m.imp_ton_chua_gia_von({ count: result.totals.stockWithoutCost })}</span>{/if}
        <span>{m.imp_tong_cong_no({ amount: vnd(result.totals.receivablesAmount), customers: result.totals.receivablesByCustomer.length })}</span>
      </div>
      {#if result.errors.length}
        <div class="table-wrap errors">
          <table class="table">
            <thead><tr><th>Sheet</th><th class="num">{m.imp_dong()}</th><th>{m.imp_cot()}</th><th>{m.imp_loi()}</th></tr></thead>
            <tbody>{#each result.errors as row}<tr><td>{row.sheet}</td><td class="num">{row.row || '—'}</td><td>{row.column}</td><td class="bad">{row.message}</td></tr>{/each}</tbody>
          </table>
        </div>
        {#if result.truncated}<p class="hint">{m.imp_qua_nhieu_loi()}</p>{/if}
      {/if}
    </section>
  {/if}
{/if}

<section class="card">
  <header class="card-head"><h2>{m.imp_lich_su()}</h2></header>
  <div class="table-wrap">
    <table class="table">
      <thead><tr><th>{m.imp_lo()}</th><th>File</th><th class="num">{m.imp_them_moi()}</th><th class="num">{m.imp_cap_nhat()}</th><th class="num">{m.imp_ton_dau_ky()}</th><th class="num">{m.imp_cong_no()}</th><th>{m.imp_nguoi_ghi()}</th><th>{m.imp_xac_nhan()}</th><th>{m.trang_thai()}</th><th></th></tr></thead>
      <tbody>
        {#each batches as batch (batch.id)}
          <tr class:muted={batch.status === 'ROLLED_BACK'}>
            <td class="code">{batch.code}</td>
            <td>{batch.fileName}<small>{dateTime(batch.createdAt)}</small></td>
            <td class="num">{num(batch.createdCount)}</td>
            <td class="num">{num(batch.updatedCount)}</td>
            <td class="num">{num(batch.openingCount)}</td>
            <td class="num">{num(batch.receivableCount)}</td>
            <td>{batch.createdByName}</td>
            <td>{#each batch.confirmations as row}<span class="pill success">{roleLabel(row.role)}</span>{:else}<span class="muted">—</span>{/each}</td>
            <td>{#if batch.status === 'COMMITTED'}<span class="pill">{m.imp_da_ghi_trang_thai()}</span>{:else}<span class="pill neutral">{m.imp_da_hoan_tac_trang_thai()}</span><small>{batch.rolledBackByName}</small>{/if}</td>
            <td>
              <div class="batch-actions">
              <button class="btn small" onclick={() => openReport(batch)}>{m.imp_doi_chieu()}</button>
              {#if canImport && batch.status === 'COMMITTED'}<button class="btn small" disabled={busy === batch.id} onclick={() => rollback(batch)}><RotateCcw size={14} />{m.imp_hoan_tac()}</button>{/if}
              </div>
            </td>
          </tr>
        {:else}<tr class="empty-row"><td colspan="10">{m.imp_chua_co_lo()}</td></tr>{/each}
      </tbody>
    </table>
  </div>
  {#if total > pageSize}<Pagination {page} {pageSize} {total} onchange={(next, size) => { page = next; pageSize = size; void loadBatches(); }} />{/if}
</section>

<Dialog bind:open={reportOpen} title={report ? m.imp_doi_chieu_lo({ code: report.batch.code }) : ''} wide>
  {#if report}
    <div class="report">
      <h3>{m.imp_ho_so()}</h3>
      <table class="table">
        <thead><tr><th>{m.imp_loai_du_lieu()}</th><th class="num">{m.imp_theo_file()}</th><th class="num">{m.imp_trong_he_thong()}</th><th></th></tr></thead>
        <tbody>{#each report.records as row}<tr><td>{collectionLabel(row.collection)}</td><td class="num">{num(row.expected)}</td><td class="num">{num(row.actual)}</td><td>{#if row.ok}<span class="pill success">{m.imp_khop()}</span>{:else}<span class="pill danger">{m.imp_lech()}</span>{/if}</td></tr>
        {:else}<tr class="empty-row"><td colspan="4">{m.imp_khong_them_moi()}</td></tr>{/each}</tbody>
      </table>
      <h3>{m.imp_ton_dau_ky()}</h3>
      <table class="table">
        <thead><tr><th>{m.kho()}</th><th class="num">{m.imp_so_ma()}</th><th class="num">{m.imp_sl_nhap()}</th><th class="num">{m.imp_sl_hien_tai()}</th><th class="num">{m.imp_gia_tri()}</th><th></th></tr></thead>
        <tbody>{#each report.stock as row}<tr><td>{row.warehouse}</td><td class="num">{num(row.lines)}</td><td class="num">{num(row.importedQuantity)}</td><td class="num">{num(row.currentQuantity)}</td><td class="num">{vnd(row.importedValue)}</td><td>{#if row.ok}<span class="pill success">{m.imp_khop()}</span>{:else}<span class="pill warning">{m.imp_da_phat_sinh()}</span>{/if}</td></tr>
        {:else}<tr class="empty-row"><td colspan="6">{m.imp_khong_co_ton()}</td></tr>{/each}</tbody>
      </table>
      <h3>{m.imp_cong_no_dau_ky()}</h3>
      <p class="line">{m.imp_cong_no_doi_chieu({ file: vnd(report.receivables.fileTotal), imported: vnd(report.receivables.imported), outstanding: vnd(report.receivables.outstanding), documents: report.receivables.documents })} {#if report.receivables.ok}<span class="pill success">{m.imp_khop()}</span>{:else}<span class="pill danger">{m.imp_lech()}</span>{/if}</p>
      {#if report.receivables.byCustomer.length}
        <table class="table compact"><thead><tr><th>{m.imp_ma_kh()}</th><th class="num">{m.crm_so_tien()}</th></tr></thead><tbody>{#each report.receivables.byCustomer as row}<tr><td>{row.code}</td><td class="num">{vnd(row.amount)}</td></tr>{/each}</tbody></table>
      {/if}
      <h3>{m.imp_xac_nhan()}</h3>
      <p class="line">{#each report.batch.confirmations as row}<span class="pill success">{roleLabel(row.role)}: {row.name} · {dateTime(row.at)}</span> {:else}{m.imp_chua_xac_nhan()}{/each}</p>
    </div>
  {/if}
  {#snippet footer()}
    <button class="btn" onclick={() => (reportOpen = false)}>{m.dong()}</button>
    {#if report && canConfirm && report.batch.status === 'COMMITTED'}<button class="btn primary" onclick={confirmBatch}><ShieldCheck size={15} />{m.imp_xac_nhan_doi_chieu()}</button>{/if}
  {/snippet}
</Dialog>

<style>
  .steps { margin-bottom: 16px; padding: 16px 20px; }
  .steps ol { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 12px; margin: 0 0 16px; padding: 0; list-style: none; }
  .steps li { display: flex; gap: 10px; color: var(--muted); font-size: 13px; }
  .steps li b { display: grid; flex: none; width: 24px; height: 24px; place-items: center; border-radius: 50%; background: var(--blue-soft); color: var(--navy); font-size: 12px; }
  .upload { display: flex; flex-wrap: wrap; gap: 10px; }
  .upload label { position: relative; cursor: pointer; max-width: 420px; overflow: hidden; text-overflow: ellipsis; }
  .upload input { position: absolute; inset: 0; opacity: 0; cursor: pointer; }
  .result { margin-bottom: 16px; }
  .totals { display: flex; flex-wrap: wrap; gap: 8px 20px; padding: 12px 20px; border-top: 1px solid var(--line-soft); font-size: 13px; }
  .warn { color: var(--amber); }
  .errors { max-height: 420px; overflow-y: auto; border-top: 1px solid var(--line-soft); }
  .bad { color: var(--red); font-weight: 600; }
  .hint { margin: 0; padding: 8px 20px 14px; color: var(--subtle); font-size: 12.5px; }
  tr.muted td { color: var(--subtle); }
  .batch-actions { display: flex; justify-content: flex-end; gap: 6px; white-space: nowrap; }
  .report h3 { margin: 14px 0 8px; font-size: 14px; }
  .report h3:first-child { margin-top: 0; }
  .report .line { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; margin: 0 0 8px; font-size: 13px; }
  .compact td, .compact th { padding: 6px 10px; }
  @media (max-width: 900px) { .steps ol { grid-template-columns: 1fr 1fr; } }
</style>
