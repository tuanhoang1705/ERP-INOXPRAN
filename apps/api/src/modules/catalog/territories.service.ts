import { ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { newProvinceOf, oldProvince, provinceLabel, type SalesTerritoryView, type SetEmployeeTerritories, type TerritoryChannel, type TerritoryMismatchView } from '@inoxpran/contracts';
import type { Db, Document } from 'mongodb';
import { ObjectId } from 'mongodb';
import { AuditService } from '../../common/audit.service';
import { toObjectId } from '../../common/domain';
import type { AuthenticatedRequest } from '../../common/request-context';
import { TERRITORIES } from '../../common/territories';
import { MONGO_DATABASE } from '../../common/tokens';

const CUSTOMER_KINDS = ['CUSTOMER', 'BOTH'];
const key = (provinceCode: string, channel: string) => `${provinceCode}|${channel}`;

/**
 * Phân vùng NVKD theo tỉnh cũ (PV-01, 30/10/2026): gán tỉnh cho từng NVKD, đối chiếu khách lệch vùng. Quy tắc ràng buộc khách / phiếu
 * BH ở `common/territories.ts`.
 */
@Injectable()
export class TerritoriesService {
  constructor(
    @Inject(MONGO_DATABASE) private readonly db: Db,
    private readonly audit: AuditService,
  ) {}

  private view(row: Document, codes: Map<string, string>): SalesTerritoryView {
    const old = oldProvince(String(row.provinceCode));
    const current = newProvinceOf(String(row.provinceCode));
    return {
      provinceCode: String(row.provinceCode),
      provinceName: old?.name ?? String(row.provinceCode),
      newProvinceCode: current?.code ?? '',
      newProvinceName: current?.name ?? '',
      channel: row.channel as TerritoryChannel,
      employeeId: (row.employeeId as ObjectId).toHexString(),
      employeeCode: codes.get(String(row.employeeId)) ?? '',
      employeeName: String(row.employeeName),
    };
  }

  async list(): Promise<SalesTerritoryView[]> {
    const [rows, employees] = await Promise.all([
      this.db.collection(TERRITORIES).find({}).sort({ provinceCode: 1, channel: 1 }).toArray(),
      this.db.collection('employees').find({}, { projection: { code: 1 } }).toArray(),
    ]);
    const codes = new Map(employees.map((row) => [String(row._id), String(row.code)]));
    return rows.map((row) => this.view(row, codes));
  }

  /** Khách thuộc (tỉnh, kênh): kênh ALL = mọi khách của tỉnh. */
  private customerFilter(provinceCode: string, channel: string): Document {
    return { kind: { $in: CUSTOMER_KINDS }, provinceOldCode: provinceCode, ...(channel === 'ALL' ? {} : { territoryChannel: channel }) };
  }

  /**
   * Đặt lại danh sách tỉnh NVKD phụ trách. Tỉnh đang của người khác thì chuyển sang NVKD này; khách ở các vùng vừa nhận đang do
   * người khác phụ trách (không có ngoại lệ) phải chuyển theo (`moveCustomers`) — quy tắc bắt buộc khớp.
   */
  async setForEmployee(employeeId: string, input: SetEmployeeTerritories, request: AuthenticatedRequest) {
    const employee = await this.db.collection('employees').findOne({ _id: toObjectId(employeeId) });
    if (!employee) throw new NotFoundException({ code: 'EMPLOYEE_NOT_FOUND', message: 'Không tìm thấy nhân viên' });
    const wanted = new Map(input.territories.map((entry) => [key(entry.provinceCode, entry.channel), entry]));
    const provinceChannels = new Map<string, Set<string>>();
    for (const entry of wanted.values()) provinceChannels.set(entry.provinceCode, (provinceChannels.get(entry.provinceCode) ?? new Set()).add(entry.channel));
    for (const [provinceCode, channels] of provinceChannels) {
      if (channels.has('ALL') && channels.size > 1) {
        throw new ConflictException({ code: 'TERRITORY_CHANNEL_CONFLICT', message: `${provinceLabel(provinceCode)}: chọn cả tỉnh hoặc từng kênh, không chọn cả hai` });
      }
    }
    const employeeObjectId = employee._id as ObjectId;
    const all = await this.db.collection(TERRITORIES).find({}).toArray();
    const mine = all.filter((row) => (row.employeeId as ObjectId).equals(employeeObjectId));
    const others = all.filter((row) => !(row.employeeId as ObjectId).equals(employeeObjectId));
    // Vùng nhận thêm (chưa phải của NVKD này).
    const gained = [...wanted.values()].filter((entry) => !mine.some((row) => row.provinceCode === entry.provinceCode && row.channel === entry.channel));
    const takeOver: Document[] = [];
    for (const entry of gained) {
      for (const row of others.filter((item) => item.provinceCode === entry.provinceCode)) {
        if (entry.channel === 'ALL' || row.channel === entry.channel) takeOver.push(row);
        else if (row.channel === 'ALL') {
          throw new ConflictException({ code: 'TERRITORY_CHANNEL_CONFLICT', message: `${provinceLabel(entry.provinceCode)} đang do ${String(row.employeeName)} phụ trách cả tỉnh — bỏ tỉnh khỏi ${String(row.employeeName)} trước rồi mới chia kênh` });
        }
      }
    }
    const affectedFilter = gained.length
      ? { $or: gained.map((entry) => this.customerFilter(entry.provinceCode, entry.channel)), salesRepId: { $ne: employeeObjectId }, territoryException: { $exists: false } }
      : null;
    const affected = affectedFilter ? await this.db.collection('partners').find(affectedFilter, { projection: { code: 1, name: 1, salesRepName: 1 } }).toArray() : [];
    if (affected.length && !input.moveCustomers) {
      throw new ConflictException({
        code: 'TERRITORY_CUSTOMERS_AFFECTED',
        message: `${affected.length} khách ở các tỉnh vừa chọn đang do người khác phụ trách (${affected.slice(0, 5).map((row) => String(row.code)).join(', ')}${affected.length > 5 ? '…' : ''}) — xác nhận chuyển khách sang ${String(employee.name)}`,
        details: { customers: affected.map((row) => ({ code: String(row.code), name: String(row.name), salesRepName: row.salesRepName ? String(row.salesRepName) : null })) },
      });
    }
    const now = new Date();
    const session = this.db.client.startSession();
    try {
      await session.withTransaction(async () => {
        const removeIds = [...mine.filter((row) => !wanted.has(key(String(row.provinceCode), String(row.channel)))), ...takeOver].map((row) => row._id as ObjectId);
        if (removeIds.length) await this.db.collection(TERRITORIES).deleteMany({ _id: { $in: removeIds } }, { session });
        if (gained.length) {
          await this.db.collection(TERRITORIES).insertMany(gained.map((entry) => ({
            _id: new ObjectId(), provinceCode: entry.provinceCode, channel: entry.channel, employeeId: employeeObjectId, employeeName: String(employee.name), createdAt: now, updatedAt: now,
          })), { session });
        }
        if (affectedFilter && affected.length) {
          await this.db.collection('partners').updateMany(affectedFilter, { $set: { salesRepId: employeeObjectId, salesRepName: String(employee.name), updatedAt: now }, $inc: { version: 1 } }, { session });
        }
      });
    } finally {
      await session.endSession();
    }
    await this.audit.record({
      actorId: request.user.sub, actorEmail: request.user.email, correlationId: request.correlationId,
      action: 'SALES_TERRITORY_ASSIGNED', entityType: 'Employee', entityId: employeeObjectId.toHexString(),
      metadata: {
        employee: String(employee.name),
        territories: [...wanted.values()].map((entry) => `${entry.provinceCode}${entry.channel === 'ALL' ? '' : `/${entry.channel}`}`),
        takenOver: takeOver.map((row) => `${String(row.provinceCode)}/${String(row.channel)} ← ${String(row.employeeName)}`),
        movedCustomers: affected.map((row) => String(row.code)),
      },
    });
    return { territories: (await this.list()).filter((row) => row.employeeId === employeeObjectId.toHexString()), movedCustomers: affected.length };
  }

  /** Khách có NVKD khác người phụ trách vùng (kể cả khách vùng đã giao mà chưa có NVKD). */
  async mismatches(): Promise<TerritoryMismatchView[]> {
    const [territories, customers] = await Promise.all([
      this.db.collection(TERRITORIES).find({}).toArray(),
      this.db.collection('partners').find({ kind: { $in: CUSTOMER_KINDS }, provinceOldCode: { $exists: true } }, { projection: { code: 1, name: 1, provinceOldCode: 1, territoryChannel: 1, salesRepId: 1, salesRepName: 1, territoryException: 1 } }).sort({ code: 1 }).toArray(),
    ]);
    const owners = new Map(territories.map((row) => [key(String(row.provinceCode), String(row.channel)), row]));
    const rows: TerritoryMismatchView[] = [];
    for (const customer of customers) {
      const province = String(customer.provinceOldCode);
      const owner = owners.get(key(province, 'ALL')) ?? (customer.territoryChannel ? owners.get(key(province, String(customer.territoryChannel))) : undefined);
      if (!owner) continue;
      if (customer.salesRepId && (customer.salesRepId as ObjectId).equals(owner.employeeId as ObjectId)) continue;
      const exception = customer.territoryException as Document | undefined;
      rows.push({
        partnerId: (customer._id as ObjectId).toHexString(),
        code: String(customer.code),
        name: String(customer.name),
        provinceLabel: provinceLabel(province),
        ...(customer.territoryChannel ? { channel: customer.territoryChannel } : {}),
        ...(customer.salesRepName ? { salesRepName: String(customer.salesRepName) } : {}),
        territoryRepId: (owner.employeeId as ObjectId).toHexString(),
        territoryRepName: String(owner.employeeName),
        ...(exception ? { exception: { reason: String(exception.reason), byName: String(exception.byName), at: String(exception.at) } } : {}),
      });
    }
    return rows;
  }

  /** Chuyển các khách lệch vùng về NVKD phụ trách vùng (bỏ ngoại lệ). Không chọn khách = mọi khách lệch không có ngoại lệ. */
  async fixMismatches(partnerIds: string[] | undefined, request: AuthenticatedRequest) {
    const rows = (await this.mismatches()).filter((row) => (partnerIds?.length ? partnerIds.includes(row.partnerId) : !row.exception));
    const now = new Date();
    for (const row of rows) {
      await this.db.collection('partners').updateOne(
        { _id: toObjectId(row.partnerId) },
        { $set: { salesRepId: toObjectId(row.territoryRepId), salesRepName: row.territoryRepName, updatedAt: now }, $unset: { territoryException: '' }, $inc: { version: 1 } },
      );
    }
    if (rows.length) {
      await this.audit.record({
        actorId: request.user.sub, actorEmail: request.user.email, correlationId: request.correlationId,
        action: 'SALES_TERRITORY_CUSTOMERS_FIXED', entityType: 'Partner', entityId: 'territories',
        metadata: { customers: rows.map((row) => `${row.code}: ${row.salesRepName ?? '—'} → ${row.territoryRepName}`) },
      });
    }
    return { moved: rows.length };
  }
}
