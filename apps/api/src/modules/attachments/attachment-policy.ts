import { canLogActivity, canManagePartnerKind, PRODUCT_EDITOR_ROLES } from '@inoxpran/contracts';
import type { Document } from 'mongodb';
import type { EvidenceTarget } from '../../common/evidence-intake.service';

/** Mục đích file trong tab "Đính kèm": nhận PDF hay chỉ ảnh, tối đa bao nhiêu file trên một hồ sơ. */
export interface PurposeRule {
  allowPdf: boolean;
  limit: number;
}

/**
 * Hồ sơ / chứng từ có tab "Đính kèm" (đường dẫn /attachments/:type/:id). Quyền xem đi theo quyền xem hồ sơ đó
 * (danh mục sản phẩm / đối tác: mọi người dùng đã đăng nhập); quyền tải lên / xóa theo người được sửa hồ sơ.
 * Thư mục S3 (keyPrefix) phải có trong IAM DeleteObject của máy chủ và danh sách quét GuardDuty.
 */
export interface AttachmentPolicy {
  entityType: EvidenceTarget['entityType'];
  collection: string;
  codeField: string;
  keyPrefix: string;
  auditPrefix: string;
  href: (id: string, entity: Document) => string;
  purposes: Record<string, PurposeRule>;
  /** Mục đích mặc định khi không truyền ?purpose=. */
  defaultPurpose: string;
  canView: (roles: string[], entity: Document) => boolean;
  canEdit: (roles: string[], entity: Document) => boolean;
}

const has = (roles: string[], allowed: readonly string[]) => roles.some((role) => allowed.includes(role));
/** Chứng từ mua hàng (hợp đồng, invoice, B/L, tờ khai, C/O…): phòng mua hàng, kế toán, Giám đốc, kho. */
const PURCHASE_DOC_EDITORS = ['ADMIN', 'PROCUREMENT', 'PROCUREMENT_MANAGER', 'ACCOUNTANT', 'WAREHOUSE', 'WAREHOUSE_MANAGER'];

export const ATTACHMENT_POLICIES: Record<string, AttachmentPolicy> = {
  products: {
    entityType: 'Product',
    collection: 'products',
    codeField: 'sku',
    keyPrefix: 'product-files',
    auditPrefix: 'PRODUCT_FILE',
    href: (id) => `/catalog/products/${id}`,
    purposes: { PRODUCT_IMAGE: { allowPdf: false, limit: 12 }, PRODUCT_DOCUMENT: { allowPdf: true, limit: 20 } },
    defaultPurpose: 'PRODUCT_IMAGE',
    canView: () => true,
    canEdit: (roles) => has(roles, PRODUCT_EDITOR_ROLES),
  },
  partners: {
    entityType: 'Partner',
    collection: 'partners',
    codeField: 'code',
    keyPrefix: 'partner-files',
    auditPrefix: 'PARTNER_FILE',
    href: (id, entity) => (entity.kind === 'SUPPLIER' ? `/catalog/suppliers/${id}` : `/catalog/dealers/${id}`),
    purposes: { PARTNER_DOCUMENT: { allowPdf: true, limit: 30 } },
    defaultPurpose: 'PARTNER_DOCUMENT',
    canView: () => true,
    // Người quản lý hồ sơ đối tác; đội kinh doanh đính kèm giấy tờ khách (giấy phép kinh doanh, danh thiếp…).
    canEdit: (roles, entity) => canManagePartnerKind(roles, String(entity.kind)) || (entity.kind !== 'SUPPLIER' && canLogActivity(roles)),
  },
  'purchase-orders': {
    entityType: 'PurchaseOrder',
    collection: 'purchase_orders',
    codeField: 'code',
    keyPrefix: 'purchase-docs',
    auditPrefix: 'PURCHASE_FILE',
    href: (id) => `/procurement/${id}`,
    purposes: { PURCHASE_DOCUMENT: { allowPdf: true, limit: 40 } },
    defaultPurpose: 'PURCHASE_DOCUMENT',
    canView: () => true,
    canEdit: (roles) => has(roles, PURCHASE_DOC_EDITORS),
  },
  'import-shipments': {
    entityType: 'ImportShipment',
    collection: 'import_shipments',
    codeField: 'code',
    keyPrefix: 'purchase-docs',
    auditPrefix: 'PURCHASE_FILE',
    href: (id) => `/procurement/shipments/${id}`,
    purposes: { PURCHASE_DOCUMENT: { allowPdf: true, limit: 40 } },
    defaultPurpose: 'PURCHASE_DOCUMENT',
    canView: () => true,
    canEdit: (roles) => has(roles, PURCHASE_DOC_EDITORS),
  },
};
