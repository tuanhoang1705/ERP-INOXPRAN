import { describe, expect, it } from 'vitest';
import { cancelledCode, DEFAULT_SALES_ISSUE_TEMPLATE, expandSalesOrderCode, nextSalesOrderSequence, normalizeSalesOrderCode, periodOfDate, SALES_ISSUE_TEMPLATES, SALES_ORDER_CODE_PATTERN, salesIssueTemplate, salesOrderCodeProblem, salesOrderPeriodPrefix, salesOrderSequence, warehouseSlipNumber } from './sales-templates.js';

describe('mẫu chứng từ phiếu xuất kho bán hàng', () => {
  it('PXK-001 là mẫu mặc định, một thuế suất cho cả phiếu', () => {
    expect(DEFAULT_SALES_ISSUE_TEMPLATE).toBe('PXK-001');
    expect(SALES_ISSUE_TEMPLATES).toContain('PXK-001');
    expect(salesIssueTemplate('PXK-001')).toMatchObject({ code: 'PXK-001', vatMode: 'DOCUMENT' });
  });

  it('phiếu cũ chưa có mã mẫu được coi là PXK-001', () => {
    expect(salesIssueTemplate(undefined).code).toBe('PXK-001');
    expect(salesIssueTemplate('KHONG-CO').code).toBe('PXK-001');
  });
});

describe('số phiếu BH tự nhập', () => {
  it('chấp nhận số phiếu giấy cũ và số theo định dạng hệ thống, viết hoa khi lưu', () => {
    expect(normalizeSalesOrderCode('  bh003/0826 ')).toBe('BH003/0826');
    for (const code of ['BH003/0826', 'BH2026100123', 'PX-01.2026_A']) expect(SALES_ORDER_CODE_PATTERN.test(code)).toBe(true);
  });
  it('từ chối khoảng trắng, ký tự lạ, quá ngắn hoặc quá dài', () => {
    for (const code of ['', 'B', 'BH 003', 'BH#1', '/BH1', 'BHĐ1', 'A'.repeat(41)]) expect(SALES_ORDER_CODE_PATTERN.test(code)).toBe(false);
  });
});

describe('số phiếu BH tự nhập không trùng kiểu số chứng từ khác', () => {
  it('chặn số bắt đầu như SWK / AR / PO / TH / KK… kèm chữ số', () => {
    for (const code of ['SWK2026100001', 'AR2610-00001', 'PO2610-00001', 'TH2026100001', 'KK2026100001', 'IMP2610-001', 'XT2026100001']) expect(salesOrderCodeProblem(code)).toBe('RESERVED');
  });
  it('vẫn cho số BH (kể cả đúng kiểu tự sinh) và số phiếu giấy; báo sai định dạng trước', () => {
    for (const code of ['BH003/0826', 'BH2026100123', 'PX-01', 'THANGVUONG-01', 'ARC1']) expect(salesOrderCodeProblem(code)).toBe(null);
    expect(salesOrderCodeProblem('BH 01')).toBe('FORMAT');
  });
});

describe('đánh số phiếu BH / SWK theo tháng (12/10/2026)', () => {
  const october = { year: 2026, month: 10 };
  it('chỉ gõ số hóa đơn → BH + năm + tháng của ngày chứng từ + 4 số', () => {
    expect(expandSalesOrderCode('104', october)).toBe('BH2026100104');
    expect(expandSalesOrderCode('7', { year: 2027, month: 1 })).toBe('BH2027010007');
    expect(expandSalesOrderCode('BH003/0826', october)).toBe('BH003/0826');
    expect(expandSalesOrderCode('12345', october)).toBe('12345');
    expect(SALES_ORDER_CODE_PATTERN.test('104')).toBe(true);
    expect(SALES_ORDER_CODE_PATTERN.test('5')).toBe(true);
    expect(salesOrderPeriodPrefix(october)).toBe('BH202610');
    expect(periodOfDate('2026-09-30')).toEqual({ year: 2026, month: 9 });
  });
  it('phiếu kho SWK cùng số phiếu BH', () => {
    expect(warehouseSlipNumber('BH2026100104')).toBe('SWK2026100104');
    expect(warehouseSlipNumber('BH003/0826')).toBe('SWK003/0826');
    expect(warehouseSlipNumber('PX-01')).toBe('SWK-PX-01');
  });
});

describe('dùng lại số cuối của phiếu xóa / hủy (13/10/2026)', () => {
  it('tách số thứ tự của mã dạng chuẩn; phiếu hủy -H và số tự nhập khác không tính', () => {
    expect(salesOrderSequence('BH2026100104', 'BH202610')).toBe(104);
    expect(salesOrderSequence('BH2026100104-H1', 'BH202610')).toBeNull();
    expect(salesOrderSequence('BH003/0826', 'BH202610')).toBeNull();
    expect(salesOrderSequence('BH2026090104', 'BH202610')).toBeNull();
  });
  it('số kế tiếp = số cuối đang dùng + 1; tháng trống quay về số đầu tiên của tháng hoặc 1', () => {
    expect(nextSalesOrderSequence(107, 104)).toBe(108);
    expect(nextSalesOrderSequence(null, 104)).toBe(104);
    expect(nextSalesOrderSequence(null, null)).toBe(1);
  });
  it('phiếu hủy đổi sang đuôi -H nhỏ nhất chưa dùng', () => {
    expect(cancelledCode('BH2026100104', new Set())).toBe('BH2026100104-H1');
    expect(cancelledCode('BH2026100104', new Set(['BH2026100104-H1', 'BH2026100104-H2']))).toBe('BH2026100104-H3');
  });
});
