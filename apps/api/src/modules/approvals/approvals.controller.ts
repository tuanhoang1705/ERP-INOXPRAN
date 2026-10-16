import { Controller, Get, Inject, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { Db, Document, ObjectId } from 'mongodb';
import { serializeDocument } from '../../common/domain';
import { Roles } from '../../common/roles.decorator';
import { MONGO_DATABASE } from '../../common/tokens';

@ApiTags('Approvals')
@Roles('ADMIN', 'SALES_MANAGER', 'PROCUREMENT_MANAGER', 'DIRECTOR')
@Controller('approval-requests')
export class ApprovalsController {
  constructor(@Inject(MONGO_DATABASE) private readonly db: Db) {}

  @Get()
  async list(@Query('status') status = 'PENDING') {
    const filter: Document = status ? { status } : {};
    const approvals = await this.db.collection('approval_requests').find(filter).sort({ requestedAt: -1 }).limit(250).toArray();

    return Promise.all(
      approvals.map(async (approval) => {
        const collection = approval.entityType === 'SalesOrder' ? 'sales_orders' : 'purchase_orders';
        const entity = await this.db.collection(collection).findOne(
          { _id: approval.entityId as ObjectId },
          { projection: { code: 1, customerName: 1, supplierName: 1, grandTotal: 1, total: 1, version: 1, status: 1 } },
        );
        return serializeDocument({
          ...approval,
          entityCode: entity?.code ?? '—',
          counterpartyName: entity?.customerName ?? entity?.supplierName ?? '—',
          amount: entity?.grandTotal ?? entity?.total ?? '0',
          entityVersion: entity?.version,
          entityStatus: entity?.status,
        });
      }),
    );
  }
}
