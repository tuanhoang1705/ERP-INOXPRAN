import ExcelJS from 'exceljs';

/**
 * Bộ chuẩn Excel thương hiệu INOXPRAN (XLS-01, 30/10/2026) — dùng chung cho mọi file xuất (trừ file tồn kho tháng phải giống hệt
 * mẫu của kho). Màu theo giao diện web: navy đầu bảng / tiêu đề, cam làm điểm nhấn, cam nhạt cho dòng tổng và chỉ số chính,
 * xám nhạt xen kẽ dòng. Chữ Arial 11 (tiêu đề 18), số tiền có dấu phân cách, số âm đỏ trong ngoặc, cố định đầu bảng, lọc tự động,
 * in A4 ngang vừa một trang ngang và lặp dòng đầu bảng.
 */
export const BRAND = {
  navy: 'FF123B5E',
  navy2: 'FF1B5480',
  orange: 'FFE2703A',
  orangeSoft: 'FFFDF0E9',
  zebra: 'FFF4F6F9',
  border: 'FFD0D7E2',
  text: 'FF1F2937',
  muted: 'FF5A6B7C',
  white: 'FFFFFFFF',
  red: 'FFC0392B',
  green: 'FF1E7B4A',
  inSoft: 'FFE7F4EC',
  outSoft: 'FFFDF0E9',
  warnSoft: 'FFFFF4D6',
} as const;
export const COMPANY = 'CÔNG TY TNHH ĐẦU TƯ THẮNG VƯỢNG — INOXPRAN';
const FONT = 'Arial';

export const FORMATS = {
  money: '#,##0;[Red](#,##0);"-"',
  qty: '#,##0.####;[Red]-#,##0.####;"-"',
  int: '#,##0;[Red]-#,##0;"-"',
  percent: '0.0%',
  date: 'dd/mm/yyyy',
} as const;

export type BrandColumnType = 'text' | 'code' | 'money' | 'qty' | 'int' | 'percent' | 'date';
export interface BrandColumn {
  key: string;
  header: string;
  width: number;
  type?: BrandColumnType;
  /** Cột trọng tâm (VD Doanh số, Còn nợ): chữ đậm. */
  emphasis?: boolean;
  /** Tô nền nhạt cả cột: nhập (xanh) / xuất (cam). */
  tint?: 'in' | 'out';
  wrap?: boolean;
}

const solid = (argb: string): ExcelJS.Fill => ({ type: 'pattern', pattern: 'solid', fgColor: { argb } });
const line = (argb: string = BRAND.border): Partial<ExcelJS.Border> => ({ style: 'thin', color: { argb } });
const box = (argb: string = BRAND.border): Partial<ExcelJS.Borders> => ({ top: line(argb), bottom: line(argb), left: line(argb), right: line(argb) });
const pad = (value: number) => String(value).padStart(2, '0');

/** Ngày giờ xuất theo giờ Việt Nam, VD "30/10/2026 14:05". */
export function exportedAt(date = new Date()): string {
  const vn = new Date(date.getTime() + 7 * 3_600_000);
  return `${pad(vn.getUTCDate())}/${pad(vn.getUTCMonth() + 1)}/${vn.getUTCFullYear()} ${pad(vn.getUTCHours())}:${pad(vn.getUTCMinutes())}`;
}

export function brandWorkbook(): ExcelJS.Workbook {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'INOXPRAN ERP';
  workbook.company = 'INOXPRAN';
  workbook.created = new Date();
  return workbook;
}

/** Sheet theo khung chuẩn: độ rộng cột, in A4 (ngang mặc định), chân trang có số trang, ẩn lưới cho gọn. */
export function brandSheet(workbook: ExcelJS.Workbook, name: string, columns: BrandColumn[], options: { portrait?: boolean } = {}): ExcelJS.Worksheet {
  const sheet = workbook.addWorksheet(name.slice(0, 31), {
    views: [{ showGridLines: false }],
    pageSetup: {
      paperSize: 9, orientation: options.portrait ? 'portrait' : 'landscape', fitToPage: true, fitToWidth: 1, fitToHeight: 0,
      margins: { left: 0.4, right: 0.4, top: 0.5, bottom: 0.6, header: 0.25, footer: 0.3 },
      horizontalCentered: true,
    },
    headerFooter: { oddFooter: '&L&8INOXPRAN ERP&C&8Trang &P/&N&R&8&D &T' },
  });
  sheet.columns = columns.map((column) => ({ key: column.key, width: column.width }));
  sheet.properties.defaultRowHeight = 20;
  return sheet;
}

