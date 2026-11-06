import { BadRequestException, NotFoundException } from '@nestjs/common';
import type { StaffOption } from '@inoxpran/contracts';
import type { ClientSession, Db, Document } from 'mongodb';
import { ObjectId } from 'mongodb';
import { toObjectId } from './domain';

/**
 * Người mượn / phụ trách (STAFF-PICK-01, 04/11/2026): phiếu xuất hàng mẫu / kiểm định / tặng, phiếu đổi bảo hành, nhập lại hàng
 * mẫu không phiếu chọn được NVKD hoặc mọi tài khoản đang hoạt động trừ Admin / quản trị gốc. Tài khoản gắn hồ sơ NVKD đang hoạt
 * động hiện và lưu theo NVKD (`salesRepId`); tài khoản khác lưu `staffUserId`. Tên luôn ghi vào `salesRepName` nên danh sách,
 * trang phiếu, bản in hiện như trước.
 */
export interface PickedStaff { kind: 'EMPLOYEE' | 'USER'; id: ObjectId; name: string }

const ACTIVE_EMPLOYEE = { status: { $ne: 'INACTIVE' } };
const NOT_ADMIN = { root: { $ne: true }, roles: { $ne: 'ADMIN' } };
/** Danh sách chọn chỉ có tài khoản đang hoạt động; khi lưu chỉ chặn Admin (như NVKD: sửa phiếu cũ của người đã nghỉ vẫn giữ người). */
const PICKABLE_USER = { status: 'ACTIVE', ...NOT_ADMIN };

/** Danh sách chọn: NVKD đang hoạt động (theo mã), rồi tài khoản không gắn NVKD (theo tên). */
export async function staffOptions(db: Db): Promise<StaffOption[]> {
  const employees = await db.collection('employees').find(ACTIVE_EMPLOYEE, { projection: { code: 1, name: 1, role: 1, userId: 1 } }).sort({ code: 1 }).toArray();
  const linked = employees.map((row) => row.userId).filter((id): id is ObjectId => id instanceof ObjectId);
  const users = await db.collection('users').find({ ...PICKABLE_USER, _id: { $nin: linked } }, { projection: { displayName: 1, title: 1, roles: 1 } }).toArray();
  return [
    ...employees.map((row): StaffOption => ({ kind: 'EMPLOYEE', id: String(row._id), name: String(row.name), code: String(row.code), roles: row.role ? [String(row.role)] : [] })),
    ...users
      .map((row): StaffOption => ({ kind: 'USER', id: String(row._id), name: String(row.displayName ?? ''), ...(row.title ? { title: String(row.title) } : {}), roles: (row.roles as string[] | undefined) ?? [] }))
      .sort((a, b) => a.name.localeCompare(b.name, 'vi')),
  ];
}

/**
 * Người được chọn: NVKD theo `salesRepId`, hoặc tài khoản theo `staffUserId` (tài khoản gắn NVKD đang hoạt động → NVKD đó).
 * null = không chọn ai.
 * SEC-UI-01 (06/11/2026): người đã nghỉ (NVKD ngừng / tài khoản khóa) không chọn mới được — danh sách chọn trên web chỉ có người
 * đang hoạt động; `keep` = chứng từ đang sửa: giữ nguyên người đang lưu (đã nghỉ) vẫn lưu được.
 */
export async function resolveStaff(
  db: Db,
  ref: { salesRepId?: string | undefined; staffUserId?: string | undefined },
  session?: ClientSession,
  keep?: { salesRepId?: unknown; staffUserId?: unknown } | null,
): Promise<PickedStaff | null> {
  const options = session ? { session } : {};
  if (ref.salesRepId && ref.staffUserId) {
    throw new BadRequestException({ code: 'VALIDATION_ERROR', message: 'Chỉ chọn một người mượn / phụ trách', details: [{ path: ['staffUserId'] }] });
  }
  if (ref.salesRepId) {
    const employee = await db.collection('employees').findOne({ _id: toObjectId(ref.salesRepId, 'salesRepId') }, { ...options, projection: { name: 1, status: 1 } });
    if (!employee) throw new NotFoundException({ code: 'SALES_REP_NOT_FOUND', message: 'Không tìm thấy nhân viên kinh doanh', details: [{ path: ['salesRepId'] }] });
    if (employee.status === 'INACTIVE' && String(keep?.salesRepId ?? '') !== ref.salesRepId) {
      throw new BadRequestException({ code: 'STAFF_INACTIVE', message: `${String(employee.name)} đã ngừng làm việc — chọn người khác`, details: [{ path: ['salesRepId'] }] });
    }
    return { kind: 'EMPLOYEE', id: employee._id, name: String(employee.name) };
  }
  if (!ref.staffUserId) return null;
  const userId = toObjectId(ref.staffUserId, 'staffUserId');
  const user = await db.collection('users').findOne({ _id: userId, ...NOT_ADMIN }, { ...options, projection: { displayName: 1, status: 1 } });
  if (!user) {
    throw new BadRequestException({ code: 'STAFF_NOT_FOUND', message: 'Không tìm thấy tài khoản (không phải Admin) để làm người mượn / phụ trách', details: [{ path: ['staffUserId'] }] });
  }
  if (user.status !== 'ACTIVE' && String(keep?.staffUserId ?? '') !== ref.staffUserId) {
    throw new BadRequestException({ code: 'STAFF_INACTIVE', message: `Tài khoản ${String(user.displayName ?? '')} đã khóa — chọn người khác`, details: [{ path: ['staffUserId'] }] });
  }
  const employee = await db.collection('employees').findOne({ userId, ...ACTIVE_EMPLOYEE }, { ...options, projection: { name: 1 } });
  return employee ? { kind: 'EMPLOYEE', id: employee._id, name: String(employee.name) } : { kind: 'USER', id: userId, name: String(user.displayName ?? '') };
}

/** Trường ghi vào phiếu cho người được chọn (tên ở `salesRepName` cho cả hai loại). */
export function staffFields(staff: PickedStaff): Document {
  return staff.kind === 'EMPLOYEE' ? { salesRepId: staff.id, salesRepName: staff.name } : { staffUserId: staff.id, salesRepName: staff.name };
}

/** Trường của loại kia cần gỡ khi đổi người (NVKD ↔ tài khoản). */
export function staffUnsetKey(staff: PickedStaff | null): 'salesRepId' | 'staffUserId' {
  return staff?.kind === 'USER' ? 'salesRepId' : 'staffUserId';
}
