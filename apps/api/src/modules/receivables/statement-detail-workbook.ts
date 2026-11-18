import ExcelJS from 'exceljs';

/**
 * Sổ công nợ của một khách theo mẫu kế toán `CN NPP Thế Tài 16.11.xlsx` (AR-XLS-03, 16/11/2026):
 * - một sheet, mỗi dòng hàng của mỗi chứng từ là một dòng; 18 cột A–R, đầu bảng song ngữ nền xanh nhạt, cố định hàng 1;
 * - P "thành tiền" (gồm thuế) là phát sinh nợ: bán hàng dương, trả hàng / giảm nợ âm; Q đã thanh toán; R phí vận chuyển khách trả;
 * - hàng Tổng cộng (17/11/2026): SUM số lượng L, tiền chưa thuế N, thuế O, P, Q, R; khối tổng (1) Tổng công nợ · (2) Đã thanh toán · (3) Phí vận chuyển · (4) = (1) − (2) − (3)
 *   · (5) công nợ nhóm tách riêng (mẫu: "quạt + vợt muỗi") · (6) = (4) − (5).
 * Dựng sẵn số liệu ở receivables.service (statementWorkbook); file này chỉ trình bày.
 */

export interface StatementDetailLine {
  /** C — ngày ghi sổ công nợ (YYYY-MM-DD, giờ Việt Nam). */
  date?: string | undefined;
  /** D — số chứng từ (số BH, mã phiếu trả hàng, mã phiếu thu, số chứng từ sổ cũ). */
  documentNo?: string | undefined;
  /** E — ngày xuất hóa đơn (chỉ dòng sổ cũ có). */
  invoiceDate?: string | undefined;
  /** F — số chứng từ mới. */
  newDocumentNo?: string | undefined;
  /** G — số hóa đơn. */
  invoiceNo?: string | undefined;
  /** H — diễn giải. */
  description: string;
  sku?: string | undefined;
  name?: string | undefined;
  unit?: string | undefined;
  quantity?: number | undefined;
  /** M — đơn giá chưa thuế. */
  unitPrice?: number | undefined;
  /** N — thành tiền chưa thuế. */
  net?: number | undefined;
  /** O — tiền thuế GTGT. */
  tax?: number | undefined;
  /** P — thành tiền gồm thuế (phát sinh nợ; âm = giảm nợ). */
  amount?: number | undefined;
  /** Q — đã thanh toán. */
  paid?: number | undefined;
  /** R — phí vận chuyển khách trả (trừ nợ). */
  freight?: number | undefined;
}

export interface StatementDetailInput {
  customer: { code: string; name: string; nameZh?: string | undefined };
  sheetName: string;
  lines: readonly StatementDetailLine[];
  /** Thuế suất chung của các dòng có thuế (VD "8") — tiêu đề cột O "Thuế GTGT (8%)"; nhiều thuế suất thì để trống. */
  vatPercent?: string | undefined;
  /** Nhóm công nợ tách riêng còn nợ (hiện tại) — null = không in (5), (6) (kỳ xuất chưa tới hôm nay). */
  segments: ReadonlyArray<{ name: string; amount: number }> | null;
}

const FONT = 'Times New Roman';
const MONEY = '#,##0 [$₫-42A];[Red]-#,##0 [$₫-42A]';
const PRICE = '#,##0.00;[Red]-#,##0.00';
const DATE = 'yyyy-mm-dd;@';
const THIN = { style: 'thin' as const, color: { indexed: 64 } as unknown as Partial<ExcelJS.Color> };
const MEDIUM = { style: 'medium' as const, color: { indexed: 64 } as unknown as Partial<ExcelJS.Color> };
const BORDER: Partial<ExcelJS.Borders> = { top: THIN, left: THIN, bottom: THIN, right: THIN };
/** Độ rộng cột A–R như file mẫu. */
const WIDTHS = [9.140625, 33.28515625, 13.7109375, 16, 13.7109375, 13.5703125, 9.140625, 35.85546875, 17.28515625, 48.140625, 9.140625, 9.28515625, 12.140625, 14, 15, 15, 13.5703125, 12.5703125];
const HEADER_FILL: ExcelJS.Fill = { type: 'pattern', pattern: 'solid', fgColor: { theme: 4, tint: 0.5999938962981048 } as unknown as Partial<ExcelJS.Color> };

