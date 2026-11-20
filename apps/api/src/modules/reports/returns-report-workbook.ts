import { INVENTORY_CATEGORIES, type ReturnDebtState, type ReturnRating, type ReturnsReport, type ReturnsReportSlip } from '@inoxpran/contracts';
import { addBodyRow, brandSheet, brandWorkbook, exportedAt, finalize, FORMATS, kpiStrip, noteRow, signatureBlock, tableHeader, titleBlock, toBuffer, totalRow, type Bi, type BrandColumn } from '../../common/excel-brand';
import { categoryZhShort, periodZh, regionBi, tierBi } from './report-labels';

/**
 * File Excel báo cáo Doanh số & hàng trả (RPT-RET-01) theo bộ chuẩn thương hiệu (XLS-01): các bảng như trên màn hình.
 * Song ngữ Việt + Trung (XLS-BI-01, 20/11/2026) — chữ Trung lấy theo giao diện (zh.json rr_*).
 */

const STATE_TEXT: Record<ReturnDebtState, Bi> = {
  CREDITED: { vi: 'Đã giảm công nợ', zh: '已冲减应收' },
  NOT_CREDITED: { vi: 'Không giảm công nợ', zh: '不冲减应收' },
  PENDING: { vi: 'Chờ kế toán xử lý', zh: '待会计处理' },
  NO_MONEY: { vi: 'Không tính tiền (hàng tặng)', zh: '不计金额（赠品）' },
};
const RATING_TEXT: Record<ReturnRating, string> = { NORMAL: 'Bình thường 正常', WATCH: 'Theo dõi 关注', WARNING: 'Cảnh báo 警告', HIGH_RISK: 'Rủi ro cao 高风险' };
const TONE_TEXT = { OK: 'Đạt 达标', WATCH: 'Theo dõi 关注', OVER: 'Vượt ngưỡng 超标' } as const;
const SCOPE_TEXT = { month: { vi: 'trong tháng', zh: '所选月份' }, '90': { vi: '90 ngày', zh: '最近 90 天' }, '180': { vi: '180 ngày', zh: '最近 180 天' } } as const;
const NO_REP = 'Chưa giao NVKD 未分配业务员';
const categoryText = (code: string) => {
  const item = INVENTORY_CATEGORIES.find((row) => row.code === code);
  return item ? `${item.vi} ${categoryZhShort(item.zh)}` : code;
};
const money = (value: string | null | undefined) => (value === null || value === undefined ? null : Number(value));
const ratio = (value: number | null) => (value === null ? null : value / 100);
const dayText = (iso: string | undefined) => {
  if (!iso) return '';
  const vn = new Date(new Date(iso).getTime() + 7 * 3_600_000);
  return `${String(vn.getUTCDate()).padStart(2, '0')}/${String(vn.getUTCMonth() + 1).padStart(2, '0')}/${vn.getUTCFullYear()}`;
};

