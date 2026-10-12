// Ứng dụng chạy hoàn toàn phía trình duyệt (adapter-static + fallback, dữ liệu tải sau khi đăng nhập).
// Tắt SSR để bản dev giống production và để ngôn ngữ (đọc từ localStorage) không lệch giữa máy chủ và trình duyệt.
export const ssr = false;
