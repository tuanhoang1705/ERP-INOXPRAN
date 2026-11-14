import { Inject, Injectable } from '@nestjs/common';
import ExcelJS from 'exceljs';
import type { Db, Document, ObjectId } from 'mongodb';
import { INOXPRAN_LOGO } from '../../common/brand-logo';
import { dateBounds } from '../../common/date-range';
import { decimalString, toObjectId } from '../../common/domain';
import { EvidenceIntakeService } from '../../common/evidence-intake.service';
import { pageOf, type PageRequest } from '../../common/paging';
import { MONGO_DATABASE } from '../../common/tokens';

export interface PriceListQuery {
  search?: string | undefined;
  categoryId?: string | undefined;
  /** Bảng giá áp dụng tại cuối một ngày (LIST-DATE-01); bỏ trống = hiện tại. */
  at?: string | undefined;
}

export interface PriceListRow {
  productId: string;
  sku: string;
  model?: string;
  name: string;
  categoryName?: string;
  baseUnit: string;
  packSize?: number;
  /** Tính năng sản phẩm (PRICE-IMG-01): mô tả tiếng Việt của mã hàng — cột "Tính năng sản phẩm" của bảng báo giá. */
  specification?: string;
  /** Ảnh đại diện của mã hàng (đọc qua /attachments/products/:id/:imageId). */
  imageId?: string;
  distributorPrice: string | null;
  dealerPrice: string | null;
  retailPrice: string;
  availability: string;
  clearance: boolean;
}

const AVAILABILITY_TEXT: Record<string, string> = { IN_STOCK: 'Còn hàng', INCOMING: 'Đang về', OUT_OF_STOCK: 'Chưa có hàng' };
const escapeRegex = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Kích thước ảnh PNG / JPEG đọc từ phần đầu file (không cần thư viện ảnh). */
export function imageSize(data: Buffer): { type: 'png' | 'jpeg'; width: number; height: number } | null {
  if (data.length > 24 && data.readUInt32BE(0) === 0x89504e47) return { type: 'png', width: data.readUInt32BE(16), height: data.readUInt32BE(20) };
  if (data.length > 4 && data[0] === 0xff && data[1] === 0xd8) {
    let offset = 2;
    while (offset + 9 < data.length) {
      if (data[offset] !== 0xff) return null;
      const marker = data[offset + 1] as number;
      const length = data.readUInt16BE(offset + 2);
      // SOF0–SOF15 trừ DHT (C4), JPG (C8), DAC (CC): chiều cao, chiều rộng của ảnh.
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        return { type: 'jpeg', height: data.readUInt16BE(offset + 5), width: data.readUInt16BE(offset + 7) };
      }
      offset += 2 + length;
    }
  }
  return null;
}

/**
 * Bảng giá theo cấp (Giá & Khuyến mãi) và file Excel "Bảng báo giá" (PRICE-IMG-01, 11/11/2026 — theo mẫu "Bảng Báo Giá Inoxpran"
 * của công ty): STT, Model, Tên sản phẩm, Hình ảnh, Tính năng sản phẩm, Số SP/thùng, Giá đại lý, Giá Net NPP, Giá bán lẻ, Tình trạng.
 */
@Injectable()
export class PriceListService {
  constructor(
    @Inject(MONGO_DATABASE) private readonly db: Db,
    private readonly evidence: EvidenceIntakeService,
  ) {}

