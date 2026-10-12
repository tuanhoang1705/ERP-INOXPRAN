import { describe, expect, it } from 'vitest';
import { vndInWords } from './vnd-words';

describe('vndInWords', () => {
  it('khớp đúng dòng "Số tiền bằng chữ" trên phiếu xuất kho thật', () => {
    expect(vndInWords(80_830_000)).toBe('Tám mươi triệu tám trăm ba mươi nghìn đồng.');
    expect(vndInWords(1_920_000)).toBe('Một triệu chín trăm hai mươi nghìn đồng.');
  });

  it('đọc đúng mốt, lăm, linh và nhóm không trăm', () => {
    expect(vndInWords(21)).toBe('Hai mươi mốt đồng.');
    expect(vndInWords(15)).toBe('Mười lăm đồng.');
    expect(vndInWords(105)).toBe('Một trăm linh năm đồng.');
    expect(vndInWords(1_005_000)).toBe('Một triệu không trăm linh năm nghìn đồng.');
    expect(vndInWords(2_000_000_500)).toBe('Hai tỷ năm trăm đồng.');
    expect(vndInWords(1_250_000_000)).toBe('Một tỷ hai trăm năm mươi triệu đồng.');
  });

  it('làm tròn tới đồng và xử lý số 0', () => {
    expect(vndInWords(0)).toBe('Không đồng.');
    expect(vndInWords('1777777.8')).toBe('Một triệu bảy trăm bảy mươi bảy nghìn bảy trăm bảy mươi tám đồng.');
  });
});
