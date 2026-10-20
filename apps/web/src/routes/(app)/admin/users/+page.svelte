<script lang="ts">
  import { m } from '$lib/paraglide/messages';
  import type { AdminUser, LoginEvent, Warehouse } from '@inoxpran/contracts';
  import { onMount } from 'svelte';
  import { CircleAlert, CircleCheck, Copy, KeyRound, ListChecks, LogOut, Pencil, Plus, ShieldOff, UserCheck, UserX } from 'lucide-svelte';
  import { api, ApiRequestError } from '$lib/api';
  import { dateTime, initials } from '$lib/format';
  import { hasRole, roleLabel } from '$lib/labels';
  import { loginReasonText } from '$lib/admin';
  import { debounce, initialPageSize, pageQuery, rememberPageSize, type Paged } from '$lib/paging';
  import { session } from '$lib/session.svelte';
  import { canManageUser, USER_ROLES } from '$shared/user-admin';
  import Dialog from '$lib/components/Dialog.svelte';
  import Pagination from '$lib/components/Pagination.svelte';
  import DateRangeFilter from '$lib/components/DateRangeFilter.svelte';
  import PermissionsDialog from '$lib/components/PermissionsDialog.svelte';

  type Tab = 'users' | 'logins';
  let tab = $state<Tab>('users');
  let users = $state<AdminUser[]>([]);
  let total = $state(0);
  let page = $state(1);
  let pageSize = $state(initialPageSize());
  let search = $state('');
  /** Lọc theo ngày tạo tài khoản / thời điểm đăng nhập (LIST-DATE-01). */
  let from = $state('');
  let to = $state('');
  let loginFrom = $state('');
  let loginTo = $state('');
  let role = $state('');
  let status = $state('');
  let loading = $state(true);
  let error = $state('');
  let success = $state('');
  let warehouses = $state<Warehouse[]>([]);

  let logins = $state<LoginEvent[]>([]);
  let loginTotal = $state(0);
  let loginPage = $state(1);
  let loginFilter = $state<'' | 'false'>('');
  let loginSearch = $state('');

  let formOpen = $state(false);
  let editing = $state<AdminUser | null>(null);
  let form = $state({ email: '', displayName: '', title: '', department: '', phone: '', roles: [] as string[], warehouseScopes: [] as string[] });
  let formError = $state('');
  let saving = $state(false);

  let secretOpen = $state(false);
  let secret = $state({ email: '', password: '' });
  let copied = $state(false);

  let confirmOpen = $state(false);
  let permissionsOpen = $state(false);
  let permissionsUser = $state<AdminUser | null>(null);
  let confirmAction = $state<{ user: AdminUser; kind: 'disable' | 'enable' | 'reset-password' | 'reset-mfa' | 'revoke-sessions' | 'mfa-on' | 'mfa-off' } | null>(null);

  const me = $derived(session.user);
  const isAdmin = $derived(Boolean(me?.roles.includes('ADMIN')));
  const actor = $derived({ id: me?.sub ?? '', roles: me?.roles ?? [], root: me?.root });
  const assignable = $derived(USER_ROLES.filter((item) => item !== 'ADMIN' || me?.root));
  const manageable = (user: AdminUser) => isAdmin && user.id !== me?.sub && canManageUser(actor, user);

  async function load() {
    loading = true;
    error = '';
    try {
      const result = await api<Paged<AdminUser>>(`/admin/users?${pageQuery({ search, role, status, from, to }, page, pageSize)}`);
      users = result.rows;
      total = result.total;
    } catch (caught) {
      error = caught instanceof Error ? caught.message : m.khong_tai_duoc_danh_sach_nguoi();
    } finally {
      loading = false;
    }
  }
  async function loadLogins() {
    const result = await api<Paged<LoginEvent>>(`/admin/login-events?${pageQuery({ success: loginFilter, search: loginSearch, from: loginFrom, to: loginTo }, loginPage, pageSize)}`).catch(() => null);
    if (result) {
      logins = result.rows;
      loginTotal = result.total;
    }
  }
  const refilter = () => {
    page = 1;
    void load();
  };
  const searchChanged = debounce(refilter);
  const loginSearchChanged = debounce(() => {
    loginPage = 1;
    void loadLogins();
  });
  function changePage(next: number, size: number) {
    if (size !== pageSize) rememberPageSize(size);
    page = next;
    pageSize = size;
    void load();
  }

  onMount(() => {
    void load();
    void api<Warehouse[]>('/warehouses').then((rows) => (warehouses = rows)).catch(() => undefined);
  });

  function openForm(user: AdminUser | null) {
    editing = user;
    form = user
      ? { email: user.email, displayName: user.displayName, title: user.title ?? '', department: user.department ?? '', phone: user.phone ?? '', roles: [...user.roles], warehouseScopes: [...user.warehouseScopes] }
      : { email: '', displayName: '', title: '', department: '', phone: '', roles: [], warehouseScopes: warehouses.filter((row) => row.active && row.purpose !== 'DEFECTIVE').slice(0, 1).map((row) => row.id) };
    formError = '';
    formOpen = true;
  }

  async function save(event: SubmitEvent) {
    event.preventDefault();
    formError = '';
    if (!form.roles.length) {
      formError = m.adm_need_role();
      return;
    }
    saving = true;
    const optional = (value: string) => value.trim() || undefined;
    const body = { displayName: form.displayName.trim(), title: optional(form.title), department: optional(form.department), phone: optional(form.phone), roles: form.roles, warehouseScopes: form.warehouseScopes };
    try {
      if (editing) {
        await api(`/admin/users/${editing.id}`, { method: 'PATCH', body: JSON.stringify(body) });
        success = m.crud_da_luu({ name: form.displayName });
      } else {
        const result = await api<{ user: AdminUser; temporaryPassword: string }>('/admin/users', { method: 'POST', body: JSON.stringify({ ...body, email: form.email.trim() }) });
        secret = { email: result.user.email, password: result.temporaryPassword };
        copied = false;
        secretOpen = true;
        success = m.crud_da_them({ name: result.user.displayName });
      }
      formOpen = false;
      await load();
    } catch (caught) {
      formError = caught instanceof Error ? caught.message : m.crud_loi_luu();
      if (caught instanceof ApiRequestError && caught.payload.code === 'VALIDATION_ERROR') formError = m.adm_invalid_form();
    } finally {
      saving = false;
    }
  }

  function ask(user: AdminUser, kind: NonNullable<typeof confirmAction>['kind']) {
    confirmAction = { user, kind };
    confirmOpen = true;
  }
  async function runAction() {
    if (!confirmAction) return;
    const { user, kind } = confirmAction;
    try {
      // Bật / tắt yêu cầu 2 lớp (MFA-02) dùng PATCH riêng; các thao tác khác là POST /admin/users/:id/<thao tác>.
      const result = kind === 'mfa-on' || kind === 'mfa-off'
        ? await api<{ temporaryPassword?: string }>(`/admin/users/${user.id}/mfa`, { method: 'PATCH', body: JSON.stringify({ required: kind === 'mfa-on' }) })
        : await api<{ temporaryPassword?: string }>(`/admin/users/${user.id}/${kind}`, { method: 'POST' });
      confirmOpen = false;
      if (kind === 'reset-password' && result.temporaryPassword) {
        secret = { email: user.email, password: result.temporaryPassword };
        copied = false;
        secretOpen = true;
      }
      success = { disable: m.adm_done_disable, enable: m.adm_done_enable, 'reset-password': m.adm_done_reset_password, 'reset-mfa': m.adm_done_reset_mfa, 'revoke-sessions': m.adm_done_revoke, 'mfa-on': m.adm_done_mfa_on, 'mfa-off': m.adm_done_mfa_off }[kind]({ name: user.displayName });
      await load();
    } catch (caught) {
      error = caught instanceof Error ? caught.message : m.crud_loi_luu();
      confirmOpen = false;
    }
  }
  async function copySecret() {
    try {
      await navigator.clipboard.writeText(secret.password);
      copied = true;
    } catch {
      copied = false;
    }
  }
  function switchTab(next: Tab) {
    tab = next;
    if (next === 'logins' && !logins.length) void loadLogins();
  }

  const confirmText = $derived(confirmAction ? {
    disable: m.adm_confirm_disable, enable: m.adm_confirm_enable, 'reset-password': m.adm_confirm_reset_password, 'reset-mfa': m.adm_confirm_reset_mfa, 'revoke-sessions': m.adm_confirm_revoke,
    'mfa-on': m.adm_confirm_mfa_on, 'mfa-off': m.adm_confirm_mfa_off,
  }[confirmAction.kind]({ name: confirmAction.user.displayName }) : '');

  /** Ma trận quyền đang được API thực thi (RolesGuard); dùng để giải thích cho người duyệt. */
  const matrix: Array<{ action: string; roles: string[] }> = [
    { action: m.lap_gui_don_ban(), roles: ['SALES', 'SALES_MANAGER'] },
    { action: m.duyet_don_ban_ngoai_le(), roles: ['SALES_MANAGER', 'DIRECTOR'] },
    { action: m.xuat_kho_xac_nhan_giao(), roles: ['WAREHOUSE', 'WAREHOUSE_MANAGER'] },
    { action: m.lap_don_mua(), roles: ['PROCUREMENT', 'PROCUREMENT_MANAGER'] },
    { action: m.duyet_don_mua(), roles: ['PROCUREMENT_MANAGER', 'DIRECTOR'] },
    { action: m.nhap_kho_theo_don_mua(), roles: ['WAREHOUSE', 'WAREHOUSE_MANAGER', 'DIRECTOR'] },
    { action: m.ghi_nhan_thu_tien(), roles: ['ACCOUNTANT'] },
    { action: m.ra_soat_cong_no_qua_han(), roles: ['ACCOUNTANT', 'DIRECTOR'] },
    { action: m.xem_bao_cao_doanh_so(), roles: ['DIRECTOR', 'SALES_MANAGER', 'ACCOUNTANT', 'AUDITOR'] },
    { action: m.adm_matrix_catalog(), roles: ['DIRECTOR', 'WAREHOUSE_MANAGER', 'WAREHOUSE'] },
    { action: m.adm_matrix_warranty(), roles: ['WARRANTY', 'DIRECTOR'] },
  ];
  const columns = ['DIRECTOR', 'SALES_MANAGER', 'SALES', 'WAREHOUSE_MANAGER', 'WAREHOUSE', 'ACCOUNTANT', 'PROCUREMENT_MANAGER', 'WARRANTY'];
