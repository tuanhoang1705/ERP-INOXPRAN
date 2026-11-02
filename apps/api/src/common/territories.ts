import { BadRequestException } from '@nestjs/common';
import { newProvince, oldProvince, oldProvincesOf, provinceLabel, type CustomerChannel } from '@inoxpran/contracts';
import type { ClientSession, Db, Document, ObjectId } from 'mongodb';
import type { RequestUser } from './request-context';

/**
 * Phân vùng NVKD theo tỉnh cũ (PV-01, 30/10/2026). Collection `sales_territories`: mỗi dòng (tỉnh cũ, kênh) → một NVKD.
 * Tỉnh không tách kênh có một dòng kênh ALL; tỉnh tách kênh (VD Hà Nội) có dòng DISTRIBUTOR / RETAIL riêng — kênh chưa giao ai
 * thì khách kênh đó chọn NVKD tự do.
 */
export const TERRITORIES = 'sales_territories';

export interface TerritoryOwner { employeeId: ObjectId; employeeName: string }

/** Tỉnh cũ có tách kênh không (có dòng phân vùng theo kênh). */
export async function isSplitProvince(db: Db, provinceCode: string, session?: ClientSession): Promise<boolean> {
  return Boolean(await db.collection(TERRITORIES).findOne({ provinceCode, channel: { $ne: 'ALL' } }, { ...(session ? { session } : {}), projection: { _id: 1 } }));
}

/** NVKD phụ trách (tỉnh cũ, kênh); null = vùng chưa giao ai (chọn NVKD tự do). */
export async function territoryOwner(db: Db, provinceCode: string | null | undefined, channel: string | null | undefined, session?: ClientSession): Promise<TerritoryOwner | null> {
  if (!provinceCode) return null;
  const rows = await db.collection(TERRITORIES).find({ provinceCode }, session ? { session } : {}).toArray();
  const row = rows.find((item) => item.channel === 'ALL') ?? (channel ? rows.find((item) => item.channel === channel) : undefined);
  return row ? { employeeId: row.employeeId as ObjectId, employeeName: String(row.employeeName) } : null;
}

/**
 * Chuẩn hóa tỉnh của khách: có tỉnh cũ thì suy ra tỉnh mới (và tên tỉnh mới vào `province`); chỉ có tỉnh mới mà tỉnh mới đó chỉ
 * gồm một tỉnh cũ (Hà Nội, Thanh Hóa…) thì điền luôn tỉnh cũ. Tỉnh cũ không thuộc tỉnh mới đã chọn → 400.
 */
export function normalizeProvinces(input: { provinceOldCode?: string | null | undefined; provinceNewCode?: string | null | undefined }): Document {
  const old = oldProvince(input.provinceOldCode);
  if (input.provinceOldCode && !old) throw new BadRequestException({ code: 'PROVINCE_NOT_FOUND', message: 'Không có tỉnh cũ này', details: [{ path: ['provinceOldCode'] }] });
  if (old) {
    if (input.provinceNewCode && input.provinceNewCode !== old.newCode) {
      throw new BadRequestException({ code: 'PROVINCE_MISMATCH', message: `${old.name} nay thuộc ${newProvince(old.newCode)?.name ?? old.newCode}`, details: [{ path: ['provinceOldCode'] }] });
    }
    return { provinceOldCode: old.code, provinceNewCode: old.newCode, province: newProvince(old.newCode)?.name ?? old.name };
  }
  const current = newProvince(input.provinceNewCode);
  if (input.provinceNewCode && !current) throw new BadRequestException({ code: 'PROVINCE_NOT_FOUND', message: 'Không có tỉnh mới này', details: [{ path: ['provinceNewCode'] }] });
  if (!current) return {};
  const members = oldProvincesOf(current.code);
  return { ...(members.length === 1 ? { provinceOldCode: members[0]!.code } : {}), provinceNewCode: current.code, province: current.name };
}

const canOverride = (user: Pick<RequestUser, 'roles' | 'root'>) => Boolean(user.root) || user.roles.includes('ADMIN');

/**
 * Ràng buộc NVKD theo phân vùng (bắt buộc khớp): khách ở vùng đã giao thì NVKD phải là người phụ trách vùng. Bỏ trống NVKD thì
 * tự điền; khác thì 400 TERRITORY_MISMATCH, trừ khi Admin / quản trị gốc ghi lý do ngoại lệ. Trả các trường cần ghi vào khách
 * (`unsetException` = gỡ ngoại lệ cũ khi đã khớp hoặc vùng chưa giao ai).
 */
export async function enforceTerritory(
  db: Db,
  partner: { provinceOldCode?: string | null | undefined; territoryChannel?: CustomerChannel | null | undefined; salesRepId?: ObjectId | null | undefined },
  user: Pick<RequestUser, 'roles' | 'root' | 'displayName'>,
  exceptionReason: string | undefined,
  session?: ClientSession,
): Promise<{ set: Document; unsetException: boolean }> {
  if (partner.provinceOldCode && !partner.territoryChannel && await isSplitProvince(db, partner.provinceOldCode, session)) {
    throw new BadRequestException({ code: 'TERRITORY_CHANNEL_REQUIRED', message: `${provinceLabel(partner.provinceOldCode)} chia vùng theo kênh — chọn kênh nhà phân phối hay bán lẻ`, details: [{ path: ['territoryChannel'] }] });
  }
  const owner = await territoryOwner(db, partner.provinceOldCode, partner.territoryChannel, session);
  if (!owner) return { set: {}, unsetException: true };
  if (!partner.salesRepId) return { set: { salesRepId: owner.employeeId, salesRepName: owner.employeeName }, unsetException: true };
  if (owner.employeeId.equals(partner.salesRepId)) return { set: {}, unsetException: true };
  const region = provinceLabel(partner.provinceOldCode) + (partner.territoryChannel ? ` – ${partner.territoryChannel === 'DISTRIBUTOR' ? 'nhà phân phối' : 'bán lẻ'}` : '');
  if (!exceptionReason || !canOverride(user)) {
    throw new BadRequestException({
      code: 'TERRITORY_MISMATCH',
      message: `Khách ở ${region} do ${owner.employeeName} phụ trách${canOverride(user) ? ' — muốn giao người khác thì ghi lý do ngoại lệ' : ''}`,
      details: [{ path: ['salesRepId'] }],
    });
  }
  return { set: { territoryException: { reason: exceptionReason, byName: user.displayName, at: new Date().toISOString() } }, unsetException: false };
}
