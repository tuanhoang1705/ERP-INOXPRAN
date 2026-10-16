<script lang="ts">
  /**
   * Quyền nghiệp vụ của một tài khoản (PERM-01): ô tích theo nhóm, mặc định theo vai trò; quản trị gốc tích / bỏ tích,
   * người khác chỉ xem. Danh sách quyền lấy từ `$shared/permissions` — thêm quyền mới ở đó là ô tích tự hiện.
   */
  import { CircleAlert, RotateCcw } from 'lucide-svelte';
  import { m } from '$lib/paraglide/messages';
  import { getLocale } from '$lib/paraglide/runtime';
  import type { AdminUser } from '@inoxpran/contracts';
  import { PERMISSION_GROUPS, PERMISSIONS, roleHasPermission, type PermissionKey } from '$shared/permissions';
  import { api } from '$lib/api';
  import Dialog from './Dialog.svelte';

  let { open = $bindable(false), user, editable, onsaved }: {
    open?: boolean;
    user: AdminUser | null;
    /** Chỉ quản trị gốc sửa được; tài khoản gốc luôn có mọi quyền. */
    editable: boolean;
    onsaved: (user: AdminUser) => void;
  } = $props();

  let checked = $state<Record<string, boolean>>({});
  let saving = $state(false);
  let error = $state('');
  const canEdit = $derived(editable && !user?.root);

  $effect(() => {
    if (open && user) {
      checked = Object.fromEntries(PERMISSIONS.map((item) => [item.key, Boolean(user.root) || user.permissions.includes(item.key)]));
      error = '';
    }
  });

  const text = (item: { vi: string; zh: string }) => (getLocale() === 'zh' ? item.zh : item.vi);
  const byRole = (key: PermissionKey) => roleHasPermission(user?.roles ?? [], key);
  const customized = (key: PermissionKey) => Boolean(user) && !user?.root && checked[key] !== byRole(key);

  async function save() {
    if (!user) return;
    saving = true;
    error = '';
    try {
      const overrides = Object.fromEntries(PERMISSIONS.map((item) => [item.key, checked[item.key] === byRole(item.key) ? null : checked[item.key]]));
      const updated = await api<AdminUser>(`/admin/users/${user.id}/permissions`, { method: 'PATCH', body: JSON.stringify({ overrides }) });
      onsaved(updated);
      open = false;
    } catch (caught) {
      error = caught instanceof Error ? caught.message : m.crud_loi_luu();
    } finally {
      saving = false;
    }
  }
</script>

<Dialog bind:open title={m.perm_tieu_de({ name: user?.displayName ?? '' })} wide>
  {#if user?.root}<p class="note">{m.perm_root_tat_ca()}</p>{:else if !editable}<p class="note">{m.perm_chi_root_sua()}</p>{:else}<p class="note">{m.perm_huong_dan()}</p>{/if}
  {#each PERMISSION_GROUPS as group (group.key)}
    <h3>{text(group)}</h3>
    <ul class="perms">
      {#each PERMISSIONS.filter((item) => item.group === group.key) as item (item.key)}
        <li class:custom={customized(item.key)}>
          <label>
            <input type="checkbox" bind:checked={checked[item.key]} disabled={!canEdit} />
            <span>{text(item)}</span>
          </label>
          <span class="meta">
            <small>{byRole(item.key) ? m.perm_mac_dinh_co() : m.perm_mac_dinh_khong()}</small>
            {#if customized(item.key)}
              <span class="pill orange">{m.perm_chinh_rieng()}</span>
              {#if canEdit}<button type="button" class="link" onclick={() => (checked[item.key] = byRole(item.key))}><RotateCcw size={13} />{m.perm_ve_mac_dinh()}</button>{/if}
            {/if}
          </span>
        </li>
      {/each}
    </ul>
  {/each}
  {#if error}<div class="banner error"><CircleAlert size={17} /><span>{error}</span></div>{/if}
  {#snippet footer()}
    <button type="button" class="btn" onclick={() => (open = false)}>{m.dong()}</button>
    {#if canEdit}<button type="button" class="btn primary" disabled={saving} onclick={save}>{saving ? m.kh_dang_luu() : m.perm_luu()}</button>{/if}
  {/snippet}
</Dialog>

<style>
  .note { margin: 0 0 12px; color: var(--muted); font-size: 13px; line-height: 1.5; }
  h3 { margin: 12px 0 6px; font-size: 13px; text-transform: uppercase; letter-spacing: 0.02em; color: var(--subtle); }
  .perms { display: grid; gap: 6px; margin: 0; padding: 0; list-style: none; }
  .perms li { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 6px 12px; padding: 9px 12px; border: 1px solid var(--line-soft); border-radius: 8px; }
  .perms li.custom { border-color: var(--amber); background: var(--amber-soft); }
  .perms label { display: flex; align-items: flex-start; gap: 9px; min-width: 0; font-size: 13.5px; line-height: 1.45; cursor: pointer; }
  .perms input { flex: none; width: 16px; height: 16px; margin-top: 2px; }
  .meta { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; }
  .meta small { color: var(--subtle); }
  .link { display: inline-flex; align-items: center; gap: 4px; padding: 0; border: 0; background: none; color: var(--navy); font-size: 12.5px; cursor: pointer; }
</style>
