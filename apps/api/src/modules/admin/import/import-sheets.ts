/**
 * File mẫu nhập dữ liệu ban đầu (giai đoạn 5): mỗi loại dữ liệu một sheet, dòng 1 là tiêu đề cột (cột có * là bắt buộc).
 * Nhận diện cột theo tiêu đề (bỏ dấu *, không phân biệt hoa thường) nên có thể đổi thứ tự / bỏ cột không bắt buộc.
 */
export type ColumnType = 'text' | 'code' | 'int' | 'decimal' | 'money' | 'date' | 'enum';

export interface ColumnDef {
  key: string;
  label: string;
  required?: boolean;
  type?: ColumnType;
  /** enum: giá trị chuẩn → các cách viết được chấp nhận (không dấu, không phân biệt hoa thường). */
  values?: Record<string, string[]>;
  hint?: string;
  /** Danh sách chọn hiển thị trong file mẫu (mặc định = các giá trị chuẩn). */
  choices?: string[];
  width?: number;
}

export interface SheetDef {
  name: string;
  title: string;
  note: string;
  columns: ColumnDef[];
}

const TIERS = { TIER_1: ['npp', 'nha phan phoi', 'cap 1', 'tier_1'], TIER_2: ['dai ly', 'cap 2', 'tier_2'], RETAIL: ['le', 'khach le', 'retail'] };
const CURRENCY = { VND: ['vnd', 'dong'], CNY: ['cny', 'rmb', 'nhan dan te'], USD: ['usd', 'do la'] };