/**
 * Khối tiêu đề: tên công ty, tên báo cáo (gạch chân cam), dòng thông tin (kỳ, bộ lọc, người lập, giờ xuất). Trả số dòng kế tiếp.
 */
export function titleBlock(sheet: ExcelJS.Worksheet, width: number, title: string, meta: string[]): number {
  const last = sheet.getColumn(width).letter;
  sheet.mergeCells(`A1:${last}1`);
  sheet.getCell('A1').value = COMPANY;
  sheet.getCell('A1').font = { name: FONT, size: 12, bold: true, color: { argb: BRAND.navy } };
  sheet.getRow(1).height = 20;
  sheet.mergeCells(`A2:${last}2`);
  const heading = sheet.getCell('A2');
  heading.value = title.toUpperCase();
  heading.font = { name: FONT, size: 18, bold: true, color: { argb: BRAND.navy } };
  heading.alignment = { vertical: 'middle' };
  sheet.getRow(2).height = 30;
  for (let column = 1; column <= width; column += 1) sheet.getRow(2).getCell(column).border = { bottom: { style: 'medium', color: { argb: BRAND.orange } } };
  // Bảng hẹp (vài cột): dòng thông tin dài thì xuống dòng thay vì bị cắt khi in.
  const capacity = Math.max(20, columnWidths(sheet, 1, width) * 1.15);
  let row = 3;
  for (const text of meta.filter(Boolean)) {
    sheet.mergeCells(`A${row}:${last}${row}`);
    const cell = sheet.getCell(`A${row}`);
    cell.value = text;
    cell.font = { name: FONT, size: 10, italic: true, color: { argb: BRAND.muted } };
    cell.alignment = { vertical: 'top', wrapText: true };
    sheet.getRow(row).height = 15 * Math.ceil(text.length / capacity) + 2;
    row += 1;
  }
  return row + 1;
}

export interface Kpi { label: string; value: number | string; format?: string; tone?: 'normal' | 'danger' | 'good' }

function columnWidths(sheet: ExcelJS.Worksheet, from: number, to: number): number {
  let total = 0;
  for (let column = from; column <= to; column += 1) total += sheet.getColumn(column).width ?? 9;
  return total;
}

/**
 * Chia các cột 1..width thành `parts` nhóm liền nhau sao cho nhóm hẹp nhất rộng nhất có thể (theo độ rộng cột,
 * không theo số cột) — tránh ô chỉ số rơi vào một cột hẹp và hiện ##### khi số lớn.
 */
function splitByWidth(sheet: ExcelJS.Worksheet, width: number, parts: number): Array<[number, number]> {
  const widths = Array.from({ length: width }, (_, index) => sheet.getColumn(index + 1).width ?? 9);
  const prefix = [0];
  for (const value of widths) prefix.push(prefix[prefix.length - 1]! + value);
  const span = (from: number, to: number) => prefix[to]! - prefix[from - 1]!;
  // best[k][i]: nhóm hẹp nhất lớn nhất khi chia cột 1..i thành k nhóm; cut[k][i]: cột cuối của nhóm thứ k-1.
  const best = Array.from({ length: parts + 1 }, () => new Array<number>(width + 1).fill(-Infinity));
  const cut = Array.from({ length: parts + 1 }, () => new Array<number>(width + 1).fill(0));
  for (let i = 1; i <= width; i += 1) best[1]![i] = span(1, i);
  for (let k = 2; k <= parts; k += 1) {
    for (let i = k; i <= width; i += 1) {
      for (let j = k - 1; j < i; j += 1) {
        const value = Math.min(best[k - 1]![j]!, span(j + 1, i));
        if (value > best[k]![i]!) { best[k]![i] = value; cut[k]![i] = j; }
      }
    }
  }
  const groups: Array<[number, number]> = [];
  let to = width;
  for (let k = parts; k >= 1; k -= 1) {
    const from = k === 1 ? 1 : cut[k]![to]! + 1;
    groups.unshift([from, to]);
    to = from - 1;
  }
  return groups;
}

/**
 * Dải chỉ số chính: mỗi ô gồm nhãn nhỏ + số to, nền cam nhạt, chia đều bề ngang bảng. Trả số dòng kế tiếp.
 */
