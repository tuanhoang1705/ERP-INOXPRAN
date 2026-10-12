import { CLOSED_WARRANTY_STATUSES, endOfVnDay, REPEAT_REPAIR_THRESHOLD, slaState, vnDate, type WarrantyReport } from '@inoxpran/contracts';
import Decimal from 'decimal.js';
import type { Document, ObjectId } from 'mongodb';

const DAY_MS = 86_400_000;
const money = (value: unknown) => new Decimal(value === undefined || value === null ? 0 : String(value));

/** Danh sách tháng YYYY-MM từ `from` tới `to` (gồm cả hai đầu). */
export function monthsBetween(from: string, to: string): string[] {
  const result: string[] = [];
  let [year, month] = from.split('-').map(Number) as [number, number];
  const [endYear, endMonth] = to.split('-').map(Number) as [number, number];
  while (year < endYear || (year === endYear && month <= endMonth)) {
    result.push(`${year}-${String(month).padStart(2, '0')}`);
    month += 1;
    if (month > 12) {
      month = 1;
      year += 1;
    }
  }
  return result;
}

/** Tháng đầu kỳ mặc định: lùi `count − 1` tháng từ `to`. */
export function shiftMonth(month: string, delta: number): string {
  const [year, value] = month.split('-').map(Number) as [number, number];
  const index = year * 12 + (value - 1) + delta;
  return `${Math.floor(index / 12)}-${String((index % 12) + 1).padStart(2, '0')}`;
}

/**
 * Báo cáo bảo hành: phiếu tiếp nhận trong kỳ (theo tháng tiếp nhận) và phiếu đã trả trong kỳ (theo tháng trả).
 * - Đúng hẹn: trả trước 23:59 ngày hẹn trả cuối cùng (sau các lần dời hẹn có lý do).
 * - Chi phí công ty: chi phí linh kiện / đổi mới / hoàn tiền của phiếu công ty chịu; doanh thu dịch vụ: phiếu khách trả tiền.
 * - Sản phẩm bảo hành từ lần thứ 3 (cùng mã hàng + số hóa đơn): Luật 19/2023 Điều 30 khoản 2 điểm đ.
 */
