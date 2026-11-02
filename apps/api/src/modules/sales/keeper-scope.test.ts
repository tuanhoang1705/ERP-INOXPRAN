import { effectivePermissions } from '@inoxpran/contracts';
import { ObjectId } from 'mongodb';
import { describe, expect, it } from 'vitest';
import { canDeliverSalesOrder, isAssignedKeeper, isKeeperOnly, salesOrderScope } from './keeper-scope';

const keeperId = new ObjectId();
const user = (sub: string, roles: string[], overrides: Record<string, boolean> = {}) => ({ sub, roles, permissions: effectivePermissions({ roles, permissionOverrides: overrides }) });

describe('phạm vi phiếu của thủ kho', () => {
  it('tài khoản chỉ có vai trò kho bị giới hạn theo phiếu được giao, không thấy nháp/hủy', () => {
    const keeper = user(keeperId.toHexString(), ['WAREHOUSE']);
    expect(isKeeperOnly(keeper)).toBe(true);
    expect(salesOrderScope(keeper)).toEqual({ warehouseKeeperId: keeperId, status: { $nin: ['DRAFT', 'CANCELLED'] } });
  });

  it('kế toán, kinh doanh, giám đốc, quản trị, quản lý kho xem toàn bộ trừ phiếu đã hủy (DOC-HIDE-01)', () => {
    for (const roles of [['ACCOUNTANT'], ['SALES'], ['DIRECTOR'], ['ADMIN'], ['WAREHOUSE_MANAGER'], ['WAREHOUSE', 'WAREHOUSE_MANAGER']]) {
      expect(salesOrderScope(user(keeperId.toHexString(), roles))).toEqual({ status: { $ne: 'CANCELLED' } });
    }
  });

  it('chỉ quản trị gốc thấy cả phiếu đã hủy', () => {
    expect(salesOrderScope({ ...user(keeperId.toHexString(), ['ADMIN']), root: true })).toEqual({});
  });

  it('thủ kho được phân bước văn phòng (SAL-STEP-01) xem toàn bộ phiếu (trừ phiếu đã hủy)', () => {
    expect(salesOrderScope(user(keeperId.toHexString(), ['WAREHOUSE'], { 'sales.step.confirm': true }))).toEqual({ status: { $ne: 'CANCELLED' } });
  });

  it('chỉ thủ kho được giao và được phân bước 4 (hoặc ADMIN) lập SWK', () => {
    const order = { warehouseKeeperId: keeperId };
    expect(isAssignedKeeper(user(keeperId.toHexString(), ['WAREHOUSE']), order)).toBe(true);
    expect(isAssignedKeeper(user(keeperId.toHexString(), ['WAREHOUSE'], { 'sales.step.ship': false }), order)).toBe(false);
    expect(isAssignedKeeper(user(new ObjectId().toHexString(), ['WAREHOUSE_MANAGER']), order)).toBe(false);
    expect(isAssignedKeeper(user(new ObjectId().toHexString(), ['ADMIN']), order)).toBe(true);
    expect(isAssignedKeeper(user(keeperId.toHexString(), ['WAREHOUSE']), {})).toBe(false);
  });

  it('xác nhận giao: thủ kho của phiếu, hoặc người không thuộc kho được phân bước 5', () => {
    const order = { warehouseKeeperId: keeperId };
    expect(canDeliverSalesOrder(user(keeperId.toHexString(), ['WAREHOUSE']), order)).toBe(true);
    expect(canDeliverSalesOrder(user(new ObjectId().toHexString(), ['WAREHOUSE_MANAGER']), order)).toBe(false);
    expect(canDeliverSalesOrder(user(new ObjectId().toHexString(), ['SALES']), order)).toBe(false);
    expect(canDeliverSalesOrder(user(new ObjectId().toHexString(), ['SALES'], { 'sales.step.deliver': true }), order)).toBe(true);
  });
});
