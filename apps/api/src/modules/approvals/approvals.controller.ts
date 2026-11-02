import { Controller, Get, Inject, Query, Req } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { Db, Document, ObjectId } from 'mongodb';
import { serializeDocument } from '../../common/domain';
import { hideStatus } from '../../common/hidden-documents';
import type { AuthenticatedRequest } from '../../common/request-context';
import { Roles } from '../../common/roles.decorator';
import { MONGO_DATABASE } from '../../common/tokens';

@ApiTags('Approvals')
@Roles('ADMIN', 'SALES_MANAGER', 'PROCUREMENT_MANAGER', 'DIRECTOR')
@Controller('approval-requests')
export class ApprovalsController {
  constructor(@Inject(MONGO_DATABASE) private readonly db: Db) {}

  @Get()
  async list(@Req() request: AuthenticatedRequest, @Query('status') status = 'PENDING') {
    // Yêu cầu đã hủy (phiếu hủy / xóa) chỉ quản trị gốc thấy (DOC-HIDE-01).
    const filter: Document = hideStatus(status ? { status } : {}, request.user);
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
