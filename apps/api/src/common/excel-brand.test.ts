import type ExcelJS from 'exceljs';
import { describe, expect, it } from 'vitest';
import { brandSheet, brandWorkbook, kpiStrip, type BrandColumn } from './excel-brand';

const ledger: BrandColumn[] = [
  { key: 'stt', header: 'STT', width: 6 },
  { key: 'date', header: 'Ngày', width: 12 },
  { key: 'doc', header: 'Chứng từ', width: 17 },
  { key: 'text', header: 'Diễn giải', width: 42 },
  { key: 'debit', header: 'Phát sinh nợ (đ)', width: 17 },
  { key: 'paid', header: 'Đã thu (đ)', width: 17 },
  { key: 'ship', header: 'Phí vận chuyển (đ)', width: 15 },
  { key: 'return', header: 'Trả hàng / giảm (đ)', width: 15 },
  { key: 'balance', header: 'Còn nợ lũy kế (đ)', width: 18 },
];

const mergedWidth = (sheet: ExcelJS.Worksheet, range: string) => {
  const [from, to] = range.split(':').map((ref) => sheet.getCell(ref!).col);
  let total = 0;
  for (let column = Number(from); column <= Number(to); column += 1) total += sheet.getColumn(column).width ?? 9;
  return total;
};

describe('bộ chuẩn Excel thương hiệu', () => {
  it('dải chỉ số chia theo độ rộng cột: không ô nào rơi vào một cột hẹp (hiện #####)', () => {
    const sheet = brandSheet(brandWorkbook(), 'Sổ', ledger);
    kpiStrip(sheet, 5, ledger.length, [
      { label: 'Số dư đầu kỳ', value: 0 },
      { label: 'Phát sinh nợ', value: 3_552_864_390 },
      { label: 'Đã thu', value: 3_411_476_230 },
      { label: 'Còn nợ cuối kỳ', value: 141_388_160 },
    ]);
    const ranges = (sheet.model.merges ?? []).filter((range) => range.endsWith('6') && range.includes(':'));
    expect(ranges).toHaveLength(4);
    for (const range of ranges) expect(mergedWidth(sheet, range)).toBeGreaterThanOrEqual(28);
  });
});
