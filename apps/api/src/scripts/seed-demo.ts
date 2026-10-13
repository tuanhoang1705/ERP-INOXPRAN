import { config } from 'dotenv';
import { randomBytes } from 'node:crypto';
import { resolve } from 'node:path';
import Decimal from 'decimal.js';
import { Decimal128, type Db, type Document, MongoClient, ObjectId } from 'mongodb';
import { vnDayStart, vnMonthStart, vnParts } from '../common/domain';
import { hashPassword } from '../modules/auth/password';
import { ObjectStorage } from '../common/object-storage';
import { evaluateApproval } from '../modules/sales/approval.engine';
import { calculatePrice, documentTotals, pickPromotion, resolveSalesTierRate, type PromotionRule } from '../modules/sales/pricing.engine';
import { runOverdueReview } from '../modules/receivables/overdue-review';
import { categories, priceList, type PriceListItem } from './demo-data/inoxpran-price-list';
import { seedWarrantyDemo } from './demo-data/warranty-demo';
import { runWarrantySlaReview } from '../modules/warranty/warranty-sla';

config({ path: process.env.ENV_FILE ?? resolve(process.cwd(), '../../.env'), quiet: true });

/*
 * Dữ liệu trình diễn cho INOXPRAN.
 * - Danh mục, quy cách thùng và 3 mức giá lấy từ bảng báo giá thật (demo-data/inoxpran-price-list.ts).
 * - Kho thật: 1369 Đại lộ Thăng Long, xã Sơn Đồng, TP. Hà Nội.
 * - Đại lý, nhân viên, đơn hàng, công nợ là dữ liệu GIẢ ĐỊNH, sinh tất định (cùng kết quả mỗi lần chạy)
 *   và đều mang cờ demoData: true. Không dùng để hạch toán.
 *
 * Chạy: npm run seed:demo            (chỉ khi CSDL chưa có dữ liệu nghiệp vụ)
 *       npm run seed:demo -- --reset (xóa toàn bộ dữ liệu nghiệp vụ, giữ tài khoản không phải demo)
 */

const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;
const D = (value: Decimal | string | number) => Decimal128.fromString(new Decimal(value).toString());
/** Thuế GTGT 8% (giảm 2% theo chính sách 2026) — đúng như phiếu xuất kho bán hàng. Giá bảng giá đã gồm VAT. */
const TAX_RATE = '8';
const DISCOUNT_CAP = '10';
const ORDER_APPROVAL_THRESHOLD = '150000000';
const SALES_TIERS = [
  { minimumRevenue: '150000000', discountRate: '1' },
  { minimumRevenue: '400000000', discountRate: '2' },
  { minimumRevenue: '1000000000', discountRate: '3' },
];
const REVENUE_STATUSES = new Set(['RESERVED', 'SHIPPED', 'DELIVERED']);

const OPERATIONAL_COLLECTIONS = [
  'products', 'product_categories', 'partners', 'warehouses', 'locations', 'price_books', 'promotions', 'regions', 'employees',
  'sales_orders', 'shipments', 'receivables', 'payments', 'inventory_balances', 'inventory_movements', 'inventory_reservations',
  'inventory_transfers', 'purchase_orders', 'goods_receipts', 'approval_requests', 'notifications', 'outbox_events',
  'idempotency_keys', 'counters', 'overdue_reviews', 'audit_events', 'attachments', 'branches', 'warranty_tickets', 'warranty_fault_codes',
  // Giai đoạn 3–5: nhật ký chăm sóc khách, lô hàng nhập, lô nhập dữ liệu Excel (bộ đếm số chứng từ cũng bị xóa ở trên).
  'partner_activities', 'import_shipments', 'import_batches',
  // 08/10/2026: phiếu trả hàng (khách trả / trả nhà máy).
  'stock_returns',
  'stock_counts',
];

