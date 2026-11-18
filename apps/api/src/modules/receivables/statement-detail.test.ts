import ExcelJS from 'exceljs';
import { ObjectId, type Document } from 'mongodb';
import { describe, expect, it } from 'vitest';
import type { LedgerRow } from './ledger';
import Decimal from 'decimal.js';
import { buildStatementDetailLines, roundToTotal } from './statement-detail';
import { buildStatementDetailWorkbook, safeSheetName, STATEMENT_DETAIL_HEADERS } from './statement-detail-workbook';

const zero = '0.00';
const row = (kind: LedgerRow['kind'], refId: string, date: string, amounts: Partial<Pick<LedgerRow, 'debit' | 'receipt' | 'freight' | 'returns'>>, extra: Partial<LedgerRow> = {}): LedgerRow => ({
  date: `${date}T03:00:00.000Z`, kind, refId, code: refId, documentNo: refId, description: `${kind} ${refId}`,
  debit: zero, receipt: zero, freight: zero, returns: zero, balance: zero, ...amounts, ...extra,
});

const orderId = new ObjectId().toHexString();
const order1Id = new ObjectId().toHexString();
const ids = { bh: new ObjectId().toHexString(), bh1: new ObjectId().toHexString(), hist: new ObjectId().toHexString(), hist2: new ObjectId().toHexString(), pay: new ObjectId().toHexString(), fr: new ObjectId().toHexString(), ret: new ObjectId().toHexString(), disc: new ObjectId().toHexString() };
const returnId = new ObjectId();

// Phiếu PXK-002 (thuế từng dòng) có dòng tặng; phiếu PXK-001 (thuế cả phiếu) chia thuế về dòng.
const orders = new Map<string, Document>([
  [orderId, {
    code: 'BH2026110201', templateCode: 'PXK-002', taxRate: '8',
    lines: [
      { sku: 'INP6004', productName: 'Nồi cơm điện cơ 1.2 L xanh', unit: 'Cái', quantity: '30', unitPrice: '537037.04', netAmount: '16111111.00', lineTotal: '16111111.00', vatRate: '8', taxAmount: '1288889.00' },
      { sku: 'INP6005', productName: 'Nồi cơm điện cơ 1.8 L xanh', unit: 'Cái', quantity: '2', unitPrice: '0', netAmount: '0', lineTotal: '0', gift: true, zeroPriceKind: 'GIFT', vatRate: '8', taxAmount: '0' },
    ],
  }],
  [order1Id, {
    code: 'BH2026100143', templateCode: 'PXK-001', taxRate: '8',
    lines: [
      { sku: 'INP1003', productName: 'Bộ nồi Inox', unit: 'Cái', quantity: '40', unitPrice: '324074.07', netAmount: '12962962.80', lineTotal: '12962962.80' },
      { sku: 'INP6403', productName: 'Quạt điện đứng', unit: 'Cái', quantity: '1', unitPrice: '0', netAmount: '0', lineTotal: '0', gift: true, zeroPriceKind: 'EXCHANGE' },
    ],
  }],
]);
const receivables = new Map<string, Document>([
  [ids.bh, { salesOrderId: new ObjectId(orderId), salesOrderCode: 'BH2026110201' }],
  [ids.bh1, { salesOrderId: new ObjectId(order1Id), salesOrderCode: 'BH2026100143' }],
  [ids.hist, {
    sourceType: 'HISTORY_IMPORT', historyDocumentNo: '00000024', historyInvoiceNo: '0024', note: 'Xuất bán Công ty TNHH Nhân Vượng向 仁旺销售产品',
    historyLines: [
      { sku: 'INP1003', productName: 'Bộ nồi Inox INP1003', quantity: '56', unitPrice: '314814.82', amount: '19040000.31' },
      { sku: 'INP2301', productName: 'Chảo rán INP2301', quantity: '20', unitPrice: '416666.65', amount: '8999999.64' },
    ],
  }],
  [ids.hist2, { sourceType: 'HISTORY_IMPORT', historyDocumentNo: 'NO-LINES', note: 'Xuất bán (không có dòng hàng)' }],
]);
const payments = new Map<string, Document>([
  [ids.pay, { code: 'PT2026110001', kind: 'RECEIPT', method: 'BANK_TRANSFER', reference: 'FT123' }],
  [ids.fr, { code: 'PT2026110002', kind: 'FREIGHT', note: 'Khách tự đến kho lấy hàng đơn BH2026100143' }],
  [ids.ret, {
    code: 'GN0001', kind: 'RETURN', stockReturnId: returnId,
    historyLines: [{ sku: 'INP6407', productName: 'Quạt tích điện', unit: 'Cái', quantity: '36', unitPrice: '250000', amount: '9000000', netUnitPrice: '231481.48', vatRate: '8', netAmount: '8333333.28', taxAmount: '666666.72' }],
  }],
  [ids.disc, { code: 'GN0002', kind: 'RETURN', note: 'Giảm giá 1%' }],
]);

