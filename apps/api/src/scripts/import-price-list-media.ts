/**
 * PRICE-IMG-01 (11/11/2026): nạp ảnh sản phẩm + "Tính năng sản phẩm" từ file "Bảng Báo Giá Inoxpran" của công ty.
 *
 * Đầu vào là gói JSON dựng sẵn ở máy (ảnh đã nén JPEG cạnh dài ≤ 1200 px):
 *   { source, rows: [{ model, feature, image? }], images: { <khóa>: <base64 JPEG> } }
 * Ảnh đi đúng các bước của luồng tải ảnh sản phẩm: quét ClamAV, lưu S3 product-files/<id SP>/<id ảnh>.jpg,
 * bản ghi `attachments` (PRODUCT_IMAGE, LINKED) và nhật ký PRODUCT_FILE_UPLOADED.
 *
 * Quy tắc:
 *  - Tính năng: ghi đè `specification` khi khác nội dung trong file (người dùng đồng ý ghi đè ngày 11/11/2026).
 *  - Ảnh: chỉ nạp khi sản phẩm chưa có ảnh đại diện, hoặc ảnh đại diện hiện tại không phải PNG/JPEG
 *    (WebP không đưa được vào Excel) — ảnh nạp thành ảnh đại diện. Sản phẩm đã có ảnh đại diện PNG/JPEG giữ nguyên.
 *  - Chạy lại không nạp trùng: sản phẩm đã có ảnh cùng sha256 thì bỏ qua.
 *
 * Chạy thử (không ghi gì):  node apps/api/dist/scripts/import-price-list-media.js --file <gói.json> | --s3-key <khóa S3>
 * Chạy thật:  PRICE_MEDIA_CONFIRM=NAP-ANH-BANG-GIA node apps/api/dist/scripts/import-price-list-media.js --s3-key <khóa> --execute
 * Trên máy chủ: cd /opt/inoxpran && docker compose run --rm --no-deps [-e PRICE_MEDIA_CONFIRM=…] api \
 *   node apps/api/dist/scripts/import-price-list-media.js --s3-key imports/price-media-20261111.json [--execute]
 */
import { config } from 'dotenv';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { MongoClient, ObjectId, type Document } from 'mongodb';
import { detectImageType } from '../common/image-signature';
import { ClamAvScanner } from '../common/malware-scanner';
import { attachmentObjectKey, ObjectStorage } from '../common/object-storage';

config({ path: process.env.ENV_FILE ?? resolve(process.cwd(), '../../.env') });

export const PRICE_MEDIA_CONFIRM = 'NAP-ANH-BANG-GIA';
const ACTOR_EMAIL = 'import-price-list-media';
const PRODUCT_IMAGE_LIMIT = 12;

interface Bundle {
  source?: string;
  rows: Array<{ model: string; feature?: string; image?: string }>;
  images: Record<string, string>;
}

