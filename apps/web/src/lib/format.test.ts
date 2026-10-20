import { describe, expect, it } from 'vitest';
import { num, vnd } from './format';

describe('num / vnd', () => {
  it('số âm dưới 1 đồng (số lẻ sổ cũ) hiện 0, không hiện -0', () => {
    expect(num('-0.32')).toBe('0');
    expect(num(-0)).toBe('0');
    expect(vnd('-0.02').startsWith('0 ')).toBe(true);
  });
  it('số âm từ 1 đồng trở lên giữ dấu', () => {
    expect(num('-1.4')).toMatch(/^[-−]1$/);
    expect(vnd('-7120000')).toMatch(/^[-−]7[.,]120[.,]000 /);
  });
});