export const STATEMENT_DETAIL_HEADERS = (vatPercent?: string) => [
  'mã khách hàng\n客户编号', 'Tên Khách Hàng(中文)', 'Ngày tháng ghi sổ\n订单日期', 'số chứng từ\n订单编号', 'ngày xuất HĐ\n发票日期', 'số chứng từ mới\n发票订单号',
  'số hóa đơn\n发票号', 'diễn giải\n摘要', 'Mã Hàng\n型号', 'Tên Hàng\n产品规格', 'ĐVT\n单位', 'số lượng\n数量', 'Đơn Giá\n单价', 'Thành tiền chưa thuế\n不含税金额',
  `Thuế GTGT${vatPercent ? ` (${vatPercent}%)` : ''}\n税额`, 'thành tiền\n含税金额', 'Đã thanh toán\n（收款）', 'phí vận chuyển\n运费',
];

const round2 = (value: number) => Math.round(value * 100) / 100;
type SummedKey = 'quantity' | 'net' | 'tax' | 'amount' | 'paid' | 'freight';
const sumOf = (lines: readonly StatementDetailLine[], key: SummedKey) => round2(lines.reduce((total, line) => total + (line[key] ?? 0), 0));
/** Cột có tổng ở hàng Tổng cộng (17/11/2026, kế toán: "thêm hàng tổng cộng có tổng các cột") — đơn giá (M) không cộng. */
const SUMMED: ReadonlyArray<{ column: string; key: SummedKey }> = [
  { column: 'L', key: 'quantity' }, { column: 'N', key: 'net' }, { column: 'O', key: 'tax' },
  { column: 'P', key: 'amount' }, { column: 'Q', key: 'paid' }, { column: 'R', key: 'freight' },
];
/** Ngày YYYY-MM-DD → ô ngày của Excel (nửa đêm UTC = đúng ngày, không lệch múi giờ). */
const excelDate = (value: string | undefined) => (value && /^\d{4}-\d{2}-\d{2}$/.test(value) ? new Date(`${value}T00:00:00Z`) : value ?? null);
const quantityFormat = (value: number) => (Number.isInteger(value) ? '#,##0;[Red]-#,##0' : '#,##0.00##;[Red]-#,##0.00##');

/** Tên sheet hợp lệ của Excel: bỏ ký tự cấm, tối đa 31 ký tự. */
export function safeSheetName(value: string): string {
  const cleaned = value.replace(/[\\/?*[\]:]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 31).replace(/^'+|'+$/g, '');
  return cleaned || 'Công nợ';
}

