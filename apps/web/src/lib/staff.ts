/**
 * Người mượn / phụ trách (STAFF-PICK-01, 04/11/2026): phiếu xuất hàng mẫu / kiểm định / tặng, phiếu đổi bảo hành, nhập lại hàng
 * mẫu không phiếu chọn được NVKD hoặc mọi tài khoản không phải Admin. Ô chọn dùng chung StaffSelect; API nhận NVKD ở `salesRepId`,
 * tài khoản ở `staffUserId`.
 */
import type { StaffOption } from '@inoxpran/contracts';
import { api } from '$lib/api';

export type { StaffOption };

export function loadStaff(): Promise<StaffOption[]> {
  return api<StaffOption[]>('/staff');
}

/** Thêm người đang ghi trên phiếu nhưng không còn trong danh sách (NVKD ngưng, tài khoản bị khóa) để ô chọn vẫn hiện tên. */
export function withCurrent(options: StaffOption[], current: { salesRepId?: string | undefined; staffUserId?: string | undefined; salesRepName?: string | undefined }): StaffOption[] {
  const id = current.staffUserId ?? current.salesRepId;
  if (!id || options.some((row) => row.id === id)) return options;
  return [...options, { kind: current.staffUserId ? 'USER' : 'EMPLOYEE', id, name: current.salesRepName ?? id, roles: [] }];
}

/** Trường gửi API cho người được chọn: NVKD → `salesRepId`, tài khoản → `staffUserId`. */
export function staffPick(options: readonly StaffOption[], id: string): { salesRepId?: string; staffUserId?: string } {
  if (!id) return {};
  return options.find((row) => row.id === id)?.kind === 'USER' ? { staffUserId: id } : { salesRepId: id };
}
