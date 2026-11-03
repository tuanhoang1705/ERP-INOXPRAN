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

/** Hàng khác (tặng / đổi / bù) luôn ở cuối phiếu (03/11/2026): dòng hàng bán trước, giữ nguyên thứ tự trong từng nhóm. */
export function otherLinesLast<T extends ZeroPriceLine>(lines: readonly T[]): T[] {
  return [...lines.filter((line) => !isZeroPriceLine(line)), ...lines.filter((line) => isZeroPriceLine(line))];
}

/**
 * Phiếu bán B2B / B2C (03/11/2026): dòng hàng bán phải có đơn giá lớn hơn 0 — hàng không tính tiền thêm bằng "Thêm hàng khác"
 * (tặng / đổi / bù), xuất mẫu / kiểm định / tặng chọn đúng Loại phiếu để kho phân loại đúng. Trả về vị trí dòng hàng bán đầu
 * tiên có đơn giá 0 (hoặc -1).
 */
export function zeroPricedSaleLine(lines: ReadonlyArray<ZeroPriceLine & { unitPrice: unknown }>): number {
  return lines.findIndex((line) => !isZeroPriceLine(line) && !(Number(String(line.unitPrice)) > 0));
}

/** Bản in BH / SWK luôn dùng tiếng Việt. */
export const ZERO_PRICE_LABEL_VI: Record<ZeroPriceKind, string> = {
  GIFT: 'Hàng tặng',
  EXCHANGE: 'Hàng đổi',
  COMPENSATION: 'Hàng bù',
};
