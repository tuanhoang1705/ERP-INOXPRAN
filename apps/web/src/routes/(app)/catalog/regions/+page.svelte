<script lang="ts">
  /**
   * Phân vùng NVKD (PV-01, 30/10/2026): mỗi NVKD phụ trách một hay nhiều tỉnh cũ (63; tỉnh mới 34 suy ra). Hà Nội có thể chia theo
   * kênh nhà phân phối / bán lẻ. Khách ở vùng đã giao bắt buộc do người phụ trách vùng quản lý (Admin / quản trị gốc đặt ngoại lệ).
   */
  import type { SalesTerritoryView, TerritoryMismatchView } from '@inoxpran/contracts';
  import { NEW_PROVINCES, oldProvincesOf, provinceLabel } from '$shared/provinces';
  import { m } from '$lib/paraglide/messages';
  import { onMount } from 'svelte';
  import { CircleAlert, CircleCheck, MapPinned, Pencil, Plus, Trash2, UserRoundCheck } from 'lucide-svelte';
  import { api, ApiRequestError } from '$lib/api';
  import { can } from '$lib/permissions';
  import { loadTerritories } from '$lib/territories.svelte';
  import ConfirmDelete from '$lib/components/ConfirmDelete.svelte';
  import ConfirmDialog from '$lib/components/ConfirmDialog.svelte';
  import Dialog from '$lib/components/Dialog.svelte';
  import RecordDialog, { type RecordValues } from '$lib/components/RecordDialog.svelte';

  type Employee = { id: string; code: string; name: string; title: string; role: 'SALES' | 'SALES_MANAGER'; phone?: string; status: 'ACTIVE' | 'INACTIVE'; dealerCount: number; userId?: string | null; userEmail?: string };
  type LinkableUser = { id: string; email: string; displayName: string };
  type Pick = '' | 'ALL' | 'DISTRIBUTOR' | 'RETAIL';

  let territories = $state<SalesTerritoryView[]>([]);
  let employees = $state<Employee[]>([]);
  let mismatches = $state<TerritoryMismatchView[]>([]);
  let loading = $state(true);
  let error = $state('');
  let success = $state('');
  let filter = $state('');
  const editable = $derived(can.editSalesStructure());

  let employeeOpen = $state(false);
  let editingEmployee = $state<Employee | null>(null);
  let deleteOpen = $state(false);
  let deleteTarget = $state<Employee | null>(null);
  let linkableUsers = $state<LinkableUser[]>([]);

  // Hộp chọn tỉnh phụ trách của một NVKD.
  let assignOpen = $state(false);
  let assignFor = $state<Employee | null>(null);
  let picks = $state<Record<string, Pick>>({});
  let assignSearch = $state('');
  let assignError = $state('');
  let saving = $state(false);
  let moveOpen = $state(false);
  let moveMessage = $state('');

  async function load() {
    try {
      [territories, employees] = await Promise.all([api<SalesTerritoryView[]>('/territories'), api<Employee[]>('/employees')]);
      if (editable) {
        [linkableUsers, mismatches] = await Promise.all([
          api<LinkableUser[]>('/employees/linkable-users').catch(() => []),
          api<TerritoryMismatchView[]>('/territories/mismatches').catch(() => []),
        ]);
      }
    } catch (caught) {
      error = caught instanceof Error ? caught.message : m.khong_tai_duoc_khu_vuc();
    } finally {
      loading = false;
    }
  }
  onMount(load);

  const channelText = (channel: string) => (channel === 'DISTRIBUTOR' ? m.pv_kenh_npp() : channel === 'RETAIL' ? m.pv_kenh_ban_le() : '');
  const ownersOf = (provinceCode: string) => territories.filter((row) => row.provinceCode === provinceCode);
  const regionsOf = (employeeId: string) => territories.filter((row) => row.employeeId === employeeId);
  const fold = (text: string) => text.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/đ/gi, 'd').toLowerCase();
  const visibleProvinces = $derived(NEW_PROVINCES.filter((item) => !filter.trim() || fold(item.name).includes(fold(filter)) || oldProvincesOf(item.code).some((old) => fold(old.name).includes(fold(filter)))));
  const assignedCount = $derived(new Set(territories.map((row) => row.provinceCode)).size);

  function openAssign(employee: Employee) {
    assignFor = employee;
    picks = Object.fromEntries(regionsOf(employee.id).map((row) => [row.provinceCode, row.channel as Pick]));
    assignSearch = '';
    assignError = '';
    assignOpen = true;
  }
  /** Chọn / bỏ cả tỉnh mới = mọi tỉnh cũ thuộc nó. */
  function toggleNew(newCode: string, checked: boolean) {
    const next = { ...picks };
    for (const old of oldProvincesOf(newCode)) {
      if (checked) next[old.code] = next[old.code] || 'ALL';
      else delete next[old.code];
    }
    picks = next;
  }
  const assignProvinces = $derived(NEW_PROVINCES.filter((item) => !assignSearch.trim() || fold(item.name).includes(fold(assignSearch)) || oldProvincesOf(item.code).some((old) => fold(old.name).includes(fold(assignSearch)))));
  const otherOwner = (provinceCode: string, channel: Pick) => territories.find((row) => row.provinceCode === provinceCode && row.employeeId !== assignFor?.id && (channel === 'ALL' || row.channel === 'ALL' || row.channel === channel));

  async function saveAssign(moveCustomers = false) {
    if (!assignFor) return;
    saving = true;
    assignError = '';
    try {
      const body = { territories: Object.entries(picks).filter(([, channel]) => channel).map(([provinceCode, channel]) => ({ provinceCode, channel })), moveCustomers };
      const result = await api<{ movedCustomers: number }>(`/employees/${assignFor.id}/territories`, { method: 'PUT', body: JSON.stringify(body) });
      assignOpen = false;
      success = m.pv_da_luu({ name: assignFor.name, count: result.movedCustomers });
      await Promise.all([load(), loadTerritories(true)]);
    } catch (caught) {
      if (caught instanceof ApiRequestError && caught.payload.code === 'TERRITORY_CUSTOMERS_AFFECTED') {
        moveMessage = caught.message;
        moveOpen = true;
      } else {
        assignError = caught instanceof Error ? caught.message : m.crud_loi_luu();
      }
    } finally {
      saving = false;
    }
  }

  async function fixMismatches(partnerIds?: string[]) {
    error = '';
    try {
      const result = await api<{ moved: number }>('/territories/mismatches/fix', { method: 'POST', body: JSON.stringify(partnerIds ? { partnerIds } : {}) });
      success = m.pv_da_chuyen_khach({ count: result.moved });
      await load();
    } catch (caught) {
      error = caught instanceof Error ? caught.message : m.crud_loi_luu();
    }
  }

  const employeeFields = $derived([
    { key: 'code', label: m.ma_nv(), type: 'code' as const, required: true },
    { key: 'name', label: m.ho_ten(), required: true, maxlength: 120 },
    { key: 'title', label: m.chuc_vu(), required: true, maxlength: 120 },
    { key: 'role', label: m.crud_vai_tro_kd(), type: 'select' as const, options: [{ value: 'SALES', label: m.nhan_vien_kinh_doanh() }, { value: 'SALES_MANAGER', label: m.crud_truong_phong_kd() }] },
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
    ? { code: editingEmployee.code, name: editingEmployee.name, title: editingEmployee.title, role: editingEmployee.role, phone: editingEmployee.phone ?? '', status: editingEmployee.status, userId: editingEmployee.userId ?? '' }
    : { title: m.nhan_vien_kinh_doanh(), role: 'SALES', status: 'ACTIVE', userId: '' });
  async function saveEmployee(values: RecordValues) {
    const body = { code: values.code, name: values.name, title: values.title, role: values.role, phone: values.phone || undefined, status: values.status, userId: values.userId || null };
    await api(editingEmployee ? `/employees/${editingEmployee.id}` : '/employees', { method: editingEmployee ? 'PATCH' : 'POST', body: JSON.stringify(body) });
    success = editingEmployee ? m.crud_da_luu({ name: String(values.name) }) : m.crud_da_them({ name: String(values.name) });
    await load();
  }
  async function remove() {
    if (!deleteTarget) return;
    await api(`/employees/${deleteTarget.id}`, { method: 'DELETE' });
    success = m.crud_da_xoa({ name: deleteTarget.name });
    await load();
  }
  async function deactivateEmployee() {
    if (!deleteTarget) return;
    await api(`/employees/${deleteTarget.id}`, { method: 'PATCH', body: JSON.stringify({ status: 'INACTIVE' }) });
    success = m.crud_da_ngung({ name: deleteTarget.name });
    await load();
  }
</script>

<svelte:head><title>{m.pv_tieu_de()} · INOXPRAN</title></svelte:head>

<section class="page-head">
  <div>
    <nav class="crumbs" aria-label={m.duong_dan()}><a href="/catalog/products">{m.danh_muc()}</a><span>{m.pv_tieu_de()}</span></nav>
    <h1 class="page-title">{m.pv_tieu_de()}</h1>
    <p class="page-sub">{m.pv_mo_ta()}</p>
  </div>
</section>

{#if error}<div class="banner error"><CircleAlert size={17} />{error}</div>{/if}
{#if success}<div class="banner success"><CircleCheck size={17} />{success}</div>{/if}

{#if editable && mismatches.length}
  <article class="card mismatch">
    <header class="card-head head">
      <h2><CircleAlert size={17} />{m.pv_khach_lech({ count: mismatches.length })}</h2>
      {#if mismatches.some((row) => !row.exception)}<button class="btn small navy" onclick={() => fixMismatches()}><UserRoundCheck size={15} />{m.pv_chuyen_tat_ca()}</button>{/if}
    </header>
    <table class="table">
      <thead><tr><th>{m.ma()}</th><th>{m.ten_dai_ly_khach_hang()}</th><th>{m.pv_tinh_kenh()}</th><th>{m.pv_nvkd_hien_tai()}</th><th>{m.pv_nvkd_vung()}</th><th>{m.pv_ngoai_le()}</th><th class="actions-col"></th></tr></thead>
      <tbody>
        {#each mismatches as row (row.partnerId)}
          <tr>
            <td class="code"><a href={`/catalog/dealers/${row.partnerId}`}>{row.code}</a></td>
            <td>{row.name}</td>
            <td class="muted">{row.provinceLabel}{row.channel ? ` · ${channelText(row.channel)}` : ''}</td>
            <td>{row.salesRepName ?? '—'}</td>
            <td><b>{row.territoryRepName}</b></td>
            <td class="muted">{#if row.exception}{row.exception.reason}<small>{row.exception.byName}</small>{:else}—{/if}</td>
            <td><button class="btn small" onclick={() => fixMismatches([row.partnerId])}>{m.pv_chuyen()}</button></td>
          </tr>
        {/each}
      </tbody>
    </table>
  </article>
{/if}

<section class="split">
  <article class="card">
    <header class="card-head head">
      <h2><MapPinned size={17} />{m.pv_bang_tinh({ assigned: assignedCount })}</h2>
      <input class="search" type="search" bind:value={filter} placeholder={m.pv_tim_tinh()} aria-label={m.pv_tim_tinh()} />
    </header>
    <table class="table provinces">
      <thead><tr><th>{m.pv_tinh_moi()}</th><th>{m.pv_tinh_cu()}</th><th>{m.nv_phu_trach()}</th></tr></thead>
      <tbody>
        {#each visibleProvinces as item (item.code)}
          {#each oldProvincesOf(item.code) as old, index (old.code)}
            {@const owners = ownersOf(old.code)}
            <tr class:first={index === 0}>
              {#if index === 0}<td class="new" rowspan={oldProvincesOf(item.code).length}>{item.name}</td>{/if}
              <td>{old.name}</td>
              <td>
                {#each owners as owner}<span class="owner">{owner.employeeName}{#if owner.channel !== 'ALL'}<small>{channelText(owner.channel)}</small>{/if}</span>{/each}
                {#if !owners.length}<span class="muted">{m.pv_chua_giao()}</span>{/if}
              </td>
            </tr>
          {/each}
        {/each}
      </tbody>
    </table>
  </article>
  <article class="card">
    <header class="card-head head"><h2>{m.nhan_vien_kinh_doanh()}</h2>{#if editable}<button class="btn small" onclick={() => { editingEmployee = null; employeeOpen = true; }}><Plus size={15} />{m.crud_them_nhan_vien()}</button>{/if}</header>
    <table class="table">
      <thead><tr><th>{m.ma_nv()}</th><th>{m.ho_ten()}</th><th>{m.pv_tinh_phu_trach()}</th><th class="num">{m.dai_ly_phu_trach()}</th>{#if editable}<th class="actions-col"><span class="sr-only">{m.crud_thao_tac()}</span></th>{/if}</tr></thead>
      <tbody>
        {#each employees as employee (employee.id)}
          {@const own = regionsOf(employee.id)}
          <tr class:inactive={employee.status === 'INACTIVE'}>
            <td class="code">{employee.code}</td>
            <td>{employee.name}{#if employee.status === 'INACTIVE'} <span class="pill neutral">{m.crud_nghi_viec()}</span>{/if}<small>{employee.title}{employee.phone ? ` · ${employee.phone}` : ''}</small>{#if employee.userEmail}<small class="account">{employee.userEmail}</small>{/if}</td>
            <td class="regions">
              {#each own as row}<span class="chip">{provinceLabel(row.provinceCode)}{row.channel !== 'ALL' ? ` · ${channelText(row.channel)}` : ''}</span>{/each}
              {#if !own.length}<span class="muted">{m.pv_chua_co_tinh()}</span>{/if}
            </td>
            <td class="num">{employee.dealerCount}</td>
            {#if editable}
              <td class="row-actions">
                <button class="icon-btn" title={m.pv_chon_tinh_phu_trach()} aria-label={`${m.pv_chon_tinh_phu_trach()} ${employee.name}`} onclick={() => openAssign(employee)}><MapPinned size={15} /></button>
                <button class="icon-btn" title={m.crud_sua()} aria-label={`${m.crud_sua()} ${employee.name}`} onclick={() => { editingEmployee = employee; employeeOpen = true; }}><Pencil size={15} /></button>
                <button class="icon-btn danger" title={m.crud_xoa()} aria-label={`${m.crud_xoa()} ${employee.name}`} onclick={() => { deleteTarget = employee; deleteOpen = true; }}><Trash2 size={15} /></button>
              </td>
            {/if}
          </tr>
        {/each}
      </tbody>
    </table>
  </article>
</section>

<Dialog bind:open={assignOpen} title={m.pv_chon_tinh_cho({ name: assignFor?.name ?? '' })} wide>
  <p class="muted lead">{m.pv_chon_tinh_huong_dan()}</p>
  {#if assignError}<div class="banner error"><CircleAlert size={17} /><span>{assignError}</span></div>{/if}
  <input class="search wide" type="search" bind:value={assignSearch} placeholder={m.pv_tim_tinh()} aria-label={m.pv_tim_tinh()} />
  <div class="assign">
    {#each assignProvinces as item (item.code)}
      {@const members = oldProvincesOf(item.code)}
      <fieldset>
        <legend>
          <label><input type="checkbox" checked={members.every((old) => picks[old.code])} indeterminate={members.some((old) => picks[old.code]) && !members.every((old) => picks[old.code])}
            onchange={(event) => toggleNew(item.code, event.currentTarget.checked)} />{item.name}</label>
        </legend>
        {#if members.length > 1 || item.code === 'HA-NOI'}
          {#each members as old (old.code)}
            {@const taken = picks[old.code] ? otherOwner(old.code, picks[old.code] ?? 'ALL') : undefined}
            <div class="old">
              <label><input type="checkbox" checked={Boolean(picks[old.code])} onchange={(event) => (picks = { ...picks, [old.code]: event.currentTarget.checked ? 'ALL' : '' })} />{old.name}</label>
              {#if picks[old.code]}
                <select bind:value={picks[old.code]} aria-label={m.pv_kenh()}>
                  <option value="ALL">{m.pv_ca_tinh()}</option>
                  <option value="DISTRIBUTOR">{m.pv_kenh_npp()}</option>
                  <option value="RETAIL">{m.pv_kenh_ban_le()}</option>
                </select>
              {/if}
              {#if taken}<small class="taken">{m.pv_dang_cua({ name: taken.employeeName })}</small>{/if}
            </div>
          {/each}
        {:else if picks[members[0]!.code]}
          {@const taken = otherOwner(members[0]!.code, picks[members[0]!.code] ?? 'ALL')}
          {#if taken}<small class="taken">{m.pv_dang_cua({ name: taken.employeeName })}</small>{/if}
        {/if}
      </fieldset>
    {/each}
  </div>
  {#snippet footer()}
    <span class="count">{m.pv_da_chon({ count: Object.values(picks).filter(Boolean).length })}</span>
    <button class="btn" onclick={() => (assignOpen = false)}>{m.huy()}</button>
    <button class="btn primary" disabled={saving} onclick={() => saveAssign()}>{m.crud_luu()}</button>
  {/snippet}
</Dialog>

<ConfirmDialog bind:open={moveOpen} title={m.pv_chuyen_khach_tieu_de()} message={moveMessage} confirmLabel={m.pv_chuyen_khach_nut()} tone="navy" onconfirm={() => saveAssign(true)} />
<RecordDialog bind:open={employeeOpen} formId="employee-form" title={editingEmployee ? m.crud_sua_nhan_vien() : m.crud_them_nhan_vien()} fields={employeeFields} values={employeeValues} onsubmit={saveEmployee} />
<ConfirmDelete bind:open={deleteOpen} name={deleteTarget?.name ?? ''} ondelete={remove} ondeactivate={deleteTarget?.status === 'ACTIVE' ? deactivateEmployee : undefined} />

<style>
  .split { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1.4fr); gap: 18px; align-items: start; }
  .head { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding-bottom: 14px; }
  .head h2 { display: inline-flex; align-items: center; gap: 8px; }
  .search { width: min(220px, 100%); }
  .search.wide { width: 100%; margin-bottom: 12px; }
  .actions-col { width: 110px; }
  tr.inactive td { color: var(--subtle); }
  td small { display: block; color: var(--muted); font-size: 12px; }
  .provinces td.new { font-weight: 700; color: var(--navy); vertical-align: top; }
  .provinces tr.first td { border-top: 1px solid var(--line); }
  .owner { display: inline-flex; align-items: baseline; gap: 6px; margin-right: 10px; font-weight: 600; }
  .owner small { display: inline; }
  .regions { display: flex; flex-wrap: wrap; gap: 4px; }
  .chip { padding: 2px 8px; border-radius: 999px; background: var(--blue-soft, #e8f0fa); color: var(--navy); font-size: 12px; white-space: nowrap; }
  .mismatch { margin-bottom: 18px; border-color: var(--amber, #c98a00); }
  .mismatch h2 { color: var(--amber, #a86b00); }
  .lead { margin: 0 0 10px; }
  .assign { display: grid; grid-template-columns: repeat(auto-fill, minmax(200px, 1fr)); gap: 10px; max-height: 52vh; overflow: auto; }
  .assign fieldset { margin: 0; padding: 6px 10px 8px; border: 1px solid var(--line); border-radius: var(--radius-sm); align-self: start; }
  .assign legend { padding: 0 4px; font-weight: 700; }
  .assign label { display: inline-flex; align-items: center; gap: 6px; cursor: pointer; }
  .old { display: grid; gap: 4px; margin: 6px 0 0 18px; font-size: 13px; }
  .old select { width: 100%; padding: 2px 6px; font-size: 12.5px; }
  .taken { color: var(--amber, #a86b00); font-size: 11.5px; }
  .count { margin-right: auto; color: var(--muted); font-size: 13px; }
  @media (max-width: 1100px) { .split { grid-template-columns: 1fr; } }
</style>
