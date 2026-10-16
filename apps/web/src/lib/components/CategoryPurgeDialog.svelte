<script lang="ts">
  /**
   * Quản trị gốc gỡ hẳn cả nhóm hàng (CAT-PURGE-01): xem trước từng mã + tồn đầu kỳ sẽ gỡ (hoặc lý do chưa gỡ được),
   * gõ lại đúng mã nhóm rồi mới gỡ. Gỡ: mã hàng, dòng "Tồn đầu kỳ" trên thẻ kho, dòng tồn, nhóm hàng — như chưa từng nhập.
   */
  import { CircleAlert, Trash2 } from 'lucide-svelte';
  import { m } from '$lib/paraglide/messages';
  import { api } from '$lib/api';
  import { num } from '$lib/format';
  import Dialog from './Dialog.svelte';

  type PreviewRow = { id: string; sku: string; name: string; unit: string; opening: Array<{ warehouse: string; quantity: string }>; total: string; blockers: string[] };
  type Preview = { category: { id: string; code: string; name: string }; products: PreviewRow[]; total: string; blocked: number };

  let { open = $bindable(false), category, onpurged }: {
    open?: boolean;
    category: { id: string; code: string; name: string } | null;
    onpurged: (result: { removed: number; openingQuantity: string }) => void;
  } = $props();

  let preview = $state<Preview | null>(null);
  let confirm = $state('');
  let working = $state(false);
  let error = $state('');

  $effect(() => {
    if (open && category) {
      preview = null;
      confirm = '';
      error = '';
      void api<Preview>(`/product-categories/${category.id}/purge-preview`).then((value) => (preview = value)).catch((caught) => (error = caught instanceof Error ? caught.message : m.khong_the_hoan_tat_thao_tac()));
    }
  });

  const ready = $derived(Boolean(preview && preview.products.length && !preview.blocked && confirm.trim().toUpperCase() === preview.category.code.toUpperCase()));

  async function purge() {
    if (!category || !ready) return;
    working = true;
    error = '';
    try {
      const result = await api<{ removed: number; openingQuantity: string }>(`/product-categories/${category.id}/purge`, { method: 'POST', idempotentCommand: true, body: JSON.stringify({ confirm: confirm.trim() }) });
      open = false;
      onpurged(result);
    } catch (caught) {
      error = caught instanceof Error ? caught.message : m.khong_the_hoan_tat_thao_tac();
    } finally {
      working = false;
    }
  }
</script>

<Dialog bind:open title={m.cp_tieu_de({ name: category?.name ?? '' })} wide>
  <p class="lead">{m.cp_giai_thich()}</p>
  {#if preview}
    {#if !preview.products.length}
      <p class="muted">{m.cp_ma_trong()}</p>
    {:else}
      <p class="sum"><b>{m.cp_tong({ count: preview.products.length, total: num(preview.total) })}</b>{#if preview.blocked} · <span class="bad">{m.cp_bi_chan({ count: preview.blocked })}</span>{/if}</p>
      <div class="table-wrap list">
        <table class="table compact">
          <thead><tr><th>{m.ma_sp()}</th><th>{m.ten_san_pham()}</th><th class="num">{m.cp_ton()}</th><th>{m.cp_ly_do_chan()}</th></tr></thead>
          <tbody>
            {#each preview.products as row (row.id)}
              <tr class:blocked={row.blockers.length > 0}>
                <td class="code">{row.sku}</td>
                <td>{row.name}</td>
                <td class="num">{num(row.total)} {row.unit}{#if row.opening.length > 1}<small>{row.opening.map((item) => `${item.warehouse}: ${num(item.quantity)}`).join(' · ')}</small>{/if}</td>
                <td class="bad">{row.blockers.join(', ')}</td>
              </tr>
            {/each}
          </tbody>
        </table>
      </div>
      {#if !preview.blocked}
        <div class="field">
          <label for="purge-confirm">{m.cp_go_ma({ code: preview.category.code })}</label>
          <input id="purge-confirm" autocomplete="off" bind:value={confirm} placeholder={preview.category.code} />
        </div>
      {/if}
    {/if}
  {:else if !error}<p class="muted">{m.dang_tai()}</p>{/if}
  {#if error}<div class="banner error"><CircleAlert size={17} /><span>{error}</span></div>{/if}
  {#snippet footer()}
    <button class="btn" onclick={() => (open = false)}>{m.dong()}</button>
    <button class="btn danger" disabled={!ready || working} onclick={purge}><Trash2 size={15} />{m.cp_nut()}</button>
  {/snippet}
</Dialog>

<style>
  .lead { margin: 0 0 10px; color: var(--muted); font-size: 13px; line-height: 1.5; }
  .sum { margin: 0 0 8px; font-size: 13.5px; }
  .list { max-height: 340px; overflow-y: auto; margin-bottom: 12px; }
  .bad { color: var(--red); }
  tr.blocked td { background: #fdf0f0; }
  td small { display: block; color: var(--muted); font-size: 12px; }
</style>
