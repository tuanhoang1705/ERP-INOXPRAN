import { ObjectId } from 'mongodb';
import { describe, expect, it } from 'vitest';
import { isAssignedKeeper, isKeeperOnly, salesOrderScope, seesStaffHidden } from './keeper-scope';

const keeperId = new ObjectId();

describe('phạm vi phiếu của thủ kho', () => {
  it('tài khoản chỉ có vai trò kho bị giới hạn theo phiếu được giao, không thấy nháp/hủy', () => {
    const user = { sub: keeperId.toHexString(), roles: ['WAREHOUSE'] };
    expect(isKeeperOnly(user)).toBe(true);
    expect(salesOrderScope(user)).toEqual({ warehouseKeeperId: keeperId, status: { $nin: ['DRAFT', 'CANCELLED'] } });
  });

  it('kế toán, giám đốc, quản trị, kiểm soát, quản trị gốc xem toàn bộ (cả phiếu quản trị gốc đã hủy)', () => {
    for (const roles of [['ACCOUNTANT'], ['DIRECTOR'], ['ADMIN'], ['AUDITOR']]) {
      expect(salesOrderScope({ sub: keeperId.toHexString(), roles })).toEqual({});
    }
    expect(salesOrderScope({ sub: keeperId.toHexString(), roles: ['SALES'], root: true })).toEqual({});
  });

  it('kinh doanh, quản lý kho xem toàn bộ trừ phiếu quản trị gốc đã hủy (ROOT-DEL-02)', () => {
    for (const roles of [['SALES'], ['SALES_MANAGER'], ['WAREHOUSE_MANAGER'], ['WAREHOUSE', 'WAREHOUSE_MANAGER']]) {
      expect(salesOrderScope({ sub: keeperId.toHexString(), roles })).toEqual({ staffHidden: { $ne: true } });
      expect(seesStaffHidden({ roles })).toBe(false);
    }
  });

  it('chỉ thủ kho được giao (hoặc ADMIN) thao tác lập SWK / xác nhận giao', () => {
    const order = { warehouseKeeperId: keeperId };
    expect(isAssignedKeeper({ sub: keeperId.toHexString(), roles: ['WAREHOUSE'] }, order)).toBe(true);
    expect(isAssignedKeeper({ sub: new ObjectId().toHexString(), roles: ['WAREHOUSE_MANAGER'] }, order)).toBe(false);
    expect(isAssignedKeeper({ sub: new ObjectId().toHexString(), roles: ['ADMIN'] }, order)).toBe(true);
    expect(isAssignedKeeper({ sub: keeperId.toHexString(), roles: ['WAREHOUSE'] }, {})).toBe(false);
  });
});