export const IMPORT_SHEETS: SheetDef[] = [
  {
    name: 'NHOM_HANG', title: 'Nhóm hàng', note: 'Nhóm sản phẩm (dùng trong sheet SAN_PHAM cột "Mã nhóm").',
    columns: [
      { key: 'code', label: 'Mã nhóm', required: true, type: 'code', width: 16 },
      { key: 'name', label: 'Tên nhóm', required: true, width: 32 },
      { key: 'sortOrder', label: 'Thứ tự', type: 'int', width: 10 },
      { key: 'description', label: 'Mô tả', width: 40 },
    ],
  },
  {
    name: 'KHU_VUC', title: 'Khu vực', note: 'Khu vực bán hàng (dùng cho khách hàng, NVKD).',
    columns: [
      { key: 'code', label: 'Mã khu vực', required: true, type: 'code', width: 16 },
      { key: 'name', label: 'Tên khu vực', required: true, width: 30 },
      { key: 'sortOrder', label: 'Thứ tự', type: 'int', width: 10 },
    ],
  },
  {
    name: 'NVKD', title: 'Nhân viên kinh doanh', note: 'Nhân viên phụ trách khách (không phải tài khoản đăng nhập).',
    columns: [
      { key: 'code', label: 'Mã NV', required: true, type: 'code', width: 14 },
      { key: 'name', label: 'Họ tên', required: true, width: 28 },
      { key: 'title', label: 'Chức danh', required: true, width: 26 },
      { key: 'role', label: 'Vai trò', type: 'enum', values: { SALES: ['nvkd', 'nhan vien', 'sales'], SALES_MANAGER: ['truong kd', 'truong phong', 'quan ly', 'sales_manager'] }, hint: 'NVKD / Trưởng KD', width: 14 },
      { key: 'regionCode', label: 'Mã khu vực', type: 'code', width: 14 },
      { key: 'phone', label: 'Điện thoại', width: 16 },
    ],
  },
  {
    name: 'NHA_CUNG_CAP', title: 'Nhà cung cấp', note: 'Công ty mẹ, nhà máy, NCC trong nước.',
    columns: [
      { key: 'code', label: 'Mã NCC', required: true, type: 'code', width: 14 },
      { key: 'name', label: 'Tên nhà cung cấp', required: true, width: 40 },
      { key: 'shortName', label: 'Tên viết tắt', width: 18 },
      { key: 'taxCode', label: 'Mã số thuế', width: 16 },
      { key: 'phone', label: 'Điện thoại', width: 16 },
      { key: 'email', label: 'Email', width: 24 },
      { key: 'address', label: 'Địa chỉ', width: 44 },
      { key: 'website', label: 'Website', width: 22 },
      { key: 'paymentTermDays', label: 'Số ngày thanh toán', type: 'int', width: 12 },
      { key: 'contactName', label: 'Người liên hệ', width: 22 },
      { key: 'contactPhone', label: 'ĐT người liên hệ', width: 16 },
    ],
  },
  {
    name: 'SAN_PHAM', title: 'Sản phẩm', note: 'Mã hàng (SKU). Giá bán lẻ theo bảng báo giá (giá khách lẻ); kích thước thùng (cm) để tính CBM.',
    columns: [
      { key: 'sku', label: 'Mã SP', required: true, type: 'code', width: 14 },
      { key: 'model', label: 'Model in', width: 14 },
      { key: 'name', label: 'Tên sản phẩm', required: true, width: 40 },
      { key: 'nameZh', label: 'Tên tiếng Trung', width: 24 },
      { key: 'nameEn', label: 'Tên tiếng Anh', width: 28 },
      { key: 'categoryCode', label: 'Mã nhóm', type: 'code', width: 14 },
      { key: 'baseUnit', label: 'Đơn vị tính', required: true, width: 10 },
      { key: 'packSize', label: 'Số cái / thùng', type: 'int', width: 10 },
      { key: 'barcode', label: 'Mã vạch đơn vị', width: 16 },
      { key: 'cartonBarcode', label: 'Mã vạch thùng', width: 16 },
      { key: 'listPrice', label: 'Giá bán lẻ', required: true, type: 'money', width: 14 },
      { key: 'standardCost', label: 'Giá vốn', type: 'money', width: 14 },
      { key: 'minimumStock', label: 'Định mức tồn', type: 'int', width: 10 },
      { key: 'hsCode', label: 'Mã HS', width: 12 },
      { key: 'customsName', label: 'Tên khai hải quan', width: 26 },
      { key: 'cartonLengthCm', label: 'Dài thùng (cm)', type: 'decimal', width: 10 },
      { key: 'cartonWidthCm', label: 'Rộng thùng (cm)', type: 'decimal', width: 10 },
      { key: 'cartonHeightCm', label: 'Cao thùng (cm)', type: 'decimal', width: 10 },
      { key: 'grossKgPerCarton', label: 'Kg cả bì / thùng', type: 'decimal', width: 10 },
      { key: 'netKgPerCarton', label: 'Kg tịnh / thùng', type: 'decimal', width: 10 },
      { key: 'purchaseCurrency', label: 'Tiền tệ mua', type: 'enum', values: CURRENCY, width: 10 },
      { key: 'purchasePrice', label: 'Giá mua', type: 'decimal', width: 12 },
      { key: 'defaultSupplierCode', label: 'Mã NCC mặc định', type: 'code', width: 14 },
      { key: 'supplierItemCode', label: 'Mã hàng NCC', width: 20 },
      { key: 'defaultLocationCode', label: 'Vị trí mặc định', type: 'code', width: 12 },
      { key: 'brand', label: 'Thương hiệu', width: 14 },
      { key: 'material', label: 'Chất liệu', width: 18 },
      { key: 'specification', label: 'Mô tả / tính năng', width: 40 },
      {
        key: 'availability', label: 'Tình trạng hàng', type: 'enum', width: 14, hint: 'Còn hàng / Đang về / Chưa có hàng',
        values: { IN_STOCK: ['con hang', 'co hang', 'san hang'], INCOMING: ['dang ve', 'sap ve', 'hang ve'], OUT_OF_STOCK: ['chua co hang', 'het hang', 'tam het'] },
        choices: ['Còn hàng', 'Đang về', 'Chưa có hàng'],
      },
      { key: 'clearance', label: 'Mã hàng clear', type: 'enum', width: 10, hint: 'Có / Không', values: { YES: ['co', 'x', 'clear', 'hang clear', 'ma hang clear'], NO: ['khong'] }, choices: ['Có', 'Không'] },
    ],
  },
  {
    name: 'BANG_GIA', title: 'Bảng giá theo cấp', note: 'Giá cho khách cấp NPP và Đại lý (khách lẻ dùng Giá bán lẻ ở sheet SAN_PHAM). Ô trống = cấp đó dùng giá bán lẻ. Nhập lại sẽ cập nhật bảng giá, phiếu đã lập giữ giá cũ.',
    columns: [
      { key: 'sku', label: 'Mã SP', required: true, type: 'code', width: 14 },
      { key: 'distributorPrice', label: 'Giá Net NPP', type: 'money', width: 14 },
      { key: 'dealerPrice', label: 'Giá đại lý', type: 'money', width: 14 },
    ],
  },
  {
    name: 'KHACH_HANG', title: 'Khách hàng', note: 'Đại lý / NPP / khách lẻ. Loại "Cơ hội" chưa lập phiếu bán được.',
    columns: [
      { key: 'code', label: 'Mã KH', required: true, type: 'code', width: 12 },
      { key: 'name', label: 'Tên khách hàng', required: true, width: 40 },
      { key: 'stage', label: 'Loại', type: 'enum', values: { CUSTOMER: ['chinh thuc', 'khach chinh thuc', 'customer'], PROSPECT: ['co hoi', 'khach co hoi', 'prospect'] }, hint: 'Chính thức / Cơ hội', width: 12 },
      { key: 'customerTier', label: 'Cấp giá', type: 'enum', values: TIERS, hint: 'NPP / Đại lý / Lẻ', width: 10 },
      { key: 'grade', label: 'Xếp hạng', type: 'enum', values: { A: ['a'], B: ['b'], C: ['c'], D: ['d'] }, width: 8 },
      { key: 'shortName', label: 'Tên viết tắt', width: 16 },
      { key: 'regionCode', label: 'Mã khu vực', type: 'code', width: 12 },
      { key: 'province', label: 'Tỉnh / thành', width: 16 },
      { key: 'salesRepCode', label: 'Mã NVKD', type: 'code', width: 12 },
      { key: 'taxCode', label: 'Mã số thuế', width: 16 },
      { key: 'phone', label: 'Điện thoại', width: 16 },
      { key: 'email', label: 'Email', width: 24 },
      { key: 'address', label: 'Địa chỉ', width: 44 },
      { key: 'creditLimit', label: 'Hạn mức công nợ', type: 'money', width: 14 },
      { key: 'paymentTermDays', label: 'Số ngày nợ', type: 'int', width: 10 },
      { key: 'source', label: 'Nguồn khách', width: 16 },
      { key: 'contactName', label: 'Người liên hệ', width: 22 },
      { key: 'contactTitle', label: 'Chức vụ', width: 16 },
      { key: 'contactPhone', label: 'ĐT người liên hệ', width: 16 },
      { key: 'deliveryAddress', label: 'Địa chỉ nhận hàng', width: 44 },
    ],
  },
  {
    name: 'TON_DAU_KY', title: 'Tồn đầu kỳ', note: 'Số lượng theo đơn vị tính cơ bản tại ngày chốt. Mỗi mã / kho chỉ một dòng.',
    columns: [
      { key: 'warehouseCode', label: 'Mã kho', required: true, type: 'code', width: 12 },
      { key: 'sku', label: 'Mã SP', required: true, type: 'code', width: 14 },
      { key: 'quantity', label: 'Số lượng', required: true, type: 'decimal', width: 12 },
      { key: 'locationCode', label: 'Vị trí', type: 'code', width: 12 },
      { key: 'unitCost', label: 'Giá vốn', type: 'money', hint: 'Đặt giá vốn nếu mã chưa có', width: 14 },
      { key: 'initialQuantity', label: 'Số lượng nhập ban đầu', type: 'decimal', hint: 'Cột 初始入库 — để tính % tồn còn lại', width: 14 },
    ],
  },
  {
    name: 'CONG_NO_DAU_KY', title: 'Công nợ đầu kỳ', note: 'Mỗi chứng từ còn nợ một dòng (số còn phải thu tại ngày chốt).',
    columns: [
      { key: 'customerCode', label: 'Mã KH', required: true, type: 'code', width: 12 },
      { key: 'documentNo', label: 'Số chứng từ', required: true, width: 18 },
      { key: 'documentDate', label: 'Ngày chứng từ', required: true, type: 'date', width: 14 },
      { key: 'dueDate', label: 'Hạn thanh toán', required: true, type: 'date', width: 14 },
      { key: 'amount', label: 'Số tiền còn nợ', required: true, type: 'money', width: 16 },
      { key: 'note', label: 'Ghi chú', width: 30 },
    ],
  },
];

