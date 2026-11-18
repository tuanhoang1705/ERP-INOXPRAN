import { INVENTORY_CATEGORIES, RETURN_LAG_BUCKETS, type ReturnDebtState, type ReturnRating, type ReturnsReport, type ReturnsReportSlip } from '@inoxpran/contracts';
import { addBodyRow, brandSheet, brandWorkbook, exportedAt, finalize, FORMATS, kpiStrip, noteRow, signatureBlock, tableHeader, titleBlock, toBuffer, totalRow, type BrandColumn } from '../../common/excel-brand';

/** File Excel báo cáo Doanh số & hàng trả (RPT-RET-01) theo bộ chuẩn thương hiệu (XLS-01): các bảng như trên màn hình. */

const STATE_TEXT: Record<ReturnDebtState, string> = { CREDITED: 'Đã giảm công nợ', NOT_CREDITED: 'Không giảm công nợ', PENDING: 'Chờ kế toán xử lý', NO_MONEY: 'Không tính tiền (hàng tặng)' };
const RATING_TEXT: Record<ReturnRating, string> = { NORMAL: 'Bình thường', WATCH: 'Theo dõi', WARNING: 'Cảnh báo', HIGH_RISK: 'Rủi ro cao' };
const TONE_TEXT = { OK: 'Đạt', WATCH: 'Theo dõi', OVER: 'Vượt ngưỡng' } as const;
const SCOPE_TEXT = { month: 'trong tháng', '90': '90 ngày', '180': '180 ngày' } as const;
const categoryText = (code: string) => INVENTORY_CATEGORIES.find((item) => item.code === code)?.vi ?? code;
const money = (value: string | null | undefined) => (value === null || value === undefined ? null : Number(value));
const ratio = (value: number | null) => (value === null ? null : value / 100);
const dayText = (iso: string | undefined) => {
  if (!iso) return '';
  const vn = new Date(new Date(iso).getTime() + 7 * 3_600_000);
  return `${String(vn.getUTCDate()).padStart(2, '0')}/${String(vn.getUTCMonth() + 1).padStart(2, '0')}/${vn.getUTCFullYear()}`;
};

