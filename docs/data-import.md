# Hướng dẫn nhập dữ liệu ban đầu (Excel)

Dùng khi đưa INOXPRAN ERP vào chạy thật: chuyển danh mục, khách hàng, nhà cung cấp, tồn kho và công nợ từ sổ sách cũ (Excel / MISA) sang hệ thống.

**Ai làm:**
- Giám đốc hoặc quản trị hệ thống: nhập dữ liệu và hoàn tác lô.
- Kế toán: xem bảng đối chiếu và xác nhận.

**Màn hình:** *Tổng quan › Quản trị › Nhập dữ liệu ban đầu (Excel)* (`/admin/import`).

## 1. Chuẩn bị

1. Chốt ngày đưa vào dùng, ví dụ hết ngày 31/10/2026:
   - kiểm kê tồn kho thực tế;
   - khóa sổ công nợ trên phần mềm cũ.
2. Trong ERP, khai báo trước những thứ file không tạo được:
   - **Kho và vị trí lưu** (*Kho & vị trí lưu*), nếu sheet tồn đầu kỳ có ghi vị trí;
   - **Tài khoản người dùng** (*Người dùng & phân quyền*). Kế toán, NVKD, thủ kho chỉ thao tác được trên kho được gán: tạo kho trước, rồi gán kho cho tài khoản (Quản trị và Giám đốc thấy mọi kho).
3. Bấm **Tải file mẫu**. File có sheet `HUONG_DAN` và 9 sheet dữ liệu.

## 2. Điền file mẫu

**Quy tắc chung:**
- Điền từ dòng 2, giữ nguyên dòng tiêu đề. Cột có `*` là bắt buộc.
- Có thể đổi thứ tự cột, bỏ cột không bắt buộc, hoặc để trống cả sheet không dùng.
- **Mã** (mã SP, mã KH…) chỉ gồm chữ hoa, số và `. _ / -`.
  - Mã đã có trong hệ thống sẽ được **cập nhật** theo các ô có nhập; ô trống giữ nguyên giá trị cũ.
  - Mã chưa có sẽ được **thêm mới**.
- **Số tiền:**
  - viết `1500000`, `1.500.000` hoặc `1,500,000` đều được;
  - số lẻ dùng dấu chấm hoặc dấu phẩy (`25,5`).
- **Ngày:** `dd/mm/yyyy` hoặc ô định dạng ngày của Excel.

| Sheet | Nội dung | Ghi chú |
| --- | --- | --- |
| `NHOM_HANG` | Nhóm sản phẩm | Dùng ở cột "Mã nhóm" của sheet sản phẩm |
| `KHU_VUC` | Khu vực bán hàng | Dùng cho khách hàng, NVKD |
| `NVKD` | Nhân viên kinh doanh | Vai trò: NVKD / Trưởng KD |
| `NHA_CUNG_CAP` | Công ty mẹ, nhà máy, NCC trong nước | Kèm 1 người liên hệ |
| `SAN_PHAM` | Mã hàng | Giá bán lẻ (giá khách lẻ); tên Trung / Anh, mã HS, quy cách và kích thước thùng (tính CBM), giá mua theo CNY / USD; "Tình trạng hàng" (Còn hàng / Đang về / Chưa có hàng) và "Mã hàng clear" (Có / Không) như trên bảng báo giá |
| `BANG_GIA` | Giá theo cấp khách | Mỗi mã một dòng: "Giá Net NPP" (khách cấp NPP), "Giá đại lý" (khách cấp Đại lý); ô trống = cấp đó dùng giá bán lẻ. Nhập lại để đổi giá: bảng giá của cấp tăng phiên bản, phiếu đã lập giữ giá cũ; hoàn tác lô sẽ trả về giá trước đó |
| `KHACH_HANG` | Đại lý / NPP / khách lẻ | Loại: Chính thức (bắt buộc cấp giá) hoặc Cơ hội; kèm 1 người liên hệ và 1 địa chỉ nhận hàng |
| `TON_DAU_KY` | Tồn tại ngày chốt | Một dòng cho mỗi cặp mã + kho, số lượng theo đơn vị cơ bản; cột "Giá vốn" chỉ đặt cho mã chưa có giá vốn; cột "Số lượng nhập ban đầu" (初始入库, tùy chọn) để báo cáo tồn kho tháng tính % tồn còn lại |
| `CONG_NO_DAU_KY` | Chứng từ còn nợ tại ngày chốt | Mỗi chứng từ một dòng: số chứng từ gốc, ngày, hạn thanh toán, số tiền còn phải thu |

