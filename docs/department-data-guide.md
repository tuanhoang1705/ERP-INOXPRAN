# Hướng dẫn các phòng ban cung cấp dữ liệu cho ERP INOXPRAN

## 1. Cách bàn giao chung

- Mỗi phòng ban cử một người lập dữ liệu và một người duyệt dữ liệu.
- Dùng đúng mã đang vận hành; không dùng tên thay cho mã SKU, mã khách hàng hoặc mã kho.
- Một dòng biểu diễn một bản ghi. Không gộp ô, không chèn dòng tổng vào giữa dữ liệu và không dùng màu sắc thay cho trạng thái.
- Ngày dùng dạng `YYYY-MM-DD`; tiền là số VND chưa định dạng; tỷ lệ nhập dạng phần trăm, ví dụ `8` nghĩa là 8%.
- Số lượng phải kèm đơn vị tính. Nếu giao dịch dùng đơn vị khác đơn vị cơ sở, phải có hệ số quy đổi.
- Dữ liệu đã khóa cần giữ mã chứng từ gốc và hệ thống nguồn. Dữ liệu đang mở phải ghi rõ trạng thái và phần đã thực hiện.
- Mỗi file bàn giao ghi ngày chốt dữ liệu, người lập, người duyệt và tổng kiểm soát để đối soát.

File mẫu dùng chung nằm tại `outputs/erp-demo-2026-10-01/INOXPRAN_ERP_Demo_Data_and_Rules.xlsx`. Dòng màu vàng là dữ liệu cần phòng ban điền hoặc xác nhận. Dữ liệu có chữ `DEMO` chỉ dùng trình diễn.

## 2. Phòng Kho

### Dữ liệu cần cung cấp

1. Danh sách kho: mã kho, tên, địa chỉ, người phụ trách, trạng thái hoạt động.
2. Danh sách vị trí/kệ: mã kho, mã vị trí, tên, loại khu vực, có được xuất bán hay chỉ chờ kiểm tra.
3. Danh mục hàng: SKU, tên, nhóm, đơn vị cơ sở, đơn vị quy đổi, hệ số, barcode, định mức tồn.
4. Tồn tại thời điểm chốt: SKU, kho, vị trí, số lượng thực tế, số lượng đang giữ, đơn vị và lô kiểm đếm nguồn.
5. Chứng từ đang mở: phiếu nhập, xuất, chuyển kho và hàng chờ xử lý chưa hoàn tất.
6. Danh mục lý do điều chỉnh, loại hàng lỗi và quy trình xử lý chênh lệch.

### Quy tắc cần chốt

- Có quản lý vị trí bắt buộc cho mọi SKU không?
- Khi kiểm kê có khóa cả kho hay chỉ SKU/vị trí đang đếm?
- Dung sai nhập vượt đơn mua và chênh lệch kiểm kê là bao nhiêu?
- Chuyển kho có cần duyệt; thời điểm nào ghi giảm kho nguồn?
- Ai được điều chỉnh kho và mức chênh lệch nào cần hai người xác nhận?

### Tổng kiểm soát

- Tổng số SKU theo kho và tổng số lượng theo SKU/kho.
- Tổng giá trị tồn theo phương pháp công ty đang dùng.
- Danh sách SKU âm, không có đơn vị cơ sở, trùng mã hoặc không có vị trí.

## 3. Phòng Kinh doanh

### Dữ liệu cần cung cấp

1. Danh sách khách hàng: mã, tên pháp lý, mã số thuế, địa chỉ, người liên hệ và trạng thái.
2. Nhóm/hạng khách hàng và người phụ trách bán hàng.
3. Bảng giá có ngày hiệu lực; giá theo SKU và nhóm khách.
4. Chính sách chiết khấu theo hạng khách, số lượng, doanh số và chương trình.
5. Báo giá, đơn bán và phần giao còn lại tại thời điểm chốt.
6. Lý do hủy/đổi/trả hàng thường dùng.

### Quy tắc cần chốt

- Giá nhập đã gồm VAT hay chưa; cách làm tròn giá và tiền.
- Khi nào được sửa giá; giá dưới sàn hoặc chiết khấu nào phải duyệt.
- Khi nào giữ hàng và giữ trong bao lâu.
- Có cho giao một phần, đổi hàng tương đương hoặc hủy phần còn lại không?
- Đơn nào được tự duyệt; ai duyệt khi vượt giá trị, chiết khấu hoặc hạn mức.

