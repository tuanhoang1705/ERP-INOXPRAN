import { Controller, Get, Inject, Param, Req } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { Db, Document } from 'mongodb';
import { toObjectId } from '../../common/domain';
import type { AuthenticatedRequest } from '../../common/request-context';
import { Area } from '../../common/roles.decorator';
import { MONGO_DATABASE } from '../../common/tokens';
import { StockReturnsService } from './stock-returns.service';
import { returnPrintPricing } from './stock-return-print-pricing';

/** Separate read-only endpoint to avoid changing the in-progress return/edit/accounting workflows. */
@ApiTags('Inventory')
@Controller('inventory/returns')
export class StockReturnPrintController {
  constructor(@Inject(MONGO_DATABASE) private readonly db: Db, private readonly returns: StockReturnsService) {}

  @Area('inventory.returns')
  @Get(':id/print')
  async get(@Param('id') id: string, @Req() request: AuthenticatedRequest) {
    // Reuse the source document's access checks, including hidden cancelled documents.
    const slip = await this.returns.get(id, request.user) as Document;
    const [partner, order, payment, employee, staff] = await Promise.all([
      slip.partnerId ? this.db.collection('partners').findOne({ _id: toObjectId(String(slip.partnerId)) }, { projection: { address: 1, phone: 1, taxCode: 1 } }) : null,
      slip.salesOrderCode ? this.db.collection('sales_orders').findOne({ code: slip.salesOrderCode }) : null,
      slip.creditNote?.paymentId ? this.db.collection('payments').findOne({ _id: toObjectId(String(slip.creditNote.paymentId)), stockReturnId: toObjectId(id), kind: 'RETURN', status: 'POSTED' }) : null,
      slip.salesRepId ? this.db.collection('employees').findOne({ _id: toObjectId(String(slip.salesRepId)) }, { projection: { name: 1 } }) : null,
      slip.staffUserId ? this.db.collection('users').findOne({ _id: toObjectId(String(slip.staffUserId)) }, { projection: { displayName: 1 } }) : null,
    ]);
    const pricing = returnPrintPricing(slip, order, payment);
    return {
      slip,
      party: { address: order?.buyer?.address ?? partner?.address ?? '', phone: order?.buyer?.phone ?? partner?.phone ?? '', taxCode: order?.buyer?.taxCode ?? partner?.taxCode ?? '', contactName: order?.contactName ?? '' },
      staffName: slip.borrowerName ?? order?.salesRepName ?? employee?.name ?? staff?.displayName ?? '',
      destination: slip.warehouseName,
      pricing,
    };
  }
}
