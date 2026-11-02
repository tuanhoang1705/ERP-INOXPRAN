import type { PermissionKey, SalesStepKey } from './permissions';

/**
 * 5 bước phiếu xuất kho bán hàng (SAL-STEP-01, 26/10/2026) — mỗi bước là một quyền theo tài khoản (permissions.ts), Admin
 * phân công. Luật dùng chung cho API (kiểm tra thật) và giao diện (ẩn / hiện nút):
 * - bước 4 (xuất kho): người giữ bước VÀ là thủ kho kế toán chọn trên phiếu;
 * - bước 5 (xác nhận giao): người giữ bước — người có vai trò kho chỉ xác nhận phiếu mình là thủ kho, người khác được tích
 *   bước 5 xác nhận mọi phiếu đã xuất.
 */
export const SALES_STEPS = [
  { n: 1, key: 'sales.step.create', vi: 'Lập phiếu', zh: '开单' },
  { n: 2, key: 'sales.step.issue', vi: 'KT phát hành', zh: '会计发出' },
  { n: 3, key: 'sales.step.confirm', vi: 'Đối chiếu khách', zh: '客户核对' },
  { n: 4, key: 'sales.step.ship', vi: 'Kho xuất SWK', zh: '仓库出库' },
  { n: 5, key: 'sales.step.deliver', vi: 'Giao thành công', zh: '确认送达' },
] as const satisfies ReadonlyArray<{ n: number; key: SalesStepKey; vi: string; zh: string }>;

/** Vai trò kho (thủ kho). */
export const KEEPER_ROLES: readonly string[] = ['WAREHOUSE', 'WAREHOUSE_MANAGER'];
/** Vai trò xem toàn bộ phiếu bán (quản lý kho xem hết để điều phối, nhưng chỉ thao tác phiếu giao cho mình). */
export const SALES_FULL_VIEW_ROLES: readonly string[] = ['ADMIN', 'DIRECTOR', 'ACCOUNTANT', 'SALES', 'SALES_MANAGER', 'AUDITOR', 'WAREHOUSE_MANAGER'];
/** Bước làm ở văn phòng (lập, phát hành, đối chiếu): người giữ bước này xem được phiếu nháp và mọi phiếu. */
export const OFFICE_STEP_KEYS: readonly SalesStepKey[] = ['sales.step.create', 'sales.step.issue', 'sales.step.confirm'];

/** Người thao tác (request.user ở API, session.user ở giao diện). */
export interface StepActor {
  sub: string;
  roles: readonly string[];
  root?: boolean | undefined;
  permissions?: readonly string[] | undefined;
}

export function holds(actor: StepActor, key: PermissionKey): boolean {
  return Boolean(actor.root) || Boolean(actor.permissions?.includes(key));
}

export function hasKeeperRole(roles: readonly string[]): boolean {
  return roles.some((role) => KEEPER_ROLES.includes(role));
}

/**
 * Thủ kho thuần (vai trò WAREHOUSE, không kiêm vai trò xem toàn bộ, không được phân bước văn phòng): chỉ thấy phiếu kế toán
 * chọn mình làm thủ kho, sau khi phát hành.
 */
export function isKeeperOnly(actor: Pick<StepActor, 'roles' | 'root' | 'permissions'>): boolean {
  if (actor.root || !actor.roles.includes('WAREHOUSE') || actor.roles.some((role) => SALES_FULL_VIEW_ROLES.includes(role))) return false;
  return !OFFICE_STEP_KEYS.some((key) => actor.permissions?.includes(key));
}

const isAdmin = (actor: StepActor) => Boolean(actor.root) || actor.roles.includes('ADMIN');

/** Lập SWK & xuất kho phiếu này: giữ bước 4 và là thủ kho của phiếu (Admin luôn được). */
export function canShipOrder(actor: StepActor, keeperId: string | null | undefined): boolean {
  return holds(actor, 'sales.step.ship') && (isAdmin(actor) || (Boolean(keeperId) && keeperId === actor.sub));
}

/** Xác nhận giao phiếu này: giữ bước 5; người có vai trò kho chỉ phiếu mình là thủ kho (Admin luôn được). */
export function canDeliverOrder(actor: StepActor, keeperId: string | null | undefined): boolean {
  if (!holds(actor, 'sales.step.deliver')) return false;
  return isAdmin(actor) || !hasKeeperRole(actor.roles) || (Boolean(keeperId) && keeperId === actor.sub);
}
