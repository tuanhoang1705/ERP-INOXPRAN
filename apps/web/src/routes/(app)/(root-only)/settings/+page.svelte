<script lang="ts">
  import { m } from '$lib/paraglide/messages';
  import { onMount } from 'svelte';
  import { CircleAlert } from 'lucide-svelte';
  import { api } from '$lib/api';

  type MisaStatus = { configured: boolean; mode: string; baseUrl: string; pendingEvents: number; sourceOfTruth: { operations: string; statutoryAccounting: string } };
  let misa = $state<MisaStatus | null>(null);
  let loading = $state(true);
  let error = $state('');

  async function load() {
    loading = true;
    error = '';
    try {
      misa = await api<MisaStatus>('/integrations/misa/status');
    } catch (caught) {
      error = caught instanceof Error ? caught.message : m.khong_tai_duoc_trang_thai_tich();
    } finally {
      loading = false;
    }
  }
  onMount(load);
</script>

<svelte:head><title>{m.thiet_lap_he_thong_inoxpran_erp()}</title></svelte:head>

<section class="page-head">
  <div>
    <nav class="crumbs" aria-label={m.duong_dan()}><a href="/">{m.tong_quan()}</a><span>{m.thiet_lap_he_thong()}</span></nav>
    <h1 class="page-title">{m.thiet_lap_tich_hop()}</h1>
    <p class="page-sub">{m.trang_thai_nen_tang_ranh_gioi()}</p>
  </div>
  <div class="actions"><button class="btn" onclick={load}>{m.kiem_tra_lai()}</button></div>
</section>

{#if error}<div class="banner error"><CircleAlert size={17} />{error}</div>{/if}

<section class="grid">
  <article class="card">
    <header class="card-head head"><div><h2>{m.misa_amis_ke_toan()}</h2><p>{m.tich_hop_giai_doan_2()}</p></div><span class={`pill ${misa?.configured ? 'success' : 'warning'}`}>{misa?.configured ? m.da_cau_hinh() : m.chua_ket_noi()}</span></header>
    {#if loading}<p class="body muted">{m.dang_kiem_tra()}</p>
    {:else if misa}
      <dl>
        <div><dt>{m.nguon_chuan_nghiep_vu_van_hanh()}</dt><dd>{misa.sourceOfTruth.operations}</dd></div>
        <div><dt>{m.nguon_chuan_ke_toan_phap_dinh()}</dt><dd>{misa.sourceOfTruth.statutoryAccounting}</dd></div>
        <div><dt>{m.su_kien_cho_dong_bo()}</dt><dd>{misa.pendingEvents}</dd></div>
        <div><dt>{m.dia_chi_ket_noi()}</dt><dd>{misa.baseUrl}</dd></div>
      </dl>
      <p class="note">{m.chi_bat_gui_chung_tu_sau()}</p>
    {/if}
  </article>
  <article class="card">
    <header class="card-head head"><div><h2>{m.kiem_soat_bao_mat()}</h2><p>{m.dang_ap_dung()}</p></div><span class="pill success">{m.dang_bat()}</span></header>
    <ul>
      <li><b>{m.phien_dang_nhap_an_toan()}</b><span>{m.cookie_httponly_chong_gia_mao_yeu()}</span></li>
      <li><b>{m.phan_quyen_theo_vai_tro_pham()}</b><span>{m.moi_api_kiem_tra_vai_tro()}</span></li>
      <li><b>{m.xac_thuc_hai_lop_totp()}</b><span>{m.bat_buoc_voi_quan_tri_vien()}</span></li>
      <li><b>{m.nhat_ky_kiem_toan()}</b><span>{m.ghi_lai_ai_lam_gi_luc()}</span></li>
    </ul>
  </article>
  <article class="card">
    <header class="card-head head"><div><h2>{m.tinh_nhat_quan_du_lieu()}</h2><p>MongoDB replica set</p></div><span class="pill success">{m.dang_bat()}</span></header>
    <ul>
      <li><b>{m.giao_dich_nhieu_chung_tu()}</b><span>{m.giu_hang_xuat_kho_cong_no()}</span></li>
      <li><b>{m.so_kho_bat_bien()}</b><span>{m.chung_tu_da_ghi_so_chi()}</span></li>
      <li><b>{m.chong_ghi_trung()}</b><span>{m.moi_lenh_ghi_co_khoa_idempotency()}</span></li>
    </ul>
  </article>
  <article class="card">
    <header class="card-head head"><div><h2>{m.tac_vu_nen()}</h2><p>Worker BullMQ</p></div><span class="pill">{m.theo_lich()}</span></header>
    <ul>
      <li><b>{m.ra_soat_cong_no_qua_han()}</b><span>{m.t_06_00_hang_ngay_gio_viet()}</span></li>
      <li><b>{m.thong_bao_phe_duyet()}</b><span>{m.gui_toi_truong_phong_giam_doc()}</span></li>
    </ul>
  </article>
</section>

<style>
  .grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 18px; }
  .head { padding-bottom: 14px; border-bottom: 1px solid var(--line-soft); }
  .body { padding: 16px 20px; }
  dl { margin: 0; padding: 8px 20px 4px; }
  dl div { display: flex; justify-content: space-between; gap: 14px; padding: 10px 0; border-bottom: 1px solid var(--line-soft); }
  dt { color: var(--muted); }
  dd { margin: 0; max-width: 60%; font-weight: 500; text-align: right; overflow-wrap: anywhere; }
  .note { margin: 12px 20px 18px; padding: 10px 12px; border-left: 3px solid var(--orange); background: var(--orange-soft); color: var(--muted); font-size: 13px; }
  ul { display: grid; margin: 0; padding: 6px 20px 16px; list-style: none; }
  li { display: grid; gap: 3px; padding: 10px 0; border-bottom: 1px solid var(--line-soft); }
  li:last-child { border-bottom: 0; }
  li span { color: var(--muted); font-size: 13px; }
  @media (max-width: 900px) { .grid { grid-template-columns: 1fr; } }
</style>
