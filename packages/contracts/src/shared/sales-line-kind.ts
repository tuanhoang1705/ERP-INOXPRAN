/** Dòng hàng khác trên phiếu bán: không tính tiền nhưng vẫn giữ chỗ / xuất kho như hàng tặng cũ. */
export const ZERO_PRICE_KINDS = ['GIFT', 'EXCHANGE', 'COMPENSATION'] as const;
export type ZeroPriceKind = (typeof ZERO_PRICE_KINDS)[number];

export interface ZeroPriceLine {
  /** Cờ tương thích với phiếu cũ và các luồng kho / trả hàng. Cả ba loại đều được lưu gift=true. */
  gift?: boolean | undefined;
  zeroPriceKind?: ZeroPriceKind | undefined;
}

/** Phiếu cũ chỉ có gift=true vẫn là hàng tặng; dòng bán thường không có loại hàng khác. */
export function zeroPriceKindOf(line: ZeroPriceLine): ZeroPriceKind | undefined {
  return line.zeroPriceKind ?? (line.gift ? 'GIFT' : undefined);
}

export function isZeroPriceLine(line: ZeroPriceLine): boolean {
  return zeroPriceKindOf(line) !== undefined;
}

/** Bản in BH / SWK luôn dùng tiếng Việt. */
export const ZERO_PRICE_LABEL_VI: Record<ZeroPriceKind, string> = {
  GIFT: 'Hàng tặng',
  EXCHANGE: 'Hàng đổi',
  COMPENSATION: 'Hàng bù',
};