export function buildWarrantyReport(
  tickets: Document[],
  options: { from: string; to: string; now: Date; warningRatio: number; faultNames: Map<string, string> },
): WarrantyReport {
  const months = monthsBetween(options.from, options.to);
  const inRange = (month: string) => month >= options.from && month <= options.to;
  const monthOf = (at: Date) => vnDate(at).slice(0, 7);
  const byMonth = new Map(months.map((month) => [month, { month, received: 0, returned: 0, onTime: 0, companyCost: new Decimal(0), serviceRevenue: new Decimal(0) }]));
  const resolutions = new Map<string, number>();
  const products = new Map<string, { sku: string; name: string; count: number; companyCost: Decimal }>();
  const faults = new Map<string, number>();
  const repeats = new Map<string, WarrantyReport['repeatProducts'][number]>();
  let received = 0;
  let returned = 0;
  let onTime = 0;
  let open = 0;
  let overdueOpen = 0;
  let turnaroundDays = 0;
  let rejected = 0;
  let exchanged = 0;
  let refunded = 0;
  let companyCost = new Decimal(0);
  let serviceRevenue = new Decimal(0);

  for (const ticket of tickets) {
    const product = ticket.product as { sku: string; name: string };
    const receivedMonth = monthOf(ticket.receivedAt as Date);
    if (inRange(receivedMonth) && ticket.status !== 'CANCELLED') {
      received += 1;
      byMonth.get(receivedMonth)!.received += 1;
      const entry = products.get(product.sku) ?? { sku: product.sku, name: product.name, count: 0, companyCost: new Decimal(0) };
      entry.count += 1;
      products.set(product.sku, entry);
      for (const line of (ticket.lines as Array<{ faultCode?: string }> | undefined) ?? []) {
        if (line.faultCode) faults.set(line.faultCode, (faults.get(line.faultCode) ?? 0) + 1);
      }
      if (!(CLOSED_WARRANTY_STATUSES as readonly string[]).includes(String(ticket.status))) {
        open += 1;
        const sla = slaState({ receivedAt: ticket.receivedAt as Date, promisedDate: String(ticket.promisedDate), now: options.now, closedAt: null, warningRatio: options.warningRatio });
        if (sla.tone === 'overdue') overdueOpen += 1;
      }
      const services = Number((ticket.warranty as { priorServiceCount?: number } | undefined)?.priorServiceCount ?? 0) + 1;
      const invoice = ticket.invoice as { number?: string } | undefined;
      if (services >= REPEAT_REPAIR_THRESHOLD && invoice?.number) {
        const key = `${product.sku}:${invoice.number}`;
        const current = repeats.get(key);
        if (!current || services >= current.services) {
          repeats.set(key, {
            sku: product.sku,
            name: product.name,
            invoiceNumber: invoice.number,
            customerName: String((ticket.customer as { name?: string }).name ?? ''),
            services,
            lastTicketId: (ticket._id as ObjectId).toHexString(),
            lastCode: String(ticket.code),
          });
        }
      }
    }

    const returnedAt = ticket.returnedAt as Date | undefined;
    if (ticket.status === 'RETURNED' && returnedAt && inRange(monthOf(returnedAt))) {
      const month = byMonth.get(monthOf(returnedAt))!;
      returned += 1;
      month.returned += 1;
      if (returnedAt.getTime() <= endOfVnDay(String(ticket.promisedDate)).getTime()) {
        onTime += 1;
        month.onTime += 1;
      }
      turnaroundDays += (returnedAt.getTime() - (ticket.receivedAt as Date).getTime()) / DAY_MS;
      const result = ticket.result as { resolution?: string; cost?: unknown; chargedTo?: string } | undefined;
      if (result?.resolution) resolutions.set(result.resolution, (resolutions.get(result.resolution) ?? 0) + 1);
      if (result?.resolution === 'REJECTED') rejected += 1;
      if (result?.resolution === 'EXCHANGED') exchanged += 1;
      if (result?.resolution === 'REFUNDED') refunded += 1;
      const cost = money(result?.cost);
      if (result?.chargedTo === 'CUSTOMER') {
        serviceRevenue = serviceRevenue.add(cost);
        month.serviceRevenue = month.serviceRevenue.add(cost);
      } else {
        companyCost = companyCost.add(cost);
        month.companyCost = month.companyCost.add(cost);
        const entry = products.get(product.sku);
        if (entry) entry.companyCost = entry.companyCost.add(cost);
      }
    }
  }

  const rate = (part: number, whole: number) => (whole ? Math.round((part / whole) * 1000) / 10 : null);
  return {
    from: options.from,
    to: options.to,
    totals: {
      received,
      returned,
      open,
      overdueOpen,
      onTimeRate: rate(onTime, returned),
      averageTurnaroundDays: returned ? Math.round((turnaroundDays / returned) * 10) / 10 : null,
      rejectionRate: rate(rejected, returned),
      exchanged,
      refunded,
      companyCost: companyCost.toFixed(0),
      serviceRevenue: serviceRevenue.toFixed(0),
    },
    byMonth: [...byMonth.values()].map((row) => ({ ...row, companyCost: row.companyCost.toFixed(0), serviceRevenue: row.serviceRevenue.toFixed(0) })),
    byResolution: [...resolutions.entries()].map(([resolution, count]) => ({ resolution, count })).sort((a, b) => b.count - a.count),
    byProduct: [...products.values()]
      .sort((a, b) => b.count - a.count || b.companyCost.comparedTo(a.companyCost))
      .slice(0, 10)
      .map((row) => ({ ...row, companyCost: row.companyCost.toFixed(0) })),
    byFaultCode: [...faults.entries()]
      .map(([code, count]) => ({ code, name: options.faultNames.get(code) ?? code, count }))
      .sort((a, b) => b.count - a.count || a.code.localeCompare(b.code))
      .slice(0, 12),
    repeatProducts: [...repeats.values()].sort((a, b) => b.services - a.services),
  };
}
