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
      headers.set('content-type', 'application/json');
      headers.set('x-csrf-token', loginBody.csrfToken);
      headers.set('idempotency-key', crypto.randomUUID());
    }
    const response = await fetch(`${baseUrl}${path}`, { ...init, headers });
    if (!response.ok) throw new Error(`${init.method ?? 'GET'} ${path}: ${response.status} ${await response.text()}`);
    return response.json() as Promise<T>;
  }

  const [warehouses, products, suppliers] = await Promise.all([
    request<Array<{ id: string; code: string }>>('/warehouses'),
    request<Array<{ id: string; sku: string; baseUnit: string }>>('/products?status=ACTIVE'),
    request<Array<{ id: string; code: string }>>('/partners?kind=SUPPLIER'),
  ]);
  const warehouse = warehouses.find((item) => item.code === 'KHO-SD') ?? warehouses[0];
  const product = products.find((item) => item.sku === 'INP2001');
  const supplier = suppliers.find((item) => item.code === 'NCC-OEM-QD');
  if (!warehouse || !product || !supplier) throw new Error('Demo master data is incomplete');

  const order = await request<{ id: string; code: string; version: number }>('/purchase-orders', {
    method: 'POST',
    body: JSON.stringify({
      supplierId: supplier.id,
      warehouseId: warehouse.id,
      note: 'Worker smoke test',
      lines: [{ productId: product.id, quantity: '1', unit: product.baseUnit, unitCost: '250000000' }],
    }),
  });
  const submitted = await request<{ status: string }>(`/purchase-orders/${order.id}/submit`, {
    method: 'POST',
    body: JSON.stringify({ version: order.version }),
  });
  if (submitted.status !== 'PENDING_APPROVAL') throw new Error('Smoke order did not enter approval workflow');

  type Notification = { id: string; title: string; href?: string; readAt?: string | null };
  let notification: Notification | undefined;
  for (let attempt = 0; attempt < 20 && !notification; attempt += 1) {
    const notifications = await request<Notification[]>('/notifications?unreadOnly=true');
    notification = notifications.find((item) => item.href === `/procurement/${order.id}`);
    if (!notification) await new Promise((resolveDelay) => setTimeout(resolveDelay, 500));
  }
  if (!notification) throw new Error('Outbox worker did not create an in-app approval notification');

  await request(`/notifications/${notification.id}/read`, { method: 'POST', body: '{}' });
  const unread = await request<Notification[]>('/notifications?unreadOnly=true');
  if (unread.some((item) => item.id === notification?.id)) throw new Error('Notification was not marked as read');

  process.stdout.write(JSON.stringify({
    ok: true,
    purchaseOrder: order.code,
    outboxDelivered: true,
    notificationMarkedRead: true,
  }, null, 2));
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.exitCode = 1;
});
