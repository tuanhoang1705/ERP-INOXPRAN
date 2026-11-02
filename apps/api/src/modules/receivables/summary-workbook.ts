import ExcelJS from 'exceljs';

/**
 * Bảng tổng hợp công nợ khách theo tháng giống hệt mẫu `收付明细汇总表.xlsx` của kế toán (AR-XLS-02, 31/10/2026) — theo sheet
 * mới nhất `T10-10月`: mỗi tháng một sheet `T{m}-{m}月`, tiêu đề 应收账款汇总表, đầu bảng song ngữ nền vàng, Times New Roman 11,
 * viền mảnh, số `#,##0 ;[Red](#,##0)`, sắp theo còn nợ cuối tháng giảm dần, dòng 合计 dùng SUBTOTAL.
 *   E đầu kỳ: sheet đầu là số; các sheet sau là công thức trỏ cột J của chính khách đó ở sheet tháng trước (như mẫu).
 *   J cuối kỳ = E − F + G + H − I (F phí vận chuyển khách trả hộ trừ nợ, H trả hàng là số âm).
 * Bỏ sheet 应付账款总明细 (phải trả nhà cung cấp — không thuộc công nợ khách).
 */

export interface SummaryFigures {
  /** Còn nợ đầu tháng. */
  opening: number;
  freight: number;
  /** Bán hàng (phát sinh nợ) trong tháng. */
  sales: number;
  /** Trả hàng / điều chỉnh giảm trong tháng (số dương; in ra cột H là số âm). */
  returns: number;
  receipt: number;
  closing: number;
}

export interface SummaryCustomer {
  id: string;
  code?: string;
  name: string;
  nameZh?: string;
  salesRepName?: string;
  /** Số liệu theo từng tháng của `months` (cùng thứ tự). */
  figures: SummaryFigures[];
  /** Ghi chú cột 备注 theo từng tháng. */
  notes: string[][];
}

export interface SummaryMonth { year: number; month: number }

const FONT = 'Times New Roman';
const MONEY = '#,##0 ;[Red](#,##0)';
const YELLOW = 'FFFFFF00';
const THIN = { style: 'thin' as const, color: { argb: 'FF000000' } };
const BORDER = { top: THIN, left: THIN, bottom: THIN, right: THIN };
const WIDTHS = [8.875, 12, 51, 16.75, 20.75, 16.625, 16.625, 16.625, 16.625, 16.625, 30];

const lastDay = (year: number, month: number) => new Date(Date.UTC(year, month, 0)).getUTCDate();
const pad = (value: number) => String(value).padStart(2, '0');
export const summarySheetName = ({ month }: SummaryMonth) => `T${month}-${month}月`;
const previousOf = ({ year, month }: SummaryMonth): SummaryMonth => (month === 1 ? { year: year - 1, month: 12 } : { year, month: month - 1 });
const isZero = (figures: SummaryFigures) => [figures.opening, figures.freight, figures.sales, figures.returns, figures.receipt].every((value) => Math.abs(value) < 0.5);

