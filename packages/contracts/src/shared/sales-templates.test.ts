import { describe, expect, it } from 'vitest';
import { DEFAULT_SALES_ISSUE_TEMPLATE, normalizeSalesOrderCode, SALES_ISSUE_TEMPLATES, SALES_ORDER_CODE_PATTERN, salesIssueTemplate, salesOrderCodeProblem } from './sales-templates.js';

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
