<script lang="ts">
  import { m } from '$lib/paraglide/messages';
  import { onMount } from 'svelte';
  import { CircleAlert, CircleCheck, Pencil, Plus, Trash2 } from 'lucide-svelte';
  import { api } from '$lib/api';
  import { can } from '$lib/permissions';
  import ConfirmDelete from '$lib/components/ConfirmDelete.svelte';
  import RecordDialog, { type RecordValues } from '$lib/components/RecordDialog.svelte';

  type Region = { id: string; code: string; name: string; sortOrder?: number; dealerCount: number };
  type Employee = { id: string; code: string; name: string; title: string; role: 'SALES' | 'SALES_MANAGER'; regionCode?: string | null; phone?: string; status: 'ACTIVE' | 'INACTIVE'; dealerCount: number; userId?: string | null; userEmail?: string };
  type LinkableUser = { id: string; email: string; displayName: string };
  let regions = $state<Region[]>([]);
  let employees = $state<Employee[]>([]);
  let loading = $state(true);
  let error = $state('');
  let success = $state('');
  const editable = $derived(can.editSalesStructure());

  let regionOpen = $state(false);
  let editingRegion = $state<Region | null>(null);
  let employeeOpen = $state(false);
  let editingEmployee = $state<Employee | null>(null);
  let deleteOpen = $state(false);
  let deleteTarget = $state<{ kind: 'region'; row: Region } | { kind: 'employee'; row: Employee } | null>(null);

  /** Tài khoản đăng nhập kinh doanh để gắn với hồ sơ NVKD (khách do tài khoản đó tạo tự gán NVKD phụ trách). */
  let linkableUsers = $state<LinkableUser[]>([]);

  async function load() {
    try {
      [regions, employees] = await Promise.all([api<Region[]>('/regions'), api<Employee[]>('/employees')]);
      if (editable) linkableUsers = await api<LinkableUser[]>('/employees/linkable-users').catch(() => []);
    } catch (caught) {
      error = caught instanceof Error ? caught.message : m.khong_tai_duoc_khu_vuc();
    } finally {
      loading = false;
    }
  }
  onMount(load);

  const regionFields = $derived([
    { key: 'code', label: m.crud_ma_khu_vuc(), type: 'code' as const, required: true, readonly: Boolean(editingRegion), hint: editingRegion ? m.crud_ma_khu_vuc_khong_doi() : undefined },
    { key: 'name', label: m.ten_khu_vuc(), required: true, maxlength: 120 },
    { key: 'sortOrder', label: m.crud_thu_tu(), type: 'digits' as const },
  ]);
  const regionValues = $derived<RecordValues>(editingRegion
    ? { code: editingRegion.code, name: editingRegion.name, sortOrder: String(editingRegion.sortOrder ?? '') }
    : { sortOrder: String((regions.at(-1)?.sortOrder ?? 0) + 1) });
  async function saveRegion(values: RecordValues) {
    const body = { name: values.name, sortOrder: values.sortOrder ? Number(values.sortOrder) : undefined };
    await api(editingRegion ? `/regions/${editingRegion.id}` : '/regions', { method: editingRegion ? 'PATCH' : 'POST', body: JSON.stringify(editingRegion ? body : { ...body, code: values.code }) });
    success = editingRegion ? m.crud_da_luu({ name: String(values.name) }) : m.crud_da_them({ name: String(values.name) });
    await load();
  }

  const employeeFields = $derived([
    { key: 'code', label: m.ma_nv(), type: 'code' as const, required: true },
    { key: 'name', label: m.ho_ten(), required: true, maxlength: 120 },
    { key: 'title', label: m.chuc_vu(), required: true, maxlength: 120 },
    { key: 'role', label: m.crud_vai_tro_kd(), type: 'select' as const, options: [{ value: 'SALES', label: m.nhan_vien_kinh_doanh() }, { value: 'SALES_MANAGER', label: m.crud_truong_phong_kd() }] },
    { key: 'regionCode', label: m.khu_vuc_phu_trach(), type: 'select' as const, options: [{ value: '', label: m.crud_khong_theo_vung() }, ...regions.map((row) => ({ value: row.code, label: row.name }))] },
    { key: 'phone', label: m.dien_thoai(), type: 'tel' as const, maxlength: 30 },
    { key: 'status', label: m.trang_thai(), type: 'select' as const, options: [{ value: 'ACTIVE', label: m.dang_hoat_dong() }, { value: 'INACTIVE', label: m.crud_nghi_viec() }] },
    {
      key: 'userId', label: m.nv_tai_khoan(), type: 'select' as const, span: true, hint: m.nv_tai_khoan_goi_y(),
      options: [
        { value: '', label: m.nv_chua_lien_ket() },
        ...linkableUsers
          .filter((user) => user.id === editingEmployee?.userId || !employees.some((row) => row.userId === user.id))
          .map((user) => ({ value: user.id, label: `${user.displayName} — ${user.email}` })),
      ],
    },
  ]);
  const employeeValues = $derived<RecordValues>(editingEmployee
    ? { code: editingEmployee.code, name: editingEmployee.name, title: editingEmployee.title, role: editingEmployee.role, regionCode: editingEmployee.regionCode ?? '', phone: editingEmployee.phone ?? '', status: editingEmployee.status, userId: editingEmployee.userId ?? '' }
    : { title: m.nhan_vien_kinh_doanh(), role: 'SALES', regionCode: '', status: 'ACTIVE', userId: '' });
  async function saveEmployee(values: RecordValues) {
    const body = { code: values.code, name: values.name, title: values.title, role: values.role, regionCode: values.regionCode || null, phone: values.phone || undefined, status: values.status, userId: values.userId || null };
    await api(editingEmployee ? `/employees/${editingEmployee.id}` : '/employees', { method: editingEmployee ? 'PATCH' : 'POST', body: JSON.stringify(body) });
    success = editingEmployee ? m.crud_da_luu({ name: String(values.name) }) : m.crud_da_them({ name: String(values.name) });
    await load();
  }

  function askDelete(target: NonNullable<typeof deleteTarget>) {
    deleteTarget = target;
    deleteOpen = true;
  }
  async function remove() {
    if (!deleteTarget) return;
    await api(deleteTarget.kind === 'region' ? `/regions/${deleteTarget.row.id}` : `/employees/${deleteTarget.row.id}`, { method: 'DELETE' });
    success = m.crud_da_xoa({ name: deleteTarget.row.name });
    await load();
  }
  async function deactivateEmployee() {
    if (deleteTarget?.kind !== 'employee') return;
    await api(`/employees/${deleteTarget.row.id}`, { method: 'PATCH', body: JSON.stringify({ status: 'INACTIVE' }) });
    success = m.crud_da_ngung({ name: deleteTarget.row.name });
    await load();
  }