export async function returnsReportWorkbook(report: ReturnsReport, slips: ReturnsReportSlip[], preparedBy: string, filterText: Bi): Promise<Buffer> {
  const workbook = brandWorkbook();
  const monthZh = periodZh(report.month.label);
  const at = exportedAt();
  const meta: Bi[] = [
    {
      vi: `Tháng: ${report.month.label}${report.month.partial ? ' (đến hôm nay)' : ''}${filterText.vi ? ` · ${filterText.vi}` : ''}`,
      zh: `月份：${monthZh}${report.month.partial ? '（截至今日）' : ''}${filterText.zh ? ` · ${filterText.zh}` : ''}`,
    },
    {
      vi: `Người lập: ${preparedBy} · Xuất lúc ${at} · Giá trị gồm VAT. Doanh số theo ngày giao, hàng trả theo ngày nhận hàng trả.`,
      zh: `制表人：${preparedBy} · 导出时间 ${at} · 金额含增值税。销售按交货日期，退货按收货日期。`,
    },
  ];
  const s = report.summary;

  // Sheet 1: theo tháng.
  const monthColumns: BrandColumn[] = [
    { key: 'month', header: 'Tháng\n月份', width: 14, type: 'code' },
    { key: 'sales', header: 'Doanh số giao (A)\n交货销售额 (A)', width: 18, type: 'money', emphasis: true },
    { key: 'orders', header: 'Số phiếu BH\n销售单数', width: 10, type: 'int' },
    { key: 'returns', header: 'Hàng trả (B)\n退货 (B)', width: 16, type: 'money' },
    { key: 'rate', header: 'Tỷ lệ trả B÷A\n退货率 B÷A', width: 11, type: 'percent' },
    { key: 'tone', header: 'Đánh giá\n评估', width: 17 },
    { key: 'credited', header: 'Đã giảm nợ (B1)\n已冲减 (B1)', width: 16, type: 'money' },
    { key: 'notCredited', header: 'Không giảm nợ (B2)\n不冲减 (B2)', width: 16, type: 'money' },
    { key: 'pending', header: 'Chờ kế toán (B3)\n待处理 (B3)', width: 16, type: 'money' },
    { key: 'net', header: 'Doanh số thuần A−B1\n净销售额 A−B1', width: 18, type: 'money', emphasis: true },
    { key: 'collected', header: 'Thu tiền\n收款', width: 16, type: 'money' },
    { key: 'returnCredits', header: 'Giảm nợ trả hàng (theo sổ)\n退货冲减（按台账）', width: 20, type: 'money' },
    { key: 'debtByReturns', header: 'Trả nợ bằng hàng\n以货抵债', width: 12, type: 'percent' },
  ];
  const monthSheet = brandSheet(workbook, 'Theo tháng 按月', monthColumns, { bilingual: true });
  let row = titleBlock(monthSheet, monthColumns.length, { vi: 'Doanh số & hàng trả theo tháng', zh: '按月销售与退货' }, meta);
  row = kpiStrip(monthSheet, row, monthColumns.length, [
    { label: { vi: 'DOANH SỐ GIAO (Đ)', zh: '交货销售额（越南盾）' }, value: Number(s.sales), format: FORMATS.money },
    { label: { vi: 'HÀNG KHÁCH TRẢ (Đ)', zh: '客户退货（越南盾）' }, value: Number(s.returns.total), format: FORMATS.money },
    { label: { vi: 'TỶ LỆ TRẢ', zh: '退货率' }, value: s.rate === null ? '—' : s.rate / 100, format: FORMATS.percent, tone: s.tone === 'OVER' ? 'danger' : s.tone === 'OK' ? 'good' : 'normal' },
    { label: { vi: 'ĐÃ GIẢM CÔNG NỢ (Đ)', zh: '已冲减应收（越南盾）' }, value: Number(s.returns.credited), format: FORMATS.money },
    { label: { vi: 'CHỜ KẾ TOÁN (Đ)', zh: '待会计处理（越南盾）' }, value: Number(s.returns.pending), format: FORMATS.money, tone: s.pendingOverdueSlips ? 'danger' : 'normal' },
    { label: { vi: 'DOANH SỐ THUẦN (Đ)', zh: '净销售额（越南盾）' }, value: Number(s.netSales), format: FORMATS.money },
  ]);
  const monthHeader = row;
  tableHeader(monthSheet, monthHeader, monthColumns);
  const totals = { sales: 0, orders: 0, returns: 0, credited: 0, notCredited: 0, pending: 0, net: 0, collected: 0, returnCredits: 0 };
  report.months.forEach((month, index) => {
    totals.sales += Number(month.sales); totals.orders += month.salesOrders; totals.returns += Number(month.returns.total);
    totals.credited += Number(month.returns.credited); totals.notCredited += Number(month.returns.notCredited); totals.pending += Number(month.returns.pending);
    totals.net += Number(month.netSales); totals.collected += Number(month.collected); totals.returnCredits += Number(month.returnCredits);
    addBodyRow(monthSheet, monthColumns, {
      month: `${month.label}${month.partial ? '*' : ''}`, sales: Number(month.sales), orders: month.salesOrders, returns: Number(month.returns.total), rate: ratio(month.rate),
      tone: month.tone ? TONE_TEXT[month.tone] : '—', credited: Number(month.returns.credited), notCredited: Number(month.returns.notCredited), pending: Number(month.returns.pending),
      net: Number(month.netSales), collected: Number(month.collected), returnCredits: Number(month.returnCredits), debtByReturns: ratio(month.debtByReturns),
    }, index, month.tone === 'OVER' ? { cells: { rate: { color: 'red', bold: true }, tone: { color: 'red', bold: true } } } : {});
  });
  totalRow(monthSheet, monthColumns, {
    month: 'CỘNG 6 THÁNG 6 个月合计', sales: totals.sales, orders: totals.orders, returns: totals.returns, rate: totals.sales > 0 ? totals.returns / totals.sales : null,
    credited: totals.credited, notCredited: totals.notCredited, pending: totals.pending, net: totals.net, collected: totals.collected, returnCredits: totals.returnCredits,
    debtByReturns: totals.collected + totals.returnCredits > 0 ? totals.returnCredits / (totals.collected + totals.returnCredits) : null,
  });
  finalize(monthSheet, monthHeader, monthHeader + report.months.length, monthColumns.length, { freezeColumns: 1 });
  noteRow(monthSheet, monthColumns.length, {
    vi: '* Tháng đang chạy. B1 = kế toán đã ghi giảm nợ; B2 = kế toán xác nhận không giảm nợ (đổi hàng, bảo hành…); B3 = hàng đã về kho, kế toán chưa xử lý. Trả nợ bằng hàng = giảm nợ trả hàng ÷ (thu tiền + giảm nợ trả hàng), theo ngày ghi sổ công nợ. Ngưỡng tháng: ≤ 6% đạt, ≤ 9% theo dõi, trên 9% vượt ngưỡng.',
    zh: '* 进行中的月份。B1 = 会计已登记冲减应收；B2 = 会计确认不冲减应收（换货、保修等）；B3 = 货已入库，会计尚未处理。以货抵债 = 退货冲减 ÷（收款 + 退货冲减），按应收记账日期。月度阈值：≤ 6% 达标，≤ 9% 关注，高于 9% 超标。',
  });
  signatureBlock(monthSheet, monthColumns.length, preparedBy);

  // Sheet 2: đối chiếu công nợ tháng.
  const ledgerColumns: BrandColumn[] = [
    { key: 'item', header: 'Khoản mục\n项目', width: 52, wrap: true },
    { key: 'amount', header: 'Số tiền (đ)\n金额（越南盾）', width: 22, type: 'money', emphasis: true },
  ];
  const ledgerSheet = brandSheet(workbook, 'Đối chiếu công nợ 应收对账', ledgerColumns, { portrait: true, bilingual: true });
  const ledgerHeader = titleBlock(ledgerSheet, ledgerColumns.length, { vi: `Đối chiếu công nợ khách hàng ${report.month.label}`, zh: `${monthZh} 客户应收对账` }, meta);
  tableHeader(ledgerSheet, ledgerHeader, ledgerColumns);
  const l = report.ledger;
  const ledgerRows: Array<[string, string]> = [
    ['Công nợ đầu tháng\n月初应收', l.opening],
    ['+ Phát sinh nợ trong tháng (phiếu BH đã giao, chứng từ khác)\n+ 本月新增应收（已交货销售单及其他单据）', l.debits],
    ['− Thu tiền\n− 收款', l.collected],
    ['− Trả hàng đã giảm nợ (theo ngày ghi sổ)\n− 退货冲减（按记账日期）', l.returnCredits],
    ['− Cước vận chuyển trừ nợ\n− 运费抵扣', l.freight],
    ...(Number(l.other) !== 0 ? [['± Điều chỉnh khác\n± 其他调整', l.other] as [string, string]] : []),
  ];
  ledgerRows.forEach(([item, amount], index) => addBodyRow(ledgerSheet, ledgerColumns, { item, amount: Number(amount) }, index));
  totalRow(ledgerSheet, ledgerColumns, { item: report.month.partial ? 'CÔNG NỢ ĐẾN HÔM NAY 截至今日应收' : 'CÔNG NỢ CUỐI THÁNG 月末应收', amount: Number(l.closing) });
  addBodyRow(ledgerSheet, ledgerColumns, {
    item: `Hàng đã về kho, kế toán chưa ghi giảm nợ (${l.pendingSlips} phiếu, ${l.pendingOverdueSlips} phiếu quá 7 ngày)\n已入库但会计尚未冲减（${l.pendingSlips} 张，其中 ${l.pendingOverdueSlips} 张超过 7 天）`,
    amount: Number(l.pendingValue),
  }, 0, l.pendingSlips ? { highlight: 'warn' } : {});
  addBodyRow(ledgerSheet, ledgerColumns, { item: 'Công nợ nếu kế toán ghi giảm hết phần chờ\n若待处理部分全部冲减，应收余额为', amount: Number(l.expectedClosing) }, 1);
  finalize(ledgerSheet, ledgerHeader, ledgerHeader, ledgerColumns.length);
  const debtRate = l.debtByReturns === null ? '—' : `${l.debtByReturns.toLocaleString('vi-VN')}%`;
  noteRow(ledgerSheet, ledgerColumns.length, {
    vi: `Cùng công thức sổ chi tiết công nợ theo khách. Trả nợ bằng hàng trong tháng: ${debtRate}. Bảng này không theo bộ lọc loại hàng trả.`,
    zh: `与按客户的应收明细账口径一致。本月以货抵债：${debtRate}。本表不受退货类型筛选影响。`,
  });

  // Sheet 3: theo khách hàng.
  const customerColumns: BrandColumn[] = [
    { key: 'stt', header: 'STT\n序号', width: 6, type: 'int' },
    { key: 'code', header: 'Mã KH\n客户编号', width: 11, type: 'code' },
    { key: 'name', header: 'Khách hàng\n客户', width: 32, wrap: true },
    { key: 'tier', header: 'Cấp\n级别', width: 26 },
    { key: 'region', header: 'Tỉnh / thành\n省 / 市', width: 18, wrap: true },
    { key: 'rep', header: 'NVKD\n业务员', width: 18 },
    { key: 'sales', header: 'Doanh số giao\n交货销售额', width: 16, type: 'money' },
    { key: 'returns', header: 'Hàng trả\n退货', width: 15, type: 'money', emphasis: true },
    { key: 'rate', header: '% trả\n退货率', width: 9, type: 'percent' },
    { key: 'slow', header: 'Chậm bán\n滞销', width: 14, type: 'money' },
    { key: 'defect', header: 'Hàng lỗi\n不良品', width: 14, type: 'money' },
    { key: 'credited', header: 'Đã giảm nợ\n已冲减', width: 14, type: 'money' },
    { key: 'notCredited', header: 'Chưa / không giảm nợ\n未/不冲减', width: 15, type: 'money' },
    { key: 'collected', header: 'Thu tiền\n收款', width: 15, type: 'money' },
    { key: 'debtByReturns', header: 'Trả nợ bằng hàng\n以货抵债', width: 11, type: 'percent' },
    { key: 'outstanding', header: 'Dư nợ hiện tại\n当前应收余额', width: 16, type: 'money' },
    { key: 'overdue', header: 'Quá hạn (ngày)\n逾期（天）', width: 12, type: 'int' },
    { key: 'rating', header: 'Đánh giá\n评估', width: 17 },
  ];
  const customerSheet = brandSheet(workbook, 'Theo khách hàng 按客户', customerColumns, { bilingual: true });
  const scope = SCOPE_TEXT[report.window.scope];
  const customerMeta: Bi[] = [
    {
      vi: `Khoảng xem: ${report.window.label} (${scope.vi})${filterText.vi ? ` · ${filterText.vi}` : ''}`,
      zh: `统计区间：${report.window.label}（${scope.zh}）${filterText.zh ? ` · ${filterText.zh}` : ''}`,
    },
    meta[1]!,
  ];
  const customerHeader = titleBlock(customerSheet, customerColumns.length, { vi: 'Hàng trả theo khách hàng', zh: '按客户统计退货' }, customerMeta);
  tableHeader(customerSheet, customerHeader, customerColumns);
  report.customers.forEach((item, index) => {
    addBodyRow(customerSheet, customerColumns, {
      stt: index + 1, code: item.code, name: item.name, tier: tierBi(item.tier), region: regionBi(undefined, item.regionName), rep: item.salesRepName ?? '—',
      sales: Number(item.sales), returns: Number(item.returns), rate: ratio(item.rate), slow: Number(item.slow), defect: Number(item.defect),
      credited: Number(item.credited), notCredited: Number(item.notCredited), collected: Number(item.collected), debtByReturns: ratio(item.debtByReturns),
      outstanding: Number(item.outstanding), overdue: item.maxDaysOverdue, rating: RATING_TEXT[item.rating],
    }, index, item.rating === 'HIGH_RISK' ? { highlight: 'danger' } : item.rating === 'WARNING' ? { highlight: 'warn' } : {});
  });
  finalize(customerSheet, customerHeader, customerHeader + report.customers.length, customerColumns.length, { freezeColumns: 3 });
  noteRow(customerSheet, customerColumns.length, {
    vi: 'Xếp loại: bình thường dưới 5% · theo dõi 5–10% · cảnh báo trên 10% · rủi ro cao trên 10% và (quá hạn trên 60 ngày hoặc trả nợ bằng hàng trên 30%). Khách có hàng trả mà không có doanh số trong khoảng xem được coi như trên 10%.',
    zh: '评估规则：低于 5% 正常 · 5–10% 关注 · 高于 10% 警告 · 高于 10% 且（逾期超过 60 天或以货抵债超过 30%）为高风险。统计区间内无销售但有退货的客户按高于 10% 处理。',
  });

  // Sheet 4: theo mã hàng. (Sheet "Theo tháng bán" bỏ ngày 20/11/2026 — RPT-RET-COHORT-OFF-01.)
  const productColumns: BrandColumn[] = [
    { key: 'stt', header: 'STT\n序号', width: 6, type: 'int' },
    { key: 'sku', header: 'Mã hàng\n商品编码', width: 14, type: 'code' },
    { key: 'name', header: 'Tên hàng\n商品名称', width: 40, wrap: true },
    { key: 'unit', header: 'ĐVT\n单位', width: 8 },
    { key: 'sold', header: 'SL bán\n销售数量', width: 11, type: 'qty' },
    { key: 'returned', header: 'SL trả\n退货数量', width: 11, type: 'qty', emphasis: true },
    { key: 'rate', header: '% trả (SL)\n退货率（数量）', width: 11, type: 'percent' },
    { key: 'reason', header: 'Lý do chính\n主要原因', width: 30, wrap: true },
  ];
  const productSheet = brandSheet(workbook, 'Theo mã hàng 按商品', productColumns, { bilingual: true });
  const productHeader = titleBlock(productSheet, productColumns.length, { vi: 'Mã hàng bị trả nhiều nhất', zh: '退货最多的商品' }, customerMeta);
  tableHeader(productSheet, productHeader, productColumns);
  report.products.forEach((item, index) => addBodyRow(productSheet, productColumns, {
    stt: index + 1, sku: item.sku, name: item.name, unit: item.unit, sold: Number(item.soldQuantity), returned: Number(item.returnedQuantity), rate: ratio(item.rate), reason: categoryText(item.mainCategory),
  }, index));
  finalize(productSheet, productHeader, productHeader + report.products.length, productColumns.length, { freezeColumns: 3 });
  noteRow(productSheet, productColumns.length, {
    vi: 'Số lượng theo đơn vị cơ bản. SL bán = dòng bán (không gồm hàng tặng) của phiếu BH giao trong khoảng xem; SL trả = phiếu NK khách trả nhận trong khoảng xem (không gồm hàng tặng trả lại).',
    zh: '数量按基本单位。销售数量 = 统计区间内交货销售单的销售行（不含赠品）；退货数量 = 统计区间内收到的客户退货入库单（不含赠品退回）。',
  });

  // Sheet 5: theo NVKD.
  const repColumns: BrandColumn[] = [
    { key: 'stt', header: 'STT\n序号', width: 6, type: 'int' },
    { key: 'name', header: 'Nhân viên kinh doanh\n业务员', width: 30, type: 'code' },
    { key: 'customers', header: 'Số khách\n客户数', width: 10, type: 'int' },
    { key: 'sales', header: 'Doanh số giao\n交货销售额', width: 18, type: 'money' },
    { key: 'returns', header: 'Hàng trả\n退货', width: 16, type: 'money', emphasis: true },
    { key: 'rate', header: '% trả\n退货率', width: 10, type: 'percent' },
    { key: 'credited', header: 'Đã giảm nợ\n已冲减', width: 16, type: 'money' },
    { key: 'pending', header: 'Chờ kế toán\n待处理', width: 16, type: 'money' },
  ];
  const repSheet = brandSheet(workbook, 'Theo NVKD 按业务员', repColumns, { portrait: true, bilingual: true });
  const repHeader = titleBlock(repSheet, repColumns.length, { vi: 'Hàng trả theo nhân viên kinh doanh', zh: '按业务员统计退货' }, customerMeta);
  tableHeader(repSheet, repHeader, repColumns);
  report.reps.forEach((item, index) => addBodyRow(repSheet, repColumns, {
    stt: index + 1, name: item.id ? item.name : NO_REP, customers: item.customers, sales: Number(item.sales), returns: Number(item.returns), rate: ratio(item.rate), credited: Number(item.credited), pending: Number(item.pending),
  }, index, item.id ? {} : { highlight: 'warn' }));
  finalize(repSheet, repHeader, repHeader + report.reps.length, repColumns.length);
  noteRow(repSheet, repColumns.length, {
    vi: 'Doanh số theo NVKD ghi trên phiếu BH; hàng trả theo NVKD của phiếu BH gốc (không có phiếu gốc: NVKD đang phụ trách khách).',
    zh: '销售额按销售单上的业务员；退货按原销售单的业务员（无原单时按客户当前负责的业务员）。',
  });

  // Sheet 6: danh sách phiếu NK nhận trong tháng.
  const slipColumns: BrandColumn[] = [
    { key: 'stt', header: 'STT\n序号', width: 6, type: 'int' },
    { key: 'code', header: 'Phiếu NK\n退货入库单', width: 16, type: 'code' },
    { key: 'received', header: 'Ngày nhận\n收货日期', width: 12 },
    { key: 'customer', header: 'Khách hàng\n客户', width: 30, wrap: true },
    { key: 'source', header: 'Phiếu BH gốc\n原销售单', width: 18, wrap: true },
    { key: 'delivered', header: 'Ngày giao BH\n交货日期', width: 12 },
    { key: 'days', header: 'Sau (ngày)\n间隔（天）', width: 12, type: 'int' },
    { key: 'category', header: 'Loại hàng trả\n退货类型', width: 26, wrap: true },
    { key: 'warehouse', header: 'Về kho\n入库仓库', width: 20 },
    { key: 'value', header: 'Giá trị (đ)\n金额（越南盾）', width: 15, type: 'money', emphasis: true },
    { key: 'state', header: 'Công nợ\n应收', width: 24, wrap: true },
    { key: 'credit', header: 'Phiếu giảm nợ\n冲减单', width: 22 },
  ];
  const slipSheet = brandSheet(workbook, 'Phiếu NK trong tháng 本月退货单', slipColumns, { bilingual: true });
  const slipHeader = titleBlock(slipSheet, slipColumns.length, { vi: `Phiếu nhập hàng khách trả ${report.month.label}`, zh: `${monthZh} 客户退货入库单` }, meta);
  tableHeader(slipSheet, slipHeader, slipColumns);
  const stateText = (item: ReturnsReportSlip) => {
    const text = STATE_TEXT[item.state];
    if (item.state === 'PENDING') return `${text.vi} · ${item.pendingDays ?? 0} ngày\n${text.zh} · ${item.pendingDays ?? 0} 天`;
    return item.value === null ? `${text.vi} · chưa định giá\n${text.zh} · 未定价` : `${text.vi}\n${text.zh}`;
  };
  slips.forEach((item, index) => addBodyRow(slipSheet, slipColumns, {
    stt: index + 1, code: item.code, received: dayText(item.receivedAt), customer: `${item.customerCode} · ${item.customerName}`,
    source: item.salesOrderCode ?? (item.preErpSalesCode ? `${item.preErpSalesCode} (trước ERP · ERP 之前)` : '—'), delivered: dayText(item.deliveredAt), days: item.days ?? null,
    category: categoryText(item.category), warehouse: item.warehouseName, value: money(item.value),
    state: stateText(item),
    credit: item.creditCode ? `${item.creditCode}${item.creditPostedOn ? ` · ${item.creditPostedOn.split('-').reverse().join('/')}` : ''}` : '',
  }, index, item.state === 'PENDING' && (item.pendingDays ?? 0) > 7 ? { highlight: 'warn' } : {}));
  totalRow(slipSheet, slipColumns, { customer: `TỔNG CỘNG (${slips.length} phiếu) 合计（${slips.length} 张）`, value: slips.reduce((sum, item) => sum + Number(item.value ?? 0), 0) });
  finalize(slipSheet, slipHeader, slipHeader + slips.length, slipColumns.length, { freezeColumns: 2 });

  return toBuffer(workbook);
}
