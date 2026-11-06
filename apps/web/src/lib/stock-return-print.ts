import type { StockReturn } from '@inoxpran/contracts';

export interface StockReturnPrint {
  slip: StockReturn & { postedAt?: string; borrowerName?: string };
  party: { address: string; phone: string; taxCode: string; contactName: string };
  staffName: string;
  destination: string;
  pricing: {
    lines: Array<{ unitPrice: string | null; net: string | null; tax: string | null; rate: string | null }>;
    net: string | null;
    tax: string | null;
    total: string | null;
    rate: string | null;
    status: 'VALUED' | 'TOTAL_ONLY' | 'UNPRICED';
  };
}

export function returnPrintDate(iso: string): string {
  const date = new Date(iso);
  if (!Number.isFinite(date.getTime())) return '';
  const parts = new Intl.DateTimeFormat('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(date);
  const get = (type: string) => parts.find(part => part.type === type)?.value ?? '';
  return `Ngày ${get('day')} tháng ${get('month')} năm ${get('year')}`;
}
