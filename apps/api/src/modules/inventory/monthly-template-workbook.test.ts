import { monthlyBalance, type InventoryCategory } from '@inoxpran/contracts';
import ExcelJS from 'exceljs';
import { describe, expect, it } from 'vitest';
import { monthlyTemplateWorkbook, TEMPLATE_COLUMNS, templateAmount } from './monthly-template-workbook';

const amounts: Partial<Record<InventoryCategory, number>> = {
  PURCHASE_IN: 100, SALES_OUT: 40, SALES_REVERSAL_IN: 3, SALES_EXTRA_OUT: 1, LOSS_OUT: 2, ADJUST_IN: 5, ADJUST_OUT: 1, WARRANTY_OUT: 1,
  SAMPLE_OUT: 4, INSPECTION_OUT: 2, GIFT_OUT: 6, GIFT_RETURN_IN: 1, IMPORT_DEFECT_IN: 1, USAGE_DEFECT_IN: 2, SLOW_RETURN_IN: 7, SAMPLE_IN: 3, INSPECTION_IN: 1, FACTORY_RETURN_OUT: 9,
};

describe('file tồn kho tháng theo mẫu TỒN KHO.xlsx', () => {
  it('gộp loại ERP vào 11 cột mẫu mà công thức tồn cuối kỳ của mẫu vẫn bằng tồn ERP', () => {
    const value = Object.fromEntries(TEMPLATE_COLUMNS.map((column) => [column.letter, templateAmount(amounts, column.parts)]));
    expect(value).toMatchObject({ G: 100, H: 38, I: -1, J: 6, K: 6, L: 1, M: 1, N: 2, O: 7, P: 4, Q: 9 });
    const opening = 50;
    const closing = opening + value.G! - value.H! - value.I! - value.J! - value.K! + value.L! + value.M! + value.N! + value.O! + value.P! - value.Q!;
    expect(closing).toBe(monthlyBalance(opening, amounts).closing);
  });

  it('R xuất kho tổng hợp = tổng xuất − tổng nhập (dương: tồn giảm), S = F − R', () => {
    const value = Object.fromEntries(TEMPLATE_COLUMNS.map((column) => [column.letter, templateAmount(amounts, column.parts)]));
    const out = value.H! + value.I! + value.J! + value.K! + value.Q!;
    const inbound = value.G! + value.L! + value.M! + value.N! + value.O! + value.P!;
    expect(out - inbound).toBe(monthlyBalance(50, amounts).netOut);
    // Ví dụ file kho tháng 10: INP1003 tồn tháng trước 1.728, xuất 375 + 12 kiểm định + 1 tặng, nhập lại 13 bán chậm + 1 lỗi → 374.
    const inp1003 = monthlyBalance(1728, { SALES_OUT: 375, INSPECTION_OUT: 12, GIFT_OUT: 1, SLOW_RETURN_IN: 13, USAGE_DEFECT_IN: 1 });
    expect(inp1003).toEqual({ netOut: 374, closing: 1354 });
  });

  it('bố cục như mẫu: tiêu đề, đầu cột có màu, công thức E/R/S, dòng 合计, cột 现货库存 từ kiểm kê', async () => {
    const buffer = await monthlyTemplateWorkbook({
      monthNo: 10,
      chineseNames: new Map([['p1', '不锈钢套锅']]),
      counted: new Map([['p1', { counted: 583, difference: 1, codes: ['KK2026100001'] }], ['p2', { counted: null, difference: 0, codes: ['KK2026100001'], notCounted: true }]]),
      report: {
        month: '2026-10', warehouseId: null, warehouseName: 'Tất cả kho', current: false, columns: [], mismatches: 0, stockCountWarnings: [],
        rows: [
          { productId: 'p1', sku: 'INP1001', productName: 'Bộ nồi', unit: 'bộ', initialQuantity: 860, remainingPercent: 67.67, opening: 618, amounts: { SALES_OUT: 36 }, netOut: 36, closing: 582, available: null, ledgerMatches: null },
          { productId: 'p2', sku: 'INP1002', productName: 'Chảo', unit: 'cái', initialQuantity: null, remainingPercent: null, opening: 4, amounts: {}, netOut: 0, closing: 4, available: null, ledgerMatches: null },
        ],
        totals: { opening: 622, amounts: { SALES_OUT: 36 }, netOut: 36, closing: 586 },
      },
    });
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(buffer as unknown as ArrayBuffer);
    const sheet = workbook.getWorksheet('10月库存')!;
    expect(sheet.getCell('A1').value).toBe('___10___月库存明细单');
    expect(sheet.getCell('F2').value).toBe('商品数量');
    expect((sheet.getCell('G3').fill as ExcelJS.FillPattern).fgColor?.argb).toBe('FF00B050');
    expect((sheet.getCell('R3').fill as ExcelJS.FillPattern).fgColor?.argb).toBe('FF4472C4');
    expect(sheet.getCell('B4').value).toBe('不锈钢套锅');
    expect(sheet.getCell('H4').value).toBe(36);
    expect((sheet.getCell('S4').value as ExcelJS.CellFormulaValue).formula).toBe('F4+G4-H4-I4-J4-K4+L4+M4+N4+O4+P4-Q4');
    expect((sheet.getCell('E4').value as ExcelJS.CellFormulaValue).formula).toBe('IFERROR(S4/D4, 0)');
    expect(sheet.getCell('T4').value).toBe(583);
    expect((sheet.getCell('R4').value as ExcelJS.CellFormulaValue).result).toBe(36);
    // Không còn cột ghi chú (31/10/2026): 20 cột A–T; kiểm kê lệch thì ô S tô vàng.
    expect(sheet.columnCount).toBe(20);
    expect(sheet.getCell('U3').value).toBeNull();
    expect((sheet.getCell('S4').fill as ExcelJS.FillPattern).fgColor?.argb).toBe('FFFFFF00');
    // ERP còn tồn mà không đếm: không có số thực tế, ô S tô vàng.
    expect(sheet.getCell('T5').value).toBeNull();
    expect((sheet.getCell('S5').fill as ExcelJS.FillPattern).fgColor?.argb).toBe('FFFFFF00');
    expect(sheet.getCell('B6').value).toBe('合计');
    expect((sheet.getCell('S6').value as ExcelJS.CellFormulaValue).formula).toBe('SUBTOTAL(9,S4:S5)');
    expect(sheet.getCell('A4').font?.size).toBe(14);
  });
});
