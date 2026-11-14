<script lang="ts">
  /**
   * Ô chọn sản phẩm gõ được ở các form kho (PROD-PICK-01, 13/11/2026): gõ mã / tên (có dấu hay không) để lọc,
   * bấm mũi tên mở cả danh sách, ↑↓ chọn, Enter lấy, Esc đóng. Dòng phụ là đơn vị tính.
   * Trong bảng dòng hàng (mặc định `floating`) danh sách nổi theo màn hình nên không bị khung bảng cắt.
   */
  import { m } from '$lib/paraglide/messages';
  import { productPickOptions } from '$lib/product';
  import CustomerPicker from './CustomerPicker.svelte';

  let {
    products,
    value = '',
    onchoose,
    id,
    label,
    disabled = false,
    loading = false,
    invalid = false,
    floating = true,
  }: {
    products: ReadonlyArray<{ id: string; sku: string; name: string; baseUnit?: string | undefined }>;
    value?: string; onchoose: (id: string) => void; id: string; label?: string;
    disabled?: boolean; loading?: boolean; invalid?: boolean; floating?: boolean;
  } = $props();

  const options = $derived(productPickOptions(products));
</script>

<CustomerPicker {id} {label} {options} {value} {onchoose} {disabled} {loading} {invalid} {floating}
  placeholder={m.wr_tim_san_pham()} emptyText={m.pp_khong_tim_thay_san_pham()} toggleLabel={m.wr_mo_ds_san_pham()}
  describe={(option) => (option.unit ? `${m.don_vi_tinh()}: ${option.unit}` : '')} />
