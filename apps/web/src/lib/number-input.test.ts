import { describe, expect, it } from 'vitest';
import { canonicalNumber, formatNumberValue, parseLooseNumber, reformatNumberInput, separatorsFor } from './number-input';

const vi = separatorsFor('vi-VN');
const zh = separatorsFor('zh-CN');

describe('separatorsFor', () => {
  it('lấy dấu phân cách theo ngôn ngữ', () => {
    expect(vi).toEqual({ group: '.', decimal: ',' });
    expect(zh).toEqual({ group: ',', decimal: '.' });
  });
});

describe('formatNumberValue', () => {
  it('định dạng giá trị chuẩn để hiển thị', () => {
    expect(formatNumberValue('1250000', vi)).toBe('1.250.000');
    expect(formatNumberValue('1250000', zh)).toBe('1,250,000');
    expect(formatNumberValue('25.50', vi)).toBe('25,5');
    expect(formatNumberValue('313708.0000', vi)).toBe('313.708');
    expect(formatNumberValue(7, vi)).toBe('7');
    expect(formatNumberValue('', vi)).toBe('');
    expect(formatNumberValue(undefined, vi)).toBe('');
  });
});

describe('reformatNumberInput', () => {
  it('chèn phân cách khi gõ và giữ con trỏ ở cuối', () => {
    expect(reformatNumberInput('1250000', 7, 0, vi)).toEqual({ text: '1.250.000', value: '1250000', caret: 9 });
    expect(reformatNumberInput('1250000', 7, 0, zh)).toEqual({ text: '1,250,000', value: '1250000', caret: 9 });
  });
  it('giữ con trỏ khi chèn chữ số ở giữa', () => {
    // "1.250.000" gõ thêm "9" sau "1.2" → "1.2950.000" con trỏ ở vị trí 4
    const result = reformatNumberInput('1.2950.000', 4, 0, vi);
    expect(result.text).toBe('12.950.000');
    expect(result.value).toBe('12950000');
    expect(result.text.slice(0, result.caret)).toBe('12.9');
  });
  it('xử lý số lẻ, giữ dấu thập phân cuối khi đang gõ', () => {
    expect(reformatNumberInput('25,', 3, 2, vi)).toEqual({ text: '25,', value: '25', caret: 3 });
    expect(reformatNumberInput('1234,567', 8, 2, vi)).toMatchObject({ text: '1.234,56', value: '1234.56' });
    expect(reformatNumberInput('1234.5', 6, 4, zh)).toMatchObject({ text: '1,234.5', value: '1234.5' });
    expect(reformatNumberInput(',5', 2, 2, vi)).toMatchObject({ text: '0,5', value: '0.5', caret: 3 });
  });
  it('ô số nguyên bỏ dấu thập phân và chữ', () => {
    expect(reformatNumberInput('12,5abc', 7, 0, vi)).toMatchObject({ text: '125', value: '125' });
  });
  it('bỏ số 0 thừa ở đầu', () => {
    expect(reformatNumberInput('05', 2, 0, vi)).toEqual({ text: '5', value: '5', caret: 1 });
    expect(reformatNumberInput('0', 1, 0, vi)).toEqual({ text: '0', value: '0', caret: 1 });
  });
  it('xóa hết thì rỗng', () => {
    expect(reformatNumberInput('', 0, 0, vi)).toEqual({ text: '', value: '', caret: 0 });
  });
});

describe('parseLooseNumber', () => {
  it('hiểu chuỗi dán từ Excel / tin nhắn', () => {
    expect(parseLooseNumber('1.250.000 đ', 0)).toBe('1250000');
    expect(parseLooseNumber('1,250,000.50', 2)).toBe('1250000.5');
    expect(parseLooseNumber('1.250.000,75', 2)).toBe('1250000.75');
    expect(parseLooseNumber('25,5', 2)).toBe('25.5');
    expect(parseLooseNumber('1,250', 0)).toBe('1250');
    expect(parseLooseNumber('abc', 0)).toBe('');
  });
});

describe('canonicalNumber', () => {
  it('chuẩn hóa để so sánh', () => {
    expect(canonicalNumber('0100.500')).toBe('100.5');
    expect(canonicalNumber(42)).toBe('42');
    expect(canonicalNumber('')).toBe('');
  });
});
