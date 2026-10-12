/**
 * Ô tìm chức năng (NAV-02, 09/10/2026): mọi màn hình trong menu + các thao tác nhanh ngoài menu,
 * lọc theo vai trò / quản trị gốc giống menu, tìm không phân biệt dấu và hoa thường.
 */
import { foldText } from '$shared/text';
import { m } from '$lib/paraglide/messages';
import type { NavSection } from '$lib/nav';

export interface CommandItem {
  label: string;
  href: string;
  /** "Phân hệ › Nhóm" để biết chức năng nằm ở đâu. */
  path: string;
  keywords: string;
  /** Mọi tầng phải qua (phân hệ, mục); ADMIN luôn qua. */
  roleGates: Array<string[] | undefined>;
  rootOnly?: boolean | undefined;
}

export interface CommandUser {
  roles: string[];
  root?: boolean | undefined;
}

const WAREHOUSE_EDITORS = ['DIRECTOR', 'WAREHOUSE_MANAGER', 'WAREHOUSE'];

/** Từ khóa phụ (không dấu) cho các chức năng hay tìm theo tên gọi tắt. */
const KEYWORDS: Record<string, string> = {
  '/': 'tong quan dashboard bang dieu khien',
  '/sales/orders': 'bh swk phieu xuat kho ban hang don hang',
  '/sales/orders/new': 'bh lap phieu de nghi xuat ban tao phieu ban hang',
  '/approvals': 'duyet phe duyet ngoai le',
  '/inventory': 'ton kho kha dung so luong',
  '/inventory/movements': 'the kho lich su xuat nhap',
  '/inventory/counts': 'kiem ke kiem kho dem hang chot ton cuoi thang',
  '/inventory/shipments': 'swk giao hang xuat kho',
  '/inventory/returns': 'tra hang khach tra tra nha may',
  '/inventory/reports/monthly': 'bao cao ton kho thang excel',
  '/inventory/reports/journal': 'nhat ky xuat nhap excel',
  '/inventory/transfers/new': 'chuyen kho dieu chuyen',
  '/inventory?adjust=1': 'dieu chinh ton hao hut hang mau',
  '/procurement': 'po don mua nhap kho nhap hang',
  '/procurement/new': 'po lap don mua nhap hang dat hang',
  '/procurement/shipments': 'lo hang nhap khau container',
  '/receivables': 'cong no thu tien so chi tiet',
  '/receivables/overdue': 'tuoi no qua han canh bao cong no',
  '/catalog/products': 'san pham sku ma hang danh muc',
  '/catalog/dealers': 'khach hang dai ly npp ho so',
  '/catalog/suppliers': 'nha cung cap ncc',
  '/catalog/warehouses': 'kho vi tri luu',
  '/catalog/regions': 'khu vuc nhan vien kinh doanh nvkd',
  '/pricing': 'bang gia gia npp dai ly',
  '/pricing/promotions': 'khuyen mai ctkm',
  '/pricing/tiers': 'chiet khau bac doanh so',
  '/warranty': 'bao hanh sc sua chua',
  '/warranty/new': 'tiep nhan bao hanh sc',
  '/admin/users': 'nguoi dung tai khoan phan quyen mat khau',
  '/admin/system': 'giam sat he thong sao luu',
  '/admin/audit': 'nhat ky he thong audit log',
  '/admin/import': 'nhap du lieu ban dau excel import',
  '/settings': 'thiet lap he thong misa tich hop',
  '/account': 'tai khoan cua toi doi mat khau mfa xac thuc',
};

/** Thao tác hay dùng nằm ngoài menu (nút trên trang). */
export function quickActions(): CommandItem[] {
  const path = m.cmd_thao_tac();
  const action = (label: string, href: string, roles?: string[]): CommandItem => ({ label, href, path, keywords: KEYWORDS[href] ?? '', roleGates: [roles] });
  return [
    action(m.lap_phieu_bh(), '/sales/orders/new', ['ACCOUNTANT', 'SALES', 'SALES_MANAGER']),
    action(m.lap_don_mua(), '/procurement/new', ['PROCUREMENT', 'PROCUREMENT_MANAGER']),
    action(m.crud_dieu_chinh_ton(), '/inventory?adjust=1', WAREHOUSE_EDITORS),
    action(m.dieu_chuyen_kho(), '/inventory/transfers/new', WAREHOUSE_EDITORS),
    action(m.cmd_tai_khoan(), '/account'),
  ];
}

/** Phẳng hóa menu thành danh sách chức năng (kèm đường dẫn "Phân hệ › Nhóm"). */
export function buildCommands(sections: readonly NavSection[], extra: readonly CommandItem[] = []): CommandItem[] {
  const items: CommandItem[] = [];
  for (const section of sections) {
    for (const group of section.groups) {
      for (const item of group.items) {
        items.push({
          label: item.label,
          href: item.href,
          path: group.title === section.label ? section.label : `${section.label} › ${group.title}`,
          keywords: KEYWORDS[item.href] ?? '',
          roleGates: [section.roles, item.roles],
          rootOnly: item.rootOnly,
        });
      }
    }
  }
  return [...items, ...extra];
}

const passes = (roles: string[], required: string[] | undefined) => !required?.length || roles.includes('ADMIN') || roles.some((role) => required.includes(role));

/** Chức năng người dùng được dùng (cùng quy tắc menu), bỏ trùng đường dẫn — giữ mục đầu tiên. */
export function visibleCommands(items: readonly CommandItem[], user: CommandUser | null | undefined): CommandItem[] {
  if (!user) return [];
  const seen = new Set<string>();
  return items.filter((item) => {
    if (item.rootOnly && !user.root) return false;
    if (!item.roleGates.every((gate) => passes(user.roles, gate))) return false;
    if (seen.has(item.href)) return false;
    seen.add(item.href);
    return true;
  });
}

/** Xếp hạng: khớp đầu tên > đầu một từ của tên > giữa tên > chỉ khớp từ khóa / đường dẫn. Mọi từ gõ phải khớp. */
export function searchCommands(items: readonly CommandItem[], query: string, limit = 12): CommandItem[] {
  const q = foldText(query);
  if (!q) return [];
  const tokens = q.split(' ');
  const scored: Array<{ item: CommandItem; score: number }> = [];
  for (const item of items) {
    const label = foldText(item.label);
    const extra = `${foldText(item.path)} ${item.keywords} ${item.href.toLowerCase()}`;
    if (!tokens.every((token) => label.includes(token) || extra.includes(token))) continue;
    let score = 0;
    if (label.startsWith(q)) score = 100;
    else if (label.split(' ').some((word, index, words) => words.slice(index).join(' ').startsWith(q))) score = 80;
    else if (label.includes(q)) score = 60;
    else if (tokens.every((token) => label.includes(token))) score = 50;
    else if (item.keywords.includes(q)) score = 40;
    else score = 20;
    scored.push({ item, score: score - label.length / 100 });
  }
  return scored.sort((a, b) => b.score - a.score).slice(0, limit).map((entry) => entry.item);
}