export const normalize = (value: string): string =>
  value.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/đ/g, 'd').replace(/Đ/g, 'D').replace(/\*/g, '').replace(/\s+/g, ' ').trim().toLowerCase();

/** Giá trị ô exceljs → chuỗi (ngày → YYYY-MM-DD). */
export function cellText(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (value instanceof Date) {
    const shifted = new Date(value.getTime() + 7 * 3_600_000);
    return shifted.toISOString().slice(0, 10);
  }
  if (typeof value === 'number') return Number.isInteger(value) ? String(value) : String(Number(value.toFixed(6)));
  if (typeof value === 'boolean') return value ? 'TRUE' : 'FALSE';
  if (typeof value === 'object') {
    const object = value as { result?: unknown; text?: unknown; richText?: Array<{ text: string }>; hyperlink?: unknown };
    if (object.richText) return object.richText.map((part) => part.text).join('').trim();
    if (object.result !== undefined) return cellText(object.result);
    if (object.text !== undefined) return cellText(object.text);
  }
  return String(value).trim();
}

export type ParsedValue = string | number | undefined;

/** Ngày có thật (31/02 → sai; Date của JS tự lùi sang tháng sau nên phải so lại từng phần). */
function isRealDate(iso: string): boolean {
  const [year, month, day] = iso.split('-').map(Number) as [number, number, number];
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

/** Thông báo lỗi kiểm tra (zod) bằng tiếng Việt cho người nhập file. */
export function issueMessage(issue: { code: string; message: string; input?: unknown; format?: string; minimum?: unknown; maximum?: unknown }): string {
  if (/[À-ỹ]/.test(issue.message)) return issue.message;
  if (issue.code === 'invalid_type') return issue.input === undefined ? 'Bắt buộc nhập' : 'Sai kiểu dữ liệu';
  if (issue.code === 'invalid_format') return issue.format === 'email' ? 'Email không hợp lệ' : 'Sai định dạng';
  if (issue.code === 'too_small') return `Quá ngắn / quá nhỏ (tối thiểu ${String(issue.minimum)})`;
  if (issue.code === 'too_big') return `Quá dài / quá lớn (tối đa ${String(issue.maximum)})`;
  return 'Giá trị không hợp lệ';
}

/** Chuyển chuỗi trong ô theo kiểu cột; lỗi trả về chuỗi mô tả. */
export function parseCell(column: ColumnDef, raw: string): { value: ParsedValue } | { error: string } {
  const text = raw.trim();
  if (!text) return column.required ? { error: 'Bắt buộc nhập' } : { value: undefined };
  switch (column.type ?? 'text') {
    case 'code': {
      const code = text.toUpperCase();
      return /^[A-Z0-9][A-Z0-9._/-]{1,39}$/.test(code) ? { value: code } : { error: 'Mã chỉ gồm chữ hoa, số, . _ / - (2–40 ký tự)' };
    }
    case 'int': {
      const cleaned = text.replace(/[.,\s](?=\d{3}\b)/g, '');
      return /^\d+$/.test(cleaned) ? { value: Number(cleaned) } : { error: 'Phải là số nguyên không âm' };
    }
    case 'decimal':
    case 'money': {
      let cleaned = text.replace(/\s/g, '');
      // "1.234.567" / "1,234,567" (phân cách nghìn) và "12,5" (dấu phẩy thập phân).
      if (/^\d{1,3}([.,]\d{3})+$/.test(cleaned) && column.type === 'money') cleaned = cleaned.replace(/[.,]/g, '');
      else if (/^\d+,\d+$/.test(cleaned)) cleaned = cleaned.replace(',', '.');
      if (!/^\d+(\.\d+)?$/.test(cleaned)) return { error: 'Phải là số không âm' };
      const places = cleaned.split('.')[1]?.length ?? 0;
      if (column.type === 'money' && places > 2) return { error: 'Số tiền tối đa 2 chữ số lẻ' };
      if (places > 4) return { error: 'Tối đa 4 chữ số lẻ' };
      return { value: cleaned };
    }
    case 'date': {
      if (/^\d{4}-\d{2}-\d{2}$/.test(text)) return isRealDate(text) ? { value: text } : { error: 'Ngày không hợp lệ' };
      const match = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/.exec(text);
      if (!match) return { error: 'Ngày dạng dd/mm/yyyy' };
      const iso = `${match[3]}-${match[2]!.padStart(2, '0')}-${match[1]!.padStart(2, '0')}`;
      return isRealDate(iso) ? { value: iso } : { error: 'Ngày không hợp lệ' };
    }
    case 'enum': {
      const wanted = normalize(text);
      for (const [value, aliases] of Object.entries(column.values ?? {})) {
        if (wanted === normalize(value) || aliases.some((alias) => normalize(alias) === wanted)) return { value };
      }
      return { error: `Giá trị không hợp lệ${column.hint ? ` (${column.hint})` : ''}` };
    }
    default:
      return { value: text };
  }
}
