import { Inject, Injectable, OnModuleInit } from '@nestjs/common';
import type { Db } from 'mongodb';
import { MONGO_DATABASE } from './tokens';

@Injectable()
export class DatabaseIndexesService implements OnModuleInit {
  constructor(@Inject(MONGO_DATABASE) private readonly db: Db) {}

  async onModuleInit(): Promise<void> {
    await Promise.all([
      this.db.collection('users').createIndex({ email: 1 }, { unique: true }),
      this.db.collection('products').createIndex({ sku: 1 }, { unique: true }),
      this.db.collection('products').createIndex({ name: 'text', sku: 'text' }),
      this.db.collection('partners').createIndex({ code: 1 }, { unique: true }),
      this.db.collection('partners').createIndex({ name: 'text', code: 'text' }),
      this.db.collection('partners').createIndex({ kind: 1, stage: 1, grade: 1 }),
      this.db.collection('partner_activities').createIndex({ partnerId: 1, occurredAt: -1 }),
      this.db.collection('partner_activities').createIndex({ done: 1, followUpOn: 1, ownerId: 1 }),
      this.db.collection('outbox_events').createIndex({ aggregateType: 1, aggregateId: 1 }),
      this.db.collection('warehouses').createIndex({ code: 1 }, { unique: true }),
      this.db.collection('promotions').createIndex({ code: 1 }, { unique: true }),
      this.db.collection('product_categories').createIndex({ code: 1 }, { unique: true }),
      this.db.collection('locations').createIndex({ warehouseId: 1, code: 1 }, { unique: true }),
      this.db.collection('regions').createIndex({ code: 1 }, { unique: true }),
      this.db.collection('employees').createIndex({ code: 1 }, { unique: true }),
      this.db.collection('sales_orders').createIndex({ code: 1 }, { unique: true }),
      this.db.collection('sales_orders').createIndex({ customerId: 1, createdAt: -1 }),
      this.db.collection('sales_orders').createIndex({ warehouseKeeperId: 1, status: 1, orderDate: -1 }),
      this.db.collection('attachments').createIndex({ entityType: 1, entityId: 1, purpose: 1, status: 1 }),
      this.db.collection('attachments').createIndex({ status: 1, expiresAt: 1 }),
      this.db.collection('attachments').dropIndex('expiresAt_1').catch(() => undefined),
      this.db.collection('branches').createIndex({ code: 1 }, { unique: true }),
      this.db.collection('purchase_orders').createIndex({ code: 1 }, { unique: true }),
      this.db.collection('purchase_orders').createIndex({ supplierId: 1, createdAt: -1 }),
      this.db.collection('import_shipments').createIndex({ code: 1 }, { unique: true }),
      this.db.collection('import_batches').createIndex({ sha256: 1, status: 1 }),
      this.db.collection('import_batches').createIndex({ createdAt: -1 }),
      this.db.collection('receivables').createIndex({ sourceType: 1, partnerId: 1, openingDocumentNo: 1 }),
      this.db.collection('import_shipments').createIndex({ purchaseOrderIds: 1, status: 1 }),
      this.db.collection('goods_receipts').createIndex({ importShipmentId: 1 }),
      this.db.collection('inventory_balances').createIndex({ warehouseId: 1, productId: 1 }, { unique: true }),
      this.db.collection('inventory_movements').createIndex({ productId: 1, warehouseId: 1, occurredAt: -1 }),
      this.db.collection('inventory_transfers').createIndex({ code: 1 }, { unique: true }),
      this.db.collection('inventory_movements').createIndex({ occurredAt: 1, warehouseId: 1 }),
      this.db.collection('stock_returns').createIndex({ code: 1 }, { unique: true }),
      this.db.collection('employees').createIndex({ userId: 1 }, { unique: true, partialFilterExpression: { userId: { $type: 'objectId' } } }),
      this.db.collection('stock_returns').createIndex({ kind: 1, createdAt: -1 }),
      this.db.collection('stock_returns').createIndex({ salesOrderCode: 1 }, { sparse: true }),
      // Kiểm kê (STK-01): mỗi kho chỉ một phiếu đang mở.
      this.db.collection('stock_counts').createIndex({ code: 1 }, { unique: true }),
      this.db.collection('stock_counts').createIndex({ warehouseId: 1 }, { unique: true, partialFilterExpression: { open: true }, name: 'one_open_count_per_warehouse' }),
      this.db.collection('stock_counts').createIndex({ warehouseId: 1, startedAt: -1 }),
      this.db.collection('stock_counts').createIndex({ period: 1, status: 1 }),
      this.db.collection('receivables').createIndex({ partnerId: 1, dueDate: 1, status: 1 }),
      this.db.collection('audit_events').createIndex({ entityType: 1, entityId: 1, occurredAt: -1 }),
      this.db.collection('approval_requests').createIndex({ status: 1, requestedAt: -1 }),
      this.db.collection('outbox_events').createIndex({ status: 1, availableAt: 1, occurredAt: 1 }),
      this.db.collection('notifications').createIndex({ userId: 1, readAt: 1, createdAt: -1 }),
      this.db.collection('notifications').createIndex({ outboxEventId: 1, userId: 1 }, { unique: true }),
      this.db.collection('idempotency_keys').createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 }),
      this.db.collection('warranty_tickets').createIndex({ code: 1 }, { unique: true }),
      this.db.collection('warranty_tickets').createIndex({ status: 1, promisedDate: 1 }),
      this.db.collection('warranty_tickets').createIndex({ 'product.productId': 1, 'invoice.number': 1 }),
      this.db.collection('warranty_tickets').createIndex({ receivedAt: -1 }),
      this.db.collection('warranty_tickets').createIndex({ returnedAt: -1 }),
      this.db.collection('warranty_fault_codes').createIndex({ code: 1 }, { unique: true }),
      // Lịch sử đăng nhập tự xóa sau 180 ngày.
      this.db.collection('login_events').createIndex({ at: 1 }, { expireAfterSeconds: 180 * 24 * 3600 }),
      this.db.collection('login_events').createIndex({ userId: 1, at: -1 }),
      this.db.collection('login_events').createIndex({ success: 1, at: -1 }),
      this.db.collection('users').createIndex({ status: 1, lastSeenAt: -1 }),
      this.db.collection('system_jobs').createIndex({ type: 1, at: -1 }),
      this.db.collection('audit_events').createIndex({ occurredAt: -1 }),
    ]);
  }
}
