/**
 * Danh mục tỉnh / thành phố (PV-01, 30/10/2026): 63 tỉnh cũ và 34 tỉnh mới sau sắp xếp đơn vị hành chính có hiệu lực 01/07/2025.
 * Phân vùng NVKD gán theo **tỉnh cũ** (chi tiết hơn — VD Hải Dương cũ và Hải Phòng cũ cùng thuộc Hải Phòng mới nhưng có thể do
 * hai người phụ trách); tỉnh mới suy ra từ tỉnh cũ. Mã tỉnh cũ trùng mã "khu vực" cũ của hệ thống (HAI-DUONG, THAI-BINH…).
 */
export interface NewProvince {
  code: string;
  name: string;
}
export interface OldProvince {
  code: string;
  name: string;
  /** Tỉnh mới chứa tỉnh cũ này. */
  newCode: string;
}

export const NEW_PROVINCES = [
  { code: 'HA-NOI', name: 'Hà Nội' },
  { code: 'HUE', name: 'Huế' },
  { code: 'LAI-CHAU', name: 'Lai Châu' },
  { code: 'DIEN-BIEN', name: 'Điện Biên' },
  { code: 'SON-LA', name: 'Sơn La' },
  { code: 'LANG-SON', name: 'Lạng Sơn' },
  { code: 'QUANG-NINH', name: 'Quảng Ninh' },
  { code: 'THANH-HOA', name: 'Thanh Hóa' },
  { code: 'NGHE-AN', name: 'Nghệ An' },
  { code: 'HA-TINH', name: 'Hà Tĩnh' },
  { code: 'CAO-BANG', name: 'Cao Bằng' },
  { code: 'TUYEN-QUANG', name: 'Tuyên Quang' },
  { code: 'LAO-CAI', name: 'Lào Cai' },
  { code: 'THAI-NGUYEN', name: 'Thái Nguyên' },
  { code: 'PHU-THO', name: 'Phú Thọ' },
  { code: 'BAC-NINH', name: 'Bắc Ninh' },
  { code: 'HUNG-YEN', name: 'Hưng Yên' },
  { code: 'HAI-PHONG', name: 'Hải Phòng' },
  { code: 'NINH-BINH', name: 'Ninh Bình' },
  { code: 'QUANG-TRI', name: 'Quảng Trị' },
  { code: 'DA-NANG', name: 'Đà Nẵng' },
  { code: 'QUANG-NGAI', name: 'Quảng Ngãi' },
  { code: 'GIA-LAI', name: 'Gia Lai' },
  { code: 'KHANH-HOA', name: 'Khánh Hòa' },
  { code: 'LAM-DONG', name: 'Lâm Đồng' },
  { code: 'DAK-LAK', name: 'Đắk Lắk' },
  { code: 'HO-CHI-MINH', name: 'TP Hồ Chí Minh' },
  { code: 'DONG-NAI', name: 'Đồng Nai' },
  { code: 'TAY-NINH', name: 'Tây Ninh' },
  { code: 'CAN-THO', name: 'Cần Thơ' },
  { code: 'VINH-LONG', name: 'Vĩnh Long' },
  { code: 'DONG-THAP', name: 'Đồng Tháp' },
  { code: 'CA-MAU', name: 'Cà Mau' },
  { code: 'AN-GIANG', name: 'An Giang' },
] as const satisfies readonly NewProvince[];

