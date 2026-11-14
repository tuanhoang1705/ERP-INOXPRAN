<script lang="ts">
  import type { SalesOrder } from '@inoxpran/contracts';
  import { onMount } from 'svelte';
  import { page } from '$app/state';
  import { CircleAlert } from 'lucide-svelte';
  import { m } from '$lib/paraglide/messages';
  import { api } from '$lib/api';
  import SampleIssueForm from '$lib/components/SampleIssueForm.svelte';

  let order = $state<SalesOrder | null>(null);
  let error = $state('');
  onMount(async () => {
    try {
      order = await api<SalesOrder>(`/sample-issues/${page.params.id}`);
    } catch (caught) {
      error = caught instanceof Error ? caught.message : m.khong_tai_duoc_du_lieu_danh();
    }
  });
</script>

<svelte:head><title>{m.inv_sua_phieu_tra({ code: order?.code ?? '' })} · INOXPRAN ERP</title></svelte:head>

<section class="page-head">
  <div>
    <nav class="crumbs" aria-label={m.duong_dan()}><a href="/inventory">{m.kho_giao_hang()}</a><span><a href="/inventory/sample-issues">{m.xm_tieu_de()}</a></span><span>{order?.code ?? ''}</span></nav>
    <h1 class="page-title">{m.inv_sua_phieu_tra({ code: order?.code ?? '' })}</h1>
    <p class="page-sub">{m.xm_sua_mo_ta()}</p>
  </div>
</section>

{#if error}<div class="banner error"><CircleAlert size={17} />{error}</div>{/if}
{#if order}<SampleIssueForm existing={order} />{/if}
