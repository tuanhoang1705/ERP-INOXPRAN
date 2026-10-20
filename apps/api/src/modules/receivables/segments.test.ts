import { describe, expect, it } from 'vitest';
import { historySegments, lineSegment, normalizeSku, normalOutstanding, openParts, orderSegments, planPartsAllocation, rulesFor, segmentOutstanding, type SegmentRule } from './segments';

const fans: SegmentRule = { code: 'QUAT-VOT', name: 'Quạt & vợt muỗi', categoryIds: ['cat-quat'], skus: ['INP7901', 'inp7902 '], manualOnly: false, active: true, sortOrder: 1 };
const samples: SegmentRule = { code: 'HANG-MAU', name: 'Hàng mẫu', categoryIds: [], skus: [], manualOnly: true, active: true, sortOrder: 2 };
const rules = [samples, fans];
const day = (value: string) => new Date(`${value}T00:00:00+07:00`);

describe('lineSegment', () => {
  it('khớp theo nhóm hàng hoặc mã hàng (không phân biệt hoa thường, khoảng trắng)', () => {
    expect(lineSegment({ sku: 'INP6401-A', categoryId: 'cat-quat' }, rules)).toBe('QUAT-VOT');
    expect(lineSegment({ sku: ' inp7902', categoryId: 'cat-tien-ich' }, rules)).toBe('QUAT-VOT');
    expect(lineSegment({ sku: 'INP7951', categoryId: 'cat-tien-ich' }, rules)).toBeNull();
  });
  it('mã có khoảng trắng / xuống dòng (trích PDF) vẫn khớp', () => {
    expect(normalizeSku('INP6401(\nXANH)')).toBe(normalizeSku(' inp6401( xanh) '));
  });
  it('hàng tặng, nhóm chỉ gắn tay và nhóm tắt không tự xếp', () => {
    expect(lineSegment({ sku: 'INP7901', gift: true }, rules)).toBeNull();
    expect(lineSegment({ sku: 'INP7901' }, [{ ...fans, active: false }])).toBeNull();
    expect(lineSegment({ sku: 'X', categoryId: 'cat-quat' }, [{ ...samples, categoryIds: ['cat-quat'] }])).toBeNull();
  });
});

describe('orderSegments', () => {
  it('phiếu BH: tiền hàng chưa thuế của dòng quạt + thuế 8%, làm tròn như tổng phiếu', () => {
    const lines = [
      { sku: 'INP6401-A', categoryId: 'cat-quat', netAmount: '509259.26' },
      { sku: 'INP7901', categoryId: 'cat-tien-ich', netAmount: '69444.44' },
      { sku: 'INP1001', categoryId: 'cat-noi', netAmount: '4805555.50' },
      { sku: 'INP6402', categoryId: 'cat-quat', netAmount: '0', gift: true },
    ];
    // (509259.26 + 69444.44) × 1,08 = 625000,00
    expect(orderSegments(lines, '8', '5815000', rules)).toEqual([{ code: 'QUAT-VOT', amount: '625000.00' }]);
  });
  it('không vượt tổng phiếu, không có dòng thuộc nhóm thì rỗng', () => {
    expect(orderSegments([{ categoryId: 'cat-quat', netAmount: '1000000' }], '10', '900000', rules)).toEqual([{ code: 'QUAT-VOT', amount: '900000.00' }]);
    expect(orderSegments([{ categoryId: 'cat-noi', netAmount: '1000000' }], '8', '1080000', rules)).toEqual([]);
  });
});

describe('historySegments', () => {
  it('chứng từ cũ: thành tiền dòng thuộc nhóm (đã gồm thuế), phiếu trả hàng lấy giá trị tuyệt đối', () => {
    const lines = [{ categoryId: 'cat-quat', amount: '55000000' }, { sku: 'INP7902', amount: '8400000' }, { categoryId: 'cat-noi', amount: '5190000.48' }];
    expect(historySegments(lines, '68590000.48', rules)).toEqual([{ code: 'QUAT-VOT', amount: '63400000.00' }]);
    expect(historySegments([{ categoryId: 'cat-quat', amount: '-77000000' }], '77000000', rules)).toEqual([{ code: 'QUAT-VOT', amount: '77000000.00' }]);
  });
});

