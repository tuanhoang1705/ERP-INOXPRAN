import { canDeliverOrder, canShipOrder, isKeeperOnly, KEEPER_ROLES } from '@inoxpran/contracts';
import type { Document } from 'mongodb';
import { ObjectId } from 'mongodb';
import { seesCancelled } from '../../common/hidden-documents';
import type { RequestUser } from '../../common/request-context';

export { isKeeperOnly, KEEPER_ROLES };

type ScopeUser = Pick<RequestUser, 'roles' | 'sub' | 'root' | 'permissions'>;

const keeperOf = (order: Document) => (order.warehouseKeeperId as ObjectId | undefined)?.toHexString();

/**
 * Điều kiện lọc phiếu theo người xem (rỗng = xem tất cả). Thủ kho thuần (vai trò WAREHOUSE, không kiêm vai trò xem toàn bộ,
 * không được phân bước văn phòng — SAL-STEP-01) chỉ thấy phiếu kế toán chọn mình làm thủ kho, sau khi phát hành.
 * Phiếu đã hủy chỉ quản trị gốc thấy (DOC-HIDE-01): danh sách, chi tiết, Tổng quan, ảnh đối chiếu, tạo đề nghị.
 */
export function salesOrderScope(user: ScopeUser): Document {
  if (isKeeperOnly(user)) return { warehouseKeeperId: new ObjectId(user.sub), status: { $nin: ['DRAFT', 'CANCELLED'] } };
  return seesCancelled(user) ? {} : { status: { $ne: 'CANCELLED' } };
}

/** Lập SWK & xuất kho phiếu này: được phân công bước 4 và là thủ kho của phiếu (ADMIN luôn được). */
export function isAssignedKeeper(user: ScopeUser, order: Document): boolean {
  return canShipOrder(user, keeperOf(order));
}

/** Xác nhận giao phiếu này (bước 5): người có vai trò kho chỉ phiếu mình là thủ kho; người khác được phân bước 5 giao mọi phiếu. */
export function canDeliverSalesOrder(user: ScopeUser, order: Document): boolean {
  return canDeliverOrder(user, keeperOf(order));
}