  /** Giá Net NPP (cấp 1), giá đại lý (cấp 2) theo bảng giá hiện hành, giá bán lẻ theo hồ sơ mã hàng. */
  async list(query: PriceListQuery, paging: PageRequest | null) {
    const bounds = query.at ? dateBounds(query.at, query.at) : null;
    const now = bounds?.$lt ? new Date(bounds.$lt.getTime() - 1) : new Date();
    const filter: Document = { status: 'ACTIVE' };
    if (query.categoryId) filter.categoryId = toObjectId(query.categoryId, 'categoryId');
    if (query.search) {
      const pattern = new RegExp(escapeRegex(query.search), 'i');
      filter.$or = [{ sku: pattern }, { name: pattern }, { model: pattern }];
    }
    const cursor = this.db.collection('products').find(filter).sort({ sku: 1 });
    const [products, categories, books] = await Promise.all([
      (paging ? cursor.skip(paging.skip).limit(paging.pageSize) : cursor).toArray(),
      this.db.collection('product_categories').find({}).toArray(),
      this.db.collection('price_books').find({
        status: 'PUBLISHED',
        validFrom: { $lte: now },
        $or: [{ validTo: null }, { validTo: { $gte: now } }],
      }).sort({ priority: -1, version: -1 }).toArray(),
    ]);
    const categoryById = new Map(categories.map((row) => [(row._id as ObjectId).toHexString(), row]));
    const priceFor = (tier: string, productId: ObjectId): string | null => {
      for (const book of books) {
        if (book.customerTier !== tier && book.customerTier !== 'ALL') continue;
        const line = (book.lines as Array<{ productId: ObjectId; baseUnitPrice: unknown }>).find((item) => item.productId.equals(productId));
        if (line) return decimalString(line.baseUnitPrice);
      }
      return null;
    };
    const booksSummary = books.map((book) => ({
      code: String(book.code),
      name: String(book.name),
      customerTier: String(book.customerTier),
      version: Number(book.version),
      validFrom: (book.validFrom as Date).toISOString(),
      lineCount: (book.lines as unknown[]).length,
    }));
    const rows: PriceListRow[] = products.map((product) => {
      const id = product._id as ObjectId;
      const category = product.categoryId ? categoryById.get((product.categoryId as ObjectId).toHexString()) : undefined;
      return {
        productId: id.toHexString(),
        sku: String(product.sku),
        ...(product.model ? { model: String(product.model) } : {}),
        name: String(product.name),
        ...(category ? { categoryName: String(category.name) } : {}),
        baseUnit: String(product.baseUnit),
        ...(product.packSize ? { packSize: product.packSize as number } : {}),
        ...(product.specification ? { specification: String(product.specification) } : {}),
        ...(product.primaryImageId ? { imageId: (product.primaryImageId as ObjectId).toHexString() } : {}),
        distributorPrice: priceFor('TIER_1', id),
        dealerPrice: priceFor('TIER_2', id),
        retailPrice: decimalString(product.listPrice),
        availability: String(product.availability ?? 'IN_STOCK'),
        clearance: Boolean(product.clearance),
      };
    });
    if (!paging) return { books: booksSummary, rows };
    return { books: booksSummary, ...pageOf(rows, await this.db.collection('products').countDocuments(filter), paging) };
  }

  /** File Excel bảng báo giá theo mẫu công ty, kèm ảnh đại diện của từng mã (JPEG / PNG). */
  async export(query: PriceListQuery): Promise<{ fileName: string; data: Buffer }> {
    const { rows } = await this.list(query, null);
    const attachments = await this.db.collection('attachments').find(
      { _id: { $in: rows.filter((row) => row.imageId).map((row) => toObjectId(row.imageId as string, 'imageId')) }, entityType: 'Product', purpose: 'PRODUCT_IMAGE' },
    ).toArray();
    const attachmentById = new Map(attachments.map((row) => [(row._id as ObjectId).toHexString(), row]));

    const workbook = new ExcelJS.Workbook();
    workbook.creator = 'INOXPRAN ERP';
    workbook.company = 'INOXPRAN';
    const sheet = workbook.addWorksheet('Bảng báo giá', {
      views: [{ state: 'frozen', ySplit: 2, showGridLines: false }],
      pageSetup: {
        paperSize: 9, orientation: 'landscape', fitToPage: true, fitToWidth: 1, fitToHeight: 0,
        margins: { left: 0.3, right: 0.3, top: 0.4, bottom: 0.5, header: 0.2, footer: 0.25 }, horizontalCentered: true, printTitlesRow: '1:2',
      },
      headerFooter: { oddFooter: '&C&8Trang &P/&N' },
    });
    // Độ rộng cột theo file mẫu (tên sản phẩm của ERP dài hơn mẫu nên cột C rộng hơn).
    const widths = [6, 13, 22, 34, 46, 12, 17, 17, 17, 16];
    sheet.columns = widths.map((width) => ({ width }));
    const thin = { style: 'thin' as const, color: { argb: 'FF000000' } };
    const border = { top: thin, bottom: thin, left: thin, right: thin };
    const green: ExcelJS.Fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF92D050' } };

    // Dòng 1: logo + tên công ty + tiêu đề (như dòng đầu file mẫu).
    sheet.getRow(1).height = 60;
    sheet.mergeCells('D1:J1');
    const atText = query.at ? `${query.at.slice(8, 10)}/${query.at.slice(5, 7)}/${query.at.slice(0, 4)}` : new Intl.DateTimeFormat('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh', day: '2-digit', month: '2-digit', year: 'numeric' }).format(new Date());
    const title = sheet.getCell('D1');
    title.value = {
      richText: [
        { text: 'CÔNG TY TNHH ĐẦU TƯ THẮNG VƯỢNG\n', font: { name: 'Arial', size: 10, color: { argb: 'FF5A6B7C' } } },
        { text: 'BẢNG BÁO GIÁ SẢN PHẨM', font: { name: 'Arial', size: 18, bold: true, color: { argb: 'FF123B5E' } } },
        { text: `\nÁp dụng ngày ${atText}`, font: { name: 'Arial', size: 10, italic: true, color: { argb: 'FF5A6B7C' } } },
      ],
    };
    title.alignment = { vertical: 'middle', horizontal: 'left', wrapText: true };
    const logo = workbook.addImage({ base64: INOXPRAN_LOGO.base64, extension: 'png' });
    const logoHeight = 44;
    sheet.addImage(logo, { tl: { col: 0.15, row: 0.17 }, ext: { width: Math.round((INOXPRAN_LOGO.width / INOXPRAN_LOGO.height) * logoHeight), height: logoHeight }, editAs: 'oneCell' });