export function kpiStrip(sheet: ExcelJS.Worksheet, startRow: number, width: number, items: Kpi[]): number {
  if (!items.length) return startRow;
  const groups = splitByWidth(sheet, width, Math.min(items.length, width));
  items.slice(0, groups.length).forEach((item, index) => {
    const [from, to] = groups[index]!;
    const left = sheet.getColumn(from).letter;
    const right = sheet.getColumn(to).letter;
    sheet.mergeCells(`${left}${startRow}:${right}${startRow}`);
    sheet.mergeCells(`${left}${startRow + 1}:${right}${startRow + 1}`);
    const label = sheet.getCell(`${left}${startRow}`);
    label.value = item.label;
    label.font = { name: FONT, size: 9, bold: true, color: { argb: BRAND.muted } };
    label.alignment = { horizontal: 'left', vertical: 'bottom', indent: 1 };
    const value = sheet.getCell(`${left}${startRow + 1}`);
    value.value = item.value;
    value.font = { name: FONT, size: 14, bold: true, color: { argb: item.tone === 'danger' ? BRAND.red : item.tone === 'good' ? BRAND.green : BRAND.navy } };
    value.alignment = { horizontal: 'left', vertical: 'middle', indent: 1 };
    if (item.format) value.numFmt = item.format;
    for (let column = from; column <= to; column += 1) {
      for (const rowNo of [startRow, startRow + 1]) {
        const cell = sheet.getRow(rowNo).getCell(column);
        cell.fill = solid(BRAND.orangeSoft);
        cell.border = {
          ...(rowNo === startRow ? { top: line(BRAND.orange) } : { bottom: line(BRAND.orange) }),
          ...(column === from ? { left: { style: 'medium', color: { argb: BRAND.orange } } } : {}),
          ...(column === to ? { right: line(BRAND.white) } : {}),
        };
      }
    }
  });
  sheet.getRow(startRow).height = 18;
  sheet.getRow(startRow + 1).height = 26;
  return startRow + 3;
}

/** Dòng đầu bảng: nền navy, chữ trắng đậm, xuống dòng. */
export function tableHeader(sheet: ExcelJS.Worksheet, rowNo: number, columns: BrandColumn[]): void {
  const row = sheet.getRow(rowNo);
  columns.forEach((column, index) => {
    const cell = row.getCell(index + 1);
    cell.value = column.header;
    cell.font = { name: FONT, size: 11, bold: true, color: { argb: BRAND.white } };
    cell.fill = solid(column.tint === 'in' ? BRAND.green : column.tint === 'out' ? BRAND.orange : BRAND.navy);
    cell.alignment = { horizontal: 'center', vertical: 'middle', wrapText: true };
    cell.border = box(BRAND.navy2);
  });
  row.height = 32;
}

export interface RowStyle {
  /** Dòng cần chú ý: nền vàng nhạt (cảnh báo) hoặc chữ đỏ (lỗi / quá hạn). */
  highlight?: 'warn' | 'danger';
  /** Ô riêng cần chữ đỏ / xanh. */
  cells?: Record<string, { color?: 'red' | 'green'; bold?: boolean }>;
}

/** Thêm một dòng thân bảng theo kiểu cột: định dạng số, căn lề, viền, xen kẽ nền. */
export function addBodyRow(sheet: ExcelJS.Worksheet, columns: BrandColumn[], values: Record<string, unknown>, index: number, style: RowStyle = {}): ExcelJS.Row {
  const row = sheet.addRow(columns.map((column) => values[column.key] ?? null));
  // Cột xuống dòng: tăng chiều cao theo độ dài chữ để không bị cắt (Excel không tự giãn dòng có chiều cao cố định).
  const lines = Math.max(1, ...columns.filter((column) => column.wrap).map((column) => Math.ceil(String(values[column.key] ?? '').length / Math.max(1, column.width * 1.1))));
  row.height = lines > 1 ? 15 * lines + 4 : 20;
  columns.forEach((column, position) => {
    const cell = row.getCell(position + 1);
    const numeric = column.type && column.type !== 'text' && column.type !== 'code';
    const custom = style.cells?.[column.key];
    cell.font = {
      name: FONT, size: 11,
      bold: Boolean(column.emphasis || column.type === 'code' || custom?.bold),
      color: { argb: custom?.color === 'red' || style.highlight === 'danger' ? BRAND.red : custom?.color === 'green' ? BRAND.green : column.type === 'code' ? BRAND.navy : BRAND.text },
    };
    if (column.type === 'money') cell.numFmt = FORMATS.money;
    else if (column.type === 'qty') cell.numFmt = FORMATS.qty;
    else if (column.type === 'int') cell.numFmt = FORMATS.int;
    else if (column.type === 'percent') cell.numFmt = FORMATS.percent;
    else if (column.type === 'date') cell.numFmt = FORMATS.date;
    cell.alignment = { vertical: 'middle', horizontal: numeric ? (column.type === 'date' ? 'center' : 'right') : 'left', wrapText: Boolean(column.wrap) };
    cell.border = box();
    const fill = style.highlight === 'warn' ? BRAND.warnSoft : column.tint === 'in' ? BRAND.inSoft : column.tint === 'out' ? BRAND.outSoft : index % 2 === 1 ? BRAND.zebra : null;
    if (fill) cell.fill = solid(fill);
  });
  return row;
}

