<script lang="ts">
  /**
   * Phân công 5 bước phiếu bán hàng (SAL-STEP-01, 26/10/2026): mỗi tài khoản đang hoạt động một dòng, mỗi bước một ô tích.
   * Mặc định theo vai trò; ô vàng = đã chỉnh riêng. Admin tích / bỏ tích cho tài khoản không phải Admin, quản trị gốc cho mọi
   * tài khoản; Giám đốc / kiểm soát chỉ xem. Lưu từng dòng (PATCH quyền, ô bằng mặc định gửi null).
   */
  import { m } from '$lib/paraglide/messages';
  import { getLocale } from '$lib/paraglide/runtime';
  import type { AdminUser } from '@inoxpran/contracts';
  import { onMount } from 'svelte';
  import { CircleAlert, CircleCheck, Lock, RotateCcw, Save, TriangleAlert, Undo2 } from 'lucide-svelte';
  import { api } from '$lib/api';
  import { roleLabel } from '$lib/labels';
  import { session } from '$lib/session.svelte';
  import { editablePermissionKeys, isStepHolder, roleHasPermission, type PermissionOverrides, type SalesStepKey } from '$shared/permissions';
  import { SALES_STEPS } from '$shared/sales-steps';

  let users = $state<AdminUser[]>([]);
  let checked = $state<Record<string, Record<string, boolean>>>({});
  let loading = $state(true);
  let error = $state('');
  let success = $state('');
  let saving = $state<Record<string, boolean>>({});
  let search = $state('');
  let onlyCustom = $state(false);

  const me = $derived(session.user);
  const actor = $derived({ id: me?.sub ?? '', roles: me?.roles ?? [], root: me?.root });
  /** Admin sửa được; Giám đốc / kiểm soát chỉ xem. */
  const adminView = $derived(Boolean(me?.roles.includes('ADMIN')));
  const zh = getLocale() === 'zh';
  const stepName = (step: (typeof SALES_STEPS)[number]) => (zh ? step.zh : step.vi);

  const effective = (user: AdminUser, key: SalesStepKey) => user.permissions.includes(key);
  const editable = (user: AdminUser) => editablePermissionKeys(actor, user) as string[];
  const canEditCell = (user: AdminUser, key: SalesStepKey) => editable(user).includes(key);
  const byRole = (user: AdminUser, key: SalesStepKey) => roleHasPermission(user.roles, key);
  const customized = (user: AdminUser, key: SalesStepKey) => checked[user.id]?.[key] !== byRole(user, key);
  const dirty = (user: AdminUser) => SALES_STEPS.some((step) => checked[user.id]?.[step.key] !== effective(user, step.key));
  const anyCustom = (user: AdminUser) => SALES_STEPS.some((step) => customized(user, step.key));
  const overridesOf = (user: AdminUser): PermissionOverrides =>
    Object.fromEntries(SALES_STEPS.filter((step) => customized(user, step.key)).map((step) => [step.key, checked[user.id]?.[step.key] ?? false]));
  /** Số người được phân công bước (như người nhận thông báo: không tính Admin chỉ có quyền mặc định của vai trò). */
  const holders = (key: SalesStepKey) => users.filter((user) => isStepHolder({ roles: user.roles, permissionOverrides: overridesOf(user) }, key)).length;
  const visible = $derived(users.filter((user) => {
    const text = search.trim().toLowerCase();
    if (text && !`${user.displayName} ${user.email} ${user.title ?? ''}`.toLowerCase().includes(text)) return false;
    return !onlyCustom || anyCustom(user);
  }));
  const pending = $derived(users.filter(dirty));

  function reset(user: AdminUser) {
    checked[user.id] = Object.fromEntries(SALES_STEPS.map((step) => [step.key, effective(user, step.key)]));
  }
  function toDefault(user: AdminUser) {
    for (const step of SALES_STEPS) if (canEditCell(user, step.key)) checked[user.id]![step.key] = byRole(user, step.key);
  }

  async function load() {
    loading = true;
    error = '';
    try {
      const result = await api<AdminUser[] | { rows: AdminUser[] }>('/admin/users?status=ACTIVE');
      users = (Array.isArray(result) ? result : result.rows).filter((user) => !user.root && user.status === 'ACTIVE');
      checked = {};
      for (const user of users) reset(user);
    } catch (caught) {
      error = caught instanceof Error ? caught.message : m.khong_tai_duoc_danh_sach_nguoi();
    } finally {
      loading = false;
    }
  }

  async function save(user: AdminUser): Promise<boolean> {
    saving[user.id] = true;
    error = '';
    try {
      const overrides = Object.fromEntries(SALES_STEPS.filter((step) => canEditCell(user, step.key)).map((step) => {
        const value = checked[user.id]?.[step.key] ?? false;
        return [step.key, value === byRole(user, step.key) ? null : value];
      }));
      const updated = await api<AdminUser>(`/admin/users/${user.id}/permissions`, { method: 'PATCH', body: JSON.stringify({ overrides }) });
      users = users.map((row) => (row.id === updated.id ? updated : row));
      reset(updated);
      success = m.sst_da_luu({ name: updated.displayName });
      return true;
    } catch (caught) {
      error = `${user.displayName}: ${caught instanceof Error ? caught.message : m.crud_loi_luu()}`;
      return false;
    } finally {
      saving[user.id] = false;
    }
  }
  async function saveAll() {
    let count = 0;
    for (const user of pending) if (await save(user)) count += 1;
    if (count) success = m.sst_da_luu_nhieu({ count });
  }

  onMount(load);
