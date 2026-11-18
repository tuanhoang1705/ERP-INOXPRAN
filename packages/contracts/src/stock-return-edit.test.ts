import { describe, expect, it } from 'vitest';
import { CorrectGoodsReceiptSchema, CreateStockReturnSchema, UpdateStockReturnSchema, UpdateWarrantyIntakeSchema, VoidStockReturnSchema, WarrantyActionSchema } from './index.js';
import { categoryAmount, categoryOf, STOCK_BACKDATE_FROM } from './shared/inventory-categories.js';
import { expandStockReturnCode } from './shared/stock-return-code.js';

const id = '6ad5ec55b1816be287b02c63';
const customerReturn = {
  kind: 'CUSTOMER',
  category: 'USAGE_DEFECT_IN',
  partnerId: id,
  warehouseId: id,
  note: 'Khách trả hàng lỗi',
  receivedAt: '2026-10-19T09:00:00+07:00',
  lines: [{ productId: id, quantity: '2', note: 'Không lên nguồn' }],
};

describe('phiếu trả hàng 20/10/2026: ngày nhận, nguyên nhân dòng, sửa / hủy', () => {
  it('giữ số tự nhập khi tạo, mặc định tự sinh và không đổi số khi sửa phiếu', () => {
    expect(CreateStockReturnSchema.parse(customerReturn).code).toBeUndefined();
    expect(CreateStockReturnSchema.parse({ ...customerReturn, code: ' 0040 ' }).code).toBe('0040');
    expect(UpdateStockReturnSchema.parse({ ...customerReturn, version: 0, reason: 'Sửa số lượng', code: '0041' })).not.toHaveProperty('code');
  });

  it('ghép số ngắn với tháng chứng từ và chuẩn hóa số ghi đầy đủ trên phiếu giấy', () => {
    expect(expandStockReturnCode('0040', 'NK', '2026-10-19')).toBe('NK2026100040');
    expect(expandStockReturnCode('40', 'XT', '2026-11-18')).toBe('XT2026110040');
    expect(expandStockReturnCode(' nk2026100040 ', 'NK', '2026-11-18')).toBe('NK2026100040');
    expect(expandStockReturnCode('10000', 'NK', '2026-11-18')).toBe('NK20261110000');
    for (const invalid of ['', '0000', 'NK2026130040', 'NK2026110040-H1', 'XT2026110040', 'BH2026110040']) {
      expect(expandStockReturnCode(invalid, 'NK', '2026-11-18')).toBeNull();
    }
  });

  it('khách trả nhận ngày giờ nhận (có múi giờ) và nguyên nhân từng dòng', () => {
    const parsed = CreateStockReturnSchema.parse(customerReturn);
    expect(parsed.kind === 'CUSTOMER' && parsed.receivedAt).toBe('2026-10-19T09:00:00+07:00');
    expect(parsed.lines[0]?.note).toBe('Không lên nguồn');
    expect(() => CreateStockReturnSchema.parse({ ...customerReturn, receivedAt: '19/10/2026' })).toThrow();
  });

  it('sửa phiếu bắt buộc phiên bản + lý do; hủy phiếu bắt buộc lý do', () => {
    expect(UpdateStockReturnSchema.parse({ ...customerReturn, version: 0, reason: 'Đếm lại' }).version).toBe(0);
    expect(() => UpdateStockReturnSchema.parse({ ...customerReturn, version: 0 })).toThrow();
    expect(() => UpdateStockReturnSchema.parse({ ...customerReturn, version: 0, reason: 'ab' })).toThrow();
    expect(() => VoidStockReturnSchema.parse({ version: 1, reason: '' })).toThrow();
  });

  it('mốc ghi lùi ngày = 00:00 01/10/2026 giờ Việt Nam (sau tồn đầu kỳ 30/09)', () => {
    expect(STOCK_BACKDATE_FROM.toISOString()).toBe('2026-09-30T17:00:00.000Z');
  });

  it('dòng đảo / sửa trừ đúng cột của loại gốc trên báo cáo tháng', () => {
    expect(categoryAmount('USAGE_DEFECT_IN', 'OUT', 2)).toBe(-2);
    expect(categoryOf({ movementType: 'RETURN_CORRECTION', direction: 'OUT', category: 'USAGE_DEFECT_IN' })).toBe('USAGE_DEFECT_IN');
    expect(categoryOf({ movementType: 'RECEIPT_CORRECTION', direction: 'OUT' })).toBe('PURCHASE_IN');
    expect(categoryAmount('PURCHASE_IN', 'OUT', 2)).toBe(-2);
  });
});

describe('bảo hành / phiếu nhập 20/10/2026', () => {
  it('trả khách: hàng đổi đã giao trước + số phiếu trả hàng (viết hoa)', () => {
    const action = WarrantyActionSchema.parse({ type: 'RETURN', version: 3, receiverName: 'Đại lý', exchangeDelivered: true, returnSlipCode: 'th2026100007' });
    expect(action.type === 'RETURN' && action.returnSlipCode).toBe('TH2026100007');
  });

  it('sửa tiếp nhận: cần lý do, hóa đơn đủ số + ngày', () => {
    const intake = { channel: 'DEALER', customerName: 'Ánh Luật', productId: id, receivedDate: '2026-10-20', symptom: 'Không lên nguồn', version: 1, reason: 'Sai số điện thoại' };
    expect(UpdateWarrantyIntakeSchema.parse(intake).reason).toBe('Sai số điện thoại');
    expect(() => UpdateWarrantyIntakeSchema.parse({ ...intake, invoiceNumber: 'HD1' })).toThrow();
    expect(() => UpdateWarrantyIntakeSchema.parse({ ...intake, reason: '' })).toThrow();
  });

  it('sửa phiếu nhập: số thực nhận được về 0, cần lý do', () => {
    expect(CorrectGoodsReceiptSchema.parse({ version: 0, reason: 'Nhận nhầm', lines: [{ productId: id, quantity: '0' }] }).lines[0]?.quantity).toBe('0');
    expect(() => CorrectGoodsReceiptSchema.parse({ version: 0, reason: '', lines: [{ productId: id, quantity: '1' }] })).toThrow();
  });
});