/** Dòng tổng: nền cam nhạt, chữ đậm navy, viền trên đôi. */
export function totalRow(sheet: ExcelJS.Worksheet, columns: BrandColumn[], values: Record<string, unknown>): ExcelJS.Row {
  const row = sheet.addRow(columns.map((column) => values[column.key] ?? null));
  row.height = 24;
  columns.forEach((column, position) => {
    const cell = row.getCell(position + 1);
    cell.font = { name: FONT, size: 11, bold: true, color: { argb: BRAND.navy } };
    cell.fill = solid(BRAND.orangeSoft);
    cell.border = { top: { style: 'double', color: { argb: BRAND.navy } }, bottom: { style: 'medium', color: { argb: BRAND.navy } }, left: line(), right: line() };
    if (column.type === 'money') cell.numFmt = FORMATS.money;
    else if (column.type === 'qty') cell.numFmt = FORMATS.qty;
    else if (column.type === 'int') cell.numFmt = FORMATS.int;
    else if (column.type === 'percent') cell.numFmt = FORMATS.percent;
    cell.alignment = { vertical: 'middle', horizontal: column.type && column.type !== 'text' && column.type !== 'code' ? 'right' : 'left' };
  });
  return row;
}

/** Ghi chú cuối bảng (chữ nhỏ nghiêng). */
export function noteRow(sheet: ExcelJS.Worksheet, width: number, text: string): void {
  const row = sheet.addRow([text]);
  sheet.mergeCells(`A${row.number}:${sheet.getColumn(width).letter}${row.number}`);
  row.getCell(1).font = { name: FONT, size: 9, italic: true, color: { argb: BRAND.muted } };
  row.getCell(1).alignment = { wrapText: true, vertical: 'top' };
  row.height = 28;
}

/** Khối ký tên: Người lập · Kế toán trưởng · Giám đốc (chia đều bề ngang). */
export function signatureBlock(sheet: ExcelJS.Worksheet, width: number, preparedBy: string, roles = ['Người lập biểu', 'Kế toán trưởng', 'Giám đốc']): void {
  const start = sheet.lastRow ? sheet.lastRow.number + 2 : 1;
  const groups = splitByWidth(sheet, width, Math.min(roles.length, width));
  roles.slice(0, groups.length).forEach((role, index) => {
    const [from, to] = groups[index]!;
    const left = sheet.getColumn(from).letter;
    const right = sheet.getColumn(to).letter;
    const rows: Array<[number, string, Partial<ExcelJS.Font>]> = [
      [start, role, { bold: true, size: 11, color: { argb: BRAND.navy } }],
      [start + 1, '(Ký, ghi rõ họ tên)', { italic: true, size: 9, color: { argb: BRAND.muted } }],
      [start + 5, index === 0 ? preparedBy : '', { bold: true, size: 11, color: { argb: BRAND.text } }],
    ];
    for (const [rowNo, text, font] of rows) {
      sheet.mergeCells(`${left}${rowNo}:${right}${rowNo}`);
      const cell = sheet.getCell(`${left}${rowNo}`);
      cell.value = text;
      cell.font = { name: FONT, ...font };
      cell.alignment = { horizontal: 'center' };
    }
  });
}

/** Cố định đầu bảng, lọc tự động, lặp dòng đầu bảng khi in. */
export function finalize(sheet: ExcelJS.Worksheet, headerRow: number, lastRow: number, width: number, options: { freezeColumns?: number } = {}): void {
  sheet.views = [{ state: 'frozen', xSplit: options.freezeColumns ?? 0, ySplit: headerRow, showGridLines: false }];
  if (lastRow > headerRow) sheet.autoFilter = { from: { row: headerRow, column: 1 }, to: { row: lastRow, column: width } };
  sheet.pageSetup.printTitlesRow = `${headerRow}:${headerRow}`;
}

export async function toBuffer(workbook: ExcelJS.Workbook): Promise<Buffer> {
  return Buffer.from(await workbook.xlsx.writeBuffer());
}
