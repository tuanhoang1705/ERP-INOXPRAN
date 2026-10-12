<script lang="ts">
  /** Đơn mua / hợp đồng nhập hàng dạng cửa sổ chứng từ. */
  import { page } from '$app/state';
  import PurchaseOrderRecord from '$lib/components/record/PurchaseOrderRecord.svelte';
</script>

<PurchaseOrderRecord id={page.params.id ?? ''} />
