import { type ClientSession } from 'mongodb';
import { ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import type { DebtSegmentInput, SkuAlias, UpdateDebtSegment } from '@inoxpran/contracts';
import Decimal from 'decimal.js';
import { type Db, type Document, ObjectId } from 'mongodb';
import { AuditService } from '../../common/audit.service';
import { decimalString, serializeDocument, toObjectId } from '../../common/domain';
import type { AuthenticatedRequest } from '../../common/request-context';
import { MONGO_DATABASE } from '../../common/tokens';
import { releaseHoldIfCleared } from './overdue-review';
import { ReallocationError } from './reallocate';
import { loadSegmentItems } from './segment-items';
import { DEBT_SEGMENTS, planPartner, reallocatePartner, segmentContext, SKU_ALIASES, writePlan, type PartnerPlan, type WriteSnapshot } from './segment-store';
import { normalizeSku } from './segments';

const STATE = 'debt_segment_state';
const APPLIES = 'debt_segment_applies';
const compact = (sku: string) => normalizeSku(sku).replace(/[^A-Z0-9]/g, '');
/** Trường cấu hình làm đổi số liệu (đổi thì phải Áp dụng lại); đổi mã / tên thì không. */
const RULE_FIELDS = ['categoryIds', 'skus', 'manualOnly', 'active', 'sortOrder', 'scope', 'partnerIds'] as const;
const sameValue = (a: unknown, b: unknown) => JSON.stringify(Array.isArray(a) ? a.map(String).sort() : a ?? null) === JSON.stringify(Array.isArray(b) ? b.map(String).sort() : b ?? null);

/** Đếm chứng từ / phiếu sẽ đổi khi áp dụng kế hoạch phân bổ lại của một khách. */
function changesOf(plan: PartnerPlan) {
  let receivables = 0;
  for (const row of plan.receivables) {
    const next = plan.result.receivables.get((row._id as ObjectId).toHexString());
    if (!next) continue;
    const parts = (list: unknown) => ((list as Document[] | undefined) ?? []).map((part) => `${String(part.code)}:${new Decimal(decimalString(part.amount)).toFixed(2)}:${new Decimal(decimalString(part.paid)).toFixed(2)}`).join(';');
    if (!new Decimal(decimalString(row.paidAmount)).eq(next.paidAmount) || row.status !== next.status || parts(row.segments) !== parts(next.segments)) receivables += 1;
  }
  return { receivables, payments: plan.result.changedPayments.length };
}

/**
 * Nhóm công nợ tách riêng (CN-SEG-01): cấu hình nhóm (Admin), ghép mã hàng cũ trong sổ công nợ với danh mục,
 * xem trước → áp dụng (tính lại phần nhóm + phân bổ lại tiền đã thu của mọi khách) → hoàn tác lần áp dụng gần nhất.
 */
@Injectable()
export class SegmentsService {
  constructor(
    @Inject(MONGO_DATABASE) private readonly db: Db,
    private readonly audit: AuditService,
  ) {}

  private async bumpConfig() {
    await this.db.collection<{ _id: string } & Document>(STATE).updateOne({ _id: 'state' }, { $inc: { configVersion: 1 }, $set: { updatedAt: new Date() } }, { upsert: true });
  }

  private async state() {
    const row = await this.db.collection<{ _id: string } & Document>(STATE).findOne({ _id: 'state' });
    const configVersion = Number(row?.configVersion ?? 0);
    const appliedVersion = row?.appliedVersion === undefined ? -1 : Number(row.appliedVersion);
    return { configVersion, appliedVersion, pending: configVersion !== appliedVersion && configVersion > 0 };
  }

  async list() {
    const [rows, categories, state, last, holdings, tagged] = await Promise.all([
      this.db.collection(DEBT_SEGMENTS).find().sort({ sortOrder: 1, code: 1 }).toArray(),
      this.db.collection('product_categories').find({}, { projection: { code: 1, name: 1 } }).sort({ sortOrder: 1, code: 1 }).toArray(),
      this.state(),
      this.db.collection(APPLIES).find({}, { projection: { snapshot: 0 } }).sort({ appliedAt: -1 }).limit(1).next(),
      // Hàng khách đang nợ của từng nhóm (theo chứng từ còn nợ) và khách đã gắn chứng từ vào nhóm gắn tay.
      loadSegmentItems(this.db),
      this.db.collection('receivables').aggregate([{ $match: { 'segmentTag.code': { $exists: true } } }, { $group: { _id: '$segmentTag.code', partnerIds: { $addToSet: '$partnerId' } } }]).toArray(),
    ]);
    const categoryName = new Map(categories.map((row) => [(row._id as ObjectId).toHexString(), `${String(row.code)} — ${String(row.name)}`]));
    const taggedBy = new Map(tagged.map((row) => [String(row._id), ((row.partnerIds as unknown[]) ?? []).map(String)]));
    const partnerIds = [...new Set([
      ...rows.flatMap((row) => ((row.partnerIds as unknown[]) ?? []).map(String)),
      ...holdings.map((row) => row.partnerId),
      ...[...taggedBy.values()].flat(),
    ])];
    const partners = partnerIds.length
      ? await this.db.collection('partners').find({ _id: { $in: partnerIds.map((id) => new ObjectId(id)) } }, { projection: { code: 1, name: 1 } }).toArray()
      : [];
    const partnerInfo = new Map(partners.map((row) => [(row._id as ObjectId).toHexString(), { id: (row._id as ObjectId).toHexString(), code: String(row.code), name: String(row.name) }]));
    return {
      segments: rows.map((row) => ({
        ...serializeDocument(row),
        scope: row.scope === 'SELECTED' ? 'SELECTED' : 'ALL',
        categoryIds: ((row.categoryIds as unknown[]) ?? []).map(String),
        categoryNames: ((row.categoryIds as unknown[]) ?? []).map((id) => categoryName.get(String(id)) ?? String(id)),
        partnerIds: ((row.partnerIds as unknown[]) ?? []).map(String),
        partners: ((row.partnerIds as unknown[]) ?? []).map((id) => partnerInfo.get(String(id)) ?? { id: String(id), code: '?', name: '' })
          .sort((a, b) => a.code.localeCompare(b.code)),
        // Nhóm gắn tay: khách đã gắn chứng từ (VD nhóm hàng mẫu chỉ của KH015).
        taggedPartners: (taggedBy.get(String(row.code)) ?? []).map((id) => partnerInfo.get(id) ?? { id, code: '?', name: '' }).sort((a, b) => a.code.localeCompare(b.code)),
        holders: holdings.filter((holding) => holding.code === String(row.code)).map((holding) => ({ ...holding, partner: partnerInfo.get(holding.partnerId) ?? { id: holding.partnerId, code: '?', name: '' } }))
          .sort((a, b) => a.partner.code.localeCompare(b.partner.code)),
      })),
      categories: categories.map((row) => ({ id: (row._id as ObjectId).toHexString(), code: String(row.code), name: String(row.name) })),
      state: { ...state, lastApply: last ? serializeDocument(last) : null },
    };
  }

  async create(input: DebtSegmentInput, request: AuthenticatedRequest) {
    if (await this.db.collection(DEBT_SEGMENTS).findOne({ code: input.code })) throw new ConflictException({ code: 'SEGMENT_CODE_EXISTS', message: `Mã nhóm ${input.code} đã có` });
    const now = new Date();
    const doc = {
      _id: new ObjectId(),
      ...input,
      categoryIds: input.categoryIds.map((id) => toObjectId(id, 'categoryId')),
      skus: [...new Set(input.skus.map(normalizeSku))],
      partnerIds: [...new Set(input.partnerIds)].map((id) => toObjectId(id, 'partnerId')),
      createdAt: now, createdBy: request.user.displayName, updatedAt: now, updatedBy: request.user.displayName,
    };
    await this.db.collection(DEBT_SEGMENTS).insertOne(doc);
    await this.bumpConfig();
    await this.audit.record({ actorId: request.user.sub, actorEmail: request.user.email, correlationId: request.correlationId, action: 'DEBT_SEGMENT_CREATED', entityType: 'DebtSegment', entityId: input.code, after: serializeDocument(doc) });
    return serializeDocument(doc);
  }

  async update(code: string, input: UpdateDebtSegment, request: AuthenticatedRequest) {
    const before = await this.db.collection(DEBT_SEGMENTS).findOne({ code });
    if (!before) throw new NotFoundException({ code: 'SEGMENT_NOT_FOUND', message: `Không có nhóm công nợ ${code}` });
    const { code: nextCode, ...fields } = input;
    const renaming = nextCode !== undefined && nextCode !== code;
    if (renaming && await this.db.collection(DEBT_SEGMENTS).findOne({ code: nextCode }, { projection: { _id: 1 } })) {
      throw new ConflictException({ code: 'SEGMENT_CODE_EXISTS', message: `Mã nhóm ${nextCode} đã có` });
    }
    const now = new Date();
    const set: Document = { ...fields, ...(renaming ? { code: nextCode } : {}), updatedAt: now, updatedBy: request.user.displayName };
    if (fields.categoryIds) set.categoryIds = fields.categoryIds.map((id) => toObjectId(id, 'categoryId'));
    if (fields.skus) set.skus = [...new Set(fields.skus.map(normalizeSku))];
    if (fields.partnerIds) set.partnerIds = [...new Set(fields.partnerIds)].map((id) => toObjectId(id, 'partnerId'));
    const session = this.db.client.startSession();
    let after: Document | null = null;
    try {
      await session.withTransaction(async () => {
        after = await this.db.collection(DEBT_SEGMENTS).findOneAndUpdate({ _id: before._id }, { $set: set }, { returnDocument: 'after', session });
        // Đổi mã: chứng từ / phiếu thu đã mang mã cũ đổi theo trong cùng giao dịch.
        if (renaming) await this.renameReferences(code, nextCode as string, session, now, request);
      });
    } finally {
      await session.endSession();
    }
    // Chỉ đổi mã / tên: số liệu không đổi, không cần Áp dụng lại.
    if (RULE_FIELDS.some((key) => fields[key] !== undefined && !sameValue(set[key], before[key]))) await this.bumpConfig();
    await this.audit.record({ actorId: request.user.sub, actorEmail: request.user.email, correlationId: request.correlationId, action: renaming ? 'DEBT_SEGMENT_RENAMED' : 'DEBT_SEGMENT_UPDATED', entityType: 'DebtSegment', entityId: renaming ? (nextCode as string) : code, before: serializeDocument(before), after: after ? serializeDocument(after) : {}, ...(renaming ? { metadata: { from: code, to: nextCode } } : {}) });
    return after ? serializeDocument(after) : null;
  }

  /** Lần áp dụng còn hoàn tác được chụp mã nhóm cũ → khóa lại khi đổi mã / xóa nhóm. */
  private async closeApplies(session: ClientSession, now: Date, reason: string) {
    await this.db.collection(APPLIES).updateMany({ status: 'APPLIED' }, { $set: { status: 'CLOSED', closedAt: now, closedReason: reason } }, { session });
  }

  private async renameReferences(from: string, to: string, session: ClientSession, now: Date, request: AuthenticatedRequest) {
    await this.db.collection('receivables').updateMany({ 'segments.code': from }, { $set: { 'segments.$[part].code': to, updatedAt: now }, $inc: { version: 1 } }, { session, arrayFilters: [{ 'part.code': from }] });
    await this.db.collection('receivables').updateMany({ 'segmentTag.code': from }, { $set: { 'segmentTag.code': to, updatedAt: now }, $inc: { version: 1 } }, { session });
    await this.db.collection('payments').updateMany({ 'allocations.segment': from }, { $set: { 'allocations.$[row].segment': to } }, { session, arrayFilters: [{ 'row.segment': from }] });
    await this.db.collection('payments').updateMany({ segment: from }, { $set: { segment: to } }, { session });
    await this.closeApplies(session, now, `Đổi mã nhóm ${from} → ${to} (${request.user.displayName})`);
  }

  /**
   * Xóa nhóm: gỡ gắn tay và lựa chọn "Thu cho nhóm", phân bổ lại từng khách đang có phần nhóm — phần nhóm về nợ thường
   * (có thể bị tính quá hạn ở lần rà soát tới), tổng nợ không đổi. Một giao dịch; lỗi dữ liệu thì không ghi gì.
   */
  async remove(code: string, request: AuthenticatedRequest) {
    const session = this.db.client.startSession();
    try {
      let result: Record<string, unknown> = {};
      await session.withTransaction(async () => {
        const segment = await this.db.collection(DEBT_SEGMENTS).findOne({ code }, { session });
        if (!segment) throw new NotFoundException({ code: 'SEGMENT_NOT_FOUND', message: `Không có nhóm công nợ ${code}` });
        const [docPartners, paymentPartners, open] = await Promise.all([
          this.db.collection('receivables').distinct('partnerId', { $or: [{ 'segments.code': code }, { 'segmentTag.code': code }] }, { session }),
          this.db.collection('payments').distinct('partnerId', { $or: [{ segment: code }, { 'allocations.segment': code }] }, { session }),
          this.db.collection('receivables').find({ 'segments.code': code }, { projection: { segments: 1 }, session }).toArray(),
        ]);
        let moved = new Decimal(0);
        for (const row of open) {
          for (const part of (row.segments as Document[] | undefined) ?? []) {
            if (part.code === code) moved = moved.add(decimalString(part.amount)).minus(decimalString(part.paid ?? '0'));
          }
        }
        const partnerIds = [...new Set([...docPartners, ...paymentPartners].map(String))].map((id) => new ObjectId(id));
        const now = new Date();
        await this.db.collection(DEBT_SEGMENTS).deleteOne({ _id: segment._id }, { session });
        await this.db.collection('receivables').updateMany({ 'segmentTag.code': code }, { $unset: { segmentTag: '' }, $set: { updatedAt: now }, $inc: { version: 1 } }, { session });
        await this.db.collection('payments').updateMany({ segment: code }, { $unset: { segment: '' } }, { session });
        const partners = await this.db.collection('partners').find({ _id: { $in: partnerIds } }, { projection: { code: 1 }, session }).toArray();
        const codeOf = new Map(partners.map((row) => [(row._id as ObjectId).toHexString(), String(row.code)]));
        for (const partnerId of partnerIds) {
          try {
            await reallocatePartner(this.db, partnerId, session, now);
          } catch (error) {
            if (!(error instanceof ReallocationError)) throw error;
            throw new ConflictException({ code: 'SEGMENT_DELETE_BLOCKED', message: `Không xóa được nhóm ${code}: ${codeOf.get(partnerId.toHexString()) ?? partnerId.toHexString()} — ${error.message}` });
          }
        }
        await this.closeApplies(session, now, `Xóa nhóm ${code} (${request.user.displayName})`);
        await this.audit.record({
          actorId: request.user.sub, actorEmail: request.user.email, correlationId: request.correlationId,
          action: 'DEBT_SEGMENT_DELETED', entityType: 'DebtSegment', entityId: code, before: serializeDocument(segment),
          metadata: { customers: partnerIds.map((id) => codeOf.get(id.toHexString()) ?? id.toHexString()), movedToNormal: moved.toFixed(2) },
        }, session);
        result = { code, customers: partnerIds.length, movedToNormal: moved.toFixed(2) };
      });
      return result;
    } finally {
      await session.endSession();
    }
  }

  /**
   * Bật / tắt một khách trong nhóm "chọn khách" (VD cho NPP nợ riêng quạt) — từ sổ công nợ của khách.
   * Tính lại phần nhóm và phân bổ lại tiền đã thu của riêng khách đó ngay, không cần Áp dụng cho mọi khách.
   */
  async setPartner(code: string, partnerId: string, enabled: boolean, request: AuthenticatedRequest) {
    const id = toObjectId(partnerId, 'partnerId');
    const session = this.db.client.startSession();
    try {
      let result: Record<string, unknown> = {};
      await session.withTransaction(async () => {
        const segment = await this.db.collection(DEBT_SEGMENTS).findOne({ code }, { session });
        if (!segment) throw new NotFoundException({ code: 'SEGMENT_NOT_FOUND', message: `Không có nhóm công nợ ${code}` });
        if (segment.scope !== 'SELECTED') throw new ConflictException({ code: 'SEGMENT_SCOPE_ALL', message: 'Nhóm này áp dụng cho mọi khách — không cần bật riêng' });
        const partner = await this.db.collection('partners').findOne({ _id: id, kind: { $in: ['CUSTOMER', 'BOTH'] } }, { session, projection: { code: 1, name: 1 } });
        if (!partner) throw new NotFoundException({ code: 'PARTNER_NOT_FOUND', message: 'Không tìm thấy khách hàng' });
        const now = new Date();
        await this.db.collection(DEBT_SEGMENTS).updateOne(
          { _id: segment._id },
          { ...(enabled ? { $addToSet: { partnerIds: id } } : { $pull: { partnerIds: id } }), $set: { updatedAt: now, updatedBy: request.user.displayName } } as Document,
          { session },
        );
        const { plan } = await reallocatePartner(this.db, id, session, now);
        const released = await releaseHoldIfCleared(this.db, id, session, now);
        await this.audit.record({
          actorId: request.user.sub, actorEmail: request.user.email, correlationId: request.correlationId,
          action: 'DEBT_SEGMENT_PARTNER_CHANGED', entityType: 'DebtSegment', entityId: code,
          after: { partnerCode: partner.code, enabled }, metadata: { before: plan.before, after: plan.after, partnerHoldReleased: released },
        }, session);
        result = { code, partnerId, enabled, summary: plan.after, partnerHoldReleased: released };
      });
      return result;
    } finally {
      await session.endSession();
    }
  }

  /** Mã hàng trong dòng hàng chứng từ lịch sử: mã khớp danh mục / đã ghép / chưa ghép (kèm gợi ý). */
  async skuReport() {
    const unwind = (collection: string) => this.db.collection(collection).aggregate([
      { $match: { 'historyLines.0': { $exists: true } } },
      { $unwind: '$historyLines' },
      { $group: { _id: '$historyLines.sku', lines: { $sum: 1 }, name: { $first: '$historyLines.productName' } } },
    ]).toArray();
    const [fromReceivables, fromPayments, products, aliases] = await Promise.all([
      unwind('receivables'),
      unwind('payments'),
      this.db.collection('products').find({}, { projection: { sku: 1, name: 1, categoryId: 1 } }).toArray(),
      this.db.collection(SKU_ALIASES).find().toArray(),
    ]);
    const bySku = new Map<string, { sku: string; lines: number; name: string }>();
    for (const row of [...fromReceivables, ...fromPayments]) {
      const sku = normalizeSku(row._id as string);
      if (!sku) continue;
      const entry = bySku.get(sku) ?? { sku: String(row._id).trim(), lines: 0, name: String(row.name ?? '') };
      entry.lines += Number(row.lines ?? 0);
      bySku.set(sku, entry);
    }
    const catalog = new Map(products.map((row) => [normalizeSku(String(row.sku)), row]));
    const aliasOf = new Map(aliases.map((row) => [normalizeSku(String(row.oldSku)), row]));
    const suggestions = (sku: string) => {
      const base = compact(sku.replace(/\(.*$/, ''));
      const keys = new Set([base, base.startsWith('NP') ? `I${base}` : '', /[A-Z]$/.test(base) ? base.slice(0, -1) : ''].filter(Boolean));
      // Mã trùng khít (bỏ gạch / khoảng trắng, VD INP1301B = INP1301-B) đứng đầu để gợi ý điền sẵn đúng.
      const exact = (row: Document) => (keys.has(compact(String(row.sku))) ? 0 : 1);
      return products
        .filter((row) => [...keys].some((key) => compact(String(row.sku)) === key || compact(String(row.sku)).startsWith(key)))
        .sort((a, b) => exact(a) - exact(b) || String(a.sku).localeCompare(String(b.sku)))
        .slice(0, 6)
        .map((row) => ({ sku: String(row.sku), name: String(row.name) }));
    };
    const rows = [...bySku.entries()].map(([key, entry]) => {
      const alias = aliasOf.get(key);
      const status = catalog.has(key) ? 'CATALOG' : alias ? 'ALIAS' : 'MISSING';
      return { ...entry, status, ...(alias ? { productSku: String(alias.productSku) } : {}), ...(status === 'CATALOG' ? {} : { suggestions: suggestions(key) }) };
    }).sort((a, b) => (a.status === 'MISSING' ? 0 : a.status === 'ALIAS' ? 1 : 2) - (b.status === 'MISSING' ? 0 : b.status === 'ALIAS' ? 1 : 2) || a.sku.localeCompare(b.sku));
    return {
      rows: rows.filter((row) => row.status !== 'CATALOG'),
      counts: { total: rows.length, catalog: rows.filter((row) => row.status === 'CATALOG').length, alias: rows.filter((row) => row.status === 'ALIAS').length, missing: rows.filter((row) => row.status === 'MISSING').length },
    };
  }

  async setAlias(input: SkuAlias, request: AuthenticatedRequest) {
    const oldSku = normalizeSku(input.oldSku);
    if (!input.productSku) {
      await this.db.collection(SKU_ALIASES).deleteOne({ oldSku });
    } else {
      const product = await this.db.collection('products').findOne({ sku: { $regex: `^${input.productSku.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, $options: 'i' } });
      if (!product) throw new NotFoundException({ code: 'PRODUCT_NOT_FOUND', message: `Không có mã ${input.productSku} trong danh mục` });
      await this.db.collection(SKU_ALIASES).updateOne(
        { oldSku },
        { $set: { oldSku, productId: product._id, productSku: String(product.sku), updatedAt: new Date(), updatedBy: request.user.displayName } },
        { upsert: true },
      );
    }
    await this.bumpConfig();
    await this.audit.record({ actorId: request.user.sub, actorEmail: request.user.email, correlationId: request.correlationId, action: 'SKU_ALIAS_SET', entityType: 'SkuAlias', entityId: oldSku, after: { productSku: input.productSku } });
    return { oldSku, productSku: input.productSku };
  }

  /** Tính kế hoạch cho mọi khách có công nợ (không ghi). */
  private async plans(session?: Parameters<typeof planPartner>[3]) {
    const ctx = await segmentContext(this.db, session);
    const partnerIds = (await this.db.collection('receivables').distinct('partnerId', {}, session ? { session } : {})) as ObjectId[];
    const partners = await this.db.collection('partners').find({ _id: { $in: partnerIds } }, { projection: { code: 1, name: 1 }, ...(session ? { session } : {}) }).toArray();
    const info = new Map(partners.map((row) => [(row._id as ObjectId).toHexString(), row]));
    const now = new Date();
    const results: Array<{ partnerId: ObjectId; code: string; name: string; plan?: PartnerPlan; error?: string }> = [];
    for (const partnerId of partnerIds) {
      const partner = info.get(partnerId.toHexString());
      const base = { partnerId, code: String(partner?.code ?? ''), name: String(partner?.name ?? '') };
      try {
        results.push({ ...base, plan: await planPartner(this.db, partnerId, ctx, session, now) });
      } catch (error) {
        if (!(error instanceof ReallocationError)) throw error;
        results.push({ ...base, error: error.message });
      }
    }
    return results;
  }

  private static row(item: Awaited<ReturnType<SegmentsService['plans']>>[number]) {
    return {
      partnerId: item.partnerId.toHexString(),
      code: item.code,
      name: item.name,
      ...(item.plan ? { before: item.plan.before, after: item.plan.after, changes: changesOf(item.plan) } : {}),
      ...(item.error ? { error: item.error } : {}),
    };
  }

  /** Xem trước theo từng khách: nợ nhóm, nợ thường, nợ thường quá hạn trên 60 ngày — trước / sau khi áp dụng. */
  async preview() {
    const results = await this.plans();
    const rows = results.map(SegmentsService.row)
      .filter((row) => row.error || (row.changes && (row.changes.receivables || row.changes.payments)) || (row.after && new Decimal(row.after.segment).gt(0)))
      .sort((a, b) => Number(Boolean(b.error)) - Number(Boolean(a.error)) || new Decimal(b.after?.segment ?? 0).comparedTo(a.after?.segment ?? 0) || a.code.localeCompare(b.code));
    const total = (pick: (row: (typeof rows)[number]) => string | undefined) => rows.reduce((sum, row) => sum.add(pick(row) ?? 0), new Decimal(0)).toFixed(2);
    return {
      state: await this.state(),
      rows,
      totals: {
        segmentBefore: total((row) => row.before?.segment), segmentAfter: total((row) => row.after?.segment),
        overdue60Before: total((row) => row.before?.overdue60), overdue60After: total((row) => row.after?.overdue60),
      },
      errors: rows.filter((row) => row.error).length,
    };
  }

  /** Áp dụng cho mọi khách trong một giao dịch; lưu trạng thái trước để hoàn tác. Có khách lỗi dữ liệu thì không ghi gì. */
  async apply(request: AuthenticatedRequest) {
    const session = this.db.client.startSession();
    try {
      let result: Record<string, unknown> = {};
      await session.withTransaction(async () => {
        const results = await this.plans(session);
        const failed = results.filter((item) => item.error);
        if (failed.length) {
          throw new ConflictException({ code: 'SEGMENT_APPLY_BLOCKED', message: `${failed.length} khách có dữ liệu công nợ không khớp — xem danh sách lỗi ở bản xem trước`, details: failed.map((item) => `${item.code}: ${item.error}`).slice(0, 20) });
        }
        const now = new Date();
        const snapshot: WriteSnapshot = { receivables: [], payments: [] };
        const released: string[] = [];
        for (const item of results) {
          const written = await writePlan(this.db, item.plan as PartnerPlan, session, now);
          snapshot.receivables.push(...written.receivables);
          snapshot.payments.push(...written.payments);
          if (await releaseHoldIfCleared(this.db, item.partnerId, session, now)) released.push(item.code);
        }
        const state = await this.state();
        const rows = results.map(SegmentsService.row).filter((row) => row.changes && (row.changes.receivables || row.changes.payments));
        const doc = {
          _id: new ObjectId(),
          appliedAt: now,
          appliedBy: request.user.displayName,
          appliedById: toObjectId(request.user.sub),
          configVersion: state.configVersion,
          status: 'APPLIED',
          customers: rows,
          counts: { customers: rows.length, receivables: snapshot.receivables.length, payments: snapshot.payments.length },
          released,
          snapshot,
        };
        await this.db.collection(APPLIES).insertOne(doc, { session });
        await this.db.collection<{ _id: string } & Document>(STATE).updateOne({ _id: 'state' }, { $set: { appliedVersion: state.configVersion, lastApplyId: doc._id, updatedAt: now } }, { upsert: true, session });
        await this.audit.record({ actorId: request.user.sub, actorEmail: request.user.email, correlationId: request.correlationId, action: 'DEBT_SEGMENTS_APPLIED', entityType: 'DebtSegmentApply', entityId: doc._id.toHexString(), metadata: { ...doc.counts, released } }, session);
        const { snapshot: _snapshot, ...summary } = doc;
        result = serializeDocument(summary);
      });
      return result;
    } finally {
      await session.endSession();
    }
  }

  async applies() {
    const rows = await this.db.collection(APPLIES).find({}, { projection: { snapshot: 0, customers: 0 } }).sort({ appliedAt: -1 }).limit(20).toArray();
    return rows.map((row) => serializeDocument(row));
  }

  /** Hoàn tác lần áp dụng gần nhất khi các chứng từ đã đổi chưa bị thu / sửa tiếp. */
  async undo(id: string, request: AuthenticatedRequest) {
    const session = this.db.client.startSession();
    try {
      let result: Record<string, unknown> = {};
      await session.withTransaction(async () => {
        const doc = await this.db.collection(APPLIES).findOne({ _id: toObjectId(id) }, { session });
        if (!doc || doc.status !== 'APPLIED') throw new ConflictException({ code: 'SEGMENT_APPLY_STATE', message: 'Lần áp dụng này không còn hoàn tác được' });
        const later = await this.db.collection(APPLIES).findOne({ status: 'APPLIED', appliedAt: { $gt: doc.appliedAt } }, { session, projection: { _id: 1 } });
        if (later) throw new ConflictException({ code: 'SEGMENT_APPLY_STATE', message: 'Chỉ hoàn tác được lần áp dụng gần nhất' });
        const snapshot = doc.snapshot as WriteSnapshot;
        const now = new Date();
        for (const row of snapshot.receivables) {
          const restored = await this.db.collection('receivables').updateOne(
            { _id: row._id, version: row.version },
            {
              $set: { paidAmount: row.paidAmount, status: row.status, updatedAt: now, ...(row.segments ? { segments: row.segments } : {}) },
              ...(row.segments ? {} : { $unset: { segments: '' } }),
              $inc: { version: 1 },
            },
            { session },
          );
          if (restored.matchedCount !== 1) throw new ConflictException({ code: 'SEGMENT_UNDO_BLOCKED', message: 'Có chứng từ đã thay đổi sau khi áp dụng (thu tiền / sửa phiếu) — không hoàn tác được' });
        }
        for (const row of snapshot.payments) {
          const restored = await this.db.collection('payments').updateOne({ _id: row._id, reallocatedAt: doc.appliedAt }, { $set: { allocations: row.allocations }, $unset: { reallocatedAt: '' } }, { session });
          if (restored.matchedCount !== 1) throw new ConflictException({ code: 'SEGMENT_UNDO_BLOCKED', message: 'Có phiếu thu đã được phân bổ lại sau lần áp dụng này — không hoàn tác được' });
        }
        await this.db.collection(APPLIES).updateOne({ _id: doc._id }, { $set: { status: 'UNDONE', undoneAt: now, undoneBy: request.user.displayName } }, { session });
        await this.db.collection<{ _id: string } & Document>(STATE).updateOne({ _id: 'state' }, { $set: { appliedVersion: -1, updatedAt: now } }, { upsert: true, session });
        await this.audit.record({ actorId: request.user.sub, actorEmail: request.user.email, correlationId: request.correlationId, action: 'DEBT_SEGMENTS_UNDONE', entityType: 'DebtSegmentApply', entityId: id, metadata: doc.counts as Record<string, unknown> }, session);
        result = { id, status: 'UNDONE', counts: doc.counts };
      });
      return result;
    } finally {
      await session.endSession();
    }
  }
}
