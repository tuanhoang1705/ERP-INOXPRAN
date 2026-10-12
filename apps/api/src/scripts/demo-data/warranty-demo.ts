/**
 * Phiếu bảo hành demo, tính tương đối theo thời điểm chạy seed để danh sách luôn có đủ 3 màu:
 * đỏ (quá hẹn), vàng (đã qua 70% thời gian hẹn), không màu; kèm các bước chờ Giám đốc duyệt, chờ khách duyệt báo giá,
 * khách không có hóa đơn, sản phẩm bảo hành lần thứ 3 và phiếu đã trả (đúng hẹn / trễ hẹn).
 */
import { addDays, coverageFor, serviceDays, vnDate, WARRANTY_DEFAULTS, type WarrantyStatus } from '@inoxpran/contracts';
import Decimal from 'decimal.js';
import { Decimal128, type Db, type Document, ObjectId } from 'mongodb';

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;
const money = (value: number) => Decimal128.fromString(new Decimal(value).toString());

interface Staff { id: ObjectId; name: string }

/** Danh mục mã lỗi theo nhóm hàng (mã nhóm trong bảng giá); nhóm rỗng = dùng chung. Gồm các mã đã dùng trên phiếu demo. */
const FAULT_CODES: Array<[code: string, name: string, categories: string[]]> = [
  ['NC-01', 'Không vào điện / không lên nguồn', ['DIEN-BEP']],
  ['NC-02', 'Hở nắp, thoát hơi (gioăng)', ['DIEN-BEP']],
  ['NC-03', 'Báo lỗi mã E trên màn hình / bo mạch', ['DIEN-BEP']],
  ['NC-04', 'Không giữ ấm, nấu khê / sống (cảm biến nhiệt)', ['DIEN-BEP']],
  ['NOI-01', 'Đáy nồi phồng, cong vênh', ['NOI-INOX']],
  ['NOI-02', 'Ố, gỉ bề mặt inox', ['NOI-INOX']],
  ['NOI-06', 'Tay cầm / quai lỏng, gãy đinh tán', ['NOI-INOX', 'CHAO', 'GANG']],
  ['CHAO-01', 'Bong lớp chống dính', ['CHAO']],
  ['CHAO-02', 'Đáy không nhận bếp từ', ['CHAO', 'NOI-INOX']],
  ['GANG-01', 'Nứt / bong men do sản xuất', ['GANG']],
  ['GANG-03', 'Vỡ men do va đập', ['GANG']],
  ['QUAT-01', 'Không quay, không lên đèn', ['QUAT']],
  ['QUAT-02', 'Không quay, có tiếng ù (tụ khởi động)', ['QUAT']],
  ['QUAT-05', 'Chạy yếu, mô tơ nóng (bạc đạn)', ['QUAT']],
  ['QUAT-07', 'Điều khiển từ xa không nhận lệnh', ['QUAT']],
  ['PIN-01', 'Pin không sạc / nhanh hết', ['QUAT', 'TIEN-ICH']],
  ['TI-01', 'Không phóng điện / không hoạt động', ['TIEN-ICH']],
  ['KHAC-01', 'Lỗi khác (ghi rõ ở hiện tượng)', []],
];

/** Sinh số giả ngẫu nhiên cố định để dữ liệu demo giống nhau mỗi lần seed. */
function sequence(seed: number) {
  let state = seed;
  return () => {
    state = (state * 1_103_515_245 + 12_345) % 2_147_483_648;
    return state / 2_147_483_648;
  };
}

interface TicketSpec {
  key: string;
  /** Tiếp nhận cách thời điểm seed bao nhiêu giờ. */
  hoursAgo: number;
  turnaroundDays?: number;
  customer: { code?: string; name?: string; phone?: string; address?: string };
  channel: 'DEALER' | 'WALK_IN' | 'ONSITE';
  sku: string;
  /** Số tháng trước khi tiếp nhận mà khách mua (ngày hóa đơn); bỏ trống = không có hóa đơn. */
  invoice?: { number: string; monthsBefore: number };
  symptom: string;
  accessories?: string;
  condition?: string;
  steps: Array<(ticket: Document, at: (hoursAfterReceipt: number) => Date) => void>;
  status: WarrantyStatus;
}