export async function returnsReportWorkbook(report: ReturnsReport, slips: ReturnsReportSlip[], preparedBy: string, filterText: string): Promise<Buffer> {
  const workbook = brandWorkbook();
  const meta = [
    `Tháng: ${report.month.label}${report.month.partial ? ' (đến hôm nay)' : ''}${filterText ? ` · ${filterText}` : ''}`,
    `Người lập: ${preparedBy} · Xuất lúc ${exportedAt()} · Giá trị gồm VAT. Doanh số theo ngày giao, hàng trả theo ngày nhận hàng trả.`,
  ];
  const s = report.summary;

  // Sheet 1: theo tháng.
  const monthColumns: BrandColumn[] = [
    { key: 'month', header: 'Tháng', width: 11, type: 'code' },
    { key: 'sales', header: 'Doanh số giao (A)', width: 18, type: 'money', emphasis: true },
    { key: 'orders', header: 'Số phiếu BH', width: 10, type: 'int' },
    { key: 'returns', header: 'Hàng trả (B)', width: 16, type: 'money' },
    { key: 'rate', header: 'Tỷ lệ trả B÷A', width: 11, type: 'percent' },
    { key: 'tone', header: 'Đánh giá', width: 13 },
    { key: 'credited', header: 'Đã giảm nợ (B1)', width: 16, type: 'money' },
    { key: 'notCredited', header: 'Không giảm nợ (B2)', width: 16, type: 'money' },
    { key: 'pending', header: 'Chờ kế toán (B3)', width: 16, type: 'money' },
    { key: 'net', header: 'Doanh số thuần A−B1', width: 18, type: 'money', emphasis: true },
    { key: 'collected', header: 'Thu tiền', width: 16, type: 'money' },
    { key: 'returnCredits', header: 'Giảm nợ trả hàng (theo sổ)', width: 17, type: 'money' },
    { key: 'debtByReturns', header: 'Trả nợ bằng hàng', width: 12, type: 'percent' },
  ];
  const monthSheet = brandSheet(workbook, 'Theo tháng', monthColumns);
  let row = titleBlock(monthSheet, monthColumns.length, 'Doanh số & hàng trả theo tháng', meta);
  row = kpiStrip(monthSheet, row, monthColumns.length, [
    { label: 'DOANH SỐ GIAO (Đ)', value: Number(s.sales), format: FORMATS.money },
    { label: 'HÀNG KHÁCH TRẢ (Đ)', value: Number(s.returns.total), format: FORMATS.money },
    { label: 'TỶ LỆ TRẢ', value: s.rate === null ? '—' : s.rate / 100, format: FORMATS.percent, tone: s.tone === 'OVER' ? 'danger' : s.tone === 'OK' ? 'good' : 'normal' },
    { label: 'ĐÃ GIẢM CÔNG NỢ (Đ)', value: Number(s.returns.credited), format: FORMATS.money },
    { label: 'CHỜ KẾ TOÁN (Đ)', value: Number(s.returns.pending), format: FORMATS.money, tone: s.pendingOverdueSlips ? 'danger' : 'normal' },
    { label: 'DOANH SỐ THUẦN (Đ)', value: Number(s.netSales), format: FORMATS.money },
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
    month: 'CỘNG 6 THÁNG', sales: totals.sales, orders: totals.orders, returns: totals.returns, rate: totals.sales > 0 ? totals.returns / totals.sales : null,
    credited: totals.credited, notCredited: totals.notCredited, pending: totals.pending, net: totals.net, collected: totals.collected, returnCredits: totals.returnCredits,
    debtByReturns: totals.collected + totals.returnCredits > 0 ? totals.returnCredits / (totals.collected + totals.returnCredits) : null,
  });
  finalize(monthSheet, monthHeader, monthHeader + report.months.length, monthColumns.length, { freezeColumns: 1 });
  noteRow(monthSheet, monthColumns.length, '* Tháng đang chạy. B1 = kế toán đã ghi giảm nợ; B2 = kế toán xác nhận không giảm nợ (đổi hàng, bảo hành…); B3 = hàng đã về kho, kế toán chưa xử lý. Trả nợ bằng hàng = giảm nợ trả hàng ÷ (thu tiền + giảm nợ trả hàng), theo ngày ghi sổ công nợ. Ngưỡng tháng: ≤ 6% đạt, ≤ 9% theo dõi, trên 9% vượt ngưỡng.');
  signatureBlock(monthSheet, monthColumns.length, preparedBy);

  // Sheet 2: đối chiếu công nợ tháng.
  const ledgerColumns: BrandColumn[] = [
    { key: 'item', header: 'Khoản mục', width: 52 },
    { key: 'amount', header: 'Số tiền (đ)', width: 22, type: 'money', emphasis: true },
  ];
  const ledgerSheet = brandSheet(workbook, 'Đối chiếu công nợ', ledgerColumns, { portrait: true });
  const ledgerHeader = titleBlock(ledgerSheet, ledgerColumns.length, `Đối chiếu công nợ khách hàng ${report.month.label}`, meta);
  tableHeader(ledgerSheet, ledgerHeader, ledgerColumns);
  const l = report.ledger;
  const ledgerRows: Array<[string, string]> = [
    ['Công nợ đầu tháng', l.opening],
    ['+ Phát sinh nợ trong tháng (phiếu BH đã giao, chứng từ khác)', l.debits],
    ['− Thu tiền', l.collected],
    ['− Trả hàng đã giảm nợ (theo ngày ghi sổ)', l.returnCredits],
    ['− Cước vận chuyển trừ nợ', l.freight],
    ...(Number(l.other) !== 0 ? [['± Điều chỉnh khác', l.other] as [string, string]] : []),
  ];
  ledgerRows.forEach(([item, amount], index) => addBodyRow(ledgerSheet, ledgerColumns, { item, amount: Number(amount) }, index));
  totalRow(ledgerSheet, ledgerColumns, { item: report.month.partial ? 'CÔNG NỢ ĐẾN HÔM NAY' : 'CÔNG NỢ CUỐI THÁNG', amount: Number(l.closing) });
  addBodyRow(ledgerSheet, ledgerColumns, { item: `Hàng đã về kho, kế toán chưa ghi giảm nợ (${l.pendingSlips} phiếu, ${l.pendingOverdueSlips} phiếu quá 7 ngày)`, amount: Number(l.pendingValue) }, 0, l.pendingSlips ? { highlight: 'warn' } : {});
  addBodyRow(ledgerSheet, ledgerColumns, { item: 'Công nợ nếu kế toán ghi giảm hết phần chờ', amount: Number(l.expectedClosing) }, 1);
  finalize(ledgerSheet, ledgerHeader, ledgerHeader, ledgerColumns.length);
  noteRow(ledgerSheet, ledgerColumns.length, `Cùng công thức sổ chi tiết công nợ theo khách. Trả nợ bằng hàng trong tháng: ${l.debtByReturns === null ? '—' : `${l.debtByReturns.toLocaleString('vi-VN')}%`}. Bảng này không theo bộ lọc loại hàng trả.`);

  // Sheet 3: theo khách hàng.
  const customerColumns: BrandColumn[] = [
    { key: 'stt', header: 'STT', width: 6, type: 'int' },
    { key: 'code', header: 'Mã KH', width: 11, type: 'code' },
    { key: 'name', header: 'Khách hàng', width: 32, wrap: true },
    { key: 'tier', header: 'Cấp', width: 14 },
    { key: 'region', header: 'Tỉnh / thành', width: 18, wrap: true },
    { key: 'rep', header: 'NVKD', width: 18 },
    { key: 'sales', header: 'Doanh số giao', width: 16, type: 'money' },
    { key: 'returns', header: 'Hàng trả', width: 15, type: 'money', emphasis: true },
    { key: 'rate', header: '% trả', width: 9, type: 'percent' },
    { key: 'slow', header: 'Chậm bán', width: 14, type: 'money' },
    { key: 'defect', header: 'Hàng lỗi', width: 14, type: 'money' },
    { key: 'credited', header: 'Đã giảm nợ', width: 14, type: 'money' },
    { key: 'notCredited', header: 'Chưa / không giảm nợ', width: 15, type: 'money' },
    { key: 'collected', header: 'Thu tiền', width: 15, type: 'money' },
    { key: 'debtByReturns', header: 'Trả nợ bằng hàng', width: 11, type: 'percent' },
    { key: 'outstanding', header: 'Dư nợ hiện tại', width: 16, type: 'money' },
    { key: 'overdue', header: 'Quá hạn (ngày)', width: 10, type: 'int' },
    { key: 'rating', header: 'Đánh giá', width: 13 },
  ];
  const customerSheet = brandSheet(workbook, 'Theo khách hàng', customerColumns);
  const customerMeta = [`Khoảng xem: ${report.window.label} (${SCOPE_TEXT[report.window.scope]})${filterText ? ` · ${filterText}` : ''}`, meta[1] as string];
  const customerHeader = titleBlock(customerSheet, customerColumns.length, 'Hàng trả theo khách hàng', customerMeta);
  tableHeader(customerSheet, customerHeader, customerColumns);
  report.customers.forEach((item, index) => {
    addBodyRow(customerSheet, customerColumns, {
      stt: index + 1, code: item.code, name: item.name, tier: item.tier, region: item.regionName, rep: item.salesRepName ?? '—',
      sales: Number(item.sales), returns: Number(item.returns), rate: ratio(item.rate), slow: Number(item.slow), defect: Number(item.defect),
      credited: Number(item.credited), notCredited: Number(item.notCredited), collected: Number(item.collected), debtByReturns: ratio(item.debtByReturns),
      outstanding: Number(item.outstanding), overdue: item.maxDaysOverdue, rating: RATING_TEXT[item.rating],
    }, index, item.rating === 'HIGH_RISK' ? { highlight: 'danger' } : item.rating === 'WARNING' ? { highlight: 'warn' } : {});
  });
  finalize(customerSheet, customerHeader, customerHeader + report.customers.length, customerColumns.length, { freezeColumns: 3 });
  noteRow(customerSheet, customerColumns.length, 'Xếp loại: bình thường dưới 5% · theo dõi 5–10% · cảnh báo trên 10% · rủi ro cao trên 10% và (quá hạn trên 60 ngày hoặc trả nợ bằng hàng trên 30%). Khách có hàng trả mà không có doanh số trong khoảng xem được coi như trên 10%.');

  // Sheet 4: theo tháng bán.
  const cohortColumns: BrandColumn[] = [
    { key: 'month', header: 'Tháng bán', width: 11, type: 'code' },
    { key: 'sales', header: 'Doanh số giao', width: 17, type: 'money', emphasis: true },
    ...RETURN_LAG_BUCKETS.map((bucket, index) => ({ key: `b${index}`, header: bucket.to === null ? `Trả sau trên ${bucket.from - 1} ngày` : `Trả sau ${bucket.from}–${bucket.to} ngày`, width: 15, type: 'money' as const })),
    { key: 'returned', header: 'Tổng đã trả', width: 15, type: 'money' },
    { key: 'returnedRate', header: '% đã trả', width: 10, type: 'percent' },
    { key: 'kept', header: 'Giữ lại', width: 10, type: 'percent', emphasis: true },
  ];
  const cohortSheet = brandSheet(workbook, 'Theo tháng bán', cohortColumns);
  const cohortHeader = titleBlock(cohortSheet, cohortColumns.length, 'Doanh số mỗi tháng còn giữ lại bao nhiêu', [meta[0] as string, 'Hàng trả có phiếu BH gốc, tính đến hôm nay, xếp theo tháng giao của phiếu BH gốc. Dấu * = còn khoảng thời gian đang tính.']);
  tableHeader(cohortSheet, cohortHeader, cohortColumns);
  report.cohort.rows.forEach((item, index) => {
    const values: Record<string, unknown> = { month: `${item.label}${item.running ? '*' : ''}`, sales: Number(item.sales), returned: Number(item.returned), returnedRate: ratio(item.returnedRate), kept: ratio(item.kept) };
    item.buckets.forEach((bucket, position) => { values[`b${position}`] = bucket.state === 'NOT_YET' ? null : Number(bucket.value); });
    addBodyRow(cohortSheet, cohortColumns, values, index);
  });
  finalize(cohortSheet, cohortHeader, cohortHeader + report.cohort.rows.length, cohortColumns.length, { freezeColumns: 1 });
  noteRow(cohortSheet, cohortColumns.length, `Phiếu trả không có phiếu BH gốc trên ERP (hàng bán trước khi dùng ERP): ${report.cohort.unlinkedSlips} phiếu, ${Number(report.cohort.unlinkedValue).toLocaleString('vi-VN')} đ — không xếp được tháng bán. Trung vị số ngày từ giao đến trả: ${report.cohort.medianDays ?? '—'} ngày.`);

  // Sheet 5: theo mã hàng.
  const productColumns: BrandColumn[] = [
    { key: 'stt', header: 'STT', width: 6, type: 'int' },
    { key: 'sku', header: 'Mã hàng', width: 14, type: 'code' },
    { key: 'name', header: 'Tên hàng', width: 40, wrap: true },
    { key: 'unit', header: 'ĐVT', width: 8 },
    { key: 'sold', header: 'SL bán', width: 11, type: 'qty' },
    { key: 'returned', header: 'SL trả', width: 11, type: 'qty', emphasis: true },
    { key: 'rate', header: '% trả (SL)', width: 10, type: 'percent' },
    { key: 'reason', header: 'Lý do chính', width: 26 },
  ];
  const productSheet = brandSheet(workbook, 'Theo mã hàng', productColumns);
  const productHeader = titleBlock(productSheet, productColumns.length, 'Mã hàng bị trả nhiều nhất', customerMeta);
  tableHeader(productSheet, productHeader, productColumns);
  report.products.forEach((item, index) => addBodyRow(productSheet, productColumns, {
    stt: index + 1, sku: item.sku, name: item.name, unit: item.unit, sold: Number(item.soldQuantity), returned: Number(item.returnedQuantity), rate: ratio(item.rate), reason: categoryText(item.mainCategory),
  }, index));
  finalize(productSheet, productHeader, productHeader + report.products.length, productColumns.length, { freezeColumns: 3 });
  noteRow(productSheet, productColumns.length, 'Số lượng theo đơn vị cơ bản. SL bán = dòng bán (không gồm hàng tặng) của phiếu BH giao trong khoảng xem; SL trả = phiếu NK khách trả nhận trong khoảng xem (không gồm hàng tặng trả lại).');

  // Sheet 6: theo NVKD.
  const repColumns: BrandColumn[] = [
    { key: 'stt', header: 'STT', width: 6, type: 'int' },
    { key: 'name', header: 'Nhân viên kinh doanh', width: 30, type: 'code' },
    { key: 'customers', header: 'Số khách', width: 10, type: 'int' },
    { key: 'sales', header: 'Doanh số giao', width: 18, type: 'money' },
    { key: 'returns', header: 'Hàng trả', width: 16, type: 'money', emphasis: true },
    { key: 'rate', header: '% trả', width: 10, type: 'percent' },
    { key: 'credited', header: 'Đã giảm nợ', width: 16, type: 'money' },
    { key: 'pending', header: 'Chờ kế toán', width: 16, type: 'money' },
  ];
  const repSheet = brandSheet(workbook, 'Theo NVKD', repColumns, { portrait: true });
  const repHeader = titleBlock(repSheet, repColumns.length, 'Hàng trả theo nhân viên kinh doanh', customerMeta);
  tableHeader(repSheet, repHeader, repColumns);
  report.reps.forEach((item, index) => addBodyRow(repSheet, repColumns, {
    stt: index + 1, name: item.name, customers: item.customers, sales: Number(item.sales), returns: Number(item.returns), rate: ratio(item.rate), credited: Number(item.credited), pending: Number(item.pending),
  }, index, item.id ? {} : { highlight: 'warn' }));
  finalize(repSheet, repHeader, repHeader + report.reps.length, repColumns.length);
  noteRow(repSheet, repColumns.length, 'Doanh số theo NVKD ghi trên phiếu BH; hàng trả theo NVKD của phiếu BH gốc (không có phiếu gốc: NVKD đang phụ trách khách).');

  // Sheet 7: danh sách phiếu NK nhận trong tháng.
  const slipColumns: BrandColumn[] = [
    { key: 'stt', header: 'STT', width: 6, type: 'int' },
    { key: 'code', header: 'Phiếu NK', width: 16, type: 'code' },
    { key: 'received', header: 'Ngày nhận', width: 12 },
    { key: 'customer', header: 'Khách hàng', width: 30, wrap: true },
    { key: 'source', header: 'Phiếu BH gốc', width: 18 },
    { key: 'delivered', header: 'Ngày giao BH', width: 12 },
    { key: 'days', header: 'Sau (ngày)', width: 9, type: 'int' },
    { key: 'category', header: 'Loại hàng trả', width: 24 },
    { key: 'warehouse', header: 'Về kho', width: 20 },
    { key: 'value', header: 'Giá trị (đ)', width: 15, type: 'money', emphasis: true },
    { key: 'state', header: 'Công nợ', width: 22 },
    { key: 'credit', header: 'Phiếu giảm nợ', width: 22 },
  ];
  const slipSheet = brandSheet(workbook, 'Phiếu NK trong tháng', slipColumns);
  const slipHeader = titleBlock(slipSheet, slipColumns.length, `Phiếu nhập hàng khách trả ${report.month.label}`, meta);
  tableHeader(slipSheet, slipHeader, slipColumns);
  slips.forEach((item, index) => addBodyRow(slipSheet, slipColumns, {
    stt: index + 1, code: item.code, received: dayText(item.receivedAt), customer: `${item.customerCode} · ${item.customerName}`,
    source: item.salesOrderCode ?? (item.preErpSalesCode ? `${item.preErpSalesCode} (trước ERP)` : '—'), delivered: dayText(item.deliveredAt), days: item.days ?? null,
    category: categoryText(item.category), warehouse: item.warehouseName, value: money(item.value),
    state: item.state === 'PENDING' ? `${STATE_TEXT.PENDING} · ${item.pendingDays ?? 0} ngày` : STATE_TEXT[item.state] + (item.value === null ? ' · chưa định giá' : ''),
    credit: item.creditCode ? `${item.creditCode}${item.creditPostedOn ? ` · ${item.creditPostedOn.split('-').reverse().join('/')}` : ''}` : '',
  }, index, item.state === 'PENDING' && (item.pendingDays ?? 0) > 7 ? { highlight: 'warn' } : {}));
  totalRow(slipSheet, slipColumns, { customer: `TỔNG CỘNG (${slips.length} phiếu)`, value: slips.reduce((sum, item) => sum + Number(item.value ?? 0), 0) });
  finalize(slipSheet, slipHeader, slipHeader + slips.length, slipColumns.length, { freezeColumns: 2 });

  return toBuffer(workbook);
}
