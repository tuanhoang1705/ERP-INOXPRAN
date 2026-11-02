<script lang="ts">
  import { m } from '$lib/paraglide/messages';
  import type { SalesOrder } from '@inoxpran/contracts';
  import { page } from '$app/state';
  import { onMount } from 'svelte';
  import { CircleAlert } from 'lucide-svelte';
  import SalesIssueForm from '$lib/components/SalesIssueForm.svelte';
  import { api } from '$lib/api';
  import { can } from '$lib/session.svelte';

  let order = $state<SalesOrder | null>(null);
  let error = $state('');
  /** Không có quyền sửa trực tiếp nhưng có quyền gửi đề nghị (SAL-CHG-01): form gửi đề nghị sửa thay vì lưu. */
  const requestMode = $derived(page.url.searchParams.get('request') === '1' && !can('sales.edit_issued') && can('sales.change_request'));

  onMount(async () => {
    try {
      const loaded = await api<SalesOrder>(`/sales-orders/${page.params.id}`);
      // Sau khi phát hành (trừ phiếu đã hủy): sửa trực tiếp nếu có quyền sales.edit_issued, hoặc soạn đề nghị sửa.
      // Phiếu nháp: người được phân công bước 1 hoặc 2 (SAL-STEP-01).
      if ((loaded.status === 'DRAFT' && (can('sales.step.create') || can('sales.step.issue'))) || (loaded.status !== 'CANCELLED' && loaded.status !== 'DRAFT' && (can('sales.edit_issued') || requestMode))) order = loaded;
      else error = m.chi_sua_duoc_phieu_o_trang();
    } catch (caught) {
      error = caught instanceof Error ? caught.message : m.khong_tai_duoc_phieu();
    }
  });
</script>

<svelte:head><title>{m.sua_phieu_xuat_kho_ban_hang_2()}</title></svelte:head>

{#if error}<div class="banner error"><CircleAlert size={17} />{error} <a class="link" href={`/sales/orders/${page.params.id}`}>{m.quay_lai_phieu()}</a></div>{/if}
{#if order}<SalesIssueForm existing={order} {requestMode} />{/if}