### Tổng kiểm soát

- Số khách đang hoạt động theo hạng và số dòng bảng giá theo thời gian hiệu lực.
- Đơn đang mở: tổng trước thuế, VAT, tổng thanh toán, đã giao và còn giao.
- Danh sách mã khách trùng, bảng giá chồng ngày hoặc SKU không tồn tại.

## 4. Phòng Kế toán

### Dữ liệu cần cung cấp

1. Danh sách nhà cung cấp và thông tin pháp lý.
2. Hạn mức tín dụng, số ngày nợ và trạng thái khóa của từng khách.
3. Công nợ phải thu mở: khách hàng, chứng từ, ngày chứng từ, hạn thanh toán, nguyên tệ, số tiền, đã thu và còn lại.
4. Các khoản nhận trước/đặt cọc chưa phân bổ.
5. Đơn mua, hóa đơn mua và khoản phải trả đang mở nếu nằm trong phạm vi giai đoạn sau.
6. Mẫu báo cáo công nợ, tuổi nợ, nhập–xuất–tồn và file xuất MISA đang sử dụng.

### Quy tắc cần chốt

- Vượt hạn mức thì khóa cứng hay chuyển duyệt.
- Thu tiền phân bổ thủ công hay theo nợ cũ nhất; xử lý thu thừa thế nào.
- Các mốc tuổi nợ, cách tính ngày quá hạn và người nhận cảnh báo.
- Thuế suất theo nhóm hàng; thời điểm ghi nhận công nợ.
- Quy tắc đối soát và mã tài khoản MISA cho giai đoạn tích hợp.

### Tổng kiểm soát

- Tổng phải thu, đã thu và còn lại theo khách hàng; tổng công nợ theo nhóm tuổi nợ.
- Số chứng từ và tổng tiền phải khớp sổ hiện tại.
- Danh sách chứng từ thiếu khách, thiếu hạn thanh toán, số dư âm hoặc đã thu lớn hơn số phải thu.

## 5. Ban giám đốc và Quản trị hệ thống

- Chốt ma trận quyền theo vai trò và phạm vi kho.
- Chốt ngưỡng duyệt, người thay thế/ủy quyền và thời hạn ủy quyền.
- Chốt quy tắc đánh số, mẫu in, thời gian lưu chứng từ và yêu cầu audit.
- Cung cấp danh sách người dùng bằng email công ty; không gửi mật khẩu qua Excel.
- Xác định ba người ký UAT và kho/nhóm bán hàng tham gia pilot.

## 6. Quy trình tiếp nhận và nghiệm thu dữ liệu

1. **Tiếp nhận:** lưu bản gốc chỉ đọc và cấp mã batch.
2. **Kiểm tra cấu trúc:** đúng cột, đúng kiểu dữ liệu, không trùng khóa.
3. **Làm sạch:** phòng ban sửa tại nguồn; nhóm dự án không tự đoán dữ liệu thiếu.
4. **Nạp thử staging:** import có thể chạy lại, giữ mã nguồn và checksum.
5. **Đối soát:** khớp số dòng, tổng tiền, tổng tồn và tổng công nợ.
6. **UAT:** chủ nghiệp vụ kiểm tra mẫu và trường hợp biên.
7. **Chốt cutover:** ký biên bản, khóa file nguồn và chỉ sau đó mới nạp production.

## 7. Quyết định liên phòng ban phải ký chung

| Nội dung | Kho | Kinh doanh | Kế toán | Giám đốc |
| --- | --- | --- | --- | --- |
| Đơn vị cơ sở và quy đổi | Lập | Xác nhận đơn vị bán | Đối chiếu giá trị |  |
| Giá, VAT và làm tròn |  | Lập | Xác nhận thuế | Duyệt ngoại lệ |
| Hạn mức và số ngày nợ |  | Đề xuất | Lập/đối soát | Duyệt |
| Thời điểm giữ/xuất hàng | Lập | Xác nhận | Xác nhận ghi nhận công nợ |  |
| Hủy, trả hàng và đảo giao dịch | Xác nhận tồn | Xác nhận khách | Xác nhận tiền/thuế | Duyệt ngưỡng |
| Cutover tồn và công nợ | Lập tồn | Xác nhận đơn mở | Lập công nợ | Ký chốt |