export const OLD_PROVINCES = [
  { code: 'HA-NOI', name: 'Hà Nội', newCode: 'HA-NOI' },
  { code: 'HA-GIANG', name: 'Hà Giang', newCode: 'TUYEN-QUANG' },
  { code: 'CAO-BANG', name: 'Cao Bằng', newCode: 'CAO-BANG' },
  { code: 'BAC-KAN', name: 'Bắc Kạn', newCode: 'THAI-NGUYEN' },
  { code: 'TUYEN-QUANG', name: 'Tuyên Quang', newCode: 'TUYEN-QUANG' },
  { code: 'LAO-CAI', name: 'Lào Cai', newCode: 'LAO-CAI' },
  { code: 'DIEN-BIEN', name: 'Điện Biên', newCode: 'DIEN-BIEN' },
  { code: 'LAI-CHAU', name: 'Lai Châu', newCode: 'LAI-CHAU' },
  { code: 'SON-LA', name: 'Sơn La', newCode: 'SON-LA' },
  { code: 'YEN-BAI', name: 'Yên Bái', newCode: 'LAO-CAI' },
  { code: 'HOA-BINH', name: 'Hòa Bình', newCode: 'PHU-THO' },
  { code: 'THAI-NGUYEN', name: 'Thái Nguyên', newCode: 'THAI-NGUYEN' },
  { code: 'LANG-SON', name: 'Lạng Sơn', newCode: 'LANG-SON' },
  { code: 'QUANG-NINH', name: 'Quảng Ninh', newCode: 'QUANG-NINH' },
  { code: 'BAC-GIANG', name: 'Bắc Giang', newCode: 'BAC-NINH' },
  { code: 'PHU-THO', name: 'Phú Thọ', newCode: 'PHU-THO' },
  { code: 'VINH-PHUC', name: 'Vĩnh Phúc', newCode: 'PHU-THO' },
  { code: 'BAC-NINH', name: 'Bắc Ninh', newCode: 'BAC-NINH' },
  { code: 'HAI-DUONG', name: 'Hải Dương', newCode: 'HAI-PHONG' },
  { code: 'HAI-PHONG', name: 'Hải Phòng', newCode: 'HAI-PHONG' },
  { code: 'HUNG-YEN', name: 'Hưng Yên', newCode: 'HUNG-YEN' },
  { code: 'THAI-BINH', name: 'Thái Bình', newCode: 'HUNG-YEN' },
  { code: 'HA-NAM', name: 'Hà Nam', newCode: 'NINH-BINH' },
  { code: 'NAM-DINH', name: 'Nam Định', newCode: 'NINH-BINH' },
  { code: 'NINH-BINH', name: 'Ninh Bình', newCode: 'NINH-BINH' },
  { code: 'THANH-HOA', name: 'Thanh Hóa', newCode: 'THANH-HOA' },
  { code: 'NGHE-AN', name: 'Nghệ An', newCode: 'NGHE-AN' },
  { code: 'HA-TINH', name: 'Hà Tĩnh', newCode: 'HA-TINH' },
  { code: 'QUANG-BINH', name: 'Quảng Bình', newCode: 'QUANG-TRI' },
  { code: 'QUANG-TRI', name: 'Quảng Trị', newCode: 'QUANG-TRI' },
  { code: 'THUA-THIEN-HUE', name: 'Thừa Thiên Huế', newCode: 'HUE' },
  { code: 'DA-NANG', name: 'Đà Nẵng', newCode: 'DA-NANG' },
  { code: 'QUANG-NAM', name: 'Quảng Nam', newCode: 'DA-NANG' },
  { code: 'QUANG-NGAI', name: 'Quảng Ngãi', newCode: 'QUANG-NGAI' },
  { code: 'BINH-DINH', name: 'Bình Định', newCode: 'GIA-LAI' },
  { code: 'PHU-YEN', name: 'Phú Yên', newCode: 'DAK-LAK' },
  { code: 'KHANH-HOA', name: 'Khánh Hòa', newCode: 'KHANH-HOA' },
  { code: 'NINH-THUAN', name: 'Ninh Thuận', newCode: 'KHANH-HOA' },
  { code: 'BINH-THUAN', name: 'Bình Thuận', newCode: 'LAM-DONG' },
  { code: 'KON-TUM', name: 'Kon Tum', newCode: 'QUANG-NGAI' },
  { code: 'GIA-LAI', name: 'Gia Lai', newCode: 'GIA-LAI' },
  { code: 'DAK-LAK', name: 'Đắk Lắk', newCode: 'DAK-LAK' },
  { code: 'DAK-NONG', name: 'Đắk Nông', newCode: 'LAM-DONG' },
  { code: 'LAM-DONG', name: 'Lâm Đồng', newCode: 'LAM-DONG' },
  { code: 'BINH-PHUOC', name: 'Bình Phước', newCode: 'DONG-NAI' },
  { code: 'TAY-NINH', name: 'Tây Ninh', newCode: 'TAY-NINH' },
  { code: 'BINH-DUONG', name: 'Bình Dương', newCode: 'HO-CHI-MINH' },
  { code: 'DONG-NAI', name: 'Đồng Nai', newCode: 'DONG-NAI' },
  { code: 'BA-RIA-VUNG-TAU', name: 'Bà Rịa – Vũng Tàu', newCode: 'HO-CHI-MINH' },
  { code: 'HO-CHI-MINH', name: 'TP Hồ Chí Minh', newCode: 'HO-CHI-MINH' },
  { code: 'LONG-AN', name: 'Long An', newCode: 'TAY-NINH' },
  { code: 'TIEN-GIANG', name: 'Tiền Giang', newCode: 'DONG-THAP' },
  { code: 'BEN-TRE', name: 'Bến Tre', newCode: 'VINH-LONG' },
  { code: 'TRA-VINH', name: 'Trà Vinh', newCode: 'VINH-LONG' },
  { code: 'VINH-LONG', name: 'Vĩnh Long', newCode: 'VINH-LONG' },
  { code: 'DONG-THAP', name: 'Đồng Tháp', newCode: 'DONG-THAP' },
  { code: 'AN-GIANG', name: 'An Giang', newCode: 'AN-GIANG' },
  { code: 'KIEN-GIANG', name: 'Kiên Giang', newCode: 'AN-GIANG' },
  { code: 'CAN-THO', name: 'Cần Thơ', newCode: 'CAN-THO' },
  { code: 'HAU-GIANG', name: 'Hậu Giang', newCode: 'CAN-THO' },
  { code: 'SOC-TRANG', name: 'Sóc Trăng', newCode: 'CAN-THO' },
  { code: 'BAC-LIEU', name: 'Bạc Liêu', newCode: 'CA-MAU' },
  { code: 'CA-MAU', name: 'Cà Mau', newCode: 'CA-MAU' },
] as const satisfies readonly OldProvince[];

