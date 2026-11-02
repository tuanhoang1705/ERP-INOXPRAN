import { ObjectId } from 'mongodb';
import { describe, expect, it } from 'vitest';
import { planCustomer } from './rebuild-sales-territories';

const customer = (fields: Record<string, unknown>) => ({ _id: new ObjectId(), name: 'Khách thử', kind: 'CUSTOMER', ...fields });

describe('dựng phân vùng từ dữ liệu khách cũ (PV-01)', () => {
  it('mã khu vực cũ là tỉnh cũ; Hà Nội tách kênh theo HN-NPP / HN-LE', () => {
    expect(planCustomer(customer({ code: 'KH024', regionCode: 'HAI-DUONG', province: 'Hải Phòng', address: 'Thôn Lý Dương, Xã Kẻ Sặt, TP Hải Phòng' }), {}))
      .toMatchObject({ oldCode: 'HAI-DUONG', newCode: 'HAI-PHONG' });
    expect(planCustomer(customer({ code: 'KH006', regionCode: 'HN-NPP', province: 'Hà Nội' }), {})).toMatchObject({ oldCode: 'HA-NOI', channel: 'DISTRIBUTOR' });
    expect(planCustomer(customer({ code: 'KH003', regionCode: 'HN-LE', province: 'Hà Nội' }), {})).toMatchObject({ oldCode: 'HA-NOI', channel: 'RETAIL' });
  });

  it('khu vực cũ lệch tỉnh / địa chỉ thì không đoán — báo cần chốt', () => {
    const plan = planCustomer(customer({ code: 'KH005', regionCode: 'HUNG-YEN', province: 'Ninh Bình', address: 'Lô CN - 08, khu công nghiệp Phúc Sơn, Phường Đông Hoa Lư, Ninh Bình' }), {});
    expect(plan.oldCode).toBeUndefined();
    expect(plan.newCode).toBe('NINH-BINH');
    expect(plan.problem).toContain('HUNG-YEN');
  });

  it('chỉ có tỉnh mới gộp nhiều tỉnh cũ → cần chốt; file quyết định thắng', () => {
    const raw = customer({ code: 'KH070', province: 'Phú Thọ', address: 'Thôn Bắc Cường, Xã Thổ Tang, Tỉnh Phú Thọ, Việt Nam' });
    expect(planCustomer(raw, {})).toMatchObject({ newCode: 'PHU-THO', problem: expect.stringContaining('nhiều tỉnh cũ') });
    expect(planCustomer(raw, { provinces: { KH070: 'VINH-PHUC' } })).toMatchObject({ oldCode: 'VINH-PHUC', newCode: 'PHU-THO', source: 'quyết định' });
    expect(planCustomer(customer({ code: 'KH064', province: 'Hải Phòng', address: 'Số 121 Quang Trung, Phường Hồng Bàng, TP Hải Phòng' }), {})).toMatchObject({ newCode: 'HAI-PHONG' });
  });

  it('dò địa chỉ khi không có khu vực; không có gì thì báo', () => {
    expect(planCustomer(customer({ code: 'KH092', province: 'Hưng Yên', address: 'Thôn Trương Xá, Xã Nghĩa Dân, Tỉnh Hưng Yên' }), {})).toMatchObject({ newCode: 'HUNG-YEN' });
    expect(planCustomer(customer({ code: 'KH001', province: 'Thanh Hóa', address: 'thôn 8, Xã Tân Tiến, Tỉnh Thanh Hóa' }), {})).toMatchObject({ oldCode: 'THANH-HOA' });
    expect(planCustomer(customer({ code: 'KH999' }), {})).toMatchObject({ problem: 'không xác định được tỉnh' });
  });
});
