import { Controller, Get, Inject, NotFoundException, Param, Query, Req } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { HistoryEntry } from '@inoxpran/contracts';
import { ObjectId, type Db, type Document } from 'mongodb';
import { seesCancelled } from '../../common/hidden-documents';
import { pageOf, pageRequest } from '../../common/paging';
import type { AuthenticatedRequest } from '../../common/request-context';
import { MONGO_DATABASE } from '../../common/tokens';
import { diffFields } from './history-diff';

/**
 * Hồ sơ có tab "Lịch sử" và quyền xem: đi theo quyền xem hồ sơ đó (danh mục sản phẩm / đối tác mở cho mọi người dùng
 * đã đăng nhập, như GET /products, /partners). Nhật ký đầy đủ của hệ thống (mọi đối tượng) vẫn ở /audit-events.
 */
const ENTITY_TYPES: Record<string, { entityType: string; collection: string }> = {
  products: { entityType: 'Product', collection: 'products' },
  partners: { entityType: 'Partner', collection: 'partners' },
  'purchase-orders': { entityType: 'PurchaseOrder', collection: 'purchase_orders' },
  'import-shipments': { entityType: 'ImportShipment', collection: 'import_shipments' },
};

@ApiTags('History')
@Controller('history')
export class HistoryController {
  constructor(@Inject(MONGO_DATABASE) private readonly db: Db) {}

  @Get(':type/:id')
  async list(@Param('type') type: string, @Param('id') id: string, @Req() request: AuthenticatedRequest, @Query('page') page?: string, @Query('pageSize') pageSize?: string) {
    const target = ENTITY_TYPES[type];
    if (!target || !ObjectId.isValid(id)) throw new NotFoundException({ code: 'ENTITY_NOT_FOUND', message: 'Không tìm thấy hồ sơ' });
    const paging = pageRequest(page, pageSize) ?? { page: 1, pageSize: 20, skip: 0 };
    const filter: Document = { entityType: target.entityType, entityId: id };
    // Hủy / xóa chỉ quản trị gốc thấy (DOC-HIDE-01): hồ sơ đã hủy → không tìm thấy; sự kiện hủy / xóa (VD xóa thanh toán NCC) bị ẩn.
    if (!seesCancelled(request.user)) {
      const entity = await this.db.collection(target.collection).findOne({ _id: new ObjectId(id) }, { projection: { status: 1 } });
      if (entity?.status === 'CANCELLED') throw new NotFoundException({ code: 'ENTITY_NOT_FOUND', message: 'Không tìm thấy hồ sơ' });
      filter.action = { $not: /_(CANCELLED|DELETED|VOIDED)$/ };
    }
    const [events, total] = await Promise.all([
      this.db.collection('audit_events').find(filter).sort({ occurredAt: -1, _id: -1 }).skip(paging.skip).limit(paging.pageSize).toArray(),
      this.db.collection('audit_events').countDocuments(filter),
    ]);
    const actorIds = [...new Set(events.map((event) => String(event.actorId)).filter((value) => ObjectId.isValid(value)))].map((value) => new ObjectId(value));
    const users = actorIds.length ? await this.db.collection('users').find({ _id: { $in: actorIds } }, { projection: { displayName: 1 } }).toArray() : [];
    const nameById = new Map(users.map((user) => [user._id.toHexString(), String(user.displayName)]));
    const rows: HistoryEntry[] = events.map((event) => ({
      id: (event._id as ObjectId).toHexString(),
      action: String(event.action),
      ...(event.actorEmail ? { actorEmail: String(event.actorEmail) } : {}),
      ...(nameById.has(String(event.actorId)) ? { actorName: String(nameById.get(String(event.actorId))) } : {}),
      occurredAt: (event.occurredAt as Date).toISOString(),
      changes: diffFields(event.before, event.after),
      ...(event.metadata ? { metadata: event.metadata as Record<string, unknown> } : {}),
    }));
    return pageOf(rows, total, paging);
  }
}