export function buildStatementDetailWorkbook(input: StatementDetailInput): ExcelJS.Workbook {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'INOXPRAN ERP';
  workbook.company = 'INOXPRAN';
  workbook.created = new Date();
  // Ô công thức kết quả 0 không được lưu số tính sẵn → Excel tính lại toàn bộ khi mở file.
  workbook.calcProperties = { fullCalcOnLoad: true };
  const sheet = workbook.addWorksheet(safeSheetName(input.sheetName), {
    views: [{ state: 'frozen', xSplit: 0, ySplit: 1, activeCell: 'A2' }],
    pageSetup: { paperSize: 9, orientation: 'landscape', fitToPage: true, fitToWidth: 1, fitToHeight: 0, margins: { left: 0.7, right: 0.7, top: 0.75, bottom: 0.75, header: 0.3, footer: 0.3 } },
  });
  WIDTHS.forEach((width, column) => { sheet.getColumn(column + 1).width = width; });
  const style = (cell: ExcelJS.Cell, options: { bold?: boolean; wrap?: boolean; numFmt?: string; border?: Partial<ExcelJS.Borders> } = {}) => {
    cell.font = { name: FONT, size: 11, family: 1, ...(options.bold ? { bold: true } : {}) };
    cell.alignment = { horizontal: 'left', vertical: 'middle', ...(options.wrap ? { wrapText: true } : {}) };
    cell.border = options.border ?? BORDER;
    if (options.numFmt) cell.numFmt = options.numFmt;
  };

  // Hàng 1: đầu bảng song ngữ.
  const header = sheet.getRow(1);
  header.height = 45;
  STATEMENT_DETAIL_HEADERS(input.vatPercent).forEach((text, column) => {
    const cell = header.getCell(column + 1);
    cell.value = text;
    style(cell, { bold: true, wrap: true });
    cell.fill = HEADER_FILL;
  });

  const customerName = input.customer.nameZh ? `${input.customer.name}（${input.customer.nameZh}）` : input.customer.name;
  input.lines.forEach((line, index) => {
    const row = sheet.getRow(2 + index);
    const values: Array<[ExcelJS.CellValue, { bold?: boolean; wrap?: boolean; numFmt?: string }]> = [
      [input.customer.code, { bold: true }],
      [customerName, {}],
      [excelDate(line.date), { numFmt: DATE }],
      [line.documentNo ?? null, {}],
      [excelDate(line.invoiceDate), { numFmt: DATE }],
      [line.newDocumentNo ?? null, {}],
      [line.invoiceNo ?? null, {}],
      [line.description, { wrap: true }],
      [line.sku ?? null, {}],
      [line.name ?? null, { wrap: true }],
      [line.unit ?? null, {}],
      [line.quantity ?? null, line.quantity === undefined ? {} : { numFmt: quantityFormat(line.quantity) }],
      [line.unitPrice ?? null, { numFmt: PRICE }],
      [line.net ?? null, { numFmt: MONEY }],
      [line.tax ?? null, { numFmt: MONEY }],
      [line.amount ?? null, { numFmt: MONEY }],
      [line.paid ?? null, { numFmt: MONEY }],
      [line.freight ?? null, { numFmt: MONEY }],
    ];
    values.forEach(([value, options], column) => {
      const cell = row.getCell(column + 1);
      cell.value = value;
      style(cell, options);
    });
  });

  // Hàng Tổng cộng ngay dưới bảng: nhãn ở A–H (gộp ô), SUM số lượng · tiền chưa thuế · thuế · thành tiền · đã thanh toán · phí VC.
  const first = 2;
  const last = Math.max(first, 1 + input.lines.length);
  const totalAt = last + 1;
  const totalRow = sheet.getRow(totalAt);
  for (let column = 1; column <= WIDTHS.length; column += 1) {
    const cell = totalRow.getCell(column);
    style(cell, { bold: true });
    cell.fill = HEADER_FILL;
  }
  sheet.mergeCells(`A${totalAt}:H${totalAt}`);
  const label = sheet.getCell(`A${totalAt}`);
  label.value = 'Tổng cộng 合计';
  label.alignment = { horizontal: 'right', vertical: 'middle' };
  const sums = Object.fromEntries(SUMMED.map(({ column, key }) => [column, sumOf(input.lines, key)])) as Record<string, number>;
  for (const { column } of SUMMED) {
    const cell = sheet.getCell(`${column}${totalAt}`);
    const result = sums[column] ?? 0;
    cell.value = { formula: `SUM(${column}${first}:${column}${last})`, result };
    cell.numFmt = column === 'L' ? quantityFormat(result) : MONEY;
  }
  const totals = { P: sums.P ?? 0, Q: sums.Q ?? 0, R: sums.R ?? 0 };

  // Khối tổng ở H:I, cách hai dòng (mẫu: H185:I190), viền ngoài đậm.
  const groups = (input.segments ?? []).filter((segment) => Math.abs(segment.amount) >= 0.005);
  const remaining = round2(totals.P - totals.Q - totals.R);
  const start = totalAt + 3;
  const summary: Array<{ label: string; value: ExcelJS.CellValue; numFmt?: string; highlight?: boolean }> = [
    { label: 'Tổng công nợ (1)', value: { formula: `P${totalAt}`, result: totals.P } },
    { label: 'Đã thanh toán (2)', value: { formula: `Q${totalAt}`, result: totals.Q } },
    { label: 'Phí vận chuyển (3)', value: { formula: `R${totalAt}`, result: totals.R } },
    { label: 'còn lại (4)=(1)-(2)-(3)', value: { formula: `I${start}-I${start + 1}-I${start + 2}`, result: remaining } },
  ];
  if (groups.length) {
    const names = groups.map((segment) => segment.name).join(' + ');
    const labelOf = (index: number) => (groups.length === 1 ? '(5)' : `(5${String.fromCharCode(97 + index)})`);
    groups.forEach((segment, index) => summary.push({ label: `Công nợ ${segment.name} ${labelOf(index)}`, value: round2(segment.amount) }));
    const segmentRows = groups.map((_, index) => `I${start + 4 + index}`).join('-');
    const segmentTotal = round2(groups.reduce((total, segment) => total + segment.amount, 0));
    summary.push({
      label: `còn lại công nợ (trừ ${names})\n(6)=(4)-${groups.length === 1 ? '(5)' : groups.map((_, index) => labelOf(index)).join('-')}`,
      value: { formula: `I${start + 3}-${segmentRows}`, result: round2(remaining - segmentTotal) },
      highlight: true,
    });
  }
  summary.forEach((item, index) => {
    const row = sheet.getRow(start + index);
    const top = index === 0 ? MEDIUM : THIN;
    const bottom = index === summary.length - 1 ? MEDIUM : THIN;
    const label = row.getCell('H');
    label.value = item.label;
    style(label, { bold: true, wrap: item.label.includes('\n'), border: { top, bottom, left: MEDIUM, right: THIN } });
    const value = row.getCell('I');
    value.value = item.value;
    style(value, { bold: true, numFmt: MONEY, border: { top, bottom, left: THIN, right: MEDIUM } });
    if (item.highlight) {
      value.font = { name: FONT, size: 11, family: 1, bold: true, color: { argb: 'FFFF0000' } };
      value.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFFFF00' } };
      row.height = 32.25;
    }
  });
  return workbook;
}
