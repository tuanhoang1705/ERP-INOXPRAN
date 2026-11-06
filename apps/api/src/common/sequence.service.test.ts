import { describe, expect, it } from 'vitest';
import { documentCode } from './sequence.service';

const at = (iso: string) => new Date(`${iso}+07:00`);

describe('documentCode (NUM-01: mọi chứng từ đánh số như phiếu BH)', () => {
  it('tiền tố + năm + tháng theo giờ Việt Nam + 4 số', () => {
    expect(documentCode('NK', at('2026-11-06T09:00:00'), 61)).toBe('NK2026110061');
    expect(documentCode('PAY', at('2026-10-31T23:30:00'), 301)).toBe('PAY2026100301');
    // 00:30 ngày 01/12 giờ Việt Nam vẫn là tháng 12 dù giờ UTC còn tháng 11.
    expect(documentCode('XT', at('2026-12-01T00:30:00'), 7)).toBe('XT2026120007');
  });

  it('quá 9999 trong năm thì thành 5 số, không cắt', () => {
    expect(documentCode('ADJ', at('2026-12-20T10:00:00'), 10000)).toBe('ADJ20261210000');
  });
});
