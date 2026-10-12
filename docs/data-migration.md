# Quy trình nhập dữ liệu lịch sử

## Phân lớp

- `OPENING`: tồn đầu, công nợ đầu, đơn đang mở — nhập thành dữ liệu vận hành native.
- `HISTORY`: chứng từ đã khóa — nhập vùng chỉ đọc phục vụ tra cứu/báo cáo.
- `REJECTED`: dòng lỗi hoặc chưa map — không tự bỏ qua, phải có lý do và owner xử lý.

## Pipeline bắt buộc

1. Nhận file bất biến, tính SHA-256, ghi nguồn/người giao/thời điểm.
2. Staging raw giữ nguyên giá trị gốc và số dòng.
3. Chuẩn hóa mã SKU, đối tác, đơn vị, ngày, tiền; map bằng bảng version hóa.
4. Phát hiện trùng theo `sourceSystem + documentType + sourceDocumentId` và fingerprint.
5. Validate khóa ngoại, tổng dòng, total chứng từ, dấu tiền và trạng thái.
6. Dry-run sinh báo cáo sai lệch; không ghi production nếu vượt tolerance đã duyệt.
7. Commit theo `importBatchId` idempotent; retry không nhân đôi dữ liệu.
8. Đối soát bốn lớp: record count, tổng tiền, tồn theo SKU/kho, công nợ theo khách.
9. Kế toán và Kho ký biên bản; khóa batch, lưu report và checksum.

Không sửa trực tiếp batch đã khóa. Sửa mapping rồi tạo batch điều chỉnh hoặc rollback có kiểm soát.