export type NewProvinceCode = (typeof NEW_PROVINCES)[number]['code'];
export type OldProvinceCode = (typeof OLD_PROVINCES)[number]['code'];
export const NEW_PROVINCE_CODES = NEW_PROVINCES.map((item) => item.code) as [NewProvinceCode, ...NewProvinceCode[]];
export const OLD_PROVINCE_CODES = OLD_PROVINCES.map((item) => item.code) as [OldProvinceCode, ...OldProvinceCode[]];

const OLD_BY_CODE = new Map<string, OldProvince>(OLD_PROVINCES.map((item) => [item.code, item]));
const NEW_BY_CODE = new Map<string, NewProvince>(NEW_PROVINCES.map((item) => [item.code, item]));

export function oldProvince(code: string | null | undefined): OldProvince | undefined {
  return code ? OLD_BY_CODE.get(code) : undefined;
}
export function newProvince(code: string | null | undefined): NewProvince | undefined {
  return code ? NEW_BY_CODE.get(code) : undefined;
}
/** Các tỉnh cũ gộp thành một tỉnh mới. */
export function oldProvincesOf(newCode: string): OldProvince[] {
  return OLD_PROVINCES.filter((item) => item.newCode === newCode);
}
export function newProvinceOf(oldCode: string): NewProvince | undefined {
  return newProvince(oldProvince(oldCode)?.newCode);
}
/** Tên hiển thị tỉnh cũ, VD "Hải Dương (nay Hải Phòng)"; tỉnh giữ nguyên chỉ ghi tên. */
export function provinceLabel(oldCode: string | null | undefined): string {
  const old = oldProvince(oldCode);
  if (!old) return '';
  const current = newProvince(old.newCode);
  return current && current.name !== old.name ? `${old.name} (nay ${current.name})` : old.name;
}

/** Bỏ dấu, chữ thường, gộp khoảng trắng — để dò tên tỉnh trong địa chỉ gõ tay. */
export function foldVietnamese(text: string): string {
  return text.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/đ/gi, 'd').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

