<script lang="ts">
  /** Hồ sơ khách hàng (CRM) — cửa sổ chứng từ dùng chung với nhà cung cấp. */
  import { page } from '$app/state';
  import PartnerRecord from '$lib/components/record/PartnerRecord.svelte';
</script>

<PartnerRecord id={page.params.id ?? ''} kind="customer" />
