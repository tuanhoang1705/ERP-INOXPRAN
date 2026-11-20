import type ExcelJS from 'exceljs';
import { describe, expect, it } from 'vitest';
import { addBodyRow, brandSheet, brandWorkbook, kpiStrip, lineCount, noteRow, signatureBlock, tableHeader, textWidth, titleBlock, totalRow, type BrandColumn } from './excel-brand';

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

describe('song ngữ Việt + Trung (XLS-BI-01) — chỉ sheet bật bilingual', () => {
  const richText = (value: ExcelJS.CellValue) => (value as ExcelJS.CellRichTextValue).richText.map((part) => part.text).join('');

  it('độ rộng chữ: chữ Hán / dấu câu toàn khổ gấp đôi chữ Latinh; số dòng tính cả dấu xuống dòng', () => {
    expect(textWidth('Mã KH')).toBe(5);
    expect(textWidth('客户编号（越南盾）')).toBe(18);
    expect(lineCount('Mã KH\n客户编号', 10)).toBe(2);
    expect(lineCount('客户编号客户编号', 10)).toBe(2);
    expect(lineCount('', 10)).toBe(1);
    // Ngắt ở khoảng trắng như Excel: "Hộ Kinh Doanh Đào Thị Quỳnh Hoa" (31 ký tự) cần 2 dòng ở cột rộng 30.
    expect(lineCount('Hộ Kinh Doanh Đào Thị Quỳnh Hoa', 30)).toBe(2);
    expect(lineCount('BH2026080991 (trước ERP · ERP 之前)', 18)).toBe(3);
    // Từ dài hơn cả ô thì bị cắt giữa từ.
    expect(lineCount('NK2026110001NK2026110002', 10)).toBe(3);
  });

  it('dòng tổng: nhãn tràn sang ô trống bên phải; ô kế bên có số thì nhãn xuống dòng trong ô, dòng cao theo số dòng', () => {
    const sheet = brandSheet(brandWorkbook(), 'Tháng', ledger, { bilingual: true });
    const columns: BrandColumn[] = [{ key: 'month', header: 'Tháng\n月份', width: 14, type: 'code' }, { key: 'note', header: 'Ghi chú\n备注', width: 30 }, { key: 'sales', header: 'Doanh số\n销售额', width: 18, type: 'money' }];
    const wrapped = totalRow(sheet, columns, { month: 'CỘNG 6 THÁNG 6 个月合计', note: 1, sales: 100 });
    expect(wrapped.getCell(1).alignment?.wrapText).toBe(true);
    // Chữ đậm hoa ở cột rộng 14: "CỘNG 6" / "THÁNG 6 个月" / "合计" → 3 dòng.
    expect(wrapped.height).toBe(50);
    const overflow = totalRow(sheet, columns, { month: 'CỘNG 6 THÁNG 6 个月合计', sales: 100 });
    expect(overflow.getCell(1).alignment?.wrapText).toBeUndefined();
    expect(overflow.height).toBe(24);
  });

  it('tiêu đề, dòng thông tin, nhãn chỉ số, đầu cột, ghi chú: dòng Việt rồi dòng Trung, dòng đủ cao để không bị cắt', () => {
    const sheet = brandSheet(brandWorkbook(), 'Sổ 台账', ledger, { bilingual: true });
    expect(sheet.headerFooter.oddFooter).toContain('Trang 页 &P/&N');
    const next = titleBlock(sheet, ledger.length, { vi: 'Sổ công nợ', zh: '应收台账' }, [{ vi: 'Người lập: A', zh: '制表人：A' }, '']);
    expect(richText(sheet.getCell('A1').value)).toBe('CÔNG TY TNHH ĐẦU TƯ THẮNG VƯỢNG — INOXPRAN  胜旺投资有限责任公司');
    expect(richText(sheet.getCell('A2').value)).toBe('SỔ CÔNG NỢ\n应收台账');
    expect(sheet.getRow(2).height).toBe(50);
    expect(sheet.getCell('A3').value).toBe('Người lập: A\n制表人：A');
    expect(sheet.getRow(3).height).toBe(31);
    // Dòng thông tin trống bị bỏ: bảng bắt đầu sau một dòng trống.
    expect(next).toBe(5);
    const header = kpiStrip(sheet, next, ledger.length, [{ label: { vi: 'ĐÃ THU', zh: '已收款' }, value: 1 }]);
    expect(sheet.getCell(`A${next}`).value).toBe('ĐÃ THU\n已收款');
    expect(sheet.getRow(next).height).toBe(29);
    // Cột rộng 12: "Phát sinh nợ (đ)" 2 dòng + "本期应收（越南盾）" 2 dòng.
    tableHeader(sheet, header, [{ key: 'a', header: 'Phát sinh nợ (đ)\n本期应收（越南盾）', width: 12 }]);
    expect(sheet.getRow(header).height).toBe(62);
    noteRow(sheet, ledger.length, { vi: 'Ghi chú', zh: '备注' });
    expect(sheet.lastRow!.getCell(1).value).toBe('Ghi chú\n备注');
    expect(sheet.lastRow!.height).toBe(30);
    signatureBlock(sheet, ledger.length, 'A');
    const texts: string[] = [];
    sheet.eachRow((row) => row.eachCell((cell) => { if (typeof cell.value === 'string') texts.push(cell.value); }));
    expect(texts).toContain('Kế toán trưởng 会计主管');
    expect(texts).toContain('(Ký, ghi rõ họ tên · 签字并注明姓名)');
  });

  it('sheet không bật song ngữ (VD file mẫu nhập dữ liệu) giữ đúng cách trình bày cũ', () => {
    const sheet = brandSheet(brandWorkbook(), 'HUONG_DAN', ledger);
    expect(sheet.headerFooter.oddFooter).toBe('&L&8INOXPRAN ERP&C&8Trang &P/&N&R&8&D &T');
    const next = titleBlock(sheet, ledger.length, 'File nhập dữ liệu', ['Cách dùng: điền từ dòng 2']);
    expect(sheet.getCell('A1').value).toBe('CÔNG TY TNHH ĐẦU TƯ THẮNG VƯỢNG — INOXPRAN');
    expect(sheet.getRow(1).height).toBe(20);
    expect(sheet.getCell('A2').value).toBe('FILE NHẬP DỮ LIỆU');
    expect(sheet.getRow(2).height).toBe(30);
    expect(sheet.getRow(3).height).toBe(17);
    tableHeader(sheet, next, [{ key: 'a', header: 'Phát sinh nợ (đ)', width: 12 }]);
    expect(sheet.getRow(next).height).toBe(32);
    // Cách tính chiều cao cũ: số ký tự ÷ (độ rộng × 1,1).
    const body = addBodyRow(sheet, [{ key: 'note', header: 'Ghi chú', width: 10, wrap: true }], { note: 'x'.repeat(23) }, 0);
    expect(body.height).toBe(49);
    const total = totalRow(sheet, [{ key: 'month', header: 'Tháng', width: 5 }, { key: 'sales', header: 'Doanh số', width: 18, type: 'money' }], { month: 'TỔNG CỘNG', sales: 1 });
    expect(total.getCell(1).alignment?.wrapText).toBeUndefined();
    expect(total.height).toBe(24);
    noteRow(sheet, ledger.length, 'Ghi chú '.repeat(60));
    expect(sheet.lastRow!.height).toBe(28);
    signatureBlock(sheet, ledger.length, 'A');
    const texts: string[] = [];
    sheet.eachRow((row) => row.eachCell((cell) => { if (typeof cell.value === 'string') texts.push(cell.value); }));
    expect(texts).toContain('Kế toán trưởng');
    expect(texts).toContain('(Ký, ghi rõ họ tên)');
    expect(texts.some((text) => /[\u4E00-\u9FFF]/.test(text))).toBe(false);
  });
});
