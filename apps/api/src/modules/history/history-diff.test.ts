import { describe, expect, it } from 'vitest';
import { diffFields } from './history-diff';

describe('diffFields', () => {
  it('chỉ trả trường đổi, bỏ trường hệ thống', () => {
    const before = { id: '1', name: 'Bồn rửa', listPrice: '100', version: 1, updatedAt: 'a', contacts: [{ name: 'An' }] };
    const after = { id: '1', name: 'Bồn rửa inox', listPrice: '100', version: 2, updatedAt: 'b', contacts: [{ name: 'An' }, { name: 'Bình' }], hsCode: '7324' };
    expect(diffFields(before, after)).toEqual([
      { field: 'contacts', before: [{ name: 'An' }], after: [{ name: 'An' }, { name: 'Bình' }] },
      { field: 'hsCode', after: '7324' },
      { field: 'name', before: 'Bồn rửa', after: 'Bồn rửa inox' },
    ]);
  });

  it('không có bản trước hoặc sau (tạo / xóa / thao tác khác) thì không liệt kê trường', () => {
    expect(diffFields(undefined, { name: 'x' })).toEqual([]);
    expect(diffFields({ name: 'x' }, null)).toEqual([]);
  });
});
