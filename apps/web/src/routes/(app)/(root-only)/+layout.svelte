<script lang="ts">
  // Giám sát hệ thống, nhật ký hệ thống, nhập dữ liệu ban đầu, thiết lập hệ thống: chỉ tài khoản quản trị gốc (root).
  // API cũng chặn (RootOnly); ở đây báo rõ thay vì để trang gọi API rồi lỗi.
  import { m } from '$lib/paraglide/messages';
  import { ShieldAlert } from 'lucide-svelte';
  import { session } from '$lib/session.svelte';
  let { children } = $props();
</script>

{#if session.user?.root}
  {@render children()}
{:else}
  <section class="page-head"><div><h1 class="page-title">{m.root_only_title()}</h1><p class="page-sub">{m.root_only_sub()}</p></div></section>
  <div class="banner error"><ShieldAlert size={17} /><span>{m.err_root_only()}</span></div>
{/if}