/** `includeZero` = false (chọn tất cả khách): bỏ khách không có số dư đầu kỳ và không phát sinh gì trong tháng. */
export function buildSummaryWorkbook(months: readonly SummaryMonth[], customers: readonly SummaryCustomer[], options: { includeZero: boolean }): ExcelJS.Workbook {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'INOXPRAN ERP';
  workbook.company = 'INOXPRAN';
  workbook.created = new Date();
  /** Dòng của từng khách ở sheet tháng trước — để E tháng sau trỏ đúng ô J. */
  let previousRows = new Map<string, number>();
  months.forEach((period, index) => {
    const sheet = workbook.addWorksheet(summarySheetName(period), {
      views: [{ state: 'frozen', ySplit: 3, activeCell: 'A4' }],
      pageSetup: {
        paperSize: 9, orientation: 'landscape', fitToPage: true, fitToWidth: 1, fitToHeight: 0, horizontalCentered: true,
        margins: { left: 0.17, right: 0.18, top: 0.78, bottom: 0.42, header: 0.3, footer: 0.3 },
      },
    });
    WIDTHS.forEach((width, column) => { sheet.getColumn(column + 1).width = width; });
    const style = (cell: ExcelJS.Cell, extra: Partial<ExcelJS.Style> = {}) => {
      cell.font = { name: FONT, size: 11, ...(extra.font ?? {}) };
      cell.alignment = { horizontal: 'left', vertical: 'middle', ...(extra.alignment ?? {}) };
      cell.border = BORDER;
      if (extra.numFmt) cell.numFmt = extra.numFmt;
      if (extra.fill) cell.fill = extra.fill;
    };

    // Dòng 1–2: tiêu đề và ngày cuối tháng, đơn vị.
    sheet.mergeCells('C1:K1');
    sheet.getCell('C1').value = '应收账款汇总表';
    sheet.getCell('C1').font = { name: FONT, size: 16 };
    sheet.getCell('C1').alignment = { horizontal: 'left', vertical: 'middle' };
    sheet.getRow(1).height = 20.25;
    sheet.mergeCells('C2:K2');
    sheet.getCell('C2').value = `                   ${period.year}  年 ${period.month} 月${lastDay(period.year, period.month)}日                 单位:越南盾`;
    sheet.getCell('C2').font = { name: FONT, size: 10 };
    sheet.getCell('C2').alignment = { horizontal: 'left', vertical: 'middle' };

    // Dòng 3: đầu bảng song ngữ nền vàng.
    const before = previousOf(period);
    const beforeDay = lastDay(before.year, before.month);
    const m = period.month;
    const headers = [
      '序\n号', '客户编号', '客户名称\ntên khách hàng', 'Nhân Viên Bán hàng\n（对应销售）',
      `${before.year}年${before.month}月${beforeDay}日\n余额\nCN dến ${pad(beforeDay)}/${pad(before.month)}/${before.year}\n`,
      'Phí vận chuyển\n运费', `${m}月销售\n（借方）(bán hàng tháng ${m})`, 'Trả hàng\n退货', `${m}月收入\n（贷方）(Thu tiền tháng ${m})`,
      `${m}月余额\ncòn nợ cuối tháng ${m}`, '备 注',
    ];
    const header = sheet.getRow(3);
    header.height = 59.25;
    headers.forEach((text, column) => {
      const cell = header.getCell(column + 1);
      cell.value = text;
      style(cell, { font: { name: FONT, size: 11, bold: column < 10 }, alignment: { horizontal: 'left', vertical: 'middle', wrapText: column < 10 }, ...(column < 10 ? { fill: { type: 'pattern', pattern: 'solid', fgColor: { argb: YELLOW } } } : {}) });
    });

    const rows = customers
      .filter((customer) => options.includeZero || !isZero(customer.figures[index]!))
      .sort((a, b) => b.figures[index]!.closing - a.figures[index]!.closing || (a.code ?? '').localeCompare(b.code ?? ''));
    const currentRows = new Map<string, number>();
    rows.forEach((customer, order) => {
      const r = 4 + order;
      currentRows.set(customer.id, r);
      const figures = customer.figures[index]!;
      const row = sheet.getRow(r);
      row.height = 40.5;
      const previousRow = index > 0 ? previousRows.get(customer.id) : undefined;
      const opening = previousRow
        ? { formula: `'${summarySheetName(months[index - 1]!)}'!J${previousRow}`, result: figures.opening }
        : figures.opening;
      const values: unknown[] = [
        order + 1, customer.code ?? '', customer.nameZh ? `${customer.name}\n${customer.nameZh}` : customer.name, customer.salesRepName ?? '',
        opening, figures.freight, figures.sales, figures.returns ? -figures.returns : 0, figures.receipt,
        { formula: `E${r}-F${r}+G${r}+H${r}-I${r}`, result: figures.closing },
        (customer.notes[index] ?? []).join('\n'),
      ];
      values.forEach((value, column) => {
        const cell = row.getCell(column + 1);
        cell.value = value as ExcelJS.CellValue;
        const money = column >= 4 && column <= 9;
        style(cell, {
          font: { name: FONT, size: 11, bold: column === 8 || column === 9 },
          alignment: { horizontal: 'left', vertical: 'middle', wrapText: column === 2 || column === 10 },
          ...(money ? { numFmt: MONEY } : {}),
        });
      });
    });
    const first = 4;
    const last = Math.max(first, 3 + rows.length);

    // Dòng 合计 (cách một dòng) và dòng ký như mẫu.
    const totalAt = last + 2;
    const total = sheet.getRow(totalAt);
    total.height = 40.5;
    for (let column = 1; column <= 11; column += 1) style(total.getCell(column), { font: { name: FONT, size: 11, bold: true } });
    total.getCell(3).value = '合计';
    const sum = (key: keyof SummaryFigures) => rows.reduce((value, customer) => value + customer.figures[index]![key], 0);
    const totals: Array<[string, number]> = [['E', sum('opening')], ['F', sum('freight')], ['G', sum('sales')], ['H', -sum('returns')], ['I', sum('receipt')], ['J', sum('closing')]];
    for (const [column, result] of totals) {
      const cell = sheet.getCell(`${column}${totalAt}`);
      cell.value = { formula: `SUBTOTAL(9,${column}${first}:${column}${last})`, result };
      cell.numFmt = MONEY;
    }
    sheet.mergeCells(`A${totalAt + 2}:K${totalAt + 2}`);
    sheet.getCell(`A${totalAt + 2}`).value = '总裁：                      总经理：                    复核：                     制表：';
    sheet.getCell(`A${totalAt + 2}`).font = { name: FONT, size: 11 };
    sheet.getRow(totalAt + 2).height = 30;

    sheet.autoFilter = `A3:K${last}`;
    sheet.pageSetup.printArea = `A1:K${totalAt + 2}`;
    sheet.pageSetup.printTitlesRow = '3:3';
    previousRows = currentRows;
  });
  return workbook;
}
