<script lang="ts">
  /**
   * Bản in nằm ngoài khung ứng dụng nên tự kiểm tra vùng hiển thị (VIS-ROLE-01, 13/11/2026): tài khoản không thuộc phần việc của
   * bản in (VD phiếu BH với tài khoản bảo hành) thấy khung "không có quyền" thay vì trang lỗi. API vẫn chặn riêng.
   */
  import type { Snippet } from 'svelte';
  import { onMount } from 'svelte';
  import { page } from '$app/state';
  import { m } from '$lib/paraglide/messages';
  import { api } from '$lib/api';
  import { canSeePath, type VisibilityUser } from '$shared/visibility';

  let { children }: { children: Snippet } = $props();
  let status = $state<'checking' | 'ok' | 'blocked'>('checking');

  onMount(async () => {
    // Chưa đăng nhập / lỗi mạng: để trang in tự báo lỗi như trước.
    const user = await api<VisibilityUser>('/auth/me').catch(() => null);
    status = user && !canSeePath(user, page.url.pathname) ? 'blocked' : 'ok';
  });
</script>

{#if status === 'ok'}
  {@render children()}
{:else if status === 'blocked'}
  <section class="no-access" role="alert">
    <h1>{m.vis_khong_co_quyen()}</h1>
    <p>{m.vis_khong_co_quyen_mo_ta()}</p>
    <button onclick={() => window.close()}>{m.dong()}</button>
  </section>
{/if}

<style>
  .no-access { max-width: 480px; margin: 80px auto; padding: 28px 24px; border: 1px solid #d8dee6; border-radius: 12px; color: #5a6b7c; font-family: system-ui, sans-serif; text-align: center; }
  .no-access h1 { margin: 0 0 8px; color: #1d2a36; font-size: 18px; }
  .no-access p { margin: 0 0 16px; font-size: 13.5px; line-height: 1.5; }
  .no-access button { padding: 8px 18px; border: 1px solid #c9d2dc; border-radius: 8px; background: #fff; cursor: pointer; }
</style>
