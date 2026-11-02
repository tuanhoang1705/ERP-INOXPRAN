import { BadRequestException, ConflictException, ForbiddenException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import type { ConvertPartner, EmployeeInput, LocationInput, PartnerAddress, PartnerContact, ProductCategoryInput, RegionInput, UpdatePartner, UpdateProduct, UpdateWarehouse } from '@inoxpran/contracts';
import Decimal from 'decimal.js';
import type { ClientSession, Db, Document } from 'mongodb';
import { ObjectId } from 'mongodb';
import { AuditService } from '../../common/audit.service';
import { EvidenceIntakeService } from '../../common/evidence-intake.service';
import { decimal, decimalString, serializeDocument, toObjectId } from '../../common/domain';
import type { AuthenticatedRequest } from '../../common/request-context';
import { MONGO_DATABASE } from '../../common/tokens';
import { canChangeCreditTerms, canConvertProspect, canManagePartnerKind } from './partner-access';
import { enforceTerritory, normalizeProvinces } from '../../common/territories';

type Status = 'ACTIVE' | 'INACTIVE';
type Patch<T> = { [Key in keyof T]?: T[Key] | undefined };
/** Một chỗ đang dùng bản ghi: collection + điều kiện + nhãn hiển thị khi báo không xóa được. */
interface Usage { collection: string; filter: Document; label: string }

function actor(request: AuthenticatedRequest) {
  return { actorId: request.user.sub, actorEmail: request.user.email, correlationId: request.correlationId };
}

const isDuplicate = (error: unknown) => (error as { code?: number }).code === 11000;
/** Trường người có quyền công nợ (kế toán) được sửa trên hồ sơ khách dù không quản lý hồ sơ. */
const CREDIT_ONLY_KEYS = new Set(['version', 'creditLimit', 'paymentTermDays', 'status', 'holdReason']);

/** Tên trường cần $unset (danh sách `clear` của PATCH); trường vừa gửi giá trị mới thì không xóa. */
function unsetOf(clear: readonly string[] | undefined, set: Document): Document {
  return Object.fromEntries((clear ?? []).filter((field) => !(field in set) || set[field] === undefined).map((field) => [field, '']));
}

/** Tối đa một người liên hệ chính / một địa chỉ mặc định; có danh sách mà chưa chọn thì lấy dòng đầu. */
export function normalizePartnerLists<T extends { contacts?: PartnerContact[] | undefined; addresses?: PartnerAddress[] | undefined }>(input: T): T {
  const result = { ...input };
  if (input.contacts) {
    const primary = Math.max(0, input.contacts.findIndex((row) => row.primary));
    result.contacts = input.contacts.map((row, index) => ({ ...row, primary: index === primary }));
  }
  if (input.addresses) {
    const preferred = Math.max(0, input.addresses.findIndex((row) => row.isDefault));
    result.addresses = input.addresses.map((row, index) => ({ ...row, isDefault: index === preferred }));
  }
  return result;
}

/**
 * Thêm / sửa / xóa danh mục nền: sản phẩm, nhóm hàng, đối tác, kho, vị trí lưu, khu vực, nhân viên kinh doanh.
 * Xóa chỉ khi bản ghi chưa phát sinh chứng từ; đã dùng thì trả 409 *_IN_USE và gợi ý chuyển "Ngừng sử dụng"
 * để giữ nguyên lịch sử (thẻ kho, phiếu bán, công nợ). Mọi thay đổi ghi nhật ký (audit) kèm trước / sau.
 */
@Injectable()
export class MasterDataService {
  constructor(
    @Inject(MONGO_DATABASE) private readonly db: Db,
    private readonly audit: AuditService,
    private readonly evidence: EvidenceIntakeService,
  ) {}

  // ---------- dùng chung ----------

  private async usages(checks: Usage[], session?: ClientSession): Promise<string[]> {
    const found = await Promise.all(checks.map(async (check) => ((await this.db.collection(check.collection).findOne(check.filter, { projection: { _id: 1 }, ...(session ? { session } : {}) })) ? check.label : null)));
    return found.filter((label): label is string => label !== null);
  }

  private async assertUnused(code: string, name: string, checks: Usage[], hint = 'Hãy chuyển sang "Ngừng sử dụng" để giữ lịch sử chứng từ.', extra?: Document): Promise<void> {
    const usedBy = await this.usages(checks);
    if (usedBy.length) {
      throw new ConflictException({
        code,
        message: `Không xóa được ${name}: đã phát sinh ở ${usedBy.join(', ')}. ${hint}`,
        details: { usedBy, ...(extra ?? {}) },
      });
    }
  }

  private async load(collection: string, id: string, code: string, message: string) {
    const document = await this.db.collection(collection).findOne({ _id: toObjectId(id) });
    if (!document) throw new NotFoundException({ code, message });
    return document;
  }

  private async record(request: AuthenticatedRequest, action: string, entityType: string, entityId: string, before?: Document | null, after?: Document | null) {
    await this.audit.record({
      ...actor(request),
      action,
      entityType,
      entityId,
      ...(before ? { before: serializeDocument(before) } : {}),
      ...(after ? { after: serializeDocument(after) } : {}),
    });
  }

  // ---------- sản phẩm ----------

  /** Nhà cung cấp mặc định (kèm tên để hiển thị) và ảnh đại diện (phải là ảnh của chính sản phẩm). */
  async productRefs(input: { defaultSupplierId?: string | undefined; primaryImageId?: string | undefined }, productId?: ObjectId): Promise<Document> {
    const refs: Document = {};
    if (input.defaultSupplierId) {
      const supplier = await this.db.collection('partners').findOne({ _id: toObjectId(input.defaultSupplierId, 'defaultSupplierId'), kind: { $in: ['SUPPLIER', 'BOTH'] } });
      if (!supplier) throw new BadRequestException({ code: 'SUPPLIER_NOT_FOUND', message: 'Không tìm thấy nhà cung cấp' });
      Object.assign(refs, { defaultSupplierId: supplier._id, defaultSupplierName: String(supplier.name) });
    }
    if (input.primaryImageId) {
      const image = productId
        ? await this.db.collection('attachments').findOne({ _id: toObjectId(input.primaryImageId, 'primaryImageId'), entityType: 'Product', entityId: productId, purpose: 'PRODUCT_IMAGE' })
        : null;
      if (!image) throw new BadRequestException({ code: 'IMAGE_NOT_FOUND', message: 'Ảnh đại diện phải là ảnh đã tải lên của sản phẩm' });
      refs.primaryImageId = image._id;
    }
    return refs;
  }

  async updateProduct(id: string, input: Patch<UpdateProduct> & { version: number }, request: AuthenticatedRequest) {
    const objectId = toObjectId(id);
    const before = await this.load('products', id, 'PRODUCT_NOT_FOUND', 'Không tìm thấy sản phẩm');
    const update: Document = { ...input, updatedAt: new Date(), ...(await this.productRefs(input, objectId)) };
    delete update.version;
    delete update.clear;
    const unset = unsetOf(input.clear, update);
    if ('defaultSupplierId' in unset) unset.defaultSupplierName = '';
    if (input.categoryId !== undefined) {
      const category = await this.db.collection('product_categories').findOne({ _id: toObjectId(input.categoryId, 'categoryId') });
      if (!category) throw new BadRequestException({ code: 'CATEGORY_NOT_FOUND', message: 'Không tìm thấy nhóm hàng' });
      update.categoryId = category._id;
    }
    if (input.listPrice !== undefined) update.listPrice = decimal(input.listPrice);
    if (input.standardCost !== undefined) update.standardCost = decimal(input.standardCost);
    if (input.minimumStock !== undefined) update.minimumStock = decimal(input.minimumStock);
    if (input.unitConversions !== undefined) {
      update.unitConversions = input.unitConversions.map((item) => ({ ...item, factorToBase: decimal(item.factorToBase) }));
    }
    const result = await this.db.collection('products').findOneAndUpdate(
      { _id: objectId, version: input.version },
      { $set: update, $inc: { version: 1 }, ...(Object.keys(unset).length ? { $unset: unset } : {}) },
      { returnDocument: 'after' },
    );
    if (!result) throw new ConflictException({ code: 'VERSION_CONFLICT', message: 'Sản phẩm đã được người khác cập nhật, hãy tải lại rồi sửa' });
    await this.record(request, 'PRODUCT_UPDATED', 'Product', id, before, result);
    return serializeDocument(result);
  }

  async deleteProduct(id: string, request: AuthenticatedRequest) {
    const before = await this.load('products', id, 'PRODUCT_NOT_FOUND', 'Không tìm thấy sản phẩm');
    const productId = before._id as ObjectId;
    // Mã chỉ có tồn đầu kỳ nhập từ Excel: báo kèm "purgeable" để quản trị gốc chọn gỡ hẳn (CAT-PURGE-01).
    const purgeable = (await this.purgePlan([productId]))[0]?.blockers.length === 0;
    await this.assertUnused('PRODUCT_IN_USE', `mã ${String(before.sku)}`, [
      { collection: 'inventory_movements', filter: { productId }, label: 'thẻ kho' },
      { collection: 'inventory_balances', filter: { productId }, label: 'tồn kho' },
      { collection: 'sales_orders', filter: { 'lines.productId': productId }, label: 'phiếu bán hàng' },
      { collection: 'purchase_orders', filter: { 'lines.productId': productId }, label: 'đơn mua hàng' },
      { collection: 'price_books', filter: { 'lines.productId': productId }, label: 'bảng giá' },
      { collection: 'promotions', filter: { productIds: productId }, label: 'chương trình khuyến mãi' },
      { collection: 'warranty_tickets', filter: { 'product.productId': productId }, label: 'phiếu bảo hành' },
    ], purgeable ? 'Mã chỉ có tồn đầu kỳ nhập từ Excel — quản trị gốc có thể "Gỡ hẳn cả tồn đầu kỳ".' : undefined, purgeable ? { purgeable: true } : undefined);
    await this.evidence.removeAllFor('Product', productId);
    // Giá riêng của khách cho mã này (PRI-CUST-01) là cấu hình, xóa theo mã.
    await this.db.collection('customer_prices').deleteMany({ productId });
    await this.db.collection('products').deleteOne({ _id: productId });
    await this.record(request, 'PRODUCT_DELETED', 'Product', id, before);
  }

  // ---------- gỡ hẳn mã hàng chỉ có tồn đầu kỳ (CAT-PURGE-01, 14/10/2026) ----------

  /**
   * Mã gỡ được khi chỉ có dòng "Tồn đầu kỳ" nhập từ Excel (kể cả dòng hoàn tác lô): không phiếu bán / mua / lô nhập / bảng giá /
   * khuyến mãi / bảo hành / trả hàng / chuyển kho / kiểm kê, không phát sinh thẻ kho khác, không có hàng giữ chỗ.
   */
  async purgePlan(productIds: ObjectId[], session?: ClientSession) {
    const options = session ? { session } : {};
    const [products, warehouses] = await Promise.all([
      this.db.collection('products').find({ _id: { $in: productIds } }, options).sort({ sku: 1 }).toArray(),
      this.db.collection('warehouses').find({}, { projection: { code: 1 }, ...options }).toArray(),
    ]);
    const warehouseCode = new Map(warehouses.map((row) => [String(row._id), String(row.code)]));
    const rows = [];
    for (const product of products) {
      const productId = product._id as ObjectId;
      const blockers = await this.usages([
        { collection: 'inventory_movements', filter: { productId, $nor: [{ movementType: 'OPENING', referenceType: 'ImportBatch' }, { movementType: 'REVERSAL', referenceType: 'ImportBatchRollback' }] }, label: 'thẻ kho có phát sinh ngoài tồn đầu kỳ' },
        { collection: 'inventory_balances', filter: { productId, reserved: { $gt: decimal('0') } }, label: 'hàng đang giữ chỗ' },
        { collection: 'sales_orders', filter: { 'lines.productId': productId }, label: 'phiếu bán hàng' },
        { collection: 'purchase_orders', filter: { 'lines.productId': productId }, label: 'đơn mua hàng' },
        { collection: 'import_shipments', filter: { 'lines.productId': productId }, label: 'lô hàng nhập' },
        { collection: 'price_books', filter: { 'lines.productId': productId }, label: 'bảng giá' },
        { collection: 'promotions', filter: { productIds: productId }, label: 'chương trình khuyến mãi' },
        { collection: 'warranty_tickets', filter: { 'product.productId': productId }, label: 'phiếu bảo hành' },
        { collection: 'stock_returns', filter: { 'lines.productId': productId }, label: 'phiếu trả hàng' },
        { collection: 'inventory_transfers', filter: { 'lines.productId': productId }, label: 'phiếu chuyển kho' },
        { collection: 'stock_counts', filter: { $or: [{ 'skuStep.entries.productId': productId }, { 'qtyStep.entries.productId': productId }, { 'adjustments.productId': productId }] }, label: 'phiếu kiểm kê' },
      ], session);
      const balances = await this.db.collection('inventory_balances').find({ productId }, options).toArray();
      const opening = balances.map((row) => ({ warehouse: warehouseCode.get(String(row.warehouseId)) ?? String(row.warehouseId), quantity: decimalString(row.onHand) }));
      rows.push({
        id: productId.toHexString(),
        sku: String(product.sku),
        name: String(product.name),
        unit: String(product.baseUnit ?? ''),
        opening,
        total: opening.reduce((sum, row) => sum.add(row.quantity), new Decimal(0)).toString(),
        blockers,
      });
    }
    return rows;
  }

  async categoryPurgePreview(id: string) {
    const category = await this.load('product_categories', id, 'CATEGORY_NOT_FOUND', 'Không tìm thấy nhóm hàng');
    const products = await this.db.collection('products').find({ categoryId: category._id }, { projection: { _id: 1 } }).toArray();
    const rows = await this.purgePlan(products.map((row) => row._id as ObjectId));
    return {
      category: { id, code: String(category.code), name: String(category.name) },
      products: rows,
      total: rows.reduce((sum, row) => sum.add(row.total), new Decimal(0)).toString(),
      blocked: rows.filter((row) => row.blockers.length).length,
    };
  }

  /** Quản trị gốc gỡ cả nhóm (gõ lại đúng mã nhóm để xác nhận). */
  async purgeCategory(id: string, confirm: string, request: AuthenticatedRequest) {
    const category = await this.load('product_categories', id, 'CATEGORY_NOT_FOUND', 'Không tìm thấy nhóm hàng');
    if (confirm.trim().toUpperCase() !== String(category.code).toUpperCase()) {
      throw new BadRequestException({ code: 'PURGE_CONFIRM_MISMATCH', message: `Gõ đúng mã nhóm "${String(category.code)}" để xác nhận` });
    }
    const products = await this.db.collection('products').find({ categoryId: category._id }, { projection: { _id: 1 } }).toArray();
    return this.purgeProducts(products.map((row) => row._id as ObjectId), request, category);
  }

  async purgeProduct(id: string, request: AuthenticatedRequest) {
    await this.load('products', id, 'PRODUCT_NOT_FOUND', 'Không tìm thấy sản phẩm');
    return this.purgeProducts([toObjectId(id)], request);
  }

  /**
   * Gỡ hẳn (một giao dịch): dòng tồn đầu kỳ trên thẻ kho, dòng tồn, mã hàng; lô nhập Excel bỏ các dòng tồn đầu kỳ / mã đã tạo
   * tương ứng (đối chiếu lô vẫn khớp); nhóm không còn mã thì xóa nhóm. Có mã bị chặn thì không gỡ gì.
   */
  private async purgeProducts(productIds: ObjectId[], request: AuthenticatedRequest, category?: Document) {
    const session = this.db.client.startSession();
    let result: Document = {};
    try {
      await session.withTransaction(async () => {
        const plan = await this.purgePlan(productIds, session);
        const blocked = plan.filter((row) => row.blockers.length);
        if (blocked.length) {
          throw new ConflictException({
            code: 'PRODUCT_PURGE_BLOCKED',
            message: `Không gỡ được: ${blocked.map((row) => `${row.sku} (${row.blockers.join(', ')})`).join('; ')}`,
            details: { blocked: blocked.map((row) => ({ sku: row.sku, blockers: row.blockers })) },
          });
        }
        const ids = plan.map((row) => new ObjectId(row.id));
        const products = await this.db.collection('products').find({ _id: { $in: ids } }, { session }).toArray();
        const movements = await this.db.collection('inventory_movements').find({ productId: { $in: ids } }, { session, projection: { productId: 1, referenceId: 1, movementType: 1, direction: 1, quantity: 1 } }).toArray();
        const batches = await this.db.collection('import_batches').find({
          $or: [{ 'openings.productId': { $in: ids } }, { 'created.products': { $in: ids } }, ...(category ? [{ 'created.product_categories': category._id }] : [])],
        }, { session }).toArray();
        await this.db.collection('inventory_movements').deleteMany({ productId: { $in: ids } }, { session });
        await this.db.collection('inventory_balances').deleteMany({ productId: { $in: ids } }, { session });
        await this.db.collection('customer_prices').deleteMany({ productId: { $in: ids } }, { session });
        await this.db.collection('products').deleteMany({ _id: { $in: ids } }, { session });
        const categoryEmpty = category ? (await this.db.collection('products').countDocuments({ categoryId: category._id }, { session })) === 0 : false;
        for (const batch of batches) {
          const removed = ((batch.openings as Document[] | undefined) ?? [])
            .filter((row) => ids.some((id) => id.equals(row.productId as ObjectId)) && row.direction !== 'OUT')
            .reduce<Decimal>((sum, row) => sum.add(String(row.next ?? row.quantity ?? 0)), new Decimal(0));
          const totals = batch.totals as Document | undefined;
          await this.db.collection('import_batches').updateOne(
            { _id: batch._id },
            {
              $pull: { openings: { productId: { $in: ids } }, 'created.products': { $in: ids }, ...(categoryEmpty && category ? { 'created.product_categories': category._id } : {}) } as Document,
              ...(totals?.stockQuantity !== undefined && removed.gt(0) ? { $set: { 'totals.stockQuantity': new Decimal(String(totals.stockQuantity)).sub(removed).toString() } } : {}),
            },
            { session },
          );
        }
        if (categoryEmpty && category) await this.db.collection('product_categories').deleteOne({ _id: category._id }, { session });
        const actor = { actorId: request.user.sub, actorEmail: request.user.email, correlationId: request.correlationId };
        for (const product of products) {
          const row = plan.find((item) => item.id === (product._id as ObjectId).toHexString());
          await this.audit.record({
            ...actor, action: 'PRODUCT_PURGED', entityType: 'Product', entityId: (product._id as ObjectId).toHexString(),
            before: serializeDocument(product),
            metadata: {
              opening: row?.opening ?? [],
              batches: [...new Set(movements.filter((item) => (item.productId as ObjectId).equals(product._id as ObjectId)).map((item) => String(item.referenceId)))],
            },
          }, session);
        }
        if (categoryEmpty && category) {
          await this.audit.record({ ...actor, action: 'CATEGORY_DELETED', entityType: 'ProductCategory', entityId: (category._id as ObjectId).toHexString(), before: serializeDocument(category), metadata: { purged: products.length } }, session);
        }
        result = {
          removed: products.length,
          skus: products.map((row) => String(row.sku)),
          openingQuantity: plan.reduce((sum, row) => sum.add(row.total), new Decimal(0)).toString(),
          categoryDeleted: categoryEmpty,
        };
      });
    } finally {
      await session.endSession();
    }
    for (const id of productIds) await this.evidence.removeAllFor('Product', id).catch(() => 0);
    return result;
  }

  // ---------- nhóm hàng ----------

  async listCategories(includeInactive: boolean) {
    const rows = await this.db.collection('product_categories').aggregate([
      ...(includeInactive ? [] : [{ $match: { status: { $ne: 'INACTIVE' } } }]),
      { $lookup: { from: 'products', localField: '_id', foreignField: 'categoryId', pipeline: [{ $project: { _id: 1 } }], as: 'products' } },
      { $project: { code: 1, name: 1, description: 1, sortOrder: 1, status: 1, productCount: { $size: '$products' } } },
      { $sort: { sortOrder: 1, code: 1 } },
    ]).toArray();
    return rows.map(serializeDocument);
  }

  async createCategory(input: ProductCategoryInput, request: AuthenticatedRequest) {
    const now = new Date();
    const document = { _id: new ObjectId(), ...input, sortOrder: input.sortOrder ?? 99, status: 'ACTIVE', createdAt: now, updatedAt: now };
    try {
      await this.db.collection('product_categories').insertOne(document);
    } catch (error) {
      if (isDuplicate(error)) throw new ConflictException({ code: 'CATEGORY_CODE_EXISTS', message: `Mã nhóm ${input.code} đã tồn tại` });
      throw error;
    }
    await this.record(request, 'CATEGORY_CREATED', 'ProductCategory', document._id.toHexString(), null, document);
    return serializeDocument(document);
  }

  async updateCategory(id: string, input: Patch<ProductCategoryInput> & { status?: Status | undefined }, request: AuthenticatedRequest) {
    const before = await this.load('product_categories', id, 'CATEGORY_NOT_FOUND', 'Không tìm thấy nhóm hàng');
    let after: Document | null;
    try {
      after = await this.db.collection('product_categories').findOneAndUpdate({ _id: before._id }, { $set: { ...input, updatedAt: new Date() } }, { returnDocument: 'after' });
    } catch (error) {
      if (isDuplicate(error)) throw new ConflictException({ code: 'CATEGORY_CODE_EXISTS', message: `Mã nhóm ${input.code} đã tồn tại` });
      throw error;
    }
    await this.record(request, 'CATEGORY_UPDATED', 'ProductCategory', id, before, after);
    return serializeDocument(after as Document);
  }

  async deleteCategory(id: string, request: AuthenticatedRequest) {
    const before = await this.load('product_categories', id, 'CATEGORY_NOT_FOUND', 'Không tìm thấy nhóm hàng');
    const categoryId = before._id as ObjectId;
    await this.assertUnused('CATEGORY_IN_USE', `nhóm ${String(before.name)}`, [
      { collection: 'products', filter: { categoryId }, label: 'sản phẩm' },
      { collection: 'promotions', filter: { categoryIds: categoryId }, label: 'chương trình khuyến mãi' },
      { collection: 'warranty_fault_codes', filter: { categoryIds: categoryId }, label: 'mã lỗi bảo hành' },
    ]);
    await this.db.collection('product_categories').deleteOne({ _id: categoryId });
    await this.record(request, 'CATEGORY_DELETED', 'ProductCategory', id, before);
  }

  // ---------- đối tác ----------

  private async salesRep(salesRepId: string) {
    const employee = await this.db.collection('employees').findOne({ _id: toObjectId(salesRepId, 'salesRepId') });
    if (!employee) throw new BadRequestException({ code: 'SALES_REP_NOT_FOUND', message: 'Không tìm thấy nhân viên kinh doanh' });
    return { salesRepId: employee._id, salesRepName: String(employee.name) };
  }

  private async assertRegion(regionCode: string | undefined) {
    if (!regionCode) return;
    if (!(await this.db.collection('regions').findOne({ code: regionCode }))) {
      throw new BadRequestException({ code: 'REGION_NOT_FOUND', message: `Không có khu vực ${regionCode}` });
    }
  }

  /** Dùng chung cho thêm mới (catalog.service) để mã NVKD lưu đúng kiểu ObjectId kèm tên. */
  async partnerRefs(input: { salesRepId?: string | undefined; regionCode?: string | undefined }) {
    await this.assertRegion(input.regionCode);
    return input.salesRepId ? await this.salesRep(input.salesRepId) : {};
  }

  async updatePartner(id: string, input: Patch<UpdatePartner> & { version: number }, request: AuthenticatedRequest) {
    const before = await this.load('partners', id, 'PARTNER_NOT_FOUND', 'Không tìm thấy đối tác');
    // Nhân viên kinh doanh sửa được hồ sơ khách "cơ hội" (chưa có cấp giá / công nợ).
    const salesOnProspect = before.stage === 'PROSPECT' && request.user.roles.includes('SALES');
    // Kế toán (không quản lý hồ sơ khách) vẫn đặt được hạn mức, số ngày nợ, khóa / mở khóa công nợ — "KD đề xuất, kế toán lập, Giám đốc duyệt".
    const creditOnly = canChangeCreditTerms(request.user.roles) && Object.keys(input).every((key) => CREDIT_ONLY_KEYS.has(key));
    if (!canManagePartnerKind(request.user.roles, String(before.kind)) && !salesOnProspect && !creditOnly) {
      throw new ForbiddenException({ code: 'PARTNER_KIND_FORBIDDEN', message: 'Hồ sơ khách hàng do phòng Kinh doanh và Giám đốc quản lý; tài khoản kho chỉ sửa nhà cung cấp' });
    }
    const creditChanged =
      (input.creditLimit !== undefined && decimalString(input.creditLimit) !== decimalString(before.creditLimit ?? '0')) ||
      (input.paymentTermDays !== undefined && input.paymentTermDays !== Number(before.paymentTermDays ?? 0)) ||
      (input.status !== undefined && input.status !== before.status && (input.status === 'ON_HOLD' || before.status === 'ON_HOLD'));
    if (creditChanged && !canChangeCreditTerms(request.user.roles)) {
      throw new ForbiddenException({ code: 'CREDIT_TERMS_FORBIDDEN', message: 'Hạn mức, số ngày nợ và khóa / mở khóa công nợ do Giám đốc hoặc kế toán thay đổi' });
    }
    const update: Document = { ...normalizePartnerLists(input), updatedAt: new Date() };
    delete update.version;
    delete update.clear;
    delete update.territoryExceptionReason;
    if (input.creditLimit !== undefined) update.creditLimit = decimal(input.creditLimit);
    if (input.salesRepId !== undefined) Object.assign(update, await this.salesRep(input.salesRepId));
    await this.assertRegion(input.regionCode);
    const cleared = new Set<string>(input.clear ?? []);
    let unsetException = false;
    // Phân vùng NVKD (PV-01): chỉ kiểm khi sửa tỉnh / kênh / NVKD (sửa trường khác không đụng khách cũ đang lệch).
    const territoryTouched = ['provinceOldCode', 'provinceNewCode', 'territoryChannel', 'salesRepId'].some((key) => key in input || cleared.has(key)) || Boolean(input.territoryExceptionReason);
    if (before.kind !== 'SUPPLIER' && territoryTouched) {
      if ('provinceOldCode' in input || 'provinceNewCode' in input) {
        const provinces = normalizeProvinces({
          provinceOldCode: 'provinceOldCode' in input ? input.provinceOldCode : cleared.has('provinceOldCode') ? null : (before.provinceOldCode as string | undefined),
          provinceNewCode: input.provinceNewCode ?? (cleared.has('provinceNewCode') ? null : 'provinceOldCode' in input ? undefined : (before.provinceNewCode as string | undefined)),
        });
        Object.assign(update, provinces);
      }
      const territory = await enforceTerritory(this.db, {
        provinceOldCode: cleared.has('provinceOldCode') ? null : ((update.provinceOldCode ?? before.provinceOldCode) as string | undefined),
        territoryChannel: cleared.has('territoryChannel') ? null : ((update.territoryChannel ?? before.territoryChannel) as never),
        salesRepId: (update.salesRepId ?? before.salesRepId) as ObjectId | undefined,
      }, request.user, input.territoryExceptionReason);
      Object.assign(update, territory.set);
      unsetException = territory.unsetException;
    }
    const unset: Document = { ...unsetOf(input.clear, update), ...(input.status && input.status !== 'ON_HOLD' ? { holdReason: '' } : {}), ...(unsetException && before.territoryException ? { territoryException: '' } : {}) };
    if (input.status && input.status !== 'ON_HOLD') delete update.holdReason;
    const result = await this.db.collection('partners').findOneAndUpdate(
      { _id: before._id, version: input.version },
      { $set: update, $inc: { version: 1 }, ...(Object.keys(unset).length ? { $unset: unset } : {}) },
      { returnDocument: 'after' },
    );
    if (!result) throw new ConflictException({ code: 'VERSION_CONFLICT', message: 'Hồ sơ đã được người khác cập nhật, hãy tải lại rồi sửa' });
    await this.record(request, 'PARTNER_UPDATED', 'Partner', id, before, result);
    return serializeDocument(result);
  }

  async deletePartner(id: string, request: AuthenticatedRequest) {
    const before = await this.load('partners', id, 'PARTNER_NOT_FOUND', 'Không tìm thấy đối tác');
    if (!canManagePartnerKind(request.user.roles, String(before.kind))) {
      throw new ForbiddenException({ code: 'PARTNER_KIND_FORBIDDEN', message: 'Hồ sơ khách hàng do phòng Kinh doanh và Giám đốc quản lý; tài khoản kho chỉ sửa nhà cung cấp' });
    }
    const partnerId = before._id as ObjectId;
    await this.assertUnused('PARTNER_IN_USE', String(before.name), [
      { collection: 'sales_orders', filter: { customerId: partnerId }, label: 'phiếu bán hàng' },
      { collection: 'purchase_orders', filter: { supplierId: partnerId }, label: 'đơn mua hàng' },
      { collection: 'receivables', filter: { partnerId }, label: 'công nợ' },
      { collection: 'payments', filter: { partnerId }, label: 'phiếu thu' },
      { collection: 'warranty_tickets', filter: { 'customer.partnerId': partnerId }, label: 'phiếu bảo hành' },
    ]);
    await this.db.collection('partner_activities').deleteMany({ partnerId });
    await this.evidence.removeAllFor('Partner', partnerId);
    await this.db.collection('partners').deleteOne({ _id: partnerId });
    await this.record(request, 'PARTNER_DELETED', 'Partner', id, before);
  }

  /** Chuyển khách "cơ hội" thành khách chính thức: gán cấp giá; hạn mức / số ngày nợ chỉ Giám đốc, kế toán đặt. */
  async convertPartner(id: string, input: ConvertPartner, request: AuthenticatedRequest) {
    const before = await this.load('partners', id, 'PARTNER_NOT_FOUND', 'Không tìm thấy đối tác');
    if (!canConvertProspect(request.user.roles)) {
      throw new ForbiddenException({ code: 'PARTNER_KIND_FORBIDDEN', message: 'Chuyển khách cơ hội thành khách chính thức do quản lý kinh doanh hoặc Giám đốc thực hiện' });
    }
    if (before.stage !== 'PROSPECT') throw new ConflictException({ code: 'PARTNER_NOT_PROSPECT', message: 'Khách này đã là khách chính thức' });
    const creditChanged = (input.creditLimit !== undefined && Number(input.creditLimit) !== 0) || (input.paymentTermDays !== undefined && input.paymentTermDays !== 0);
    if (creditChanged && !canChangeCreditTerms(request.user.roles)) {
      throw new ForbiddenException({ code: 'CREDIT_TERMS_FORBIDDEN', message: 'Hạn mức, số ngày nợ và khóa / mở khóa công nợ do Giám đốc hoặc kế toán thay đổi' });
    }
    // Khách chính thức phải có NVKD phụ trách (doanh số, nhật ký xuất nhập, báo cáo theo NVKD).
    const rep = input.salesRepId ? await this.salesRep(input.salesRepId) : null;
    // Phân vùng NVKD (PV-01): khách ở vùng đã giao thì NVKD là người phụ trách vùng (tự điền khi bỏ trống).
    const territory = await enforceTerritory(this.db, {
      provinceOldCode: before.provinceOldCode as string | undefined,
      territoryChannel: before.territoryChannel as never,
      salesRepId: (rep?.salesRepId ?? before.salesRepId) as ObjectId | undefined,
    }, request.user, input.territoryExceptionReason);
    if (!rep && !before.salesRepId && !territory.set.salesRepId) {
      throw new BadRequestException({ code: 'SALES_REP_REQUIRED', message: 'Chọn NVKD phụ trách trước khi chuyển thành khách chính thức', details: [{ path: ['salesRepId'] }] });
    }
    const now = new Date();
    const result = await this.db.collection('partners').findOneAndUpdate(
      { _id: before._id, version: input.version, stage: 'PROSPECT' },
      {
        $set: {
          stage: 'CUSTOMER',
          customerTier: input.customerTier,
          ...(rep ?? {}),
          ...territory.set,
          ...(input.creditLimit !== undefined ? { creditLimit: decimal(input.creditLimit) } : {}),
          ...(input.paymentTermDays !== undefined ? { paymentTermDays: input.paymentTermDays } : {}),
          convertedAt: now,
          convertedBy: toObjectId(request.user.sub),
          updatedAt: now,
        },
        $inc: { version: 1 },
      },
      { returnDocument: 'after' },
    );
    if (!result) throw new ConflictException({ code: 'VERSION_CONFLICT', message: 'Hồ sơ đã được người khác cập nhật, hãy tải lại rồi thử lại' });
    await this.record(request, 'PARTNER_CONVERTED', 'Partner', id, before, result);
    return serializeDocument(result);
  }

  // ---------- kho ----------

  /** Người tạo kho được gán quyền kho mới (có hiệu lực từ lần đăng nhập sau). */
  async grantWarehouse(userId: string, warehouseId: ObjectId) {
    await this.db.collection('users').updateOne({ _id: toObjectId(userId) }, { $addToSet: { warehouseScopes: warehouseId.toHexString() } });
  }

  private async warehouseStock(warehouseId: ObjectId) {
    return this.db.collection('inventory_balances').findOne({ warehouseId, $or: [{ onHand: { $gt: 0 } }, { reserved: { $gt: 0 } }] }, { projection: { _id: 1 } });
  }

  /** Kho kèm số liệu tóm tắt (số vị trí, mã có tồn, tổng tồn, đang giữ, mã dưới định mức) để trang kho không phải tải cả bảng tồn. */
  async listWarehouses() {
    const [warehouses, locationCounts, stock] = await Promise.all([
      this.db.collection('warehouses').find({}).sort({ code: 1 }).toArray(),
      this.db.collection('locations').aggregate([{ $group: { _id: '$warehouseId', count: { $sum: 1 } } }]).toArray(),
      this.db.collection('inventory_balances').aggregate([
        { $lookup: { from: 'products', localField: 'productId', foreignField: '_id', pipeline: [{ $project: { minimumStock: 1 } }], as: 'product' } },
        { $unwind: '$product' },
        {
          $group: {
            _id: '$warehouseId',
            stockedProducts: { $sum: { $cond: [{ $gt: ['$onHand', 0] }, 1, 0] } },
            units: { $sum: '$onHand' },
            reserved: { $sum: '$reserved' },
            low: { $sum: { $cond: [{ $and: [{ $gt: ['$product.minimumStock', 0] }, { $lte: [{ $subtract: ['$onHand', '$reserved'] }, '$product.minimumStock'] }] }, 1, 0] } },
          },
        },
      ]).toArray(),
    ]);
    const find = (rows: Document[], id: ObjectId) => rows.find((row) => (row._id as ObjectId).equals(id));
    return warehouses.map((row) => {
      const summary = find(stock, row._id);
      return {
        ...serializeDocument(row),
        locationCount: Number(find(locationCounts, row._id)?.count ?? 0),
        stockedProducts: Number(summary?.stockedProducts ?? 0),
        units: decimalString(summary?.units ?? '0'),
        reserved: decimalString(summary?.reserved ?? '0'),
        lowCount: row.purpose === 'DEFECTIVE' ? 0 : Number(summary?.low ?? 0),
      };
    });
  }

  async updateWarehouse(id: string, input: Patch<UpdateWarehouse> & { version: number }, request: AuthenticatedRequest) {
    const before = await this.load('warehouses', id, 'WAREHOUSE_NOT_FOUND', 'Không tìm thấy kho');
    if (input.active === false && before.active !== false) {
      if (await this.warehouseStock(before._id as ObjectId)) {
        throw new ConflictException({ code: 'WAREHOUSE_HAS_STOCK', message: 'Kho còn hàng tồn hoặc hàng đang giữ; chuyển kho hết hàng trước khi ngừng sử dụng' });
      }
    }
    const update: Document = { ...input, updatedAt: new Date() };
    delete update.version;
    const result = await this.db.collection('warehouses').findOneAndUpdate(
      { _id: before._id, version: input.version },
      { $set: update, $inc: { version: 1 } },
      { returnDocument: 'after' },
    );
    if (!result) throw new ConflictException({ code: 'VERSION_CONFLICT', message: 'Kho đã được người khác cập nhật, hãy tải lại rồi sửa' });
    await this.record(request, 'WAREHOUSE_UPDATED', 'Warehouse', id, before, result);
    return serializeDocument(result);
  }

  async deleteWarehouse(id: string, request: AuthenticatedRequest) {
    const before = await this.load('warehouses', id, 'WAREHOUSE_NOT_FOUND', 'Không tìm thấy kho');
    const warehouseId = before._id as ObjectId;
    await this.assertUnused('WAREHOUSE_IN_USE', `kho ${String(before.name)}`, [
      { collection: 'inventory_movements', filter: { warehouseId }, label: 'thẻ kho' },
      { collection: 'inventory_balances', filter: { warehouseId }, label: 'tồn kho' },
      { collection: 'sales_orders', filter: { warehouseId }, label: 'phiếu bán hàng' },
      { collection: 'purchase_orders', filter: { warehouseId }, label: 'đơn mua hàng' },
      { collection: 'inventory_transfers', filter: { $or: [{ fromWarehouseId: warehouseId }, { toWarehouseId: warehouseId }] }, label: 'phiếu chuyển kho' },
      { collection: 'locations', filter: { warehouseId }, label: 'vị trí lưu' },
      { collection: 'branches', filter: { defaultWarehouseId: warehouseId }, label: 'kho mặc định của văn phòng' },
    ]);
    await this.db.collection('warehouses').deleteOne({ _id: warehouseId });
    await this.db.collection('users').updateMany({ warehouseScopes: id }, { $pull: { warehouseScopes: id } } as Document);
    await this.record(request, 'WAREHOUSE_DELETED', 'Warehouse', id, before);
  }

  // ---------- vị trí lưu ----------

  private locationUsages(location: Document): Usage[] {
    const filter = { warehouseId: location.warehouseId, locationCode: location.code };
    return [
      { collection: 'inventory_balances', filter, label: 'tồn kho' },
      { collection: 'inventory_movements', filter, label: 'thẻ kho' },
    ];
  }

  async listLocations(warehouseId?: string) {
    const filter: Document = warehouseId ? { warehouseId: toObjectId(warehouseId, 'warehouseId') } : {};
    const [locations, stocked] = await Promise.all([
      this.db.collection('locations').find(filter).sort({ code: 1 }).toArray(),
      this.db.collection('inventory_balances').aggregate([
        { $match: { ...filter, onHand: { $gt: 0 }, locationCode: { $ne: null } } },
        { $group: { _id: { warehouseId: '$warehouseId', code: '$locationCode' }, count: { $sum: 1 } } },
      ]).toArray(),
    ]);
    return locations.map((row) => ({
      ...serializeDocument(row),
      stockedProducts: Number(stocked.find((item) => (item._id.warehouseId as ObjectId).equals(row.warehouseId as ObjectId) && item._id.code === row.code)?.count ?? 0),
    }));
  }

  async createLocation(input: LocationInput, request: AuthenticatedRequest) {
    const warehouseId = toObjectId(input.warehouseId, 'warehouseId');
    if (!(await this.db.collection('warehouses').findOne({ _id: warehouseId }))) {
      throw new BadRequestException({ code: 'WAREHOUSE_NOT_FOUND', message: 'Không tìm thấy kho' });
    }
    const now = new Date();
    const document = { _id: new ObjectId(), ...input, warehouseId, createdAt: now, updatedAt: now };
    try {
      await this.db.collection('locations').insertOne(document);
    } catch (error) {
      if (isDuplicate(error)) throw new ConflictException({ code: 'LOCATION_CODE_EXISTS', message: `Vị trí ${input.code} đã có trong kho này` });
      throw error;
    }
    await this.record(request, 'LOCATION_CREATED', 'Location', document._id.toHexString(), null, document);
    return serializeDocument(document);
  }

  async updateLocation(id: string, input: Patch<Omit<LocationInput, 'warehouseId'>>, request: AuthenticatedRequest) {
    const before = await this.load('locations', id, 'LOCATION_NOT_FOUND', 'Không tìm thấy vị trí lưu');
    if (input.code !== undefined && input.code !== before.code && (await this.usages(this.locationUsages(before))).length) {
      throw new ConflictException({ code: 'LOCATION_IN_USE', message: `Vị trí ${String(before.code)} đã có hàng / thẻ kho nên không đổi mã được; hãy tạo vị trí mới` });
    }
    let after: Document | null;
    try {
      after = await this.db.collection('locations').findOneAndUpdate({ _id: before._id }, { $set: { ...input, updatedAt: new Date() } }, { returnDocument: 'after' });
    } catch (error) {
      if (isDuplicate(error)) throw new ConflictException({ code: 'LOCATION_CODE_EXISTS', message: `Vị trí ${input.code} đã có trong kho này` });
      throw error;
    }
    await this.record(request, 'LOCATION_UPDATED', 'Location', id, before, after);
    return serializeDocument(after as Document);
  }

  async deleteLocation(id: string, request: AuthenticatedRequest) {
    const before = await this.load('locations', id, 'LOCATION_NOT_FOUND', 'Không tìm thấy vị trí lưu');
    await this.assertUnused('LOCATION_IN_USE', `vị trí ${String(before.code)}`, this.locationUsages(before));
    await this.db.collection('locations').deleteOne({ _id: before._id });
    await this.record(request, 'LOCATION_DELETED', 'Location', id, before);
  }

  // ---------- khu vực bán hàng ----------

  async createRegion(input: RegionInput, request: AuthenticatedRequest) {
    const document = { _id: new ObjectId(), ...input, sortOrder: input.sortOrder ?? 99, createdAt: new Date() };
    try {
      await this.db.collection('regions').insertOne(document);
    } catch (error) {
      if (isDuplicate(error)) throw new ConflictException({ code: 'REGION_CODE_EXISTS', message: `Mã khu vực ${input.code} đã tồn tại` });
      throw error;
    }
    await this.record(request, 'REGION_CREATED', 'Region', document._id.toHexString(), null, document);
    return serializeDocument(document);
  }

  /** Mã khu vực không đổi (đại lý, phiếu bán, báo cáo lưu theo mã). */
  async updateRegion(id: string, input: Patch<Omit<RegionInput, 'code'>>, request: AuthenticatedRequest) {
    const before = await this.load('regions', id, 'REGION_NOT_FOUND', 'Không tìm thấy khu vực');
    const after = await this.db.collection('regions').findOneAndUpdate({ _id: before._id }, { $set: { ...input, updatedAt: new Date() } }, { returnDocument: 'after' });
    await this.record(request, 'REGION_UPDATED', 'Region', id, before, after);
    return serializeDocument(after as Document);
  }

  async deleteRegion(id: string, request: AuthenticatedRequest) {
    const before = await this.load('regions', id, 'REGION_NOT_FOUND', 'Không tìm thấy khu vực');
    const regionCode = String(before.code);
    await this.assertUnused('REGION_IN_USE', `khu vực ${String(before.name)}`, [
      { collection: 'partners', filter: { regionCode }, label: 'hồ sơ đại lý' },
      { collection: 'employees', filter: { regionCode }, label: 'nhân viên kinh doanh' },
      { collection: 'sales_orders', filter: { regionCode }, label: 'phiếu bán hàng' },
    ], 'Khu vực đã dùng thì giữ lại để báo cáo doanh số theo vùng không bị lệch.');
    await this.db.collection('regions').deleteOne({ _id: before._id });
    await this.record(request, 'REGION_DELETED', 'Region', id, before);
  }

  // ---------- nhân viên kinh doanh ----------

  /** Tài khoản đăng nhập liên kết với hồ sơ NVKD: phải là tài khoản kinh doanh và chưa gắn với NVKD khác. */
  private async linkedUser(userId: string | null | undefined, employeeId?: ObjectId): Promise<ObjectId | null> {
    if (!userId) return null;
    const user = await this.db.collection('users').findOne({ _id: toObjectId(userId, 'userId') });
    if (!user || !(user.roles as string[] | undefined)?.some((role) => role === 'SALES' || role === 'SALES_MANAGER')) {
      throw new BadRequestException({ code: 'EMPLOYEE_USER_INVALID', message: 'Chỉ liên kết được tài khoản nhân viên / trưởng phòng kinh doanh', details: [{ path: ['userId'] }] });
    }
    const taken = await this.db.collection('employees').findOne({ userId: user._id, ...(employeeId ? { _id: { $ne: employeeId } } : {}) });
    if (taken) {
      throw new ConflictException({ code: 'EMPLOYEE_USER_TAKEN', message: `Tài khoản ${String(user.email)} đã gắn với NVKD ${String(taken.code)}`, details: [{ path: ['userId'] }] });
    }
    return user._id as ObjectId;
  }

  /** Tài khoản kinh doanh để liên kết với hồ sơ NVKD (không lộ toàn bộ danh sách người dùng). */
  async linkableUsers() {
    const users = await this.db
      .collection('users')
      .find({ roles: { $in: ['SALES', 'SALES_MANAGER'] }, status: { $ne: 'DISABLED' } }, { projection: { email: 1, displayName: 1, roles: 1 } })
      .sort({ displayName: 1 })
      .toArray();
    return users.map((user) => ({ id: String(user._id), email: String(user.email), displayName: String(user.displayName ?? user.email), roles: user.roles as string[] }));
  }

  /** NVKD gắn với tài khoản đang đăng nhập (để tự gán người phụ trách khách do họ tạo). */
  async employeeOfUser(userId: string) {
    const employee = await this.db.collection('employees').findOne({ userId: toObjectId(userId), status: { $ne: 'INACTIVE' } });
    return employee ? { salesRepId: employee._id as ObjectId, salesRepName: String(employee.name) } : null;
  }

  async createEmployee(input: EmployeeInput, request: AuthenticatedRequest) {
    await this.assertRegion(input.regionCode ?? undefined);
    const now = new Date();
    const document = { _id: new ObjectId(), ...input, regionCode: input.regionCode ?? null, userId: await this.linkedUser(input.userId), createdAt: now, updatedAt: now };
    try {
      await this.db.collection('employees').insertOne(document);
    } catch (error) {
      if (isDuplicate(error)) throw new ConflictException({ code: 'EMPLOYEE_CODE_EXISTS', message: `Mã nhân viên ${input.code} đã tồn tại` });
      throw error;
    }
    await this.record(request, 'EMPLOYEE_CREATED', 'Employee', document._id.toHexString(), null, document);
    return serializeDocument(document);
  }

  async updateEmployee(id: string, input: Patch<EmployeeInput>, request: AuthenticatedRequest) {
    const before = await this.load('employees', id, 'EMPLOYEE_NOT_FOUND', 'Không tìm thấy nhân viên');
    if (input.regionCode) await this.assertRegion(input.regionCode);
    const { userId, ...fields } = input;
    const set: Document = { ...fields, ...(userId !== undefined ? { userId: await this.linkedUser(userId, before._id as ObjectId) } : {}), updatedAt: new Date() };
    let after: Document | null;
    try {
      after = await this.db.collection('employees').findOneAndUpdate({ _id: before._id }, { $set: set }, { returnDocument: 'after' });
    } catch (error) {
      if (isDuplicate(error)) throw new ConflictException({ code: 'EMPLOYEE_CODE_EXISTS', message: `Mã nhân viên ${input.code} đã tồn tại` });
      throw error;
    }
    // Hồ sơ đại lý đang phụ trách hiển thị tên NVKD; phiếu bán cũ giữ tên tại thời điểm lập.
    if (input.name && input.name !== before.name) {
      await this.db.collection('partners').updateMany({ salesRepId: before._id }, { $set: { salesRepName: input.name } });
    }
    await this.record(request, 'EMPLOYEE_UPDATED', 'Employee', id, before, after);
    return serializeDocument(after as Document);
  }

  async deleteEmployee(id: string, request: AuthenticatedRequest) {
    const before = await this.load('employees', id, 'EMPLOYEE_NOT_FOUND', 'Không tìm thấy nhân viên');
    const employeeId = before._id as ObjectId;
    await this.assertUnused('EMPLOYEE_IN_USE', String(before.name), [
      { collection: 'partners', filter: { salesRepId: employeeId }, label: 'hồ sơ đại lý đang phụ trách' },
      { collection: 'sales_orders', filter: { salesRepId: employeeId }, label: 'phiếu bán hàng' },
    ]);
    await this.db.collection('employees').deleteOne({ _id: employeeId });
    await this.record(request, 'EMPLOYEE_DELETED', 'Employee', id, before);
  }
}
