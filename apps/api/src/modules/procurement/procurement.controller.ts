import { Body, Controller, Delete, Get, Headers, Param, Patch, Post, Query, Req } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import {
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
import { Roles } from '../../common/roles.decorator';
import type { AuthenticatedRequest } from '../../common/request-context';
import { pageRequest } from '../../common/paging';
import { ImportShipmentsService } from './import-shipments.service';
import { ProcurementService } from './procurement.service';

const VersionSchema = z.object({ version: z.number().int().positive() });
const BUYERS = ['ADMIN', 'PROCUREMENT', 'PROCUREMENT_MANAGER'];
/** Lô hàng nhập: mua hàng, Giám đốc, kế toán (nhập chi phí / tờ khai). */
const SHIPMENT_EDITORS = ['ADMIN', 'PROCUREMENT', 'PROCUREMENT_MANAGER', 'DIRECTOR', 'ACCOUNTANT'];
const RECEIVERS = ['ADMIN', 'DIRECTOR', 'WAREHOUSE', 'WAREHOUSE_MANAGER'];

@ApiTags('Procurement')
@Controller()
export class ProcurementController {
  constructor(
    private readonly procurement: ProcurementService,
    private readonly shipments: ImportShipmentsService,
  ) {}

  @Get('purchase-orders')
  list(
    @Query('status') status?: string, @Query('search') search?: string, @Query('page') page?: string, @Query('pageSize') pageSize?: string,
    @Query('supplierId') supplierId?: string, @Query('from') from?: string, @Query('to') to?: string,
  ) {
    return this.procurement.list(status, search, pageRequest(page, pageSize), supplierId, from, to);
  }

  @Get('purchase-orders/:id')
  get(@Param('id') id: string) {
    return this.procurement.get(id);
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

  @Roles('ADMIN', 'PROCUREMENT_MANAGER', 'DIRECTOR')
  @Post('purchase-orders/:id/approve')
  approve(@Param('id') id: string, @Body() body: unknown, @Headers('idempotency-key') key: string | undefined, @Req() request: AuthenticatedRequest) {
    return this.procurement.approve(id, VersionSchema.parse(body).version, request, key);
  }

  @Roles('ADMIN', 'PROCUREMENT_MANAGER', 'DIRECTOR')
  @Post('purchase-orders/:id/cancel')
  cancel(@Param('id') id: string, @Body() body: unknown, @Headers('idempotency-key') key: string | undefined, @Req() request: AuthenticatedRequest) {
    return this.procurement.cancel(id, VersionSchema.parse(body).version, request, key);
  }

  /** Tiền đã trả nhà cung cấp: kế toán, Giám đốc, trưởng phòng mua hàng. */
  @Roles('ADMIN', 'ACCOUNTANT', 'DIRECTOR', 'PROCUREMENT_MANAGER')
  @Post('purchase-orders/:id/payments')
  addPayment(@Param('id') id: string, @Body() body: unknown, @Req() request: AuthenticatedRequest) {
    return this.procurement.addPayment(id, SupplierPaymentSchema.parse(body), request);
  }

  @Roles('ADMIN', 'ACCOUNTANT', 'DIRECTOR', 'PROCUREMENT_MANAGER')
  @Delete('purchase-orders/:id/payments/:paymentId')
  removePayment(@Param('id') id: string, @Param('paymentId') paymentId: string, @Req() request: AuthenticatedRequest) {
    return this.procurement.removePayment(id, paymentId, request);
  }

  @Roles(...RECEIVERS)
  @Post('goods-receipts')
  receive(@Body() body: unknown, @Headers('idempotency-key') key: string | undefined, @Req() request: AuthenticatedRequest) {
    return this.procurement.receive(CreateGoodsReceiptSchema.parse(body), request, key);
  }

  // ---------- lô hàng nhập ----------

  @Get('import-shipments')
  shipmentList(
    @Query('status') status?: string, @Query('search') search?: string, @Query('purchaseOrderId') purchaseOrderId?: string, @Query('page') page?: string,
    @Query('pageSize') pageSize?: string, @Query('from') from?: string, @Query('to') to?: string,
  ) {
    return this.shipments.list({ status, search, purchaseOrderId, from, to }, pageRequest(page ?? '1', pageSize) ?? { page: 1, pageSize: 50, skip: 0 });
  }

  @Roles(...SHIPMENT_EDITORS)
  @Get('import-shipments/draft')
  shipmentDraft(@Query('purchaseOrderId') purchaseOrderId: string) {
    return this.shipments.draft(purchaseOrderId);
  }

  @Get('import-shipments/:id')
  shipment(@Param('id') id: string) {
    return this.shipments.get(id);
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
