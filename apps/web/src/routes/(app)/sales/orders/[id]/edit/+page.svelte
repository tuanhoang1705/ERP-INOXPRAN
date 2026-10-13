<script lang="ts">
  import { m } from '$lib/paraglide/messages';
  import type { SalesOrder } from '@inoxpran/contracts';
  import { page } from '$app/state';
  import { onMount } from 'svelte';
  import { CircleAlert } from 'lucide-svelte';
  import SalesIssueForm from '$lib/components/SalesIssueForm.svelte';
  import { api } from '$lib/api';
  import { session } from '$lib/session.svelte';

  let order = $state<SalesOrder | null>(null);
  let error = $state('');

  onMount(async () => {
    try {
      const loaded = await api<SalesOrder>(`/sales-orders/${page.params.id}`);
      // Quản trị gốc sửa được phiếu ở mọi giai đoạn sau khi phát hành (trừ phiếu đã hủy).
      if (loaded.status === 'DRAFT' || (session.user?.root && loaded.status !== 'CANCELLED')) order = loaded;
      else error = m.chi_sua_duoc_phieu_o_trang();
    } catch (caught) {
      error = caught instanceof Error ? caught.message : m.khong_tai_duoc_phieu();
    }
  });
</script>

<svelte:head><title>{m.sua_phieu_xuat_kho_ban_hang_2()}</title></svelte:head>

{#if error}<div class="banner error"><CircleAlert size={17} />{error} <a class="link" href={`/sales/orders/${page.params.id}`}>{m.quay_lai_phieu()}</a></div>{/if}
{#if order}<SalesIssueForm existing={order} />{/if}
