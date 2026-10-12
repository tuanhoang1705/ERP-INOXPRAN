<script lang="ts">
  import '../app.css';
  import { onMount } from 'svelte';
  import { htmlLang } from '$lib/i18n';

  onMount(() => {
    document.documentElement.lang = htmlLang();
  });
</script>

<svelte:head>
  <title>INOXPRAN ERP</title>
</svelte:head>

<slot />
