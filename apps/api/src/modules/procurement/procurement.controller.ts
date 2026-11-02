import { Body, Controller, Delete, Get, Headers, Param, Patch, Post, Query, Req } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import {
  CorrectGoodsReceiptSchema,
  CreateGoodsReceiptSchema,
  CreateImportShipmentSchema,
  CreatePurchaseOrderSchema,
  ReceiveImportShipmentSchema,
  SupplierPaymentSchema,
  UpdateImportShipmentSchema,
  UpdatePurchaseOrderSchema,
} from '@inoxpran/contracts';
import { z } from 'zod';
import { assertWarehouseAccess } from '../../common/access';
import { onlyProvided } from '../../common/patch';
import { AllowReadOnly, Roles } from '../../common/roles.decorator';
import type { AuthenticatedRequest } from '../../common/request-context';
import { pageRequest } from '../../common/paging';
import { ImportShipmentsService } from './import-shipments.service';
import { PayablesService } from './payables.service';
import { ProcurementService } from './procurement.service';

const VersionSchema = z.object({ version: z.number().int().positive() });
const BUYERS = ['ADMIN', 'PROCUREMENT', 'PROCUREMENT_MANAGER'];
/** Lô hàng nhập: mua hàng, kế toán (nhập chi phí / tờ khai). Giám đốc chỉ xem (ROLE-DIR-01). */
const SHIPMENT_EDITORS = ['ADMIN', 'PROCUREMENT', 'PROCUREMENT_MANAGER', 'ACCOUNTANT'];
const RECEIVERS = ['ADMIN', 'WAREHOUSE', 'WAREHOUSE_MANAGER'];
const PAYABLE_VIEWERS = ['ADMIN', 'ACCOUNTANT', 'DIRECTOR', 'AUDITOR', 'PROCUREMENT', 'PROCUREMENT_MANAGER'];

@ApiTags('Procurement')
@Controller()
export class ProcurementController {
  constructor(
    private readonly procurement: ProcurementService,
    private readonly shipments: ImportShipmentsService,
    private readonly payablesBook: PayablesService,
  ) {}

  @Get('purchase-orders')
  list(
    @Req() request: AuthenticatedRequest,
    @Query('status') status?: string, @Query('search') search?: string, @Query('page') page?: string, @Query('pageSize') pageSize?: string,
    @Query('supplierId') supplierId?: string, @Query('from') from?: string, @Query('to') to?: string,
  ) {
    return this.procurement.list(status, search, pageRequest(page, pageSize), supplierId, from, to, request.user);
  }

  @Get('purchase-orders/:id')
  get(@Param('id') id: string, @Req() request: AuthenticatedRequest) {
    return this.procurement.get(id, request.user);
  }

  @Roles(...BUYERS)
  @Post('purchase-orders')
  create(@Body() body: unknown, @Headers('idempotency-key') key: string | undefined, @Req() request: AuthenticatedRequest) {
    const input = CreatePurchaseOrderSchema.parse(body);
    assertWarehouseAccess(request, input.warehouseId);
    return this.procurement.create(input, request, key);
  }

  @Roles(...BUYERS)
  @Patch('purchase-orders/:id')
  update(@Param('id') id: string, @Body() body: unknown, @Req() request: AuthenticatedRequest) {
    const input = UpdatePurchaseOrderSchema.parse(body);
    if (input.warehouseId) assertWarehouseAccess(request, input.warehouseId);
    return this.procurement.update(id, { ...onlyProvided(body, input), version: input.version }, request);
  }

  @Roles(...BUYERS)
  @Post('purchase-orders/:id/submit')
  submit(@Param('id') id: string, @Body() body: unknown, @Headers('idempotency-key') key: string | undefined, @Req() request: AuthenticatedRequest) {
    return this.procurement.submit(id, VersionSchema.parse(body).version, request, key);
  }

  // Giám đốc chỉ xem nhưng vẫn duyệt đơn mua (ROLE-DIR-01).
  @Roles('ADMIN', 'PROCUREMENT_MANAGER', 'DIRECTOR')
  @AllowReadOnly()
  @Post('purchase-orders/:id/approve')
  approve(@Param('id') id: string, @Body() body: unknown, @Headers('idempotency-key') key: string | undefined, @Req() request: AuthenticatedRequest) {
    return this.procurement.approve(id, VersionSchema.parse(body).version, request, key);
  }

  @Roles('ADMIN', 'PROCUREMENT_MANAGER')
  @Post('purchase-orders/:id/cancel')
  cancel(@Param('id') id: string, @Body() body: unknown, @Headers('idempotency-key') key: string | undefined, @Req() request: AuthenticatedRequest) {
    return this.procurement.cancel(id, VersionSchema.parse(body).version, request, key);
  }

