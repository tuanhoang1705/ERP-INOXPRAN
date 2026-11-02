import type { Db, Document } from 'mongodb';
import { seesCancelled, type Viewer } from '../../common/hidden-documents';

/**
 * Dòng thẻ kho của chứng từ đã hủy coi như đã xóa (DOC-HIDE-01, 27/10/2026): chỉ quản trị gốc còn thấy.
 * - Phiếu trả hàng đã hủy: dòng gốc + dòng đảo cùng ngày luôn bù trừ về 0.
 * - Phiếu BH hủy sau khi giao: dòng xuất + dòng nhập lại (khác ngày) — chỉ ẩn khi cộng lại về 0 theo kho × mã. Khách đã trả
 *   một phần (phiếu TH còn hiệu lực) thì phần nhập lại nhỏ hơn phần xuất → giữ hiện để tồn chạy không lệch.
 * Ẩn đi thì thẻ kho / nhật ký hiện như chứng từ chưa từng có; tồn hiện tại không đổi. Báo cáo tồn tháng giữ số tổng (không lọc).
 * Trả về điều kiện lọc inventory_movements cho người xem, `null` khi không cần lọc.
 */
export async function hiddenMovementFilter(db: Db, viewer: Viewer): Promise<Document | null> {
  if (seesCancelled(viewer)) return null;
  const [returnCodes, shipmentCodes, slipNos] = await Promise.all([
    db.collection('stock_returns').distinct('code', { status: 'VOIDED' }),
    db.collection('shipments').distinct('code', { status: 'CANCELLED' }),
    db.collection('sales_orders').distinct('warehouseSlipNo', { status: 'CANCELLED', voidedAfterShipment: true }),
  ]);
  const candidates = [...new Set([...shipmentCodes, ...slipNos].filter(Boolean).map(String))];
  const unbalanced = candidates.length
    ? await db.collection('inventory_movements').aggregate([
      { $match: { referenceType: 'Shipment', referenceId: { $in: candidates } } },
      { $group: { _id: { ref: '$referenceId', warehouseId: '$warehouseId', productId: '$productId' }, net: { $sum: { $cond: [{ $eq: ['$direction', 'IN'] }, '$quantity', { $multiply: ['$quantity', -1] }] } } } },
      { $match: { net: { $ne: 0 } } },
      { $group: { _id: '$_id.ref' } },
    ]).toArray()
    : [];
  const skip = new Set(unbalanced.map((row) => String(row._id)));
  const shipments = candidates.filter((code) => !skip.has(code));
  const hidden: Document[] = [
    ...(returnCodes.length ? [{ referenceType: 'StockReturn', referenceId: { $in: returnCodes } }] : []),
    ...(shipments.length ? [{ referenceType: 'Shipment', referenceId: { $in: shipments } }] : []),
  ];
  return hidden.length ? { $nor: hidden } : null;
}
