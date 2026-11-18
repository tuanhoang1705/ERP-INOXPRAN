import type { Document } from 'mongodb';

/**
 * Thứ tự danh sách phiếu trả hàng (NK-SORT-01, 18/11/2026 — người dùng: "danh sách lộn xộn, không đúng số thứ tự"): mới nhất → cũ
 * nhất theo SỐ PHIẾU — tháng trên số (yyyymm) giảm dần, rồi số thứ tự giảm dần — không theo lúc bấm lưu. Phiếu lập bù số giấy cũ
 * (VD NK2026100040 lập ngày 18/11) nằm đúng chỗ của số đó trong tháng 10. Cùng số: phiếu đang dùng trước, phiếu đã hủy (…-H1) sau.
 * Mã không đúng dạng (dữ liệu rất cũ) xuống cuối. Sắp xếp trong CSDL rồi mới cắt trang ($sort + $limit chỉ giữ số dòng của trang).
 */
export const RETURN_NUMBER_PATTERN = '^[A-Z]+(20\\d{2}(?:0[1-9]|1[0-2]))(\\d{4,5})';

export function returnListOrder(): Document[] {
  return [
    { $addFields: { _number: { $regexFind: { input: { $ifNull: ['$code', ''] }, regex: RETURN_NUMBER_PATTERN } } } },
    {
      $addFields: {
        _period: { $ifNull: [{ $arrayElemAt: ['$_number.captures', 0] }, ''] },
        _seq: { $convert: { input: { $arrayElemAt: ['$_number.captures', 1] }, to: 'int', onError: -1, onNull: -1 } },
      },
    },
    { $sort: { _period: -1, _seq: -1, code: 1, createdAt: -1, _id: -1 } },
  ];
}

export const RETURN_ORDER_FIELDS = ['_number', '_period', '_seq'];
