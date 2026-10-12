import { describe, expect, it } from 'vitest';
import { cellText, IMPORT_SHEETS, normalize, parseCell } from './import-sheets';

const column = (sheet: string, key: string) => {
  const found = IMPORT_SHEETS.find((row) => row.name === sheet)?.columns.find((row) => row.key === key);
  if (!found) throw new Error(`${sheet}.${key}`);
  return found;
};

describe('đọc ô Excel', () => {
  it('ngày, công thức, rich text', () => {
    expect(cellText(new Date(Date.UTC(2026, 9, 5, 17, 0)))).toBe('2026-10-06');
    expect(cellText({ formula: 'A1*2', result: 24 })).toBe('24');
    expect(cellText({ richText: [{ text: 'INP' }, { text: '2001' }] })).toBe('INP2001');
    expect(cellText(1.5)).toBe('1.5');
  });

  it('chuẩn hóa tiêu đề cột không dấu', () => {
    expect(normalize('Mã SP *')).toBe('ma sp');
    expect(normalize('Đơn vị  tính')).toBe('don vi tinh');
  });
});

describe('kiểu cột', () => {
  it('mã viết hoa, kiểm tra ký tự', () => {
    expect(parseCell(column('SAN_PHAM', 'sku'), ' inp2001 ')).toEqual({ value: 'INP2001' });
    expect(parseCell(column('SAN_PHAM', 'sku'), 'INP 2001')).toHaveProperty('error');
    expect(parseCell(column('SAN_PHAM', 'sku'), '')).toEqual({ error: 'Bắt buộc nhập' });
  });

  it('số tiền có phân cách nghìn, số thập phân dấu phẩy', () => {
    expect(parseCell(column('SAN_PHAM', 'listPrice'), '1.250.000')).toEqual({ value: '1250000' });
    expect(parseCell(column('SAN_PHAM', 'listPrice'), '1,250,000')).toEqual({ value: '1250000' });
    expect(parseCell(column('SAN_PHAM', 'cartonHeightCm'), '25,5')).toEqual({ value: '25.5' });
    expect(parseCell(column('SAN_PHAM', 'listPrice'), '-5')).toHaveProperty('error');
    expect(parseCell(column('SAN_PHAM', 'listPrice'), '12.345')).toEqual({ value: '12345' });
  });

  it('ngày dd/mm/yyyy và giá trị liệt kê có dấu / không dấu', () => {
    expect(parseCell(column('CONG_NO_DAU_KY', 'dueDate'), '5/11/2026')).toEqual({ value: '2026-11-05' });
    expect(parseCell(column('CONG_NO_DAU_KY', 'dueDate'), '2026-11-05')).toEqual({ value: '2026-11-05' });
    expect(parseCell(column('CONG_NO_DAU_KY', 'dueDate'), '31/02/2026')).toEqual({ error: 'Ngày không hợp lệ' });
    expect(parseCell(column('CONG_NO_DAU_KY', 'dueDate'), '2026-02-29')).toEqual({ error: 'Ngày không hợp lệ' });
    expect(parseCell(column('KHACH_HANG', 'customerTier'), 'Đại lý')).toEqual({ value: 'TIER_2' });
    expect(parseCell(column('KHACH_HANG', 'customerTier'), 'NPP')).toEqual({ value: 'TIER_1' });
    expect(parseCell(column('KHACH_HANG', 'stage'), 'Cơ hội')).toEqual({ value: 'PROSPECT' });
    expect(parseCell(column('KHACH_HANG', 'customerTier'), 'VIP')).toHaveProperty('error');
  });
});

describe('bảng giá theo cấp và tình trạng hàng (bảng báo giá đầy đủ cột, 09/10/2026)', () => {
  it('sheet BANG_GIA: mã bắt buộc, giá NPP / đại lý không bắt buộc', () => {
    expect(column('BANG_GIA', 'sku').required).toBe(true);
    expect(column('BANG_GIA', 'distributorPrice').required).toBeFalsy();
    expect(parseCell(column('BANG_GIA', 'dealerPrice'), '1,086,000')).toEqual({ value: '1086000' });
    expect(parseCell(column('BANG_GIA', 'dealerPrice'), '')).toEqual({ value: undefined });
  });

  it('tình trạng hàng và mã hàng clear như ghi trên bảng giá', () => {
    expect(parseCell(column('SAN_PHAM', 'availability'), 'Còn hàng')).toEqual({ value: 'IN_STOCK' });
    expect(parseCell(column('SAN_PHAM', 'availability'), 'Đang về')).toEqual({ value: 'INCOMING' });
    expect(parseCell(column('SAN_PHAM', 'availability'), 'Chưa có hàng')).toEqual({ value: 'OUT_OF_STOCK' });
    expect(parseCell(column('SAN_PHAM', 'clearance'), 'Có')).toEqual({ value: 'YES' });
    expect(parseCell(column('SAN_PHAM', 'clearance'), 'x')).toEqual({ value: 'YES' });
    expect(parseCell(column('SAN_PHAM', 'clearance'), 'Không')).toEqual({ value: 'NO' });
    expect(column('SAN_PHAM', 'availability').choices).toEqual(['Còn hàng', 'Đang về', 'Chưa có hàng']);
  });
});
