import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AppNotification, DashboardSummary } from '@inoxpran/contracts';
import { overwriteGetLocale, type Locale } from '$lib/paraglide/runtime';

let locale: Locale = 'zh';
let serverText: typeof import('./server-text');

beforeAll(async () => {
  overwriteGetLocale(() => locale);
  // format.ts chọn định dạng số theo ngôn ngữ lúc nạp module, nên đặt ngôn ngữ trước khi import.
  serverText = await import('./server-text');
});
afterAll(() => {
  locale = 'vi';
});

const alert = (overrides: Partial<DashboardSummary['alerts'][number]>): DashboardSummary['alerts'][number] => ({
  id: 'x', level: 'WARNING', title: 'Tiêu đề máy chủ', detail: 'Chi tiết máy chủ', ...overrides,
});

describe('chữ do máy chủ sinh — tiếng Trung', () => {
  it('dịch cảnh báo theo mã mẫu, giữ nguyên tên hàng là dữ liệu', () => {
    const text = serverText.alertText(alert({
      template: 'LOW_STOCK',
      params: { name: 'Bộ nồi Inox 5 món', sku: 'NI-05', available: '3', minimum: '1200', unit: 'bộ', more: 2 },
    }));
    expect(text.title).toBe('库存低于最低库存量');
    expect(text.detail).toBe('Bộ nồi Inox 5 món NI-05 — 剩余 3/1,200 bộ (+2 SKU)');
  });

  it('cảnh báo nợ quá hạn: số tiền định dạng theo ngôn ngữ, thêm số đại lý khác', () => {
    const text = serverText.alertText(alert({
      template: 'OVERDUE_60',
      params: { name: 'Gia dụng Sơn Đồng', province: 'Hà Nội', total: '125000000.00', others: 2 },
    }));
    expect(text.title).toBe('应收账款逾期超过 60 天');
    expect(text.detail).toBe('Gia dụng Sơn Đồng (Hà Nội) — 125,000,000 ₫，另有 2 家经销商');
  });

  it('không có mã mẫu (bản ghi cũ) thì dùng chữ tiếng Việt của máy chủ', () => {
    expect(serverText.alertText(alert({}))).toEqual({ title: 'Tiêu đề máy chủ', detail: 'Chi tiết máy chủ' });
    const legacy: AppNotification = { id: 'n', title: 'Có chứng từ chờ phê duyệt', message: 'cũ', createdAt: '2026-10-03T00:00:00.000Z' };
    expect(serverText.notificationText(legacy)).toEqual({ title: 'Có chứng từ chờ phê duyệt', message: 'cũ' });
  });

  it('dịch thông báo theo mã mẫu', () => {
    const text = serverText.notificationText({
      id: 'n', title: 'vi', message: 'vi', createdAt: '2026-10-03T00:00:00.000Z',
      template: 'SALES_READY_FOR_SWK', params: { code: 'BH2026100009', customer: 'Gia dụng Sơn Đồng' },
    });
    expect(text).toEqual({ title: '单据 BH2026100009 已核对完毕 — 等待您开具 SWK 单', message: '请开具 SWK 单并向 Gia dụng Sơn Đồng 发货。' });
  });

  it('dịch nhãn kỳ, nhãn lạ trả nguyên văn', () => {
    expect(serverText.periodText('90 ngày gần nhất')).toBe('最近 90 天');
    expect(serverText.periodText('Quý 4/2026')).toBe('2026 年第 4 季度');
    expect(serverText.periodText('Tháng 09/2026')).toBe('2026 年 09 月');
    expect(serverText.periodText('cùng kỳ tháng 9')).toBe('9 月同期');
    expect(serverText.periodText('01/09/2026 – 15/09/2026')).toBe('2026/09/01 – 2026/09/15');
    expect(serverText.periodText('Kỳ khác')).toBe('Kỳ khác');
  });
});

describe('chữ do máy chủ sinh — tiếng Việt', () => {
  it('bản tiếng Việt trùng với chữ máy chủ', () => {
    locale = 'vi';
    expect(serverText.alertText(alert({ template: 'APPROVAL_OVERDUE_24H', params: { count: 3 } })))
      .toEqual({ title: 'Đơn hàng chờ duyệt quá 24 giờ', detail: '3 đơn hàng đang chờ quyết định phê duyệt' });
    expect(serverText.periodText('Quý 4/2026')).toBe('Quý 4/2026');
    expect(serverText.periodText('90 ngày gần nhất')).toBe('90 ngày gần nhất');
  });
});
