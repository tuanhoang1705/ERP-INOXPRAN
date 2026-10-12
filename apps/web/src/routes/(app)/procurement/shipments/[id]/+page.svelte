<script lang="ts">
  /** Lô hàng nhập (container / B/L) dạng cửa sổ chứng từ. */
  import { page } from '$app/state';
  import ImportShipmentRecord from '$lib/components/record/ImportShipmentRecord.svelte';
</script>

<ImportShipmentRecord id={page.params.id ?? ''} />
