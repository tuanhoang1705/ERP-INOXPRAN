import { config } from 'dotenv';
import { resolve } from 'node:path';
import { authenticator } from 'otplib';

config({ path: process.env.ENV_FILE ?? resolve(process.cwd(), '../../.env'), quiet: true });

const baseUrl = process.env.API_BASE_URL ?? 'http://127.0.0.1:3000/api/v1';

async function main(): Promise<void> {
  const secret = process.env.ADMIN_TOTP_SECRET;
  const email = process.env.ADMIN_EMAIL;
  const password = process.env.ADMIN_PASSWORD;
  if (!secret || !email || !password) throw new Error('Local admin smoke-test credentials are missing');

  const login = await fetch(`${baseUrl}/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password, totpCode: authenticator.generate(secret) }),
  });
  if (!login.ok) throw new Error(`Login failed: ${login.status} ${await login.text()}`);
  const loginBody = await login.json() as { csrfToken: string };
  const cookies = login.headers.getSetCookie().map((value) => value.split(';')[0]).join('; ');

  async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const headers = new Headers(init.headers);
    headers.set('cookie', cookies);
    if ((init.method ?? 'GET') !== 'GET') {
      if (!headers.has('content-type')) headers.set('content-type', 'application/json');
      headers.set('x-csrf-token', loginBody.csrfToken);
      if (!headers.has('idempotency-key')) headers.set('idempotency-key', crypto.randomUUID());
    }
    const response = await fetch(`${baseUrl}${path}`, { ...init, headers });
    if (!response.ok) throw new Error(`${init.method ?? 'GET'} ${path}: ${response.status} ${await response.text()}`);
    return response.json() as Promise<T>;
  }

  const [warehouses, products, customers, suppliers] = await Promise.all([
    request<Array<{ id: string; code: string }>>('/warehouses'),
    request<Array<{ id: string; sku: string; baseUnit: string }>>('/products?status=ACTIVE'),
    request<Array<{ id: string; code: string }>>('/partners?kind=CUSTOMER'),
    request<Array<{ id: string; code: string }>>('/partners?kind=SUPPLIER'),
  ]);
  const warehouse = warehouses.find((item) => item.code === 'KHO-SD') ?? warehouses[0];
  // Điều chuyển chỉ kiểm thử khi có từ hai kho trở lên (INOXPRAN hiện có một kho Sơn Đồng).
  const secondaryWarehouse = warehouses.find((item) => item.id !== warehouse?.id);
  const product = products.find((item) => item.sku === 'INP2001');
  const customer = customers.find((item) => item.code === 'KH005');
  const supplier = suppliers.find((item) => item.code === 'NCC-OEM-QD');
  if (!warehouse || !product || !customer || !supplier) throw new Error('Demo master data is incomplete — chạy npm run seed:demo:reset');

  const keepers = await request<Array<{ id: string }>>(`/sales-orders/warehouse-keepers?warehouseId=${warehouse.id}`);
  if (!keepers[0]) throw new Error('Kho chưa có tài khoản thủ kho — chạy npm run seed:demo:reset');
  const salesOrderInput = { customerId: customer.id, warehouseId: warehouse.id, warehouseKeeperId: keepers[0].id, note: 'API smoke test', lines: [{ productId: product.id, quantity: '1', unit: product.baseUnit }] };
  const salesOrderKey = crypto.randomUUID();
  const salesOrder = await request<{ id: string; version: number; code: string }>('/sales-orders', {
    method: 'POST',
    headers: { 'idempotency-key': salesOrderKey },
    body: JSON.stringify(salesOrderInput),
  });
  const replayedOrder = await request<{ id: string; version: number; code: string }>('/sales-orders', {
    method: 'POST',
    headers: { 'idempotency-key': salesOrderKey },
    body: JSON.stringify(salesOrderInput),
  });
  if (replayedOrder.id !== salesOrder.id || replayedOrder.code !== salesOrder.code) {
    throw new Error('Idempotent replay created a different sales order');
  }

  const mismatchHeaders = new Headers({
    cookie: cookies,
    'content-type': 'application/json',
    'x-csrf-token': loginBody.csrfToken,
    'idempotency-key': salesOrderKey,
  });
  const mismatchResponse = await fetch(`${baseUrl}/sales-orders`, {
    method: 'POST',
    headers: mismatchHeaders,
    body: JSON.stringify({ ...salesOrderInput, note: 'Different payload' }),
  });
  const mismatchBody = await mismatchResponse.json() as { code?: string };
  if (mismatchResponse.status !== 409 || mismatchBody.code !== 'IDEMPOTENCY_KEY_REUSED') {
    throw new Error(`Idempotency payload mismatch was not rejected: ${mismatchResponse.status}`);
  }
  if (!/^BH\d{10}$/.test(salesOrder.code)) throw new Error(`Số phiếu BH sai định dạng: ${salesOrder.code}`);

  // Kế toán sửa phiếu nháp (thêm 1 dòng hàng tặng) trước khi phát hành.
  const editedOrder = await request<{ version: number; lines: Array<{ gift?: boolean }> }>(`/sales-orders/${salesOrder.id}`, {
    method: 'PATCH',
    body: JSON.stringify({ ...salesOrderInput, version: salesOrder.version, lines: [...salesOrderInput.lines, { productId: product.id, quantity: '1', unit: product.baseUnit, gift: true }] }),
  });
  if (editedOrder.lines.filter((line) => line.gift).length !== 1) throw new Error('Sửa phiếu không lưu được dòng hàng tặng');

  // Phát hành BH → kinh doanh yêu cầu sửa → phiếu quay về nháp và nhả hàng giữ.
  const latestVersion = async () => (await request<{ version: number }>(`/sales-orders/${salesOrder.id}`)).version;
  await request(`/sales-orders/${salesOrder.id}/submit`, { method: 'POST', body: JSON.stringify({ version: editedOrder.version }) });
  const blockedShip = await fetch(`${baseUrl}/sales-orders/${salesOrder.id}/ship`, {
    method: 'POST',
    headers: new Headers({ cookie: cookies, 'content-type': 'application/json', 'x-csrf-token': loginBody.csrfToken, 'idempotency-key': crypto.randomUUID() }),
    body: JSON.stringify({ version: await latestVersion() }),
  });
  const blockedBody = await blockedShip.json() as { code?: string };
  if (blockedShip.status !== 409 || blockedBody.code !== 'CUSTOMER_NOT_CONFIRMED') throw new Error(`Kho xuất được khi khách chưa xác nhận: ${blockedShip.status}`);
  await request(`/sales-orders/${salesOrder.id}/customer-confirmation`, { method: 'POST', body: JSON.stringify({ version: await latestVersion(), decision: 'REVISION_REQUESTED', note: 'Smoke: khách đổi số lượng' }) });
  const revised = await request<{ status: string; confirmationStatus: string; version: number }>(`/sales-orders/${salesOrder.id}`);
  if (revised.status !== 'DRAFT' || revised.confirmationStatus !== 'REVISION_REQUESTED') throw new Error('Yêu cầu sửa không trả phiếu về nháp');

  // Phát hành lại → khách xác nhận → kho lập SWK.
  await request(`/sales-orders/${salesOrder.id}/submit`, { method: 'POST', body: JSON.stringify({ version: revised.version }) });
  // Ảnh bằng chứng đối chiếu (PNG 2×2) — bắt buộc trước khi chuyển kho.
  const evidence = await request<{ id: string }>(`/sales-orders/${salesOrder.id}/attachments`, {
    method: 'POST',
    headers: { 'content-type': 'image/png', 'x-file-name': 'smoke-zalo.png' },
    body: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAFklEQVR4nGNgYGD4z8DAwMDAwMAAAA4AAf8d6ZoGAAAAAElFTkSuQmCC', 'base64'),
  });
  await request(`/sales-orders/${salesOrder.id}/customer-confirmation`, { method: 'POST', body: JSON.stringify({ version: await latestVersion(), decision: 'CONFIRMED', evidenceIds: [evidence.id] }) });
  const shipment = await request<{ shipmentCode: string; receivableId: string }>(`/sales-orders/${salesOrder.id}/ship`, {
    method: 'POST',
    body: JSON.stringify({ version: await latestVersion(), receiverName: 'Smoke Receiver', carrier: 'Khách tự lấy tại kho' }),
  });
  if (!/^SWK\d{10}$/.test(shipment.shipmentCode)) throw new Error(`Số phiếu SWK sai định dạng: ${shipment.shipmentCode}`);
  const receivables = await request<Array<{ id: string; partnerId: string; outstandingAmount: string }>>('/receivables');
  const receivable = receivables.find((item) => item.id === shipment.receivableId);
  if (!receivable) throw new Error('Shipment did not create a receivable');
  await request('/payments', { method: 'POST', body: JSON.stringify({ partnerId: receivable.partnerId, amount: receivable.outstandingAmount, method: 'BANK_TRANSFER', receivedAt: new Date().toISOString(), reference: 'SMOKE', allocations: [{ receivableId: receivable.id, amount: receivable.outstandingAmount }] }) });

  const purchaseOrder = await request<{ id: string; version: number; code: string }>('/purchase-orders', {
    method: 'POST',
    body: JSON.stringify({ supplierId: supplier.id, warehouseId: warehouse.id, note: 'API smoke test', lines: [{ productId: product.id, quantity: '2', unit: product.baseUnit, unitCost: '1000000' }] }),
  });
  await request(`/purchase-orders/${purchaseOrder.id}/submit`, { method: 'POST', body: JSON.stringify({ version: purchaseOrder.version }) });
  const receipt = await request<{ code: string }>('/goods-receipts', { method: 'POST', body: JSON.stringify({ purchaseOrderId: purchaseOrder.id, supplierDocumentReference: 'SMOKE', lines: [{ productId: product.id, quantity: '2' }] }) });

  type Balance = { productId: string; onHand: string };
  let transferCode: string | null = null;
  if (secondaryWarehouse) {
  const sourceBefore = (await request<Balance[]>(`/inventory/balances?warehouseId=${warehouse.id}`)).find((item) => item.productId === product.id);
  const destinationBefore = (await request<Balance[]>(`/inventory/balances?warehouseId=${secondaryWarehouse.id}`)).find((item) => item.productId === product.id);
  if (!sourceBefore) throw new Error('Source inventory balance is missing');
  const transferInput = {
    fromWarehouseId: warehouse.id,
    toWarehouseId: secondaryWarehouse.id,
    reason: 'API smoke test transfer',
    lines: [{ productId: product.id, quantity: '1' }],
  };
  const transferKey = crypto.randomUUID();
  const transfer = await request<{ id: string; code: string }>('/inventory/transfers', {
    method: 'POST',
    headers: { 'idempotency-key': transferKey },
    body: JSON.stringify(transferInput),
  });
  const replayedTransfer = await request<{ id: string; code: string }>('/inventory/transfers', {
    method: 'POST',
    headers: { 'idempotency-key': transferKey },
    body: JSON.stringify(transferInput),
  });
  if (transfer.id !== replayedTransfer.id) throw new Error('Idempotent transfer replay created a second transfer');

  const rollbackKey = crypto.randomUUID();
  const failedTransferResponse = await fetch(`${baseUrl}/inventory/transfers`, {
    method: 'POST',
    headers: new Headers({
      cookie: cookies,
      'content-type': 'application/json',
      'x-csrf-token': loginBody.csrfToken,
      'idempotency-key': rollbackKey,
    }),
    body: JSON.stringify({ ...transferInput, lines: [{ productId: product.id, quantity: '999999999' }] }),
  });
  if (failedTransferResponse.status !== 409) {
    throw new Error(`Insufficient-stock transfer was not rejected: ${failedTransferResponse.status}`);
  }
  await request('/inventory/transfers', {
    method: 'POST',
    headers: { 'idempotency-key': rollbackKey },
    body: JSON.stringify(transferInput),
  });
  const sourceAfter = (await request<Balance[]>(`/inventory/balances?warehouseId=${warehouse.id}`)).find((item) => item.productId === product.id);
  const destinationAfter = (await request<Balance[]>(`/inventory/balances?warehouseId=${secondaryWarehouse.id}`)).find((item) => item.productId === product.id);
  if (!sourceAfter || !destinationAfter) throw new Error('Transfer inventory balance is missing');
  if (Number(sourceAfter.onHand) !== Number(sourceBefore.onHand) - 2) throw new Error('Transfers did not decrement source stock exactly once each');
  if (Number(destinationAfter.onHand) !== Number(destinationBefore?.onHand ?? '0') + 2) throw new Error('Transfers did not increment destination stock exactly once each');
  transferCode = transfer.code;
  }
  const dashboard = await request<{ recentOrders: unknown[] }>('/dashboard/summary');

  process.stdout.write(JSON.stringify({ ok: true, idempotencyReplay: true, idempotencyMismatchRejected: true, transactionRollbackRecovery: transferCode ? true : 'skipped (single warehouse)', inventoryTransfer: transferCode ?? 'skipped (single warehouse)', salesOrder: salesOrder.code, shipment: shipment.shipmentCode, purchaseOrder: purchaseOrder.code, receipt: receipt.code, dashboardRecentOrders: dashboard.recentOrders.length }, null, 2));
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.exitCode = 1;
});
