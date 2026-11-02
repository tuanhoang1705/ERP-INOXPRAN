import { describe, expect, it } from 'vitest';
import { nkCodesIn, planRenumber, type RenumberSlip } from './return-codes';

const at = (iso: string) => new Date(`${iso}+07:00`);
const slip = (code: string, created: string, note: string, partnerId?: string): RenumberSlip => ({ code, createdAt: at(created), documentAt: at(created), note, ...(partnerId ? { partnerId } : {}) });

describe('mã phiếu nhập trả hàng NK (NK-01)', () => {
  it('đọc số NK trong ghi chú tiếng Trung / Việt, chuẩn hóa khoảng trắng', () => {
    expect(nkCodesIn('滞销退货入库，入库单号NK2026100037')).toEqual(['NK2026100037']);
    expect(nkCodesIn('9月25日阮俊煌带回公司拍照，出库单号SWK2026090096，本次归还仓库，入库单号为NK2026100036')).toEqual(['NK2026100036']);
    expect(nkCodesIn('10月16号退回仓库, nk 2026100033')).toEqual(['NK2026100033']);
    expect(nkCodesIn('không có số')).toEqual([]);
    expect(nkCodesIn('NK20261000331')).toEqual([]);
  });

  it('đổi theo ghi chú; 3 phiếu cùng số → đuôi -2, -3 theo thứ tự lập; phiếu không có số → số kế tiếp của tháng', () => {
    const plan = planRenumber([
      slip('TH2026100015', '2026-10-27T11:59:00', '10月16日返还仓库1个6209B,本单还欠1个6209A,NK2026100033'),
      slip('TH2026100013', '2026-10-27T11:40:00', '10月16号退回仓库 NK2026100033'),
      slip('TH2026100014', '2026-10-27T11:50:00', '10月16号退回仓库, NK2026100033'),
      slip('TH2026100018', '2026-10-30T23:35:00', '滞销退货入库，入库单号NK2026100037'),
      slip('TH2026100019', '2026-10-31T09:00:00', 'Khách trả 2 cái'),
    ], new Set(['TH2026100013', 'TH2026100014', 'TH2026100015', 'TH2026100018', 'TH2026100019']), new Map());
    const to = Object.fromEntries(plan.rows.map((row) => [row.from, row.to]));
    expect(to).toEqual({
      TH2026100013: 'NK2026100033',
      TH2026100014: 'NK2026100033-2',
      TH2026100015: 'NK2026100033-3',
      TH2026100018: 'NK2026100037',
      TH2026100019: 'NK2026100038',
    });
    expect(plan.rows.find((row) => row.from === 'TH2026100014')!.flags).toContain('DUPLICATE_NK');
    expect(plan.rows.find((row) => row.from === 'TH2026100019')!.flags).toContain('NO_NK');
    expect(plan.blocked).toEqual([]);
    expect(plan.counters['202610']).toBe(38);
  });

  it('nhiều số NK trong một ghi chú → chặn cho tới khi có quyết định; lệch tháng và trùng công nợ sổ cũ chỉ báo', () => {
    const slips = [
      slip('TH2026100005', '2026-10-10T10:00:00', 'NK2026100026 và NK2026100027', 'kh042'),
      slip('TH2026100009', '2026-10-12T10:00:00', '使用不良，NK2026090028', 'kh001'),
    ];
    const history = new Map([['NK2026090028', new Set(['kh001'])]]);
    const blocked = planRenumber(slips, new Set(), history);
    expect(blocked.blocked.map((row) => row.from)).toEqual(['TH2026100005']);
    const decided = planRenumber(slips, new Set(), history, { TH2026100005: 'NK2026100027' });
    expect(decided.blocked).toEqual([]);
    expect(decided.rows[0]).toMatchObject({ to: 'NK2026100027', flags: ['DECISION'] });
    expect(decided.rows[1]!.flags).toEqual(expect.arrayContaining(['MONTH_MISMATCH', 'HISTORY_SAME_CUSTOMER']));
  });

  it('mã đích đã là phiếu khác → chặn; số mới bỏ qua số NK đã có trong công nợ sổ cũ', () => {
    const plan = planRenumber(
      [slip('TH2026110001', '2026-11-02T08:00:00', 'NK2026110001'), slip('TH2026110002', '2026-11-03T08:00:00', '')],
      new Set(['NK2026110001', 'TH2026110001', 'TH2026110002']),
      new Map([['NK2026110002', new Set(['x'])]]),
    );
    expect(plan.blocked.map((row) => row.from)).toEqual(['TH2026110001']);
    expect(plan.rows[1]!.to).toBe('NK2026110003');
  });
});
