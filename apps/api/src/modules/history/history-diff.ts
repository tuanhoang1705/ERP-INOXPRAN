/** Trường hệ thống không hiển thị trong tab "Lịch sử". */
const IGNORED = new Set(['id', '_id', 'version', 'createdAt', 'updatedAt', 'createdBy']);

const same = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

/**
 * So sánh bản trước / sau (đã serialize) của một lần sửa: trả các trường cấp một có thay đổi.
 * Mảng / đối tượng lồng (người liên hệ, dòng hàng…) so nguyên khối và trả cả giá trị cũ / mới.
 */
export function diffFields(before: unknown, after: unknown): Array<{ field: string; before?: unknown; after?: unknown }> {
  const left = before && typeof before === 'object' ? (before as Record<string, unknown>) : {};
  const right = after && typeof after === 'object' ? (after as Record<string, unknown>) : {};
  if (!before || !after) return [];
  const keys = [...new Set([...Object.keys(left), ...Object.keys(right)])].filter((key) => !IGNORED.has(key)).sort();
  return keys
    .filter((key) => !same(left[key], right[key]))
    .map((key) => ({ field: key, ...(left[key] !== undefined ? { before: left[key] } : {}), ...(right[key] !== undefined ? { after: right[key] } : {}) }));
}