</script>

<section class="card steps">
  <header class="head">
    <div>
      <h2>{m.sst_tieu_de()}</h2>
      <p class="hint">{adminView ? m.sst_huong_dan() : m.sst_chi_xem()}</p>
    </div>
    <div class="tools">
      <input bind:value={search} placeholder={m.adm_search_ph()} aria-label={m.tim_kiem()} />
      <label class="only"><input type="checkbox" bind:checked={onlyCustom} />{m.sst_chi_chinh_rieng()}</label>
      {#if pending.length}<button class="btn primary small" onclick={saveAll}><Save size={14} />{m.sst_luu_tat_ca({ count: pending.length })}</button>{/if}
    </div>
  </header>
  {#if error}<div class="banner error"><CircleAlert size={17} /><span>{error}</span></div>{/if}
  {#if success}<div class="banner success"><CircleCheck size={17} /><span>{success}</span></div>{/if}
  <div class="table-wrap">
    <table class="table compact matrix">
      <colgroup><col class="c-user" />{#each SALES_STEPS as step (step.key)}<col class="c-step" />{/each}<col class="c-act" /></colgroup>
      <thead>
        <tr>
          <th>{m.sst_nguoi_dung()}</th>
          {#each SALES_STEPS as step (step.key)}
            {@const count = holders(step.key)}
            <th class="center"><span class="n">{step.n}</span> {stepName(step)}<small class:zero={count === 0}>{m.sst_so_nguoi({ count })}</small></th>
          {/each}
          <th><span class="sr-only">{m.thao_tac()}</span></th>
        </tr>
      </thead>
      <tbody>
        {#if loading && !users.length}<tr class="empty-row"><td colspan={SALES_STEPS.length + 2}>{m.dang_tai()}</td></tr>
        {:else}
          {#each visible as user (user.id)}
            {@const locked = editable(user).length === 0}
            <tr class:dirty={dirty(user)}>
              <td class="user">
                <b>{user.displayName}</b>{#if locked && adminView}<span class="lock" title={user.id === me?.sub ? m.sst_khoa_ban_than() : m.sst_khoa_admin()}><Lock size={12} /></span>{/if}
                <small>{user.email}</small>
                <span class="roles">{#each user.roles as item}<span class="pill neutral">{roleLabel[item] ?? item}</span>{/each}</span>
              </td>
              {#each SALES_STEPS as step (step.key)}
                <td class="center cell" class:custom={customized(user, step.key)} title={byRole(user, step.key) ? m.perm_mac_dinh_co() : m.perm_mac_dinh_khong()}>
                  <input type="checkbox" aria-label={`${stepName(step)} — ${user.displayName}`} bind:checked={checked[user.id]![step.key]} disabled={!canEditCell(user, step.key)} />
                  {#if step.key === 'sales.step.ship' && !user.warehouseScopes.length && isStepHolder({ roles: user.roles, permissionOverrides: overridesOf(user) }, step.key)}
                    <span class="warn" title={m.sst_khong_pham_vi_kho()}><TriangleAlert size={13} /></span>
                  {/if}
                </td>
              {/each}
              <td class="act">
                {#if dirty(user)}
                  <button class="btn primary small" disabled={saving[user.id]} onclick={() => save(user)}><Save size={13} />{m.sst_luu()}</button>
                  <button class="icon-btn" title={m.sst_hoan_tac()} aria-label={m.sst_hoan_tac()} onclick={() => reset(user)}><Undo2 size={14} /></button>
                {:else if !locked && anyCustom(user)}
                  <button class="link" onclick={() => toDefault(user)}><RotateCcw size={13} />{m.perm_ve_mac_dinh()}</button>
                {/if}
              </td>
            </tr>
          {:else}<tr class="empty-row"><td colspan={SALES_STEPS.length + 2}>{m.sst_khong_co()}</td></tr>{/each}
        {/if}
      </tbody>
    </table>
  </div>
  <p class="hint legend"><span class="swatch"></span>{m.sst_chu_thich()}</p>
</section>

<style>
  .steps { display: grid; gap: 12px; }
  .head { display: flex; flex-wrap: wrap; align-items: flex-start; justify-content: space-between; gap: 10px 16px; }
  .head h2 { margin: 0; font-size: 16px; }
  .hint { margin: 4px 0 0; color: var(--subtle); font-size: 12.5px; max-width: 70ch; }
  .tools { display: flex; flex-wrap: wrap; align-items: center; gap: 8px 12px; }
  .tools input:not([type]) { min-width: 220px; }
  .only { display: inline-flex; align-items: center; gap: 6px; font-size: 13px; color: var(--muted); white-space: nowrap; }
  .matrix { table-layout: fixed; min-width: 860px; }
  .matrix .c-user { width: 30%; }
  .matrix .c-step { width: 11%; }
  .matrix .c-act { width: 15%; }
  .matrix th { vertical-align: bottom; white-space: normal; line-height: 1.3; }
  .matrix th .n { display: inline-grid; place-items: center; width: 18px; height: 18px; border-radius: 50%; background: var(--navy); color: #fff; font-size: 11px; }
  .matrix th small { display: block; margin-top: 3px; color: var(--subtle); font-weight: 500; text-transform: none; }
  .matrix th small.zero { color: var(--red); font-weight: 600; }
  .center { text-align: center; }
  .user b { font-weight: 600; }
  .user small { display: block; color: var(--subtle); font-size: 12px; overflow-wrap: anywhere; }
  .user .roles { display: flex; flex-wrap: wrap; gap: 4px; margin-top: 4px; }
  .user .lock { margin-left: 6px; color: var(--subtle); vertical-align: -1px; }
  .cell input { width: 17px; height: 17px; cursor: pointer; }
  .cell input:disabled { cursor: not-allowed; }
  .cell.custom { background: var(--amber-soft); box-shadow: inset 0 0 0 1px var(--amber); }
  .cell .warn { margin-left: 4px; color: var(--amber); vertical-align: -2px; }
  tr.dirty td { background: var(--soft, #f3f7fb); }
  tr.dirty td.cell.custom { background: var(--amber-soft); }
  .act { white-space: nowrap; }
  .act .btn { margin-right: 4px; }
  .link { display: inline-flex; align-items: center; gap: 4px; padding: 0; border: 0; background: none; color: var(--navy); font-size: 12.5px; cursor: pointer; }
  .legend { display: flex; align-items: center; gap: 8px; }
  .swatch { width: 14px; height: 14px; border-radius: 3px; background: var(--amber-soft); box-shadow: inset 0 0 0 1px var(--amber); }
</style>
