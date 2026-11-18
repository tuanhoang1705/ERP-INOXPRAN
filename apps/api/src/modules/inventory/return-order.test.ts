import { describe, expect, it } from 'vitest';
import { RETURN_NUMBER_PATTERN, returnListOrder } from './return-order';

const parse = (code: string) => {
  const match = new RegExp(RETURN_NUMBER_PATTERN).exec(code);
  return match ? [match[1], Number(match[2])] : null;
};

describe('thứ tự danh sách phiếu trả hàng (NK-SORT-01)', () => {
  it('đọc tháng trên số và số thứ tự, kể cả phiếu đã hủy và số 5 chữ số', () => {
    expect(parse('NK2026100040')).toEqual(['202610', 40]);
    expect(parse('NK2026100040-H1')).toEqual(['202610', 40]);
    expect(parse('XT2026110003')).toEqual(['202611', 3]);
    expect(parse('NK20261210001')).toEqual(['202612', 10001]);
    expect(parse('TH2610-00012')).toBeNull();
    expect(parse('NK2026130001')).toBeNull();
  });

  it('xếp theo số giảm dần; cùng số thì phiếu đang dùng trước phiếu đã hủy', () => {
    const sort = returnListOrder().find((stage) => '$sort' in stage);
    expect(sort).toEqual({ $sort: { _period: -1, _seq: -1, code: 1, createdAt: -1, _id: -1 } });
    const rows = ['NK2026100040-H1', 'NK2026110005', 'NK2026100003', 'NK2026100040', 'XT2026110002', 'TH-OLD']
      .map((code) => ({ code, key: parse(code) ?? ['', -1] }))
      .sort((a, b) => String(b.key[0]).localeCompare(String(a.key[0])) || Number(b.key[1]) - Number(a.key[1]) || (a.code < b.code ? -1 : a.code > b.code ? 1 : 0))
      .map((row) => row.code);
    expect(rows).toEqual(['NK2026110005', 'XT2026110002', 'NK2026100040', 'NK2026100040-H1', 'NK2026100003', 'TH-OLD']);
  });
});
