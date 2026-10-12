/**
 * Loại phát sinh kho chuẩn — khớp các cột của bảng tồn kho tháng `月库存明细单` công ty đang dùng
 * (docs/inventory-excel-mapping.md). Dùng chung cho thẻ kho, báo cáo tồn kho tháng, nhật ký xuất nhập và file Excel.
 *
 * Mỗi phát sinh thẻ kho thuộc đúng một loại: lấy trường `category` nếu có, không thì suy ra từ `movementType`
 * (dữ liệu cũ). Quy ước như file Excel:
 *   Xuất tổng hợp (综合出库) = tổng các loại XUẤT − tổng các loại NHẬP (kể cả nhập hàng mua)
 *   Tồn cuối kỳ (库存结余)  = tồn đầu kỳ − xuất tổng hợp
 */
export type StockDirection = 'IN' | 'OUT';

export interface InventoryCategoryInfo {
  code: string;
  direction: StockDirection;
  /** Tiêu đề cột tiếng Trung như file Excel của công ty. */
  zh: string;
  vi: string;
  /** Cột riêng của ERP, chỉ hiện khi kỳ báo cáo có phát sinh. */
  optional?: boolean;
}

export const INVENTORY_CATEGORIES = [
  { code: 'PURCHASE_IN', direction: 'IN', zh: '本月（入库）', vi: 'Nhập hàng mua' },
  { code: 'SALES_OUT', direction: 'OUT', zh: '本月（出库）', vi: 'Xuất bán' },
  { code: 'LOSS_OUT', direction: 'OUT', zh: '本月损耗（出库）', vi: 'Hao hụt' },
  { code: 'SAMPLE_OUT', direction: 'OUT', zh: '样品（出库）', vi: 'Hàng mẫu xuất' },
  { code: 'GIFT_OUT', direction: 'OUT', zh: '活动赠送·套餐搭配（出库）', vi: 'Hàng tặng KM / combo xuất' },
  { code: 'GIFT_RETURN_IN', direction: 'IN', zh: '活动赠送·套餐搭配退回（入库）', vi: 'Hàng tặng / combo trả lại' },
  { code: 'IMPORT_DEFECT_IN', direction: 'IN', zh: '进口不良（入库）', vi: 'Hàng lỗi nhập khẩu' },
  { code: 'USAGE_DEFECT_IN', direction: 'IN', zh: '使用不良（入库）', vi: 'Hàng lỗi do sử dụng' },
  { code: 'SLOW_RETURN_IN', direction: 'IN', zh: '滞销退货（入库）', vi: 'Hàng bán chậm trả lại' },
  { code: 'SAMPLE_IN', direction: 'IN', zh: '样品（入库）', vi: 'Hàng mẫu nhập lại' },
  { code: 'FACTORY_RETURN_OUT', direction: 'OUT', zh: '库存退货（出库返厂）', vi: 'Hàng tồn trả nhà máy' },
  { code: 'WARRANTY_OUT', direction: 'OUT', zh: '保修换新（出库）', vi: 'Xuất đổi bảo hành', optional: true },
  { code: 'ADJUST_IN', direction: 'IN', zh: '盘盈·其他（入库）', vi: 'Kiểm kê thừa / điều chỉnh tăng', optional: true },
  { code: 'ADJUST_OUT', direction: 'OUT', zh: '盘亏·其他（出库）', vi: 'Kiểm kê thiếu / điều chỉnh giảm', optional: true },
  { code: 'OPENING_IN', direction: 'IN', zh: '期初导入（入库）', vi: 'Tồn đầu kỳ nhập hệ thống', optional: true },
  { code: 'TRANSFER_IN', direction: 'IN', zh: '调拨（入库）', vi: 'Chuyển kho đến', optional: true },
  { code: 'TRANSFER_OUT', direction: 'OUT', zh: '调拨（出库）', vi: 'Chuyển kho đi', optional: true },
] as const satisfies readonly InventoryCategoryInfo[];

export type InventoryCategory = (typeof INVENTORY_CATEGORIES)[number]['code'];
export const INVENTORY_CATEGORY_CODES = INVENTORY_CATEGORIES.map((item) => item.code) as InventoryCategory[];

const BY_CODE = new Map<string, InventoryCategoryInfo>(INVENTORY_CATEGORIES.map((item) => [item.code, item]));