    // Dòng 2: đầu bảng.
    const headers = ['STT', 'MODEL', 'TÊN SẢN PHẨM', 'HÌNH ẢNH', 'TÍNH NĂNG SẢN PHẨM', 'SỐ SP/THÙNG', 'GIÁ ĐẠI LÝ', 'Giá Net NPP', 'GIÁ BÁN LẺ', 'TÌNH TRẠNG HÀNG HÓA'];
    const header = sheet.getRow(2);
    header.height = 33;
    headers.forEach((text, index) => {
      const cell = header.getCell(index + 1);
      cell.value = text;
      cell.font = { name: 'Arial', size: 12, bold: true };
      cell.alignment = { horizontal: 'center', vertical: 'middle', wrapText: true };
      cell.border = border;
      if (index === 7) cell.fill = green;
    });

    // Ảnh nằm giữa cột D: cột ~34 ký tự ≈ 243 px; ảnh tối đa 220 × 170 px.
    const columnPx = widths[3]! * 7 + 5;
    const maxWidth = 220;
    const maxHeight = 170;
    let rowNumber = 3;
    for (const [index, item] of rows.entries()) {
      const row = sheet.getRow(rowNumber);
      const status = `${AVAILABILITY_TEXT[item.availability] ?? item.availability}${item.clearance ? '\n(Mã hàng clear)' : ''}`;
      const values: Array<string | number | null> = [
        index + 1, item.model ?? item.sku, item.name, null, item.specification ?? '', item.packSize ?? null,
        item.dealerPrice ? Number(item.dealerPrice) : null, item.distributorPrice ? Number(item.distributorPrice) : null, Number(item.retailPrice), status,
      ];
      values.forEach((value, column) => {
        const cell = row.getCell(column + 1);
        cell.value = value;
        cell.border = border;
        cell.font = { name: 'Times New Roman', size: column === 4 || column === 9 ? 13 : 12 };
        cell.alignment = column === 4 ? { vertical: 'middle', horizontal: 'left', wrapText: true } : { vertical: 'middle', horizontal: 'center', wrapText: true };
        if (column >= 6 && column <= 8) cell.numFmt = '#,##0';
        if (column === 7) cell.fill = green;
      });
      // Chiều cao dòng: đủ cho ảnh và cho các dòng tính năng (mỗi dòng ~17 pt, cột E ~46 ký tự / dòng).
      const featureLines = (item.specification ?? '').split('\n').reduce((sum, line) => sum + Math.max(1, Math.ceil(line.length / 46)), 0);
      let imageHeightPx = 0;
      const attachment = item.imageId ? attachmentById.get(item.imageId) : undefined;
      if (attachment) {
        const file = await this.evidence.read(attachment).catch(() => null);
        const size = file ? imageSize(file.data) : null;
        if (file && size) {
          const scale = Math.min(maxWidth / size.width, maxHeight / size.height, 1);
          const width = Math.round(size.width * scale);
          imageHeightPx = Math.round(size.height * scale);
          const imageId = workbook.addImage({ buffer: file.data as unknown as ExcelJS.Buffer, extension: size.type });
          row.height = Math.max(40, featureLines * 17 + 14, (imageHeightPx + 16) * 0.75);
          const rowPx = (row.height as number) / 0.75;
          sheet.addImage(imageId, {
            tl: { col: 3 + (columnPx - width) / 2 / columnPx, row: rowNumber - 1 + (rowPx - imageHeightPx) / 2 / rowPx },
            ext: { width, height: imageHeightPx },
            editAs: 'oneCell',
          });
        } else if (file) {
          // Ảnh định dạng khác (VD WebP tải lên trước 11/11/2026): Excel không đọc được — tải lại ảnh JPEG / PNG ở danh mục sản phẩm.
          row.getCell(4).value = '(ảnh chưa đúng định dạng — tải lại ảnh ở danh mục sản phẩm)';
          row.getCell(4).font = { name: 'Arial', size: 9, italic: true, color: { argb: 'FF9AA5B1' } };
        }
      }
      if (!imageHeightPx) row.height = Math.max(40, featureLines * 17 + 14);
      rowNumber += 1;
    }
    sheet.autoFilter = { from: { row: 2, column: 1 }, to: { row: Math.max(2, rowNumber - 1), column: headers.length } };
    const stamp = (query.at ?? new Date(Date.now() + 7 * 3_600_000).toISOString().slice(0, 10)).replace(/-/g, '');
    return { fileName: `Bang_Bao_Gia_INOXPRAN_${stamp}.xlsx`, data: Buffer.from(await workbook.xlsx.writeBuffer()) };
  }
}
