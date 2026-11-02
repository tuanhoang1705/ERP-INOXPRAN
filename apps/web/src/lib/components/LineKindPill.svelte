<script lang="ts">
  /** Nhãn hàng tặng / đổi / bù trên dòng phiếu BH (SAL-KIND-01): cam / xanh / tím — dùng chung cho trang phiếu, đề nghị sửa. */
  import { zeroPriceKindLabel, zeroPriceKindTone } from '$lib/labels';
  import type { ZeroPriceKind } from '$shared/sales-line-kind';

  let { kind }: { kind: ZeroPriceKind } = $props();
</script>

<span class={`pill ${zeroPriceKindTone(kind)} line-kind`}>{zeroPriceKindLabel(kind)}</span>

<style>
  .line-kind { margin-left: 8px; vertical-align: 1px; }
</style>
