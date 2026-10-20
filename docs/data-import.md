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

## 8. Nhập lịch sử công nợ theo khách (từ 16/10/2026)

Dùng để chuyển **sổ công nợ cũ** (Excel `每日订单汇总表`) vào ERP: chứng từ bán / trả hàng, khoản thu, phí vận chuyển khách trả. Khác với sheet `CONG_NO_DAU_KY` (một số dư mỗi chứng từ), lịch sử giữ từng bút toán với **ngày chứng từ thật**, để sổ chi tiết theo khách (*Công nợ → Công nợ theo khách hàng*) hiện đúng diễn biến.

**Màn hình:** cùng trang *Nhập dữ liệu ban đầu*, ô **Nhập lịch sử công nợ theo khách** (chỉ quản trị gốc).

**File** — gồm 3 sheet:

| Sheet | Nội dung | Cột bắt buộc |
| --- | --- | --- |
| `CONG_NO_LICH_SU` | Mỗi dòng một bút toán. Cột: Mã dòng, Mã KH, Ngày chứng từ, Loại, Số chứng từ, Số hóa đơn, Số tiền (số dương), Diễn giải, Ghi chú, Nguồn, Cờ kiểm tra | Mã dòng, Mã KH, Ngày chứng từ, Loại, Số tiền |
| `CONG_NO_LICH_SU_HANG` | Dòng hàng của chứng từ bán / trả (mã, tên, ĐVT, số lượng, đơn giá, thành tiền) — chỉ để xem lại | Mã dòng |
| `DOI_CHIEU_CONG_NO` | Số tổng trên sheet đối chiếu của sổ cũ theo từng khách: Tổng công nợ, Đã thanh toán, Phí vận chuyển, Còn lại | Mã KH |

**Loại** và tác động lên nợ:
- **Tăng nợ:** *Bán hàng*, *Hoàn tiền* (trả tiền lại cho khách).
- **Giảm nợ:**
  - *Thu tiền*: vào cột Đã thu;
  - *Phí vận chuyển*: khách / NPP trả cước thay công ty, cột riêng, không tính là tiền thu;
  - *Trả hàng*, *Giảm giá*, *Trừ lương*: vào cột Trả hàng / giảm.

**Ngày chốt** (mặc định 30/09/2026): chỉ nhập dòng **đến hết** ngày chốt. Từ 19/10/2026, dòng **sau** ngày chốt **không nhập**: từ ngày chốt, kế toán nhập trên ERP. Hệ thống vẫn so các dòng này với ERP để làm danh sách việc:
- số chứng từ trùng phiếu BH đã có → **Đã có trên ERP**, kèm công nợ phiếu ERP và chênh so với sổ cũ;
- khoản giảm nợ trùng khách + ngày + số tiền + loại với phiếu thu ERP → **Nghi trùng**;
- phiếu bán khớp một phiếu BH trên ERP khác số (cùng khách, cùng tiền hoặc cùng dòng hàng, ngày gần nhau) → **Nghi trùng**, ghi số phiếu gợi ý;
- còn lại → **Chưa có trên ERP — kế toán nhập**.

**Cột "Phiếu ERP (trùng)"** (sheet `CONG_NO_LICH_SU`, không bắt buộc) dùng khi một lần xuất đã có phiếu BH trên ERP nhưng sổ cũ ghi khác số. Ví dụ: sổ cũ ghi theo ngày đơn 30/09, kho xuất 01/10 nên phiếu được lập lại trên ERP. Ghi số phiếu ERP vào cột này:
- dòng sổ cũ không nhập, công nợ nằm ở phiếu ERP;
- phiếu phải có trên ERP, chưa hủy, cùng khách; sai thì báo lỗi theo dòng.

Chạy thử có bảng **"Trùng với phiếu BH trên ERP"**:
- dòng đã ghép;
- chứng từ bán trong 30 ngày trước ngày chốt mà nghi đã được lập lại trên ERP. Chỉ là cảnh báo: dòng này vẫn nhập, kế toán kiểm chứng từ xuất kho rồi ghép.

**Các bước**

1. **Trước khi ghi:** tích **Không tự khóa** cho các NPP trả gối đầu (*Công nợ theo khách hàng* → mở khách). Chạy thử liệt kê khách **sẽ bị khóa** (còn nợ quá hạn > 60 ngày); không tích thì lần rà soát 06:00 hôm sau sẽ khóa đặt hàng của họ.
2. Chọn file, kiểm tra ngày chốt, bấm **Kiểm tra (chạy thử)**. Xem các phần:
   - bảng theo khách: số bút toán, phát sinh, đã thu, phí vận chuyển, trả hàng / giảm, còn lại, so với *Còn lại (sổ cũ)*;
   - danh sách sau ngày chốt;
   - các dòng gắn cờ: ngày bị đảo ngày / tháng, thiếu ngày, ngày tương lai…
3. Bấm **Ghi vào hệ thống**:
   - chứng từ tăng nợ thành khoản phải thu (`AR…`): ngày phát sinh = ngày chứng từ, hạn = ngày chứng từ + số ngày nợ của khách;
   - khoản giảm nợ thành phiếu (`PAY…`), tự phân bổ vào chứng từ **hạn cũ nhất trước**;
   - phần dư thành **khoản trả trước** của khách.
