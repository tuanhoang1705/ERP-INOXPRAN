# Kiến trúc và bất biến nghiệp vụ

## Ranh giới module

`Identity`, `Catalog`, `Procurement`, `Inventory`, `Sales/Pricing`, `Approval`, `Fulfillment`, `Receivables`, `Reporting`, `Integration` và `Audit` dùng chung một database nhưng không sửa trực tiếp collection thuộc module khác ngoài transaction nghiệp vụ đã định nghĩa.

## Trạng thái chính

```text
SalesOrder:    DRAFT → PENDING_APPROVAL → RESERVED → SHIPPED → DELIVERED
                    ↘ RESERVED (tự duyệt)

PurchaseOrder: DRAFT → PENDING_APPROVAL → APPROVED → PARTIALLY_RECEIVED → RECEIVED
                    ↘ APPROVED (tự duyệt)

Receivable:    OPEN → PARTIALLY_PAID → PAID
```

Các trạng thái kết thúc không được quay ngược bằng update trực tiếp. Hủy/đảo giao dịch phải sinh chứng từ và movement bù riêng.

## Bất biến bắt buộc

1. `available = onHand - reserved` và không bao giờ nhỏ hơn 0 sau transaction thành công.
2. Một order chỉ được giữ hàng một lần; một reservation chỉ được tiêu thụ một lần.
3. Tổng payment allocation phải bằng số tiền payment và không vượt outstanding của từng receivable.
4. Giá dùng cho order là snapshot; thay đổi bảng giá sau đó không làm đổi chứng từ cũ.
5. Mỗi lệnh tạo/submit/approve/post có `Idempotency-Key`; retry cùng key trả lại cùng kết quả.
6. Update trạng thái dùng `version`; bản ghi bị thay đổi đồng thời trả conflict thay vì ghi đè.
7. Quantity/money lưu `Decimal128`; API trao đổi chuỗi thập phân để tránh lỗi IEEE-754.
8. Mọi transaction ảnh hưởng tiền/tồn có audit event cùng correlation ID.

## Nguồn chuẩn

- INOXPRAN ERP: đơn mua/bán, reservation, kho, giao hàng, công nợ vận hành.
- MISA AMIS: kế toán và báo cáo pháp định cho đến khi giai đoạn kế toán tổng hợp chạy song song, khớp hai kỳ khóa sổ và được phê duyệt chuyển đổi.
- Lịch sử khóa: vùng chỉ đọc, giữ `sourceSystem`, `sourceDocumentId`, checksum và batch import.

## Xử lý bất đồng bộ và tích hợp MISA dự kiến

Các transaction cần phát sự kiện ghi transactional outbox trong cùng transaction MongoDB. Relay claim event theo `PENDING → PROCESSING → ENQUEUED`; BullMQ worker xử lý idempotent rồi chuyển sang `SENT`. Lỗi tạm thời retry exponential backoff, lỗi vĩnh viễn chuyển `DEAD_LETTER`. Handler đầu tiên tạo thông báo trong ứng dụng cho chứng từ chờ duyệt.

Adapter MISA giai đoạn 2 dùng cùng cơ chế trên. Mapping ID hai hệ thống là duy nhất theo loại chứng từ; không đồng bộ hai chiều cùng một trường/chứng từ.

## Đa ngôn ngữ

Giao diện web dùng [Paraglide JS](https://inlang.com/m/gerre34r/library-inlang-paraglideJs) (inlang): ngôn ngữ gốc `vi`, thêm `zh` (tiếng Trung giản thể). Chữ giao diện nằm ở `apps/web/messages/{vi,zh}.json`; plugin Vite biên dịch thành hàm `m.<khóa>()` có kiểm tra kiểu, thiếu khóa hoặc sai tham số thì `svelte-check` báo lỗi.

- Ngôn ngữ đã chọn lưu ở localStorage; lần đầu lấy theo trình duyệt, không khớp thì dùng tiếng Việt. Đổi ngôn ngữ tải lại trang. Số, ngày định dạng theo `vi-VN` / `zh-CN`; thuộc tính `lang` của trang là `zh-Hans` để trình duyệt chọn đúng phông chữ Hán.
- Lỗi API: giao diện dịch theo `code` (khóa `err_<code>`); chưa có bản dịch thì hiện thông báo tiếng Việt của máy chủ.
- Cảnh báo dashboard và thông báo trong ứng dụng: máy chủ gửi kèm `template` + `params` (`DASHBOARD_ALERT_TEMPLATES`, `NOTIFICATION_TEMPLATES` trong contracts), giao diện dựng câu theo ngôn ngữ (`apps/web/src/lib/server-text.ts`). Chữ tiếng Việt lưu kèm là bản dự phòng cho thông báo cũ. Thêm loại thông báo mới: thêm mã vào `NOTIFICATION_TEMPLATES`, gửi `template`/`params` khi tạo, thêm câu vào hai file messages và `notificationText`.
- Nhãn kỳ do máy chủ trả về ("90 ngày gần nhất", "Quý 4/2026", "Tháng 09/2026"…) được `periodText` nhận dạng và dịch; nhãn lạ hiện nguyên văn.
- Không dịch: chứng từ in (phiếu BH/SWK, số tiền bằng chữ) theo quy định kế toán Việt Nam; dữ liệu nghiệp vụ do người dùng nhập.
- Thêm ngôn ngữ: thêm mã vào `locales` trong `apps/web/project.inlang/settings.json`, tạo `messages/<mã>.json` đủ khóa, thêm lựa chọn vào `LOCALE_OPTIONS` (`apps/web/src/lib/i18n.ts`) và quy tắc định dạng trong `intlLocale`/`htmlLang`.