const rows: LedgerRow[] = [
  row('DEBIT', ids.hist, '2026-01-14', { debit: '28039999.95' }, { sourceType: 'HISTORY_IMPORT' }),
  row('DEBIT', ids.hist2, '2026-01-20', { debit: '5000000.00' }, { sourceType: 'HISTORY_IMPORT' }),
  row('DEBIT', ids.bh1, '2026-10-20', { debit: '14000000.00' }, { salesOrderId: order1Id }),
  row('FREIGHT', ids.fr, '2026-10-20', { freight: '1500000.00' }),
  row('RETURN', ids.ret, '2026-10-21', { returns: '9000000.00' }),
  row('RETURN', ids.disc, '2026-10-22', { returns: '200000.00' }),
  row('RECEIPT', ids.pay, '2026-11-02', { receipt: '60000000.00' }),
  // Công nợ đã sửa trên sổ: 17.500.000 thay vì 17.400.000 của dòng hàng → dòng điều chỉnh +100.000.
  row('DEBIT', ids.bh, '2026-11-16', { debit: '17500000.00' }, { salesOrderId: orderId }),
];
const sources = { partner: { name: 'CÔNG TY TNHH NHÂN VƯỢNG', nameZh: '仁旺' }, receivables, payments, orders, returnCodes: new Map([[returnId.toHexString(), 'NK2026100035']]) };