export async function seedWarrantyDemo(db: Db, now: Date, counters: Map<string, number>, staff: { receiver: Staff; technician: Staff }) {
  const products = new Map((await db.collection('products').find({}).toArray()).map((product) => [String(product.sku), product]));
  const categoryRows = await db.collection('product_categories').find({}).toArray();
  const categoriesById = new Map(categoryRows.map((category) => [(category._id as ObjectId).toHexString(), String(category.name)]));
  const categoryIdByCode = new Map(categoryRows.map((category) => [String(category.code), category._id as ObjectId]));
  await db.collection('warranty_fault_codes').insertMany(FAULT_CODES.map(([code, name, categories]) => ({
    _id: new ObjectId(), code, name, categoryIds: categories.map((item) => categoryIdByCode.get(item)).filter(Boolean), active: true, demoData: true, createdAt: now, updatedAt: now,
  })));
  const partners = new Map((await db.collection('partners').find({ kind: 'CUSTOMER' }).toArray()).map((partner) => [String(partner.code), partner]));

  const diagnose = (lines: Document[], plan: string, extra: Document = {}) => (ticket: Document, at: (h: number) => Date) => {
    Object.assign(ticket, { lines, plan, ...extra });
    ticket.history.push({ at: at(3), byName: staff.technician.name, action: 'DIAGNOSE', from: 'RECEIVED', to: extra.nextStatus ?? 'REPAIRING' });
    delete ticket.nextStatus;
  };
  const event = (hours: number, action: string, from: string, to: string, note?: string, byName = staff.technician.name) => (ticket: Document, at: (h: number) => Date) => {
    ticket.history.push({ at: at(hours), byName, action, from, to, ...(note ? { note } : {}) });
  };
  const repaired = (hours: number, resolution: 'REPAIRED' | 'PART_REPLACED', cost: number, replacedParts?: string) => (ticket: Document, at: (h: number) => Date) => {
    ticket.result = { resolution, cost: money(cost), chargedTo: ticket.coverage === 'IN_WARRANTY' ? 'COMPANY' : 'CUSTOMER', completedAt: at(hours), ...(replacedParts ? { replacedParts } : {}) };
    ticket.history.push({ at: at(hours), byName: staff.technician.name, action: 'REPAIR_DONE', from: 'REPAIRING', to: 'TESTING' });
  };
  const tested = (hours: number) => (ticket: Document, at: (h: number) => Date) => {
    ticket.test = { functional: true, safety: true, performance: true, testedAt: at(hours), testedByName: staff.receiver.name };
    ticket.history.push({ at: at(hours), byName: staff.receiver.name, action: 'TEST', from: 'TESTING', to: 'READY', note: 'Đạt chức năng, an toàn, hiệu suất' });
  };
  const returned = (hours: number, receiver: string) => (ticket: Document, at: (h: number) => Date) => {
    ticket.returnedAt = at(hours);
    ticket.returnedTo = receiver;
    ticket.serviceDays = serviceDays(ticket.receivedAt as Date, ticket.returnedAt as Date);
    ticket.history.push({ at: at(hours), byName: staff.receiver.name, action: 'RETURN', from: 'READY', to: 'RETURNED' });
  };
  const line = (symptom: string, rootCause?: string, action?: string, partCode?: string, faultCode?: string) =>
    ({ symptom, ...(rootCause ? { rootCause } : {}), ...(action ? { action } : {}), ...(partCode ? { partCode } : {}), ...(faultCode ? { faultCode } : {}) });

  const specs: TicketSpec[] = [
    // Quá hẹn (đỏ): chờ linh kiện.
    {
      key: 'red-parts', hoursAgo: 9 * 24 + 6, customer: { code: 'KH005' }, channel: 'DEALER', sku: 'INP6402', invoice: { number: '0004581', monthsBefore: 4 },
      symptom: 'Quạt không quay, có tiếng ù khi bật', accessories: 'Điều khiển từ xa', condition: 'Thân quạt trầy nhẹ',
      steps: [
        diagnose([line('Quạt không quay, có tiếng ù khi bật', 'Tụ khởi động 1.5 µF bị phồng', 'Thay tụ khởi động', 'LK-TU-15', 'QUAT-02')], 'REPAIR'),
        event(20, 'WAIT_PARTS', 'REPAIRING', 'WAITING_PARTS', 'Chờ tụ 1.5 µF từ nhà cung cấp'),
      ],
      status: 'WAITING_PARTS',
    },
    // Quá hẹn (đỏ): sửa xong, chưa kiểm tra sau sửa.
    {
      key: 'red-testing', hoursAgo: 11 * 24 + 3, customer: { name: 'Chị Nguyễn Thu Trang', phone: '0912 456 789', address: 'Ngõ 12 Trần Thái Tông, Cầu Giấy, Hà Nội' }, channel: 'WALK_IN',
      sku: 'INP6001', invoice: { number: '0003925', monthsBefore: 6 }, symptom: 'Nồi cơm không chuyển sang chế độ giữ ấm, cơm bị khê',
      steps: [
        diagnose([line('Nồi cơm không chuyển sang giữ ấm, cơm bị khê', 'Cảm biến nhiệt đáy nồi sai lệch', 'Thay cảm biến nhiệt', 'LK-CB-NC18', 'NC-04')], 'REPAIR'),
        repaired(4 * 24, 'PART_REPLACED', 0, 'Cảm biến nhiệt đáy nồi'),
      ],
      status: 'TESTING',
    },
    // Vàng: đề nghị đổi sản phẩm mới, chờ Giám đốc duyệt.
    {
      key: 'yellow-exchange', hoursAgo: 6 * 24 + 2, customer: { code: 'KH008' }, channel: 'DEALER', sku: 'INP2102', invoice: { number: '0005112', monthsBefore: 3 },
      symptom: 'Bong lớp chống dính ở đáy chảo sau 3 tháng sử dụng', condition: 'Còn hộp, đáy chảo bong 2 vết',
      steps: [
        diagnose([line('Bong lớp chống dính ở đáy chảo', 'Lỗi phủ lớp chống dính từ nhà máy (lô 2606)', 'Đề nghị đổi chảo mới cùng mã', undefined, 'CHAO-01')], 'EXCHANGE', { nextStatus: 'PENDING_APPROVAL' }),
        (ticket, at) => { ticket.approval = { proposal: 'EXCHANGE', requestedAt: at(3), requestedByName: staff.technician.name, note: 'Lỗi nhà sản xuất, không sửa được' }; },
      ],
      status: 'PENDING_APPROVAL',
    },
    // Vàng: đã kiểm tra đạt, chờ khách tới nhận.
    {
      key: 'yellow-ready', hoursAgo: 6 * 24 + 5, customer: { code: 'KH007' }, channel: 'DEALER', sku: 'INP6002', invoice: { number: '0004203', monthsBefore: 8 },
      symptom: 'Nắp trong nồi cơm bị hở, hơi thoát ra ngoài', accessories: 'Muỗng, cốc đong',
      steps: [
        diagnose([line('Nắp trong bị hở, thoát hơi', 'Gioăng cao su nắp trong bị chai', 'Thay gioăng nắp trong', 'LK-GIOANG-18', 'NC-02')], 'REPAIR'),
        repaired(2 * 24, 'PART_REPLACED', 0, 'Gioăng cao su nắp trong'),
        tested(2 * 24 + 4),
      ],
      status: 'READY',
    },
    // Không màu: khách lẻ không có hóa đơn → không thuộc diện bảo hành, chờ kiểm tra.
    {
      key: 'normal-no-invoice', hoursAgo: 2, customer: { name: 'Anh Phạm Văn Long', phone: '0983 221 456', address: 'Thôn Đông, xã Sơn Đồng, Hà Nội' }, channel: 'WALK_IN', sku: 'INP7901',
      symptom: 'Vợt muỗi không phóng điện dù đã sạc đầy', condition: 'Lưới vợt cong nhẹ',
      steps: [],
      status: 'RECEIVED',
    },
    // Không màu: hết bảo hành, chờ khách duyệt báo giá.
    {
      key: 'normal-quote', hoursAgo: 2 * 24 + 1, customer: { code: 'KH010' }, channel: 'DEALER', sku: 'INP6403', invoice: { number: '0001877', monthsBefore: 14 },
      symptom: 'Quạt chạy yếu, mô tơ nóng nhanh',
      steps: [
        diagnose([line('Quạt chạy yếu, mô tơ nóng nhanh', 'Bạc đạn mô tơ mòn, thiếu dầu', 'Thay bạc đạn, tra dầu', 'LK-BAC-608', 'QUAT-05')], 'QUOTE', { quoteAmount: money(180000), nextStatus: 'QUOTE_PENDING' }),
      ],
      status: 'QUOTE_PENDING',
    },
    // Không màu: lỗi do người dùng (rơi vỡ), đề nghị từ chối bảo hành chờ Giám đốc duyệt.
    {
      key: 'normal-reject', hoursAgo: 26, customer: { code: 'KH011' }, channel: 'DEALER', sku: 'INP3001', invoice: { number: '0004890', monthsBefore: 5 },
      symptom: 'Vỡ men tráng ở thành nồi', condition: 'Thành nồi có vết va đập, men bong mảng lớn',
      steps: [
        diagnose([line('Vỡ men tráng ở thành nồi', 'Va đập mạnh (rơi), không phải lỗi sản xuất', 'Đề nghị từ chối bảo hành, báo khách', undefined, 'GANG-03')], 'REJECT', { nextStatus: 'PENDING_APPROVAL', exclusion: 'PHYSICAL_DAMAGE', coverage: 'NOT_COVERED' }),
        (ticket, at) => { ticket.approval = { proposal: 'REJECT', requestedAt: at(3), requestedByName: staff.technician.name, note: 'Ảnh vết va đập đã gửi đại lý qua Zalo' }; },
      ],
      status: 'PENDING_APPROVAL',
    },
    // Không màu: dời hẹn vì chờ linh kiện từ nhà máy.
    {
      key: 'normal-rescheduled', hoursAgo: 8 * 24, turnaroundDays: 7, customer: { code: 'KH004' }, channel: 'DEALER', sku: 'INP1002', invoice: { number: '0003391', monthsBefore: 7 },
      symptom: 'Tay cầm nồi 24 cm bị lỏng, xoay được',
      steps: [
        diagnose([line('Tay cầm nồi 24 cm lỏng', 'Đinh tán tay cầm bị gãy', 'Thay tay cầm và đinh tán', 'LK-TAYCAM-24', 'NOI-06')], 'REPAIR'),
        event(30, 'WAIT_PARTS', 'REPAIRING', 'WAITING_PARTS', 'Chờ tay cầm thay thế từ nhà máy'),
        (ticket, at) => {
          const to = addDays(vnDate(now), 5);
          ticket.reschedules.push({ from: ticket.promisedDate, to, reason: 'Nhà máy giao tay cầm thay thế chậm', at: at(5 * 24), byName: staff.technician.name });
          ticket.history.push({ at: at(5 * 24), byName: staff.technician.name, action: 'RESCHEDULE', from: 'WAITING_PARTS', to: 'WAITING_PARTS', note: `${String(ticket.promisedDate)} → ${to}: Nhà máy giao tay cầm thay thế chậm` });
          ticket.promisedDate = to;
        },
      ],
      status: 'WAITING_PARTS',
    },
    // Đã trả đúng hẹn.
    {
      key: 'returned-on-time', hoursAgo: 12 * 24, customer: { code: 'KH002' }, channel: 'DEALER', sku: 'INP6402', invoice: { number: '0002764', monthsBefore: 9 },
      symptom: 'Điều khiển từ xa không nhận lệnh',
      steps: [
        diagnose([line('Điều khiển từ xa không nhận lệnh', 'Mắt nhận hồng ngoại hỏng', 'Thay mắt nhận', 'LK-IR-01', 'QUAT-07')], 'REPAIR'),
        repaired(2 * 24, 'PART_REPLACED', 0, 'Mắt nhận hồng ngoại'),
        tested(2 * 24 + 3),
        returned(4 * 24, 'Nhân viên giao nhận Tân Tiến'),
      ],
      status: 'RETURNED',
    },
    // Đã trả, trễ hẹn 3 ngày.
    {
      key: 'returned-late', hoursAgo: 20 * 24, customer: { code: 'KH009' }, channel: 'DEALER', sku: 'INP6002', invoice: { number: '0003066', monthsBefore: 10 },
      symptom: 'Nồi cơm không vào điện',
      steps: [
        diagnose([line('Nồi cơm không vào điện', 'Cầu chì nhiệt bị đứt', 'Thay cầu chì nhiệt', 'LK-CC-185', 'NC-01')], 'REPAIR'),
        event(30, 'WAIT_PARTS', 'REPAIRING', 'WAITING_PARTS', 'Hết cầu chì nhiệt trong kho'),
        event(6 * 24, 'PARTS_ARRIVED', 'WAITING_PARTS', 'REPAIRING'),
        repaired(8 * 24, 'PART_REPLACED', 0, 'Cầu chì nhiệt 185 °C'),
        tested(9 * 24),
        returned(10 * 24 + 10, 'Anh Hoàng (Điện máy Hoàng Gia)'),
      ],
      status: 'RETURNED',
    },
  ];

  // Phiếu đã trả trong 6 tháng qua (cho báo cáo): đủ các kết quả sửa / thay linh kiện / đổi mới / hoàn tiền / từ chối / sửa có phí.
  const rand = sequence(20261005);
  const pick = <T>(items: readonly T[]): T => items[Math.floor(rand() * items.length) % items.length] as T;
  const skusByCategory = new Map<string, string[]>();
  for (const product of products.values()) {
    const code = categoryRows.find((category) => (category._id as ObjectId).equals(product.categoryId as ObjectId))?.code;
    if (code && product.status === 'ACTIVE') skusByCategory.set(String(code), [...(skusByCategory.get(String(code)) ?? []), String(product.sku)]);
  }
  const faultsByCategory = (category: string) => FAULT_CODES.filter(([, , categories]) => categories.includes(category)).map(([code, name]) => ({ code, name }));
  const dealers = ['KH001', 'KH002', 'KH003', 'KH004', 'KH006', 'KH007', 'KH009', 'KH012', 'KH014', 'KH016'];
  const walkIns = [
    { name: 'Chị Lê Thu Hà', phone: '0904 118 226', address: 'Hoài Đức, Hà Nội' },
    { name: 'Anh Trần Quốc Bảo', phone: '0936 552 017', address: 'Đan Phượng, Hà Nội' },
    { name: 'Cô Nguyễn Thị Lan', phone: '0912 773 905', address: 'Bắc Từ Liêm, Hà Nội' },
  ];
  const categoryWeights = ['DIEN-BEP', 'DIEN-BEP', 'DIEN-BEP', 'QUAT', 'QUAT', 'CHAO', 'CHAO', 'NOI-INOX', 'GANG', 'TIEN-ICH'];
  const receivers = ['Nhân viên giao nhận Tân Tiến', 'Khách nhận tại showroom', 'Đại lý tự lấy', 'Giao qua Viettel Post'];
  // Tỉ lệ kết quả gần thực tế: phần lớn sửa / thay linh kiện, ít đổi mới, hiếm hoàn tiền.
  const HISTORY_KINDS = ['repair', 'part', 'repair', 'paid', 'repair', 'part', 'exchange', 'repair', 'reject', 'part', 'repair', 'paid', 'repair', 'part', 'repair', 'exchange', 'repair', 'part', 'refund', 'repair', 'paid', 'part', 'repair', 'reject', 'repair', 'part', 'unrepaired', 'repair', 'exchange', 'part'] as const;
  for (let index = 0; index < 30; index += 1) {
    const category = pick(categoryWeights);
    const skus = skusByCategory.get(category) ?? [];
    if (!skus.length) continue;
    const sku = pick(skus);
    const fault = pick(faultsByCategory(category).length ? faultsByCategory(category) : [{ code: 'KHAC-01', name: 'Lỗi khác' }]);
    const kind = HISTORY_KINDS[index % HISTORY_KINDS.length] as (typeof HISTORY_KINDS)[number];
    const hoursAgo = Math.round((24 + rand() * 150) * 24);
    const returnHours = Math.round((1.5 + rand() * (rand() < 0.2 ? 11 : 6.2)) * 24);
    const walkIn = rand() < 0.25;
    const outOfWarranty = kind === 'paid' || kind === 'unrepaired';
    const invoice = { number: `000${String(1200 + index * 37).padStart(4, '0')}`, monthsBefore: outOfWarranty ? 13 + Math.floor(rand() * 6) : 1 + Math.floor(rand() * 10) };
    const director = 'Ban Giám đốc';
    const steps: TicketSpec['steps'] = [];
    const faultLine = line(fault.name, undefined, undefined, undefined, fault.code);
    if (kind === 'repair' || kind === 'part') {
      steps.push(diagnose([{ ...faultLine, action: kind === 'part' ? 'Thay linh kiện hỏng' : 'Vệ sinh, cân chỉnh, sửa mạch' }], 'REPAIR'));
      steps.push(repaired(returnHours - 20, kind === 'part' ? 'PART_REPLACED' : 'REPAIRED', kind === 'part' ? 40_000 + Math.round(rand() * 21) * 10_000 : 0, kind === 'part' ? 'Linh kiện thay thế' : undefined));
      steps.push(tested(returnHours - 16));
    } else if (kind === 'paid' || kind === 'unrepaired') {
      const quote = 120_000 + Math.round(rand() * 25) * 10_000;
      steps.push(diagnose([faultLine], 'QUOTE', { quoteAmount: money(quote), nextStatus: 'QUOTE_PENDING' }));
      if (kind === 'paid') {
        steps.push((ticket) => { ticket.quoteAccepted = true; });
        steps.push(event(20, 'QUOTE_DECISION', 'QUOTE_PENDING', 'REPAIRING', 'Khách đồng ý báo giá'));
        steps.push(repaired(returnHours - 20, 'PART_REPLACED', quote, 'Linh kiện theo báo giá'));
        steps.push(tested(returnHours - 16));
      } else {
        steps.push((ticket, at) => {
          ticket.quoteAccepted = false;
          ticket.result = { resolution: 'RETURNED_UNREPAIRED', cost: money(0), chargedTo: 'CUSTOMER', completedAt: at(20) };
        });
        steps.push(event(20, 'QUOTE_DECISION', 'QUOTE_PENDING', 'READY', 'Khách không đồng ý báo giá'));
      }
    } else {
      const proposal = kind === 'reject' ? 'REJECT' : kind === 'exchange' ? 'EXCHANGE' : 'REFUND';
      steps.push(diagnose([{ ...faultLine, rootCause: kind === 'reject' ? 'Hư hỏng do va đập / sử dụng sai' : 'Lỗi sản xuất, không sửa được' }], proposal, {
        nextStatus: 'PENDING_APPROVAL',
        ...(kind === 'reject' ? { exclusion: pick(['PHYSICAL_DAMAGE', 'LIQUID', 'MISUSE']), coverage: 'NOT_COVERED' } : {}),
      }));
      steps.push((ticket, at) => {
        const product = products.get(sku) as Document;
        const cost = kind === 'exchange' ? new Decimal(String(product.standardCost ?? product.listPrice)).toNumber() : kind === 'refund' ? new Decimal(String(product.listPrice)).toNumber() : 0;
        ticket.approval = { proposal, requestedAt: at(4), requestedByName: staff.technician.name, decidedAt: at(26), decidedByName: director, approved: true };
        ticket.result = { resolution: kind === 'reject' ? 'REJECTED' : kind === 'exchange' ? 'EXCHANGED' : 'REFUNDED', cost: money(cost), chargedTo: kind === 'reject' ? 'CUSTOMER' : 'COMPANY', completedAt: at(26) };
        if (kind === 'refund') ticket.refund = { amount: money(cost) };
      });
      steps.push(event(26, 'APPROVE', 'PENDING_APPROVAL', 'READY', 'Đồng ý', director));
    }
    steps.push(returned(returnHours, pick(receivers)));
    specs.push({
      key: `history-${index}`, hoursAgo, customer: walkIn ? pick(walkIns) : { code: pick(dealers) }, channel: walkIn ? 'WALK_IN' : 'DEALER', sku,
      invoice, symptom: fault.name, steps, status: 'RETURNED',
    });
  }

  // Sản phẩm bảo hành lần thứ 3: hai lần trước đã trả, lần này vẫn lỗi → hệ thống đề xuất đổi mới / hoàn tiền.
  const repeatInvoice = { number: '0003310', monthsBefore: 7 };
  const repeatCustomer = { code: 'KH001' };
  for (const [index, hoursAgo] of [[1, 120 * 24], [2, 60 * 24]] as const) {
    specs.push({
      key: `repeat-${index}`, hoursAgo, customer: repeatCustomer, channel: 'DEALER', sku: 'INP6001', invoice: repeatInvoice,
      symptom: 'Nồi cơm báo lỗi E3, không nấu được',
      steps: [
        diagnose([line('Báo lỗi E3, không nấu', 'Mạch điều khiển chập do ẩm', 'Sấy và thay tụ lọc mạch điều khiển', 'LK-MACH-NC18', 'NC-03')], 'REPAIR'),
        repaired(3 * 24, 'REPAIRED', 0),
        tested(3 * 24 + 4),
        returned(index === 1 ? 5 * 24 : 6 * 24, 'Kho NPP Phú Cường'),
      ],
      status: 'RETURNED',
    });
  }
  specs.push({
    key: 'repeat-3', hoursAgo: 22, customer: repeatCustomer, channel: 'DEALER', sku: 'INP6001', invoice: repeatInvoice,
    symptom: 'Nồi cơm lại báo lỗi E3 (lần thứ 3)', condition: 'Còn tem bảo hành, đã sửa 2 lần',
    steps: [],
    status: 'RECEIVED',
  });

  // Ngày hóa đơn cố định cho cùng một sản phẩm của lần bảo hành thứ 3.
  const repeatInvoiceDate = addDays(vnDate(new Date(now.getTime() - 22 * HOUR_MS)), -repeatInvoice.monthsBefore * 30);
  const tickets: Document[] = [];
  const priorByProduct = new Map<string, { count: number; extensionDays: number }>();
  for (const spec of specs.sort((a, b) => b.hoursAgo - a.hoursAgo)) {
    const product = products.get(spec.sku);
    if (!product) throw new Error(`Thiếu sản phẩm demo ${spec.sku}`);
    const receivedAt = new Date(now.getTime() - spec.hoursAgo * HOUR_MS);
    const receivedDate = vnDate(receivedAt);
    const invoiceDate = spec.invoice ? (spec.invoice.number === repeatInvoice.number ? repeatInvoiceDate : addDays(receivedDate, -spec.invoice.monthsBefore * 30)) : null;
    const priorKey = spec.invoice ? `${spec.sku}:${spec.invoice.number}` : '';
    const prior = priorByProduct.get(priorKey) ?? { count: 0, extensionDays: 0 };
    const coverage = coverageFor({ invoiceDate, receivedDate, months: WARRANTY_DEFAULTS.warrantyMonths, extensionDays: prior.extensionDays });
    const partner = spec.customer.code ? partners.get(spec.customer.code) : undefined;
    const promisedDate = addDays(receivedDate, spec.turnaroundDays ?? WARRANTY_DEFAULTS.turnaroundDays);
    const at = (hours: number) => new Date(receivedAt.getTime() + hours * HOUR_MS);
    const ticket: Document = {
      _id: new ObjectId(),
      status: spec.status,
      channel: spec.channel,
      customer: partner
        ? { partnerId: partner._id, code: String(partner.code), name: String(partner.name), ...(partner.phone ? { phone: String(partner.phone) } : {}), ...(partner.address ? { address: String(partner.address) } : {}) }
        : { name: spec.customer.name, phone: spec.customer.phone, address: spec.customer.address },
      product: { productId: product._id, sku: spec.sku, name: String(product.name), categoryName: categoriesById.get((product.categoryId as ObjectId).toHexString()) },
      ...(spec.invoice && invoiceDate ? { invoice: { number: spec.invoice.number, date: invoiceDate } } : {}),
      coverage: coverage.coverage,
      ...(coverage.exclusion ? { exclusion: coverage.exclusion } : {}),
      warranty: {
        months: WARRANTY_DEFAULTS.warrantyMonths,
        ...(coverage.startsOn ? { startsOn: coverage.startsOn } : {}),
        ...(coverage.expiresOn ? { expiresOn: coverage.expiresOn } : {}),
        extensionDays: prior.extensionDays,
        priorServiceCount: prior.count,
      },
      receivedAt,
      receivedDate,
      promisedDate,
      originalPromisedDate: promisedDate,
      reschedules: [],
      receivedById: staff.receiver.id,
      receivedByName: staff.receiver.name,
      technicianId: staff.technician.id,
      technicianName: staff.technician.name,
      ...(spec.accessories ? { accessories: spec.accessories } : {}),
      ...(spec.condition ? { condition: spec.condition } : {}),
      lines: [{ receivedDate, symptom: spec.symptom }],
      history: [{ at: receivedAt, byName: staff.receiver.name, action: 'RECEIVE', to: 'RECEIVED', note: spec.symptom }],
      demoData: true,
      createdAt: receivedAt,
    };
    for (const step of spec.steps) step(ticket, at);
    for (const item of ticket.lines as Document[]) item.receivedDate = receivedDate;
    ticket.version = (ticket.history as Document[]).length;
    ticket.updatedAt = (ticket.history as Document[]).at(-1)?.at ?? receivedAt;
    const period = `${receivedDate.slice(2, 4)}${receivedDate.slice(5, 7)}`;
    const counterKey = `SC:${period}`;
    const sequence = (counters.get(counterKey) ?? 0) + 1;
    counters.set(counterKey, sequence);
    ticket.code = `SC20${period}${String(sequence).padStart(4, '0')}`;
    if (spec.status === 'RETURNED' && ticket.coverage === 'IN_WARRANTY' && priorKey) {
      priorByProduct.set(priorKey, { count: prior.count + 1, extensionDays: prior.extensionDays + Number(ticket.serviceDays ?? 0) });
    }
    tickets.push(ticket);
  }
  await db.collection('warranty_tickets').insertMany(tickets);
  return { total: tickets.length, open: tickets.filter((ticket) => !['RETURNED', 'CANCELLED'].includes(String(ticket.status))).length, faultCodes: FAULT_CODES.length };
}
