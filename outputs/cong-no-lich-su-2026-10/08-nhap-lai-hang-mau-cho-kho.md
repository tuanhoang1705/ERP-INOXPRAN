# Nhập lại hàng mẫu NVKD mượn — hướng dẫn cho kho

**Dùng khi:** nhân viên kinh doanh mượn hàng mẫu của kho đi chào hàng, nay mang trả lại kho.

**Không dùng "Khách trả hàng"** cho trường hợp này. Khách trả hàng là hàng đã bán, có công nợ và có bước kế toán. Hàng mẫu thì không.

## Ở đâu

*Kho & Giao hàng → Phiếu trả hàng* → nút **Nhập lại hàng mẫu** (góc trên bên phải, cạnh "Trả nhà máy").

Quản lý kho, thủ kho và Admin thấy nút này. Nhân viên kinh doanh và kế toán không tự ghi nhập kho được.

## Trường hợp 1: hàng mượn có phiếu "Xuất hàng mẫu" trên ERP

Thẻ **Theo phiếu xuất hàng mẫu**:
1. Danh sách phiếu đang mượn hiện người mượn, nơi gửi, số ngày đã mượn, hẹn trả. Chọn đúng phiếu.
2. Mỗi mã hàng hiện số còn ở ngoài. Nhập số mang về; trả một phần cũng được, không nhập quá số còn ở ngoài.
3. Bấm **Nhập lại hàng mẫu**.

Phần không mang về được (hỏng, tiêu hao khi kiểm định, tặng, thất lạc): mở phiếu → **Chốt phần chưa trả** → chọn **Không thu hồi được**. Nếu đại lý giữ lại mua: chọn **Đại lý giữ mua luôn** để lập phiếu bán.

## Trường hợp 2: hàng mượn trước khi dùng ERP (không có phiếu)

Thẻ **Không có phiếu (mượn trước khi dùng ERP)**:
1. **Người mượn:** chọn nhân viên kinh doanh đã mượn.
2. **Nhập vào kho:** kho nhận hàng (thường là Kho Sơn Đồng).
3. **Dòng hàng:** mã hàng và số lượng mang về; bấm *Thêm dòng* nếu nhiều mã.
4. **Ghi chú** (bắt buộc): mượn khi nào, đi đâu. Ví dụ: "Mượn tháng 8 đi chào hàng Hải Phòng, chưa lập phiếu".
5. Bấm **Nhập lại hàng mẫu**.

## Kết quả

- Tồn kho tăng đúng số nhập lại.
- Thẻ kho ghi loại **"Hàng mẫu nhập lại"**.
- Có phiếu **TH…** loại hàng mẫu, ghi tên người mượn. Lọc *Loại phiếu → Hàng mẫu / kiểm định nhập lại* trên trang Phiếu trả hàng để xem lại.
- Không tạo việc cho kế toán, không ảnh hưởng công nợ.
