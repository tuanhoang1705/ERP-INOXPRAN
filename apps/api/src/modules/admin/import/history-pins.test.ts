import Decimal from 'decimal.js';
import { describe, expect, it } from 'vitest';
import { planDocumentPins, type PinEntry } from './history-pins';

const entry = (id: string, amount: string, extra: Partial<PinEntry> = {}): PinEntry => ({ id, customerCode: 'KH002', type: 'BAN_HANG', status: 'NHAP', amount, ...extra });
const pin = (paid: string, ...payments: string[]) => ({ paid: new Decimal(paid), payments });

describe('planDocumentPins', () => {
  it('thu đủ số tròn cũ, số mới nhỏ hơn dưới 1 đ → giữ số đã thu', () => {
    const result = planDocumentPins([entry('LS1', '84299999.94')], new Map([['LS1', pin('84300000', 'PT1')]]));
    expect(result.blocked).toEqual([]);
    expect(result.floors.get('LS1')?.toFixed(2)).toBe('84300000.00');
    expect(result.kept).toEqual([{ id: 'LS1', customerCode: 'KH002', fileAmount: '84299999.94', keptAmount: '84300000.00', payments: ['PT1'] }]);
  });
  it('thu chưa vượt số mới → không đổi gì', () => {
    const result = planDocumentPins([entry('LS1', '84299999.94')], new Map([['LS1', pin('5000000', 'PT1')]]));
    expect(result).toEqual({ floors: new Map(), kept: [], blocked: [] });
  });
  it('thu vượt từ 1 đ → chặn, báo phiếu', () => {
    const result = planDocumentPins([entry('LS1', '84299998.50')], new Map([['LS1', pin('84300000', 'PT1', 'PT2')]]));
    expect(result.kept).toEqual([]);
    expect(result.blocked[0]).toContain('PT1, PT2');
  });
  it('file mới không còn chứng từ đã thu theo chứng từ → chặn', () => {
    const result = planDocumentPins([entry('LS2', '100')], new Map([['LS1', pin('100', 'PT1')]]));
    expect(result.blocked).toHaveLength(1);
    expect(result.blocked[0]).toContain('không còn chứng từ LS1');
  });
  it('dòng bỏ qua (đã có trên ERP) hoặc phiếu giảm nợ không tính là chứng từ còn trong file', () => {
    const result = planDocumentPins([entry('LS1', '100', { status: 'BO_QUA_DA_CO_ERP' }), entry('LS3', '100', { type: 'THU_TIEN' })], new Map([['LS1', pin('100', 'PT1')]]));
    expect(result.blocked).toHaveLength(1);
  });
});