function mulberry32(seed: number) {
  let state = seed;
  return () => {
    state |= 0;
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}
const random = mulberry32(20261001);
const randInt = (min: number, max: number) => min + Math.floor(random() * (max - min + 1));
const pick = <T>(items: readonly T[]): T => items[Math.floor(random() * items.length)] as T;
function weightedPick<T>(items: T[], weight: (item: T) => number): T {
  const total = items.reduce((sum, item) => sum + weight(item), 0);
  let cursor = random() * total;
  for (const item of items) {
    cursor -= weight(item);
    if (cursor <= 0) return item;
  }
  return items[items.length - 1] as T;
}

const regions = [
  { code: 'DBSH', name: 'Đồng bằng sông Hồng', sortOrder: 1 },
  { code: 'TDMN', name: 'Trung du & miền núi phía Bắc', sortOrder: 2 },
  { code: 'BTB', name: 'Bắc Trung Bộ', sortOrder: 3 },
  { code: 'DHMT', name: 'Duyên hải miền Trung', sortOrder: 4 },
];

const employees = [
  { code: 'NV-100', name: 'Đỗ Minh Quang', title: 'Trưởng phòng Kinh doanh', role: 'SALES_MANAGER', regionCode: null, phone: '0901 000 100' },
  { code: 'NV-101', name: 'Nguyễn Anh Tuấn', title: 'Nhân viên kinh doanh', role: 'SALES', regionCode: 'DBSH', phone: '0901 000 101' },
  { code: 'NV-102', name: 'Lê Thị Hương', title: 'Nhân viên kinh doanh', role: 'SALES', regionCode: 'DBSH', phone: '0901 000 102' },
  { code: 'NV-103', name: 'Phạm Quốc Tuấn', title: 'Nhân viên kinh doanh', role: 'SALES', regionCode: 'TDMN', phone: '0901 000 103' },
  { code: 'NV-104', name: 'Nguyễn Đức Anh', title: 'Nhân viên kinh doanh', role: 'SALES', regionCode: 'BTB', phone: '0901 000 104' },
  { code: 'NV-105', name: 'Võ Thị Mai', title: 'Nhân viên kinh doanh online', role: 'SALES', regionCode: null, phone: '0901 000 105' },
];

type Tier = 'TIER_1' | 'TIER_2' | 'RETAIL';
interface DealerSeed {
  code: string; name: string; tier: Tier; regionCode: string | null; province: string; salesRep: string;
  creditLimit: number; paymentTermDays: number; ordersPerMonth: [number, number]; address: string;
  phone?: string; taxCode?: string;
}

/** Phiếu xuất kho bán hàng thật do người dùng cung cấp — tái tạo để đối chiếu mẫu in (giá đã gồm VAT 8%). */
const realSlips = [
  {
    dealer: 'KH012', date: new Date('2026-08-12T09:30:00+07:00'), shippedAt: new Date('2026-08-12T15:00:00+07:00'), salesRep: null as string | null,
    lines: [
      ['INP6004', 15, 586000], ['INP6005', 15, 696000], ['INP6006', 15, 570000], ['INP6007', 15, 680000], ['INP6008', 15, 620000],
      ['INP6009', 15, 750000], ['INP6010', 15, 520000], ['INP6011', 15, 620000], ['INP6012', 8, 650000],
    ] as Array<[string, number, number]>,
    gifts: ['INP6004', 'INP6005', 'INP6006', 'INP6007', 'INP6008', 'INP6009', 'INP6010', 'INP6011', 'INP6012'],
  },
  {
    dealer: 'KH021', date: new Date('2026-09-29T09:00:00+07:00'), shippedAt: new Date('2026-09-29T14:30:00+07:00'), salesRep: 'NV-101',
    lines: [['INP1503', 12, 160000]] as Array<[string, number, number]>,
    gifts: [] as string[],
  },
];
const dealers: DealerSeed[] = [
  { code: 'KH001', name: 'Nhà phân phối Phú Cường', tier: 'TIER_1', regionCode: 'DBSH', province: 'Hải Phòng', salesRep: 'NV-101', creditLimit: 1_500_000_000, paymentTermDays: 45, ordersPerMonth: [5, 7], address: 'Lê Chân, Hải Phòng' },
  { code: 'KH002', name: 'Nhà phân phối Tân Tiến', tier: 'TIER_1', regionCode: 'BTB', province: 'Thanh Hóa', salesRep: 'NV-104', creditLimit: 1_200_000_000, paymentTermDays: 45, ordersPerMonth: [5, 7], address: 'TP. Thanh Hóa' },
  { code: 'KH003', name: 'Nhà phân phối Bảo Long', tier: 'TIER_1', regionCode: 'BTB', province: 'Nghệ An', salesRep: 'NV-104', creditLimit: 1_000_000_000, paymentTermDays: 45, ordersPerMonth: [4, 6], address: 'TP. Vinh, Nghệ An' },
  { code: 'KH004', name: 'Nhà phân phối Đông Bắc', tier: 'TIER_1', regionCode: 'TDMN', province: 'Thái Nguyên', salesRep: 'NV-103', creditLimit: 800_000_000, paymentTermDays: 45, ordersPerMonth: [3, 5], address: 'TP. Thái Nguyên' },
  { code: 'KH005', name: 'Siêu thị Hùng Vương', tier: 'TIER_2', regionCode: 'DBSH', province: 'Hà Nội', salesRep: 'NV-101', creditLimit: 500_000_000, paymentTermDays: 30, ordersPerMonth: [6, 8], address: 'Cầu Giấy, Hà Nội' },
  { code: 'KH006', name: 'Đại lý Đông Đô', tier: 'TIER_2', regionCode: 'DBSH', province: 'Hà Nội', salesRep: 'NV-101', creditLimit: 300_000_000, paymentTermDays: 30, ordersPerMonth: [4, 6], address: 'Hoàng Mai, Hà Nội' },
  { code: 'KH007', name: 'Gia dụng Sơn Đồng', tier: 'TIER_2', regionCode: 'DBSH', province: 'Hà Nội', salesRep: 'NV-101', creditLimit: 250_000_000, paymentTermDays: 30, ordersPerMonth: [3, 5], address: 'Xã Sơn Đồng, Hà Nội' },
  { code: 'KH008', name: 'Đại lý Minh Phát', tier: 'TIER_2', regionCode: 'DBSH', province: 'Nam Định', salesRep: 'NV-102', creditLimit: 400_000_000, paymentTermDays: 30, ordersPerMonth: [4, 6], address: 'TP. Nam Định' },
  { code: 'KH009', name: 'Điện máy Hoàng Gia', tier: 'TIER_2', regionCode: 'DBSH', province: 'Thái Bình', salesRep: 'NV-102', creditLimit: 300_000_000, paymentTermDays: 30, ordersPerMonth: [3, 5], address: 'TP. Thái Bình' },
  { code: 'KH010', name: 'Đại lý An Phú', tier: 'TIER_2', regionCode: 'DBSH', province: 'Ninh Bình', salesRep: 'NV-102', creditLimit: 250_000_000, paymentTermDays: 30, ordersPerMonth: [2, 4], address: 'TP. Ninh Bình' },
  { code: 'KH011', name: 'Gia dụng Thành Đạt', tier: 'TIER_2', regionCode: 'DBSH', province: 'Hải Dương', salesRep: 'NV-101', creditLimit: 300_000_000, paymentTermDays: 30, ordersPerMonth: [3, 5], address: 'TP. Hải Dương' },
  { code: 'KH013', name: 'Đại lý Kinh Bắc', tier: 'TIER_2', regionCode: 'DBSH', province: 'Bắc Ninh', salesRep: 'NV-102', creditLimit: 300_000_000, paymentTermDays: 30, ordersPerMonth: [3, 5], address: 'TP. Bắc Ninh' },
  { code: 'KH014', name: 'Đại lý Phúc Yên', tier: 'TIER_2', regionCode: 'DBSH', province: 'Vĩnh Phúc', salesRep: 'NV-103', creditLimit: 250_000_000, paymentTermDays: 30, ordersPerMonth: [2, 4], address: 'TP. Phúc Yên' },
  { code: 'KH015', name: 'Đại lý Hùng Lâm', tier: 'TIER_2', regionCode: 'TDMN', province: 'Phú Thọ', salesRep: 'NV-103', creditLimit: 250_000_000, paymentTermDays: 30, ordersPerMonth: [2, 4], address: 'TP. Việt Trì' },
  { code: 'KH016', name: 'Đại lý Sa Pa Xanh', tier: 'TIER_2', regionCode: 'TDMN', province: 'Lào Cai', salesRep: 'NV-103', creditLimit: 200_000_000, paymentTermDays: 30, ordersPerMonth: [2, 3], address: 'TP. Lào Cai' },
  { code: 'KH017', name: 'Đại lý Hồng Lĩnh', tier: 'TIER_2', regionCode: 'BTB', province: 'Hà Tĩnh', salesRep: 'NV-104', creditLimit: 250_000_000, paymentTermDays: 30, ordersPerMonth: [2, 4], address: 'TX. Hồng Lĩnh' },
  { code: 'KH018', name: 'Đại lý Sông Hàn', tier: 'TIER_2', regionCode: 'DHMT', province: 'Đà Nẵng', salesRep: 'NV-104', creditLimit: 300_000_000, paymentTermDays: 30, ordersPerMonth: [3, 4], address: 'Hải Châu, Đà Nẵng' },
  { code: 'KH019', name: 'Đại lý Cố Đô', tier: 'TIER_2', regionCode: 'DHMT', province: 'Huế', salesRep: 'NV-104', creditLimit: 200_000_000, paymentTermDays: 30, ordersPerMonth: [2, 3], address: 'TP. Huế' },
  { code: 'KH012', name: 'CÔNG TY TNHH TM GIANG CHÂU', tier: 'TIER_1', regionCode: 'TDMN', province: 'Tuyên Quang', salesRep: 'NV-103', creditLimit: 300_000_000, paymentTermDays: 30, ordersPerMonth: [1, 2], address: 'Tổ dân phố Yên Thái, Phường An Tường, Tuyên Quang', phone: '0918858066', taxCode: '5000906234' },
  { code: 'KH021', name: 'Hộ Kinh Doanh Đào Thị Quỳnh Hoa', tier: 'TIER_1', regionCode: 'DBSH', province: 'Hà Nội', salesRep: 'NV-101', creditLimit: 100_000_000, paymentTermDays: 15, ordersPerMonth: [1, 2], address: 'Số 83A, Phố Hàng Giấy, Phường Hoàn Kiếm, TP Hà Nội', taxCode: '025187017812' },
  { code: 'KH000', name: 'Khách lẻ showroom & online', tier: 'RETAIL', regionCode: null, province: 'Toàn quốc', salesRep: 'NV-105', creditLimit: 0, paymentTermDays: 0, ordersPerMonth: [35, 45], address: 'Showroom Sơn Đồng & website' },
];

/** Kịch bản công nợ để demo Giải thuật 3: các khoản đến hạn từ mốc này trở đi chưa được thu. */
const unpaidFromDaysAgo: Record<string, { days: number; partial?: boolean }> = {
  'KH008': { days: 82 }, // > 60 ngày → Nguy hiểm, tự khóa đặt hàng
  'KH016': { days: 42 }, // 31–60 ngày → Cảnh báo
  'KH004': { days: 35 },
  'KH011': { days: 25, partial: true }, // ≤ 30 ngày → Nhắc nợ
  'KH017': { days: 12 },
};

const lowStockSkus = new Set(['INP1001', 'INP2102', 'INP6201', 'INP6001', 'INP3202', 'INP6409']);
const seasonality: Record<string, number[]> = {
  // hệ số theo tháng 1..12
  QUAT: [0.4, 0.5, 0.9, 1.6, 2.0, 2.0, 1.6, 0.8, 0.5, 0.4, 0.3, 0.3],
  'NOI-INOX': [1.3, 1.0, 0.9, 0.9, 0.9, 0.9, 1.0, 1.2, 1.4, 1.3, 1.3, 1.5],
  CHAO: [1, 1, 1, 1, 1, 1, 1, 1.1, 1.2, 1.2, 1.2, 1.3],
  GANG: [1.2, 0.8, 0.8, 0.7, 0.7, 0.7, 0.8, 1.1, 1.2, 1.3, 1.3, 1.4],
  'DIEN-BEP': [1.1, 1.0, 1.0, 1.0, 1.0, 1.0, 1.0, 1.1, 1.2, 1.2, 1.2, 1.3],
  'TIEN-ICH': [0.6, 0.6, 0.7, 0.9, 1.0, 1.0, 0.9, 0.7, 0.6, 0.6, 0.6, 0.6],
};

function listPriceOf(item: PriceListItem): number {
  return item.retailPrice ?? Math.max(item.dealerPrice ?? 0, item.distributorPrice);
}
function basePriceFor(item: PriceListItem, tier: Tier): number {
  if (tier === 'TIER_1') return item.distributorPrice;
  if (tier === 'TIER_2') return item.dealerPrice ?? listPriceOf(item);
  return listPriceOf(item);
}
function minimumStockOf(item: PriceListItem): number {
  if (item.availability !== 'IN_STOCK') return 0;
  if (item.packSize === 1) return 5;
  return item.packSize * (item.packSize >= 20 ? 2 : 4);
}

interface GeneratedLine {
  item: PriceListItem; productId: ObjectId; categoryId: ObjectId; unit: string; quantity: number; factor: number;
  baseQuantity: number; pricing: ReturnType<typeof calculatePrice>; tierRate: string; salesTierRate: string;
  promotion: PromotionRule | undefined; pricingSource: string; gift: boolean;
}
interface GeneratedOrder {
  _id: ObjectId; dealer: DealerSeed; customerId: ObjectId; orderDate: Date; channel: 'B2B' | 'B2C';
  lines: GeneratedLine[]; subtotal: Decimal; discount: Decimal; net: Decimal; tax: Decimal; total: Decimal;
  status: string; approvalStatus: string; approvalReasons: string[]; shippedAt?: Date; deliveredAt?: Date; code?: string;
  confirmationStatus?: string | undefined; real?: boolean; salesRepCode?: string | null;
}

function vnTime(dayStart: Date, hour: number, minute = 0): Date {
  return new Date(dayStart.getTime() + hour * HOUR_MS + minute * 60_000);
}
function period(date: Date): string {
  const { year, month } = vnParts(date);
  return `${String(year).slice(-2)}${String(month).padStart(2, '0')}`;
}

async function insertMany(db: Db, collection: string, documents: Document[]) {
  for (let index = 0; index < documents.length; index += 1000) {
    await db.collection(collection).insertMany(documents.slice(index, index + 1000), { ordered: true });
  }
}

async function seedDemo(): Promise<void> {
  if (process.env.NODE_ENV === 'production') throw new Error('seed:demo bị vô hiệu hóa trong NODE_ENV=production');
  const reset = process.argv.includes('--reset');
  const uri = process.env.MONGODB_URI;
  if (!uri) throw new Error('MONGODB_URI is required');
  const client = new MongoClient(uri, { ignoreUndefined: true });
  await client.connect();
  try {
    const db = client.db(process.env.MONGODB_DATABASE ?? 'inoxpran_erp');
    const existing = await db.collection('sales_orders').countDocuments() + await db.collection('products').countDocuments();
    if (existing > 0 && !reset) {
      throw new Error('CSDL đã có dữ liệu. Chạy lại với "npm run seed:demo -- --reset" để xóa dữ liệu nghiệp vụ (môi trường dev) và tạo lại dữ liệu demo.');
    }
    if (reset) {
      for (const name of OPERATIONAL_COLLECTIONS) await db.collection(name).deleteMany({});
      await db.collection('users').deleteMany({ demoData: true });
      // Ảnh bằng chứng cũ trên S3 (chỉ khi dùng S3 giả lập ở máy dev — không đụng tới bucket thật).
      const storage = new ObjectStorage(process.env);
      if (storage.configured && process.env.S3_AUTO_CREATE_BUCKET === 'true') {
        await storage.ensureBucket();
        await storage.deletePrefix('sales-evidence/');
      }
      await db.collection('settings').deleteMany({ _id: { $in: ['organization', 'pricing', 'approval', 'operations'] } } as Document);
    }

    const now = new Date();
    const today = vnDayStart(now);
    const { year, month } = vnParts(now);
    const historyStart = vnMonthStart(year, month - 6);
    const admin = await db.collection('users').findOne({ roles: 'ADMIN', demoData: { $ne: true } });
    const actorId = (admin?._id as ObjectId | undefined) ?? new ObjectId();

    // ---------- Danh mục nền ----------
    await db.collection('regions').insertMany(regions.map((region) => ({ _id: new ObjectId(), ...region, demoData: true })));
    const employeeIds = new Map<string, ObjectId>();
    await db.collection('employees').insertMany(employees.map((employee) => {
      const _id = new ObjectId();
      employeeIds.set(employee.code, _id);
      return { _id, ...employee, status: 'ACTIVE', demoData: true, createdAt: now };
    }));

    const warehouseId = new ObjectId();
    await db.collection('warehouses').insertOne({
      _id: warehouseId, code: 'KHO-SD', name: 'Kho Sơn Đồng', address: '1369 Đại lộ Thăng Long, xã Sơn Đồng, TP. Hà Nội',
      active: true, purpose: 'NORMAL', version: 1, createdAt: now, updatedAt: now,
    });
    // Kho hàng lỗi (bảo hành đổi mới / hoàn tiền): nhận sản phẩm lỗi khách trả, chờ trả nhà cung cấp / hủy; không bán ra.
    const defectiveWarehouseId = new ObjectId();
    await db.collection('warehouses').insertOne({
      _id: defectiveWarehouseId, code: 'KHO-SD-HL', name: 'Kho hàng lỗi bảo hành (Sơn Đồng)', address: '1369 Đại lộ Thăng Long, xã Sơn Đồng, TP. Hà Nội',
      active: true, purpose: 'DEFECTIVE', version: 1, demoData: true, createdAt: now, updatedAt: now,
    });
    await db.collection('locations').insertOne({ _id: new ObjectId(), warehouseId: defectiveWarehouseId, code: 'HL-01', name: 'Kệ hàng lỗi chờ trả nhà cung cấp', active: true, createdAt: now });
    const locationCodes = ['A1-01', 'A1-02', 'A2-01', 'A2-02', 'B1-01', 'B1-02', 'B2-01', 'C1-01', 'C1-02', 'D1-01'];
    await db.collection('locations').insertMany(locationCodes.map((code) => ({
      _id: new ObjectId(), warehouseId, code, name: `Dãy ${code.slice(0, 1)} – kệ ${code.slice(1, 2)} – tầng ${code.slice(-2)}`, active: true, createdAt: now,
    })));
    // Văn phòng (không giữ hàng) — chọn được ở ô "Chi nhánh / Kho làm việc" khi đăng nhập.
    await db.collection('branches').insertOne({
      _id: new ObjectId(), code: 'VP-PARAGON', name: 'Văn phòng Tòa B Chung cư Paragon - Cầu Giấy', kind: 'OFFICE',
      address: 'Tòa B, Chung cư Paragon, Cầu Giấy, Hà Nội', defaultWarehouseId: warehouseId, active: true, createdAt: now, updatedAt: now, demoData: true,
    });

    const demoPassword = process.env.DEMO_USER_PASSWORD ?? `Inox-${randomBytes(6).toString('base64url')}`;
    const passwordHash = await hashPassword(demoPassword);
    const demoUsers = [
      { email: 'giamdoc@inoxpran.vn', displayName: 'Ban Giám đốc', title: 'Giám đốc', roles: ['DIRECTOR'] },
      { email: 'truongkd@inoxpran.vn', displayName: 'Đỗ Minh Quang', title: 'Trưởng phòng Kinh doanh', roles: ['SALES_MANAGER'] },
      { email: 'kinhdoanh@inoxpran.vn', displayName: 'Nguyễn Anh Tuấn', title: 'Nhân viên kinh doanh', roles: ['SALES'] },
      { email: 'kho@inoxpran.vn', displayName: 'Bùi Văn Kiên', title: 'Quản lý kho Sơn Đồng', roles: ['WAREHOUSE_MANAGER'] },
      { email: 'kho2@inoxpran.vn', displayName: 'Trần Văn Hùng', title: 'Thủ kho Sơn Đồng', roles: ['WAREHOUSE'] },
      { email: 'ketoan@inoxpran.vn', displayName: 'Ngô Thanh Hà', title: 'Kế toán công nợ', roles: ['ACCOUNTANT'] },
      { email: 'muahang@inoxpran.vn', displayName: 'Vũ Thị Lan', title: 'Trưởng phòng Mua hàng (nhập khẩu)', roles: ['PROCUREMENT_MANAGER'] },
      { email: 'baohanh@inoxpran.vn', displayName: 'Phạm Minh Đức', title: 'Nhân viên bảo hành', roles: ['WARRANTY'] },
      { email: 'baohanh2@inoxpran.vn', displayName: 'Lê Văn Tài', title: 'Kỹ thuật bảo hành', roles: ['WARRANTY'] },
    ];
    for (const user of demoUsers) {
      await db.collection('users').updateOne(
        { email: user.email },
        {
          $set: {
            ...user, passwordHash, status: 'ACTIVE', mfaEnabled: false, demoData: true, updatedAt: now,
            // Kho và Giám đốc thao tác được cả kho hàng lỗi.
            warehouseScopes: user.roles.some((role) => ['WAREHOUSE', 'WAREHOUSE_MANAGER', 'DIRECTOR'].includes(role)) ? [warehouseId.toHexString(), defectiveWarehouseId.toHexString()] : [warehouseId.toHexString()],
          },
          $setOnInsert: { _id: new ObjectId(), createdAt: now },
          $unset: { mfaSecret: '', lockedUntil: '', failedLoginCount: '' },
        },
        { upsert: true },
      );
    }
    if (admin) {
      await db.collection('users').updateOne({ _id: admin._id }, { $set: { warehouseScopes: [], title: 'Quản trị hệ thống' } });
    }
    // Hồ sơ NVKD gắn tài khoản đăng nhập: khách do tài khoản đó tạo tự gán NVKD phụ trách.
    for (const [code, email] of [['NV-100', 'truongkd@inoxpran.vn'], ['NV-101', 'kinhdoanh@inoxpran.vn']] as const) {
      const user = await db.collection('users').findOne({ email }, { projection: { _id: 1 } });
      if (user) await db.collection('employees').updateOne({ code }, { $set: { userId: user._id } });
    }
    // Thủ kho tiếp nhận phiếu: mỗi phiếu đã phát hành được giao cho một thủ kho (chỉ người đó thấy và lập SWK).
    const keeperAccounts = await db.collection('users')
      .find({ email: { $in: ['kho@inoxpran.vn', 'kho2@inoxpran.vn'] } }, { projection: { email: 1, displayName: 1 } })
      .toArray();
    const keeperByEmail = new Map(keeperAccounts.map((row) => [String(row.email), { id: row._id as ObjectId, name: String(row.displayName) }]));
    const mainKeeper = keeperByEmail.get('kho@inoxpran.vn') as { id: ObjectId; name: string };
    const secondKeeper = keeperByEmail.get('kho2@inoxpran.vn') as { id: ObjectId; name: string };
    /** Chia phiếu theo số cuối của số BH (không dùng chuỗi ngẫu nhiên để không làm lệch dữ liệu demo). Đề nghị nháp của KD chưa có thủ kho. */
    const keeperFor = (order: { status: string; code?: string }) =>
      order.status === 'DRAFT' ? null : Number(order.code?.slice(-1) ?? 0) % 3 === 2 ? secondKeeper : mainKeeper;

    const locationByCategory: Record<string, string> = { 'NOI-INOX': 'A1-01', CHAO: 'A2-01', GANG: 'A2-02', 'DIEN-BEP': 'B1-01', QUAT: 'C1-01', 'TIEN-ICH': 'D1-01' };

    const categoryIds = new Map<string, ObjectId>();
    await db.collection('product_categories').insertMany(categories.map((category) => {
      const _id = new ObjectId();
      categoryIds.set(category.code, _id);
      return { _id, ...category, status: 'ACTIVE', createdAt: now, updatedAt: now };
    }));

    const productIds = new Map<string, ObjectId>();
    await db.collection('products').insertMany(priceList.map((item) => {
      const _id = new ObjectId();
      productIds.set(item.sku, _id);
      const reviewNotes = [
        item.retailPrice === null ? 'Thiếu giá bán lẻ' : null,
        item.dealerPrice === null ? 'Thiếu giá đại lý' : null,
        item.note ?? null,
      ].filter(Boolean);
      return {
        _id, sku: item.sku, model: item.model, name: item.name, categoryId: categoryIds.get(item.category),
        baseUnit: item.baseUnit,
        unitConversions: [{ unit: 'Thùng', factorToBase: D(item.packSize), barcode: `893${item.sku.replace(/\D/g, '').padStart(9, '0')}` }],
        listPrice: D(listPriceOf(item)), standardCost: D(item.distributorPrice), minimumStock: D(minimumStockOf(item)),
        packSize: item.packSize, specification: item.specification, availability: item.availability, clearance: Boolean(item.clearance),
        ...(reviewNotes.length ? { priceNeedsReview: true, priceReviewNote: reviewNotes.join('; ') } : {}),
        status: 'ACTIVE', version: 1, createdAt: now, updatedAt: now,
      };
    }));

    const priceBookBase = { status: 'PUBLISHED', version: 1, validFrom: new Date('2026-01-01T00:00:00+07:00'), validTo: null, sourceDocument: 'Bảng báo giá INOXPRAN 29/09/2026', createdAt: now, updatedAt: now };
    await db.collection('price_books').insertMany([
      { _id: new ObjectId(), code: 'BG-NPP-2026', name: 'Bảng giá Net NPP 2026', customerTier: 'TIER_1', priority: 20, ...priceBookBase,
        lines: priceList.map((item) => ({ productId: productIds.get(item.sku), sku: item.sku, baseUnitPrice: D(item.distributorPrice) })) },
      { _id: new ObjectId(), code: 'BG-DAILY-2026', name: 'Bảng giá đại lý 2026', customerTier: 'TIER_2', priority: 20, ...priceBookBase,
        lines: priceList.filter((item) => item.dealerPrice !== null).map((item) => ({ productId: productIds.get(item.sku), sku: item.sku, baseUnitPrice: D(item.dealerPrice as number) })) },
    ]);

    const promotionSeeds = [
      { code: 'KM-HE-2026', name: 'Hè mát cùng INOXPRAN — giảm 5% nhóm quạt', discountRate: '5', validFrom: new Date('2026-05-01T00:00:00+07:00'), validTo: new Date('2026-07-31T23:59:59+07:00'), categoryCodes: ['QUAT'], customerTiers: [] as string[] },
      { code: 'KM-TRUNGTHU-2026', name: 'CTKM Tết Trung thu 2026 — giảm 4% nồi & bộ nồi inox', discountRate: '4', validFrom: new Date('2026-09-01T00:00:00+07:00'), validTo: new Date(today.getTime() + 3 * DAY_MS + 23 * HOUR_MS), categoryCodes: ['NOI-INOX'], customerTiers: [] },
      { code: 'KM-NPP-Q4-2026', name: 'Ưu đãi NPP quý IV — giảm 2% điện gia dụng nhà bếp', discountRate: '2', validFrom: new Date('2026-10-01T00:00:00+07:00'), validTo: new Date('2026-12-31T23:59:59+07:00'), categoryCodes: ['DIEN-BEP'], customerTiers: ['TIER_1'] },
      { code: 'KM-TET-2027', name: 'Chào Tết Đinh Mùi 2027 — giảm 5% nồi & chảo gang', discountRate: '5', validFrom: new Date('2026-12-15T00:00:00+07:00'), validTo: new Date('2027-02-10T23:59:59+07:00'), categoryCodes: ['GANG'], customerTiers: [] },
    ];
    await db.collection('promotions').insertMany(promotionSeeds.map((promotion) => ({
      _id: new ObjectId(), code: promotion.code, name: promotion.name, type: 'PERCENT', discountRate: D(promotion.discountRate),
      validFrom: promotion.validFrom, validTo: promotion.validTo, status: 'ACTIVE',
      categoryIds: promotion.categoryCodes.map((code) => categoryIds.get(code)), productIds: [], customerTiers: promotion.customerTiers,
      demoData: true, createdAt: now, updatedAt: now,
    })));
    const promotionRules: PromotionRule[] = promotionSeeds.map((promotion) => ({
      code: promotion.code, discountRate: promotion.discountRate, validFrom: promotion.validFrom, validTo: promotion.validTo, status: 'ACTIVE',
      categoryIds: promotion.categoryCodes.map((code) => (categoryIds.get(code) as ObjectId).toHexString()), productIds: [], customerTiers: promotion.customerTiers,
    }));

    const customerIds = new Map<string, ObjectId>();
    await db.collection('partners').insertMany([
      ...dealers.map((dealer) => {
        const _id = new ObjectId();
        customerIds.set(dealer.code, _id);
        return {
          _id, code: dealer.code, name: dealer.name, kind: 'CUSTOMER', customerTier: dealer.tier, regionCode: dealer.regionCode ?? undefined,
          province: dealer.province, address: dealer.address, salesRepId: employeeIds.get(dealer.salesRep),
          salesRepName: employees.find((employee) => employee.code === dealer.salesRep)?.name,
          creditLimit: D(dealer.creditLimit), paymentTermDays: dealer.paymentTermDays,
          taxCode: dealer.taxCode ?? (dealer.tier === 'RETAIL' ? undefined : `DEMO-${dealer.code}`),
          phone: dealer.phone ?? (dealer.taxCode ? undefined : `0912 ${String(100 + dealers.indexOf(dealer)).padStart(3, '0')} ${String(200 + dealers.indexOf(dealer) * 7).slice(-3)}`),
          ...(dealer.taxCode ? { realCustomer: true } : {}),
          status: 'ACTIVE', demoData: true, version: 1, createdAt: now, updatedAt: now,
        };
      }),
      { _id: new ObjectId(), code: 'NCC-OEM-QD', name: 'Nhà máy đồ gia dụng Quảng Đông (đối tác OEM)', kind: 'SUPPLIER', creditLimit: D(0), paymentTermDays: 30, taxCode: 'DEMO-SUP-OEM', status: 'ACTIVE', demoData: true, version: 1, createdAt: now, updatedAt: now },
      { _id: new ObjectId(), code: 'NCC-DIEN-NB', name: 'Công ty TNHH Điện gia dụng Ninh Bắc', kind: 'SUPPLIER', creditLimit: D(0), paymentTermDays: 30, taxCode: 'DEMO-SUP-002', status: 'ACTIVE', demoData: true, version: 1, createdAt: now, updatedAt: now },
    ]);
    const suppliers = await db.collection('partners').find({ kind: 'SUPPLIER' }).toArray();

    // ---------- Sinh đơn bán 6 tháng ----------
    const orders: GeneratedOrder[] = [];
    // Doanh số đã ghi nhận theo khách, dùng tính bậc chiết khấu trên cửa sổ 90 ngày gần nhất (ROLLING_90D).
    const revenueHistory = new Map<string, Array<{ at: number; net: Decimal }>>();
    const sellable = (item: PriceListItem, date: Date) => item.availability === 'IN_STOCK' || date < new Date(today.getTime() - 30 * DAY_MS);

    const draftOrders: Array<{ dealer: DealerSeed; date: Date }> = [];
    for (let offset = 0; offset <= 6; offset += 1) {
      const monthStart = vnMonthStart(year, month - 6 + offset);
      const monthEnd = offset === 6 ? new Date(today.getTime() + DAY_MS) : vnMonthStart(year, month - 5 + offset);
      const days = Math.round((monthEnd.getTime() - monthStart.getTime()) / DAY_MS);
      const growth = 0.9 + offset * 0.04;
      for (const dealer of dealers) {
        let count = Math.round(randInt(dealer.ordersPerMonth[0], dealer.ordersPerMonth[1]) * growth);
        if (offset === 6) count = dealer.tier === 'RETAIL' ? 2 : 0; // hôm nay: đơn lẻ; đơn đại lý hôm nay thêm theo kịch bản
        for (let index = 0; index < count; index += 1) {
          const dayOffset = randInt(0, days - 1);
          const dayStart = new Date(monthStart.getTime() + dayOffset * DAY_MS);
          if (new Date(dayStart.getTime() + 12 * HOUR_MS).getUTCDay() === 0) continue; // nghỉ Chủ nhật
          let date = vnTime(dayStart, randInt(8, 16), randInt(0, 59));
          if (date > now) date = new Date(now.getTime() - randInt(20, 120) * 60_000);
          draftOrders.push({ dealer, date });
        }
      }
    }
    // Kịch bản cho hôm qua và hôm nay
    const yesterday = new Date(today.getTime() - DAY_MS);
    const upToNow = (date: Date) => (date > now ? new Date(now.getTime() - 5 * 60_000) : date);
    const scripted: Array<{ dealer: string; date: Date; status: string; big?: boolean; creditPush?: boolean }> = [
      { dealer: 'KH001', date: vnTime(yesterday, 8, 30), status: 'PENDING_APPROVAL', big: true },
      { dealer: 'KH002', date: vnTime(yesterday, 10, 15), status: 'PENDING_APPROVAL', big: true },
      { dealer: 'KH006', date: upToNow(vnTime(today, 8, 5)), status: 'PENDING_APPROVAL', creditPush: true },
      { dealer: 'KH005', date: vnTime(yesterday, 14, 20), status: 'RESERVED' },
      { dealer: 'KH013', date: vnTime(yesterday, 15, 40), status: 'RESERVED' },
      { dealer: 'KH018', date: upToNow(vnTime(today, 8, 40)), status: 'RESERVED' },
      { dealer: 'KH007', date: upToNow(vnTime(today, 9, 0)), status: 'DRAFT' },
    ];
    for (const item of scripted) draftOrders.push({ dealer: dealers.find((dealer) => dealer.code === item.dealer) as DealerSeed, date: item.date });
    for (const slip of realSlips) if (slip.date < now) draftOrders.push({ dealer: dealers.find((dealer) => dealer.code === slip.dealer) as DealerSeed, date: slip.date });
    draftOrders.sort((a, b) => a.date.getTime() - b.date.getTime());

    for (const draft of draftOrders) {
      const script = scripted.find((item) => item.date.getTime() === draft.date.getTime() && item.dealer === draft.dealer.code);
      const real = realSlips.find((item) => item.date.getTime() === draft.date.getTime() && item.dealer === draft.dealer.code);
      const dealer = draft.dealer;
      const monthNumber = vnParts(draft.date).month;
      const channel: 'B2B' | 'B2C' = dealer.tier === 'RETAIL' ? 'B2C' : 'B2B';
      const lineCount = dealer.tier === 'TIER_1' ? randInt(script?.big ? 12 : 6, script?.big ? 16 : 11) : dealer.tier === 'TIER_2' ? randInt(3, 8) : randInt(1, 3);
      const candidates = priceList.filter((item) => sellable(item, draft.date) && !(script && (lowStockSkus.has(item.sku) || item.availability !== 'IN_STOCK')));
      const chosen: PriceListItem[] = [];
      while (chosen.length < lineCount) {
        const item = weightedPick(candidates, (candidate) => (seasonality[candidate.category]?.[monthNumber - 1] ?? 1) * (candidate.clearance ? 0.5 : 1));
        if (!chosen.includes(item)) chosen.push(item);
      }
      const windowStart = vnDayStart(draft.date).getTime() - 89 * DAY_MS;
      const windowRevenue = (revenueHistory.get(dealer.code) ?? [])
        .filter((entry) => entry.at >= windowStart)
        .reduce((sum, entry) => sum.add(entry.net), new Decimal(0));
      const salesTierRate = dealer.tier === 'RETAIL' ? '0' : resolveSalesTierRate(windowRevenue.toString(), SALES_TIERS);
      const buildLine = (item: PriceListItem, unit: string, quantity: number, factor: number, grossPrice: number, gift: boolean, discountTier: string, promotion: PromotionRule | undefined): GeneratedLine => {
        const pricing = calculatePrice({
          quantity: String(quantity), conversionFactor: String(factor), baseUnitPrice: String(grossPrice),
          tierDiscountRate: '0', salesTierDiscountRate: discountTier, promotionDiscountRate: promotion?.discountRate ?? '0',
          discountCapRate: DISCOUNT_CAP, taxRate: TAX_RATE, pricesIncludeTax: true, gift,
        });
        const pricingSource = real ? 'PHIEU_GIAY' : dealer.tier === 'TIER_1' ? 'PRICE_BOOK:BG-NPP-2026:v1' : dealer.tier === 'TIER_2' && item.dealerPrice !== null ? 'PRICE_BOOK:BG-DAILY-2026:v1' : 'PRODUCT_LIST_PRICE';
        return {
          item, productId: productIds.get(item.sku) as ObjectId, categoryId: categoryIds.get(item.category) as ObjectId, unit, quantity, factor,
          baseQuantity: quantity * factor, pricing, tierRate: '0', salesTierRate: gift ? '0' : discountTier, promotion: gift ? undefined : promotion, pricingSource, gift,
        };
      };
      const itemOf = (sku: string) => priceList.find((item) => item.sku === sku) as PriceListItem;
      const lines: GeneratedLine[] = real
        ? [
            ...real.lines.map(([sku, quantity, price]) => buildLine(itemOf(sku), itemOf(sku).baseUnit, quantity, 1, price, false, '0', undefined)),
            ...real.gifts.map((sku) => buildLine(itemOf(sku), itemOf(sku).baseUnit, 1, 1, 0, true, '0', undefined)),
          ]
        : chosen.map((item) => {
        let unit: string = item.baseUnit;
        let quantity: number;
        let factor = 1;
        if (dealer.tier === 'TIER_1') {
          if (item.packSize > 1) { unit = 'Thùng'; factor = item.packSize; quantity = script?.big ? randInt(6, 10) : randInt(2, 6); }
          else quantity = randInt(4, 12);
        } else if (dealer.tier === 'TIER_2') {
          if (item.packSize >= 2 && item.packSize <= 20 && random() < 0.55) { unit = 'Thùng'; factor = item.packSize; quantity = randInt(1, 2); }
          else if (item.packSize > 20) { unit = 'Thùng'; factor = item.packSize; quantity = 1; }
          else quantity = randInt(2, 8);
        } else quantity = randInt(1, 2);
        const promotion = pickPromotion(promotionRules, {
          productId: (productIds.get(item.sku) as ObjectId).toHexString(),
          categoryId: (categoryIds.get(item.category) as ObjectId).toHexString(),
          customerTier: dealer.tier,
          at: draft.date,
        });
        return buildLine(item, unit, quantity, factor, basePriceFor(item, dealer.tier), false, salesTierRate, promotion);
      });
      // Như phiếu thật: NPP lấy từ 3 thùng điện gia dụng thường được tặng kèm 1 sản phẩm cùng mã.
      if (!real && dealer.tier === 'TIER_1') {
        for (const line of [...lines]) {
          if (line.item.category === 'DIEN-BEP' && line.unit === 'Thùng' && line.quantity >= 3 && random() < 0.35) {
            lines.push(buildLine(line.item, line.item.baseUnit, 1, 1, 0, true, '0', undefined));
          }
        }
      }
      const subtotal = lines.reduce((sum, line) => sum.add(line.pricing.subtotal), new Decimal(0));
      const discount = lines.reduce((sum, line) => sum.add(line.pricing.discountAmount), new Decimal(0));
      const totals = documentTotals(lines.reduce((sum, line) => sum.add(line.pricing.netAmount), new Decimal(0)), TAX_RATE);
      const tax = new Decimal(totals.taxTotal);
      const total = new Decimal(totals.grandTotal);
      const age = (today.getTime() - vnDayStart(draft.date).getTime()) / DAY_MS;
      let status = script?.status ?? (age >= 4 ? 'DELIVERED' : age >= 2 ? 'SHIPPED' : 'RESERVED');
      if (channel === 'B2C' && age >= 1) status = 'DELIVERED';
      const order: GeneratedOrder = {
        _id: new ObjectId(), dealer, customerId: customerIds.get(dealer.code) as ObjectId, orderDate: draft.date, channel, lines,
        subtotal, discount, net: new Decimal(totals.netTotal), tax, total, status, real: Boolean(real), salesRepCode: real ? real.salesRep : dealer.salesRep,
        confirmationStatus: status === 'RESERVED' ? (script ? (script.dealer === 'KH005' ? 'CONFIRMED' : 'PENDING') : 'CONFIRMED') : ['SHIPPED', 'DELIVERED'].includes(status) ? 'CONFIRMED' : undefined,
        approvalStatus: script?.status === 'PENDING_APPROVAL' ? 'PENDING' : total.gte(ORDER_APPROVAL_THRESHOLD) ? 'APPROVED' : 'NOT_REQUIRED',
        approvalReasons: script?.status === 'PENDING_APPROVAL' ? [] : total.gte(ORDER_APPROVAL_THRESHOLD) ? ['ORDER_VALUE_THRESHOLD'] : [],
      };
      if (status === 'SHIPPED' || status === 'DELIVERED') {
        order.shippedAt = channel === 'B2C' ? new Date(draft.date.getTime() + 2 * HOUR_MS) : vnTime(new Date(vnDayStart(draft.date).getTime() + randInt(1, 2) * DAY_MS), randInt(8, 15));
        if (order.shippedAt > now) order.shippedAt = new Date(draft.date.getTime() + HOUR_MS);
        if (real) order.shippedAt = real.shippedAt;
        if (status === 'DELIVERED') {
          order.deliveredAt = new Date(order.shippedAt.getTime() + (channel === 'B2C' ? randInt(1, 2) : randInt(1, 3)) * DAY_MS);
          if (order.deliveredAt > now) { order.status = 'SHIPPED'; delete order.deliveredAt; }
        }
      }
      if (REVENUE_STATUSES.has(order.status)) {
        revenueHistory.set(dealer.code, [...(revenueHistory.get(dealer.code) ?? []), { at: draft.date.getTime(), net: order.net }]);
      }
      orders.push(order);
    }

    // ---------- Phải thu, phiếu xuất, thanh toán ----------
    const shipments: Document[] = [];
    const receivables: Document[] = [];
    const payments: Document[] = [];
    const counters = new Map<string, number>();
    const nextCode = (prefix: string, at: Date, width = 5, compact = false) => {
      const key = `${prefix}:${period(at)}`;
      const value = (counters.get(key) ?? 0) + 1;
      counters.set(key, value);
      const parts = vnParts(at);
      return compact
        ? `${prefix}${parts.year}${String(parts.month).padStart(2, '0')}${String(value).padStart(width, '0')}`
        : `${prefix}${period(at)}-${String(value).padStart(width, '0')}`;
    };
    for (const order of orders) order.code = nextCode('BH', order.orderDate, 4, true);

    const shippedOrders = orders.filter((order) => order.shippedAt).sort((a, b) => (a.shippedAt as Date).getTime() - (b.shippedAt as Date).getTime());
    for (const order of shippedOrders) {
      const shippedAt = order.shippedAt as Date;
      const shipmentId = new ObjectId();
      const shipmentCode = `SWK${String(order.code).slice(2)}`; // phiếu kho cùng số phiếu BH
      (order as GeneratedOrder & { shipmentCode?: string }).shipmentCode = shipmentCode;
      shipments.push({
        _id: shipmentId, code: shipmentCode, salesOrderId: order._id, warehouseId, customerId: order.customerId,
        status: order.deliveredAt ? 'DELIVERED' : 'SHIPPED', shippedAt, ...(order.deliveredAt ? { deliveredAt: order.deliveredAt } : {}),
        shippedBy: keeperFor(order)?.id ?? actorId, shippedByName: keeperFor(order)?.name ?? mainKeeper.name, version: 1, createdAt: shippedAt, updatedAt: order.deliveredAt ?? shippedAt, demoData: true,
      });
      const dueDate = new Date(vnDayStart(shippedAt).getTime() + order.dealer.paymentTermDays * DAY_MS + 17 * HOUR_MS);
      const receivableId = new ObjectId();
      const scenario = unpaidFromDaysAgo[order.dealer.code];
      const unpaidBoundary = scenario ? new Date(today.getTime() - scenario.days * DAY_MS) : null;
      let paid = new Decimal(0);
      let paidAt: Date | null = null;
      if (order.channel === 'B2C') {
        paid = order.total;
        paidAt = shippedAt;
      } else if (unpaidBoundary && dueDate >= unpaidBoundary) {
        if (scenario?.partial && dueDate < today) {
          paid = order.total.div(2).toDecimalPlaces(0);
          paidAt = new Date(dueDate.getTime() - 2 * DAY_MS);
        }
      } else if (dueDate < now) {
        paid = order.total;
        paidAt = new Date(dueDate.getTime() - randInt(0, 6) * DAY_MS);
        if (paidAt < shippedAt) paidAt = new Date(shippedAt.getTime() + 3 * DAY_MS);
      } else if (random() < 0.3 && shippedAt < new Date(today.getTime() - 7 * DAY_MS)) {
        paid = order.total;
        paidAt = new Date(shippedAt.getTime() + randInt(5, 7) * DAY_MS);
      }
      if (paidAt && paidAt > now) paidAt = new Date(now.getTime() - HOUR_MS);
      const status = paid.eq(order.total) ? 'PAID' : paid.gt(0) ? 'PARTIALLY_PAID' : 'OPEN';
      receivables.push({
        _id: receivableId, code: nextCode('AR', shippedAt), partnerId: order.customerId, salesOrderId: order._id, salesOrderCode: order.code,
        shipmentId, amount: D(order.total), paidAmount: D(paid), dueDate, status, version: 1, createdAt: shippedAt, updatedAt: paidAt ?? shippedAt, demoData: true,
      });
      if (paid.gt(0) && paidAt) {
        payments.push({
          _id: new ObjectId(), code: nextCode('PAY', paidAt), partnerId: order.customerId, amount: D(paid),
          method: order.channel === 'B2C' ? pick(['CASH', 'BANK_TRANSFER'] as const) : 'BANK_TRANSFER', receivedAt: paidAt,
          reference: order.channel === 'B2C' ? undefined : `FT${period(paidAt)}${String(payments.length + 1).padStart(6, '0')}`,
          allocations: [{ receivableId, amount: D(paid) }], status: 'POSTED', postedBy: actorId, postedAt: paidAt, createdAt: paidAt, demoData: true,
        });
      }
    }

    // Đơn chờ duyệt vượt hạn mức: chỉnh hạn mức Đông Đô để đơn hôm nay thực sự vượt hạn mức.
    const exposureOf = (customerId: ObjectId) => receivables
      .filter((row) => (row.partnerId as ObjectId).equals(customerId) && row.status !== 'PAID')
      .reduce((sum, row) => sum.add(row.amount.toString()).minus(row.paidAmount.toString()), new Decimal(0));
    const creditPushOrder = orders.find((order) => order.dealer.code === 'KH006' && order.status === 'PENDING_APPROVAL');
    if (creditPushOrder) {
      const exposure = exposureOf(creditPushOrder.customerId);
      const limit = exposure.add(creditPushOrder.total.mul(0.6)).div(10_000_000).ceil().mul(10_000_000);
      await db.collection('partners').updateOne({ _id: creditPushOrder.customerId }, { $set: { creditLimit: D(limit) } });
      const dealer = dealers.find((item) => item.code === 'KH006');
      if (dealer) dealer.creditLimit = limit.toNumber();
    }
    const approvalRequests: Document[] = [];
    for (const order of orders.filter((item) => item.status === 'PENDING_APPROVAL')) {
      const evaluation = evaluateApproval({
        orderTotal: order.total.toFixed(2),
        highestDiscountRate: order.lines.reduce((max, line) => Decimal.max(max, line.pricing.discountRate), new Decimal(0)).toString(),
        currentExposure: exposureOf(order.customerId).toFixed(2),
        creditLimit: String(order.dealer.creditLimit),
        orderApprovalThreshold: ORDER_APPROVAL_THRESHOLD,
        discountApprovalThreshold: DISCOUNT_CAP,
      });
      order.approvalReasons = evaluation.reasons.length ? evaluation.reasons : ['ORDER_VALUE_THRESHOLD'];
      approvalRequests.push({
        _id: new ObjectId(), entityType: 'SalesOrder', entityId: order._id, status: 'PENDING', reasons: order.approvalReasons,
        requestedBy: actorId, requestedAt: new Date(order.orderDate.getTime() + 10 * 60_000), demoData: true,
      });
    }
    for (const order of orders.filter((item) => item.approvalStatus === 'APPROVED')) {
      approvalRequests.push({
        _id: new ObjectId(), entityType: 'SalesOrder', entityId: order._id, status: 'APPROVED', reasons: order.approvalReasons,
        requestedBy: actorId, requestedAt: order.orderDate, decidedAt: new Date(order.orderDate.getTime() + 2 * HOUR_MS), decidedBy: actorId, demoData: true,
      });
    }

    // KD đối chiếu với khách sau khi kế toán phát hành (và sau duyệt nếu có), luôn trước lúc kho xuất SWK.
    const confirmedAtFor = (order: GeneratedOrder) => {
      let at = new Date(order.orderDate.getTime() + (order.approvalStatus === 'APPROVED' ? 3 : 1) * HOUR_MS);
      if (order.shippedAt && at >= order.shippedAt) at = new Date(order.shippedAt.getTime() - 30 * 60_000);
      return at > now ? new Date(now.getTime() - 5 * 60_000) : at;
    };
    // Người nhận / phương tiện chọn theo số phiếu để không làm lệch chuỗi ngẫu nhiên của dữ liệu demo.
    const CARRIERS = ['Xe công ty 29C-218.65', 'Viettel Post', 'Nhà xe Hoàng Long', 'Khách tự lấy tại kho'];
    const deliveryFor = (order: GeneratedOrder) => {
      if (order.channel === 'B2C') return { carrier: 'Khách tự lấy tại kho' };
      const carrier = CARRIERS[Number(order.code?.slice(-2) ?? 0) % CARRIERS.length] as string;
      return { carrier, receiverName: carrier === 'Khách tự lấy tại kho' ? `Đại diện ${order.dealer.name}` : 'Thủ kho bên mua' };
    };
    await insertMany(db, 'sales_orders', orders.map((order) => {
      const salesRep = employees.find((employee) => employee.code === order.salesRepCode);
      const shipmentCode = (order as GeneratedOrder & { shipmentCode?: string }).shipmentCode;
      return {
        _id: order._id, code: order.code, customerId: order.customerId, customerCode: order.dealer.code, customerName: order.dealer.name,
        buyer: { code: order.dealer.code, name: order.dealer.name, address: order.dealer.address, phone: order.dealer.phone, taxCode: order.dealer.taxCode ?? (order.dealer.tier === 'RETAIL' ? undefined : `DEMO-${order.dealer.code}`) },
        description: `Bán hàng ${order.dealer.name}`, templateCode: 'PXK-001', taxRate: TAX_RATE, pricesIncludeTax: true,
        ...(order.confirmationStatus ? { confirmationStatus: order.confirmationStatus } : {}),
        ...(order.status !== 'DRAFT' && order.status !== 'PENDING_APPROVAL' ? { issuedAt: new Date(order.orderDate.getTime() + 20 * 60_000), issuedByName: 'Ngô Thanh Hà' } : {}),
        ...(order.confirmationStatus === 'CONFIRMED' ? { confirmedAt: confirmedAtFor(order), confirmedByName: salesRep?.name ?? 'Nguyễn Anh Tuấn' } : {}),
        ...(keeperFor(order) ? { warehouseKeeperId: keeperFor(order)?.id, warehouseKeeperName: keeperFor(order)?.name } : {}),
        ...(shipmentCode ? { warehouseSlipNo: shipmentCode, shippedByName: keeperFor(order)?.name ?? mainKeeper.name, ...deliveryFor(order) } : {}),
        ...(order.status === 'DRAFT' ? { requestedByName: salesRep?.name } : {}),
        createdByName: order.status === 'DRAFT' ? salesRep?.name : 'Ngô Thanh Hà',
        customerTier: order.dealer.tier, province: order.dealer.province, regionCode: order.dealer.regionCode ?? undefined, warehouseId,
        channel: order.channel, ...(salesRep ? { salesRepId: employeeIds.get(salesRep.code), salesRepName: salesRep.name } : {}), orderDate: order.orderDate,
        paymentTermDays: order.dealer.paymentTermDays, lineCount: order.lines.length, status: order.status, approvalStatus: order.approvalStatus,
        requestedDeliveryDate: undefined, note: order.channel === 'B2C' ? 'Đơn bán lẻ tại showroom / website' : undefined,
        lines: order.lines.map((line) => ({
          productId: line.productId, sku: line.item.sku, productName: line.item.name, categoryId: line.categoryId, unit: line.unit, gift: line.gift,
          pricingSource: line.pricingSource, listUnitPrice: D(line.pricing.listUnitPrice), ...(line.promotion ? { promotionCode: line.promotion.code } : {}),
          quantity: D(line.quantity), baseQuantity: D(line.baseQuantity), unitPrice: D(line.pricing.unitPrice), discountRate: D(line.pricing.discountRate),
          tierDiscountRate: D(line.tierRate), salesTierDiscountRate: D(line.salesTierRate), promotionDiscountRate: D(line.promotion?.discountRate ?? '0'),
          netAmount: D(line.pricing.netAmount), lineTotal: D(line.pricing.grossAmount),
          pricingSnapshot: Object.fromEntries(Object.entries(line.pricing).map(([key, value]) => [key, D(value)])),
        })),
        subtotal: D(order.subtotal), discountTotal: D(order.discount), netTotal: D(order.net), taxTotal: D(order.tax), grandTotal: D(order.total),
        createdBy: actorId, version: 1, createdAt: order.orderDate, updatedAt: order.deliveredAt ?? order.shippedAt ?? order.orderDate,
        ...(order.shippedAt ? { shippedAt: order.shippedAt } : {}), ...(order.deliveredAt ? { deliveredAt: order.deliveredAt } : {}),
        ...(order.approvalStatus === 'APPROVED' ? { approvedAt: new Date(order.orderDate.getTime() + 2 * HOUR_MS), approvedBy: actorId, approvedByName: 'Đỗ Minh Quang' } : {}),
        demoData: true,
      };
    }));
    await insertMany(db, 'shipments', shipments.map((shipment) => {
      const order = orders.find((item) => item._id.equals(shipment.salesOrderId as ObjectId)) as GeneratedOrder;
      return { ...shipment, lines: order.lines.map((line) => ({ productId: line.productId, sku: line.item.sku, baseQuantity: D(line.baseQuantity) })) };
    }));
    await insertMany(db, 'receivables', receivables);
    await insertMany(db, 'payments', payments);
    if (approvalRequests.length) await insertMany(db, 'approval_requests', approvalRequests);

    // ---------- Tồn kho, nhập hàng, thẻ kho ----------
    const shippedQty = new Map<string, number>();
    const reservedQty = new Map<string, number>();
    // Đơn chờ duyệt/nháp chưa giữ hàng: bảo đảm đủ tồn để duyệt thành công khi trình diễn.
    const pendingQty = new Map<string, number>();
    for (const order of orders.filter((item) => item.status === 'PENDING_APPROVAL' || item.status === 'DRAFT')) {
      for (const line of order.lines) pendingQty.set(line.item.sku, (pendingQty.get(line.item.sku) ?? 0) + line.baseQuantity);
    }
    const movements: Document[] = [];
    const reservations: Document[] = [];
    for (const order of orders) {
      for (const line of order.lines) {
        if (order.shippedAt) {
          shippedQty.set(line.item.sku, (shippedQty.get(line.item.sku) ?? 0) + line.baseQuantity);
          movements.push({
            _id: new ObjectId(), warehouseId, productId: line.productId, movementType: 'SALES_SHIPMENT', direction: 'OUT', category: line.gift ? 'GIFT_OUT' : 'SALES_OUT', quantity: D(line.baseQuantity),
            unit: line.item.baseUnit, locationCode: locationByCategory[line.item.category], referenceType: 'Shipment',
            referenceId: (order as GeneratedOrder & { shipmentCode?: string }).shipmentCode, salesOrderCode: order.code, actorId, occurredAt: order.shippedAt, demoData: true,
          });
        } else if (order.status === 'RESERVED') {
          reservedQty.set(line.item.sku, (reservedQty.get(line.item.sku) ?? 0) + line.baseQuantity);
          reservations.push({ _id: new ObjectId(), salesOrderId: order._id, warehouseId, productId: line.productId, quantity: D(line.baseQuantity), status: 'ACTIVE', createdBy: actorId, createdAt: order.orderDate, demoData: true });
        }
      }
    }

    const receiptDates = [vnTime(vnMonthStart(year, month - 4), 9 * 24 + 9), vnTime(vnMonthStart(year, month - 2), 17 * 24 + 10)];
    const purchaseOrders: Document[] = [];
    const goodsReceipts: Document[] = [];
    const receivedQty = new Map<string, number>();
    receiptDates.forEach((receiptDate, index) => {
      const supplier = suppliers[index % suppliers.length] as Document;
      const items = priceList.filter((item) => (shippedQty.get(item.sku) ?? 0) > 0 && (index === 0 || item.category !== 'QUAT'));
      const poLines = items.map((item) => {
        const quantity = Math.max(item.packSize, Math.round(((shippedQty.get(item.sku) ?? 0) * 0.3) / item.packSize) * item.packSize);
        receivedQty.set(item.sku, (receivedQty.get(item.sku) ?? 0) + quantity);
        const cost = new Decimal(item.distributorPrice).mul(0.78).div(1000).round().mul(1000);
        return {
          productId: productIds.get(item.sku), sku: item.sku, productName: item.name, unit: item.baseUnit, quantity: D(quantity), baseQuantity: D(quantity),
          receivedBaseQuantity: D(quantity), unitCost: D(cost), lineTotal: D(cost.mul(quantity)),
        };
      });
      const orderDate = new Date(receiptDate.getTime() - 21 * DAY_MS);
      const poId = new ObjectId();
      const poCode = nextCode('PO', orderDate);
      const grCode = nextCode('GR', receiptDate);
      purchaseOrders.push({
        _id: poId, code: poCode, supplierId: supplier._id, supplierCode: supplier.code, supplierName: supplier.name, warehouseId,
        expectedDate: undefined, note: 'Nhập hàng bổ sung theo kế hoạch (dữ liệu demo)', status: 'RECEIVED', approvalStatus: 'APPROVED', lines: poLines,
        total: D(poLines.reduce((sum, line) => sum.add(line.lineTotal.toString()), new Decimal(0))), createdBy: actorId, approvedBy: actorId,
        approvedAt: new Date(orderDate.getTime() + 3 * HOUR_MS), version: 3, createdAt: orderDate, updatedAt: receiptDate, demoData: true,
      });
      goodsReceipts.push({
        _id: new ObjectId(), code: grCode, purchaseOrderId: poId, supplierId: supplier._id, warehouseId, supplierDocumentReference: `PGH-${grCode}`,
        lines: poLines.map((line) => ({ productId: line.productId, quantity: line.baseQuantity })), status: 'POSTED', postedBy: actorId, postedAt: receiptDate, createdAt: receiptDate, demoData: true,
      });
      for (const line of poLines) {
        movements.push({
          _id: new ObjectId(), warehouseId, productId: line.productId, movementType: 'PURCHASE_RECEIPT', direction: 'IN', quantity: line.baseQuantity,
          unit: line.unit, referenceType: 'GoodsReceipt', referenceId: grCode, reason: `Nhập theo ${poCode}`, actorId, occurredAt: receiptDate, demoData: true,
        });
      }
    });
    // Đơn mua hàng đang về cho các mã "Đang về"
    const incoming = priceList.filter((item) => item.availability === 'INCOMING');
    const incomingOrderDate = new Date(today.getTime() - 12 * DAY_MS + 9 * HOUR_MS);
    const incomingLines = incoming.map((item) => {
      const quantity = item.packSize * (item.packSize >= 12 ? 20 : 30);
      const cost = new Decimal(item.distributorPrice).mul(0.78).div(1000).round().mul(1000);
      return { productId: productIds.get(item.sku), sku: item.sku, productName: item.name, unit: item.baseUnit, quantity: D(quantity), baseQuantity: D(quantity), receivedBaseQuantity: D(0), unitCost: D(cost), lineTotal: D(cost.mul(quantity)) };
    });
    const oem = suppliers[0] as Document;
    purchaseOrders.push({
      _id: new ObjectId(), code: nextCode('PO', incomingOrderDate), supplierId: oem._id, supplierCode: oem.code, supplierName: oem.name, warehouseId,
      expectedDate: (() => { const parts = vnParts(new Date(today.getTime() + 10 * DAY_MS)); return `${parts.year}-${String(parts.month).padStart(2, '0')}-${String(parts.day).padStart(2, '0')}`; })(),
      note: 'Hàng đang về: quạt tích điện (dữ liệu demo)', status: 'APPROVED', approvalStatus: 'APPROVED', lines: incomingLines,
      total: D(incomingLines.reduce((sum, line) => sum.add(line.lineTotal.toString()), new Decimal(0))), createdBy: actorId, approvedBy: actorId,
      approvedAt: new Date(incomingOrderDate.getTime() + 4 * HOUR_MS), version: 3, createdAt: incomingOrderDate, updatedAt: incomingOrderDate, demoData: true,
    });

    // Phát sinh kho tháng này theo các cột của 月库存明细单: hàng mẫu xuất / trả, hao hụt, khách trả hàng bán chậm,
    // khách trả hàng lỗi (vào kho hàng lỗi), trả nhà máy — để báo cáo tồn kho tháng và nhật ký xuất nhập có đủ loại.
    const extraNet = new Map<string, number>();
    const stockReturns: Document[] = [];
    const defectBalances: Document[] = [];
    {
      const monthStart = vnMonthStart(year, month);
      const at = (daysAgo: number, hour: number) => new Date(Math.max(monthStart.getTime() + HOUR_MS * 9, today.getTime() - daysAgo * DAY_MS + hour * HOUR_MS));
      const picks = priceList.filter((item) => item.availability === 'IN_STOCK' && !lowStockSkus.has(item.sku) && (pendingQty.get(item.sku) ?? 0) === 0).slice(0, 5);
      const [sampleItem, lossItem, slowItem, defectItem, factoryItem] = picks;
      const productOf = (item: PriceListItem) => productIds.get(item.sku) as ObjectId;
      const move = (item: PriceListItem, values: Document, quantity: number, target = warehouseId) => {
        movements.push({ _id: new ObjectId(), warehouseId: target, productId: productOf(item), quantity: D(quantity), unit: item.baseUnit, actorId, demoData: true, ...values });
        if (target.equals(warehouseId)) extraNet.set(item.sku, (extraNet.get(item.sku) ?? 0) + (values.direction === 'IN' ? quantity : -quantity));
      };
      if (sampleItem) {
        const out = at(6, 9);
        move(sampleItem, { movementType: 'ADJUSTMENT_OUT', direction: 'OUT', category: 'SAMPLE_OUT', referenceType: 'InventoryAdjustment', referenceId: nextCode('ADJ', out), reason: 'Mẫu trưng bày hội chợ — anh Ninh mượn', occurredAt: out }, 2);
        const back = at(2, 15);
        move(sampleItem, { movementType: 'ADJUSTMENT_IN', direction: 'IN', category: 'SAMPLE_IN', referenceType: 'InventoryAdjustment', referenceId: nextCode('ADJ', back), reason: 'Hàng mẫu trả về kho sau hội chợ', occurredAt: back }, 1);
      }
      if (lossItem) {
        const lost = at(5, 10);
        move(lossItem, { movementType: 'ADJUSTMENT_OUT', direction: 'OUT', category: 'LOSS_OUT', referenceType: 'InventoryAdjustment', referenceId: nextCode('ADJ', lost), reason: 'Mở thùng thiếu 1 bộ (vỏ hộp rỗng)', occurredAt: lost }, 1);
      }
      const returnDoc = (code: string, kind: 'CUSTOMER' | 'SUPPLIER', category: string, partner: Document, target: ObjectId, item: PriceListItem, quantity: number, note: string, when: Date) => ({
        _id: new ObjectId(), code, kind, category, partnerId: partner._id, partnerCode: String(partner.code), partnerName: String(partner.name),
        warehouseId: target, warehouseName: target.equals(warehouseId) ? 'Kho Sơn Đồng' : 'Kho hàng lỗi bảo hành (Sơn Đồng)', note,
        lines: [{ productId: productOf(item), sku: item.sku, productName: item.name, unit: item.baseUnit, quantity: D(quantity) }],
        ...(kind === 'CUSTOMER' ? { accountingStatus: 'PENDING' } : {}),
        createdBy: actorId, createdByName: 'Bùi Văn Kiên', createdAt: when, demoData: true,
      });
      const partnerOf = async (code: string) => (await db.collection('partners').findOne({ code })) as Document;
      if (slowItem) {
        const when = at(4, 14);
        const customer = await partnerOf('KH005');
        const code = nextCode('TH', when, 4, true);
        move(slowItem, { movementType: 'CUSTOMER_RETURN', direction: 'IN', category: 'SLOW_RETURN_IN', referenceType: 'StockReturn', referenceId: code, partnerId: customer._id, reason: 'Hàng bán chậm khách trả lại', occurredAt: when }, 3);
        stockReturns.push(returnDoc(code, 'CUSTOMER', 'SLOW_RETURN_IN', customer, warehouseId, slowItem, 3, 'Hàng bán chậm khách trả lại', when));
      }
      if (defectItem) {
        const when = at(3, 11);
        const customer = await partnerOf('KH007');
        const code = nextCode('TH', when, 4, true);
        move(defectItem, { movementType: 'CUSTOMER_RETURN', direction: 'IN', category: 'IMPORT_DEFECT_IN', referenceType: 'StockReturn', referenceId: code, partnerId: customer._id, reason: 'Khách nhận hàng bị móp nắp — lỗi từ nhà máy', occurredAt: when }, 1, defectiveWarehouseId);
        stockReturns.push(returnDoc(code, 'CUSTOMER', 'IMPORT_DEFECT_IN', customer, defectiveWarehouseId, defectItem, 1, 'Khách nhận hàng bị móp nắp — lỗi từ nhà máy', when));
        defectBalances.push({ _id: new ObjectId(), warehouseId: defectiveWarehouseId, productId: productOf(defectItem), onHand: D(1), reserved: D(0), locationCode: 'HL-01', createdAt: when, updatedAt: when, demoData: true });
      }
      if (factoryItem && suppliers[0]) {
        const when = at(1, 10);
        const supplier = suppliers[0] as Document;
        const code = nextCode('XT', when, 4, true);
        move(factoryItem, { movementType: 'SUPPLIER_RETURN', direction: 'OUT', category: 'FACTORY_RETURN_OUT', referenceType: 'StockReturn', referenceId: code, partnerId: supplier._id, reason: 'Trả nhà máy hàng tồn lâu theo thỏa thuận', occurredAt: when }, 2);
        stockReturns.push(returnDoc(code, 'SUPPLIER', 'FACTORY_RETURN_OUT', supplier, warehouseId, factoryItem, 2, 'Trả nhà máy hàng tồn lâu theo thỏa thuận', when));
      }
    }

    const balances: Document[] = [];
    for (const item of priceList) {
      const minimum = minimumStockOf(item);
      const shipped = shippedQty.get(item.sku) ?? 0;
      const received = receivedQty.get(item.sku) ?? 0;
      const reserved = reservedQty.get(item.sku) ?? 0;
      let targetAvailable = 0;
      if (item.availability === 'IN_STOCK') {
        targetAvailable = lowStockSkus.has(item.sku)
          ? Math.max(1, Math.round(minimum * (0.3 + random() * 0.5)))
          : Math.round(minimum * (1.4 + random() * 3.5) / Math.max(1, Math.min(item.packSize, 10))) * Math.max(1, Math.min(item.packSize, 10));
      }
      if (item.availability === 'IN_STOCK' && (pendingQty.get(item.sku) ?? 0) > 0) {
        targetAvailable = Math.max(targetAvailable, (pendingQty.get(item.sku) ?? 0) + minimum + item.packSize * 2);
      }
      const onHand = targetAvailable + reserved;
      const opening = Math.max(0, onHand + shipped - received - (extraNet.get(item.sku) ?? 0));
      const productId = productIds.get(item.sku) as ObjectId;
      if (opening > 0) {
        movements.push({
          _id: new ObjectId(), warehouseId, productId, movementType: 'OPENING', direction: 'IN', quantity: D(opening), initialQuantity: D(opening), unit: item.baseUnit,
          locationCode: locationByCategory[item.category], referenceType: 'OpeningBalance', referenceId: `TONDAU-${period(historyStart)}`,
          reason: 'Tồn đầu kỳ (dữ liệu demo)', actorId, occurredAt: historyStart, demoData: true,
        });
      }
      balances.push({
        _id: new ObjectId(), warehouseId, productId, onHand: D(opening + received - shipped + (extraNet.get(item.sku) ?? 0)), reserved: D(reserved),
        locationCode: locationByCategory[item.category], createdAt: historyStart, updatedAt: now, demoData: true,
      });
    }
    await insertMany(db, 'inventory_movements', movements);
    await insertMany(db, 'inventory_balances', [...balances, ...defectBalances]);
    if (stockReturns.length) await insertMany(db, 'stock_returns', stockReturns);
    if (reservations.length) await insertMany(db, 'inventory_reservations', reservations);
    await insertMany(db, 'purchase_orders', purchaseOrders);
    await insertMany(db, 'goods_receipts', goodsReceipts);
    // Phiếu bảo hành demo (đủ 3 màu theo hẹn trả) — số phiếu SC dùng chung bộ đếm.
    const warrantyStaff = await db.collection('users').find({ email: { $in: ['baohanh@inoxpran.vn', 'baohanh2@inoxpran.vn'] } }).toArray();
    const staffOf = (email: string) => { const user = warrantyStaff.find((item) => item.email === email) as Document; return { id: user._id as ObjectId, name: String(user.displayName) }; };
    const warranty = await seedWarrantyDemo(db, now, counters, { receiver: staffOf('baohanh@inoxpran.vn'), technician: staffOf('baohanh2@inoxpran.vn') });
    await db.collection<{ _id: string } & Document>('counters').insertMany(
      [...counters.entries()].map(([key, value]) => ({ _id: key, value, createdAt: now })),
    );

    // ---------- Cấu hình & tài khoản demo ----------
    const settings = db.collection<{ _id: string } & Document>('settings');
    await Promise.all([
      settings.updateOne({ _id: 'organization' }, { $set: { legalName: 'Công ty TNHH Đầu tư Thắng Vượng', brand: 'INOXPRAN', currency: 'VND', timezone: 'Asia/Ho_Chi_Minh', warehouseAddress: '1369 Đại lộ Thăng Long, xã Sơn Đồng, TP. Hà Nội', updatedAt: now } }, { upsert: true }),
      settings.updateOne({ _id: 'pricing' }, { $set: {
        defaultTaxRate: TAX_RATE, pricesIncludeTax: true, discountCapRate: DISCOUNT_CAP,
        customerTierDiscounts: { TIER_1: '0', TIER_2: '0', RETAIL: '0' }, salesTiers: SALES_TIERS, salesTierPeriod: 'ROLLING_90D', demoData: true, updatedAt: now,
      } }, { upsert: true }),
      settings.updateOne({ _id: 'approval' }, { $set: { orderValueThreshold: ORDER_APPROVAL_THRESHOLD, purchaseOrderThreshold: '200000000', discountRateThreshold: DISCOUNT_CAP, demoData: true, updatedAt: now } }, { upsert: true }),
      // Chốt 03/10/2026: bảo hành 12 tháng mọi sản phẩm, bắt buộc hóa đơn, hẹn trả 7 ngày, vàng khi qua 70% thời gian hẹn.
      settings.updateOne({ _id: 'warranty' }, { $set: { warrantyMonths: 12, turnaroundDays: 7, warningRatio: 0.7, requireInvoice: true, demoData: true, updatedAt: now } }, { upsert: true }),
      settings.updateOne({ _id: 'operations' }, { $set: { preventNegativeStock: true, allowPartialPurchaseReceipt: true, allowPartialSalesShipment: false, paymentAllocationMode: 'MANUAL', allowOverpayment: false, receivableAgingBuckets: [30, 60], documentNumberPattern: 'DH{YY}{MM}-{SEQUENCE:4}', demoData: true, updatedAt: now } }, { upsert: true }),
    ]);


    const review = await runOverdueReview(db, now);
    const warrantyReview = await runWarrantySlaReview(db, now);
    const revenue = orders.filter((order) => REVENUE_STATUSES.has(order.status)).reduce((sum, order) => sum.add(order.net), new Decimal(0));
    process.stdout.write([
      'Đã tạo dữ liệu demo INOXPRAN:',
      `  • ${priceList.length} mã hàng / ${categories.length} nhóm, 2 kho (Sơn Đồng + kho hàng lỗi), ${dealers.length} khách hàng, ${employees.length} nhân viên`,
      `  • ${orders.length} đơn bán, ${shipments.length} phiếu xuất, ${receivables.length} khoản phải thu, ${payments.length} phiếu thu, ${purchaseOrders.length} đơn mua`,
      `  • Doanh số 6 tháng (sau CK, chưa VAT): ${revenue.toDecimalPlaces(0).toNumber().toLocaleString('vi-VN')} đ`,
      `  • Bảo hành: ${warranty.total} phiếu (${warranty.open} đang xử lý; ${warrantyReview.overdue} quá hẹn, ${warrantyReview.warning} sắp đến hẹn), ${warranty.faultCodes} mã lỗi`,
      `  • Rà soát công nợ: ${review.reminder} nhắc nợ / ${review.warning} cảnh báo / ${review.danger} nguy hiểm; tạm khóa: ${review.lockedPartners.join(', ') || 'không'}`,
      `  • Tài khoản demo (MFA tắt): ${demoUsers.map((user) => user.email).join(', ')}`,
      process.env.DEMO_USER_PASSWORD ? '    Mật khẩu: lấy từ DEMO_USER_PASSWORD' : `    Mật khẩu (chỉ hiển thị lần này): ${demoPassword}`,
      '',
    ].join('\n'));
  } finally {
    await client.close();
  }
}

seedDemo().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
});
