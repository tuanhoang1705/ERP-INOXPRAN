import { describe, expect, it } from 'vitest';
import { matchProvince, NEW_PROVINCES, newProvinceOf, OLD_PROVINCES, oldProvincesOf, provinceLabel } from './provinces';

describe('danh mục tỉnh (PV-01)', () => {
  it('đủ 63 tỉnh cũ, 34 tỉnh mới, mã không trùng, mỗi tỉnh cũ thuộc đúng một tỉnh mới có thật', () => {
    expect(OLD_PROVINCES).toHaveLength(63);
    expect(NEW_PROVINCES).toHaveLength(34);
    expect(new Set(OLD_PROVINCES.map((item) => item.code)).size).toBe(63);
    expect(new Set(NEW_PROVINCES.map((item) => item.code)).size).toBe(34);
    const newCodes = new Set(NEW_PROVINCES.map((item) => item.code));
    for (const item of OLD_PROVINCES) expect(newCodes.has(item.newCode)).toBe(true);
    for (const item of NEW_PROVINCES) expect(oldProvincesOf(item.code).length).toBeGreaterThan(0);
  });

  it('11 tỉnh giữ nguyên, 23 tỉnh mới sáp nhập', () => {
    const kept = NEW_PROVINCES.filter((item) => oldProvincesOf(item.code).length === 1);
    expect(kept).toHaveLength(11);
    expect(oldProvincesOf('PHU-THO').map((item) => item.name).sort()).toEqual(['Hòa Bình', 'Phú Thọ', 'Vĩnh Phúc']);
    expect(oldProvincesOf('HAI-PHONG').map((item) => item.code).sort()).toEqual(['HAI-DUONG', 'HAI-PHONG']);
    expect(newProvinceOf('NAM-DINH')?.name).toBe('Ninh Bình');
    expect(provinceLabel('HAI-DUONG')).toBe('Hải Dương (nay Hải Phòng)');
    expect(provinceLabel('HA-NOI')).toBe('Hà Nội');
  });

  it('dò tỉnh trong địa chỉ thật của khách', () => {
    expect(matchProvince('Nhà ông Phạm Đức Cảnh, thôn 8, Xã Tân Tiến, Tỉnh Thanh Hóa, Việt Nam')).toEqual({ oldCode: 'THANH-HOA', newCode: 'THANH-HOA' });
    expect(matchProvince('Số 13, ngách 515/13, đường Hoàng Hoa Thám, Phường Ngọc Hà, Thành phố Hà Nội, Việt Nam')).toEqual({ oldCode: 'HA-NOI', newCode: 'HA-NOI' });
    // Tên tỉnh mới đã sáp nhập: chỉ biết tỉnh mới.
    expect(matchProvince('Thôn Bắc Cường, Xã Thổ Tang, Tỉnh Phú Thọ, Việt Nam')).toEqual({ newCode: 'PHU-THO' });
    expect(matchProvince('Số nhà 10, ngõ Đoan Túc, tổ 18, Phường Thái Bình, Hưng Yên, Việt Nam')).toEqual({ newCode: 'HUNG-YEN' });
    // Tên tỉnh cũ đã bị sáp nhập: biết cả tỉnh cũ.
    expect(matchProvince('Khu 5, TT Vĩnh Tường, Vĩnh Phúc')).toEqual({ oldCode: 'VINH-PHUC', newCode: 'PHU-THO' });
    expect(matchProvince('12 Lê Lợi, Q1, TP HCM')).toEqual({ newCode: 'HO-CHI-MINH' });
    expect(matchProvince('157 Quan Nhân')).toEqual({});
  });
});
