import { BadRequestException, ConflictException, ForbiddenException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import {
  coverageFor,
  MAX_WARRANTY_PHOTOS,
  RESOLUTIONS_RETURNING_DEFECT,
  serviceDays,
  vnDate,
  WARRANTY_ACTIONS_BY_STATUS,
  type WarrantyPhotoKind,
  type WarrantyReport,
  type WarrantyResolution,
  type CreateWarrantyTicket,
  type NotificationTemplate,
  type TextParams,
  type WarrantyAction,
  type WarrantyCoverage,
  type WarrantyStatus,
} from '@inoxpran/contracts';
import Decimal from 'decimal.js';
import { type ClientSession, type Db, type Document, type Filter, ObjectId } from 'mongodb';
import { AuditService } from '../../common/audit.service';
import { decimal, decimalString, serializeDocument, toObjectId } from '../../common/domain';
import { IdempotencyService } from '../../common/idempotency.service';
import { OutboxService } from '../../common/outbox.service';
import type { AuthenticatedRequest, RequestUser } from '../../common/request-context';
import { SequenceService } from '../../common/sequence.service';
import { MONGO_DATABASE } from '../../common/tokens';
import { ticketSla, WARRANTY_TICKETS, warrantySettings } from './warranty-sla';
import { slicePage, type PageRequest } from '../../common/paging';
import { EvidenceIntakeService } from '../../common/evidence-intake.service';
import { InventoryService } from '../inventory/inventory.service';
import { WarrantyFaultCodesService } from './warranty-fault-codes.service';
import { buildWarrantyReport, shiftMonth } from './warranty-report';

/** Nhân viên bảo hành tiếp nhận và xử lý; Giám đốc duyệt từ chối / đổi mới / hoàn tiền (chốt 03/10/2026). */
export const WARRANTY_STAFF_ROLES = ['ADMIN', 'WARRANTY'];
export const WARRANTY_APPROVER_ROLES = ['ADMIN', 'DIRECTOR'];
export const WARRANTY_VIEWER_ROLES = ['ADMIN', 'DIRECTOR', 'WARRANTY'];

const RESOLUTION_BY_PROPOSAL = { REJECT: 'REJECTED', EXCHANGE: 'EXCHANGED', REFUND: 'REFUNDED' } as const;
const PHOTO_PURPOSE = 'WARRANTY_PHOTO';
/** Khách vãng lai (không có hồ sơ): phí dịch vụ ghi vào hồ sơ khách lẻ chung, ghi kèm tên / SĐT người trả. */
const WALK_IN_PARTNER_CODE = 'KH000';
const ESCAPE = /[.*+?^${}()|[\]\\]/g;

interface PriorServices {
  count: number;
  extensionDays: number;
  /** Ngày bắt đầu bảo hành mới khi sản phẩm đã được đổi (luật: tính lại từ ngày đổi). */
  restartedOn?: string;
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
    };
  }

  async settings() {
    return warrantySettings(this.db);
  }

  async list(filter: { status?: string | undefined; tone?: string | undefined; search?: string | undefined; customerId?: string | undefined }, paging: PageRequest | null = null) {
    const query: Filter<Document> = {};
    if (filter.status) query.status = filter.status;
    // Tab Bảo hành trên hồ sơ khách hàng.
    if (filter.customerId) query['customer.partnerId'] = toObjectId(filter.customerId, 'customerId');
    if (filter.search) {
      const pattern = new RegExp(filter.search.replace(ESCAPE, '\\$&'), 'i');
      query.$or = [{ code: pattern }, { 'customer.name': pattern }, { 'customer.phone': pattern }, { 'product.sku': pattern }, { 'product.name': pattern }, { 'invoice.number': pattern }];
    }
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
      .sort((a, b) => order[a.sla.tone] - order[b.sla.tone] || (a.sla.tone === 'closed' ? 0 : a.sla.dueAt.getTime() - b.sla.dueAt.getTime()));
    const present = shown.map(({ ticket, sla }) => ({ ...serializeDocument(ticket), sla: { ...sla, dueAt: sla.dueAt.toISOString(), warningAt: sla.warningAt.toISOString() } }));
    if (paging) return slicePage(present, paging, { settings, counts });
    return { settings, counts, rows: present };
  }

  async get(id: string) {
    const ticket = await this.collection().findOne({ _id: toObjectId(id) });
    if (!ticket) throw new NotFoundException({ code: 'WARRANTY_NOT_FOUND', message: 'Không tìm thấy phiếu bảo hành' });
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
   * Đổi mới: xuất 1 sản phẩm mới từ kho bán hàng (kiểm tra tồn khả dụng). Đổi mới / hoàn tiền: nhập sản phẩm lỗi khách trả
   * vào kho hàng lỗi (purpose = DEFECTIVE) chờ trả nhà cung cấp / hủy. Ghi thẻ kho tham chiếu số phiếu bảo hành.
   */
  private async moveStock(ticket: Document, resolution: WarrantyResolution, actorId: string, session: ClientSession, now: Date) {
    const reference = String(ticket.code);
    const product = ticket.product as { productId: ObjectId; sku: string };
    const productId = product.productId.toHexString();
    const defect = await this.db.collection('warehouses').findOne({ purpose: 'DEFECTIVE', active: true }, { session, sort: { code: 1 } });
    if (!defect) {
      throw new ConflictException({ code: 'DEFECTIVE_WAREHOUSE_MISSING', message: 'Chưa khai báo kho hàng lỗi — vào Danh mục › Kho & vị trí lưu, thêm kho và đánh dấu "Kho hàng lỗi"' });
    }
    let exchange: Document | null = null;
    if (resolution === 'EXCHANGED') {
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
    await this.inventory.applyPhysicalMovement({
      warehouseId: (defect._id as ObjectId).toHexString(), referenceType: 'WarrantyTicket', referenceId: reference,
      movementType: 'WARRANTY_DEFECT_IN', direction: 'IN', lines: [{ productId, quantity: '1' }],
      reason: `Hàng lỗi khách trả (${resolution === 'EXCHANGED' ? 'đổi mới' : 'hoàn tiền'}) — phiếu bảo hành ${reference}`, actorId,
    }, session);
    const place = (row: Document) => ({ warehouseCode: String(row.code), warehouseName: String(row.name) });
    return { ...(exchange ? { exchange: place(exchange) } : {}), defect: place(defect), reference, movedAt: now };
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
  async coveragePreview(productId: string, invoiceNumber: string | undefined, invoiceDate: string | undefined, receivedDate: string) {
    const settings = await warrantySettings(this.db);
    const prior = await this.priorServices(toObjectId(productId, 'productId'), invoiceNumber?.trim() || undefined);
    const coverage = coverageFor({
      invoiceDate: invoiceDate ? (prior.restartedOn ?? invoiceDate) : null,
      receivedDate,
      months: settings.warrantyMonths,
      extensionDays: prior.extensionDays,
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
      const coverage = coverageFor({
        invoiceDate: input.invoiceDate ? (prior.restartedOn ?? input.invoiceDate) : null,
        receivedDate: input.receivedDate,
        months: settings.warrantyMonths,
        extensionDays: prior.extensionDays,
      });
      const now = new Date();
      // Tiếp nhận hôm nay: giờ thực; nhập bù ngày trước: tính từ 08:00 ngày đó.
      const receivedAt = input.receivedDate === vnDate(now) ? now : new Date(`${input.receivedDate}T08:00:00+07:00`);
      const id = new ObjectId();
      const document: Document = {
        _id: id,
        code: await this.sequences.next('SC', session, 4, receivedAt, 'compact'),
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
        history: [{ at: now, byName: request.user.displayName, action: 'RECEIVE', to: 'RECEIVED', note: input.symptom }],
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
          message: action.type === 'APPROVE' ? 'Chỉ Giám đốc được duyệt từ chối / đổi mới / hoàn tiền' : 'Chỉ nhân viên bảo hành được cập nhật phiếu',
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
          const plan = action.plan;
          if (plan === 'REPAIR' && coverage !== 'IN_WARRANTY') {
            throw new BadRequestException({ code: 'WARRANTY_PLAN_INVALID', message: 'Sản phẩm không còn bảo hành: lập báo giá sửa chữa có tính phí hoặc đề nghị từ chối' });
          }
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
              roles: ['DIRECTOR'],
              level: 'WARNING',
              template: 'WARRANTY_APPROVAL_REQUESTED',
              params: { code, customer, product, proposal: plan },
              title: `Phiếu bảo hành ${code} chờ Giám đốc duyệt`,
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
            title: `Giám đốc ${action.approved ? 'đã duyệt' : 'không duyệt'} đề nghị trên phiếu ${code}`,
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
            chargedTo: ticket.coverage === 'IN_WARRANTY' ? 'COMPANY' : 'CUSTOMER',
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
          if (resolution && RESOLUTIONS_RETURNING_DEFECT.includes(resolution)) {
            const stock = await this.moveStock(ticket, resolution, request.user.sub, session, now);
            set.stock = stock;
            if (resolution === 'EXCHANGED') {
              // Chi phí đổi mới = giá vốn tham chiếu của sản phẩm mới.
              const product = await this.db.collection('products').findOne({ _id: (ticket.product as { productId: ObjectId }).productId }, { session, projection: { standardCost: 1 } });
              set['result.cost'] = decimal(decimalString(product?.standardCost ?? '0'));
            }
            notifications.push({
              roles: ['WAREHOUSE_MANAGER', 'WAREHOUSE'],
              level: 'INFO',
              template: 'WARRANTY_STOCK_MOVED',
              params: { code, product, resolution, exchange: stock.exchange?.warehouseName ?? '', defect: stock.defect.warehouseName },
              title: `Bảo hành ${code}: ${resolution === 'EXCHANGED' ? `xuất 1 ${product} đổi cho khách, ` : ''}nhập hàng lỗi vào ${stock.defect.warehouseName}`,
              message: `${customer} — ${product}`,
            });
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
      const result = await this.collection().findOneAndUpdate({ _id: ticketId, version: action.version }, update, { session, returnDocument: 'after' });
      if (!result) throw new ConflictException({ code: 'VERSION_CONFLICT', message: 'Phiếu bảo hành đã được người khác cập nhật, vui lòng tải lại' });

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

  /** Số phiếu đang quá hẹn trả (ô cảnh báo trên dashboard). */
  async overdueCount(): Promise<number> {
    const settings = await warrantySettings(this.db);
    const now = new Date();
    const open = await this.collection().find({ status: { $nin: ['RETURNED', 'CANCELLED'] } }).toArray();
    return open.filter((ticket) => ticketSla(ticket, settings, now).tone === 'overdue').length;
  }
}
