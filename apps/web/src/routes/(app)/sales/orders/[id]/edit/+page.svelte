<script lang="ts">
  import { m } from '$lib/paraglide/messages';
  import type { SalesOrder } from '@inoxpran/contracts';
  import { page } from '$app/state';
  import { onMount } from 'svelte';
  import { CircleAlert } from 'lucide-svelte';
  import SalesIssueForm from '$lib/components/SalesIssueForm.svelte';
  import { api } from '$lib/api';
  import { can, session } from '$lib/session.svelte';
  import { salesEditStage } from '$shared/sales-steps';
  import type { ChangeRequest } from '$lib/change-requests';

  let order = $state<SalesOrder | null>(null);
  let error = $state('');
  /** Sửa bằng quyền đã được duyệt (SAL-EDIT-GRANT-01, 06/11/2026): `?grant=<id>` — máy chủ kiểm lại khi lưu. */
  const grantId = $derived(page.url.searchParams.get('grant') ?? '');

  onMount(async () => {
    try {
      const loaded = await api<SalesOrder>(`/sales-orders/${page.params.id}`);
      const stage = salesEditStage(loaded);
      // Phiếu nháp: người được phân công bước 1 hoặc 2 (SAL-STEP-01). Đã đối chiếu trở đi: người sửa trực tiếp (`sales.edit_issued`)
      // hoặc người có quyền sửa đã được duyệt cho phiếu này. Đã phát hành chưa đối chiếu: không sửa — hoàn tác phiếu (SAL-UNDO-01).
      if (stage === 'DRAFT' && (can('sales.step.create') || can('sales.step.issue'))) order = loaded;
      else if (stage === 'EDIT' && can('sales.edit_issued')) order = loaded;
      else if (stage === 'EDIT' && grantId && can('sales.change_request')) {
        const grant = await api<ChangeRequest>(`/sales-change-requests/${grantId}`).catch(() => null);
        if (grant && grant.kind === 'EDIT_GRANT' && grant.status === 'GRANTED' && grant.orderId === loaded.id && grant.requestedById === session.user?.sub) order = loaded;
        else error = m.yc_quyen_khong_hieu_luc();
      } else error = stage === 'UNDO' ? m.yc_dung_hoan_tac() : m.chi_sua_duoc_phieu_o_trang();
    } catch (caught) {
      error = caught instanceof Error ? caught.message : m.khong_tai_duoc_phieu();
    }
  });
</script>

<svelte:head><title>{m.sua_phieu_xuat_kho_ban_hang_2()}</title></svelte:head>

{#if error}<div class="banner error"><CircleAlert size={17} />{error} <a class="link" href={`/sales/orders/${page.params.id}`}>{m.quay_lai_phieu()}</a></div>{/if}
{#if order}<SalesIssueForm existing={order} {grantId} />{/if}