  /** Tiền đã trả nhà cung cấp: kế toán, trưởng phòng mua hàng. */
  @Roles('ADMIN', 'ACCOUNTANT', 'PROCUREMENT_MANAGER')
  @Post('purchase-orders/:id/payments')
  addPayment(@Param('id') id: string, @Body() body: unknown, @Req() request: AuthenticatedRequest) {
    return this.procurement.addPayment(id, SupplierPaymentSchema.parse(body), request);
  }

  @Roles('ADMIN', 'ACCOUNTANT', 'PROCUREMENT_MANAGER')
  @Delete('purchase-orders/:id/payments/:paymentId')
  removePayment(@Param('id') id: string, @Param('paymentId') paymentId: string, @Req() request: AuthenticatedRequest) {
    return this.procurement.removePayment(id, paymentId, request);
  }

  /** Sổ phải trả nhà cung cấp (D2, 22/10/2026): kế toán, Giám đốc, kiểm soát, mua hàng. */
  @Roles(...PAYABLE_VIEWERS)
  @Get('payables')
  payables(@Query('search') search?: string) {
    return this.payablesBook.suppliers(search);
  }

  @Roles(...PAYABLE_VIEWERS)
  @Get('payables/:supplierId')
  payableStatement(@Param('supplierId') supplierId: string) {
    return this.payablesBook.statement(supplierId);
  }

  @Roles(...RECEIVERS)
  @Post('goods-receipts')
  receive(@Body() body: unknown, @Headers('idempotency-key') key: string | undefined, @Req() request: AuthenticatedRequest) {
    return this.procurement.receive(CreateGoodsReceiptSchema.parse(body), request, key);
  }

  /** Phiếu nhập kho đã ghi của một đơn mua / lô hàng (để xem và sửa). */
  @Get('goods-receipts')
  receipts(@Query('purchaseOrderId') purchaseOrderId?: string, @Query('importShipmentId') importShipmentId?: string) {
    return this.procurement.listReceipts({ purchaseOrderId, importShipmentId });
  }

  @Get('goods-receipts/:id')
  receipt(@Param('id') id: string) {
    return this.procurement.getReceipt(id);
  }

  /** Sửa số thực nhận / vị trí của phiếu nhập kho đã ghi (20/10/2026) — thẻ kho ghi chênh lệch, đơn mua / lô / giá vốn cập nhật theo. */
  @Roles(...RECEIVERS)
  @Patch('goods-receipts/:id')
  async correctReceipt(@Param('id') id: string, @Body() body: unknown, @Headers('idempotency-key') key: string | undefined, @Req() request: AuthenticatedRequest) {
    const input = CorrectGoodsReceiptSchema.parse(body);
    assertWarehouseAccess(request, (await this.procurement.getReceipt(id)).warehouseId);
    return this.shipments.correctReceipt(id, input, request, key);
  }

  // ---------- lô hàng nhập ----------

  @Get('import-shipments')
  shipmentList(
    @Req() request: AuthenticatedRequest,
    @Query('status') status?: string, @Query('search') search?: string, @Query('purchaseOrderId') purchaseOrderId?: string, @Query('page') page?: string,
    @Query('pageSize') pageSize?: string, @Query('from') from?: string, @Query('to') to?: string,
  ) {
    return this.shipments.list({ status, search, purchaseOrderId, from, to }, pageRequest(page ?? '1', pageSize) ?? { page: 1, pageSize: 50, skip: 0 }, request.user);
  }

  @Roles(...SHIPMENT_EDITORS)
  @Get('import-shipments/draft')
  shipmentDraft(@Query('purchaseOrderId') purchaseOrderId: string) {
    return this.shipments.draft(purchaseOrderId);
  }

  @Get('import-shipments/:id')
  shipment(@Param('id') id: string, @Req() request: AuthenticatedRequest) {
    return this.shipments.get(id, request.user);
  }

  @Roles(...SHIPMENT_EDITORS)
  @Post('import-shipments')
  createShipment(@Body() body: unknown, @Headers('idempotency-key') key: string | undefined, @Req() request: AuthenticatedRequest) {
    return this.shipments.create(CreateImportShipmentSchema.parse(body), request, key);
  }

  @Roles(...SHIPMENT_EDITORS)
  @Patch('import-shipments/:id')
  updateShipment(@Param('id') id: string, @Body() body: unknown, @Req() request: AuthenticatedRequest) {
    const input = UpdateImportShipmentSchema.parse(body);
    return this.shipments.update(id, { ...onlyProvided(body, input), version: input.version }, request);
  }

  @Roles(...RECEIVERS)
  @Post('import-shipments/:id/receive')
  receiveShipment(@Param('id') id: string, @Body() body: unknown, @Headers('idempotency-key') key: string | undefined, @Req() request: AuthenticatedRequest) {
    return this.shipments.receive(id, ReceiveImportShipmentSchema.parse(body), request, key);
  }
}
