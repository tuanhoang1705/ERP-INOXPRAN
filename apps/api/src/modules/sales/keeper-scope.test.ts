import { ObjectId } from 'mongodb';
import { describe, expect, it } from 'vitest';
import { isAssignedKeeper, isKeeperOnly, salesOrderScope } from './keeper-scope';

const keeperId = new ObjectId();

describe('phạm vi phiếu của thủ kho', () => {
  it('tài khoản chỉ có vai trò kho bị giới hạn theo phiếu được giao, không thấy nháp/hủy', () => {
    const user = { sub: keeperId.toHexString(), roles: ['WAREHOUSE'] };
    expect(isKeeperOnly(user)).toBe(true);
    expect(salesOrderScope(user)).toEqual({ warehouseKeeperId: keeperId, status: { $nin: ['DRAFT', 'CANCELLED'] } });
  });

  it('kế toán, kinh doanh, giám đốc, quản trị, quản lý kho xem toàn bộ', () => {
    for (const roles of [['ACCOUNTANT'], ['SALES'], ['DIRECTOR'], ['ADMIN'], ['WAREHOUSE_MANAGER'], ['WAREHOUSE', 'WAREHOUSE_MANAGER']]) {
      expect(salesOrderScope({ sub: keeperId.toHexString(), roles })).toEqual({});
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
