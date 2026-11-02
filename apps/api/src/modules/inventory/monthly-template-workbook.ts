import type { InventoryCategory, InventoryMonthlyReport } from '@inoxpran/contracts';
import ExcelJS from 'exceljs';

/**
 * File tồn kho tháng giống hệt mẫu `TỒN KHO.xlsx` của kho (`___10___月库存明细单`, 30/10/2026): cùng bố cục, tiêu đề Trung + Việt,
 * màu đầu cột, font 等线 14 đậm, công thức E / R / S và dòng 合计. Bỏ cột 移动数据 / 数据查验 (mẫu để trống), các dòng
 * không phải sản phẩm ERP và cột ghi chú (31/10/2026 — chiếm nhiều diện tích); cột 现货库存 lấy số đếm của phiếu kiểm kê
 * đã chốt trong tháng, lệch với tồn cuối kỳ thì ô tồn cuối kỳ tô vàng như mẫu.
 * R 综合出库 = xuất ròng trong tháng = tổng xuất − tổng nhập (dương: tồn giảm; âm: nhập nhiều hơn xuất), S = F − R.
 * Tồn đầu kỳ nhập hệ thống lúc lên ERP tính vào F (tồn tháng trước), không vào G (inventory-reports.service).
 *
 * Mẫu chỉ có 11 cột phát sinh; các loại riêng của ERP gộp vào cột gần nghĩa nhất (dấu − là trừ ra) để công thức tồn cuối kỳ
 * của mẫu (S = F + G − H − I − J − K + L + M + N + O + P − Q) vẫn đúng bằng tồn ERP:
 *   G 本月入库  = nhập hàng mua + chuyển kho đến (khi xem một kho)
 *   H 本月出库  = xuất bán − nhập lại do hủy / sửa phiếu BH + xuất bổ sung do sửa phiếu
 *   I 本月损耗  = hao hụt + kiểm kê thiếu / điều chỉnh giảm + xuất đổi bảo hành − kiểm kê thừa / điều chỉnh tăng
 *   J 样品出库  = hàng mẫu xuất + xuất kiểm định;   P 样品入库 = hàng mẫu nhập lại + nhập lại sau kiểm định
 *   Q 库存退货  = hàng tồn trả nhà máy + chuyển kho đi (khi xem một kho)
 */
export const TEMPLATE_COLUMNS = [
  { letter: 'G', parts: { PURCHASE_IN: 1, TRANSFER_IN: 1 } },
  { letter: 'H', parts: { SALES_OUT: 1, SALES_REVERSAL_IN: -1, SALES_EXTRA_OUT: 1 } },
  { letter: 'I', parts: { LOSS_OUT: 1, ADJUST_OUT: 1, WARRANTY_OUT: 1, ADJUST_IN: -1 } },
  { letter: 'J', parts: { SAMPLE_OUT: 1, INSPECTION_OUT: 1 } },
  { letter: 'K', parts: { GIFT_OUT: 1 } },
  { letter: 'L', parts: { GIFT_RETURN_IN: 1 } },
  { letter: 'M', parts: { IMPORT_DEFECT_IN: 1 } },
  { letter: 'N', parts: { USAGE_DEFECT_IN: 1 } },
  { letter: 'O', parts: { SLOW_RETURN_IN: 1 } },
  { letter: 'P', parts: { SAMPLE_IN: 1, INSPECTION_IN: 1 } },
  { letter: 'Q', parts: { FACTORY_RETURN_OUT: 1, TRANSFER_OUT: 1 } },
] as const satisfies ReadonlyArray<{ letter: string; parts: Partial<Record<InventoryCategory, 1 | -1>> }>;

const round = (value: number) => Math.round(value * 10_000) / 10_000;

/** Số của một cột mẫu từ các loại phát sinh ERP. */
export function templateAmount(amounts: Partial<Record<InventoryCategory, number>>, parts: Partial<Record<InventoryCategory, 1 | -1>>): number {
  let total = 0;
  for (const [code, sign] of Object.entries(parts) as Array<[InventoryCategory, 1 | -1]>) total += (amounts[code] ?? 0) * sign;
  return round(total);
}