</script>

<svelte:head><title>{m.nguoi_dung_phan_quyen_inoxpran_erp()}</title></svelte:head>

<section class="page-head">
  <div>
    <nav class="crumbs" aria-label={m.duong_dan()}><a href="/admin/users">{m.adm_section()}</a><span>{m.nguoi_dung_phan_quyen()}</span></nav>
    <h1 class="page-title">{m.nguoi_dung_phan_quyen()}</h1>
    <p class="page-sub">{m.adm_users_sub()}</p>
  </div>
  {#if isAdmin}<div class="actions"><button class="btn primary" onclick={() => openForm(null)}><Plus size={16} />{m.adm_add_user()}</button></div>{/if}
</section>

<nav class="tabs" aria-label={m.nguoi_dung_phan_quyen()}>
  <button class:active={tab === 'users'} onclick={() => switchTab('users')}>{m.adm_tab_users()} <b>{total}</b></button>
  <button class:active={tab === 'logins'} onclick={() => switchTab('logins')}>{m.adm_tab_logins()}</button>
</nav>

{#if error}<div class="banner error"><CircleAlert size={17} />{error}</div>{/if}
{#if success}<div class="banner success"><CircleCheck size={17} />{success}</div>{/if}

{#if tab === 'users'}
  <section class="card filters">
    <div class="field"><label for="search">{m.tim_kiem()}</label><input id="search" bind:value={search} oninput={searchChanged} placeholder={m.adm_search_ph()} /></div>
    <DateRangeFilter bind:from bind:to label={m.dr_ngay_tao()} id="user-date" onchange={refilter} />
    <div class="field"><label for="role">{m.adm_roles()}</label><select id="role" bind:value={role} onchange={refilter}><option value="">{m.tat_ca()}</option>{#each USER_ROLES as item}<option value={item}>{roleLabel[item] ?? item}</option>{/each}</select></div>
    <div class="field"><label for="status">{m.trang_thai()}</label><select id="status" bind:value={status} onchange={refilter}><option value="">{m.tat_ca()}</option><option value="ACTIVE">{m.hoat_dong()}</option><option value="DISABLED">{m.da_khoa()}</option></select></div>
  </section>

  <section class="card block">
    <div class="table-wrap">
      <table class="table">
        <thead><tr><th>{m.nguoi_dung()}</th><th>{m.chuc_danh()}</th><th>{m.vai_tro()}</th><th>{m.pham_vi_kho()}</th><th>MFA</th><th>{m.dang_nhap_gan_nhat()}</th><th>{m.trang_thai()}</th>{#if isAdmin}<th class="actions-col"><span class="sr-only">{m.crud_thao_tac()}</span></th>{/if}</tr></thead>
        <tbody>
          {#if loading && !users.length}<tr class="empty-row"><td colspan="8">{m.dang_tai()}</td></tr>
          {:else}
            {#each users as user (user.id)}
              <tr class:disabled={user.status === 'DISABLED'}>
                <td><div class="user"><span>{initials(user.displayName)}</span><div><b>{user.displayName}{#if user.root} <span class="pill orange">{m.adm_root()}</span>{/if}</b><small>{user.email}{user.demoData ? m.tai_khoan_demo() : ''}</small></div></div></td>
                <td class="muted">{user.title ?? '—'}{#if user.department}<small>{user.department}</small>{/if}</td>
                <td><div class="roles">{#each user.roles as item}<span class="pill">{roleLabel[item] ?? item}</span>{/each}</div></td>
                <td class="muted">{user.roles.includes('ADMIN') ? m.tat_ca_kho() : user.warehouseNames.join(', ') || '—'}</td>
                <td class="mfa-cell">
                  {#if manageable(user)}
                    <button class="switch" role="switch" aria-checked={user.mfaRequired} title={user.mfaRequiredSet ? '' : m.adm_mfa_by_role()} aria-label={`${m.adm_mfa_required()} ${user.displayName}`} onclick={() => ask(user, user.mfaRequired ? 'mfa-off' : 'mfa-on')}><span class="knob"></span>{user.mfaRequired ? m.adm_mfa_required() : m.adm_mfa_optional()}</button>
                  {:else if user.mfaRequired}<small class="mfa-req">{m.adm_mfa_required()}</small>{/if}
                  {#if user.mfaEnabled}<span class="pill success">{m.da_bat()}</span>{:else}<span class="pill warning">{m.chua_bat()}</span>{/if}
                </td>
                <td class="muted nowrap">{dateTime(user.lastLoginAt)}{#if user.lastSeenAt}<small>{m.adm_last_seen({ time: dateTime(user.lastSeenAt) })}</small>{/if}</td>
                <td>
                  <span class={`pill ${user.status === 'ACTIVE' ? 'success' : 'neutral'}`}>{user.status === 'ACTIVE' ? m.hoat_dong() : m.da_khoa()}</span>
                  {#if user.lockedUntil}<small class="warn">{m.adm_locked_until({ time: dateTime(user.lockedUntil) })}</small>{/if}
                  {#if user.mustChangePassword}<small class="warn">{m.adm_must_change()}</small>{/if}
                </td>
                {#if isAdmin}
                  <td class="row-actions">
                    <button class="icon-btn" title={m.perm_nut()} aria-label={`${m.perm_nut()} ${user.displayName}`} onclick={() => { permissionsUser = user; permissionsOpen = true; }}><ListChecks size={15} /></button>
                    {#if manageable(user)}
                      <button class="icon-btn" title={m.crud_sua()} aria-label={`${m.crud_sua()} ${user.displayName}`} onclick={() => openForm(user)}><Pencil size={15} /></button>
                      <button class="icon-btn" title={m.adm_reset_password()} aria-label={`${m.adm_reset_password()} ${user.displayName}`} onclick={() => ask(user, 'reset-password')}><KeyRound size={15} /></button>
                      {#if user.mfaEnabled}<button class="icon-btn" title={m.adm_reset_mfa()} aria-label={`${m.adm_reset_mfa()} ${user.displayName}`} onclick={() => ask(user, 'reset-mfa')}><ShieldOff size={15} /></button>{/if}
                      <button class="icon-btn" title={m.adm_revoke()} aria-label={`${m.adm_revoke()} ${user.displayName}`} onclick={() => ask(user, 'revoke-sessions')}><LogOut size={15} /></button>
                      {#if user.status === 'ACTIVE'}
                        <button class="icon-btn danger" title={m.adm_disable()} aria-label={`${m.adm_disable()} ${user.displayName}`} onclick={() => ask(user, 'disable')}><UserX size={15} /></button>
                      {:else}
                        <button class="icon-btn" title={m.adm_enable()} aria-label={`${m.adm_enable()} ${user.displayName}`} onclick={() => ask(user, 'enable')}><UserCheck size={15} /></button>
                      {/if}
                    {/if}
                  </td>
                {/if}
              </tr>
            {:else}<tr class="empty-row"><td colspan="8">{m.adm_no_users()}</td></tr>{/each}
          {/if}
        </tbody>
      </table>
    </div>
    <Pagination {page} {pageSize} {total} {loading} onchange={changePage} />
  </section>

  <details class="card matrix-card">
    <summary class="card-head"><h2>{m.ma_tran_quyen_nghiep_vu()}</h2><span class="muted">{m.quan_tri_he_thong_co_toan()}</span></summary>
    <div class="table-wrap">
      <table class="table matrix">
        <thead><tr><th>{m.thao_tac()}</th>{#each columns as item}<th class="center">{roleLabel[item]}</th>{/each}</tr></thead>
        <tbody>
          {#each matrix as row}<tr><td>{row.action}</td>{#each columns as item}<td class="center">{#if row.roles.includes(item)}<span class="yes">✓</span>{:else}<span class="no">—</span>{/if}</td>{/each}</tr>{/each}
        </tbody>
      </table>
    </div>
  </details>
{:else}
  <section class="card filters">
    <div class="field"><label for="login-search">{m.tim_kiem()}</label><input id="login-search" bind:value={loginSearch} oninput={loginSearchChanged} placeholder="Email" /></div>
    <DateRangeFilter bind:from={loginFrom} bind:to={loginTo} label={m.dr_thoi_gian()} id="login-date" onchange={() => { loginPage = 1; void loadLogins(); }} />
    <div class="field"><label for="login-filter">{m.adm_result()}</label><select id="login-filter" bind:value={loginFilter} onchange={() => { loginPage = 1; void loadLogins(); }}><option value="">{m.tat_ca()}</option><option value="false">{m.adm_failed_only()}</option></select></div>
  </section>
  <section class="card block">
    <div class="table-wrap">
      <table class="table">
        <thead><tr><th>{m.adm_time()}</th><th>{m.nguoi_dung()}</th><th>{m.adm_result()}</th><th>IP</th><th>{m.adm_device()}</th></tr></thead>
        <tbody>
          {#each logins as row (row.id)}
            <tr>
              <td class="nowrap">{dateTime(row.at)}</td>
              <td>{row.displayName ?? '—'}<small>{row.email}</small></td>
              <td><span class={`pill ${row.success ? 'success' : 'danger'}`}>{loginReasonText(row.reason)}</span></td>
              <td class="muted">{row.ip ?? '—'}</td>
              <td class="muted ua">{row.userAgent ?? '—'}</td>
            </tr>
          {:else}<tr class="empty-row"><td colspan="5">{m.adm_no_logins()}</td></tr>{/each}
        </tbody>
      </table>
    </div>
    <Pagination page={loginPage} {pageSize} total={loginTotal} onchange={(next, size) => { loginPage = next; pageSize = size; void loadLogins(); }} />
  </section>
{/if}

<PermissionsDialog bind:open={permissionsOpen} user={permissionsUser} editable={Boolean(me?.root)} onsaved={(updated) => { success = m.perm_da_luu({ name: updated.displayName }); users = users.map((row) => (row.id === updated.id ? updated : row)); }} />

<Dialog bind:open={formOpen} title={editing ? m.adm_edit_user({ name: editing.displayName }) : m.adm_add_user()} wide>
  <form id="user-form" class="grid" onsubmit={save} novalidate>
    {#if formError}<div class="banner error span"><CircleAlert size={17} /><span>{formError}</span></div>{/if}
    <div class="field"><label for="u-email">Email <span class="req">*</span></label><input id="u-email" type="email" bind:value={form.email} readonly={Boolean(editing)} autocomplete="off" /></div>
    <div class="field"><label for="u-name">{m.ho_ten()} <span class="req">*</span></label><input id="u-name" bind:value={form.displayName} maxlength="120" /></div>
    <div class="field"><label for="u-title">{m.chuc_danh()}</label><input id="u-title" bind:value={form.title} maxlength="120" /></div>
    <div class="field"><label for="u-dept">{m.adm_department()}</label><input id="u-dept" bind:value={form.department} maxlength="120" /></div>
    <div class="field"><label for="u-phone">{m.dien_thoai()}</label><input id="u-phone" type="tel" bind:value={form.phone} maxlength="30" /></div>
    <fieldset class="span choices">
      <legend>{m.adm_roles()} <span class="req">*</span></legend>
      {#each assignable as item}<label><input type="checkbox" value={item} bind:group={form.roles} />{roleLabel[item] ?? item}</label>{/each}
      {#if !me?.root}<p class="hint">{m.adm_admin_root_only()}</p>{/if}
    </fieldset>
    <fieldset class="span choices">
      <legend>{m.pham_vi_kho()}</legend>
      {#each warehouses as warehouse}<label><input type="checkbox" value={warehouse.id} bind:group={form.warehouseScopes} />{warehouse.name}</label>{/each}
      <p class="hint">{m.adm_scope_hint()}</p>
    </fieldset>
    {#if !editing}<p class="note span">{m.adm_temp_password_note()}</p>{/if}
  </form>
  {#snippet footer()}
    <button type="button" class="btn" onclick={() => (formOpen = false)}>{m.huy()}</button>
    <button type="submit" class="btn primary" form="user-form" disabled={saving || form.displayName.trim().length < 2 || (!editing && !form.email.includes('@'))}>{saving ? m.kh_dang_luu() : m.crud_luu()}</button>
  {/snippet}
</Dialog>

<Dialog bind:open={secretOpen} title={m.adm_temp_password_title()}>
  <p>{m.adm_temp_password_for({ email: secret.email })}</p>
  <div class="secret"><code>{secret.password}</code><button class="btn small" onclick={copySecret}><Copy size={14} />{copied ? m.adm_copied() : m.adm_copy()}</button></div>
  <p class="note">{m.adm_temp_password_warning()}</p>
  {#snippet footer()}<button class="btn primary" onclick={() => (secretOpen = false)}>{m.adm_done()}</button>{/snippet}
</Dialog>

<Dialog bind:open={confirmOpen} title={m.adm_confirm_title()}>
  <p>{confirmText}</p>
  {#snippet footer()}
    <button class="btn" onclick={() => (confirmOpen = false)}>{m.huy()}</button>
    <button class={`btn ${confirmAction?.kind === 'disable' ? 'danger' : 'primary'}`} onclick={runAction}>{m.adm_confirm()}</button>
  {/snippet}
</Dialog>

<style>
  .tabs { display: flex; gap: 6px; margin-bottom: 14px; border-bottom: 1px solid var(--line); }
  .tabs button { padding: 9px 14px; border-bottom: 2px solid transparent; color: var(--muted); font-weight: 600; }
  .tabs button.active { border-color: var(--navy); color: var(--navy); }
  .tabs b { margin-left: 4px; padding: 0 7px; border-radius: 999px; background: var(--surface-2); font-size: 11.5px; }
  .filters { grid-template-columns: 2fr 1.4fr 1fr 1fr; }
  .block { margin-bottom: 18px; }
  .user { display: flex; align-items: center; gap: 10px; }
  .user > span { display: grid; flex: none; width: 34px; height: 34px; place-items: center; border-radius: 50%; background: var(--blue-soft); color: var(--navy); font-size: 12px; font-weight: 700; }
  .user div { display: grid; }
  .roles { display: flex; flex-wrap: wrap; gap: 5px; }
  tr.disabled td { color: var(--subtle); }
  small.warn { display: block; color: var(--amber); font-size: 11.5px; }
  .actions-col { width: 190px; }
  .ua { max-width: 360px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .matrix-card summary { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding-bottom: 12px; cursor: pointer; list-style: none; }
  .center { text-align: center !important; }
  .yes { color: var(--green); font-weight: 700; }
  .no { color: var(--line); }
  .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 14px 16px; }
  .span { grid-column: 1 / -1; }
  .req { color: var(--red); }
  .choices { display: flex; flex-wrap: wrap; gap: 10px 18px; margin: 0; padding: 12px; border: 1px solid var(--line); border-radius: var(--radius-sm); }
  .choices legend { padding: 0 4px; font-size: 13px; font-weight: 500; }
  .choices label { display: flex; align-items: center; gap: 6px; font-size: 13.5px; }
  .choices .hint { flex-basis: 100%; margin: 0; color: var(--subtle); font-size: 12px; }
  .note { margin: 0; color: var(--muted); font-size: 12.5px; }
  .secret { display: flex; align-items: center; gap: 10px; padding: 12px; border: 1px dashed var(--navy-2); border-radius: 8px; background: var(--blue-soft); }
  .secret code { flex: 1; font-size: 18px; font-weight: 700; letter-spacing: 0.04em; }
  @media (max-width: 720px) { .filters, .grid { grid-template-columns: 1fr; } }
  .mfa-cell { display: grid; justify-items: start; gap: 4px; }
  .switch { display: inline-flex; align-items: center; gap: 6px; padding: 0; border: 0; background: none; color: var(--muted); font: inherit; font-size: 12px; cursor: pointer; white-space: nowrap; }
  .switch .knob { position: relative; width: 30px; height: 17px; border-radius: 999px; background: var(--line); transition: background 0.15s; }
  .switch .knob::after { content: ''; position: absolute; top: 2px; left: 2px; width: 13px; height: 13px; border-radius: 50%; background: #fff; box-shadow: 0 1px 2px rgba(0, 0, 0, 0.25); transition: left 0.15s; }
  .switch[aria-checked='true'] { color: var(--navy); font-weight: 600; }
  .switch[aria-checked='true'] .knob { background: var(--green); }
  .switch[aria-checked='true'] .knob::after { left: 15px; }
  .switch:focus-visible .knob { outline: 2px solid var(--navy-2); outline-offset: 2px; }
  .mfa-req { color: var(--muted); font-size: 12px; }
</style>
