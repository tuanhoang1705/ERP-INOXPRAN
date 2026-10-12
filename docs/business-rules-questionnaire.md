# Phiếu chốt quy tắc nghiệp vụ INOXPRAN

Tài liệu này là đầu vào cho workshop. Chỉ cần ghi câu trả lời thực tế hoặc đính kèm biểu mẫu/Excel đang sử dụng; không cần mô tả kỹ thuật.

Tham khảo [bộ quy tắc DEMO](demo-business-rules.md) để xem một phương án giả định và [hướng dẫn bàn giao dữ liệu theo phòng ban](department-data-guide.md) để chuẩn bị file đúng cấu trúc. Các giá trị trong bản DEMO không phải chính sách đã được phê duyệt.

## 1. Tổ chức và kho

- Tên pháp nhân, mã số thuế, địa chỉ xuất chứng từ:
- Danh sách kho và mã kho mong muốn:
- Mỗi kho có cần quản lý vị trí/kệ cụ thể không? Nếu có, cung cấp quy tắc đặt mã vị trí:
- Nhân viên nào được xem hoặc thao tác kho nào?
- Điều chuyển kho có cần duyệt trước khi xuất không? Ai duyệt và theo ngưỡng nào?

## 2. Sản phẩm và đơn vị tính

- File danh mục SKU hiện tại:
- Đơn vị cơ sở của từng nhóm hàng:
- Quy đổi đơn vị có cố định hay thay đổi theo lô/chứng từ?
- Có cần theo dõi quy cách độ dày, khổ, chiều dài, mác thép như thuộc tính riêng không?
- Có cho bán hàng lẻ theo phần của đơn vị đóng gói không? Số chữ số thập phân tối đa:
- SKU nào được phép thay thế lẫn nhau?

## 3. Giá bán và chiết khấu

- Các bảng giá đang dùng, ngày hiệu lực và nhóm khách hàng áp dụng:
- Giá đã gồm VAT hay chưa gồm VAT?
- Quy tắc chiết khấu theo khách hàng/số lượng/doanh số:
- Mức chiết khấu hoặc giá dưới sàn cần duyệt:
- Người được phép sửa giá trực tiếp trên báo giá/đơn bán:
- Chính sách làm tròn tiền và số lượng:

## 4. Bán hàng và giao hàng

- Chuỗi trạng thái thực tế từ báo giá đến hoàn tất:
- Khi nào hệ thống phải giữ hàng: lúc lưu đơn, gửi duyệt hay duyệt xong?
- Có cho giao một phần không? Phần còn lại được giữ trong bao lâu?
- Điều kiện cho phép hủy đơn hoặc hủy phần còn lại:
- Các lý do trả hàng và cách xử lý hàng trả về kho:
- Mẫu báo giá, đơn bán, phiếu xuất và biên bản giao hàng hiện tại:

## 5. Mua hàng và nhập kho

- Ai được lập, duyệt và thay đổi đơn mua?
- Ngưỡng giá trị cần duyệt và số cấp duyệt:
- Có cho nhập vượt số lượng đặt không? Dung sai cho phép:
- Cách xử lý thiếu hàng, hàng lỗi và trả nhà cung cấp:
- Mẫu đơn mua, phiếu nhập và chứng từ đối chiếu hiện tại:

## 6. Kiểm kê và điều chỉnh kho

- Tần suất kiểm kê và phạm vi kiểm kê:
- Khi kiểm kê có khóa xuất/nhập SKU hoặc kho không?
- Chênh lệch nào được tự động ghi nhận; chênh lệch nào phải duyệt?
- Danh sách lý do điều chỉnh bắt buộc:
- Có yêu cầu hai người xác nhận phiếu điều chỉnh không?

## 7. Công nợ và thu tiền

- Hạn mức tín dụng và số ngày nợ theo từng nhóm/khách hàng:
- Khi vượt hạn mức: khóa cứng hay chuyển duyệt?
- Khoản thu được phân bổ tự động theo chứng từ cũ nhất hay kế toán chọn thủ công?
- Có cho thu thừa/đặt cọc không? Cách xử lý số dư:
- Các mốc tuổi nợ cần báo cáo, ví dụ 0–30, 31–60, 61–90, trên 90 ngày:
- Người nhận cảnh báo nợ đến hạn/quá hạn:

## 8. Người dùng và phê duyệt

Điền người hoặc chức danh cho từng quyền:

| Nghiệp vụ | Lập | Sửa | Duyệt | Ghi sổ | Hủy/đảo | Xem |
| --- | --- | --- | --- | --- | --- | --- |
| Đơn bán | | | | | | |
| Đơn mua | | | | | | |
| Nhập kho | | | | | | |
| Xuất kho | | | | | | |
| Chuyển kho | | | | | | |
| Kiểm kê/điều chỉnh | | | | | | |
| Thu tiền | | | | | | |

- MFA bắt buộc cho nhóm người dùng nào?
- Người vắng mặt có được ủy quyền duyệt không? Cách ghi nhận thời hạn ủy quyền:

## 9. Đánh số và in chứng từ

- Mẫu số cho SO, PO, GR, SHP, thanh toán, chuyển kho và trả hàng:
- Số có reset theo năm/tháng/kho không?
- Logo, thông tin chân trang, chữ ký và số liên cần in:
- Có dùng máy in tem/mã vạch không? Khổ tem và loại máy:

## 10. Dữ liệu và tích hợp

- File tồn đầu theo SKU/kho/vị trí:
- File công nợ mở theo khách hàng/chứng từ/hạn thanh toán:
- Đơn mua, đơn bán và giao hàng chưa hoàn tất:
- File khách hàng, nhà cung cấp, sản phẩm và bảng giá:
- Thời điểm chốt dữ liệu dự kiến:
- MISA AMIS: thông tin môi trường sandbox, `app_id`, callback và người phụ trách làm việc với MISA:
- Hóa đơn điện tử đang dùng nhà cung cấp nào?
- Email gửi thông báo sử dụng domain/hộp thư nào?

## 11. Báo cáo và nghiệm thu

- Năm báo cáo quan trọng nhất cần giống số hiện tại:
- Mẫu Excel/PDF bắt buộc giữ nguyên:
- Quy mô dữ liệu: số SKU, khách hàng, đơn/ngày và dòng chứng từ/ngày:
- Ba đại diện ký UAT của Kinh doanh, Kho và Kế toán:
- Kho/nhóm bán hàng dùng pilot đầu tiên:
- Ngày dự kiến bắt đầu pilot và ngày dự kiến go-live:

## Tệp nên chuẩn bị

1. Danh mục sản phẩm và quy đổi đơn vị.
2. Danh sách khách hàng/nhà cung cấp.
3. Danh sách kho/vị trí và người phụ trách.
4. Bảng giá, chiết khấu và hạn mức tín dụng.
5. Tồn đầu, công nợ mở và chứng từ đang xử lý.
6. Mẫu in và báo cáo đang sử dụng.
7. Danh sách người dùng, chức danh và phạm vi kho.