</script>

<svelte:head><title>{m.khu_vuc_nhan_vien_kd_inoxpran()}</title></svelte:head>

<section class="page-head">
  <div>
    <nav class="crumbs" aria-label={m.duong_dan()}><a href="/catalog/products">{m.danh_muc()}</a><span>{m.khu_vuc_nhan_vien_kinh_doanh()}</span></nav>
    <h1 class="page-title">{m.khu_vuc_nhan_vien_kinh_doanh()}</h1>
    <p class="page-sub">{m.khu_vuc_ban_hang_khuvuc_va()}</p>
  </div>
</section>

{#if error}<div class="banner error"><CircleAlert size={17} />{error}</div>{/if}
{#if success}<div class="banner success"><CircleCheck size={17} />{success}</div>{/if}

<section class="split">
  <article class="card">
    <header class="card-head head"><h2>{m.khu_vuc_ban_hang()}</h2>{#if editable}<button class="btn small" onclick={() => { editingRegion = null; regionOpen = true; }}><Plus size={15} />{m.crud_them_khu_vuc()}</button>{/if}</header>
    <table class="table">
      <thead><tr><th>{m.ma()}</th><th>{m.ten_khu_vuc()}</th><th class="num">{m.so_dai_ly()}</th>{#if editable}<th class="actions-col"><span class="sr-only">{m.crud_thao_tac()}</span></th>{/if}</tr></thead>
      <tbody>
        {#each regions as region (region.id)}
          <tr>
            <td class="code">{region.code}</td><td>{region.name}</td><td class="num">{region.dealerCount}</td>
            {#if editable}
              <td class="row-actions">
                <button class="icon-btn" title={m.crud_sua()} aria-label={`${m.crud_sua()} ${region.name}`} onclick={() => { editingRegion = region; regionOpen = true; }}><Pencil size={15} /></button>
                <button class="icon-btn danger" title={m.crud_xoa()} aria-label={`${m.crud_xoa()} ${region.name}`} onclick={() => askDelete({ kind: 'region', row: region })}><Trash2 size={15} /></button>
              </td>
            {/if}
          </tr>
        {/each}
        {#if !regions.length && !loading}<tr class="empty-row"><td colspan="4">{m.chua_khai_bao_khu_vuc()}</td></tr>{/if}
      </tbody>
    </table>
  </article>
  <article class="card">
    <header class="card-head head"><h2>{m.nhan_vien_kinh_doanh()}</h2>{#if editable}<button class="btn small" onclick={() => { editingEmployee = null; employeeOpen = true; }}><Plus size={15} />{m.crud_them_nhan_vien()}</button>{/if}</header>
    <table class="table">
      <thead><tr><th>{m.ma_nv()}</th><th>{m.ho_ten()}</th><th>{m.chuc_vu()}</th><th>{m.khu_vuc_phu_trach()}</th><th class="num">{m.dai_ly_phu_trach()}</th>{#if editable}<th class="actions-col"><span class="sr-only">{m.crud_thao_tac()}</span></th>{/if}</tr></thead>
      <tbody>
        {#each employees as employee (employee.id)}
          <tr class:inactive={employee.status === 'INACTIVE'}>
            <td class="code">{employee.code}</td>
            <td>{employee.name}{#if employee.status === 'INACTIVE'} <span class="pill neutral">{m.crud_nghi_viec()}</span>{/if}{#if employee.phone}<small>{employee.phone}</small>{/if}{#if employee.userEmail}<small class="account">{employee.userEmail}</small>{/if}</td>
            <td class="muted">{employee.title}</td>
            <td class="muted">{regions.find((region) => region.code === employee.regionCode)?.name ?? (employee.role === 'SALES_MANAGER' ? m.toan_bo() : m.kenh_online())}</td>
            <td class="num">{employee.dealerCount}</td>
            {#if editable}
              <td class="row-actions">
                <button class="icon-btn" title={m.crud_sua()} aria-label={`${m.crud_sua()} ${employee.name}`} onclick={() => { editingEmployee = employee; employeeOpen = true; }}><Pencil size={15} /></button>
                <button class="icon-btn danger" title={m.crud_xoa()} aria-label={`${m.crud_xoa()} ${employee.name}`} onclick={() => askDelete({ kind: 'employee', row: employee })}><Trash2 size={15} /></button>
              </td>
            {/if}
          </tr>
        {/each}
      </tbody>
    </table>
  </article>
</section>

<RecordDialog bind:open={regionOpen} formId="region-form" title={editingRegion ? m.crud_sua_khu_vuc() : m.crud_them_khu_vuc()} fields={regionFields} values={regionValues} onsubmit={saveRegion} />
<RecordDialog bind:open={employeeOpen} formId="employee-form" title={editingEmployee ? m.crud_sua_nhan_vien() : m.crud_them_nhan_vien()} fields={employeeFields} values={employeeValues} onsubmit={saveEmployee} />
<ConfirmDelete bind:open={deleteOpen} name={deleteTarget?.row.name ?? ''} ondelete={remove}
  ondeactivate={deleteTarget?.kind === 'employee' && deleteTarget.row.status === 'ACTIVE' ? deactivateEmployee : undefined} />

<style>
  .split { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1.6fr); gap: 18px; align-items: start; }
  .head { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding-bottom: 14px; }
  .actions-col { width: 76px; }
  tr.inactive td { color: var(--subtle); }
  @media (max-width: 1000px) { .split { grid-template-columns: 1fr; } }
</style>
