<script lang="ts">
  import { m } from '$lib/paraglide/messages';
  import SampleIssueForm from '$lib/components/SampleIssueForm.svelte';
</script>

<svelte:head><title>{m.xm_lap_phieu()} · INOXPRAN ERP</title></svelte:head>

<section class="page-head">
  <div>
    <nav class="crumbs" aria-label={m.duong_dan()}><a href="/inventory">{m.kho_giao_hang()}</a><span><a href="/inventory/sample-issues">{m.xm_tieu_de()}</a></span><span>{m.xm_lap_phieu()}</span></nav>
    <h1 class="page-title">{m.xm_lap_phieu()}</h1>
    <p class="page-sub">{m.xm_lap_mo_ta()}</p>
  </div>
</section>

<SampleIssueForm />
