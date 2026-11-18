/**
 * Mã khách hàng tự sinh (CUS-CODE-01, 17/11/2026 — người dùng: "mã KH tự sinh phải sát với số mã KH tiếp theo, xóa khách
 * còn trống số nào thì khách mới lấp vào số đó, không cách xa dãy số"): lấy **số trống nhỏ nhất** từ KH001 trở đi.
 * KH000 là khách lẻ showroom & online nên không bao giờ cấp. KH020 và KH0020 coi là cùng số 20.
 */
const CUSTOMER_CODE = /^KH(\d+)$/;

export function customerCodeNumber(code: string): number | null {
  const match = CUSTOMER_CODE.exec(code.trim());
  return match ? Number(match[1]) : null;
}

export function formatCustomerCode(value: number): string {
  return `KH${String(value).padStart(3, '0')}`;
}

export interface NextCustomerCode {
  /** Mã sẽ cấp: số trống nhỏ nhất ≥ 1. */
  code: string;
  /** Mã KH lớn nhất đang có (null khi chưa có mã KH nào ngoài KH000). */
  highest: string | null;
  /** true khi mã cấp là một số trống nằm giữa dãy (nhỏ hơn mã lớn nhất). */
  fillsGap: boolean;
}

export function nextFreeCustomerCode(codes: Iterable<string>): NextCustomerCode {
  const used = new Set<number>();
  let highest: { value: number; code: string } | null = null;
  for (const code of codes) {
    const value = customerCodeNumber(code);
    if (value === null || value < 1) continue;
    used.add(value);
    if (!highest || value > highest.value) highest = { value, code: code.trim() };
  }
  let next = 1;
  while (used.has(next)) next += 1;
  return { code: formatCustomerCode(next), highest: highest?.code ?? null, fillsGap: Boolean(highest && next < highest.value) };
}