const ALIASES: Array<[string, string]> = [
  ['tp hcm', 'HO-CHI-MINH'], ['hcm', 'HO-CHI-MINH'], ['sai gon', 'HO-CHI-MINH'], ['ho chi minh', 'HO-CHI-MINH'],
  ['hue', 'THUA-THIEN-HUE'], ['ba ria', 'BA-RIA-VUNG-TAU'], ['vung tau', 'BA-RIA-VUNG-TAU'], ['dak lak', 'DAK-LAK'], ['dac lac', 'DAK-LAK'],
  ['dak nong', 'DAK-NONG'], ['bac can', 'BAC-KAN'],
];

/**
 * Dò tỉnh trong một đoạn địa chỉ. Trả tỉnh cũ khi chắc chắn (tên tỉnh cũ đã bị sáp nhập như "Vĩnh Phúc", "Hải Dương", hoặc tỉnh
 * mới chỉ có một tỉnh cũ như Hà Nội, Thanh Hóa), luôn trả tỉnh mới khi dò được. Địa chỉ ghi tên tỉnh mới đã sáp nhập (VD "Tỉnh Phú Thọ")
 * thì chỉ có tỉnh mới — không đoán tỉnh cũ.
 */
export function matchProvince(text: string | null | undefined): { oldCode?: string; newCode?: string } {
  const folded = ` ${foldVietnamese(text ?? '')} `;
  if (!folded.trim()) return {};
  const found: Array<{ index: number; code: string }> = [];
  const names: Array<[string, string]> = [...OLD_PROVINCES.map((item) => [foldVietnamese(item.name), item.code] as [string, string]), ...ALIASES];
  for (const [name, code] of names) {
    const index = folded.lastIndexOf(` ${name} `);
    if (index >= 0) found.push({ index, code });
  }
  if (!found.length) return {};
  // Tỉnh thường đứng cuối địa chỉ: lấy tên xuất hiện sau cùng (dài hơn khi cùng vị trí).
  found.sort((a, b) => b.index - a.index);
  const old = oldProvince(found[0]!.code)!;
  const merged = oldProvincesOf(old.newCode);
  // Tên trùng tỉnh mới đã sáp nhập (VD "Phú Thọ" = tỉnh mới gồm 3 tỉnh cũ) → không chắc tỉnh cũ.
  if (merged.length > 1 && newProvince(old.newCode)?.name === old.name) return { newCode: old.newCode };
  return { oldCode: old.code, newCode: old.newCode };
}

/**
 * Tỉnh của một khách, kể cả dữ liệu trước phân vùng: ưu tiên mã tỉnh đã lưu; không có thì suy từ mã khu vực cũ (trùng mã tỉnh cũ;
 * HN-LE / HN-NPP = Hà Nội) rồi tới tên tỉnh ghi tay.
 */
export function customerProvince(customer: Readonly<Record<string, unknown>>): { oldCode?: string; newCode?: string } {
  const old = oldProvince(typeof customer.provinceOldCode === 'string' ? customer.provinceOldCode : undefined);
  if (old) return { oldCode: old.code, newCode: old.newCode };
  if (typeof customer.provinceNewCode === 'string' && newProvince(customer.provinceNewCode)) return { newCode: customer.provinceNewCode };
  const region = typeof customer.regionCode === 'string' ? customer.regionCode : '';
  const fromRegion = oldProvince(region) ?? (region.startsWith('HN-') ? oldProvince('HA-NOI') : undefined);
  if (fromRegion) return { oldCode: fromRegion.code, newCode: fromRegion.newCode };
  return matchProvince(typeof customer.province === 'string' ? customer.province : '');
}

/** Tên tỉnh để báo cáo: tỉnh mới, kèm tỉnh cũ nếu khác tên — VD "Hải Phòng (Hải Dương cũ)". */
export function provinceReportName(province: { oldCode?: string; newCode?: string }): string {
  const current = newProvince(province.newCode);
  if (!current) return '';
  const old = oldProvince(province.oldCode);
  return old && old.name !== current.name ? `${current.name} (${old.name} cũ)` : current.name;
}
