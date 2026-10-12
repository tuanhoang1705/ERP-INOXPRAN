/**
 * Thanh tab "chứng từ đang mở" (như hệ thống của công ty mẹ): mỗi tab là một đường dẫn cửa sổ chứng từ,
 * tối đa 10 tab, lưu trong sessionStorage của tab trình duyệt. Chuyển tab là mở lại trang đó (dữ liệu tải lại;
 * thay đổi chưa lưu được cửa sổ chứng từ cảnh báo trước khi rời).
 */
export interface WorkspaceTab {
  href: string;
  title: string;
}

const KEY = 'erp:workspace';
export const MAX_WORKSPACE_TABS = 10;

function load(): WorkspaceTab[] {
  try {
    const parsed = JSON.parse(sessionStorage.getItem(KEY) ?? '[]') as WorkspaceTab[];
    return Array.isArray(parsed) ? parsed.filter((tab) => typeof tab.href === 'string' && typeof tab.title === 'string').slice(0, MAX_WORKSPACE_TABS) : [];
  } catch {
    return [];
  }
}

export const workspace = $state<{ tabs: WorkspaceTab[] }>({ tabs: typeof sessionStorage === 'undefined' ? [] : load() });

function save(): void {
  try {
    sessionStorage.setItem(KEY, JSON.stringify(workspace.tabs));
  } catch {
    // Không lưu được: thanh tab chỉ còn trong phiên trang hiện tại.
  }
}

/** Mở (hoặc cập nhật tiêu đề) tab cho cửa sổ chứng từ đang xem; quá 10 tab thì bỏ tab cũ nhất. */
export function openWorkspaceTab(href: string, title: string): void {
  const existing = workspace.tabs.find((tab) => tab.href === href);
  if (existing) {
    if (existing.title !== title) {
      existing.title = title;
      save();
    }
    return;
  }
  workspace.tabs = [...workspace.tabs, { href, title }].slice(-MAX_WORKSPACE_TABS);
  save();
}

/** Đóng tab; trả về tab nên chuyển sang (bên trái, nếu không có thì bên phải) khi đóng tab đang xem. */
export function closeWorkspaceTab(href: string): WorkspaceTab | null {
  const index = workspace.tabs.findIndex((tab) => tab.href === href);
  if (index < 0) return null;
  workspace.tabs = workspace.tabs.filter((tab) => tab.href !== href);
  save();
  return workspace.tabs[index - 1] ?? workspace.tabs[index] ?? null;
}

export function closeAllWorkspaceTabs(): void {
  workspace.tabs = [];
  save();
}
