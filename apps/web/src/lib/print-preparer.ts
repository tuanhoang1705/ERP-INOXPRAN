/**
 * "Người lập biểu" trên bản in phiếu BH / SWK (PRINT-PREP-01, 16/10/2026): họ tên tài khoản đang mở bản in, nếu vai trò
 * đúng với loại phiếu — BH do kế toán lập, SWK do kho lập (Admin / quản trị gốc in được cả hai).
 * Người khác mở xem (NVKD, Giám đốc…) thì in tên người đã lập phiếu như trước.
 */
export const PREPARER_ROLES: Record<'BH' | 'SWK', readonly string[]> = {
  BH: ['ACCOUNTANT', 'ADMIN'],
  SWK: ['WAREHOUSE', 'WAREHOUSE_MANAGER', 'ADMIN'],
};

export interface PrintViewer {
  displayName: string;
  roles: readonly string[];
  root?: boolean | undefined;
}

export function slipPreparerName(
  type: 'BH' | 'SWK',
  viewer: PrintViewer | null | undefined,
  order: { issuedByName?: string | undefined; shippedByName?: string | undefined },
): string {
  const stored = (type === 'SWK' ? order.shippedByName : order.issuedByName) ?? '';
  if (!viewer?.displayName.trim()) return stored;
  const allowed = viewer.root || viewer.roles.some((role) => PREPARER_ROLES[type].includes(role));
  return allowed ? viewer.displayName.trim() : stored;
}
