import { CLOSED_WARRANTY_STATUSES, slaState, WARRANTY_DEFAULTS, type SlaState } from '@inoxpran/contracts';
import { type Db, type Document, ObjectId } from 'mongodb';

export const WARRANTY_TICKETS = 'warranty_tickets';

export interface WarrantySettings {
  warrantyMonths: number;
  turnaroundDays: number;
  warningRatio: number;
}

export async function warrantySettings(db: Db): Promise<WarrantySettings> {
  const stored = await db.collection<{ _id: string } & Document>('settings').findOne({ _id: 'warranty' });
  return {
    warrantyMonths: Number(stored?.warrantyMonths ?? WARRANTY_DEFAULTS.warrantyMonths),
    turnaroundDays: Number(stored?.turnaroundDays ?? WARRANTY_DEFAULTS.turnaroundDays),
    warningRatio: Number(stored?.warningRatio ?? WARRANTY_DEFAULTS.warningRatio),
  };
}

export function ticketSla(ticket: Document, settings: WarrantySettings, now = new Date()): SlaState {
  return slaState({
    receivedAt: ticket.receivedAt as Date,
    promisedDate: String(ticket.promisedDate),
    now,
    closedAt: (ticket.returnedAt as Date | undefined) ?? (ticket.status === 'CANCELLED' ? (ticket.updatedAt as Date) : null),
    warningRatio: settings.warningRatio,
  });
}

export async function openWarrantyTickets(db: Db): Promise<Document[]> {
  return db.collection(WARRANTY_TICKETS).find({ status: { $nin: [...CLOSED_WARRANTY_STATUSES] } }).toArray();
}

/**
 * Nhắc hẹn trả: phiếu vừa sang vàng (đã qua 70% thời gian hẹn) báo nhân viên bảo hành; phiếu vừa sang đỏ (quá hẹn)
 * báo thêm Quản lý kho (WAR-ROLE-01, 28/10/2026 — trước đây Giám đốc). Mỗi mức chỉ báo một lần; dời hẹn thì đặt lại để báo theo hẹn mới.
 */
export async function runWarrantySlaReview(db: Db, now = new Date()): Promise<{ warning: number; overdue: number }> {
  const settings = await warrantySettings(db);
  const counts = { warning: 0, overdue: 0 };
  for (const ticket of await openWarrantyTickets(db)) {
    const state = ticketSla(ticket, settings, now);
    const notified = ticket.slaNotified as string | undefined;
    const level = state.tone === 'overdue' && notified !== 'overdue' ? 'overdue' : state.tone === 'warning' && !notified ? 'warning' : null;
    if (!level) continue;
    const id = (ticket._id as ObjectId).toHexString();
    const customer = String((ticket.customer as Document).name);
    const product = String((ticket.product as Document).sku);
    const params = level === 'overdue'
      ? { code: String(ticket.code), customer, product, promisedDate: String(ticket.promisedDate), lateDays: state.lateDays }
      : { code: String(ticket.code), customer, product, promisedDate: String(ticket.promisedDate), daysLeft: state.daysLeft };
    await db.collection('outbox_events').insertOne({
      _id: new ObjectId(),
      eventType: 'NOTIFICATION_REQUESTED',
      aggregateType: 'WarrantyTicket',
      aggregateId: `${id}:${level}:${String(ticket.promisedDate)}`,
      payload: {
        category: 'WARRANTY',
        targetRoles: level === 'overdue' ? ['WARRANTY', 'WAREHOUSE_MANAGER'] : ['WARRANTY'],
        level: level === 'overdue' ? 'CRITICAL' : 'WARNING',
        title: level === 'overdue' ? `Phiếu bảo hành ${String(ticket.code)} đã quá hẹn trả` : `Phiếu bảo hành ${String(ticket.code)} sắp đến hẹn trả`,
        message: level === 'overdue'
          ? `${customer} — ${product}: hẹn ${String(ticket.promisedDate)}, trễ ${state.lateDays} ngày.`
          : `${customer} — ${product}: hẹn ${String(ticket.promisedDate)}, còn ${state.daysLeft} ngày.`,
        href: `/warranty/${id}`,
        template: level === 'overdue' ? 'WARRANTY_OVERDUE' : 'WARRANTY_DUE_SOON',
        params,
      },
      status: 'PENDING',
      relayAttempts: 0,
      availableAt: now,
      occurredAt: now,
    });
    await db.collection(WARRANTY_TICKETS).updateOne({ _id: ticket._id }, { $set: { slaNotified: level } });
    counts[level] += 1;
  }
  return counts;
}