export function categoryInfo(code: string): InventoryCategoryInfo | undefined {
  return BY_CODE.get(code);
}

export function isInventoryCategory(value: unknown): value is InventoryCategory {
  return typeof value === 'string' && BY_CODE.has(value);
}

/** Loại được chọn trên phiếu điều chỉnh tồn theo chiều tăng / giảm. */
export const ADJUSTMENT_CATEGORIES = {
  IN: ['ADJUST_IN', 'SAMPLE_IN'],
  OUT: ['ADJUST_OUT', 'LOSS_OUT', 'SAMPLE_OUT'],
} as const satisfies Record<StockDirection, readonly InventoryCategory[]>;
export type AdjustmentCategory = (typeof ADJUSTMENT_CATEGORIES)['IN' | 'OUT'][number];

/** Loại hàng khách trả (phiếu nhập trả hàng). Hàng lỗi mặc định nhập kho hàng lỗi. */
export const CUSTOMER_RETURN_CATEGORIES = ['SLOW_RETURN_IN', 'GIFT_RETURN_IN', 'IMPORT_DEFECT_IN', 'USAGE_DEFECT_IN'] as const;
export type CustomerReturnCategory = (typeof CUSTOMER_RETURN_CATEGORIES)[number];
export const DEFECT_RETURN_CATEGORIES: readonly CustomerReturnCategory[] = ['IMPORT_DEFECT_IN', 'USAGE_DEFECT_IN'];

/** Loại suy ra từ nghiệp vụ thẻ kho khi phát sinh chưa ghi `category` (dữ liệu trước 08/10/2026). */
export const MOVEMENT_TYPE_CATEGORY: Readonly<Record<string, InventoryCategory>> = {
  OPENING: 'OPENING_IN',
  PURCHASE_RECEIPT: 'PURCHASE_IN',
  SALES_SHIPMENT: 'SALES_OUT',
  CUSTOMER_RETURN: 'SLOW_RETURN_IN',
  SUPPLIER_RETURN: 'FACTORY_RETURN_OUT',
  TRANSFER_IN: 'TRANSFER_IN',
  TRANSFER_OUT: 'TRANSFER_OUT',
  ADJUSTMENT_IN: 'ADJUST_IN',
  ADJUSTMENT_OUT: 'ADJUST_OUT',
  // Hoàn tác tồn đầu kỳ của lô nhập Excel: trừ vào cột tồn đầu kỳ nhập hệ thống.
  REVERSAL: 'OPENING_IN',
  WARRANTY_EXCHANGE_OUT: 'WARRANTY_OUT',
  WARRANTY_DEFECT_IN: 'USAGE_DEFECT_IN',
};

export function categoryOf(movement: { movementType: string; direction: StockDirection; category?: string | null | undefined }): InventoryCategory {
  if (isInventoryCategory(movement.category)) return movement.category;
  return MOVEMENT_TYPE_CATEGORY[movement.movementType] ?? (movement.direction === 'IN' ? 'ADJUST_IN' : 'ADJUST_OUT');
}

/** Số cộng vào cột của loại: cùng chiều với loại thì dương, ngược chiều (VD hoàn tác) thì âm. */
export function categoryAmount(category: InventoryCategory, direction: StockDirection, quantity: number): number {
  return (categoryInfo(category)?.direction ?? direction) === direction ? quantity : -quantity;
}

/** Xuất tổng hợp và tồn cuối kỳ theo cách tính của file Excel. */
export function monthlyBalance(opening: number, amounts: Partial<Record<InventoryCategory, number>>): { netOut: number; closing: number } {
  let netOut = 0;
  for (const item of INVENTORY_CATEGORIES) {
    const value = amounts[item.code] ?? 0;
    netOut += item.direction === 'OUT' ? value : -value;
  }
  netOut = Math.round(netOut * 10_000) / 10_000;
  return { netOut, closing: Math.round((opening - netOut) * 10_000) / 10_000 };
}

/** % tồn còn lại = tồn cuối ÷ số lượng nhập ban đầu (null khi chưa có số nhập ban đầu). */
export function remainingPercent(closing: number, initialQuantity: number): number | null {
  if (!(initialQuantity > 0)) return null;
  return Math.round((closing / initialQuantity) * 10_000) / 100;
}