4. Bấm **Đối chiếu** trên lô: so số trong file với số đã ghi và với số tổng sổ cũ theo từng khách, rồi **Xác nhận đã đối chiếu**.

**Chặn và hoàn tác**
- Không ghi được: file đã ghi ở lô khác, hoặc mã dòng đã nhập ở lô trước (hoàn tác lô cũ trước).
- **Hoàn tác:** xóa toàn bộ khoản phải thu và phiếu của lô.
  - Phiếu thu theo khách ngoài lô được phân bổ lại sang chứng từ khác của khách.
  - Bị chặn khi phiếu thu theo từng chứng từ / bù trừ trả trước trỏ vào chứng từ của lô, hoặc không còn chứng từ để giữ tiền đã thu.

### Thay lô bằng file mới (từ 17/10/2026)

Dùng khi lô đã ghi và kế toán đã thu tiền vào chứng từ của lô, nên hoàn tác rồi ghi lại không tiện. Ví dụ: thay bản trích PDF (làm tròn đồng) bằng bản đọc thẳng từ Excel gốc (giữ số lẻ).

1. Dòng lô "Lịch sử công nợ" → **Thay bằng file mới** → chọn file. Hệ thống chạy thử với **cùng ngày chốt** của lô; file đang dùng hoặc đã ghi ở lô khác bị chặn.
2. Hộp thoại hiện:
   - bảng còn lại từng khách *Hiện tại → File mới* và mức chênh;
   - **Giữ số đã thu theo chứng từ:** chứng từ kế toán đã thu đủ theo số cũ, số mới nhỏ hơn dưới 1 đ → giữ số đã thu làm số chứng từ (ghi số theo file). Lệch từ 1 đ, hoặc file mới không còn chứng từ đó → báo lỗi, chỉ rõ phiếu thu;
   - bảng "Trùng với phiếu BH trên ERP" (đã ghép / nghi trùng);
   - dòng sau ngày chốt (không nhập), có trạng thái đã có / nghi trùng / chưa có trên ERP, kèm công nợ phiếu ERP và chênh so với sổ cũ. Lô ghi theo quy tắc cũ có bút toán sau chốt "nhập kèm" thì khi thay lô, phần đó được gỡ ra.
3. **Thay lô** (một giao dịch):
   - chứng từ / phiếu cùng mã dòng giữ nguyên mã `AR…` / `PAY…`, nên phiếu thu ngoài lô vẫn trỏ đúng;
   - phân bổ lại từng khách (nhóm công nợ tách riêng, nợ thường trước);
   - lô giữ mã, đổi file / SHA-256 / số tổng, ghi lịch sử thay; xác nhận đối chiếu cũ bị xóa;
   - nhật ký `IMPORT_REPLACED`.
4. Hộp **Đối chiếu** tự mở → **Xác nhận đã đối chiếu** lại.
- Hàng trong lịch sử **không** tính vào doanh thu, tồn kho hay danh sách phiếu BH: chỉ là công nợ.

### Nhóm công nợ tách riêng (từ 17/10/2026)

Kế toán tách riêng "công nợ quạt" (hoặc quạt + vợt muỗi, hàng mẫu…) như trên sheet đối chiếu: phần này không tính quá hạn / tự khóa, tiền thu trừ nợ thường trước (quy tắc CN-SEG-01).

- **Lô ghi từ 17/10/2026:** dòng hàng của phiếu trả hàng được lưu. Khi ghi, hệ thống tự tách phần nhóm theo cấu hình đang dùng và phân bổ nợ thường trước.
- **Lô ghi trước ngày đó** (lô bản PDF trên production): làm một lần.
  1. *Nhập dữ liệu ban đầu* → dòng lô "Lịch sử công nợ" → **Bổ sung dòng hàng phiếu trả** → chọn đúng file đã ghi (cùng SHA-256, file khác bị chặn). Nếu thay lô bằng file mới (mục trên) thì bỏ qua bước này: file mới đã lưu dòng hàng phiếu trả.
  2. *Công nợ → Nhóm công nợ tách riêng*:
     - tạo nhóm;
     - chọn **Áp dụng cho**: *Chỉ khách được chọn* (mặc định) + danh sách khách được nợ riêng, hoặc *Mọi khách*;
     - ghép các mã hàng cũ chưa có trong danh mục (gợi ý sẵn: NP1002 → INP1002, INP1301A → INP1301-A…). Mã cũ không ghép được (VD INP6401 không rõ màu) thì ghi vào *Mã hàng thêm*;
     - **Xem trước** → **Áp dụng**.
- **Hoàn tác:**
  - Hoàn tác lần áp dụng: được khi các chứng từ đã đổi chưa bị thu tiền / sửa tiếp.
  - Hoàn tác lô lịch sử: phiếu thu theo khách ngoài lô được phân bổ lại. Chỉ bị chặn khi phiếu thu theo từng chứng từ / bù trừ trỏ vào chứng từ của lô, hoặc khi không còn chứng từ để giữ tiền đã thu.