describe('sổ công nợ khách theo dòng hàng (AR-XLS-03)', () => {
  const { lines, vatRates } = buildStatementDetailLines(rows, sources);
  const of = (documentNo: string) => lines.filter((line) => line.documentNo === documentNo);
  const sumP = (items: typeof lines) => Math.round(items.reduce((sum, line) => sum + (line.amount ?? 0), 0) * 100) / 100;

  it('phiếu BH: mỗi dòng hàng một dòng, có mã / ĐVT / SL / đơn giá / thuế; hàng tặng / đổi giá 0 có nhãn song ngữ', () => {
    const bh = of('BH2026110201');
    expect(bh[0]).toMatchObject({ date: '2026-11-16', sku: 'INP6004', name: 'Nồi cơm điện cơ 1.2 L xanh', unit: 'Cái', quantity: 30, unitPrice: 537037.04, net: 16111111, tax: 1288889, amount: 17400000, description: 'Xuất bán CÔNG TY TNHH NHÂN VƯỢNG 向仁旺销售产品' });
    expect(bh[1]).toMatchObject({ sku: 'INP6005', quantity: 2, unitPrice: 0, amount: 0, description: 'Hàng tặng 赠品' });
    expect(of('BH2026100143')[1]).toMatchObject({ description: 'Hàng đổi 换货', amount: 0 });
    expect(vatRates).toEqual(new Set(['8']));
  });

  it('PXK-001: thuế cả phiếu chia về dòng, tổng P = công nợ chứng từ (không cần dòng điều chỉnh)', () => {
    const bh = of('BH2026100143');
    expect(bh).toHaveLength(2);
    expect(bh[0]).toMatchObject({ unitPrice: 324074.07, net: 12962963, tax: 1037037, amount: 14000000 });
    expect(sumP(bh)).toBe(14000000);
  });

  it('công nợ khác dòng hàng (sửa trên sổ) → thêm dòng điều chỉnh bằng phần chênh', () => {
    const bh = of('BH2026110201');
    expect(bh.at(-1)).toMatchObject({ amount: 100000, description: expect.stringContaining('Điều chỉnh công nợ') });
    expect(sumP(bh)).toBe(17500000);
  });

  it('sổ cũ: số chứng từ, số HĐ, diễn giải gốc, N = SL × đơn giá, O = P − N; không có dòng hàng → một dòng', () => {
    const history = of('00000024');
    expect(history[0]).toMatchObject({ invoiceNo: '0024', description: 'Xuất bán Công ty TNHH Nhân Vượng向 仁旺销售产品', quantity: 56, unitPrice: 314814.82, net: 17629629.92, tax: 1410370.39, amount: 19040000.31 });
    expect(sumP(history)).toBe(28039999.95);
    expect(of('NO-LINES')).toEqual([expect.objectContaining({ amount: 5000000, description: 'Xuất bán (không có dòng hàng)' })]);
  });

  it('trả hàng: số lượng và tiền âm, mã phiếu trả hàng; giảm giá không có dòng hàng → một dòng P âm', () => {
    expect(of('NK2026100035')).toEqual([expect.objectContaining({ description: 'Trả lại hàng bán 退货 (NK2026100035)', sku: 'INP6407', quantity: -36, unitPrice: 231481.48, net: -8333333.28, tax: -666666.72, amount: -9000000 })]);
    expect(of('GN0002')).toEqual([expect.objectContaining({ amount: -200000, description: 'Giảm trừ công nợ 减免 — Giảm giá 1%' })]);
  });

  it('thu tiền vào Q, phí vận chuyển khách trả vào R', () => {
    expect(of('PT2026110001')).toEqual([expect.objectContaining({ paid: 60000000, description: 'Thu tiền khách hàng Chuyển khoản ngân hàng 货款通过银行转账 — FT123' })]);
    expect(of('PT2026110002')).toEqual([expect.objectContaining({ freight: 1500000, description: expect.stringContaining('Phí vận chuyển khách trả 运费') })]);
  });

  it('làm tròn thành tiền dòng cho đúng tổng phiếu (phần lẻ lớn nhất trước)', () => {
    const values = ['16111111.20', '8611111.05', '9299999.93'].map((value) => new Decimal(value));
    expect(roundToTotal(values, new Decimal('34022222')).map(String)).toEqual(['16111111', '8611111', '9300000']);
    expect(roundToTotal([new Decimal('0'), new Decimal('10.6')], new Decimal('11')).map(String)).toEqual(['0', '11']);
  });

  it('có lọc kỳ: dòng đầu là số dư đầu kỳ', () => {
    const withOpening = buildStatementDetailLines(rows.slice(2), sources, { date: '2026-10-01', amount: '33039999.95' }).lines;
    expect(withOpening[0]).toMatchObject({ date: '2026-10-01', description: 'Số dư đầu kỳ 期初余额', amount: 33039999.95 });
  });

  it('workbook giống mẫu: 18 cột song ngữ, cố định hàng 1, hàng Tổng cộng, khối (1)–(6); (4) = phát sinh − thu − phí VC', async () => {
    const workbook = buildStatementDetailWorkbook({ customer: { code: 'KH068', name: 'CÔNG TY TNHH NHÂN VƯỢNG', nameZh: '仁旺' }, sheetName: 'NPP Nhân Vượng', lines, vatPercent: '8', segments: [{ name: 'Quạt + vợt muỗi', amount: 1_000_000 }] });
    // Ghi ra rồi đọc lại như người dùng mở file.
    const reread = new ExcelJS.Workbook();
    await reread.xlsx.load(await workbook.xlsx.writeBuffer() as unknown as ArrayBuffer);
    const sheet = reread.getWorksheet('NPP Nhân Vượng')!;
    expect(STATEMENT_DETAIL_HEADERS('8')).toHaveLength(18);
    expect(sheet.getCell('A1').value).toBe('mã khách hàng\n客户编号');
    expect(sheet.getCell('I1').value).toBe('Mã Hàng\n型号');
    expect(sheet.getCell('O1').value).toBe('Thuế GTGT (8%)\n税额');
    expect(sheet.getCell('R1').value).toBe('phí vận chuyển\n运费');
    expect(sheet.views[0]).toMatchObject({ state: 'frozen', ySplit: 1 });
    expect(sheet.getCell('A2').value).toBe('KH068');
    expect(sheet.getCell('B2').value).toBe('CÔNG TY TNHH NHÂN VƯỢNG（仁旺）');
    expect(sheet.getCell('A2').font).toMatchObject({ name: 'Times New Roman', bold: true });
    const total = 2 + lines.length;
    const p = sumP(lines);
    expect(sheet.getCell(`P${total}`).value).toMatchObject({ formula: `SUM(P2:P${total - 1})`, result: p });
    expect(sheet.getCell(`Q${total}`).value).toMatchObject({ result: 60000000 });
    expect(sheet.getCell(`R${total}`).value).toMatchObject({ result: 1500000 });
    // Hàng Tổng cộng (17/11/2026): nhãn gộp A–H, cộng cả số lượng, tiền chưa thuế, thuế; đơn giá không cộng.
    const sumKey = (key: 'quantity' | 'net' | 'tax') => Math.round(lines.reduce((sum, line) => sum + (line[key] ?? 0), 0) * 100) / 100;
    expect(sheet.getCell(`A${total}`).value).toBe('Tổng cộng 合计');
    expect(sheet.getCell(`H${total}`).isMerged).toBe(true);
    expect(sheet.getCell(`L${total}`).value).toMatchObject({ formula: `SUM(L2:L${total - 1})`, result: sumKey('quantity') });
    expect(sheet.getCell(`N${total}`).value).toMatchObject({ formula: `SUM(N2:N${total - 1})`, result: sumKey('net') });
    expect(sheet.getCell(`O${total}`).value).toMatchObject({ formula: `SUM(O2:O${total - 1})`, result: sumKey('tax') });
    expect(sheet.getCell(`M${total}`).value).toBeNull();
    expect(sheet.getCell(`N${total}`).fill).toMatchObject({ fgColor: { theme: 4 } });
    const start = total + 3;
    expect(sheet.getCell(`H${start}`).value).toBe('Tổng công nợ (1)');
    expect(sheet.getCell(`H${start + 3}`).value).toBe('còn lại (4)=(1)-(2)-(3)');
    expect(sheet.getCell(`I${start + 3}`).value).toMatchObject({ formula: `I${start}-I${start + 1}-I${start + 2}`, result: Math.round((p - 60000000 - 1500000) * 100) / 100 });
    expect(sheet.getCell(`H${start + 4}`).value).toBe('Công nợ Quạt + vợt muỗi (5)');
    expect(sheet.getCell(`I${start + 5}`).value).toMatchObject({ formula: `I${start + 3}-I${start + 4}` });
    expect(sheet.getCell(`I${start + 5}`).fill).toMatchObject({ fgColor: { argb: 'FFFFFF00' } });
  });

  it('không có nhóm → bỏ (5), (6); tên sheet hợp lệ', () => {
    const workbook = buildStatementDetailWorkbook({ customer: { code: 'KH1', name: 'A' }, sheetName: 'A/B:C*?', lines: [], segments: null });
    const sheet = workbook.worksheets[0]!;
    expect(sheet.name).toBe('A B C');
    expect(sheet.getCell('H6').value).toBe('Tổng công nợ (1)');
    expect(sheet.getCell('H9').value).toBe('còn lại (4)=(1)-(2)-(3)');
    expect(sheet.getCell('H10').value).toBeNull();
    expect(safeSheetName('x'.repeat(40))).toHaveLength(31);
  });
});