export interface MonthlyTemplateInput {
  report: InventoryMonthlyReport;
  monthNo: number;
  /** Tên tiếng Trung của sản phẩm (产品名称); không có thì dùng tên tiếng Việt. */
  chineseNames: Map<string, string>;
  /** Số đếm thực tế của phiếu kiểm kê đã chốt trong tháng: số đếm + chênh lệch so với tồn ERP lúc đếm + mã phiếu. */
  counted: Map<string, { counted: number | null; difference: number; codes?: string[]; notCounted?: boolean }>;
}

const FONT = '等线';
const BLACK = 'FF000000';
const RED = 'FFFF0000';
const COLUMNS = 'ABCDEFGHIJKLMNOPQRST';
const DARK_RED = 'FFC00000';
const thin = { style: 'thin' as const, color: { argb: BLACK } };
const BORDER = { top: thin, bottom: thin, left: thin, right: thin };
const solid = (argb: string) => ({ type: 'pattern' as const, pattern: 'solid' as const, fgColor: { argb } });
type Rich = { text: string; red?: boolean; size?: number };
const rich = (parts: Rich[], size = 10, color = BLACK) => ({
  richText: parts.map((part) => ({ text: part.text, font: { bold: true, name: FONT, size: part.size ?? size, color: { argb: part.red ? RED : color } } })),
});

/** Đầu cột dòng 3 — chữ như mẫu; `fill` là màu nền, `color` màu chữ. */
const HEADERS: Array<{ letter: string; value: string | ReturnType<typeof rich>; fill?: string; color?: string; size?: number }> = [
  { letter: 'F', value: '上月\n库存\nTồn kho cuối tháng trước' },
  { letter: 'G', value: rich([{ text: '本月\n（入库）\n', size: 12 }, { text: 'Tháng này (nhập kho)' }]), fill: 'FF00B050' },
  { letter: 'H', value: rich([{ text: '本月\n（出库）\n', size: 12 }, { text: 'Tháng này (xuất kho)' }]), fill: 'FFFFFF00' },
  { letter: 'I', value: rich([{ text: '本月\n损耗\n（出库）\n', size: 11 }, { text: 'Hao hụt tháng này (xuất kho)' }], 10, RED), fill: 'FFFFC000', color: RED },
  { letter: 'J', value: '\n样品\n（出库）\nHàng mẫu (xuất kho)', fill: 'FFFFC000' },
  { letter: 'K', value: '活动赠送·\n套餐搭配\n（出库）\nHàng tặng khuyến mãi / Hàng combo (xuất kho)', fill: 'FFFFC000', color: DARK_RED },
  { letter: 'L', value: '活动赠送·\n套餐搭配退回\n（入库）\nHàng tặng khuyến mãi/Hàng combo/Hàng trả lại (nhập kho)', fill: 'FF92D050', color: DARK_RED },
  { letter: 'M', value: '进口不良\n（入库）\nHàng lỗi nhập khẩu (nhập kho）', fill: 'FF92D050' },
  { letter: 'N', value: '使用不良\n（入库）\nHàng lỗi do sử dụng (nhập kho)', fill: 'FF92D050', size: 11 },
  { letter: 'O', value: '滞销退货\n（入库）\nHàng bán chậm trả lại (nhập kho）', fill: 'FF92D050', size: 11 },
  { letter: 'P', value: '样品\n（入库）\nHàng mẫu (nhập kho)', fill: 'FF92D050' },
  { letter: 'Q', value: rich([{ text: '库存退货\n' }, { text: '手动', red: true }, { text: '\n（出库返厂）\nHàng tồn trả lại (xuất kho trả về nhà máy)' }]), fill: 'FF92D050' },
  { letter: 'R', value: '综合出库\nXuất kho tổng hợp', fill: 'FF4472C4' },
  { letter: 'S', value: '库存\n结余\nTồn kho cuối kỳ' },
  { letter: 'T', value: '现货库存\nTồn kho hàng có sẵn' },
];

