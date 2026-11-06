import { describe, expect, it } from 'vitest';
import { effectivePermissions } from './permissions';
import { canDeliverOrder, canShipOrder, isKeeperOnly, salesEditStage, type StepActor } from './sales-steps';

const actor = (sub: string, roles: string[], overrides: Record<string, boolean> = {}, root = false): StepActor => ({
  sub, roles, root, permissions: effectivePermissions({ roles, root, permissionOverrides: overrides }),
});

describe('5 bước phiếu BH — luật theo người (SAL-STEP-01)', () => {
  const kho2 = actor('k2', ['WAREHOUSE']);
  const kho = actor('k1', ['WAREHOUSE_MANAGER']);
  const sales = actor('s1', ['SALES']);

  it('xuất kho: giữ bước 4 và là thủ kho của phiếu; Admin luôn được', () => {
    expect(canShipOrder(kho2, 'k2')).toBe(true);
    expect(canShipOrder(kho2, 'k1')).toBe(false);
    expect(canShipOrder(kho, 'k2')).toBe(false);
    expect(canShipOrder(actor('k2', ['WAREHOUSE'], { 'sales.step.ship': false }), 'k2')).toBe(false);
    expect(canShipOrder(actor('a', ['ADMIN']), 'k2')).toBe(true);
    expect(canShipOrder(actor('r', ['ADMIN'], {}, true), undefined)).toBe(true);
    expect(canShipOrder(actor('acc', ['ACCOUNTANT'], { 'sales.step.ship': true }), 'acc')).toBe(true);
  });

  it('xác nhận giao: người có vai trò kho chỉ phiếu mình là thủ kho; người khác được tích bước 5 giao mọi phiếu', () => {
    expect(canDeliverOrder(kho2, 'k2')).toBe(true);
    expect(canDeliverOrder(kho2, 'k1')).toBe(false);
    expect(canDeliverOrder(kho, 'k2')).toBe(false);
    expect(canDeliverOrder(sales, 'k2')).toBe(false);
    expect(canDeliverOrder(actor('s1', ['SALES'], { 'sales.step.deliver': true }), 'k2')).toBe(true);
    expect(canDeliverOrder(actor('s1', ['SALES', 'WAREHOUSE'], { 'sales.step.deliver': true }), 'k2')).toBe(false);
    expect(canDeliverOrder(actor('k2', ['WAREHOUSE'], { 'sales.step.deliver': false }), 'k2')).toBe(false);
    expect(canDeliverOrder(actor('a', ['ADMIN']), 'k2')).toBe(true);
  });

  it('thủ kho thuần chỉ xem phiếu được giao; được phân bước văn phòng thì xem hết', () => {
    expect(isKeeperOnly(kho2)).toBe(true);
    expect(isKeeperOnly(kho)).toBe(false);
    expect(isKeeperOnly(actor('k2', ['WAREHOUSE'], { 'sales.step.confirm': true }))).toBe(false);
    expect(isKeeperOnly(actor('k2', ['WAREHOUSE'], { 'sales.step.deliver': true }))).toBe(true);
    expect(isKeeperOnly(sales)).toBe(false);
  });
});

describe('giai đoạn sửa phiếu BH (SAL-UNDO-01 / SAL-EDIT-GRANT-01, 06/11/2026)', () => {
  it('nháp sửa thường; đã phát hành chưa đối chiếu → hoàn tác; đã đối chiếu trở đi → sửa phiếu', () => {
    expect(salesEditStage({ status: 'DRAFT' })).toBe('DRAFT');
    expect(salesEditStage({ status: 'PENDING_APPROVAL', confirmationStatus: 'PENDING' })).toBe('UNDO');
    expect(salesEditStage({ status: 'RESERVED', confirmationStatus: 'PENDING' })).toBe('UNDO');
    expect(salesEditStage({ status: 'RESERVED', confirmationStatus: 'CONFIRMED' })).toBe('EDIT');
    // Phiếu mẫu / tặng không qua bước đối chiếu → sửa phiếu ngay sau phát hành.
    expect(salesEditStage({ status: 'RESERVED', confirmationStatus: 'NOT_REQUIRED', purpose: 'SAMPLE' })).toBe('EDIT');
    expect(salesEditStage({ status: 'SHIPPED', confirmationStatus: 'CONFIRMED' })).toBe('EDIT');
    expect(salesEditStage({ status: 'DELIVERED', confirmationStatus: 'CONFIRMED' })).toBe('EDIT');
    expect(salesEditStage({ status: 'CANCELLED' })).toBe('NONE');
    expect(salesEditStage({ status: 'DELIVERED', purpose: 'WARRANTY' })).toBe('NONE');
  });
});