## 3. Kiểm tra (chạy thử)

1. Chọn file và bấm **Kiểm tra (chạy thử)**. Hệ thống:
   - quét mã độc file;
   - đọc từng sheet, kiểm tra từng ô;
   - kiểm tra chéo giữa các sheet và với dữ liệu đang có, ví dụ: nhóm hàng có tồn tại không, khách có tồn tại không, mã có bị trùng không, cặp mã + kho đã có tồn đầu kỳ chưa, chứng từ đã nhập chưa.
2. Kết quả gồm:
   - bảng theo sheet: số dòng, thêm mới, cập nhật, lỗi;
   - tổng tồn (số lượng, giá trị) và tổng công nợ theo khách;
   - danh sách lỗi theo **sheet / dòng / cột**. Mỗi ô chỉ báo lỗi đầu tiên.
3. Sửa file và kiểm tra lại đến khi báo **Hợp lệ, có thể ghi**.

## 4. Ghi vào hệ thống

Bấm **Ghi vào hệ thống**.

**Một giao dịch:** toàn bộ file được ghi trong một giao dịch. Chỉ cần một dòng lỗi là không ghi gì cả.

**Một lô (`IMPxxxx-nnn`):** mỗi lần ghi tạo một lô, gồm:
- danh mục, khách hàng, nhà cung cấp, sản phẩm được thêm mới hoặc cập nhật;
- tồn đầu kỳ ghi vào thẻ kho loại `OPENING`;
- công nợ đầu kỳ ghi vào sổ phải thu, hiện ở *Công nợ* với dòng "Công nợ đầu kỳ · số chứng từ".

**Không ghi trùng:** cùng một file (theo mã SHA-256) không ghi được lần hai. Muốn sửa thì hoàn tác lô cũ rồi ghi lại.

## 5. Đối chiếu và xác nhận

Sau khi ghi, bảng **Đối chiếu** mở ra, gồm:
- số hồ sơ thêm mới theo file so với trong hệ thống;
- tồn đầu kỳ theo kho: số lượng nhập, số lượng hiện tại, giá trị;
- công nợ: tổng theo file, đã nhập, còn phải thu, chi tiết theo khách.

Quản trị gốc so với sổ sách cũ (cùng kế toán / Giám đốc nếu cần) rồi bấm **Xác nhận đã đối chiếu**; hệ thống ghi tên và thời điểm. Từ 09/10/2026 trang *Nhập dữ liệu ban đầu* chỉ tài khoản quản trị gốc (root) xem được.

## 6. Hoàn tác lô

Bấm **Hoàn tác** khi dữ liệu nhập chưa được dùng. Hệ thống sẽ:
- xóa hồ sơ thêm mới;
- trả hồ sơ cập nhật về giá trị cũ;
- trừ tồn đầu kỳ bằng thẻ kho `REVERSAL`;
- xóa công nợ đầu kỳ.

Hệ thống **chặn hoàn tác** và nêu lý do khi:
- mã, khách hoặc NCC mới đã có phiếu bán, đơn mua, phiếu bảo hành hoặc thẻ kho khác;
- công nợ đầu kỳ đã thu tiền;
- hồ sơ cập nhật đã bị sửa tiếp sau khi nhập.

Khi bị chặn, sửa trực tiếp trên hồ sơ, hoặc nhập một file bổ sung.

**Thứ tự hoàn tác ngược với thứ tự nhập.** Ví dụ lô 1 tạo mã hàng, lô 2 ghi tồn đầu kỳ cho các mã đó: hoàn tác lô 2 trước, rồi mới hoàn tác được lô 1 (thẻ kho của lô đã hoàn tác không còn tính là "đã dùng" — sửa ngày 09/10/2026). Chỉ cần thêm / đổi giá hoặc thông tin mã hàng thì không phải hoàn tác: nhập một file bổ sung (khác file cũ) chỉ chứa các sheet cần cập nhật.

## 7. Đưa vào dùng

1. Chạy thử với file thật trên **staging**, đối chiếu xong thì hoàn tác.
2. Ngày chốt:
   - nhập lên **production**;
   - đối chiếu;
   - quản trị gốc xác nhận đã đối chiếu;
   - tạo tài khoản người dùng.
   - liên kết tài khoản của từng NVKD với hồ sơ NVKD (*Danh mục › Khu vực & nhân viên KD › Sửa › Tài khoản đăng nhập*) để khách do NVKD tạo tự gán người phụ trách.
3. Thí điểm 2 tuần theo [production-readiness.md](production-readiness.md).
