import { describe, expect, it } from 'vitest';
import { buildSummaryWorkbook, type SummaryCustomer } from './summary-workbook';

const figures = (opening: number, freight: number, sales: number, returns: number, receipt: number) => ({ opening, freight, sales, returns, receipt, closing: opening - freight + sales - returns - receipt });
const customers: SummaryCustomer[] = [
  { id: 'a', code: 'KH068', name: 'CÔNG TY TNHH NHÂN VƯỢNG', nameZh: '仁旺', salesRepName: 'Trần Ngọc Kiên', figures: [figures(657_476_200, 0, 101_919_999, 0, 50_000_000), figures(709_396_199, 0, 141_509_980, 91_075_000, 76_000_000)], notes: [[], ['trả lại 7 cái INP6402 (NK2026100033)']] },
  { id: 'b', code: 'KH001', name: 'CÔNG TY TNHH THƯƠNG MẠI CẢNH CƯỜNG', salesRepName: 'Nguyễn Anh Tuấn', figures: [figures(800_000_000, 0, 0, 0, 0), figures(800_000_000, 730_000, 104_394_000, 0, 300_000_000)], notes: [[], []] },
  { id: 'z', code: 'KH099', name: 'Khách không phát sinh', figures: [figures(0, 0, 0, 0, 0), figures(0, 0, 0, 0, 0)], notes: [[], []] },
];

describe('bảng tổng hợp công nợ theo mẫu 收付明细汇总表 (AR-XLS-02)', () => {
  const workbook = buildSummaryWorkbook([{ year: 2026, month: 9 }, { year: 2026, month: 10 }], customers, { includeZero: false });
  const t9 = workbook.getWorksheet('T9-9月')!;
  const t10 = workbook.getWorksheet('T10-10月')!;

  it('mỗi tháng một sheet, tiêu đề và đầu bảng song ngữ nền vàng như sheet T10', () => {
    expect(workbook.worksheets.map((sheet) => sheet.name)).toEqual(['T9-9月', 'T10-10月']);
    expect(t10.getCell('C1').value).toBe('应收账款汇总表');
    expect(String(t10.getCell('C2').value)).toContain('2026  年 10 月31日');
    expect(t10.getCell('E3').value).toBe('2026年9月30日\n余额\nCN dến 30/09/2026\n');
    expect(t10.getCell('J3').value).toBe('10月余额\ncòn nợ cuối tháng 10');
    expect(t10.getCell('A3').fill).toMatchObject({ fgColor: { argb: 'FFFFFF00' } });
    expect(t10.getCell('B4').font).toMatchObject({ name: 'Times New Roman', size: 11 });
    expect(t10.getRow(4).height).toBe(40.5);
  });

  it('sắp theo còn nợ giảm dần, bỏ khách toàn 0, tên Việt + Trung 2 dòng, trả hàng là số âm, J là công thức', () => {
    expect(t10.getCell('B4').value).toBe('KH068');
    expect(t10.getCell('C4').value).toBe('CÔNG TY TNHH NHÂN VƯỢNG\n仁旺');
    expect(t10.getCell('H4').value).toBe(-91_075_000);
    expect(t10.getCell('J4').value).toMatchObject({ formula: 'E4-F4+G4+H4-I4', result: 683_831_179 });
    expect(t10.getCell('K4').value).toBe('trả lại 7 cái INP6402 (NK2026100033)');
    expect(t10.getCell('B6').value).toBeNull();
    expect(t10.getCell('E4').numFmt).toBe('#,##0 ;[Red](#,##0)');
  });

  it('E tháng sau trỏ ô J của chính khách ở sheet trước; dòng 合计 dùng SUBTOTAL', () => {
    expect(t9.getCell('B4').value).toBe('KH001');
    expect(t10.getCell('E4').value).toMatchObject({ formula: "'T9-9月'!J5" });
    expect(t10.getCell('E5').value).toMatchObject({ formula: "'T9-9月'!J4" });
    expect(t10.getCell('C7').value).toBe('合计');
    expect(t10.getCell('J7').value).toMatchObject({ formula: 'SUBTOTAL(9,J4:J5)' });
    expect(t10.autoFilter).toBe('A3:K5');
  });
});
