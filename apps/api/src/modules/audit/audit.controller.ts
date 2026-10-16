import { Controller, Get, Inject, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { Db, Document } from 'mongodb';
import { dateRangeFilter } from '../../common/date-range';
import { serializeDocument } from '../../common/domain';
import { pageOf, pageRequest } from '../../common/paging';
import { Roles, RootOnly } from '../../common/roles.decorator';
import { MONGO_DATABASE } from '../../common/tokens';

const ESCAPE = /[.*+?^${}()|[\]\\]/g;

/** Nhật ký kiểm toán (ai làm gì, lúc nào, trước / sau): lọc theo người, đối tượng, hành động, khoảng ngày (giờ Việt Nam). */
@ApiTags('Audit')
@RootOnly()
@Roles('ADMIN')
@Controller('audit-events')
export class AuditController {
  constructor(@Inject(MONGO_DATABASE) private readonly db: Db) {}

  @Get()
  async list(
    @Query('entityType') entityType?: string,
    @Query('entityId') entityId?: string,
    @Query('actorId') actorId?: string,
    @Query('action') action?: string,
    @Query('search') search?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
  ) {
    const filter: Document = {};
    if (entityType) filter.entityType = entityType;
    if (entityId) filter.entityId = entityId;
    if (actorId) filter.actorId = actorId;
    if (action) filter.action = new RegExp(`^${action.replace(ESCAPE, '\\$&')}`);
    if (search) {
      const pattern = new RegExp(search.replace(ESCAPE, '\\$&'), 'i');
      filter.$or = [{ actorEmail: pattern }, { action: pattern }, { entityId: pattern }, { 'metadata.email': pattern }];
    }
    Object.assign(filter, dateRangeFilter('occurredAt', from, to));
    const paging = pageRequest(page, pageSize);
    const cursor = this.db.collection('audit_events').find(filter).sort({ occurredAt: -1, _id: -1 });
    if (!paging) return (await cursor.limit(500).toArray()).map(serializeDocument);
    const [rows, total] = await Promise.all([cursor.skip(paging.skip).limit(paging.pageSize).toArray(), this.db.collection('audit_events').countDocuments(filter)]);
    return pageOf(rows.map(serializeDocument), total, paging);
  }
}
