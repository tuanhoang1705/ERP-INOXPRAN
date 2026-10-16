import { z } from 'zod';
import { VAT_RATES } from './shared/sales-math.js';
import { DEFAULT_SALES_ISSUE_TEMPLATE, SALES_ISSUE_TEMPLATES, SALES_ORDER_CODE_PATTERN, salesOrderCodeProblem } from './shared/sales-templates.js';
import { isLoanPurpose, isNonSalePurpose, LOAN_CLOSE_OUTCOMES, LOAN_STATUSES, SALES_PURPOSES, SALES_SLIP_TYPES } from './shared/sales-purpose.js';
import { isDateOnly, WARRANTY_CHANNELS, WARRANTY_EXCLUSIONS, WARRANTY_PLANS } from './shared/warranty.js';
import type { WarrantyChannel, WarrantyCoverage, WarrantyExclusion, WarrantyPhotoKind, WarrantyPlan, WarrantyResolution, WarrantyStatus } from './shared/warranty.js';
import { USER_ROLES } from './shared/user-admin.js';
import { CURRENCIES } from './shared/currency.js';
import { ALLOCATION_METHODS, IMPORT_COST_TYPES } from './shared/landed-cost.js';
import { CUSTOMER_RETURN_CATEGORIES } from './shared/inventory-categories.js';
import type { InventoryCategory } from './shared/inventory-categories.js';
import type { StockCountRow, StockCountStatus, StockCountStep } from './shared/stock-count.js';

export * from './shared/sales-math.js';
export * from './shared/sales-templates.js';
export * from './shared/sales-purpose.js';
export * from './shared/warranty.js';
export * from './shared/catalog-access.js';
export * from './shared/user-admin.js';
export * from './shared/permissions.js';
export * from './shared/currency.js';
export * from './shared/packing.js';
export * from './shared/landed-cost.js';
export * from './shared/inventory-categories.js';
export * from './shared/stock-count.js';
export * from './shared/text.js';

export const IdSchema = z.string().min(1).max(64);
export const CodeSchema = z
  .string()
  .trim()
  .min(2)
  .max(40)
  .regex(/^[A-Z0-9][A-Z0-9._/-]*$/, 'Mã chỉ gồm chữ hoa, số và . _ / -');
export const DecimalStringSchema = z
  .string()
  .regex(/^\d+(\.\d{1,4})?$/, 'Giá trị phải là số không âm, tối đa 4 chữ số thập phân');
export const PositiveDecimalStringSchema = DecimalStringSchema.refine(
  (value) => Number(value) > 0,
  'Giá trị phải lớn hơn 0',
);
export const MoneySchema = z
  .string()
  .regex(/^\d+(\.\d{1,2})?$/, 'Số tiền phải là số không âm');
export const PercentageSchema = z
  .string()
  .regex(/^\d+(\.\d{1,2})?$/)
  .refine((value) => Number(value) >= 0 && Number(value) <= 100, 'Tỷ lệ từ 0 đến 100');

export const ProductStatusSchema = z.enum(['ACTIVE', 'INACTIVE']);
/** Tình trạng hàng hóa theo bảng báo giá: Còn hàng / Đang về / Chưa có hàng. */
export const ProductAvailabilitySchema = z.enum(['IN_STOCK', 'INCOMING', 'OUT_OF_STOCK']);
export const SalesChannelSchema = z.enum(['B2B', 'B2C']);
/** TIER_1 = Nhà phân phối (giá Net NPP), TIER_2 = Đại lý (giá đại lý), RETAIL = khách lẻ (giá bán lẻ). */
export const CustomerTierSchema = z.enum(['TIER_1', 'TIER_2', 'RETAIL']);
export const PartnerKindSchema = z.enum(['CUSTOMER', 'SUPPLIER', 'BOTH']);
export const PartnerStatusSchema = z.enum(['ACTIVE', 'ON_HOLD', 'INACTIVE']);
export const ApprovalStatusSchema = z.enum(['NOT_REQUIRED', 'PENDING', 'APPROVED', 'REJECTED']);
export const SalesOrderStatusSchema = z.enum([
  'DRAFT',
  'PENDING_APPROVAL',
  'APPROVED',
  'RESERVED',
  'PARTIALLY_SHIPPED',
  'SHIPPED',
  'DELIVERED',
  'CANCELLED',
]);
export const PurchaseOrderStatusSchema = z.enum([
  'DRAFT',
  'PENDING_APPROVAL',
  'APPROVED',
  'PARTIALLY_RECEIVED',
  'RECEIVED',
  'CANCELLED',
]);
export const InventoryMovementTypeSchema = z.enum([
  'OPENING',
  'PURCHASE_RECEIPT',
  'SALES_SHIPMENT',
  'CUSTOMER_RETURN',
  'SUPPLIER_RETURN',
  'TRANSFER_IN',
  'TRANSFER_OUT',
  'ADJUSTMENT_IN',
  'ADJUSTMENT_OUT',
  'REVERSAL',
  /** Bảo hành: xuất sản phẩm mới đổi cho khách. */
  'WARRANTY_EXCHANGE_OUT',
  /** Bảo hành: nhập sản phẩm lỗi khách trả (đổi mới / hoàn tiền) vào kho hàng lỗi. */
  'WARRANTY_DEFECT_IN',
]);

export const UnitConversionSchema = z.object({
  unit: z.string().trim().min(1).max(30),
  factorToBase: PositiveDecimalStringSchema,
  barcode: z.string().trim().max(80).optional(),
});

export const CurrencySchema = z.enum(CURRENCIES);
/** Thành phẩm / bộ sản phẩm / linh kiện (phân loại như 产品资料 của công ty mẹ). */
export const ProductTypeSchema = z.enum(['FINISHED', 'SET', 'PART']);
const optionalText = (max: number) => z.string().trim().max(max).optional();

/**
 * Hồ sơ sản phẩm đầy đủ (giai đoạn 3, theo mẫu 产品资料): tên / mô tả Trung – Anh, hải quan, đóng gói thùng, thông tin mua.
 * Mọi trường không bắt buộc để dữ liệu cũ vẫn hợp lệ; kích thước / khối lượng là chuỗi số thập phân (cm, kg).
 */
export const ProductProfileSchema = z.object({
  nameZh: optionalText(240),
  nameEn: optionalText(240),
  /** Quy cách (规格) tiếng Trung / Anh, VD "0.6MM 8P". */
  specZh: optionalText(240),
  specEn: optionalText(240),
  descriptionZh: optionalText(2000),
  descriptionEn: optionalText(2000),
  /** Mã vạch đơn vị lẻ (mã vạch thùng nằm trong unitConversions). */
  barcode: optionalText(80),
  brand: optionalText(80),
  material: optionalText(120),
  productType: ProductTypeSchema.optional(),
  hsCode: z.string().trim().regex(/^[0-9.]{4,20}$/, 'Mã HS gồm 4–20 chữ số').optional(),
  customsName: optionalText(240),
  customsElements: optionalText(500),
  defaultVatRate: z.enum(VAT_RATES).optional(),
  /** Số cái mỗi hộp trong (packSize là số cái mỗi thùng). */
  innerPack: z.number().int().positive().optional(),
  cartonLengthCm: DecimalStringSchema.optional(),
  cartonWidthCm: DecimalStringSchema.optional(),
  cartonHeightCm: DecimalStringSchema.optional(),
  grossKgPerCarton: DecimalStringSchema.optional(),
  netKgPerCarton: DecimalStringSchema.optional(),
  purchaseCurrency: CurrencySchema.optional(),
  /** Giá mua mỗi đơn vị cơ bản theo purchaseCurrency (CNY / USD có thể tới 4 chữ số lẻ). */
  purchasePrice: DecimalStringSchema.optional(),
  defaultSupplierId: IdSchema.optional(),
  /** Mã hàng của nhà máy / công ty mẹ (VD MSF-3012-8P-0.6MM). */
  supplierItemCode: optionalText(60),
  defaultLocationCode: CodeSchema.optional(),
  /** Ảnh đại diện (một ảnh trong tab Ảnh / Đính kèm). */
  primaryImageId: IdSchema.optional(),
});
export type ProductProfile = z.infer<typeof ProductProfileSchema>;