describe('phần nợ thường / phần nhóm của chứng từ', () => {
  const doc = { id: 'r1', code: 'AR1', amount: '100', paidAmount: '30', dueDate: day('2026-07-01'), createdAt: day('2026-06-01'), segments: [{ code: 'QUAT-VOT', amount: '40', paid: '0' }] };
  it('còn nợ 70 = nợ thường 30 + nợ nhóm 40', () => {
    expect(segmentOutstanding(doc).toFixed(0)).toBe('40');
    expect(normalOutstanding(doc).toFixed(0)).toBe('30');
    expect(openParts(doc).map((part) => [part.segment, part.outstanding])).toEqual([[null, '30.00'], ['QUAT-VOT', '40.00']]);
  });
  it('chứng từ không có nhóm: nợ thường = còn nợ', () => {
    expect(normalOutstanding({ amount: '100', paidAmount: '25' }).toFixed(0)).toBe('75');
  });
});

describe('planPartsAllocation', () => {
  const parts = [
    { receivableId: 'old', segment: 'QUAT-VOT', outstanding: '40', dueDate: day('2026-06-01'), createdAt: day('2026-05-01'), code: 'AR1' },
    { receivableId: 'old', segment: null, outstanding: '10', dueDate: day('2026-06-01'), createdAt: day('2026-05-01'), code: 'AR1' },
    { receivableId: 'new', segment: null, outstanding: '50', dueDate: day('2026-08-01'), createdAt: day('2026-07-01'), code: 'AR2' },
  ];
  it('mặc định: nợ thường (cũ trước) rồi mới tới phần nhóm', () => {
    expect(planPartsAllocation(parts, '70')).toEqual({
      allocations: [{ receivableId: 'old', segment: null, amount: '10.00' }, { receivableId: 'new', segment: null, amount: '50.00' }, { receivableId: 'old', segment: 'QUAT-VOT', amount: '10.00' }],
      leftover: '0.00',
    });
  });
  it('thu cho nhóm: phần nhóm trước, dư sang nợ thường; thu vượt thành phần dư', () => {
    expect(planPartsAllocation(parts, '45', 'QUAT-VOT').allocations).toEqual([{ receivableId: 'old', segment: 'QUAT-VOT', amount: '40.00' }, { receivableId: 'old', segment: null, amount: '5.00' }]);
    expect(planPartsAllocation(parts, '120').leftover).toBe('20.00');
  });
});

describe('rulesFor (nhóm chỉ áp dụng cho khách được chọn)', () => {
  const selected: SegmentRule = { ...fans, scope: 'SELECTED', partnerIds: ['npp-1'] };
  it('khách trong danh sách mới tách; khách ngoài danh sách thì hàng quạt tính như nợ thường', () => {
    expect(historySegments([{ categoryId: 'cat-quat', amount: '1000' }], '1000', rulesFor('npp-1', [selected]))).toEqual([{ code: 'QUAT-VOT', amount: '1000.00' }]);
    expect(historySegments([{ categoryId: 'cat-quat', amount: '1000' }], '1000', rulesFor('kh-le', [selected]))).toEqual([]);
    expect(rulesFor(undefined, [selected])).toEqual([]);
  });
  it('nhóm mọi khách (hoặc cấu hình cũ không có phạm vi) và nhóm gắn tay không bị lọc', () => {
    expect(rulesFor('kh-le', [fans, samples, { ...samples, code: 'X', scope: 'SELECTED', partnerIds: [] }]).map((rule) => rule.code)).toEqual(['QUAT-VOT', 'HANG-MAU', 'X']);
  });
});