export async function monthlyTemplateWorkbook(input: MonthlyTemplateInput): Promise<Buffer> {
  const { report, monthNo } = input;
  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'INOXPRAN ERP';
  workbook.created = new Date();
  const sheet = workbook.addWorksheet(`${monthNo}月库存`, { pageSetup: { orientation: 'landscape', fitToPage: true, fitToWidth: 1, fitToHeight: 0, paperSize: 9 } });
  // B / C theo độ dài tên / mã dài nhất (chữ 等线 14 đậm ≈ 1.5 đơn vị mỗi ký tự): sản phẩm chưa có tên tiếng Trung
  // dùng tên tiếng Việt dài hơn mẫu nhiều, cột hẹp như mẫu sẽ bị cắt chữ.
  const longest = (values: string[]) => Math.max(0, ...values.map((value) => value.length));
  const nameWidth = Math.min(44, Math.max(16, Math.ceil(longest(report.rows.map((row) => input.chineseNames.get(row.productId) || row.productName)) * 1.5)));
  const codeWidth = Math.min(22, Math.max(14, Math.ceil(longest(report.rows.map((row) => row.sku)) * 1.5)));
  const widths: Record<string, number> = { A: 6, B: nameWidth, C: codeWidth, D: 11, E: 11, F: 10, R: 11, S: 11, T: 12 };
  sheet.columns = COLUMNS.split('').map((letter) => ({ key: letter, width: widths[letter] ?? 9.5 }));

  // Dòng 1: tiêu đề tháng.
  sheet.mergeCells('A1:T1');
  const title = sheet.getCell('A1');
  title.value = `___${monthNo}___月库存明细单`;
  title.font = { bold: true, size: 36, name: FONT, color: { argb: BLACK } };
  title.alignment = { horizontal: 'center', vertical: 'middle' };
  sheet.getRow(1).height = 45;

  // Dòng 2–3: đầu bảng.
  for (const letter of 'ABCDE') sheet.mergeCells(`${letter}2:${letter}3`);
  sheet.mergeCells('F2:S2');
  const left: Array<{ letter: string; value: string | ReturnType<typeof rich>; size: number; bold?: boolean }> = [
    { letter: 'A', value: '序\n号', size: 12, bold: true },
    { letter: 'B', value: ' 产 品 名 称 ', size: 11, bold: true },
    { letter: 'C', value: '型号\nModel', size: 20, bold: true },
    { letter: 'D', value: rich([{ text: '初始入库\n' }, { text: '手动', red: true }, { text: '\nSố lượng nhập kho ban đầu' }], 11), size: 11 },
    { letter: 'E', value: '剩余库存\n百分比\n% tồn kho còn lại', size: 11, bold: true },
  ];
  for (const item of left) {
    const cell = sheet.getCell(`${item.letter}2`);
    cell.value = item.value;
    cell.font = { bold: item.bold ?? true, size: item.size, name: FONT, color: { argb: BLACK } };
  }
  const group = sheet.getCell('F2');
  group.value = '商品数量';
  group.font = { bold: true, size: 22, name: FONT, color: { argb: BLACK } };
  for (const header of HEADERS) {
    const cell = sheet.getCell(`${header.letter}3`);
    cell.value = header.value;
    cell.font = { bold: true, size: header.size ?? 10, name: FONT, color: { argb: header.color ?? BLACK } };
    if (header.fill) cell.fill = solid(header.fill);
  }
  for (const rowNo of [2, 3]) {
    for (const letter of COLUMNS) {
      const cell = sheet.getCell(`${letter}${rowNo}`);
      cell.alignment = { horizontal: 'center', vertical: 'middle', wrapText: true };
      cell.border = BORDER;
    }
  }
  sheet.getRow(2).height = 27.75;
  sheet.getRow(3).height = 165.75;

  // Thân bảng: số lấy từ báo cáo; E, R, S là công thức như mẫu để sửa tay vẫn tự tính lại.
  const first = 4;
  report.rows.forEach((row, index) => {
    const rowNo = first + index;
    const excelRow = sheet.getRow(rowNo);
    const count = input.counted.get(row.productId);
    const mismatch = Boolean(count && (count.difference !== 0 || count.notCounted));
    excelRow.getCell('A').value = index + 1;
    excelRow.getCell('B').value = input.chineseNames.get(row.productId) || row.productName;
    excelRow.getCell('C').value = row.sku;
    excelRow.getCell('D').value = row.initialQuantity ?? null;
    excelRow.getCell('E').value = { formula: `IFERROR(S${rowNo}/D${rowNo}, 0)`, result: row.initialQuantity ? row.closing / row.initialQuantity : 0 };
    excelRow.getCell('F').value = row.opening;
    for (const column of TEMPLATE_COLUMNS) excelRow.getCell(column.letter).value = templateAmount(row.amounts, column.parts);
    excelRow.getCell('R').value = { formula: `-G${rowNo}+H${rowNo}+I${rowNo}+J${rowNo}+K${rowNo}+Q${rowNo}-L${rowNo}-M${rowNo}-N${rowNo}-O${rowNo}-P${rowNo}`, result: row.netOut };
    excelRow.getCell('S').value = { formula: `F${rowNo}+G${rowNo}-H${rowNo}-I${rowNo}-J${rowNo}-K${rowNo}+L${rowNo}+M${rowNo}+N${rowNo}+O${rowNo}+P${rowNo}-Q${rowNo}`, result: row.closing };
    excelRow.getCell('T').value = count?.counted ?? null;
    excelRow.height = 18;
    for (const letter of COLUMNS) {
      const cell = excelRow.getCell(letter);
      cell.font = { bold: true, size: 14, name: FONT, color: { argb: letter === 'K' || letter === 'L' ? DARK_RED : BLACK } };
      cell.border = BORDER;
      cell.alignment = { horizontal: letter === 'B' ? 'left' : 'center', vertical: 'middle', shrinkToFit: letter === 'B' };
    }
    excelRow.getCell('E').numFmt = '0.00%';
    // Kiểm kê lệch: tô vàng ô tồn cuối kỳ như mẫu (S71 "实际库存多1台").
    if (mismatch) excelRow.getCell('S').fill = solid('FFFFFF00');
  });
  const last = first + report.rows.length - 1;

  // Thang màu % tồn còn lại như mẫu: đỏ (thấp) → vàng → xanh (cao).
  if (report.rows.length) {
    sheet.addConditionalFormatting({
      ref: `E${first}:E${last}`,
      rules: [{ type: 'colorScale', priority: 1, cfvo: [{ type: 'percent', value: 15 }, { type: 'percentile', value: 50 }, { type: 'max' }], color: [{ argb: 'FFFF0000' }, { argb: 'FFFFFF00' }, { argb: 'FF00B050' }] }],
    });
  }

  // Dòng 合计: SUBTOTAL(9) như mẫu, nền cam.
  const totalNo = last + 1;
  const totalRow = sheet.getRow(totalNo);
  totalRow.getCell('B').value = '合计';
  const totalResult: Record<string, number> = { F: report.totals.opening, R: report.totals.netOut, S: report.totals.closing };
  for (const column of TEMPLATE_COLUMNS) totalResult[column.letter] = templateAmount(report.totals.amounts, column.parts);
  for (const letter of 'FGHIJKLMNOPQRS') {
    totalRow.getCell(letter).value = { formula: `SUBTOTAL(9,${letter}${first}:${letter}${Math.max(last, first)})`, result: totalResult[letter] ?? 0 };
  }
  totalRow.height = 18;
  for (const letter of COLUMNS) {
    const cell = totalRow.getCell(letter);
    cell.font = { bold: true, size: 14, name: FONT, color: { argb: BLACK } };
    cell.border = BORDER;
    cell.alignment = { horizontal: 'center', vertical: 'middle' };
    if (letter >= 'B' && letter <= 'S') cell.fill = solid('FFFFC000');
  }
  return Buffer.from(await workbook.xlsx.writeBuffer());
}
