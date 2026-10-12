/**
 * zod `.partial()` vẫn điền giá trị `.default()` cho trường không gửi lên (VD: status → ACTIVE, unitConversions → []).
 * Khi sửa chỉ giữ các trường có trong thân request gốc để không ghi đè dữ liệu người dùng không đụng tới.
 */
export function onlyProvided<T extends object>(raw: unknown, parsed: T): Partial<T> {
  const keys = new Set(raw && typeof raw === 'object' ? Object.keys(raw) : []);
  return Object.fromEntries(Object.entries(parsed).filter(([key]) => keys.has(key))) as Partial<T>;
}
