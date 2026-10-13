import type { Document } from 'mongodb';
import { ObjectId } from 'mongodb';
import type { RequestUser } from '../../common/request-context';

/** Vai trò được xem toàn bộ phiếu xuất kho bán hàng (quản lý kho xem hết để điều phối, nhưng chỉ thao tác phiếu giao cho mình). */
const FULL_VIEW_ROLES = ['ADMIN', 'DIRECTOR', 'ACCOUNTANT', 'SALES', 'SALES_MANAGER', 'AUDITOR', 'WAREHOUSE_MANAGER'];
export const KEEPER_ROLES = ['WAREHOUSE', 'WAREHOUSE_MANAGER'];

/**
 * Nhân viên thủ kho (vai trò WAREHOUSE, không kiêm vai trò xem toàn bộ): chỉ thấy phiếu kế toán đã chọn mình
 * làm thủ kho xuất hàng, và chỉ sau khi phiếu đã phát hành (không thấy nháp / phiếu hủy).
 */
export function isKeeperOnly(user: Pick<RequestUser, 'roles'>): boolean {
  return user.roles.includes('WAREHOUSE') && !user.roles.some((role) => FULL_VIEW_ROLES.includes(role));
}

/**
 * Phiếu do quản trị gốc hủy (ROOT-DEL-02, 13/10/2026) mang cờ `staffHidden`: chỉ quản trị gốc, Admin, Giám đốc, kế toán, kiểm soát
 * còn thấy (nhãn "Đã hủy" + lý do); NVKD, thủ kho, mua hàng… không thấy phiếu, dòng thẻ kho, công nợ, yêu cầu duyệt gắn với phiếu.
 */
const STAFF_HIDDEN_VIEW_ROLES = ['ADMIN', 'DIRECTOR', 'ACCOUNTANT', 'AUDITOR'];
export function seesStaffHidden(user: Pick<RequestUser, 'roles'> & { root?: boolean | undefined }): boolean {
  return Boolean(user.root) || user.roles.some((role) => STAFF_HIDDEN_VIEW_ROLES.includes(role));
}
/** Điều kiện bỏ bản ghi ẩn với nhân viên (rỗng nếu người xem được thấy). */
export function staffHiddenFilter(user: Pick<RequestUser, 'roles'> & { root?: boolean | undefined }): Document {
  return seesStaffHidden(user) ? {} : { staffHidden: { $ne: true } };
}

/** Điều kiện lọc phiếu theo người xem (rỗng = xem tất cả). */
export function salesOrderScope(user: Pick<RequestUser, 'roles' | 'sub'> & { root?: boolean | undefined }): Document {
  if (!isKeeperOnly(user)) return staffHiddenFilter(user);
  return { warehouseKeeperId: new ObjectId(user.sub), status: { $nin: ['DRAFT', 'CANCELLED'] } };
}

/** Người dùng có phải thủ kho được giao phiếu này (ADMIN luôn được). */
export function isAssignedKeeper(user: Pick<RequestUser, 'roles' | 'sub'>, order: Document): boolean {
  if (user.roles.includes('ADMIN')) return true;
  const keeperId = order.warehouseKeeperId as ObjectId | undefined;
  return Boolean(keeperId && keeperId.toHexString() === user.sub);
}
