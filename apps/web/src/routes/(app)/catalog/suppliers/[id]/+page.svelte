<script lang="ts">
  /** Hồ sơ nhà cung cấp — cửa sổ chứng từ dùng chung với khách hàng. */
  import { page } from '$app/state';
  import PartnerRecord from '$lib/components/record/PartnerRecord.svelte';
</script>

<PartnerRecord id={page.params.id ?? ''} kind="supplier" />
