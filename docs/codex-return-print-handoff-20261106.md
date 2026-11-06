# In phiếu trả hàng — phần bổ sung độc lập của Codex, 06/11/2026

Yêu cầu của người dùng: in phiếu trả hàng theo ảnh PHIẾU NHẬP KHO A4, xong trước 16:00, giữ nguyên luồng Claude đang thực hiện. Người dùng đã báo Claude chờ tích hợp trước khi triển khai production.

## Mã nguồn đã ghép vào workspace

- Nút **In phiếu** dưới số phiếu ở `/inventory/returns`, hiện cho mọi người đã được xem danh sách; mở tab mới.
- Trang mới `/print/stock-return/:id`: pháp nhân hiện tại, ngày nhận hàng theo giờ Việt Nam, số NK/XT, thông tin khách, diễn giải, nhân viên phụ trách, kho, 7 cột hàng, VAT/tổng và 5 ô ký. Hàng mẫu bằng 0; phiếu chưa định giá để trống. Nợ/Có là ô tùy chọn chỉ dùng trên bản in. In hoặc Lưu dưới dạng PDF bằng hộp thoại trình duyệt.
- API chỉ đọc `GET /api/v1/inventory/returns/:id/print`, tái sử dụng kiểm tra quyền/phiếu hủy của `StockReturnsService.get`. Tiền ưu tiên dòng giảm nợ đã được kế toán ghi, sau đó giá trị đã lưu trên phiếu; không tự lấy giá nguồn đã thay đổi để thay số tiền của phiếu.
- Trả nhà máy dùng PHIẾU XUẤT KHO. Phiếu hủy có dấu ĐÃ HỦY. Danh sách dài ngắt trang, lặp tiêu đề bảng, giữ phần ký cùng nhau.

## Phạm vi tránh xung đột

5 tệp mới: `stock-return-print.controller.ts`, `stock-return-print-pricing.ts`, test của pricing (trong module inventory); `apps/web/src/lib/stock-return-print.ts`; `apps/web/src/routes/print/stock-return/[id]/+page.svelte`.

Chỉ 2 tệp có sẵn được chạm: `inventory.module.ts` thêm controller; trang `inventory/returns/+page.svelte` thêm import Printer và một link In phiếu. Không thay các dòng/sửa chữa khác của Claude trong trang đó. Không sửa luồng trả hàng, bảo hành, phiếu BH, contracts/index, hay messages/vi.json, zh.json.

## Kiểm chứng

Đã kiểm tra trong bản chụp workspace riêng `.tmp/return-print-20261106/workspace`, dùng cổng 5191/3011. Không reset/seed CSDL, không khởi động lại API/web/worker Claude. Pricing: 7/7 test. API type-check và API build đạt; Svelte check 0 lỗi/0 cảnh báo. HTTP đã thử 6 phiếu sẵn có (khách, mẫu, nhà máy), 401/400/404; SHA-256 của phiếu trả, tồn kho, thẻ kho, phải thu, thanh toán trước/sau các GET giữ nguyên. Kiểm tra giao diện/PDF: mẫu ngắn A4 một trang, chưa có tiền không in 0, 70 dòng đủ và có chữ ký.

Chốt lúc 15:54: API build, web production build và API type-check đều đạt; 7/7 test pricing, 13/13 kiểm tra giao diện/PDF đạt. Đã mở danh sách từ production build, bấm nút In phiếu trên một phiếu có thật ở CSDL local, tab mới tải API thật và in một trang A4, không có lỗi JavaScript. Bản in tên/địa chỉ dài đã kiểm tra trực quan, không đè lên Nợ/Có. Mọi thay đổi mới đã được so khớp giữa bản kiểm thử riêng và workspace chính.

Tệp QA và các lệnh nằm ở `.tmp/return-print-20261106/`; ảnh/PDF nằm ở `output/playwright/return-print-*`. `return-print-sample.png` là mẫu hàng mẫu theo ảnh người dùng; `return-print-real.png` là luồng đã chạy với API local thật.

## Triển khai phối hợp với Claude

**Đã triển khai thành công lúc 16:13 ngày 06/11/2026**, theo yêu cầu trực tiếp của người dùng lúc 15:57. Staging và production đều đang chạy tag `20261106-160206-return-print`, thay staging `20261106-153004` và production `20261105-105018`.

Nguồn đóng gói là bản snapshot đã kiểm thử, đã so khớp đủ 433 tệp apps/packages với workspace trước khi build. Không có lệnh triển khai nào đang chạy trên cả hai máy khi bắt đầu. Image API và web trên production có digest trùng hoàn toàn staging; không build lại khi chuyển production.

Kiểm chứng staging: đăng nhập tài khoản kho bình thường, in dữ liệu của 10 phiếu (khách, mẫu, phiếu có giá trị); 401/404 đúng; trang và tài nguyên giao diện tải qua HTTPS. Production: API/Mongo/ClamAV healthy, web/worker/Caddy running; bản in đọc được 17 phiếu chưa hủy; route và tài nguyên mới tải qua HTTPS, API không đăng nhập trả 401. SHA-256 trước/sau của **7 collection** phiếu trả, tồn kho, thẻ kho, phải thu, thanh toán, phiếu bán, phiếu bảo hành **khớp hoàn toàn**.

Sao lưu trước triển khai đã kiểm tra S3 có version/AES256: `backups/hourly/inoxpran-production-20261106T090211Z.archive.gz`, 738401 byte. Bản trước để quay lại: `20261105-105018`.

Nhật ký và biên bản ở `.tmp/return-print-20261106/production-release-complete.json`, `production-verification-result.json`, `production-public-verification.json` và `release-source-manifest.json`. Không cần triển khai lại phần in phiếu; Claude có thể tiếp tục các công việc khác từ workspace hiện tại và giữ các tệp phần in này. API mới chỉ đọc, không có migration hay thay đổi cấu trúc dữ liệu.