export const ProductSchema = z.object({
  id: IdSchema,
  sku: CodeSchema,
  /** Model in trên bao bì / bảng báo giá (VD: INP6-2002). */
  model: z.string().trim().max(60).optional(),
  name: z.string().trim().min(2).max(240),
  categoryId: IdSchema.optional(),
  categoryCode: z.string().optional(),
  categoryName: z.string().optional(),
  baseUnit: z.string().trim().min(1).max(30),
  unitConversions: z.array(UnitConversionSchema).default([]),
  /** Giá bán lẻ chưa VAT; giá NPP và giá đại lý nằm trong bảng giá theo cấp. */
  listPrice: MoneySchema,
  /** Giá vốn tham chiếu dùng định giá tồn kho (mặc định = giá Net NPP). */
  standardCost: MoneySchema.optional(),
  minimumStock: DecimalStringSchema.default('0'),
  packSize: z.number().int().positive().optional(),
  specification: z.string().max(2000).optional(),
  availability: ProductAvailabilitySchema.default('IN_STOCK'),
  clearance: z.boolean().default(false),
  status: ProductStatusSchema,
  version: z.number().int().positive(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  defaultSupplierName: z.string().optional(),
}).extend(ProductProfileSchema.shape);
export type Product = z.infer<typeof ProductSchema>;

export const CreateProductSchema = ProductSchema.pick({
  sku: true,
  model: true,
  name: true,
  categoryId: true,
  baseUnit: true,
  unitConversions: true,
  listPrice: true,
  standardCost: true,
  minimumStock: true,
  packSize: true,
  specification: true,
  availability: true,
  clearance: true,
})
  .extend(ProductProfileSchema.shape)
  .extend({ status: ProductStatusSchema.default('ACTIVE') });
export type CreateProduct = z.infer<typeof CreateProductSchema>;

export const PartnerStageSchema = z.enum(['PROSPECT', 'CUSTOMER']);
/** Xếp hạng khách (A quan trọng nhất). */
export const PartnerGradeSchema = z.enum(['A', 'B', 'C', 'D']);
export const PartnerContactSchema = z.object({
  name: z.string().trim().min(1).max(120),
  title: optionalText(120),
  phone: optionalText(30),
  email: z.string().trim().email().max(160).optional(),
  zalo: optionalText(60),
  primary: z.boolean().optional(),
  note: optionalText(300),
});
export const PartnerAddressSchema = z.object({
  label: optionalText(60),
  address: z.string().trim().min(3).max(500),
  receiver: optionalText(120),
  phone: optionalText(30),
  isDefault: z.boolean().optional(),
});
export const PartnerBankAccountSchema = z.object({
  bankName: z.string().trim().min(2).max(120),
  accountNumber: z.string().trim().min(3).max(40),
  accountName: optionalText(160),
  branch: optionalText(160),
  swift: optionalText(20),
});
export type PartnerContact = z.infer<typeof PartnerContactSchema>;
export type PartnerAddress = z.infer<typeof PartnerAddressSchema>;
export type PartnerBankAccount = z.infer<typeof PartnerBankAccountSchema>;

/** Hồ sơ đối tác kiểu CRM (giai đoạn 3): xếp hạng, nguồn khách, người liên hệ, địa chỉ nhận hàng, tài khoản ngân hàng. */
export const PartnerProfileSchema = z.object({
  grade: PartnerGradeSchema.optional(),
  shortName: optionalText(60),
  /** Nguồn khách: giới thiệu, hội chợ, Zalo, website… (danh sách gợi ý ở giao diện, lưu chữ). */
  source: optionalText(60),
  website: optionalText(200),
  businessLines: optionalText(300),
  paymentMethod: optionalText(120),
  note: optionalText(1000),
  contacts: z.array(PartnerContactSchema).max(30).optional(),
  addresses: z.array(PartnerAddressSchema).max(20).optional(),
  bankAccounts: z.array(PartnerBankAccountSchema).max(10).optional(),
});

export const PartnerSchema = z.object({
  id: IdSchema,
  code: CodeSchema,
  name: z.string().trim().min(2).max(240),
  kind: PartnerKindSchema,
  customerTier: CustomerTierSchema.optional(),
  regionCode: z.string().max(20).optional(),
  province: z.string().max(80).optional(),
  salesRepId: IdSchema.optional(),
  salesRepName: z.string().optional(),
  holdReason: z.string().optional(),
  taxCode: z.string().trim().max(30).optional(),
  email: z.string().email().optional(),
  phone: z.string().trim().max(30).optional(),
  address: z.string().trim().max(500).optional(),
  creditLimit: MoneySchema.default('0'),
  paymentTermDays: z.number().int().min(0).max(365).default(0),
  status: PartnerStatusSchema,
  version: z.number().int().positive(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
}).extend({
  /** Khách "cơ hội" (đang chăm sóc, chưa mua) hay khách chính thức; dữ liệu cũ không có stage = CUSTOMER. */
  stage: PartnerStageSchema.optional(),
}).extend(PartnerProfileSchema.shape);
export type Partner = z.infer<typeof PartnerSchema>;
export const CreatePartnerSchema = PartnerSchema.pick({
  code: true,
  name: true,
  kind: true,
  customerTier: true,
  regionCode: true,
  province: true,
  salesRepId: true,
  taxCode: true,
  email: true,
  phone: true,
  address: true,
  creditLimit: true,
  paymentTermDays: true,
})
  .extend(PartnerProfileSchema.shape)
  .extend({ status: PartnerStatusSchema.default('ACTIVE'), stage: PartnerStageSchema.default('CUSTOMER') });
export type CreatePartner = z.infer<typeof CreatePartnerSchema>;

/** Chuyển khách "cơ hội" thành khách chính thức: bắt buộc cấp giá; hạn mức / số ngày nợ do Giám đốc, kế toán đặt. */
export const ConvertPartnerSchema = z.object({
  version: z.number().int().positive(),
  customerTier: CustomerTierSchema,
  /** Khách chính thức bắt buộc có NVKD phụ trách (giữ NVKD đang gán nếu bỏ trống). */
  salesRepId: IdSchema.optional(),
  creditLimit: MoneySchema.optional(),
  paymentTermDays: z.number().int().min(0).max(365).optional(),
});
export type ConvertPartner = z.infer<typeof ConvertPartnerSchema>;

/** Nhật ký chăm sóc khách (跟进记录): mỗi lần gọi / gặp / nhắn, kèm hẹn chăm sóc lại. */
export const ActivityChannelSchema = z.enum(['CALL', 'MEET', 'ZALO', 'EMAIL', 'OTHER']);
export const PartnerActivityInputSchema = z.object({
  occurredAt: z.string().datetime({ offset: true }),
  channel: ActivityChannelSchema,
  contactName: optionalText(120),
  content: z.string().trim().min(2).max(2000),
  /** Ngày hẹn chăm sóc lại (YYYY-MM-DD, giờ Việt Nam); worker nhắc người phụ trách sáng ngày đó. */
  followUpOn: z.string().date().optional(),
  followUpNote: optionalText(300),
});
export type PartnerActivityInput = z.infer<typeof PartnerActivityInputSchema>;
export const UpdatePartnerActivitySchema = PartnerActivityInputSchema.partial().extend({ done: z.boolean().optional() });
export interface PartnerActivity extends PartnerActivityInput {
  id: string;
  partnerId: string;
  partnerCode?: string;
  partnerName?: string;
  ownerId: string;
  ownerName: string;
  done: boolean;
  doneAt?: string;
  createdAt: string;
  updatedAt: string;
}

/** Một dòng lịch sử thay đổi của chứng từ / hồ sơ (tab "Lịch sử" của cửa sổ chứng từ). */
export interface HistoryEntry {
  id: string;
  action: string;
  actorEmail?: string;
  actorName?: string;
  occurredAt: string;
  /** Các trường thay đổi (so before / after); rỗng với thao tác không ghi dữ liệu. */
  changes: Array<{ field: string; before?: unknown; after?: unknown }>;
  /** Thông tin thêm của thao tác (VD tên file đính kèm, lý do). */
  metadata?: Record<string, unknown>;
}

export const WarehouseSchema = z.object({
  id: IdSchema,
  code: CodeSchema,
  name: z.string().trim().min(2).max(160),
  address: z.string().trim().max(500),
  active: z.boolean(),
  /** NORMAL = kho bán hàng; DEFECTIVE = kho hàng lỗi (nhận hàng đổi / hoàn bảo hành, không bán ra). */
  purpose: z.enum(['NORMAL', 'DEFECTIVE']).optional(),
  version: z.number().int().positive(),
});
export type Warehouse = z.infer<typeof WarehouseSchema>;
export const CreateWarehouseSchema = WarehouseSchema.pick({
  code: true,
  name: true,
  address: true,
}).extend({ active: z.boolean().default(true), purpose: z.enum(['NORMAL', 'DEFECTIVE']).default('NORMAL') });
export type CreateWarehouse = z.infer<typeof CreateWarehouseSchema>;

/** Thuế suất GTGT của phiếu: 10%, 8%, 5%, 3% hoặc KCT (không chịu thuế). */
export const VatRateSchema = z.enum(VAT_RATES);
/** Mẫu chứng từ phiếu xuất kho bán hàng (PXK-001: một thuế suất cho cả phiếu). */
export const SalesIssueTemplateSchema = z.enum(SALES_ISSUE_TEMPLATES);

export const OrderLineInputSchema = z.object({
  productId: IdSchema,
  quantity: PositiveDecimalStringSchema,
  unit: z.string().trim().min(1).max(30),
  /** Hàng tặng kèm / khuyến mãi: đơn giá 0 nhưng vẫn xuất kho. */
  gift: z.boolean().default(false),
  /**
   * Đơn giá chưa VAT sửa tay (theo đơn vị bán) — chỉ khi Admin / Giám đốc đã cấp quyền sửa giá cho đúng phiếu này
   * (xem `priceOverrideRequestId`). Dòng sửa giá: CK = 0, giá theo bảng giá vẫn lưu ở `originalUnitPrice`.
   * Thấp nhất 0 (phiếu xuất đi kiểm định / mẫu — 14/10/2026); không âm.
   */
  overrideUnitPrice: MoneySchema.optional(),
});
export const OrderLineSchema = OrderLineInputSchema.extend({
  sku: CodeSchema,
  productName: z.string(),
  baseQuantity: PositiveDecimalStringSchema,
  /** Đơn giá chưa VAT sau chiết khấu — đúng cột "Đơn giá" trên phiếu xuất kho bán hàng. */
  unitPrice: MoneySchema,
  /** Đơn giá chưa VAT trước chiết khấu. */
  listUnitPrice: MoneySchema.optional(),
  discountRate: PercentageSchema,
  netAmount: MoneySchema.optional(),
  lineTotal: MoneySchema,
  pricingSource: z.string(),
  /** Đơn giá chưa VAT theo bảng giá trước khi sửa tay (chỉ có ở dòng pricingSource = MANUAL_PRICE). */
  originalUnitPrice: MoneySchema.optional(),
});
export type OrderLine = z.infer<typeof OrderLineSchema>;

export const SalesOrderCodeSchema = z
  .string()
  .trim()
  .toUpperCase()
  .regex(SALES_ORDER_CODE_PATTERN, 'Số phiếu chỉ gồm chữ, số và . _ / - (2–40 ký tự), hoặc chỉ gõ số hóa đơn (vd. 104)')
  .refine((code) => salesOrderCodeProblem(code) !== 'RESERVED', 'Số phiếu trùng kiểu số của chứng từ khác (SWK, AR, PO, TH…) — dùng số khác');
/** Mục đích phiếu: bán hàng / xuất hàng mẫu / xuất kiểm định (SAL-TYPE-01). Thiếu = bán hàng. */
export const SalesPurposeSchema = z.enum(SALES_PURPOSES);
export const SalesSlipTypeSchema = z.enum(SALES_SLIP_TYPES);
const SalesOrderInputObject = z.object({
  /** Bỏ trống = hệ thống tự sinh BHyyyymm####; có giá trị = số phiếu tự nhập (không được trùng). */
  code: SalesOrderCodeSchema.optional(),
  /** Quyền sửa đơn giá đã được Admin / Giám đốc duyệt cho phiếu này (bắt buộc khi có dòng `overrideUnitPrice`). */
  priceOverrideRequestId: IdSchema.optional(),
  /** Mã phiên mở form lập phiếu — quyền sửa giá chưa gắn phiếu chỉ dùng được trong đúng phiên đã xin. */
  formSessionId: z.string().uuid().optional(),
  purpose: SalesPurposeSchema.default('SALE'),
  /** Bắt buộc với phiếu bán; phiếu hàng mẫu / kiểm định không có khách hàng. */
  customerId: IdSchema.optional(),
  warehouseId: IdSchema,
  channel: SalesChannelSchema.default('B2B'),
  /** Phiếu bán: NVKD phụ trách. Phiếu hàng mẫu / kiểm định: người mượn hàng (bắt buộc). */
  salesRepId: IdSchema.optional(),
  /** Phiếu hàng mẫu / kiểm định: gửi tới đâu (tên đại lý / NPP, trung tâm kiểm định). */
  destination: z.string().trim().max(200).optional(),
  /** Phiếu hàng mẫu / kiểm định: ngày hẹn mang hàng về. */
  expectedReturnDate: z.string().date().optional(),
  orderDate: z.string().date().optional(),
  paymentTermDays: z.number().int().min(0).max(365).optional(),
  requestedDeliveryDate: z.string().date().optional(),
  note: z.string().trim().max(500).optional(),
  /** Các trường in trên phiếu xuất kho bán hàng. */
  contactName: z.string().trim().max(120).optional(),
  description: z.string().trim().max(300).optional(),
  deliveryLocation: z.string().trim().max(300).optional(),
  /** Tài khoản thủ kho tiếp nhận phiếu — chỉ người này thấy và lập SWK cho phiếu. Bắt buộc khi phát hành BH. */
  warehouseKeeperId: IdSchema.optional(),
  templateCode: SalesIssueTemplateSchema.default(DEFAULT_SALES_ISSUE_TEMPLATE),
  /** Bỏ trống = thuế suất mặc định trong thiết lập giá. */
  taxRate: VatRateSchema.optional(),
  lines: z.array(OrderLineInputSchema).min(1).max(200),
});
/** Phiếu bán cần khách; phiếu hàng mẫu / kiểm định / xuất tặng cần nhân viên, không có khách, không có giá sửa tay / hàng tặng; chỉ hàng mẫu / kiểm định có hẹn trả. */
function checkSalesPurpose(input: z.infer<typeof SalesOrderInputObject>, ctx: z.RefinementCtx) {
  if (!isNonSalePurpose(input.purpose)) {
    if (!input.customerId) ctx.addIssue({ code: 'custom', path: ['customerId'], message: 'Chọn khách hàng' });
    return;
  }
  if (!input.salesRepId) ctx.addIssue({ code: 'custom', path: ['salesRepId'], message: input.purpose === 'GIFT' ? 'Chọn nhân viên phụ trách' : 'Chọn nhân viên mượn hàng' });
  if (input.customerId) ctx.addIssue({ code: 'custom', path: ['customerId'], message: 'Phiếu hàng mẫu / kiểm định / xuất tặng không gắn khách hàng' });
  if (input.priceOverrideRequestId || input.lines.some((line) => line.overrideUnitPrice !== undefined || line.gift)) {
    ctx.addIssue({ code: 'custom', path: ['lines'], message: 'Phiếu hàng mẫu / kiểm định / xuất tặng không có giá sửa tay hay dòng hàng tặng (đơn giá luôn 0)' });
  }
  if (!isLoanPurpose(input.purpose) && input.expectedReturnDate) {
    ctx.addIssue({ code: 'custom', path: ['expectedReturnDate'], message: 'Phiếu xuất tặng không có ngày hẹn trả' });
  }
}
export const CreateSalesOrderSchema = SalesOrderInputObject.superRefine(checkSalesPurpose);
export type CreateSalesOrder = z.infer<typeof CreateSalesOrderSchema>;
export const UpdateSalesOrderSchema = SalesOrderInputObject.extend({
  version: z.number().int().positive(),
  /** AUTO khi phiếu đang mang số tự nhập = cấp lại số tự sinh; bỏ trống = giữ cách đánh số hiện tại. */
  codeMode: z.enum(['AUTO', 'MANUAL']).optional(),
}).superRefine(checkSalesPurpose);
export type UpdateSalesOrder = z.infer<typeof UpdateSalesOrderSchema>;

/** Thủ kho nhập lại hàng mẫu / hàng kiểm định mang về (một phần hoặc đủ) theo phiếu. */
export const LoanReturnSchema = z.object({
  version: z.number().int().positive(),
  lines: z.array(z.object({ productId: IdSchema, quantity: PositiveDecimalStringSchema })).min(1).max(200),
  note: z.string().trim().max(500).optional(),
});
export type LoanReturn = z.infer<typeof LoanReturnSchema>;
/** Chốt phần hàng mẫu / kiểm định chưa về: hỏng / tiêu hao / tặng, hoặc đại lý giữ mua luôn (chuyển thành phiếu bán). */
export const LoanCloseSchema = z.object({
  version: z.number().int().positive(),
  outcome: z.enum(LOAN_CLOSE_OUTCOMES),
  reason: z.string().trim().min(5, 'Lý do tối thiểu 5 ký tự').max(500),
});
export type LoanClose = z.infer<typeof LoanCloseSchema>;

/**
 * Bỏ phiếu BH (kế toán / Admin, bắt buộc lý do): phiếu nháp (kể cả bị KD trả về) thì xóa hẳn;
 * phiếu đã phát hành nhưng chưa xuất kho thì hủy — giữ số, trả hàng giữ chỗ về kho.
 */
export const DiscardSalesOrderSchema = z.object({
  version: z.number().int().positive(),
  reason: z.string().trim().min(5, 'Ghi lý do (ít nhất 5 ký tự)').max(300),
});
export type DiscardSalesOrder = z.infer<typeof DiscardSalesOrderSchema>;

/**
 * Đề nghị sửa / hủy / xóa phiếu BH (SAL-CHG-01, 14/10/2026): người có quyền `sales.change_request` (mặc định kế toán, kho)
 * gửi đề nghị kèm lý do; người có quyền `sales.change_approve` (mặc định Admin) duyệt thì hệ thống mới thực hiện.
 * EDIT: phiếu đã phát hành (kèm nội dung sửa); VOID: phiếu đã xuất / đã giao; CANCEL: phiếu đã phát hành chưa xuất; DELETE: phiếu nháp.
 */
export const SALES_CHANGE_KINDS = ['EDIT', 'VOID', 'CANCEL', 'DELETE'] as const;
export type SalesChangeKind = (typeof SALES_CHANGE_KINDS)[number];
export const SALES_CHANGE_STATUSES = ['PENDING', 'APPLIED', 'REJECTED', 'WITHDRAWN', 'FAILED'] as const;
export type SalesChangeStatus = (typeof SALES_CHANGE_STATUSES)[number];
export const CreateSalesChangeRequestSchema = z.object({
  kind: z.enum(SALES_CHANGE_KINDS),
  version: z.number().int().positive(),
  reason: z.string().trim().min(5, 'Ghi lý do (ít nhất 5 ký tự)').max(300),
  changes: UpdateSalesOrderSchema.optional(),
}).superRefine((value, context) => {
  if (value.kind === 'EDIT' && !value.changes) context.addIssue({ code: 'custom', path: ['changes'], message: 'Đề nghị sửa phải kèm nội dung sửa' });
});
export type CreateSalesChangeRequest = z.infer<typeof CreateSalesChangeRequestSchema>;
export const DecideSalesChangeRequestSchema = z.object({ note: z.string().trim().max(300).optional() });
export const RejectSalesChangeRequestSchema = z.object({ note: z.string().trim().min(5, 'Ghi lý do từ chối (ít nhất 5 ký tự)').max(300) });
export interface SalesChangeRequestView {
  id: string;
  code: string;
  kind: SalesChangeKind;
  status: SalesChangeStatus;
  orderId: string;
  orderCode: string;
  orderVersion: number;
  customerName?: string;
  reason: string;
  changes?: UpdateSalesOrder;
  requestedById: string;
  requestedByName: string;
  requestedAt: string;
  decidedByName?: string;
  decidedAt?: string;
  decisionNote?: string;
  error?: string;
}
/** Kế toán xin quyền sửa đơn giá cho phiếu BH đang lập (Admin / Giám đốc duyệt từ xa). */
export const PRICE_OVERRIDE_APPROVER_ROLES = ['ADMIN', 'DIRECTOR'] as const;
export const PriceOverrideRequestSchema = z.object({
  reason: z.string().trim().min(5, 'Ghi lý do (ít nhất 5 ký tự)').max(300),
  formSessionId: z.string().uuid(),
  customerId: IdSchema.optional(),
  /** Đang sửa phiếu nháp đã có: quyền gắn luôn với phiếu này. */
  salesOrderId: IdSchema.optional(),
});
export type PriceOverrideRequestInput = z.infer<typeof PriceOverrideRequestSchema>;
export const PriceOverrideDecisionSchema = z.object({
  decision: z.enum(['APPROVE', 'REJECT']),
  note: z.string().trim().max(300).optional(),
});
export type PriceOverrideDecision = z.infer<typeof PriceOverrideDecisionSchema>;
export type PriceOverrideStatus = 'PENDING' | 'APPROVED' | 'REJECTED' | 'CANCELLED';
export interface PriceOverrideRequestView {
  id: string;
  code: string;
  status: PriceOverrideStatus;
  reason: string;
  requestedByName: string;
  requestedAt: string;
  customerName?: string;
  salesOrderId?: string;
  salesOrderCode?: string;
  decidedByName?: string;
  decidedAt?: string;
  decisionNote?: string;
  /** Quyền đã duyệt nhưng chưa gắn phiếu sẽ hết hạn lúc này. */
  expiresAt?: string;
}

/** Trạng thái phiếu BH còn hủy được: đã phát hành nhưng chưa có SWK / xuất kho. */
export const CANCELLABLE_SALES_STATUSES = ['PENDING_APPROVAL', 'APPROVED', 'RESERVED'] as const;

export const MAX_EVIDENCE_PER_CONFIRMATION = 6;

/** Bước nhân viên kinh doanh đối chiếu phiếu BH với khách hàng. */
export const CustomerConfirmationSchema = z
  .object({
    version: z.number().int().positive(),
    decision: z.enum(['CONFIRMED', 'REVISION_REQUESTED']),
    note: z.string().trim().max(500).optional(),
    /** Ảnh chụp màn hình làm bằng chứng (đã tải lên qua /sales-orders/:id/attachments). */
    evidenceIds: z.array(IdSchema).max(MAX_EVIDENCE_PER_CONFIRMATION).default([]),
  })
  .refine((value) => value.decision === 'CONFIRMED' || Boolean(value.note), {
    message: 'Cần ghi rõ nội dung cần sửa để kế toán điều chỉnh phiếu',
    path: ['note'],
  })
  .refine((value) => value.decision !== 'CONFIRMED' || value.evidenceIds.length > 0, {
    message: 'Cần đính kèm ít nhất 1 ảnh chụp màn hình xác nhận (VD: tin nhắn Zalo) trước khi chuyển kho',
    path: ['evidenceIds'],
  });
export type CustomerConfirmation = z.infer<typeof CustomerConfirmationSchema>;

/** Ảnh bằng chứng: chỉ nhận ảnh PNG / JPEG / WebP (kiểm tra cả chữ ký file), tối đa 8 MB mỗi ảnh. */
export const EVIDENCE_CONTENT_TYPES = ['image/png', 'image/jpeg', 'image/webp'] as const;
/** Đính kèm hồ sơ / chứng từ (tab "Đính kèm"): ảnh như trên và PDF. */
export const DOCUMENT_CONTENT_TYPES = [...EVIDENCE_CONTENT_TYPES, 'application/pdf'] as const;
export const MAX_EVIDENCE_BYTES = 8 * 1024 * 1024;

export interface AttachmentMeta {
  id: string;
  fileName: string;
  contentType: string;
  size: number;
  sha256: string;
  uploadedAt: string;
  uploadedByName: string;
  /** Gắn với quyết định nào khi đối chiếu (xác nhận / yêu cầu sửa). */
  decision?: 'CONFIRMED' | 'REVISION_REQUESTED';
  /** Kết quả quét mã độc lúc tải lên (SKIPPED chỉ có ở máy dev khi tắt quét). */
  scan?: { result: 'CLEAN' | 'SKIPPED'; engine: string; scannedAt: string };
}

/** Tài khoản thủ kho có thể chọn trên phiếu BH (có quyền kho và phạm vi kho xuất). */
export interface WarehouseKeeper {
  id: string;
  displayName: string;
  title?: string;
  email: string;
}

/** Nơi làm việc chọn khi đăng nhập: văn phòng hoặc kho; văn phòng dùng kho mặc định cho các form. */
export interface Workspace {
  id: string;
  code: string;
  name: string;
  kind: 'OFFICE' | 'WAREHOUSE';
  defaultWarehouseId: string | null;
}

/** Kho lập phiếu SWK và xuất hàng. */
export const WarehouseIssueSchema = z.object({
  version: z.number().int().positive(),
  receiverName: z.string().trim().max(120).optional(),
  carrier: z.string().trim().max(160).optional(),
  note: z.string().trim().max(500).optional(),
});
export type WarehouseIssue = z.infer<typeof WarehouseIssueSchema>;
/** NOT_REQUIRED = phiếu hàng mẫu / kiểm định: không có khách nên bỏ bước KD đối chiếu, phát hành xong chuyển thẳng thủ kho. */
export const ConfirmationStatusSchema = z.enum(['PENDING', 'CONFIRMED', 'REVISION_REQUESTED', 'NOT_REQUIRED']);

export const SalesQuoteRequestSchema = z.object({
  customerId: IdSchema,
  warehouseId: IdSchema,
  taxRate: VatRateSchema.optional(),
  lines: z.array(OrderLineInputSchema.extend({ quantity: DecimalStringSchema })).max(200),
});
export type SalesQuoteRequest = z.infer<typeof SalesQuoteRequestSchema>;

export interface SalesQuoteLine {
  productId: string;
  sku: string;
  productName: string;
  unit: string;
  quantity: string;
  baseQuantity: string;
  unitPrice: string;
  discountRate: string;
  tierDiscountRate: string;
  salesTierDiscountRate: string;
  promotionDiscountRate: string;
  promotionCode?: string;
  gift: boolean;
  listUnitPrice: string;
  netAmount: string;
  available: string;
  minimumStock: string;
  stockState: 'OK' | 'NEAR_MINIMUM' | 'INSUFFICIENT';
}

/** Không có khách = bảng của phiếu hàng mẫu / kiểm định: chỉ tồn khả dụng, đơn giá 0. */
export const SalesPriceSheetRequestSchema = z.object({ customerId: IdSchema.optional(), warehouseId: IdSchema });

/** Cơ sở tính giá của một mã hàng cho một khách: form dùng để tính tiền tức thời bằng priceLine(). */
export interface SalesPriceSheetItem {
  productId: string;
  sku: string;
  /** Giá niêm yết theo cấp khách cho 1 đơn vị cơ sở. */
  baseUnitPrice: string;
  tierDiscountRate: string;
  salesTierDiscountRate: string;
  promotionDiscountRate: string;
  promotionCode?: string;
  /** CK tổng đã áp trần (dòng hàng bán; hàng tặng luôn 0). */
  discountRate: string;
  /** Tồn khả dụng tại kho xuất (đơn vị cơ sở). */
  available: string;
  minimumStock: string;
}

/** Bảng giá riêng của một khách tại một kho, tải một lần khi chọn khách để form tính tiền không cần gọi máy chủ. */
export interface SalesPriceSheet {
  generatedAt: string;
  defaultVatRate: string;
  pricesIncludeTax: boolean;
  discountCapRate: string;
  approvalThreshold: string;
  /** Trống với bảng của phiếu hàng mẫu / kiểm định. */
  customer?: {
    id: string;
    tier: string;
    status: string;
    creditLimit: string;
    exposure: string;
    periodRevenue: string;
    periodLabel: string;
    salesTierRate: string;
    paymentTermDays: number;
  };
  items: SalesPriceSheetItem[];
}

export interface SalesQuote {
  lines: SalesQuoteLine[];
  subtotal: string;
  discountTotal: string;
  netTotal: string;
  taxTotal: string;
  grandTotal: string;
  taxRate: string;
  pricesIncludeTax: boolean;
  discountCapRate: string;
  customer: {
    tier: string;
    status: string;
    creditLimit: string;
    exposure: string;
    creditRemainingAfter: string;
    periodRevenue: string;
    periodLabel: string;
    salesTierRate: string;
    paymentTermDays: number;
  };
}

export const SalesOrderSchema = z.object({
  id: IdSchema,
  code: CodeSchema,
  /** Thiếu = phiếu bán. Phiếu hàng mẫu / kiểm định không có khách hàng (customer* trống). */
  purpose: SalesPurposeSchema.optional(),
  customerId: IdSchema.optional(),
  customerCode: CodeSchema.optional(),
  customerName: z.string().optional(),
  warehouseId: IdSchema,
  channel: SalesChannelSchema.optional(),
  salesRepId: IdSchema.optional(),
  salesRepName: z.string().optional(),
  destination: z.string().optional(),
  expectedReturnDate: z.string().date().optional(),
  /** Phiếu hàng mẫu / kiểm định đã xuất: hàng còn ở ngoài / đã về một phần / đã về đủ / đã chốt phần chưa về. */
  loanStatus: z.enum(LOAN_STATUSES).optional(),
  loanClosedAt: z.string().datetime().optional(),
  loanClosedByName: z.string().optional(),
  loanCloseOutcome: z.enum(LOAN_CLOSE_OUTCOMES).optional(),
  loanCloseReason: z.string().optional(),
  regionCode: z.string().optional(),
  orderDate: z.string().datetime().optional(),
  paymentTermDays: z.number().int().optional(),
  status: SalesOrderStatusSchema,
  approvalStatus: ApprovalStatusSchema,
  requestedDeliveryDate: z.string().date().optional(),
  note: z.string().optional(),
  contactName: z.string().optional(),
  description: z.string().optional(),
  deliveryLocation: z.string().optional(),
  buyer: z
    .object({ code: z.string(), name: z.string(), address: z.string().optional(), phone: z.string().optional(), taxCode: z.string().optional() })
    .optional(),
  confirmationStatus: ConfirmationStatusSchema.optional(),
  confirmationNote: z.string().optional(),
  warehouseKeeperId: IdSchema.optional(),
  warehouseKeeperName: z.string().optional(),
  confirmationEvidence: z
    .array(z.object({
      id: IdSchema, fileName: z.string(), contentType: z.string(), size: z.number(), sha256: z.string(),
      uploadedAt: z.string(), uploadedByName: z.string(), decision: z.enum(['CONFIRMED', 'REVISION_REQUESTED']).optional(),
      scan: z.object({ result: z.enum(['CLEAN', 'SKIPPED']), engine: z.string(), scannedAt: z.string() }).optional(),
    }))
    .optional(),
  warehouseSlipNo: z.string().optional(),
  /** AUTO = số tự sinh, MANUAL = số do kế toán tự nhập. Phiếu cũ không có trường này là tự sinh. */
  codeMode: z.enum(['AUTO', 'MANUAL']).optional(),
  /** Quyền sửa đơn giá đã dùng cho phiếu này: ai duyệt, lý do kế toán xin. */
  priceOverrideRequestId: z.string().optional(),
  priceOverrideApprovedByName: z.string().optional(),
  priceOverrideReason: z.string().optional(),
  /** Quản trị gốc sửa phiếu sau khi phát hành (tồn kho / công nợ đã tự điều chỉnh theo chênh lệch). */
  rootEditedAt: z.string().datetime().optional(),
  rootEditedByName: z.string().optional(),
  /** Phiếu bị hủy (đã phát hành, chưa xuất kho): ai hủy, lúc nào, lý do, trạng thái trước khi hủy. */
  cancelledAt: z.string().datetime().optional(),
  cancelledByName: z.string().optional(),
  cancelReason: z.string().optional(),
  statusBeforeCancel: z.string().optional(),
  templateCode: z.string().optional(),
  taxRate: z.string().optional(),
  pricesIncludeTax: z.boolean().optional(),
  lines: z.array(OrderLineSchema),
  subtotal: MoneySchema,
  discountTotal: MoneySchema,
  netTotal: MoneySchema.optional(),
  taxTotal: MoneySchema,
  grandTotal: MoneySchema,
  version: z.number().int().positive(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
export type SalesOrder = z.infer<typeof SalesOrderSchema>;

export const PurchaseOrderLineInputSchema = z.object({
  productId: IdSchema,
  quantity: PositiveDecimalStringSchema,
  unit: z.string().trim().min(1).max(30),
  /** Đơn giá theo tiền tệ của đơn (CNY / USD tới 4 chữ số lẻ). */
  unitCost: DecimalStringSchema,
  note: optionalText(300),
});
/** Điều kiện giao hàng (Incoterms) trên hợp đồng mua của công ty mẹ. */
export const IncotermSchema = z.enum(['EXW', 'FOB', 'CFR', 'CIF', 'DAP', 'DDP']);
export const ShippingMethodSchema = z.enum(['SEA', 'AIR', 'ROAD', 'RAIL', 'EXPRESS']);
/**
 * Đơn mua / hợp đồng nhập hàng (giai đoạn 4, theo hợp đồng MSC… của công ty mẹ): tiền tệ + tỷ giá, điều kiện giao hàng,
 * thanh toán, cảng, ETD / ETA, đặt cọc. Đơn mua trong nước dùng VND và bỏ trống các trường nhập khẩu.
 */
export const PurchaseContractTermsSchema = z.object({
  supplierContractNo: optionalText(60),
  contractDate: z.string().date().optional(),
  currency: CurrencySchema.default('VND'),
  /** VND cho 1 đơn vị ngoại tệ; VND = 1. */
  exchangeRate: PositiveDecimalStringSchema.optional(),
  incoterm: IncotermSchema.optional(),
  paymentTerms: optionalText(300),
  depositPercent: PercentageSchema.optional(),
  portOfLoading: optionalText(120),
  portOfDischarge: optionalText(120),
  shippingMethod: ShippingMethodSchema.optional(),
  etd: z.string().date().optional(),
  eta: z.string().date().optional(),
  partialShipment: z.boolean().optional(),
  /** Mã vận chuyển / ký hiệu trên thùng (shipping mark) in trên packing list. */
  shippingMark: optionalText(300),
});
const purchaseRateRule = <T extends { currency?: string | undefined; exchangeRate?: string | undefined }>(value: T) => !value.currency || value.currency === 'VND' || Boolean(value.exchangeRate);
export const CreatePurchaseOrderSchema = z
  .object({
    supplierId: IdSchema,
    warehouseId: IdSchema,
    expectedDate: z.string().date().optional(),
    note: z.string().trim().max(500).optional(),
    lines: z.array(PurchaseOrderLineInputSchema).min(1).max(200),
  })
  .extend(PurchaseContractTermsSchema.shape)
  .refine(purchaseRateRule, { message: 'Đơn ngoại tệ phải có tỷ giá quy đổi VND', path: ['exchangeRate'] });
export type CreatePurchaseOrder = z.infer<typeof CreatePurchaseOrderSchema>;
/** Sửa đơn nháp: gửi lại toàn bộ dòng hàng; trường điều khoản không gửi giữ nguyên. */
export const UpdatePurchaseOrderSchema = z
  .object({
    version: z.number().int().positive(),
    supplierId: IdSchema.optional(),
    warehouseId: IdSchema.optional(),
    expectedDate: z.string().date().optional(),
    note: z.string().trim().max(500).optional(),
    lines: z.array(PurchaseOrderLineInputSchema).min(1).max(200).optional(),
    clear: z.array(z.enum(['expectedDate', 'note', ...Object.keys(PurchaseContractTermsSchema.shape)] as [string, ...string[]])).max(20).optional(),
  })
  .extend(PurchaseContractTermsSchema.partial().shape);
export type UpdatePurchaseOrder = z.infer<typeof UpdatePurchaseOrderSchema>;
/** Ghi nhận tiền đã trả nhà cung cấp (đặt cọc / thanh toán) — chưa phải sổ công nợ phải trả. */
export const SupplierPaymentSchema = z.object({
  kind: z.enum(['DEPOSIT', 'BALANCE', 'OTHER']),
  amount: PositiveDecimalStringSchema,
  paidOn: z.string().date(),
  reference: optionalText(80),
  note: optionalText(300),
});
export type SupplierPayment = z.infer<typeof SupplierPaymentSchema>;

/** Lô hàng nhập (container / B/L) gom dòng của một hoặc nhiều đơn mua cùng kho nhận. */
export const ImportShipmentStatusSchema = z.enum(['PLANNED', 'IN_TRANSIT', 'ARRIVED', 'RECEIVED', 'CANCELLED']);
export const ContainerTypeSchema = z.enum(['20GP', '40GP', '40HQ', 'LCL', 'AIR', 'OTHER']);
export const ImportCostSchema = z.object({
  type: z.enum(IMPORT_COST_TYPES),
  /** Số tiền VND (chi phí tại Việt Nam, thuế nhập khẩu theo tờ khai). */
  amount: MoneySchema,
  invoiceNo: optionalText(60),
  note: optionalText(200),
});
export type ImportCost = z.infer<typeof ImportCostSchema>;
export const ImportShipmentLineInputSchema = z.object({
  purchaseOrderId: IdSchema,
  productId: IdSchema,
  /** Số lượng theo đơn vị cơ bản đi trong lô này. */
  quantity: PositiveDecimalStringSchema,
});
export const ImportShipmentFieldsSchema = z.object({
  containerNo: optionalText(40),
  containerType: ContainerTypeSchema.optional(),
  sealNo: optionalText(40),
  billOfLading: optionalText(60),
  vessel: optionalText(120),
  customsDeclarationNo: optionalText(60),
  etd: z.string().date().optional(),
  eta: z.string().date().optional(),
  note: optionalText(500),
  costs: z.array(ImportCostSchema).max(30).optional(),
  allocationMethod: z.enum(ALLOCATION_METHODS).optional(),
});
export const CreateImportShipmentSchema = ImportShipmentFieldsSchema.extend({
  lines: z.array(ImportShipmentLineInputSchema).min(1).max(300),
});
export type CreateImportShipment = z.infer<typeof CreateImportShipmentSchema>;
export const UpdateImportShipmentSchema = ImportShipmentFieldsSchema.partial().extend({
  version: z.number().int().positive(),
  status: z.enum(['PLANNED', 'IN_TRANSIT', 'ARRIVED', 'CANCELLED']).optional(),
  lines: z.array(ImportShipmentLineInputSchema).min(1).max(300).optional(),
});
export type UpdateImportShipment = z.infer<typeof UpdateImportShipmentSchema>;
/** Nhận hàng cả lô: số thực nhận từng dòng (mặc định = số đi trong lô), vị trí lưu; chốt giá vốn bình quân. */
export const ReceiveImportShipmentSchema = z.object({
  version: z.number().int().positive(),
  lines: z.array(z.object({ purchaseOrderId: IdSchema, productId: IdSchema, quantity: DecimalStringSchema, locationCode: CodeSchema.optional() })).min(1).max(300),
  supplierDocumentReference: optionalText(100),
  updateStandardCost: z.boolean().default(true),
});
export type ReceiveImportShipment = z.infer<typeof ReceiveImportShipmentSchema>;

export const GoodsReceiptLineSchema = z.object({
  productId: IdSchema,
  quantity: PositiveDecimalStringSchema,
  locationCode: CodeSchema.optional(),
});
export const CreateGoodsReceiptSchema = z.object({
  purchaseOrderId: IdSchema,
  supplierDocumentReference: z.string().trim().max(100).optional(),
  lines: z.array(GoodsReceiptLineSchema).min(1).max(200),
});
export type CreateGoodsReceipt = z.infer<typeof CreateGoodsReceiptSchema>;

export const InventoryTransferLineSchema = z.object({
  productId: IdSchema,
  quantity: PositiveDecimalStringSchema,
  fromLocationCode: CodeSchema.optional(),
  toLocationCode: CodeSchema.optional(),
});
export const CreateInventoryTransferSchema = z
  .object({
    fromWarehouseId: IdSchema,
    toWarehouseId: IdSchema,
    reason: z.string().trim().min(3).max(500),
    lines: z.array(InventoryTransferLineSchema).min(1).max(200),
  })
  .refine((value) => value.fromWarehouseId !== value.toWarehouseId, {
    message: 'Kho nguồn và kho đích phải khác nhau',
    path: ['toWarehouseId'],
  });
export type CreateInventoryTransfer = z.infer<typeof CreateInventoryTransferSchema>;

export const CreatePaymentSchema = z.object({
  partnerId: IdSchema,
  amount: PositiveDecimalStringSchema,
  method: z.enum(['BANK_TRANSFER', 'CASH', 'OTHER']),
  receivedAt: z.string().datetime(),
  reference: z.string().trim().max(100).optional(),
  allocations: z
    .array(
      z.object({
        receivableId: IdSchema,
        amount: PositiveDecimalStringSchema,
      }),
    )
    .min(1),
});
export type CreatePayment = z.infer<typeof CreatePaymentSchema>;

export const InventoryBalanceSchema = z.object({
  productId: IdSchema,
  warehouseId: IdSchema,
  sku: CodeSchema,
  productName: z.string(),
  unit: z.string(),
  onHand: DecimalStringSchema,
  reserved: DecimalStringSchema,
  available: DecimalStringSchema,
  minimumStock: DecimalStringSchema,
  belowMinimum: z.boolean(),
  updatedAt: z.string().datetime(),
});
export type InventoryBalance = z.infer<typeof InventoryBalanceSchema>;

/**
 * Chữ do máy chủ sinh (cảnh báo dashboard, thông báo) kèm mã mẫu + tham số để giao diện dịch theo ngôn ngữ
 * người dùng. title/detail/message tiếng Việt vẫn được lưu làm bản dự phòng (bản ghi cũ, mẫu chưa có bản dịch).
 */
export const TextParamsSchema = z.record(z.string(), z.union([z.string(), z.number()]));
export type TextParams = z.infer<typeof TextParamsSchema>;

export const DASHBOARD_ALERT_TEMPLATES = ['OVERDUE_60', 'LOW_STOCK', 'APPROVAL_OVERDUE_24H', 'APPROVAL_PENDING', 'PROMOTION_EXPIRING', 'WARRANTY_OVERDUE'] as const;
export const DashboardAlertTemplateSchema = z.enum(DASHBOARD_ALERT_TEMPLATES);
export type DashboardAlertTemplate = z.infer<typeof DashboardAlertTemplateSchema>;

export const NOTIFICATION_TEMPLATES = [
  'SALES_ISSUE_REQUESTED',
  'SALES_ORDER_CANCELLED',
  'SALES_ORDER_DELETED',
  'PRICE_OVERRIDE_REQUESTED',
  'PRICE_OVERRIDE_DECIDED',
  'SALES_ORDER_ROOT_EDITED',
  'SALES_CHANGE_REQUESTED',
  'SALES_CHANGE_APPROVED',
  'SALES_CHANGE_REJECTED',
  'SALES_APPROVAL_REQUESTED',
  'SALES_CONFIRMATION_PENDING',
  'SALES_APPROVED_CONFIRMATION_PENDING',
  'SALES_READY_FOR_SWK',
  'SALES_REVISION_REQUESTED',
  'EVIDENCE_MALWARE_BLOCKED',
  'PURCHASE_APPROVAL_REQUESTED',
  'OVERDUE_REVIEW',
  'ORDERING_LOCKED_OVERDUE',
  'WARRANTY_APPROVAL_REQUESTED',
  'WARRANTY_APPROVAL_DECIDED',
  'WARRANTY_DUE_SOON',
  'WARRANTY_OVERDUE',
  'WARRANTY_STOCK_MOVED',
  'WARRANTY_SERVICE_BILLED',
  'CRM_FOLLOW_UP_DUE',
  'CUSTOMER_RETURN_POSTED',
  'STOCK_COUNT_VARIANCE',
] as const;
export const NotificationTemplateSchema = z.enum(NOTIFICATION_TEMPLATES);
export type NotificationTemplate = z.infer<typeof NotificationTemplateSchema>;

export interface AppNotification {
  id: string;
  title: string;
  message: string;
  href?: string;
  level?: string;
  template?: NotificationTemplate;
  params?: TextParams;
  createdAt: string;
}

export const DashboardSummarySchema = z.object({
  generatedAt: z.string().datetime(),
  period: z.object({ month: z.string(), label: z.string() }),
  revenueThisMonth: MoneySchema,
  revenuePreviousMonth: MoneySchema,
  revenueChangePercent: z.number().nullable(),
  revenueComparisonLabel: z.string(),
  pendingApprovalOrders: z.number().int().nonnegative(),
  pendingOver24h: z.number().int().nonnegative(),
  /** Giá trị tồn kho (trừ kho hàng lỗi) theo giá Net NPP. */
  inventoryValue: MoneySchema,
  inventoryValueBasis: z.literal('DISTRIBUTOR_NET_PRICE'),
  /** Số mã còn tồn nhưng chưa có giá NPP — tạm tính theo giá bán lẻ. */
  inventoryValueFallbackSkus: z.number().int().nonnegative(),
  lowStockSkuCount: z.number().int().nonnegative(),
  overdueReceivables: MoneySchema,
  dealersOverdue30: z.number().int().nonnegative(),
  monthlyRevenue: z.array(
    z.object({ month: z.string(), label: z.string(), revenue: MoneySchema, current: z.boolean() }),
  ),
  recentOrders: z.array(
    z.object({
      id: IdSchema,
      code: CodeSchema,
      /** Tên khách; phiếu hàng mẫu / kiểm định = người mượn (xem `slipType`). */
      customerName: z.string(),
      province: z.string().optional(),
      channel: SalesChannelSchema,
      slipType: SalesSlipTypeSchema.optional(),
      orderDate: z.string().datetime(),
      lineCount: z.number().int(),
      total: MoneySchema,
      status: SalesOrderStatusSchema,
      confirmationStatus: ConfirmationStatusSchema.optional(),
      version: z.number().int(),
    }),
  ),
  recentOrdersTotal: z.number().int().nonnegative(),
  alerts: z.array(
    z.object({
      id: IdSchema,
      level: z.enum(['INFO', 'WARNING', 'CRITICAL']),
      title: z.string(),
      detail: z.string(),
      href: z.string().optional(),
      template: DashboardAlertTemplateSchema.optional(),
      params: TextParamsSchema.optional(),
    }),
  ),
});
export type DashboardSummary = z.infer<typeof DashboardSummarySchema>;

export interface SalesReport {
  period: { from: string; to: string; label: string };
  generatedAt: string;
  summary: {
    revenue: string;
    previousRevenue: string;
    changePercent: number | null;
    orders: number;
    averageOrderValue: string;
    activeDealers: number;
    totalDealers: number;
    averageDiscountRate: number;
    discountCapRate: string;
  };
  topDealers: Array<{ code: string; name: string; province?: string; revenue: string }>;
  regions: Array<{ code: string; name: string; revenue: string; share: number }>;
  rows: Array<{
    customerId: string;
    code: string;
    name: string;
    regionCode: string;
    regionName: string;
    tier: string;
    orders: number;
    revenue: string;
    discount: string;
    closingDebt: string;
    share: number;
  }>;
  totals: { orders: number; revenue: string; discount: string; closingDebt: string };
}

export const LoginSchema = z.object({
  email: z.string().trim().toLowerCase().email(),
  password: z.string().min(10).max(200),
  totpCode: z.string().regex(/^\d{6}$/).optional(),
});
export type LoginInput = z.infer<typeof LoginSchema>;

export const AuthUserSchema = z.object({
  id: IdSchema,
  email: z.string().email(),
  displayName: z.string(),
  roles: z.array(z.string()),
  warehouseScopes: z.array(IdSchema),
  mfaEnabled: z.boolean(),
  /** Tài khoản quản trị gốc (tạo bằng script trên máy chủ). */
  root: z.boolean().optional(),
  /** Bước bắt buộc còn thiếu (đổi mật khẩu tạm, bật MFA): phiên chỉ dùng được màn hình thiết lập. */
  pending: z.array(z.enum(['PASSWORD', 'MFA'])).optional(),
});
export type AuthUser = z.infer<typeof AuthUserSchema>;

export const ApiErrorSchema = z.object({
  statusCode: z.number().int(),
  code: z.string(),
  message: z.string(),
  correlationId: z.string().optional(),
  details: z.unknown().optional(),
});
export type ApiError = z.infer<typeof ApiErrorSchema>;

// --- Bảo hành – sửa chữa – dịch vụ (docs/warranty-design.md) ---

const DateOnlySchema = z.string().refine(isDateOnly, 'Ngày phải có dạng YYYY-MM-DD');
const OptionalText = (max: number) => z.string().trim().max(max).optional();

export const WarrantyFaultLineSchema = z.object({
  faultCode: OptionalText(40),
  receivedDate: DateOnlySchema,
  symptom: z.string().trim().min(3).max(500),
  rootCause: OptionalText(500),
  action: OptionalText(500),
  partCode: OptionalText(80),
  note: OptionalText(300),
});
export type WarrantyFaultLine = z.infer<typeof WarrantyFaultLineSchema>;

export const CreateWarrantyTicketSchema = z
  .object({
    channel: z.enum(WARRANTY_CHANNELS),
    customerId: IdSchema.optional(),
    customerName: z.string().trim().min(2).max(240),
    customerPhone: OptionalText(30),
    customerAddress: OptionalText(500),
    productId: IdSchema,
    serial: OptionalText(80),
    invoiceNumber: OptionalText(40),
    invoiceDate: DateOnlySchema.optional(),
    receivedDate: DateOnlySchema,
    promisedDate: DateOnlySchema,
    technicianId: IdSchema.optional(),
    accessories: OptionalText(300),
    condition: OptionalText(300),
    loaner: OptionalText(200),
    symptom: z.string().trim().min(3).max(500),
  })
  .superRefine((value, context) => {
    if (value.promisedDate < value.receivedDate) {
      context.addIssue({ code: 'custom', path: ['promisedDate'], message: 'Ngày hẹn trả phải từ ngày tiếp nhận trở đi' });
    }
    if (Boolean(value.invoiceNumber) !== Boolean(value.invoiceDate)) {
      context.addIssue({ code: 'custom', path: ['invoiceNumber'], message: 'Nhập đủ số và ngày hóa đơn, hoặc bỏ trống cả hai nếu khách không có hóa đơn' });
    }
    if (value.invoiceDate && value.invoiceDate > value.receivedDate) {
      context.addIssue({ code: 'custom', path: ['invoiceDate'], message: 'Ngày hóa đơn không được sau ngày tiếp nhận' });
    }
  });
export type CreateWarrantyTicket = z.infer<typeof CreateWarrantyTicketSchema>;

const ActionBase = { version: z.number().int().positive(), note: OptionalText(500) };

/** Thao tác trên phiếu bảo hành; trạng thái nào cho phép thao tác nào: WARRANTY_ACTIONS_BY_STATUS. */
export const WarrantyActionSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('DIAGNOSE'),
    ...ActionBase,
    lines: z.array(WarrantyFaultLineSchema).min(1).max(5),
    exclusion: z.enum(WARRANTY_EXCLUSIONS).exclude(['NO_INVOICE']).optional(),
    plan: z.enum(WARRANTY_PLANS),
    quoteAmount: MoneySchema.optional(),
  }),
  z.object({ type: z.literal('QUOTE_DECISION'), ...ActionBase, accepted: z.boolean() }),
  z.object({ type: z.literal('APPROVE'), ...ActionBase, approved: z.boolean() }),
  z.object({ type: z.literal('WAIT_PARTS'), ...ActionBase, note: z.string().trim().min(2).max(500) }),
  z.object({ type: z.literal('PARTS_ARRIVED'), ...ActionBase }),
  z.object({
    type: z.literal('REPAIR_DONE'),
    ...ActionBase,
    resolution: z.enum(['REPAIRED', 'PART_REPLACED']),
    replacedParts: OptionalText(300),
    cost: MoneySchema.default('0'),
  }),
  z.object({ type: z.literal('TEST'), ...ActionBase, functional: z.boolean(), safety: z.boolean(), performance: z.boolean() }),
  z.object({ type: z.literal('RESCHEDULE'), ...ActionBase, promisedDate: DateOnlySchema, reason: z.string().trim().min(3).max(300) }),
  z.object({
    type: z.literal('RETURN'),
    ...ActionBase,
    receiverName: z.string().trim().min(2).max(120),
    /** Bắt buộc khi kết quả là hoàn tiền: số tiền trả lại khách (ghi chi phí bảo hành). */
    refundAmount: MoneySchema.optional(),
  }),
  z.object({ type: z.literal('CANCEL'), ...ActionBase, reason: z.string().trim().min(3).max(300) }),
]);
export type WarrantyAction = z.infer<typeof WarrantyActionSchema>;

export interface WarrantyHistoryEntry {
  at: string;
  byName: string;
  action: string;
  from?: string;
  to?: string;
  note?: string;
}

export interface WarrantyPhoto extends AttachmentMeta {
  kind: WarrantyPhotoKind;
}

/** Mã lỗi bảo hành theo nhóm hàng (categoryIds rỗng = dùng cho mọi nhóm). */
export const WarrantyFaultCodeInputSchema = z.object({
  code: CodeSchema,
  name: z.string().trim().min(2).max(160),
  categoryIds: z.array(IdSchema).max(20).default([]),
  active: z.boolean().default(true),
});
export type WarrantyFaultCodeInput = z.infer<typeof WarrantyFaultCodeInputSchema>;
export interface WarrantyFaultCode {
  id: string;
  code: string;
  name: string;
  categoryIds: string[];
  categoryNames: string[];
  active: boolean;
  usageCount: number;
}

/** Báo cáo bảo hành theo khoảng tháng (phiếu tiếp nhận trong kỳ). */
export interface WarrantyReport {
  from: string;
  to: string;
  totals: {
    received: number;
    returned: number;
    open: number;
    overdueOpen: number;
    onTimeRate: number | null;
    averageTurnaroundDays: number | null;
    rejectionRate: number | null;
    exchanged: number;
    refunded: number;
    companyCost: string;
    serviceRevenue: string;
  };
  byMonth: Array<{ month: string; received: number; returned: number; onTime: number; companyCost: string; serviceRevenue: string }>;
  byResolution: Array<{ resolution: string; count: number }>;
  byProduct: Array<{ sku: string; name: string; count: number; companyCost: string }>;
  byFaultCode: Array<{ code: string; name: string; count: number }>;
  repeatProducts: Array<{ sku: string; name: string; invoiceNumber: string; customerName: string; services: number; lastTicketId: string; lastCode: string }>;
}

export interface WarrantyTicket {
  id: string;
  code: string;
  status: WarrantyStatus;
  version: number;
  channel: WarrantyChannel;
  customer: { partnerId?: string; code?: string; name: string; phone?: string; address?: string };
  product: { productId: string; sku: string; name: string; categoryName?: string; serial?: string };
  invoice?: { number: string; date: string };
  coverage: WarrantyCoverage;
  exclusion?: WarrantyExclusion;
  warranty: { months: number; startsOn?: string; expiresOn?: string; extensionDays: number; priorServiceCount: number };
  receivedAt: string;
  receivedDate: string;
  promisedDate: string;
  originalPromisedDate: string;
  reschedules: Array<{ from: string; to: string; reason: string; at: string; byName: string }>;
  receivedByName: string;
  technicianId?: string;
  technicianName?: string;
  accessories?: string;
  condition?: string;
  loaner?: string;
  lines: WarrantyFaultLine[];
  plan?: WarrantyPlan;
  quoteAmount?: string;
  quoteAccepted?: boolean;
  approval?: { proposal: string; requestedAt: string; requestedByName: string; decidedAt?: string; decidedByName?: string; approved?: boolean; note?: string };
  result?: { resolution: WarrantyResolution; replacedParts?: string; cost: string; chargedTo: 'COMPANY' | 'CUSTOMER'; completedAt: string; note?: string };
  test?: { functional: boolean; safety: boolean; performance: boolean; testedAt: string; testedByName: string; note?: string };
  returnedAt?: string;
  returnedTo?: string;
  cancelReason?: string;
  /** Liên kết kho khi trả: phiếu xuất hàng đổi mới / nhập hàng lỗi. */
  stock?: { exchange?: { warehouseCode: string; warehouseName: string }; defect: { warehouseCode: string; warehouseName: string }; reference: string; movedAt: string };
  /** Phí dịch vụ ngoài bảo hành đã ghi công nợ. */
  receivable?: { id: string; code: string; amount: string; partnerCode: string; partnerName: string; dueDate: string };
  refund?: { amount: string };
  /** Ảnh khi nhận / phiếu đã ký (trả kèm khi xem chi tiết). */
  photos?: WarrantyPhoto[];
  history: WarrantyHistoryEntry[];
  createdAt: string;
  updatedAt: string;
}

/** Một trang dữ liệu (danh sách gửi ?page=&pageSize=). */
export interface Paged<T> {
  rows: T[];
  total: number;
  page: number;
  pageSize: number;
}

// --- Sửa danh mục (Danh mục, Kho & giao hàng). Khi sửa chỉ cập nhật đúng các trường được gửi lên. ---

const VersionField = { version: z.number().int().positive() };

/** Mã SKU không đổi sau khi tạo (đã in trên chứng từ); muốn đổi thì ngừng mã cũ và tạo mã mới. */
/** Trường hồ sơ xóa được khi sửa (gửi tên trường trong `clear`; trường không gửi giữ nguyên). */
export const PRODUCT_CLEARABLE_FIELDS = [...(Object.keys(ProductProfileSchema.shape) as Array<keyof ProductProfile>), 'model', 'standardCost', 'specification', 'packSize'] as const;
export const UpdateProductSchema = CreateProductSchema.omit({ sku: true })
  .partial()
  .extend(VersionField)
  .extend({ clear: z.array(z.enum(PRODUCT_CLEARABLE_FIELDS as unknown as [string, ...string[]])).max(60).optional() });
export type UpdateProduct = z.infer<typeof UpdateProductSchema>;

export const PARTNER_CLEARABLE_FIELDS = [...Object.keys(PartnerProfileSchema.shape), 'taxCode', 'email', 'phone', 'address', 'province', 'regionCode'] as const;
export const UpdatePartnerSchema = CreatePartnerSchema.omit({ code: true, kind: true, stage: true })
  .partial()
  .extend({ ...VersionField, holdReason: z.string().max(120).optional() })
  .extend({ clear: z.array(z.enum(PARTNER_CLEARABLE_FIELDS as unknown as [string, ...string[]])).max(30).optional() });
export type UpdatePartner = z.infer<typeof UpdatePartnerSchema>;

export const UpdateWarehouseSchema = CreateWarehouseSchema.omit({ code: true }).partial().extend(VersionField);
export type UpdateWarehouse = z.infer<typeof UpdateWarehouseSchema>;

export const ProductCategoryInputSchema = z.object({
  code: CodeSchema,
  name: z.string().trim().min(2).max(120),
  description: z.string().trim().max(300).optional(),
  sortOrder: z.number().int().min(0).max(999).optional(),
});
export type ProductCategoryInput = z.infer<typeof ProductCategoryInputSchema>;

export const LocationInputSchema = z.object({
  warehouseId: IdSchema,
  code: CodeSchema,
  name: z.string().trim().min(2).max(120),
  active: z.boolean().default(true),
});
export type LocationInput = z.infer<typeof LocationInputSchema>;

export const RegionInputSchema = z.object({
  code: CodeSchema,
  name: z.string().trim().min(2).max(120),
  sortOrder: z.number().int().min(0).max(999).optional(),
});
export type RegionInput = z.infer<typeof RegionInputSchema>;

export const EmployeeInputSchema = z.object({
  code: CodeSchema,
  name: z.string().trim().min(2).max(120),
  title: z.string().trim().min(2).max(120),
  role: z.enum(['SALES', 'SALES_MANAGER']),
  regionCode: z.string().trim().max(20).nullable().optional(),
  phone: z.string().trim().max(30).optional(),
  status: z.enum(['ACTIVE', 'INACTIVE']).default('ACTIVE'),
  /** Tài khoản đăng nhập của NVKD: khách do tài khoản này tạo tự gán NVKD phụ trách (null = bỏ liên kết). */
  userId: IdSchema.nullable().optional(),
});
export type EmployeeInput = z.infer<typeof EmployeeInputSchema>;

// --- Quản trị hệ thống: người dùng, đăng nhập, giám sát ---

const PersonName = z.string().trim().min(2).max(120);
const RoleList = z.array(z.enum(USER_ROLES)).min(1).max(USER_ROLES.length);

export const CreateUserSchema = z.object({
  email: z.string().trim().toLowerCase().email(),
  displayName: PersonName,
  title: z.string().trim().max(120).optional(),
  department: z.string().trim().max(120).optional(),
  phone: z.string().trim().max(30).optional(),
  roles: RoleList,
  warehouseScopes: z.array(IdSchema).max(50).default([]),
});
export type CreateUser = z.infer<typeof CreateUserSchema>;

export const UpdateUserSchema = CreateUserSchema.omit({ email: true }).partial();
export type UpdateUser = z.infer<typeof UpdateUserSchema>;

export const ChangePasswordSchema = z.object({
  currentPassword: z.string().min(1).max(200),
  newPassword: z.string().min(12).max(200),
});
export type ChangePassword = z.infer<typeof ChangePasswordSchema>;

export interface AdminUser {
  id: string;
  email: string;
  displayName: string;
  title?: string;
  department?: string;
  phone?: string;
  roles: string[];
  warehouseScopes: string[];
  warehouseNames: string[];
  status: 'ACTIVE' | 'DISABLED';
  root: boolean;
  mfaEnabled: boolean;
  mustChangePassword: boolean;
  lockedUntil?: string;
  lastLoginAt?: string;
  lastSeenAt?: string;
  createdAt?: string;
  demoData?: boolean;
  /** Quyền nghiệp vụ chỉnh riêng (PERM-01) và quyền hiệu lực sau khi áp vai trò. */
  permissionOverrides?: Record<string, boolean>;
  permissions: string[];
}
/** Quản trị gốc cấp / thu quyền nghiệp vụ: true = cấp, false = thu, null = về mặc định theo vai trò. */
export const UpdateUserPermissionsSchema = z.object({ overrides: z.record(z.string(), z.boolean().nullable()) });
export type UpdateUserPermissions = z.infer<typeof UpdateUserPermissionsSchema>;

export interface LoginEvent {
  id: string;
  at: string;
  email: string;
  userId?: string;
  displayName?: string;
  success: boolean;
  reason: string;
  ip?: string;
  userAgent?: string;
}

export type HealthState = 'ok' | 'warning' | 'error' | 'unknown';
export interface SystemCheck {
  key: string;
  state: HealthState;
  /** Mã chi tiết để giao diện dịch; số liệu kèm theo trong params. */
  detail: string;
  params?: Record<string, string | number>;
}
export interface SystemStatus {
  generatedAt: string;
  version: string;
  environment: string;
  uptimeSeconds: number;
  checks: SystemCheck[];
  database: { dataSizeBytes: number; storageSizeBytes: number; collections: number; objects: number };
  queues: Array<{ name: string; waiting: number; active: number; delayed: number; failed: number }>;
  outbox: { pending: number; deadLetter: number };
  errors5xx: Array<{ day: string; count: number }>;
  logins: { failed24h: number; lockedAccounts: number; activeUsers24h: number; onlineNow: number; disabledAccounts: number };
  lastBackup?: { at: string; status: string; sizeBytes?: number; location?: string };
}

// --- Cấu hình giá: bậc doanh số, trần chiết khấu, CK theo cấp, chương trình khuyến mãi (Giám đốc, kế toán) ---
// Phiếu bán chỉ tính giá khi lập / sửa nên cấu hình mới áp dụng cho phiếu lập sau đó; phiếu cũ giữ mức đã tính.

export const SALES_TIER_PERIODS = ['ROLLING_90D', 'QUARTER'] as const;
export const MAX_DISCOUNT_CAP_RATE = 50;

export const SalesTierRuleSchema = z.object({ minimumRevenue: MoneySchema, discountRate: PercentageSchema });

export const PricingPolicyInputSchema = z
  .object({
    version: z.number().int().min(0),
    discountCapRate: PercentageSchema.refine((value) => Number(value) <= MAX_DISCOUNT_CAP_RATE, `Trần chiết khấu tối đa ${MAX_DISCOUNT_CAP_RATE}%`),
    salesTierPeriod: z.enum(SALES_TIER_PERIODS),
    salesTiers: z.array(SalesTierRuleSchema).max(10, 'Tối đa 10 bậc doanh số'),
    customerTierDiscounts: z.object({ TIER_1: PercentageSchema, TIER_2: PercentageSchema, RETAIL: PercentageSchema }),
  })
  .superRefine((value, context) => {
    const cap = Number(value.discountCapRate);
    value.salesTiers.forEach((tier, index) => {
      const previous = value.salesTiers[index - 1];
      if (Number(tier.minimumRevenue) <= 0) {
        context.addIssue({ code: 'custom', path: ['salesTiers', index, 'minimumRevenue'], message: 'Mốc doanh số phải lớn hơn 0' });
      } else if (previous && Number(tier.minimumRevenue) <= Number(previous.minimumRevenue)) {
        context.addIssue({ code: 'custom', path: ['salesTiers', index, 'minimumRevenue'], message: 'Mốc doanh số phải tăng dần' });
      }
      if (Number(tier.discountRate) > cap) {
        context.addIssue({ code: 'custom', path: ['salesTiers', index, 'discountRate'], message: 'Chiết khấu bậc không được vượt trần' });
      } else if (previous && Number(tier.discountRate) < Number(previous.discountRate)) {
        context.addIssue({ code: 'custom', path: ['salesTiers', index, 'discountRate'], message: 'Bậc cao hơn không được chiết khấu thấp hơn' });
      }
    });
    for (const [tier, rate] of Object.entries(value.customerTierDiscounts)) {
      if (Number(rate) > cap) context.addIssue({ code: 'custom', path: ['customerTierDiscounts', tier], message: 'Chiết khấu theo cấp không được vượt trần' });
    }
  });
export type PricingPolicyInput = z.infer<typeof PricingPolicyInputSchema>;

const PromotionFields = {
  name: z.string().trim().min(3).max(200),
  discountRate: PercentageSchema.refine((value) => Number(value) > 0, 'Mức giảm phải lớn hơn 0'),
  validFrom: DateOnlySchema,
  validTo: DateOnlySchema,
  /** Để trống cả nhóm hàng và mã hàng = áp dụng mọi sản phẩm. */
  categoryIds: z.array(IdSchema).max(50).default([]),
  productSkus: z.array(z.string().trim().toUpperCase().min(1).max(40)).max(200).default([]),
  /** Để trống = mọi cấp khách. */
  customerTiers: z.array(CustomerTierSchema).max(3).default([]),
};
const promotionDates = (value: { validFrom: string; validTo: string }) => value.validTo >= value.validFrom;
const PROMOTION_DATE_ISSUE = { path: ['validTo'], message: 'Ngày kết thúc phải từ ngày bắt đầu trở đi' };

export const PromotionInputSchema = z.object({ code: CodeSchema, ...PromotionFields }).refine(promotionDates, PROMOTION_DATE_ISSUE);
export type PromotionInput = z.infer<typeof PromotionInputSchema>;
/** Mã CTKM cố định sau khi tạo (đã in trên dòng phiếu bán). */
export const UpdatePromotionSchema = z.object({ version: z.number().int().min(0), ...PromotionFields }).refine(promotionDates, PROMOTION_DATE_ISSUE);
export type UpdatePromotion = z.infer<typeof UpdatePromotionSchema>;

// --- Phiếu trả hàng & báo cáo kho theo mẫu 月库存明细单 (docs/inventory-excel-mapping.md) ---

const StockReturnLineSchema = z.object({ productId: IdSchema, quantity: PositiveDecimalStringSchema });
const StockReturnBase = {
  partnerId: IdSchema,
  warehouseId: IdSchema,
  note: z.string().trim().min(3).max(500),
  lines: z.array(StockReturnLineSchema).min(1).max(100),
};
/** Khách trả hàng (nhập kho): hàng bán chậm, hàng tặng / combo trả lại, hàng lỗi nhập khẩu, hàng lỗi do sử dụng. */
export const CreateCustomerReturnSchema = z.object({
  kind: z.literal('CUSTOMER'),
  category: z.enum(CUSTOMER_RETURN_CATEGORIES),
  /** Phiếu bán gốc (BH…): có thì kiểm tra mã hàng thuộc phiếu và không trả quá số đã xuất. */
  salesOrderCode: z.string().trim().toUpperCase().max(40).optional(),
  ...StockReturnBase,
});
/** Xuất trả nhà máy / nhà cung cấp (库存退货返厂). */
export const CreateSupplierReturnSchema = z.object({
  kind: z.literal('SUPPLIER'),
  purchaseOrderCode: z.string().trim().toUpperCase().max(40).optional(),
  ...StockReturnBase,
});
export const CreateStockReturnSchema = z.discriminatedUnion('kind', [CreateCustomerReturnSchema, CreateSupplierReturnSchema]);
export type CreateStockReturn = z.infer<typeof CreateStockReturnSchema>;

export interface StockReturn {
  id: string;
  code: string;
  /** SAMPLE = hàng mẫu / hàng kiểm định NVKD mang về theo phiếu (SAL-TYPE-01): không đối tác, không qua kế toán. */
  kind: 'CUSTOMER' | 'SUPPLIER' | 'SAMPLE';
  category: InventoryCategory;
  partnerId?: string;
  partnerCode?: string;
  partnerName: string;
  warehouseId: string;
  warehouseName: string;
  salesOrderCode?: string;
  purchaseOrderCode?: string;
  note: string;
  lines: Array<{ productId: string; sku: string; productName: string; unit: string; quantity: string }>;
  /** Giá trị hàng khách trả theo giá trên phiếu BH gốc (tiền hàng sau CK + VAT) — để kế toán điều chỉnh công nợ / hóa đơn. */
  value?: { net: string; tax: string; total: string };
  /** Khách trả hàng có ảnh hưởng tiền: chờ kế toán xử lý → đã điều chỉnh. */
  accountingStatus?: 'PENDING' | 'DONE';
  accountingNote?: string;
  accountingByName?: string;
  accountingAt?: string;
  createdByName: string;
  createdAt: string;
}

export const StockReturnAccountingSchema = z.object({
  /** VD số hóa đơn điều chỉnh / số chứng từ giảm công nợ. */
  note: z.string().trim().min(3).max(300),
});

export interface InventoryMonthlyRow {
  productId: string;
  sku: string;
  productName: string;
  unit: string;
  /** Số lượng nhập ban đầu (初始入库) = số nhập ban đầu khai khi nhập tồn đầu kỳ + hàng mua đã nhập đến hết kỳ. */
  initialQuantity: number | null;
  remainingPercent: number | null;
  opening: number;
  amounts: Partial<Record<InventoryCategory, number>>;
  netOut: number;
  closing: number;
  /** Tháng hiện tại: tồn khả dụng (现货库存) và đối chiếu sổ (数据查验) với tồn đang ghi. */
  available: number | null;
  ledgerMatches: boolean | null;
}

export interface InventoryMonthlyReport {
  month: string;
  warehouseId: string | null;
  warehouseName: string;
  current: boolean;
  columns: InventoryCategory[];
  rows: InventoryMonthlyRow[];
  totals: { opening: number; amounts: Partial<Record<InventoryCategory, number>>; netOut: number; closing: number };
  mismatches: number;
  /** Phiếu kiểm kê trong kỳ đã chốt mà vẫn còn lệch (cảnh báo trên báo cáo, STK-01). */
  stockCountWarnings: StockCountWarning[];
}

export interface StockCountWarning {
  id: string;
  code: string;
  warehouseName: string;
  closedAt: string;
  closedByName: string;
  mismatches: number;
  note: string;
}

// ---- Kiểm kê kho 2 bước (STK-01) ----

const CountQuantitySchema = z.string().regex(/^\d+(\.\d{1,4})?$/, 'Số lượng không hợp lệ');

export const CreateStockCountSchema = z.object({ warehouseId: IdSchema });

export const SaveStockCountEntriesSchema = z.discriminatedUnion('step', [
  z.object({ step: z.literal('SKU'), version: z.number().int().min(0), entries: z.array(z.object({ productId: IdSchema })).max(3000) }),
  z.object({ step: z.literal('QTY'), version: z.number().int().min(0), entries: z.array(z.object({ productId: IdSchema, quantity: CountQuantitySchema })).max(3000) }),
]);
export type SaveStockCountEntries = z.infer<typeof SaveStockCountEntriesSchema>;

export const StockCountCheckSchema = z.object({ version: z.number().int().min(0), step: z.enum(['SKU', 'QTY']) });

/** Sửa tồn ERP theo kiểm kê: đặt tồn thực tế của mã về số đích, bắt buộc ghi lý do (lưu vết thẻ kho + nhật ký). */
export const StockCountErpFixSchema = z.object({
  version: z.number().int().min(0),
  step: z.enum(['SKU', 'QTY']),
  productId: IdSchema,
  targetOnHand: CountQuantitySchema,
  reason: z.string().trim().min(5, 'Lý do tối thiểu 5 ký tự').max(300),
});
export type StockCountErpFix = z.infer<typeof StockCountErpFixSchema>;

/** Chốt bước 1 / chốt kiểm kê: còn lệch thì phải xác nhận và ghi chú (≥ 10 ký tự). */
export const StockCountConfirmSchema = z.object({
  version: z.number().int().min(0),
  acknowledgeVariance: z.boolean().optional(),
  note: z.string().trim().max(500).optional(),
});
export type StockCountConfirm = z.infer<typeof StockCountConfirmSchema>;

export interface StockCountCheck {
  at: string;
  rows: StockCountRow[];
  matched: number;
  mismatched: number;
}

export interface StockCountAdjustment {
  productId: string;
  sku: string;
  step: StockCountStep;
  before: string;
  after: string;
  delta: string;
  reason: string;
  byName: string;
  at: string;
}

export interface StockCountView {
  id: string;
  code: string;
  warehouseId: string;
  warehouseCode: string;
  warehouseName: string;
  period: string;
  status: StockCountStatus;
  version: number;
  revision: number;
  checkedRevision: number | null;
  startedAt: string;
  startedByName: string;
  skuStep: { entries: Array<{ productId: string; sku: string }>; lastCheck: StockCountCheck | null; lockedAt?: string; lockedByName?: string; lockNote?: string; lockMismatches?: number };
  qtyStep: { entries: Array<{ productId: string; sku: string; quantity: string }>; lastCheck: StockCountCheck | null };
  adjustments: StockCountAdjustment[];
  closedAt?: string;
  closedByName?: string;
  closeNote?: string;
  variance?: { skuMismatches: number; qtyMismatches: number };
  cancelledAt?: string;
}

export interface InventoryJournalRow {
  id: string;
  occurredAt: string;
  category: InventoryCategory;
  direction: 'IN' | 'OUT';
  quantity: number;
  sku: string;
  productName: string;
  unit: string;
  warehouseCode: string;
  documentNo: string;
  documentType: string;
  salesOrderCode?: string;
  salesOrderDate?: string;
  partnerCode?: string;
  partnerName?: string;
  salesRepName?: string;
  keeperName?: string;
  note?: string;
}

