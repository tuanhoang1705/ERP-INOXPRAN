/**
 * Nhãn song ngữ dùng chung cho file Excel báo cáo (XLS-BI-01, 20/11/2026) — chữ Trung cùng chữ với giao diện (zh.json).
 */

export const TIER_LABELS: Record<string, string> = { TIER_1: 'NPP · Cấp 1', TIER_2: 'Đại lý · Cấp 2', RETAIL: 'Khách lẻ' };
/** Cấp khách tiếng Trung (cap_1_nha_phan_phoi, cap_2_dai_ly, khach_le). */
export const TIER_ZH: Record<string, string> = { TIER_1: '一级分销商', TIER_2: '二级经销商', RETAIL: '零售客户' };
const TIER_BY_LABEL = new Map(Object.entries(TIER_LABELS).map(([code, label]) => [label, code]));

/** "NPP · Cấp 1" → "NPP · Cấp 1 一级分销商" (nhãn lạ giữ nguyên). */
export function tierBi(label: string): string {
  const code = TIER_BY_LABEL.get(label);
  return code ? `${label} ${TIER_ZH[code]}` : label;
}

/** Khu vực do hệ thống đặt tên (không phải tên tỉnh) thêm tiếng Trung; tên tỉnh giữ nguyên. */
export function regionBi(code: string | undefined, name: string): string {
  if (code === 'B2C') return `${name} 零售渠道（B2C）`;
  if (code === 'OTHER' || name === 'Chưa có tỉnh') return `${name} 未填省份`;
  return name;
}

/** "Tháng 11/2026" hoặc "11/2026" → "2026年11月"; khoảng ngày giữ nguyên. */
export function periodZh(label: string): string {
  return label.replace(/^(?:Tháng )?(\d{1,2})\/(\d{4})$/, (_, month: string, year: string) => `${year}年${Number(month)}月`);
}

/** Bỏ đuôi chiều "（入库）" / "（出库）" của tên loại phát sinh tiếng Trung — dùng khi cột đã rõ chiều (hàng khách trả). */
export function categoryZhShort(zh: string): string {
  return zh.replace(/（(?:入库|出库)）$/, '');
}
