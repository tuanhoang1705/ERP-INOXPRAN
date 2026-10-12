<script lang="ts">
  import { Languages } from 'lucide-svelte';
  import { changeLocale, getLocale, LOCALE_OPTIONS } from '$lib/i18n';
  import type { Locale } from '$lib/paraglide/runtime';
  import { m } from '$lib/paraglide/messages';

  let { tone = 'dark' }: { tone?: 'dark' | 'light' } = $props();
  const current = getLocale();
</script>

<label class="locale" class:light={tone === 'light'} title={m.ngon_ngu()}>
  <Languages size={16} />
  <select value={current} onchange={(event) => changeLocale(event.currentTarget.value as Locale)} aria-label={m.ngon_ngu()}>
    {#each LOCALE_OPTIONS as option}<option value={option.value}>{option.label}</option>{/each}
  </select>
</label>

<style>
  .locale { display: inline-flex; align-items: center; gap: 6px; height: 36px; padding: 0 10px; border: 1px solid rgba(255, 255, 255, 0.25); border-radius: 8px; color: #fff; cursor: pointer; }
  .locale select { border: 0; background: transparent; color: inherit; font: inherit; font-size: 13px; font-weight: 600; cursor: pointer; outline: none; }
  .locale select option { color: var(--text); }
  .locale:focus-within { border-color: #fff; }
  @media (max-width: 560px) { .locale { gap: 0; padding: 0 6px; } .locale :global(svg) { display: none; } .locale select { max-width: 78px; } }
  .light { border-color: var(--line); color: var(--navy); background: var(--surface); }
  .light:focus-within { border-color: var(--navy); }
</style>