function argument(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

async function loadBundle(storage: ObjectStorage): Promise<Bundle> {
  const file = argument('--file');
  const key = argument('--s3-key');
  if (!file && !key) throw new Error('Thiếu --file <gói.json> hoặc --s3-key <khóa S3>');
  const raw = file ? readFileSync(file, 'utf8') : (await storage.get(key!)).toString('utf8');
  const bundle = JSON.parse(raw) as Bundle;
  if (!Array.isArray(bundle.rows) || typeof bundle.images !== 'object') throw new Error('Gói dữ liệu sai định dạng');
  return bundle;
}

async function main(): Promise<void> {
  const execute = process.argv.includes('--execute');
  if (execute && process.env.PRICE_MEDIA_CONFIRM !== PRICE_MEDIA_CONFIRM) throw new Error(`Chạy thật cần PRICE_MEDIA_CONFIRM=${PRICE_MEDIA_CONFIRM}`);
  const uri = process.env.MONGODB_URI;
  if (!uri) throw new Error('Thiếu MONGODB_URI');
  const storage = new ObjectStorage(process.env);
  const bundle = await loadBundle(storage);
  const scanOff = process.env.MALWARE_SCAN_MODE === 'off';
  const scanner = new ClamAvScanner({ host: process.env.CLAMAV_HOST ?? 'localhost', port: Number(process.env.CLAMAV_PORT ?? 3310), timeoutMs: Number(process.env.CLAMAV_TIMEOUT_MS ?? 30_000) });
  const client = new MongoClient(uri);
  await client.connect();
  try {
    const db = client.db(process.env.MONGODB_DATABASE ?? 'inoxpran_erp');
    const actor = await db.collection('users').findOne({ roles: 'ADMIN', status: { $ne: 'DISABLED' } }, { sort: { createdAt: 1 }, projection: { displayName: 1, email: 1 } })
      ?? await db.collection('users').findOne({ roles: 'ADMIN' }, { sort: { createdAt: 1 }, projection: { displayName: 1, email: 1 } });
    if (!actor) throw new Error('Không tìm thấy tài khoản quản trị để ghi người tải ảnh');
    // File mẫu ghi "INP6401(B)", danh mục ghi "INP6401-B": so theo chữ + số của mã SP (rồi tới model).
    // Model ghi trùng nhiều dòng (file ghi INP6209 cho 2 màu): dòng 1 ghép mã đúng model hoặc model + "A", dòng n ghép
    // model + chữ thứ n ("B", "C"…). Local / staging tách INP6209 + INP6209-B, production đổi thành INP6209-A + INP6209-B —
    // không ghép theo thứ tự mù (thiếu một mã thì ảnh màu này gắn nhầm sang màu kia).
    const keyOf = (value: unknown) => String(value ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');
    const products = await db.collection('products').find({}, { projection: { sku: 1, model: 1, name: 1, status: 1, specification: 1, primaryImageId: 1, version: 1 } }).toArray();
    const bySku = new Map<string, Document>();
    const duplicateSku = new Set<string>();
    const byModel = new Map<string, Document[]>();
    for (const product of products) {
      const skuKey = keyOf(product.sku);
      if (bySku.has(skuKey)) duplicateSku.add(skuKey); else bySku.set(skuKey, product);
      const modelKey = keyOf(product.model);
      if (modelKey && modelKey !== skuKey) byModel.set(modelKey, [...(byModel.get(modelKey) ?? []), product]);
    }
    for (const key of duplicateSku) bySku.delete(key);
    const rowsPerKey = new Map<string, number>();
    for (const row of bundle.rows) rowsPerKey.set(keyOf(row.model), (rowsPerKey.get(keyOf(row.model)) ?? 0) + 1);
    const pick = (key: string, occurrence: number): Document | undefined => {
      if ((rowsPerKey.get(key) ?? 0) > 1) {
        const wanted = occurrence === 0 ? [key, `${key}A`] : [`${key}${String.fromCharCode(65 + occurrence)}`];
        return wanted.map((value) => bySku.get(value)).find(Boolean);
      }
      const byModelKey = byModel.get(key) ?? [];
      return bySku.get(key) ?? (byModelKey.length === 1 ? byModelKey[0] : undefined);
    };
    const seen = new Map<string, number>();
    const used = new Set<string>();
    const primaryIds = products.map((product) => product.primaryImageId).filter(Boolean) as ObjectId[];
    const primaries = new Map((await db.collection('attachments').find({ _id: { $in: primaryIds } }, { projection: { contentType: 1, status: 1 } }).toArray())
      .map((row) => [(row._id as ObjectId).toHexString(), row]));

    console.log(`== ${execute ? 'CHẠY THẬT' : 'CHẠY THỬ'} — ${bundle.source ?? 'gói ảnh'}: ${bundle.rows.length} dòng, ${Object.keys(bundle.images).length} ảnh; quét mã độc: ${scanOff ? 'TẮT (máy dev)' : 'ClamAV'}; S3: ${storage.configured ? storage.bucket : 'CHƯA CẤU HÌNH'}`);
    if (execute && !storage.configured) throw new Error('Chưa cấu hình S3 (AWS_S3_BUCKET)');
    const stats = { missing: 0, featureChanged: 0, featureSame: 0, featureOverwritten: 0, imageNew: 0, imageReplaceWebp: 0, imageKept: 0, imageSame: 0, imageNone: 0, imageFull: 0 };
    const now = new Date();
    for (const row of bundle.rows) {
      const key = keyOf(row.model);
      const occurrence = seen.get(key) ?? 0;
      seen.set(key, occurrence + 1);
      const repeated = (rowsPerKey.get(key) ?? 0) > 1;
      const product = pick(key, occurrence);
      if (!product) {
        stats.missing += 1;
        const reason = repeated ? `dòng ${occurrence + 1}/${rowsPerKey.get(key)} của model ghi trùng — không có mã ${occurrence === 0 ? `${row.model} / ${row.model}-A` : `${row.model}-${String.fromCharCode(65 + occurrence)}`}`
          : duplicateSku.has(key) ? 'nhiều mã trùng khóa, không ghép' : (byModel.get(key)?.length ?? 0) > 1 ? 'nhiều mã cùng model, không ghép' : 'mã không có trong danh mục';
        console.log(`KHÔNG CÓ   ${row.model} — ${reason}`);
        continue;
      }
      const productId = product._id as ObjectId;
      if (used.has(productId.toHexString())) { stats.missing += 1; console.log(`TRÙNG     ${row.model} — ${String(product.sku)} đã ghép với dòng khác`); continue; }
      used.add(productId.toHexString());
      const model = String(product.sku);
      if (repeated || keyOf(product.sku) !== key) console.log(`GHÉP      ${row.model}${repeated ? ` (dòng ${occurrence + 1}/${rowsPerKey.get(key)})` : ''} → ${model} ${String(product.name)}`);
      const notes: string[] = [];
      const set: Document = {};

      // Tính năng sản phẩm.
      const feature = (row.feature ?? '').trim();
      const current = String(product.specification ?? '').trim();
      if (feature && feature !== current) {
        set.specification = feature;
        stats.featureChanged += 1;
        if (current) stats.featureOverwritten += 1;
        notes.push(current ? 'ghi đè tính năng' : 'điền tính năng');
      } else if (feature) {
        stats.featureSame += 1;
      }

      // Ảnh sản phẩm.
      let upload: { data: Buffer; sha256: string } | null = null;
      if (!row.image || !bundle.images[row.image]) {
        stats.imageNone += 1;
      } else {
        const data = Buffer.from(bundle.images[row.image]!, 'base64');
        const sha256 = createHash('sha256').update(data).digest('hex');
        const primary = product.primaryImageId ? primaries.get((product.primaryImageId as ObjectId).toHexString()) : undefined;
        const primaryUsable = primary && primary.status === 'LINKED' && (primary.contentType === 'image/jpeg' || primary.contentType === 'image/png');
        const same = await db.collection('attachments').findOne({ entityType: 'Product', entityId: productId, purpose: 'PRODUCT_IMAGE', status: 'LINKED', sha256 }, { projection: { _id: 1 } });
        const count = await db.collection('attachments').countDocuments({ entityId: productId, purpose: 'PRODUCT_IMAGE', status: { $in: ['PENDING', 'LINKED'] } });
        if (same) {
          stats.imageSame += 1;
          if (!primaryUsable) { set.primaryImageId = same._id; notes.push('đặt ảnh đã nạp làm ảnh đại diện'); } else notes.push('ảnh đã nạp');
        } else if (primaryUsable) {
          stats.imageKept += 1;
          notes.push('giữ ảnh đại diện đang có');
        } else if (count >= PRODUCT_IMAGE_LIMIT) {
          stats.imageFull += 1;
          notes.push(`đã đủ ${count} ảnh — bỏ qua`);
        } else {
          if (primary) stats.imageReplaceWebp += 1; else stats.imageNew += 1;
          if (detectImageType(data) !== 'image/jpeg') throw new Error(`${model}: ảnh trong gói không phải JPEG`);
          upload = { data, sha256 };
          notes.push(primary ? `nạp ảnh (thay ảnh đại diện ${String(primary.contentType)})` : 'nạp ảnh');
        }
      }
      if (!Object.keys(set).length && !upload) { console.log(`GIỮ       ${model} ${String(product.name)} — ${notes.join(', ') || 'không đổi'}`); continue; }
      console.log(`${execute ? 'CẬP NHẬT' : 'SẼ ĐỔI '}  ${model} ${String(product.name)} — ${notes.join(', ')}`);
      if (!execute) continue;

      if (upload) {
        let scan: Document = { result: 'SKIPPED', engine: 'none', scannedAt: now, reason: 'MALWARE_SCAN_MODE=off' };
        if (!scanOff) {
          // ClamAV không kết nối được → ném lỗi, dừng (fail closed như luồng tải ảnh).
          const verdict = await scanner.scan(upload.data);
          if (verdict.status === 'INFECTED') throw new Error(`${model}: ClamAV chặn ảnh (${verdict.signature})`);
          scan = { result: 'CLEAN', engine: verdict.engine, scannedAt: now };
        }
        const attachmentId = new ObjectId();
        const key = attachmentObjectKey('product-files', productId.toHexString(), attachmentId.toHexString(), 'image/jpeg');
        await storage.put(key, upload.data, 'image/jpeg', { sha256: upload.sha256, 'entity-code': model, 'uploaded-by': (actor._id as ObjectId).toHexString() });
        const document: Document = {
          _id: attachmentId, entityType: 'Product', entityId: productId, purpose: 'PRODUCT_IMAGE',
          fileName: `${model}.jpg`, contentType: 'image/jpeg', size: upload.data.length, sha256: upload.sha256,
          storage: { provider: 's3', bucket: storage.bucket, key }, scan, status: 'LINKED',
          uploadedBy: actor._id, uploadedByName: String(actor.displayName ?? actor.email), uploadedAt: now, linkedAt: now,
          importSource: 'PRICE_LIST_TEMPLATE',
        };
        await db.collection('attachments').insertOne(document);
        await db.collection('audit_events').insertOne({
          _id: new ObjectId(), actorId: (actor._id as ObjectId).toHexString(), actorEmail: ACTOR_EMAIL, action: 'PRODUCT_FILE_UPLOADED', entityType: 'Product', entityId: productId.toHexString(),
          metadata: { attachmentId: attachmentId.toHexString(), fileName: document.fileName, size: document.size, sha256: upload.sha256, storageKey: key, scan, rule: 'PRICE-IMG-01', source: bundle.source }, occurredAt: now,
        });
        set.primaryImageId = attachmentId;
      }
      const before = { specification: product.specification ?? null, primaryImageId: product.primaryImageId ? (product.primaryImageId as ObjectId).toHexString() : null };
      await db.collection('products').updateOne({ _id: productId }, { $set: { ...set, updatedAt: now }, $inc: { version: 1 } });
      await db.collection('audit_events').insertOne({
        _id: new ObjectId(), actorId: (actor._id as ObjectId).toHexString(), actorEmail: ACTOR_EMAIL, action: 'PRODUCT_UPDATED', entityType: 'Product', entityId: productId.toHexString(),
        before, after: { ...(set.specification !== undefined ? { specification: set.specification } : {}), ...(set.primaryImageId ? { primaryImageId: (set.primaryImageId as ObjectId).toHexString() } : {}) },
        metadata: { sku: model, rule: 'PRICE-IMG-01', source: bundle.source }, occurredAt: now,
      });
    }
    console.log(`\nTính năng: ${stats.featureChanged} đổi (${stats.featureOverwritten} ghi đè nội dung cũ), ${stats.featureSame} giữ nguyên.`);
    console.log(`Ảnh: ${stats.imageNew} nạp mới, ${stats.imageReplaceWebp} thay ảnh WebP, ${stats.imageKept} giữ ảnh đang có, ${stats.imageSame} đã nạp trước, ${stats.imageFull} đủ ảnh, ${stats.imageNone} dòng không có ảnh.`);
    console.log(`Mã không có trong danh mục: ${stats.missing}.`);
    if (!execute) console.log(`Chưa ghi gì. Chạy thật: PRICE_MEDIA_CONFIRM=${PRICE_MEDIA_CONFIRM} … --execute`);
  } finally {
    await client.close();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
