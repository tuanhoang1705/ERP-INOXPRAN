<script lang="ts">
  /** Ô chọn người mượn / phụ trách (STAFF-PICK-01): nhóm NVKD (theo mã) và nhóm tài khoản khác (kèm chức danh / vai trò). */
  import { m } from '$lib/paraglide/messages';
  import { roleLabel } from '$lib/labels';
  import type { StaffOption } from '$lib/staff';

  let {
    id,
    value = $bindable(''),
    options,
    placeholder = '—',
    missing = false,
  }: { id: string; value?: string; options: readonly StaffOption[]; placeholder?: string; missing?: boolean } = $props();

  const employees = $derived(options.filter((row) => row.kind === 'EMPLOYEE'));
  const users = $derived(options.filter((row) => row.kind === 'USER'));
  const detail = (row: StaffOption) => row.title || row.roles.map((role) => roleLabel[role] ?? role).join(', ');
</script>

<select {id} bind:value class:missing>
  <option value="">{placeholder}</option>
  {#if employees.length}
    <optgroup label={m.staff_nhom_nvkd()}>
      {#each employees as row (row.id)}<option value={row.id}>{row.name}{row.code ? ` (${row.code})` : ''}</option>{/each}
    </optgroup>
  {/if}
  {#if users.length}
    <optgroup label={m.staff_nhom_khac()}>
      {#each users as row (row.id)}<option value={row.id}>{row.name}{detail(row) ? ` — ${detail(row)}` : ''}</option>{/each}
    </optgroup>
  {/if}
</select>

<style>
  select.missing { border-color: #f0b38f; }
</style>
