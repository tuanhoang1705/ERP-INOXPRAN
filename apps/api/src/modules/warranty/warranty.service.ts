import { BadRequestException, ConflictException, ForbiddenException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import {
  coverageFor,
  DEFECT_RETURN_CATEGORIES,
  MAX_WARRANTY_PHOTOS,
  plansForCoverage,
  RESOLUTIONS_RETURNING_DEFECT,
  serviceDays,
  vnDate,
  WARRANTY_ACTIONS_BY_STATUS,
  WARRANTY_EDIT_GRANT_HOURS,
  warrantyEditableStages,
  type WarrantyEditDecision,
  type WarrantyEditRequestInput,
  type WarrantyEditRequestStatus,
  type WarrantyEditRequestView,
  type WarrantyEditStage,
  type WarrantyPlan,
  type WarrantyStageEdit,
  type WarrantyPhotoKind,
  type WarrantyReport,
  type WarrantyResolution,
  type CreateWarrantyTicket,
  type CustomerReturnCategory,
  type UpdateWarrantyIntake,
  type WarrantyReturnSlipOption,
  type NotificationTemplate,
  type TextParams,
  type WarrantyAction,
  type WarrantyCoverage,
  type WarrantyExchangeOrder,
  type WarrantyStatus,
} from '@inoxpran/contracts';
import Decimal from 'decimal.js';
import { type ClientSession, type Db, type Document, type Filter, ObjectId } from 'mongodb';
import { dateRangeFilter } from '../../common/date-range';
import { AuditService } from '../../common/audit.service';
import { releaseDocumentNumber } from '../../common/document-numbers';
import { decimal, decimalString, serializeDocument, toObjectId } from '../../common/domain';
import { hideStatus, seesCancelled, type Viewer } from '../../common/hidden-documents';
import { IdempotencyService } from '../../common/idempotency.service';
import { OutboxService } from '../../common/outbox.service';
import type { AuthenticatedRequest, RequestUser } from '../../common/request-context';
import { SequenceService } from '../../common/sequence.service';
import { resolveStaff, type PickedStaff } from '../../common/staff';
import { MONGO_DATABASE } from '../../common/tokens';
import { ticketSla, WARRANTY_TICKETS, warrantySettings } from './warranty-sla';
import { slicePage, type PageRequest } from '../../common/paging';
import { EvidenceIntakeService } from '../../common/evidence-intake.service';
import { InventoryService } from '../inventory/inventory.service';
import { SalesService, WALK_IN_PARTNER_CODE } from '../sales/sales.service';
import { HistoryEditService } from '../receivables/history-edit.service';

/** Tên giai đoạn ghi lịch sử / thông báo (WAR-EDIT-01). */
const WARRANTY_STAGE_LABEL: Record<WarrantyEditStage, string> = { INTAKE: 'Tiếp nhận', DIAGNOSE: 'Chẩn đoán', REPAIR: 'Sửa chữa', TEST: 'Kiểm tra', RETURN: 'Trả khách' };
const WARRANTY_PLAN_LABEL: Record<WarrantyPlan, string> = { REPAIR: 'Sửa chữa bảo hành (miễn phí)', QUOTE: 'Báo giá sửa chữa', REJECT: 'Từ chối bảo hành', EXCHANGE: 'Đổi sản phẩm mới', REFUND: 'Hoàn tiền' };
import { WarrantyFaultCodesService } from './warranty-fault-codes.service';
import { buildWarrantyReport, shiftMonth } from './warranty-report';

/**
 * Nhân viên bảo hành tiếp nhận và xử lý; Quản lý kho có mọi quyền bảo hành và duyệt từ chối / đổi mới / hoàn tiền
 * (WAR-ROLE-01, 28/10/2026 — trước đây Giám đốc duyệt); Giám đốc chỉ xem.
 */
export const WARRANTY_STAFF_ROLES = ['ADMIN', 'WARRANTY', 'WAREHOUSE_MANAGER'];
export const WARRANTY_APPROVER_ROLES = ['ADMIN', 'WAREHOUSE_MANAGER'];
export const WARRANTY_VIEWER_ROLES = ['ADMIN', 'DIRECTOR', 'WARRANTY', 'WAREHOUSE_MANAGER'];

const RESOLUTION_BY_PROPOSAL = { REJECT: 'REJECTED', EXCHANGE: 'EXCHANGED', REFUND: 'REFUNDED' } as const;
const PHOTO_PURPOSE = 'WARRANTY_PHOTO';
const ESCAPE = /[.*+?^${}()|[\]\\]/g;

interface PriorServices {
  count: number;
  extensionDays: number;
  /** Ngày bắt đầu bảo hành mới khi sản phẩm đã được đổi (luật: tính lại từ ngày đổi). */
  restartedOn?: string;
}

/** Lựa chọn khi khách không có hóa đơn (WAR-NOINV-01); có hóa đơn thì bỏ qua (schema đã chặn gửi kèm). */
function noInvoiceChoice(input: { invoiceDate?: string | undefined; noInvoiceWarranty?: boolean | undefined; declaredPurchaseDate?: string | undefined }) {
  if (input.invoiceDate) return { noInvoiceWarranty: false };
  return { noInvoiceWarranty: input.noInvoiceWarranty === true, ...(input.declaredPurchaseDate ? { declaredPurchaseDate: input.declaredPurchaseDate } : {}) };
}

@Injectable()
export class WarrantyService {
  constructor(
    @Inject(MONGO_DATABASE) private readonly db: Db,
    private readonly idempotency: IdempotencyService,
    private readonly sequences: SequenceService,
    private readonly audit: AuditService,
    private readonly outbox: OutboxService,
    private readonly inventory: InventoryService,
    private readonly evidence: EvidenceIntakeService,
    private readonly faultCodes: WarrantyFaultCodesService,
    private readonly sales: SalesService,
    /** Sửa phí sửa của phiếu đã trả làm số tiền nhỏ hơn số đã thu → xếp lại tiền thu của khách (WAR-EDIT-01). */
    private readonly ledger: HistoryEditService,
  ) {}

  private collection() {
    return this.db.collection(WARRANTY_TICKETS);
  }

  /** Ảnh được thêm khi chi tiết phiếu tải lại (get); kết quả thao tác không kèm ảnh. */
  private async present(ticket: Document, now = new Date()) {
    const settings = await warrantySettings(this.db);
    const sla = ticketSla(ticket, settings, now);
    return {
      ...serializeDocument(ticket),
      sla: { ...sla, dueAt: sla.dueAt.toISOString(), warningAt: sla.warningAt.toISOString() },
      editRequests: [...((ticket.editRequests as Document[] | undefined) ?? [])].reverse().map((row) => this.editRequestView(row, now)),
    };
  }

  async settings() {
    return warrantySettings(this.db);
  }

  async list(
    filter: { status?: string | undefined; tone?: string | undefined; search?: string | undefined; customerId?: string | undefined; from?: string | undefined; to?: string | undefined; editRequest?: string | undefined },
    paging: PageRequest | null = null,
    viewer?: Viewer,
  ) {
    // Lọc theo ngày nhận phiếu (LIST-DATE-01) ngay trong truy vấn để khoảng ngày cũ vẫn ra đủ (không bị giới hạn 500 phiếu mới nhất).
    const own: Filter<Document> = dateRangeFilter('receivedAt', filter.from, filter.to);
    if (filter.status) own.status = filter.status;
    // Phiếu có yêu cầu sửa chờ duyệt (WAR-EDIT-01).
    if (filter.editRequest === 'PENDING') own['editRequests.status'] = 'PENDING';
    // Tab Bảo hành trên hồ sơ khách hàng.
    if (filter.customerId) own['customer.partnerId'] = toObjectId(filter.customerId, 'customerId');
    if (filter.search) {
      const pattern = new RegExp(filter.search.replace(ESCAPE, '\\$&'), 'i');
      own.$or = [{ code: pattern }, { legacyCode: pattern }, { originalCode: pattern }, { 'customer.name': pattern }, { 'customer.phone': pattern }, { 'product.sku': pattern }, { 'product.name': pattern }, { 'invoice.number': pattern }];
    }
    // Phiếu đã hủy chỉ quản trị gốc thấy (DOC-HIDE-01) — cả trong số đếm "đã đóng".
    const query = hideStatus(own, viewer);
    const settings = await warrantySettings(this.db);
    const now = new Date();
    const rows = (await this.collection().find(query).sort({ receivedAt: -1 }).limit(500).toArray()).map((ticket) => {
      const sla = ticketSla(ticket, settings, now);
      return { ticket, sla };
    });
    const counts = { overdue: 0, warning: 0, normal: 0, closed: 0 };
    for (const row of rows) counts[row.sla.tone] += 1;
    const order = { overdue: 0, warning: 1, normal: 2, closed: 3 };
    const shown = rows
      .filter((row) => !filter.tone || row.sla.tone === filter.tone)
      // Theo luồng màu: quá hạn → cảnh báo → trong hạn → đã đóng; trong mỗi nhóm số phiếu mới nhất trước, như danh sách phiếu BH
      // (09/11/2026 — người dùng: danh sách lộn xộn). Phiếu hủy (…-H1) cùng nhóm đã đóng, xếp theo số gốc.
      .sort((a, b) => order[a.sla.tone] - order[b.sla.tone] || String(b.ticket.originalCode ?? b.ticket.code).localeCompare(String(a.ticket.originalCode ?? a.ticket.code), 'en', { numeric: true }) || String(b.ticket.code).localeCompare(String(a.ticket.code)));
    const present = shown.map(({ ticket, sla }) => ({ ...serializeDocument(ticket), sla: { ...sla, dueAt: sla.dueAt.toISOString(), warningAt: sla.warningAt.toISOString() } }));
    if (paging) return slicePage(present, paging, { settings, counts });
    return { settings, counts, rows: present };
  }

  async get(id: string, viewer?: Viewer) {
    const ticket = await this.collection().findOne({ _id: toObjectId(id) });
    if (!ticket || (ticket.status === 'CANCELLED' && !seesCancelled(viewer))) throw new NotFoundException({ code: 'WARRANTY_NOT_FOUND', message: 'Không tìm thấy phiếu bảo hành' });
    const photos = await this.db.collection('attachments')
      .find({ entityId: ticket._id, purpose: PHOTO_PURPOSE, status: 'LINKED' }, { projection: { data: 0 } })
      .sort({ uploadedAt: 1 })
      .toArray();
    return { ...(await this.present(ticket)), photos: photos.map((row) => ({ ...this.evidence.meta(row), kind: String(row.kind ?? 'OTHER') })) };
  }

  // ---------- Ảnh: tình trạng khi nhận, phiếu đã ký khi trả (S3 + quét mã độc như ảnh đối chiếu phiếu bán) ----------

  async uploadPhoto(id: string, body: unknown, fileNameHeader: string | undefined, kind: WarrantyPhotoKind, request: AuthenticatedRequest) {
    const ticket = await this.collection().findOne({ _id: toObjectId(id) }, { projection: { code: 1, status: 1 } });
    if (!ticket) throw new NotFoundException({ code: 'WARRANTY_NOT_FOUND', message: 'Không tìm thấy phiếu bảo hành' });
    if (ticket.status === 'CANCELLED') throw new ConflictException({ code: 'WARRANTY_ACTION_NOT_ALLOWED', message: 'Phiếu đã hủy, không đính kèm ảnh' });
    const document = await this.evidence.accept(body, fileNameHeader, {
      entityType: 'WarrantyTicket',
      entityId: ticket._id,
      code: String(ticket.code),
      purpose: PHOTO_PURPOSE,
      keyPrefix: 'warranty-photos',
      auditPrefix: 'WARRANTY_PHOTO',
      href: `/warranty/${id}`,
      fallbackName: `${kind === 'SIGNED_FORM' ? 'phieu-da-ky' : kind === 'RECEIPT' ? 'anh-khi-nhan' : 'anh'}-${String(ticket.code)}`,
      limit: MAX_WARRANTY_PHOTOS,
      countAll: true,
      status: 'LINKED',
      extra: { kind },
    }, request);
    return { ...this.evidence.meta(document), kind };
  }

  async readPhoto(id: string, photoId: string) {
    const attachment = await this.db.collection('attachments').findOne({ _id: toObjectId(photoId, 'photoId'), entityId: toObjectId(id), purpose: PHOTO_PURPOSE });
    if (!attachment) throw new NotFoundException({ code: 'ATTACHMENT_NOT_FOUND', message: 'Không tìm thấy ảnh' });
    return this.evidence.read(attachment);
  }

  /** Xóa ảnh chụp nhầm: người tải lên (hoặc quản trị) xóa được khi phiếu chưa trả khách; phiếu đã trả giữ nguyên làm chứng từ. */
  async deletePhoto(id: string, photoId: string, request: AuthenticatedRequest) {
    const ticket = await this.collection().findOne({ _id: toObjectId(id) }, { projection: { status: 1, code: 1 } });
    if (!ticket) throw new NotFoundException({ code: 'WARRANTY_NOT_FOUND', message: 'Không tìm thấy phiếu bảo hành' });
    if (ticket.status === 'RETURNED') throw new ConflictException({ code: 'WARRANTY_PHOTO_LOCKED', message: 'Phiếu đã trả khách: ảnh là chứng từ, không xóa được' });
    // SEC-UI-01 (06/11/2026): phiếu đã hủy cũng giữ nguyên ảnh (web không cho tải lên / xóa ảnh phiếu hủy).
    if (ticket.status === 'CANCELLED') throw new ConflictException({ code: 'WARRANTY_PHOTO_LOCKED', message: 'Phiếu đã hủy: không xóa được ảnh' });
    const filter = {
      _id: toObjectId(photoId, 'photoId'),
      entityId: ticket._id,
      purpose: PHOTO_PURPOSE,
      ...(request.user.roles.includes('ADMIN') ? {} : { uploadedBy: toObjectId(request.user.sub) }),
    };
    const attachment = await this.db.collection('attachments').findOne(filter, { projection: { storage: 1, fileName: 1 } });
    if (!attachment) throw new NotFoundException({ code: 'ATTACHMENT_NOT_FOUND', message: 'Ảnh không tồn tại hoặc do người khác tải lên' });
    await this.evidence.removeStored(attachment);
    await this.db.collection('attachments').deleteOne({ _id: attachment._id });
    await this.audit.record({
      actorId: request.user.sub, actorEmail: request.user.email, correlationId: request.correlationId,
      action: 'WARRANTY_PHOTO_DELETED', entityType: 'WarrantyTicket', entityId: id, metadata: { attachmentId: photoId, fileName: attachment.fileName },
    });
    return { id: photoId, deleted: true };
  }

  // ---------- Báo cáo ----------

  async report(from?: string, to?: string): Promise<WarrantyReport> {
    const now = new Date();
    const end = to && /^\d{4}-\d{2}$/.test(to) ? to : vnDate(now).slice(0, 7);
    const start = from && /^\d{4}-\d{2}$/.test(from) && from <= end ? from : shiftMonth(end, -5);
    const rangeStart = new Date(`${start}-01T00:00:00+07:00`);
    const rangeEnd = new Date(`${shiftMonth(end, 1)}-01T00:00:00+07:00`);
    const [tickets, settings, faultNames] = await Promise.all([
      this.collection().find({ $or: [{ receivedAt: { $gte: rangeStart, $lt: rangeEnd } }, { returnedAt: { $gte: rangeStart, $lt: rangeEnd } }] }).toArray(),
      warrantySettings(this.db),
      this.faultCodes.names(),
    ]);
    return buildWarrantyReport(tickets, { from: start, to: end, now, warningRatio: settings.warningRatio, faultNames });
  }

  // ---------- Trả khách: kho (đổi / hoàn) và công nợ (phí dịch vụ) ----------

  /**
   * Trả khách khi đổi mới / hoàn tiền (20/10/2026 — chống tính trùng với Phiếu trả hàng):
   * - Đổi mới: xuất 1 sản phẩm mới từ kho bán hàng (kiểm tra tồn khả dụng), trừ khi hàng đổi đã giao trước (`exchangeDelivered`).
   * - Sản phẩm lỗi khách trả KHÔNG nhập kho ở đây nữa: hàng lỗi chỉ vào kho qua Phiếu trả hàng → Hàng lỗi do sử dụng
   *   (trước đây phiếu bảo hành tự nhập 1 cái vào kho hàng lỗi → cùng một cái bị nhập 2 lần nếu đã lập phiếu trả hàng).
   *   Có số phiếu trả hàng (TH…) thì ghi liên kết để tra cứu.
   */
  private async moveStock(ticket: Document, resolution: WarrantyResolution, options: { exchangeDelivered: boolean; returnSlip: Document | null }, actorId: string, session: ClientSession, now: Date) {
    const reference = String(ticket.code);
    const product = ticket.product as { productId: ObjectId; sku: string };
    const productId = product.productId.toHexString();
    let exchange: Document | null = null;
    if (resolution === 'EXCHANGED' && !options.exchangeDelivered) {
      exchange = await this.db.collection('warehouses').findOne({ active: true, purpose: { $ne: 'DEFECTIVE' } }, { session, sort: { code: 1 } });
      if (!exchange) throw new ConflictException({ code: 'WAREHOUSE_NOT_FOUND', message: 'Không có kho bán hàng đang hoạt động để xuất hàng đổi' });
      try {
        await this.inventory.applyPhysicalMovement({
          warehouseId: (exchange._id as ObjectId).toHexString(), referenceType: 'WarrantyTicket', referenceId: reference,
          movementType: 'WARRANTY_EXCHANGE_OUT', direction: 'OUT', lines: [{ productId, quantity: '1' }],
          reason: `Xuất đổi sản phẩm mới cho khách — phiếu bảo hành ${reference}`, actorId,
        }, session);
      } catch (error) {
        if ((error as { response?: { code?: string } }).response?.code === 'INSUFFICIENT_AVAILABLE_STOCK') {
          throw new ConflictException({ code: 'WARRANTY_EXCHANGE_NO_STOCK', message: `${String(exchange.name)} không còn ${product.sku} khả dụng để đổi cho khách — nhập thêm hoặc chuyển kho trước khi trả` });
        }
        throw error;
      }
    }
    const place = (row: Document) => ({ warehouseCode: String(row.code), warehouseName: String(row.name) });
    const slip = options.returnSlip;
    return {
      ...(exchange ? { exchange: place(exchange) } : {}),
      ...(resolution === 'EXCHANGED' && options.exchangeDelivered ? { exchangeDelivered: true } : {}),
      ...(slip ? { returnSlip: { id: (slip._id as ObjectId).toHexString(), code: String(slip.code), warehouseName: String(slip.warehouseName), category: String(slip.category) } } : {}),
      reference,
      movedAt: now,
    };
  }

  /** Phiếu trả hàng (khách trả, chưa hủy) có chứa sản phẩm của phiếu bảo hành — để liên kết hàng lỗi đã nhập kho. */
  private async returnSlipFor(ticket: Document, code: string, session: ClientSession) {
    const slip = await this.db.collection('stock_returns').findOne({ $or: [{ code }, { legacyCode: code }], kind: 'CUSTOMER' }, { session });
    if (!slip || slip.status === 'VOIDED') {
      throw new BadRequestException({ code: 'WARRANTY_RETURN_SLIP_NOT_FOUND', message: `Không có phiếu khách trả ${code} (hoặc phiếu đã hủy)`, details: [{ path: ['returnSlipCode'] }] });
    }
    const product = ticket.product as { productId: ObjectId; sku: string };
    if (!(slip.lines as Document[]).some((line) => (line.productId as ObjectId).equals(product.productId))) {
      throw new BadRequestException({ code: 'WARRANTY_RETURN_SLIP_PRODUCT', message: `Phiếu ${code} không có mã ${product.sku}`, details: [{ path: ['returnSlipCode'] }] });
    }
    return slip;
  }

  /**
   * Gợi ý ô "Phiếu trả hàng đã nhập hàng lỗi" (05/11/2026, yêu cầu của người dùng — vừa gõ vừa chọn): phiếu khách trả chưa hủy
   * có mã sản phẩm của phiếu bảo hành. Phiếu của chính khách lên đầu, rồi phiếu hàng lỗi, rồi phiếu mới nhất; ghi kèm phiếu
   * bảo hành khác đã gắn phiếu đó (một phiếu trả có thể gồm nhiều cái nên vẫn chọn được).
   */
  async returnSlipOptions(id: string): Promise<WarrantyReturnSlipOption[]> {
    const ticket = await this.collection().findOne({ _id: toObjectId(id, 'id') }, { projection: { product: 1, customer: 1 } });
    if (!ticket) throw new NotFoundException({ code: 'WARRANTY_NOT_FOUND', message: 'Không tìm thấy phiếu bảo hành' });
    const productId = (ticket.product as { productId: ObjectId }).productId;
    const partnerId = (ticket.customer as { partnerId?: ObjectId }).partnerId;
    const slips = await this.db.collection('stock_returns').find(
      { kind: 'CUSTOMER', status: { $ne: 'VOIDED' }, 'lines.productId': productId },
      { sort: { postedAt: -1 }, limit: 80, projection: { code: 1, legacyCode: 1, partnerId: 1, partnerName: 1, warehouseName: 1, category: 1, receivedAt: 1, postedAt: 1, createdAt: 1, lines: 1 } },
    ).toArray();
    const codes = slips.map((slip) => String(slip.code));
    const linked = codes.length
      ? await this.collection().find({ _id: { $ne: ticket._id }, 'stock.returnSlip.code': { $in: codes } }, { projection: { code: 1, 'stock.returnSlip.code': 1 } }).toArray()
      : [];
    const ticketsBySlip = new Map<string, string[]>();
    for (const row of linked) {
      const slipCode = String((row.stock as { returnSlip: { code: string } }).returnSlip.code);
      ticketsBySlip.set(slipCode, [...(ticketsBySlip.get(slipCode) ?? []), String(row.code)]);
    }
    const rank = (slip: Document) => (partnerId && (slip.partnerId as ObjectId | undefined)?.equals(partnerId) ? 0 : 2) + (DEFECT_RETURN_CATEGORIES.includes(slip.category as CustomerReturnCategory) ? 0 : 1);
    return slips
      .map((slip, index) => ({ slip, index, rank: rank(slip) }))
      .sort((a, b) => a.rank - b.rank || a.index - b.index)
      .slice(0, 30)
      .map(({ slip }) => {
        const quantity = (slip.lines as Document[])
          .filter((line) => (line.productId as ObjectId).equals(productId))
          .reduce((sum, line) => sum.add(decimalString(line.quantity ?? '0')), new Decimal(0));
        return {
          code: String(slip.code),
          ...(slip.legacyCode ? { legacyCode: String(slip.legacyCode) } : {}),
          partnerName: String(slip.partnerName ?? ''),
          samePartner: Boolean(partnerId && (slip.partnerId as ObjectId | undefined)?.equals(partnerId)),
          category: String(slip.category ?? ''),
          warehouseName: String(slip.warehouseName ?? ''),
          date: ((slip.receivedAt ?? slip.postedAt ?? slip.createdAt) as Date).toISOString(),
          quantity: quantity.toString(),
          linkedTickets: ticketsBySlip.get(String(slip.code)) ?? [],
        };
      });
  }

  /** Phí sửa ngoài bảo hành khách đã đồng ý → khoản phải thu (đại lý theo số ngày nợ; khách vãng lai thu ngay, ghi vào hồ sơ khách lẻ). */
  private async billService(ticket: Document, amount: Decimal, session: ClientSession, now: Date) {
    const customer = ticket.customer as { partnerId?: ObjectId; name: string; phone?: string };
    const partner = customer.partnerId
      ? await this.db.collection('partners').findOne({ _id: customer.partnerId }, { session })
      : await this.db.collection('partners').findOne({ code: WALK_IN_PARTNER_CODE }, { session });
    if (!partner) {
      throw new ConflictException({ code: 'WALK_IN_PARTNER_MISSING', message: `Chưa có hồ sơ khách lẻ (mã ${WALK_IN_PARTNER_CODE}) để ghi công nợ phí dịch vụ — thêm ở Danh mục › Hồ sơ đại lý & khách hàng` });
    }
    const dueDate = new Date(now);
    if (customer.partnerId) dueDate.setUTCDate(dueDate.getUTCDate() + Number(partner.paymentTermDays ?? 0));
    const id = new ObjectId();
    const code = await this.sequences.next('AR', session);
    await this.db.collection('receivables').insertOne({
      _id: id,
      code,
      partnerId: partner._id,
      sourceType: 'WARRANTY_SERVICE',
      warrantyTicketId: ticket._id,
      warrantyCode: String(ticket.code),
      ...(customer.partnerId ? {} : { payerName: customer.name, ...(customer.phone ? { payerPhone: customer.phone } : {}) }),
      amount: decimal(amount.toFixed(2)),
      paidAmount: decimal('0'),
      dueDate,
      status: 'OPEN',
      createdAt: now,
      updatedAt: now,
      version: 1,
    }, { session });
    return { id, code, amount: decimal(amount.toFixed(2)), partnerCode: String(partner.code), partnerName: String(partner.name), dueDate };
  }

  async technicians() {
    const users = await this.db.collection('users').find({ status: 'ACTIVE', roles: 'WARRANTY' }).sort({ displayName: 1 }).toArray();
    return users.map((user) => ({ id: (user._id as ObjectId).toHexString(), displayName: String(user.displayName), email: String(user.email) }));
  }

  /**
   * Các lần bảo hành trước của cùng sản phẩm (cùng mã hàng + cùng số hóa đơn, vì sản phẩm chưa có serial):
   * số lần, tổng số ngày giữ máy (cộng vào thời hạn), và ngày đổi mới gần nhất (thời hạn tính lại từ đó).
   */
  private async priorServices(productId: ObjectId, invoiceNumber: string | undefined, session?: ClientSession, excludeId?: ObjectId): Promise<PriorServices> {
    if (!invoiceNumber) return { count: 0, extensionDays: 0 };
    const prior = await this.collection()
      .find(
        { 'product.productId': productId, 'invoice.number': invoiceNumber, status: 'RETURNED', coverage: 'IN_WARRANTY', ...(excludeId ? { _id: { $ne: excludeId } } : {}) },
        session ? { session } : {},
      )
      .sort({ returnedAt: 1 })
      .toArray();
    let restartedOn: string | undefined;
    let count = 0;
    let extensionDays = 0;
    for (const ticket of prior) {
      if ((ticket.result as Document | undefined)?.resolution === 'EXCHANGED') {
        restartedOn = vnDate(ticket.returnedAt as Date);
        count = 0;
        extensionDays = 0;
        continue;
      }
      count += 1;
      extensionDays += Number(ticket.serviceDays ?? 0);
    }
    return { count, extensionDays, ...(restartedOn ? { restartedOn } : {}) };
  }

  /** Xem trước diện bảo hành cho form tiếp nhận (cùng cách tính với lúc lưu phiếu). */
  async coveragePreview(input: { productId: string; invoiceNumber?: string | undefined; invoiceDate?: string | undefined; receivedDate: string; noInvoiceWarranty?: boolean | undefined; declaredPurchaseDate?: string | undefined }) {
    const settings = await warrantySettings(this.db);
    const prior = await this.priorServices(toObjectId(input.productId, 'productId'), input.invoiceNumber?.trim() || undefined);
    const coverage = coverageFor({
      invoiceDate: input.invoiceDate ? (prior.restartedOn ?? input.invoiceDate) : null,
      receivedDate: input.receivedDate,
      months: settings.warrantyMonths,
      extensionDays: prior.extensionDays,
      ...noInvoiceChoice(input),
    });
    return { ...coverage, months: settings.warrantyMonths, priorServiceCount: prior.count, extensionDays: prior.extensionDays, restartedOn: prior.restartedOn ?? null };
  }

  async create(input: CreateWarrantyTicket, request: AuthenticatedRequest, idempotencyKey: string | undefined) {
    return this.idempotency.execute(`warranty-create:${request.user.sub}`, idempotencyKey, input, async (session) => {
      const settings = await warrantySettings(this.db);
      const product = await this.db.collection('products').findOne({ _id: toObjectId(input.productId, 'productId') }, { session });
      if (!product) throw new NotFoundException({ code: 'PRODUCT_NOT_FOUND', message: 'Không tìm thấy sản phẩm' });
      const category = product.categoryId ? await this.db.collection('product_categories').findOne({ _id: product.categoryId as ObjectId }, { session }) : null;
      let partner: Document | null = null;
      if (input.customerId) {
        partner = await this.db.collection('partners').findOne({ _id: toObjectId(input.customerId, 'customerId'), kind: { $in: ['CUSTOMER', 'BOTH'] } }, { session });
        if (!partner) throw new NotFoundException({ code: 'CUSTOMER_NOT_FOUND', message: 'Không tìm thấy khách hàng' });
      }
      const technician = await this.resolveTechnician(input.technicianId, request.user, session);
      const invoiceNumber = input.invoiceNumber?.trim();
      const prior = await this.priorServices(product._id as ObjectId, invoiceNumber, session);
      const choice = noInvoiceChoice(input);
      const coverage = coverageFor({
        invoiceDate: input.invoiceDate ? (prior.restartedOn ?? input.invoiceDate) : null,
        receivedDate: input.receivedDate,
        months: settings.warrantyMonths,
        extensionDays: prior.extensionDays,
        ...choice,
      });
      const now = new Date();
      // SEC-UI-01 (06/11/2026): như khi sửa thông tin tiếp nhận — ngày tiếp nhận không sau hôm nay.
      if (input.receivedDate > vnDate(now)) throw new BadRequestException({ code: 'WARRANTY_DATE_INVALID', message: 'Ngày tiếp nhận không được sau hôm nay', details: [{ path: ['receivedDate'] }] });
      // Tiếp nhận hôm nay: giờ thực; nhập bù ngày trước: tính từ 08:00 ngày đó.
      const receivedAt = input.receivedDate === vnDate(now) ? now : new Date(`${input.receivedDate}T08:00:00+07:00`);
      const id = new ObjectId();
      const document: Document = {
        _id: id,
        code: await this.sequences.next('SC', session, receivedAt),
        status: 'RECEIVED',
        version: 1,
        channel: input.channel,
        customer: {
          ...(partner ? { partnerId: partner._id, code: String(partner.code) } : {}),
          name: input.customerName,
          ...(input.customerPhone ? { phone: input.customerPhone } : {}),
          ...(input.customerAddress ? { address: input.customerAddress } : {}),
        },
        product: {
          productId: product._id,
          sku: String(product.sku),
          name: String(product.name),
          ...(category ? { categoryName: String(category.name) } : {}),
          ...(input.serial ? { serial: input.serial } : {}),
        },
        ...(invoiceNumber && input.invoiceDate ? { invoice: { number: invoiceNumber, date: input.invoiceDate } } : {}),
        ...(coverage.invoiceless ? { invoicelessWarranty: true } : {}),
        ...(choice.declaredPurchaseDate ? { declaredPurchaseDate: choice.declaredPurchaseDate } : {}),
        coverage: coverage.coverage,
        ...(coverage.exclusion ? { exclusion: coverage.exclusion } : {}),
        warranty: {
          months: settings.warrantyMonths,
          ...(coverage.startsOn ? { startsOn: coverage.startsOn } : {}),
          ...(coverage.expiresOn ? { expiresOn: coverage.expiresOn } : {}),
          extensionDays: prior.extensionDays,
          priorServiceCount: prior.count,
        },
        receivedAt,
        receivedDate: input.receivedDate,
        promisedDate: input.promisedDate,
        originalPromisedDate: input.promisedDate,
        reschedules: [],
        receivedById: toObjectId(request.user.sub),
        receivedByName: request.user.displayName,
        ...(technician ? { technicianId: technician._id, technicianName: String(technician.displayName) } : {}),
        ...(input.accessories ? { accessories: input.accessories } : {}),
        ...(input.condition ? { condition: input.condition } : {}),
        ...(input.loaner ? { loaner: input.loaner } : {}),
        lines: [{ receivedDate: input.receivedDate, symptom: input.symptom }],
        history: [{
          at: now, byName: request.user.displayName, action: 'RECEIVE', to: 'RECEIVED',
          note: coverage.invoiceless ? `${input.symptom} · Bảo hành không hóa đơn — ${request.user.displayName} xác nhận` : input.symptom,
        }],
        createdAt: now,
        updatedAt: now,
      };
      await this.collection().insertOne(document, { session });
      await this.audit.record(
        { actorId: request.user.sub, actorEmail: request.user.email, correlationId: request.correlationId, action: 'WARRANTY_RECEIVED', entityType: 'WarrantyTicket', entityId: id.toHexString(), after: serializeDocument(document) },
        session,
      );
      return this.present(document, now);
    });
  }

  /**
   * Sửa thông tin tiếp nhận (20/10/2026 — "nhập sai thì sửa thế nào"): phiếu chưa trả / chưa hủy, ghi lý do và lịch sử (trường cũ → mới).
   * Sản phẩm, hóa đơn, ngày tiếp nhận quyết định diện bảo hành → chỉ đổi được khi phiếu còn ở bước Đã tiếp nhận (chưa chẩn đoán),
   * diện bảo hành / thời hạn tính lại như lúc tiếp nhận. Số phiếu giữ nguyên.
   */
  async updateIntake(id: string, input: UpdateWarrantyIntake, request: AuthenticatedRequest, idempotencyKey: string | undefined) {
    return this.idempotency.execute(`warranty-edit:${id}:${request.user.sub}`, idempotencyKey, input, async (session) => {
      const ticketId = toObjectId(id);
      const ticket = await this.collection().findOne({ _id: ticketId }, { session });
      if (!ticket) throw new NotFoundException({ code: 'WARRANTY_NOT_FOUND', message: 'Không tìm thấy phiếu bảo hành' });
      if (ticket.version !== input.version) throw new ConflictException({ code: 'VERSION_CONFLICT', message: 'Phiếu bảo hành đã được người khác cập nhật, vui lòng tải lại' });
      const status = ticket.status as WarrantyStatus;
      const now = new Date();
      // WAR-EDIT-01 (06/11/2026): yêu cầu sửa giai đoạn Tiếp nhận đã được duyệt (hoặc Quản lý kho / Admin) mở khóa phiếu đã trả khách
      // và các trường quyết định diện bảo hành sau khi đã chẩn đoán.
      const grantId = input.requestId ? this.stageGrant(ticket, 'INTAKE', input.requestId, request.user, now) : null;
      const unlocked = Boolean(grantId) || this.isWarrantyApprover(request.user);
      if (status === 'CANCELLED' || (status === 'RETURNED' && !unlocked)) {
        throw new ConflictException({
          code: 'WARRANTY_EDIT_CLOSED',
          message: status === 'CANCELLED' ? 'Phiếu đã hủy, không sửa được' : 'Phiếu đã trả khách — gửi "Yêu cầu sửa phiếu" (giai đoạn Tiếp nhận) để được duyệt sửa',
        });
      }
      if (input.receivedDate > vnDate(now)) throw new BadRequestException({ code: 'WARRANTY_DATE_INVALID', message: 'Ngày tiếp nhận không được sau hôm nay', details: [{ path: ['receivedDate'] }] });
      if (String(ticket.promisedDate) < input.receivedDate) {
        throw new BadRequestException({ code: 'WARRANTY_DATE_INVALID', message: 'Ngày tiếp nhận sau ngày hẹn trả — dời hẹn trả trước', details: [{ path: ['receivedDate'] }] });
      }
      const product = await this.db.collection('products').findOne({ _id: toObjectId(input.productId, 'productId') }, { session });
      if (!product) throw new NotFoundException({ code: 'PRODUCT_NOT_FOUND', message: 'Không tìm thấy sản phẩm' });
      let partner: Document | null = null;
      if (input.customerId) {
        partner = await this.db.collection('partners').findOne({ _id: toObjectId(input.customerId, 'customerId'), kind: { $in: ['CUSTOMER', 'BOTH'] } }, { session });
        if (!partner) throw new NotFoundException({ code: 'CUSTOMER_NOT_FOUND', message: 'Không tìm thấy khách hàng' });
      }
      const invoiceNumber = input.invoiceNumber?.trim() || undefined;
      const oldProduct = ticket.product as Document;
      const oldInvoice = ticket.invoice as { number: string; date: string } | undefined;
      const choice = noInvoiceChoice(input);
      const coverageChanged = !(oldProduct.productId as ObjectId).equals(product._id as ObjectId)
        || (oldInvoice?.number ?? '') !== (invoiceNumber ?? '')
        || (oldInvoice?.date ?? '') !== (input.invoiceDate ?? '')
        || Boolean(ticket.invoicelessWarranty) !== choice.noInvoiceWarranty
        || String(ticket.declaredPurchaseDate ?? '') !== (choice.declaredPurchaseDate ?? '')
        || String(ticket.receivedDate) !== input.receivedDate;
      if (coverageChanged && status !== 'RECEIVED' && !unlocked) {
        throw new ConflictException({
          code: 'WARRANTY_EDIT_AFTER_DIAGNOSE',
          message: 'Phiếu đã chẩn đoán: đổi sản phẩm / hóa đơn / bảo hành không hóa đơn / ngày tiếp nhận cần gửi "Yêu cầu sửa phiếu" (giai đoạn Tiếp nhận) và được duyệt',
        });
      }
      const technician = input.technicianId ? await this.resolveTechnician(input.technicianId, request.user, session) : null;

      const set: Document = { updatedAt: now };
      const unset: Document = {};
      const changes: string[] = [];
      const text = (value: unknown) => (value === undefined || value === null || value === '' ? '—' : String(value));
      const change = (label: string, from: unknown, to: unknown) => {
        if (text(from) !== text(to)) changes.push(`${label}: ${text(from)} → ${text(to)}`);
      };
      const optionalField = (path: string, value: string | undefined) => {
        if (value) set[path] = value;
        else unset[path] = '';
      };
      const oldCustomer = ticket.customer as Document;
      change('Kênh', ticket.channel, input.channel);
      change('Khách hàng', `${oldCustomer.code ? `${String(oldCustomer.code)} ` : ''}${String(oldCustomer.name)}`, `${partner ? `${String(partner.code)} ` : ''}${input.customerName}`);
      change('Điện thoại', oldCustomer.phone, input.customerPhone);
      change('Địa chỉ', oldCustomer.address, input.customerAddress);
      set.channel = input.channel;
      set.customer = {
        ...(partner ? { partnerId: partner._id, code: String(partner.code) } : {}),
        name: input.customerName,
        ...(input.customerPhone ? { phone: input.customerPhone } : {}),
        ...(input.customerAddress ? { address: input.customerAddress } : {}),
      };
      change('Sản phẩm', oldProduct.sku, product.sku);
      change('Serial', oldProduct.serial, input.serial);
      if (coverageChanged || text(oldProduct.serial) !== text(input.serial)) {
        const category = product.categoryId ? await this.db.collection('product_categories').findOne({ _id: product.categoryId as ObjectId }, { session }) : null;
        set.product = {
          productId: product._id,
          sku: String(product.sku),
          name: String(product.name),
          ...(category ? { categoryName: String(category.name) } : {}),
          ...(input.serial ? { serial: input.serial } : {}),
        };
      }
      change('Hóa đơn', oldInvoice ? `${oldInvoice.number} · ${oldInvoice.date}` : '', invoiceNumber && input.invoiceDate ? `${invoiceNumber} · ${input.invoiceDate}` : '');
      if (!oldInvoice || !input.invoiceDate) {
        const noInvoiceLabel = (warranty: boolean) => (warranty ? 'Vẫn bảo hành' : 'Sửa có tính phí');
        change('Không hóa đơn', oldInvoice ? '' : noInvoiceLabel(Boolean(ticket.invoicelessWarranty)), input.invoiceDate ? '' : noInvoiceLabel(choice.noInvoiceWarranty));
        change('Ngày mua khách khai', ticket.declaredPurchaseDate, choice.declaredPurchaseDate);
      }
      change('Ngày tiếp nhận', ticket.receivedDate, input.receivedDate);
      if (coverageChanged) {
        const settings = await warrantySettings(this.db);
        const prior = await this.priorServices(product._id as ObjectId, invoiceNumber, session, ticketId);
        const coverage = coverageFor({ invoiceDate: input.invoiceDate ? (prior.restartedOn ?? input.invoiceDate) : null, receivedDate: input.receivedDate, months: settings.warrantyMonths, extensionDays: prior.extensionDays, ...choice });
        // Lý do sửa chữa ghi lúc chẩn đoán (khác "không hóa đơn") giữ nguyên: phiếu vẫn không thuộc diện bảo hành.
        const diagnosedExclusion = ticket.plan && ticket.exclusion && ticket.exclusion !== 'NO_INVOICE';
        const nextCoverage = diagnosedExclusion ? 'NOT_COVERED' : coverage.coverage;
        change('Diện bảo hành', ticket.coverage, nextCoverage);
        set.coverage = nextCoverage;
        if (!diagnosedExclusion) {
          if (coverage.exclusion) set.exclusion = coverage.exclusion;
          else unset.exclusion = '';
        }
        if (coverage.invoiceless) set.invoicelessWarranty = true;
        else unset.invoicelessWarranty = '';
        if (choice.declaredPurchaseDate) set.declaredPurchaseDate = choice.declaredPurchaseDate;
        else unset.declaredPurchaseDate = '';
        set.warranty = {
          months: settings.warrantyMonths,
          ...(coverage.startsOn ? { startsOn: coverage.startsOn } : {}),
          ...(coverage.expiresOn ? { expiresOn: coverage.expiresOn } : {}),
          extensionDays: prior.extensionDays,
          priorServiceCount: prior.count,
        };
        if (invoiceNumber && input.invoiceDate) set.invoice = { number: invoiceNumber, date: input.invoiceDate };
        else unset.invoice = '';
        if (String(ticket.receivedDate) !== input.receivedDate) {
          set.receivedDate = input.receivedDate;
          set.receivedAt = input.receivedDate === vnDate(now) ? now : new Date(`${input.receivedDate}T08:00:00+07:00`);
          set['lines.0.receivedDate'] = input.receivedDate;
          // Phiếu đã trả khách: số ngày xử lý tính lại theo ngày tiếp nhận mới.
          if (ticket.returnedAt instanceof Date) set.serviceDays = serviceDays(set.receivedAt as Date, ticket.returnedAt);
        }
      }
      change('Kỹ thuật', ticket.technicianName, technician ? technician.displayName : ticket.technicianName);
      if (technician) {
        set.technicianId = technician._id;
        set.technicianName = String(technician.displayName);
      }
      change('Phụ kiện', ticket.accessories, input.accessories);
      change('Tình trạng', ticket.condition, input.condition);
      change('Máy cho mượn', ticket.loaner, input.loaner);
      optionalField('accessories', input.accessories);
      optionalField('condition', input.condition);
      optionalField('loaner', input.loaner);
      const firstLine = (ticket.lines as Document[])[0];
      change('Hiện tượng', firstLine?.symptom, input.symptom);
      set['lines.0.symptom'] = input.symptom;
      if (!changes.length) throw new BadRequestException({ code: 'WARRANTY_UNCHANGED', message: 'Phiếu chưa có thay đổi nào' });
      for (const key of Object.keys(set)) delete unset[key];
      if (grantId) {
        set['editRequests.$[grant].status'] = 'APPLIED';
        set['editRequests.$[grant].appliedAt'] = now;
      }

      const history = { at: now, byName: request.user.displayName, action: 'EDIT', from: status, to: status, note: `${input.reason}${grantId ? ' (yêu cầu đã duyệt)' : ''} — ${changes.join('; ')}` };
      const result = await this.collection().findOneAndUpdate(
        { _id: ticketId, version: input.version },
        { $set: set, ...(Object.keys(unset).length ? { $unset: unset } : {}), $inc: { version: 1 }, $push: { history } } as Document,
        { session, returnDocument: 'after', ...(grantId ? { arrayFilters: [{ 'grant.id': grantId }] } : {}) },
      );
      if (!result) throw new ConflictException({ code: 'VERSION_CONFLICT', message: 'Phiếu bảo hành đã được người khác cập nhật, vui lòng tải lại' });
      await this.audit.record(
        {
          actorId: request.user.sub, actorEmail: request.user.email, correlationId: request.correlationId, action: 'WARRANTY_EDITED',
          entityType: 'WarrantyTicket', entityId: id, before: serializeDocument(ticket), after: serializeDocument(result), metadata: { reason: input.reason, changes },
        },
        session,
      );
      return this.present(result, now);
    });
  }

  private async resolveTechnician(technicianId: string | undefined, user: RequestUser, session: ClientSession) {
    if (technicianId) {
      const technician = await this.db.collection('users').findOne({ _id: toObjectId(technicianId, 'technicianId'), status: 'ACTIVE', roles: 'WARRANTY' }, { session });
      if (!technician) throw new BadRequestException({ code: 'TECHNICIAN_NOT_FOUND', message: 'Kỹ thuật được chọn không phải nhân viên bảo hành' });
      return technician;
    }
    if (!user.roles.includes('WARRANTY')) return null;
    return this.db.collection('users').findOne({ _id: toObjectId(user.sub) }, { session });
  }

  async act(id: string, action: WarrantyAction, request: AuthenticatedRequest, idempotencyKey: string | undefined) {
    return this.idempotency.execute(`warranty-action:${id}:${request.user.sub}`, idempotencyKey, action, async (session) => {
      const ticketId = toObjectId(id);
      const ticket = await this.collection().findOne({ _id: ticketId }, { session });
      if (!ticket) throw new NotFoundException({ code: 'WARRANTY_NOT_FOUND', message: 'Không tìm thấy phiếu bảo hành' });
      if (ticket.version !== action.version) {
        throw new ConflictException({ code: 'VERSION_CONFLICT', message: 'Phiếu bảo hành đã được người khác cập nhật, vui lòng tải lại' });
      }
      const status = ticket.status as WarrantyStatus;
      if (!WARRANTY_ACTIONS_BY_STATUS[status].includes(action.type)) {
        throw new ConflictException({ code: 'WARRANTY_ACTION_NOT_ALLOWED', message: `Phiếu đang ở bước ${status}, không thực hiện được thao tác này` });
      }
      const allowedRoles = action.type === 'APPROVE' ? WARRANTY_APPROVER_ROLES : WARRANTY_STAFF_ROLES;
      if (!request.user.roles.some((role) => allowedRoles.includes(role))) {
        throw new ForbiddenException({
          code: action.type === 'APPROVE' ? 'WARRANTY_APPROVER_ONLY' : 'WARRANTY_STAFF_ONLY',
          message: action.type === 'APPROVE' ? 'Chỉ Quản lý kho được duyệt từ chối / đổi mới / hoàn tiền' : 'Chỉ nhân viên bảo hành / Quản lý kho được cập nhật phiếu',
        });
      }

      const now = new Date();
      const set: Document = { updatedAt: now };
      let next: WarrantyStatus = status;
      let historyNote = action.note;
      const notifications: Array<{ roles: string[]; template: NotificationTemplate; params: TextParams; title: string; message: string; level: string }> = [];
      const code = String(ticket.code);
      const customer = String((ticket.customer as Document).name);
      const product = String((ticket.product as Document).sku);

      switch (action.type) {
        case 'DIAGNOSE': {
          await this.faultCodes.assertKnown(action.lines.map((line) => line.faultCode ?? ''));
          let coverage = ticket.coverage as WarrantyCoverage;
          if (action.exclusion) {
            coverage = 'NOT_COVERED';
            set.exclusion = action.exclusion;
          }
          // Sửa chữa bảo hành miễn phí chọn được ở mọi diện / lý do sửa chữa (05/11/2026 — plansForCoverage).
          const plan = action.plan;
          if ((plan === 'EXCHANGE' || plan === 'REFUND') && coverage !== 'IN_WARRANTY') {
            throw new BadRequestException({ code: 'WARRANTY_PLAN_INVALID', message: 'Chỉ đổi mới / hoàn tiền cho sản phẩm còn bảo hành' });
          }
          if (plan === 'REJECT' && coverage !== 'NOT_COVERED') {
            throw new BadRequestException({ code: 'WARRANTY_PLAN_INVALID', message: 'Từ chối bảo hành phải chọn lý do không thuộc diện bảo hành' });
          }
          if (plan === 'QUOTE') {
            if (coverage === 'IN_WARRANTY') throw new BadRequestException({ code: 'WARRANTY_PLAN_INVALID', message: 'Sản phẩm còn bảo hành được sửa miễn phí, không lập báo giá' });
            if (!action.quoteAmount || new Decimal(action.quoteAmount).lte(0)) throw new BadRequestException({ code: 'WARRANTY_QUOTE_REQUIRED', message: 'Nhập chi phí báo giá cho khách' });
            set.quoteAmount = decimal(action.quoteAmount);
          }
          set.coverage = coverage;
          set.lines = action.lines;
          set.plan = plan;
          if (plan === 'REPAIR') next = 'REPAIRING';
          else if (plan === 'QUOTE') next = 'QUOTE_PENDING';
          else {
            next = 'PENDING_APPROVAL';
            set.approval = { proposal: plan, requestedAt: now, requestedByName: request.user.displayName, ...(action.note ? { note: action.note } : {}) };
            notifications.push({
              roles: ['WAREHOUSE_MANAGER'],
              level: 'WARNING',
              template: 'WARRANTY_APPROVAL_REQUESTED',
              params: { code, customer, product, proposal: plan },
              title: `Phiếu bảo hành ${code} chờ Quản lý kho duyệt`,
              message: `${customer} — ${product}: đề nghị ${plan === 'REJECT' ? 'từ chối bảo hành' : plan === 'EXCHANGE' ? 'đổi sản phẩm mới' : 'hoàn tiền'}.`,
            });
          }
          break;
        }
        case 'QUOTE_DECISION':
          set.quoteAccepted = action.accepted;
          if (action.accepted) next = 'REPAIRING';
          else {
            next = 'READY';
            set.result = { resolution: 'RETURNED_UNREPAIRED', cost: decimal('0'), chargedTo: 'CUSTOMER', completedAt: now, ...(action.note ? { note: action.note } : {}) };
          }
          historyNote = action.note ?? (action.accepted ? 'Khách đồng ý báo giá' : 'Khách không đồng ý báo giá');
          break;
        case 'APPROVE': {
          const approval = ticket.approval as Document;
          const proposal = approval.proposal as keyof typeof RESOLUTION_BY_PROPOSAL;
          set.approval = { ...approval, decidedAt: now, decidedByName: request.user.displayName, approved: action.approved, ...(action.note ? { note: action.note } : {}) };
          if (action.approved) {
            next = 'READY';
            set.result = { resolution: RESOLUTION_BY_PROPOSAL[proposal], cost: decimal('0'), chargedTo: proposal === 'REJECT' ? 'CUSTOMER' : 'COMPANY', completedAt: now };
          } else {
            next = 'RECEIVED';
          }
          notifications.push({
            roles: ['WARRANTY'],
            level: 'INFO',
            template: 'WARRANTY_APPROVAL_DECIDED',
            params: { code, customer, product, approved: action.approved ? 'yes' : 'no' },
            title: `Đề nghị trên phiếu ${code} ${action.approved ? 'đã được duyệt' : 'không được duyệt'}`,
            message: action.note ?? `${customer} — ${product}`,
          });
          break;
        }
        case 'WAIT_PARTS':
          next = 'WAITING_PARTS';
          break;
        case 'PARTS_ARRIVED':
          next = 'REPAIRING';
          break;
        case 'REPAIR_DONE':
          next = 'TESTING';
          set.result = {
            resolution: action.resolution,
            ...(action.replacedParts ? { replacedParts: action.replacedParts } : {}),
            cost: decimal(action.cost),
            // Sửa theo hướng "sửa chữa bảo hành (miễn phí)" thì công ty chịu, kể cả máy hết hạn / có lý do sửa chữa (05/11/2026);
            // sửa theo báo giá khách đồng ý thì khách trả. Phiếu cũ chưa lưu hướng xử lý: theo diện bảo hành.
            chargedTo: (ticket.plan ? ticket.plan === 'REPAIR' : ticket.coverage === 'IN_WARRANTY') ? 'COMPANY' : 'CUSTOMER',
            completedAt: now,
            ...(action.note ? { note: action.note } : {}),
          };
          break;
        case 'TEST': {
          const passed = action.functional && action.safety && action.performance;
          set.test = { functional: action.functional, safety: action.safety, performance: action.performance, testedAt: now, testedByName: request.user.displayName, ...(action.note ? { note: action.note } : {}) };
          next = passed ? 'READY' : 'REPAIRING';
          historyNote = action.note ?? (passed ? 'Đạt chức năng, an toàn, hiệu suất' : 'Chưa đạt kiểm tra sau sửa — sửa lại');
          break;
        }
        case 'RESCHEDULE':
          if (action.promisedDate < String(ticket.receivedDate)) {
            throw new BadRequestException({ code: 'WARRANTY_DATE_INVALID', message: 'Ngày hẹn trả phải từ ngày tiếp nhận trở đi' });
          }
          if (action.promisedDate === ticket.promisedDate) {
            throw new BadRequestException({ code: 'WARRANTY_DATE_INVALID', message: 'Ngày hẹn mới trùng ngày hẹn hiện tại' });
          }
          set.promisedDate = action.promisedDate;
          historyNote = `${String(ticket.promisedDate)} → ${action.promisedDate}: ${action.reason}`;
          break;
        case 'RETURN': {
          next = 'RETURNED';
          set.returnedAt = now;
          set.returnedTo = action.receiverName;
          set.serviceDays = serviceDays(ticket.receivedAt as Date, now);
          const result = ticket.result as { resolution?: WarrantyResolution; cost?: unknown; chargedTo?: string } | undefined;
          const resolution = result?.resolution;
          if (resolution === 'REFUNDED') {
            if (!action.refundAmount || new Decimal(action.refundAmount).lte(0)) {
              throw new BadRequestException({ code: 'WARRANTY_REFUND_REQUIRED', message: 'Nhập số tiền hoàn lại cho khách' });
            }
            set.refund = { amount: decimal(action.refundAmount) };
            set['result.cost'] = decimal(action.refundAmount);
          }
          const returnsDefect = Boolean(resolution && RESOLUTIONS_RETURNING_DEFECT.includes(resolution));
          if (!returnsDefect && (action.returnSlipCode || action.exchangeDelivered)) {
            throw new BadRequestException({ code: 'WARRANTY_RETURN_OPTION_INVALID', message: 'Chỉ ghi phiếu trả hàng / hàng đổi đã giao khi kết quả là đổi mới hoặc hoàn tiền' });
          }
          // Người phụ trách phiếu BH đổi bảo hành (STAFF-PICK-01): chỉ khi hệ thống xuất hàng đổi và lập phiếu.
          if ((action.salesRepId || action.staffUserId) && (resolution !== 'EXCHANGED' || action.exchangeDelivered)) {
            throw new BadRequestException({ code: 'WARRANTY_RETURN_OPTION_INVALID', message: 'Chỉ chọn người phụ trách khi đổi mới và hệ thống xuất hàng đổi (lập phiếu BH đổi bảo hành)' });
          }
          const staff = await resolveStaff(this.db, { salesRepId: action.salesRepId, staffUserId: action.staffUserId }, session);
          if (resolution && returnsDefect) {
            const returnSlip = action.returnSlipCode ? await this.returnSlipFor(ticket, action.returnSlipCode, session) : null;
            const stock = await this.moveStock(ticket, resolution, { exchangeDelivered: resolution === 'EXCHANGED' && Boolean(action.exchangeDelivered), returnSlip }, request.user.sub, session, now);
            set.stock = stock;
            if (stock.exchange) {
              // Hệ thống xuất 1 sản phẩm mới đổi cho khách → lập phiếu BH & SWK đổi bảo hành để in đưa thủ kho (02/11/2026).
              const order = await this.issueExchangeOrderIn(ticket, stock.exchange.warehouseCode, now, action.receiverName, staff, request, session);
              set.exchangeOrder = order;
              historyNote = `${action.note ? `${action.note} · ` : ''}Phiếu BH ${order.code} · SWK ${order.warehouseSlipNo} (đổi bảo hành)`;
            }
            if (resolution === 'EXCHANGED') {
              // Chi phí đổi mới = giá vốn tham chiếu của sản phẩm mới.
              const product = await this.db.collection('products').findOne({ _id: (ticket.product as { productId: ObjectId }).productId }, { session, projection: { standardCost: 1 } });
              set['result.cost'] = decimal(decimalString(product?.standardCost ?? '0'));
            }
            if (stock.exchange || !stock.returnSlip) {
              const exchangeName = stock.exchange?.warehouseName ?? '';
              notifications.push({
                roles: ['WAREHOUSE_MANAGER', 'WAREHOUSE'],
                level: 'INFO',
                template: 'WARRANTY_STOCK_MOVED',
                params: { code, customer, product, resolution, exchange: exchangeName, defect: '', returnSlip: stock.returnSlip?.code ?? '' },
                title: exchangeName ? `Bảo hành ${code}: xuất 1 ${product} từ ${exchangeName} đổi cho khách` : `Bảo hành ${code}: ${resolution === 'EXCHANGED' ? 'đổi mới (hàng đổi đã giao trước)' : 'hoàn tiền cho khách'}`,
                message: stock.returnSlip
                  ? `${customer} — ${product}: hàng lỗi đã nhập kho theo phiếu ${stock.returnSlip.code}`
                  : `${customer} — ${product}: hàng lỗi khách trả nhập kho qua Phiếu trả hàng → Hàng lỗi do sử dụng (nếu chưa lập)`,
              });
            }
          }
          const charge = new Decimal(decimalString(result?.cost ?? '0'));
          if (result?.chargedTo === 'CUSTOMER' && charge.gt(0) && resolution !== 'REJECTED') {
            const receivable = await this.billService(ticket, charge, session, now);
            set.receivable = receivable;
            notifications.push({
              roles: ['ACCOUNTANT'],
              level: 'INFO',
              template: 'WARRANTY_SERVICE_BILLED',
              params: { code, customer, amount: charge.toFixed(0), receivable: receivable.code },
              title: `Phí dịch vụ bảo hành ${code}: ${charge.toFixed(0)} đ — đã ghi công nợ ${receivable.code}`,
              message: `${customer} — ${product}`,
            });
          }
          break;
        }
        case 'CANCEL':
          next = 'CANCELLED';
          set.cancelReason = action.reason;
          historyNote = action.reason;
          break;
      }

      set.status = next;
      const history = { at: now, byName: request.user.displayName, action: action.type, from: status, to: next, ...(historyNote ? { note: historyNote } : {}) };
      const update: Document = { $set: set, $inc: { version: 1 }, $push: { history } };
      if (action.type === 'RESCHEDULE') {
        update.$push = { history, reschedules: { from: ticket.promisedDate, to: action.promisedDate, reason: action.reason, at: now, byName: request.user.displayName } };
        update.$unset = { slaNotified: '' };
      }
      const saved = await this.collection().findOneAndUpdate({ _id: ticketId, version: action.version }, update, { session, returnDocument: 'after' });
      if (!saved) throw new ConflictException({ code: 'VERSION_CONFLICT', message: 'Phiếu bảo hành đã được người khác cập nhật, vui lòng tải lại' });
      // NUM-02: phiếu bảo hành hủy nhả số (SC… → SC…-H1), phiếu mới lấy lại số.
      const result = action.type === 'CANCEL' ? ((await releaseDocumentNumber(this.db, 'SC', saved, session)) ?? saved) : saved;

      for (const notification of notifications) {
        await this.outbox.enqueue(
          {
            eventType: 'NOTIFICATION_REQUESTED',
            aggregateType: 'WarrantyTicket',
            aggregateId: id,
            payload: { category: 'WARRANTY', targetRoles: notification.roles, level: notification.level, title: notification.title, message: notification.message, href: `/warranty/${id}`, template: notification.template, params: notification.params },
          },
          session,
        );
      }
      await this.audit.record(
        {
          actorId: request.user.sub,
          actorEmail: request.user.email,
          correlationId: request.correlationId,
          action: `WARRANTY_${action.type}`,
          entityType: 'WarrantyTicket',
          entityId: id,
          before: { status, version: action.version },
          after: { status: next, version: action.version + 1 },
          metadata: { note: historyNote ?? null },
        },
        session,
      );
      return this.present(result, now);
    });
  }

  /** Lập phiếu BH & SWK đổi bảo hành cho phiếu bảo hành (kho xuất hàng đổi = kho đã ghi trên phiếu bảo hành). */
  private async issueExchangeOrderIn(ticket: Document, warehouseCode: string, at: Date, receiverName: string | undefined, staff: PickedStaff | null, request: AuthenticatedRequest, session: ClientSession) {
    const warehouse = await this.db.collection('warehouses').findOne({ code: warehouseCode }, { session });
    if (!warehouse) throw new ConflictException({ code: 'WAREHOUSE_NOT_FOUND', message: `Không tìm thấy kho ${warehouseCode} đã xuất hàng đổi` });
    const order = await this.sales.issueWarrantyExchange({ ticket, warehouse, at, ...(receiverName ? { receiverName } : {}), staff }, request, session);
    return { id: order.id, code: order.code, warehouseSlipNo: order.warehouseSlipNo };
  }

  /**
   * Phiếu đổi mới đã trả khách trước khi có phiếu BH đổi bảo hành (trước 02/11/2026): lập phiếu BH & SWK để in đưa thủ kho.
   * Chỉ khi hệ thống đã xuất hàng đổi từ kho (không áp dụng cho "hàng đổi đã giao trước") và phiếu chưa có phiếu BH đổi.
   */
  async issueExchangeOrder(id: string, input: WarrantyExchangeOrder, request: AuthenticatedRequest, idempotencyKey: string | undefined) {
    const { version } = input;
    return this.idempotency.execute(`warranty-exchange-order:${id}`, idempotencyKey, input, async (session) => {
      const ticketId = toObjectId(id);
      const ticket = await this.collection().findOne({ _id: ticketId }, { session });
      if (!ticket) throw new NotFoundException({ code: 'WARRANTY_NOT_FOUND', message: 'Không tìm thấy phiếu bảo hành' });
      if (ticket.version !== version) throw new ConflictException({ code: 'VERSION_CONFLICT', message: 'Phiếu bảo hành đã được người khác cập nhật, vui lòng tải lại' });
      if (!request.user.roles.some((role) => WARRANTY_STAFF_ROLES.includes(role))) {
        throw new ForbiddenException({ code: 'WARRANTY_STAFF_ONLY', message: 'Chỉ nhân viên bảo hành / Quản lý kho được cập nhật phiếu' });
      }
      const exchange = (ticket.stock as { exchange?: { warehouseCode: string } } | undefined)?.exchange;
      if (ticket.status !== 'RETURNED' || (ticket.result as { resolution?: string } | undefined)?.resolution !== 'EXCHANGED' || !exchange) {
        throw new ConflictException({ code: 'WARRANTY_EXCHANGE_ORDER_NOT_ALLOWED', message: 'Chỉ lập phiếu BH & SWK cho phiếu đổi mới đã trả khách, hệ thống đã xuất hàng đổi từ kho' });
      }
      if (ticket.exchangeOrder) {
        throw new ConflictException({ code: 'WARRANTY_EXCHANGE_ORDER_EXISTS', message: `Phiếu bảo hành đã có phiếu BH ${String((ticket.exchangeOrder as { code: string }).code)}` });
      }
      const now = new Date();
      const staff = await resolveStaff(this.db, { salesRepId: input.salesRepId, staffUserId: input.staffUserId }, session);
      const order = await this.issueExchangeOrderIn(ticket, exchange.warehouseCode, (ticket.returnedAt as Date | undefined) ?? now, ticket.returnedTo ? String(ticket.returnedTo) : undefined, staff, request, session);
      const note = `Phiếu BH ${order.code} · SWK ${order.warehouseSlipNo} (đổi bảo hành)`;
      const history = { at: now, byName: request.user.displayName, action: 'EXCHANGE_ORDER', from: 'RETURNED', to: 'RETURNED', note };
      const update: Document = { $set: { exchangeOrder: order, updatedAt: now }, $inc: { version: 1 }, $push: { history } };
      const result = await this.collection().findOneAndUpdate({ _id: ticketId, version }, update, { session, returnDocument: 'after' });
      if (!result) throw new ConflictException({ code: 'VERSION_CONFLICT', message: 'Phiếu bảo hành đã được người khác cập nhật, vui lòng tải lại' });
      await this.audit.record(
        { actorId: request.user.sub, actorEmail: request.user.email, correlationId: request.correlationId, action: 'WARRANTY_EXCHANGE_ORDER', entityType: 'WarrantyTicket', entityId: id, before: { version }, after: { version: version + 1, exchangeOrder: order.code }, metadata: { note } },
        session,
      );
      return this.present(result, now);
    });
  }

  /** Số phiếu đang quá hẹn trả (ô cảnh báo trên dashboard). */
  // ---------- WAR-EDIT-01 (06/11/2026): yêu cầu sửa phiếu theo giai đoạn — duyệt trước rồi mới sửa ----------

  private isWarrantyApprover(user: Pick<RequestUser, 'roles' | 'root'>) {
    return Boolean(user.root) || user.roles.some((role) => WARRANTY_APPROVER_ROLES.includes(role));
  }

  private editRequestView(row: Document, now = new Date()): WarrantyEditRequestView {
    const iso = (value: unknown) => (value instanceof Date ? value.toISOString() : undefined);
    const expired = row.status === 'GRANTED' && row.expiresAt instanceof Date && row.expiresAt <= now;
    return {
      id: String(row.id),
      stage: row.stage as WarrantyEditStage,
      reason: String(row.reason),
      status: (expired ? 'EXPIRED' : row.status) as WarrantyEditRequestStatus,
      requestedById: String(row.requestedBy),
      requestedByName: String(row.requestedByName),
      requestedAt: iso(row.requestedAt) as string,
      ...(row.decidedByName ? { decidedByName: String(row.decidedByName) } : {}),
      ...(iso(row.decidedAt) ? { decidedAt: iso(row.decidedAt) as string } : {}),
      ...(row.decisionNote ? { decisionNote: String(row.decisionNote) } : {}),
      ...(iso(row.expiresAt) ? { expiresAt: iso(row.expiresAt) as string } : {}),
      ...(iso(row.appliedAt) ? { appliedAt: iso(row.appliedAt) as string } : {}),
    };
  }

  private async loadForEdit(id: string, version: number, session: ClientSession) {
    const ticket = await this.collection().findOne({ _id: toObjectId(id) }, { session });
    if (!ticket) throw new NotFoundException({ code: 'WARRANTY_NOT_FOUND', message: 'Không tìm thấy phiếu bảo hành' });
    if (ticket.version !== version) throw new ConflictException({ code: 'VERSION_CONFLICT', message: 'Phiếu bảo hành đã được người khác cập nhật, vui lòng tải lại' });
    return ticket;
  }

  private async notifyWarranty(id: string, payload: Document, session: ClientSession) {
    await this.outbox.enqueue({ eventType: 'NOTIFICATION_REQUESTED', aggregateType: 'WarrantyTicket', aggregateId: id, payload: { category: 'WARRANTY', href: `/warranty/${id}`, ...payload } }, session);
  }

  /**
   * Quyền sửa một giai đoạn: Quản lý kho / Admin (người duyệt) sửa thẳng; người khác phải có yêu cầu của chính mình đã được duyệt,
   * đúng giai đoạn, còn hạn, chưa dùng. Trả id yêu cầu để đánh dấu "đã sửa" (null = người duyệt sửa thẳng).
   */
  private stageGrant(ticket: Document, stage: WarrantyEditStage, requestId: string | undefined, user: RequestUser, now: Date): ObjectId | null {
    const rows = (ticket.editRequests as Document[] | undefined) ?? [];
    if (this.isWarrantyApprover(user) && !requestId) return null;
    if (!requestId) {
      throw new ForbiddenException({ code: 'WARRANTY_EDIT_NEEDS_APPROVAL', message: `Sửa giai đoạn ${WARRANTY_STAGE_LABEL[stage]} cần gửi "Yêu cầu sửa phiếu" và được Quản lý kho duyệt trước` });
    }
    const row = rows.find((item) => String(item.id) === requestId);
    if (!row || String(row.requestedBy) !== user.sub) throw new ForbiddenException({ code: 'WARRANTY_EDIT_GRANT_NOT_FOUND', message: 'Không có quyền sửa nào của bạn khớp yêu cầu này' });
    if (row.stage !== stage) throw new ConflictException({ code: 'WARRANTY_EDIT_GRANT_STAGE', message: `Quyền sửa được duyệt cho giai đoạn ${WARRANTY_STAGE_LABEL[row.stage as WarrantyEditStage]}` });
    if (row.status !== 'GRANTED' || !(row.expiresAt instanceof Date) || row.expiresAt <= now) {
      const message = row.status === 'APPLIED' ? 'Quyền sửa đã dùng — gửi yêu cầu mới nếu cần sửa tiếp' : row.status === 'PENDING' ? 'Yêu cầu sửa đang chờ duyệt' : 'Quyền sửa không còn hiệu lực (hết hạn / bị từ chối / đã rút)';
      throw new ConflictException({ code: 'WARRANTY_EDIT_GRANT_STATE', message });
    }
    return row.id as ObjectId;
  }

  /** Nhân viên bảo hành gửi yêu cầu sửa một giai đoạn (bắt buộc lý do) → báo Quản lý kho / Admin. */
  async requestEdit(id: string, input: WarrantyEditRequestInput, request: AuthenticatedRequest, idempotencyKey: string | undefined) {
    return this.idempotency.execute(`warranty-edit-request:${id}:${request.user.sub}`, idempotencyKey, input, async (session) => {
      const ticket = await this.loadForEdit(id, input.version, session);
      if (this.isWarrantyApprover(request.user)) {
        throw new ConflictException({ code: 'WARRANTY_EDIT_NOT_NEEDED', message: 'Bạn có quyền duyệt — bấm "Sửa phiếu" để sửa trực tiếp' });
      }
      if (!warrantyEditableStages(ticket as never).includes(input.stage)) {
        throw new ConflictException({ code: 'WARRANTY_EDIT_STAGE_INVALID', message: ticket.status === 'CANCELLED' ? 'Phiếu đã hủy không sửa được' : `Phiếu chưa qua giai đoạn ${WARRANTY_STAGE_LABEL[input.stage]}` });
      }
      const now = new Date();
      const open = ((ticket.editRequests as Document[] | undefined) ?? []).find((row) => row.status === 'PENDING' || (row.status === 'GRANTED' && row.expiresAt instanceof Date && row.expiresAt > now));
      if (open) {
        throw new ConflictException({
          code: 'WARRANTY_EDIT_PENDING_EXISTS',
          message: open.status === 'PENDING' ? 'Phiếu đang có yêu cầu sửa chờ duyệt — chờ kết quả hoặc rút yêu cầu đó' : 'Phiếu đang có quyền sửa đã duyệt chưa dùng — sửa xong hoặc rút trước',
        });
      }
      const status = ticket.status as WarrantyStatus;
      const row = { id: new ObjectId(), stage: input.stage, reason: input.reason, status: 'PENDING', requestedBy: toObjectId(request.user.sub), requestedByName: request.user.displayName, requestedAt: now };
      const history = { at: now, byName: request.user.displayName, action: 'EDIT_REQUEST', from: status, to: status, note: `[${WARRANTY_STAGE_LABEL[input.stage]}] ${input.reason}` };
      const result = await this.collection().findOneAndUpdate(
        { _id: ticket._id, version: input.version },
        { $push: { editRequests: row, history }, $inc: { version: 1 }, $set: { updatedAt: now } } as Document,
        { session, returnDocument: 'after' },
      );
      if (!result) throw new ConflictException({ code: 'VERSION_CONFLICT', message: 'Phiếu bảo hành đã được người khác cập nhật, vui lòng tải lại' });
      const code = String(ticket.code);
      await this.notifyWarranty(id, {
        targetRoles: WARRANTY_APPROVER_ROLES,
        level: 'WARNING',
        title: `${request.user.displayName} xin sửa phiếu bảo hành ${code} (${WARRANTY_STAGE_LABEL[input.stage]})`,
        message: input.reason,
        template: 'WARRANTY_EDIT_REQUESTED',
        params: { code, stage: input.stage, requester: request.user.displayName, reason: input.reason },
      }, session);
      await this.audit.record({
        actorId: request.user.sub, actorEmail: request.user.email, correlationId: request.correlationId, action: 'WARRANTY_EDIT_REQUESTED',
        entityType: 'WarrantyTicket', entityId: id, metadata: { stage: input.stage, reason: input.reason, requestId: row.id.toHexString() },
      }, session);
      return this.present(result, now);
    });
  }

  /** Quản lý kho / Admin duyệt (cho sửa trong WARRANTY_EDIT_GRANT_HOURS giờ) hoặc từ chối (bắt buộc lý do). */
  async decideEdit(id: string, requestId: string, input: WarrantyEditDecision, request: AuthenticatedRequest, idempotencyKey: string | undefined) {
    return this.idempotency.execute(`warranty-edit-decide:${requestId}`, idempotencyKey, input, async (session) => {
      const ticket = await this.collection().findOne({ _id: toObjectId(id) }, { session });
      if (!ticket) throw new NotFoundException({ code: 'WARRANTY_NOT_FOUND', message: 'Không tìm thấy phiếu bảo hành' });
      const row = ((ticket.editRequests as Document[] | undefined) ?? []).find((item) => String(item.id) === requestId);
      if (!row || row.status !== 'PENDING') throw new ConflictException({ code: 'WARRANTY_EDIT_STATE', message: 'Yêu cầu sửa không còn chờ duyệt' });
      const now = new Date();
      const status = ticket.status as WarrantyStatus;
      const decided: Document = {
        'editRequests.$[row].status': input.approved ? 'GRANTED' : 'REJECTED',
        'editRequests.$[row].decidedBy': toObjectId(request.user.sub),
        'editRequests.$[row].decidedByName': request.user.displayName,
        'editRequests.$[row].decidedAt': now,
        ...(input.approved ? { 'editRequests.$[row].expiresAt': new Date(now.getTime() + WARRANTY_EDIT_GRANT_HOURS * 3_600_000) } : {}),
        ...(input.note ? { 'editRequests.$[row].decisionNote': input.note } : {}),
        updatedAt: now,
      };
      const stage = WARRANTY_STAGE_LABEL[row.stage as WarrantyEditStage];
      const history = { at: now, byName: request.user.displayName, action: input.approved ? 'EDIT_GRANTED' : 'EDIT_REJECTED', from: status, to: status, note: `[${stage}] ${String(row.requestedByName)}${input.note ? ` — ${input.note}` : ''}` };
      const result = await this.collection().findOneAndUpdate(
        { _id: ticket._id },
        { $set: decided, $push: { history }, $inc: { version: 1 } } as Document,
        { session, returnDocument: 'after', arrayFilters: [{ 'row.id': row.id, 'row.status': 'PENDING' }] },
      );
      if (!result) throw new ConflictException({ code: 'VERSION_CONFLICT', message: 'Phiếu bảo hành đã được người khác cập nhật, vui lòng tải lại' });
      const code = String(ticket.code);
      await this.notifyWarranty(id, {
        targetUserIds: [String(row.requestedBy)],
        level: input.approved ? 'INFO' : 'WARNING',
        title: input.approved ? `Được sửa phiếu bảo hành ${code} (${stage}) trong ${WARRANTY_EDIT_GRANT_HOURS} giờ` : `Yêu cầu sửa phiếu bảo hành ${code} bị từ chối`,
        message: input.note ?? `${request.user.displayName} ${input.approved ? 'đã duyệt' : 'từ chối'}`,
        template: 'WARRANTY_EDIT_DECIDED',
        params: { code, stage: String(row.stage), approved: input.approved ? 'yes' : 'no', approver: request.user.displayName, note: input.note ?? '' },
      }, session);
      await this.audit.record({
        actorId: request.user.sub, actorEmail: request.user.email, correlationId: request.correlationId, action: input.approved ? 'WARRANTY_EDIT_GRANTED' : 'WARRANTY_EDIT_REJECTED',
        entityType: 'WarrantyTicket', entityId: id, metadata: { stage: row.stage, requestId, requestedBy: String(row.requestedByName), note: input.note ?? null },
      }, session);
      return this.present(result, now);
    });
  }

  /** Người xin rút yêu cầu đang chờ hoặc trả lại quyền sửa chưa dùng. */
  async withdrawEdit(id: string, requestId: string, request: AuthenticatedRequest) {
    const ticket = await this.collection().findOne({ _id: toObjectId(id) });
    if (!ticket) throw new NotFoundException({ code: 'WARRANTY_NOT_FOUND', message: 'Không tìm thấy phiếu bảo hành' });
    const row = ((ticket.editRequests as Document[] | undefined) ?? []).find((item) => String(item.id) === requestId);
    if (!row) throw new NotFoundException({ code: 'WARRANTY_EDIT_NOT_FOUND', message: 'Không tìm thấy yêu cầu sửa' });
    if (String(row.requestedBy) !== request.user.sub) throw new ForbiddenException({ code: 'WARRANTY_EDIT_NOT_OWNER', message: 'Chỉ người gửi được rút yêu cầu' });
    const now = new Date();
    const status = ticket.status as WarrantyStatus;
    const history = { at: now, byName: request.user.displayName, action: 'EDIT_WITHDRAWN', from: status, to: status, note: `[${WARRANTY_STAGE_LABEL[row.stage as WarrantyEditStage]}]` };
    const result = await this.collection().findOneAndUpdate(
      { _id: ticket._id },
      { $set: { 'editRequests.$[row].status': 'WITHDRAWN', 'editRequests.$[row].withdrawnAt': now, updatedAt: now }, $push: { history }, $inc: { version: 1 } } as Document,
      { returnDocument: 'after', arrayFilters: [{ 'row.id': row.id, 'row.status': { $in: ['PENDING', 'GRANTED'] } }] },
    );
    if (!result || !((result.editRequests as Document[]).find((item) => String(item.id) === requestId)?.status === 'WITHDRAWN')) {
      throw new ConflictException({ code: 'WARRANTY_EDIT_STATE', message: 'Yêu cầu không còn chờ duyệt / chưa dùng' });
    }
    await this.audit.record({ actorId: request.user.sub, actorEmail: request.user.email, correlationId: request.correlationId, action: 'WARRANTY_EDIT_WITHDRAWN', entityType: 'WarrantyTicket', entityId: id, metadata: { requestId } });
    return this.present(result, now);
  }

  /** Diện bảo hành theo dữ liệu tiếp nhận (chưa tính lý do sửa chữa ghi lúc chẩn đoán). */
  private async intakeCoverage(ticket: Document, session: ClientSession) {
    const settings = await warrantySettings(this.db);
    const invoice = ticket.invoice as { number: string; date: string } | undefined;
    const prior = await this.priorServices((ticket.product as { productId: ObjectId }).productId, invoice?.number, session, ticket._id as ObjectId);
    const choice = noInvoiceChoice({ invoiceDate: invoice?.date, noInvoiceWarranty: Boolean(ticket.invoicelessWarranty), declaredPurchaseDate: ticket.declaredPurchaseDate as string | undefined });
    return coverageFor({ invoiceDate: invoice?.date ? (prior.restartedOn ?? invoice.date) : null, receivedDate: String(ticket.receivedDate), months: settings.warrantyMonths, extensionDays: prior.extensionDays, ...choice });
  }

  /**
   * Phí sửa đổi trên phiếu đã trả khách: ghi / sửa số tiền / hủy công nợ phí dịch vụ (WARRANTY_SERVICE). Đã thu nhiều hơn số mới:
   * phần thu theo khách được xếp lại (thừa → khách trả trước); bỏ phí mà đã thu tiền thì phải sửa phiếu thu trước.
   */
  private async syncServiceBill(ticket: Document, charge: Decimal, set: Document, unset: Document, changes: string[], session: ClientSession, now: Date) {
    const link = ticket.receivable as { id: ObjectId; code: string; amount: unknown } | undefined;
    const existing = link ? await this.db.collection('receivables').findOne({ _id: link.id }, { session }) : null;
    const money = (value: Decimal) => `${Number(value.toFixed(0)).toLocaleString('vi-VN')} đ`;
    if (existing && existing.status !== 'VOIDED') {
      const paid = new Decimal(decimalString(existing.paidAmount));
      const before = new Decimal(decimalString(existing.amount));
      if (charge.isZero()) {
        if (paid.gt(0)) {
          throw new ConflictException({ code: 'WARRANTY_BILL_PAID', message: `Phí sửa ${String(existing.code)} đã thu ${money(paid)} — sửa / xóa phiếu thu trên sổ công nợ khách trước khi bỏ phí` });
        }
        await this.db.collection('receivables').updateOne(
          { _id: existing._id },
          { $set: { status: 'VOIDED', statusBeforeVoid: existing.status, voidedAt: now, voidReason: `Sửa phiếu bảo hành ${String(ticket.code)}: bỏ phí sửa`, updatedAt: now }, $inc: { version: 1 } },
          { session },
        );
        await releaseDocumentNumber(this.db, 'AR', existing, session);
        unset.receivable = '';
        changes.push(`Công nợ ${String(existing.code)}: hủy`);
        return { code: String(existing.code), amount: '0' };
      }
      if (charge.eq(before)) return null;
      const overpaid = paid.gt(charge);
      if (overpaid) {
        const fixed = await this.ledger.fixedPaidOn(existing._id as ObjectId, session);
        if (fixed.total.gt(charge)) {
          throw new ConflictException({ code: 'WARRANTY_BILL_PAID', message: `Phí sửa đã thu ${money(fixed.total)} bằng phiếu thu theo chứng từ (${fixed.codes.join(', ')}) — sửa phiếu thu đó trên sổ công nợ khách trước` });
        }
      }
      const status = overpaid || paid.eq(charge) ? 'PAID' : paid.gt(0) ? 'PARTIALLY_PAID' : existing.status === 'OVERDUE' ? 'OVERDUE' : 'OPEN';
      await this.db.collection('receivables').updateOne({ _id: existing._id }, { $set: { amount: decimal(charge.toFixed(2)), status, updatedAt: now }, $inc: { version: 1 } }, { session });
      if (overpaid) await this.ledger.rebuildPartner(existing.partnerId as ObjectId, session, now);
      set['receivable.amount'] = decimal(charge.toFixed(2));
      changes.push(`Công nợ ${String(existing.code)}: ${money(before)} → ${money(charge)}`);
      return { code: String(existing.code), amount: charge.toFixed(0) };
    }
    if (charge.gt(0)) {
      const receivable = await this.billService(ticket, charge, session, now);
      set.receivable = receivable;
      changes.push(`Ghi công nợ ${receivable.code}: ${money(charge)}`);
      return { code: receivable.code, amount: charge.toFixed(0) };
    }
    return null;
  }

  /**
   * Sửa dữ liệu một giai đoạn đã qua (Chẩn đoán / Sửa chữa / Kiểm tra / Trả khách — Tiếp nhận sửa qua updateIntake), cả khi phiếu đã
   * trả khách. Hướng xử lý, xuất kho đổi máy và phiếu BH đổi bảo hành không đổi ở đây. Lịch sử ghi trường cũ → mới.
   */
  async editStage(id: string, input: WarrantyStageEdit, request: AuthenticatedRequest, idempotencyKey: string | undefined) {
    return this.idempotency.execute(`warranty-stage-edit:${id}:${request.user.sub}`, idempotencyKey, input, async (session) => {
      const ticket = await this.loadForEdit(id, input.version, session);
      const now = new Date();
      if (!warrantyEditableStages(ticket as never).includes(input.stage)) {
        throw new ConflictException({ code: 'WARRANTY_EDIT_STAGE_INVALID', message: ticket.status === 'CANCELLED' ? 'Phiếu đã hủy không sửa được' : `Phiếu chưa qua giai đoạn ${WARRANTY_STAGE_LABEL[input.stage]}` });
      }
      const grantId = this.stageGrant(ticket, input.stage, input.requestId, request.user, now);
      const set: Document = { updatedAt: now };
      const unset: Document = {};
      const changes: string[] = [];
      const text = (value: unknown) => (value === undefined || value === null || value === '' ? '—' : String(value));
      const change = (label: string, from: unknown, to: unknown) => {
        if (text(from) !== text(to)) changes.push(`${label}: ${text(from)} → ${text(to)}`);
      };
      const optionalSet = (path: string, value: string | undefined) => {
        if (value) set[path] = value;
        else unset[path] = '';
      };
      const code = String(ticket.code);
      const status = ticket.status as WarrantyStatus;
      let nextStatus: WarrantyStatus = status;
      const notifications: Document[] = [];
      switch (input.stage) {
        case 'DIAGNOSE': {
          await this.faultCodes.assertKnown(input.lines.map((line) => line.faultCode ?? ''));
          const lineText = (lines: Document[]) => lines.map((line) => [line.faultCode, line.symptom, line.rootCause, line.action, line.partCode, line.note].filter(Boolean).join(' / ')).join(' | ');
          change('Dòng lỗi', lineText((ticket.lines as Document[]) ?? []), lineText(input.lines));
          set.lines = input.lines;
          const before = ticket.exclusion === 'NO_INVOICE' ? '' : String(ticket.exclusion ?? '');
          const after = input.exclusion ?? '';
          if (ticket.exclusion === 'NO_INVOICE' && after) {
            throw new BadRequestException({ code: 'WARRANTY_EXCLUSION_LOCKED', message: 'Phiếu không hóa đơn (sửa có tính phí): lý do theo tiếp nhận, sửa ở giai đoạn Tiếp nhận' });
          }
          // Đổi hướng xử lý (WAR-EDIT-02, 09/11/2026 — bảo hành / thủ kho: sửa chữa → đổi sản phẩm mới không ra phiếu xuất kho).
          const nextPlan = (input.plan ?? ticket.plan) as WarrantyPlan | undefined;
          const planChanged = Boolean(input.plan && input.plan !== ticket.plan);
          let coverage = ticket.coverage as WarrantyCoverage;
          const exclusionChanged = ticket.exclusion !== 'NO_INVOICE' && before !== after;
          if (exclusionChanged) {
            const base = await this.intakeCoverage(ticket, session);
            coverage = (after ? 'NOT_COVERED' : base.coverage) as WarrantyCoverage;
            change('Lý do sửa chữa', before, after);
            change('Diện bảo hành', ticket.coverage, coverage);
            set.coverage = coverage;
            if (after) set.exclusion = after;
            else unset.exclusion = '';
          }
          if ((exclusionChanged || planChanged) && nextPlan && !plansForCoverage(coverage).includes(nextPlan)) {
            throw new BadRequestException({ code: 'WARRANTY_PLAN_INVALID', message: 'Hướng xử lý không hợp với diện bảo hành: đổi mới / hoàn tiền chỉ khi còn bảo hành; báo giá chỉ khi không còn bảo hành; từ chối chỉ khi có lý do sửa chữa', details: [{ path: ['plan'] }] });
          }
          if (nextPlan === 'QUOTE' && (input.quoteAmount !== undefined || planChanged)) {
            if (!input.quoteAmount || new Decimal(input.quoteAmount).lte(0)) throw new BadRequestException({ code: 'WARRANTY_QUOTE_REQUIRED', message: 'Tiền báo giá phải lớn hơn 0', details: [{ path: ['quoteAmount'] }] });
            change('Báo giá', decimalString(ticket.quoteAmount), new Decimal(input.quoteAmount).toFixed(0));
            set.quoteAmount = decimal(input.quoteAmount);
          } else if (input.quoteAmount !== undefined) {
            throw new BadRequestException({ code: 'WARRANTY_QUOTE_INVALID', message: 'Chỉ phiếu báo giá có tiền báo giá' });
          }
          if (planChanged && nextPlan) {
            const exchangeOrder = ticket.exchangeOrder as { code?: string } | undefined;
            if (exchangeOrder || (ticket.stock as Document | undefined)?.exchange) {
              throw new ConflictException({ code: 'WARRANTY_PLAN_LOCKED', message: `Phiếu đã xuất hàng đổi từ kho${exchangeOrder?.code ? ` (phiếu BH ${exchangeOrder.code})` : ''} — không đổi hướng xử lý được` });
            }
            // Phiếu đã trả khách có công nợ phí sửa: hướng mới tính lại từ đầu → hủy công nợ cũ (đã thu thì báo sửa phiếu thu trước).
            if (status === 'RETURNED' && ticket.receivable) await this.syncServiceBill(ticket, new Decimal(0), set, unset, changes, session, now);
            change('Hướng xử lý', ticket.plan ? WARRANTY_PLAN_LABEL[ticket.plan as WarrantyPlan] : '', WARRANTY_PLAN_LABEL[nextPlan]);
            set.plan = nextPlan;
            for (const key of ['result', 'test', 'approval', 'quoteAccepted', 'stock', 'refund', 'returnedAt', 'returnedTo', 'serviceDays']) unset[key] = '';
            if (nextPlan !== 'QUOTE') unset.quoteAmount = '';
            if (nextPlan === 'REPAIR') nextStatus = 'REPAIRING';
            else if (nextPlan === 'QUOTE') nextStatus = 'QUOTE_PENDING';
            else if (!this.isWarrantyApprover(request.user)) {
              // Nhân viên bảo hành đổi sang đổi mới / hoàn tiền / từ chối (09/11/2026): duyệt yêu cầu sửa chỉ cho phép sửa giai đoạn,
              // chưa phải duyệt đề nghị → phiếu chờ Quản lý kho duyệt như lúc chẩn đoán (duyệt xong mới trả khách / xuất hàng đổi).
              nextStatus = 'PENDING_APPROVAL';
              set.approval = { proposal: nextPlan, requestedAt: now, requestedByName: request.user.displayName, note: input.reason };
              const customer = String((ticket.customer as Document).name);
              const product = String((ticket.product as Document).sku);
              notifications.push({
                targetRoles: ['WAREHOUSE_MANAGER'], level: 'WARNING', template: 'WARRANTY_APPROVAL_REQUESTED',
                params: { code, customer, product, proposal: nextPlan },
                title: `Phiếu bảo hành ${code} chờ Quản lý kho duyệt`,
                message: `${customer} — ${product}: sửa phiếu, đề nghị ${WARRANTY_PLAN_LABEL[nextPlan].toLowerCase()}. ${input.reason}`,
              });
            } else {
              // Quản lý kho / Admin tự sửa → chính họ duyệt: phiếu chờ trả khách. Trả khách đổi mới → xuất 1 sản phẩm mới + phiếu BH & SWK.
              const approver = request.user.displayName;
              nextStatus = 'READY';
              set.approval = { proposal: nextPlan, requestedAt: now, requestedByName: request.user.displayName, decidedAt: now, decidedByName: approver, approved: true, note: input.reason };
              set.result = { resolution: RESOLUTION_BY_PROPOSAL[nextPlan as keyof typeof RESOLUTION_BY_PROPOSAL], cost: decimal('0'), chargedTo: nextPlan === 'REJECT' ? 'CUSTOMER' : 'COMPANY', completedAt: now };
              const customer = String((ticket.customer as Document).name);
              const product = String((ticket.product as Document).sku);
              notifications.push({
                targetRoles: nextPlan === 'EXCHANGE' ? ['WARRANTY', 'WAREHOUSE_MANAGER', 'WAREHOUSE'] : ['WARRANTY'], level: 'INFO', template: 'WARRANTY_APPROVAL_DECIDED',
                params: { code, customer, product, approved: 'yes' },
                title: `Phiếu bảo hành ${code} đổi hướng xử lý: ${WARRANTY_PLAN_LABEL[nextPlan]} — chờ trả khách`,
                message: nextPlan === 'EXCHANGE' ? `${customer} — ${product}: bấm Trả khách để xuất 1 sản phẩm mới và in phiếu BH & SWK đổi bảo hành` : `${customer} — ${product}`,
              });
            }
            if (status === 'RETURNED') changes.push('Mở lại phiếu đã trả khách');
            set.status = nextStatus;
          }
          break;
        }
        case 'REPAIR': {
          const result = (ticket.result as Document | undefined) ?? {};
          change('Kết quả', result.resolution, input.resolution);
          change('Linh kiện thay', result.replacedParts, input.replacedParts);
          change('Chi phí', decimalString(result.cost), new Decimal(input.cost).toFixed(0));
          change('Bên chịu phí', result.chargedTo === 'COMPANY' ? 'Công ty' : 'Khách', input.chargedTo === 'COMPANY' ? 'Công ty' : 'Khách');
          change('Ghi chú sửa', result.note, input.note);
          set['result.resolution'] = input.resolution;
          optionalSet('result.replacedParts', input.replacedParts);
          set['result.cost'] = decimal(input.cost);
          set['result.chargedTo'] = input.chargedTo;
          optionalSet('result.note', input.note);
          if (status === 'RETURNED') {
            const charge = input.chargedTo === 'CUSTOMER' ? new Decimal(input.cost) : new Decimal(0);
            const billed = await this.syncServiceBill(ticket, charge, set, unset, changes, session, now);
            if (billed) {
              notifications.push({
                targetRoles: ['ACCOUNTANT'], level: 'INFO', template: 'WARRANTY_SERVICE_BILLED',
                params: { code, customer: String((ticket.customer as Document).name), amount: billed.amount, receivable: billed.code },
                title: `Phí dịch vụ bảo hành ${code} đã sửa: ${billed.amount} đ — công nợ ${billed.code}`,
                message: String((ticket.customer as Document).name),
              });
            }
          }
          break;
        }
        case 'TEST': {
          const test = (ticket.test as Document | undefined) ?? {};
          const mark = (value: unknown) => (value ? 'đạt' : 'không đạt');
          change('Chức năng', mark(test.functional), mark(input.functional));
          change('An toàn', mark(test.safety), mark(input.safety));
          change('Hiệu suất', mark(test.performance), mark(input.performance));
          change('Ghi chú kiểm tra', test.note, input.note);
          set['test.functional'] = input.functional;
          set['test.safety'] = input.safety;
          set['test.performance'] = input.performance;
          optionalSet('test.note', input.note);
          set['test.editedAt'] = now;
          set['test.editedByName'] = request.user.displayName;
          break;
        }
        case 'RETURN': {
          if (input.returnedDate > vnDate(now)) throw new BadRequestException({ code: 'WARRANTY_DATE_INVALID', message: 'Ngày trả khách không được sau hôm nay', details: [{ path: ['returnedDate'] }] });
          if (input.returnedDate < String(ticket.receivedDate)) throw new BadRequestException({ code: 'WARRANTY_DATE_INVALID', message: 'Ngày trả khách phải từ ngày tiếp nhận trở đi', details: [{ path: ['returnedDate'] }] });
          const returnedAt = ticket.returnedAt as Date;
          if (vnDate(returnedAt) !== input.returnedDate) {
            const at = input.returnedDate === vnDate(now) ? now : new Date(`${input.returnedDate}T17:00:00+07:00`);
            change('Ngày trả khách', vnDate(returnedAt), input.returnedDate);
            set.returnedAt = at;
            set.serviceDays = serviceDays(ticket.receivedAt as Date, at);
          }
          change('Người nhận', ticket.returnedTo, input.receiverName);
          set.returnedTo = input.receiverName;
          const resolution = (ticket.result as { resolution?: WarrantyResolution } | undefined)?.resolution;
          if (input.refundAmount !== undefined) {
            if (resolution !== 'REFUNDED') throw new BadRequestException({ code: 'WARRANTY_RETURN_OPTION_INVALID', message: 'Chỉ phiếu hoàn tiền có số tiền hoàn' });
            if (new Decimal(input.refundAmount).lte(0)) throw new BadRequestException({ code: 'WARRANTY_REFUND_REQUIRED', message: 'Số tiền hoàn phải lớn hơn 0' });
            change('Tiền hoàn', decimalString((ticket.refund as Document | undefined)?.amount), new Decimal(input.refundAmount).toFixed(0));
            set.refund = { amount: decimal(input.refundAmount) };
            set['result.cost'] = decimal(input.refundAmount);
          }
          if (input.returnSlipCode !== undefined) {
            const returnsDefect = Boolean(resolution && RESOLUTIONS_RETURNING_DEFECT.includes(resolution));
            const current = (ticket.stock as { returnSlip?: { code: string } } | undefined)?.returnSlip?.code ?? '';
            if (input.returnSlipCode !== current) {
              if (!returnsDefect || !ticket.stock) throw new BadRequestException({ code: 'WARRANTY_RETURN_OPTION_INVALID', message: 'Chỉ phiếu đổi mới / hoàn tiền có phiếu trả hàng liên kết' });
              if (input.returnSlipCode) {
                const slip = await this.returnSlipFor(ticket, input.returnSlipCode, session);
                set['stock.returnSlip'] = { id: (slip._id as ObjectId).toHexString(), code: String(slip.code), warehouseName: String(slip.warehouseName), category: String(slip.category) };
                change('Phiếu trả hàng', current, String(slip.code));
              } else {
                unset['stock.returnSlip'] = '';
                change('Phiếu trả hàng', current, '');
              }
            }
          }
          break;
        }
      }
      if (!changes.length) throw new BadRequestException({ code: 'WARRANTY_UNCHANGED', message: 'Phiếu chưa có thay đổi nào' });
      for (const key of Object.keys(set)) delete unset[key];
      if (grantId) {
        set['editRequests.$[grant].status'] = 'APPLIED';
        set['editRequests.$[grant].appliedAt'] = now;
      }
      const history = {
        at: now, byName: request.user.displayName, action: 'EDIT_STAGE', from: status, to: nextStatus,
        note: `[${WARRANTY_STAGE_LABEL[input.stage]}] ${input.reason}${grantId ? ' (yêu cầu đã duyệt)' : ''} — ${changes.join('; ')}`,
      };
      const result = await this.collection().findOneAndUpdate(
        { _id: ticket._id, version: input.version },
        { $set: set, ...(Object.keys(unset).length ? { $unset: unset } : {}), $inc: { version: 1 }, $push: { history } } as Document,
        { session, returnDocument: 'after', ...(grantId ? { arrayFilters: [{ 'grant.id': grantId }] } : {}) },
      );
      if (!result) throw new ConflictException({ code: 'VERSION_CONFLICT', message: 'Phiếu bảo hành đã được người khác cập nhật, vui lòng tải lại' });
      for (const notification of notifications) await this.notifyWarranty(id, notification, session);
      await this.audit.record({
        actorId: request.user.sub, actorEmail: request.user.email, correlationId: request.correlationId, action: 'WARRANTY_STAGE_EDITED',
        entityType: 'WarrantyTicket', entityId: id, before: serializeDocument(ticket), after: serializeDocument(result),
        metadata: { stage: input.stage, reason: input.reason, changes, requestId: grantId ? grantId.toHexString() : null },
      }, session);
      return this.present(result, now);
    });
  }

  async overdueCount(): Promise<number> {
    const settings = await warrantySettings(this.db);
    const now = new Date();
    const open = await this.collection().find({ status: { $nin: ['RETURNED', 'CANCELLED'] } }).toArray();
    return open.filter((ticket) => ticketSla(ticket, settings, now).tone === 'overdue').length;
  }
}
