# Nhập lịch sử công nợ lên production — các bước

File nhập: `04-cong-no-lich-su.xlsx` (cùng thư mục). Đã diễn tập trên CSDL trống ở máy: ghi, đối chiếu, thu tiền theo khách, hoàn tác đều đúng. Chi tiết số liệu ở `bao-cao-doi-chieu.md`.

**Người làm:** quản trị gốc. Kế toán ngồi cùng ở bước 4–5.

## 0. Trước khi nhập

1. Production đã chạy bản có chức năng công nợ theo khách (lệnh deploy ở cuối file).
2. **Khách *Nguyễn Anh Tuấn* (880.000 đ) không có trong file.** Sổ cũ không ghi mã khách cho người này, danh sách khách ERP cũng không có ai tên này, nên không biết gắn nợ vào khách nào.
   - Đây là phiếu tháng 10: **BH2026100127** ngày 09/10/2026, bếp hồng ngoại INP6153 600.000 đ + chảo INP2106 280.000 đ. Phiếu này nằm sau ngày chốt.
   - Kế toán tìm số BH2026100127 trong *Danh sách phiếu BH*.
     - Có rồi: không cần làm gì. Công nợ đã có từ chính phiếu đó; có trong file thì hệ thống cũng tự bỏ qua.
     - Chưa có: lập phiếu BH như bình thường (tạo khách lẻ ngay trên form).
3. **Số ngày nợ của khách.** Hạn trả của chứng từ cũ = ngày chứng từ + *Số ngày nợ* trên hồ sơ khách, tính **lúc ghi**.
   - Các khách nhập từ `03-khach-hang.xlsx` đang là **0 ngày**, nên hạn trả = ngày chứng từ.
   - Muốn NPP 45 ngày / đại lý 30 ngày thì sửa hồ sơ khách **trước** khi ghi.
4. **Tích "Không tự khóa"** cho khách trả gối đầu: *Công nợ → Công nợ theo khách hàng* → mở khách → tích ô *Không tự khóa* (chỉ tài khoản Admin thấy ô này).
   - Không tích thì lần rà soát 06:00 sáng hôm sau sẽ khóa đặt hàng của các khách này.
   - Lúc diễn tập (số ngày nợ 0), 15 khách sẽ bị khóa:

| Mã KH | Khách |
| --- | --- |
| KH001 | CÔNG TY TNHH THƯƠNG MẠI CẢNH CƯỜNG |
| KH002 | CÔNG TY TNHH LỘC HƯNG THÁI |
| KH005 | CÔNG TY TNHH THƯƠNG MẠI VÀ DỊCH VỤ ĐẠI PHÁT |
| KH011 | Hợp Tác Xã Tân Sơn Quảng Ninh |
| KH012 | CÔNG TY TNHH TM GIANG CHÂU |
| KH024 | CÔNG TY TNHH ĐỒ GIA DỤNG MINH TRÍ |
| KH034 | CÔNG TY TNHH THƯƠNG MẠI 319 ĐÔNG ANH |
| KH042 | CÔNG TY TNHH THƯƠNG MẠI TỔNG HỢP BẰNG ÁNH |
| KH058 | CÔNG TY TNHH PHÁT TRIỂN SẢN XUẤT THƯƠNG MẠI DỊCH VỤ RỒNG VIỆT |
| KH066 | CÔNG TY TNHH THƯƠNG MẠI GIANG MINH NGỌC |
| KH068 | CÔNG TY TNHH NHÂN VƯỢNG |
| KH071 | CÔNG TY TNHH GIA BẢO HP |
| KH074 | CÔNG TY TNHH THƯƠNG MẠI VÀ DỊCH VỤ THẢO NGUYÊN HD |
| KH076 | CÔNG TY TNHH THƯƠNG MẠI VÀ DỊCH VỤ ĐỨC ĐÀN |
| KH086 | Vương Tuyết Mai |

Danh sách đúng là danh sách bước 2 của chạy thử báo, vì còn tùy số ngày nợ và phiếu thu tháng 10 đã có trên production.

## 1. Chạy thử

*Quản trị → Nhập dữ liệu ban đầu → Nhập lịch sử công nợ theo khách.* Chọn file, ngày chốt **30/09/2026**, bấm **Kiểm tra (chạy thử)**.

Cần thấy:
- **0 lỗi.**
  - Nếu báo khách không tồn tại: kiểm tra đã nhập `03-khach-hang.xlsx` chưa.
- **Cảnh báo "sẽ bị khóa"** chỉ còn khách mà kế toán đồng ý để khóa.

## 2. Kế toán xem danh sách sau ngày chốt

Có 49 bút toán từ 01/10/2026 trở đi. Mỗi dòng có trạng thái:
- **Đã có trên ERP — bỏ qua:** phiếu BH tháng 10 đã lập trên ERP.
- **Nghi trùng — bỏ qua:** đã có phiếu thu ERP cùng khách, ngày, số tiền.
- **Nhập kèm:** phiếu / khoản thu tháng 10 chưa có trên ERP. Kế toán xác nhận đúng là chưa nhập tay.

Nếu kế toán đã ghi khoản thu tháng 10 trên ERP với **ngày khác** ngày trong sổ cũ, hệ thống không nhận ra là trùng. Khi đó báo mình để bỏ dòng đó khỏi file.

## 3. Các dòng gắn cờ

Có 46 dòng (sheet `CAN_KIEM_TRA` trong file):
- **DAO_NGAY** (27): ngày trong sổ bị đảo ngày / tháng, đã sửa theo thứ tự số hóa đơn.
- **THIEU_NGAY** (17): ô ngày trống, tạm lấy ngày của dòng trước.
- **NGAY_TUONG_LAI** (1): LS00342, KH058, 100.000.000, sổ ghi 14/11/2026. Đã lấy **11/04/2026** theo sheet đối chiếu của khách.
- **GIAM_GIA** (1): khoản giảm giá.

Kế toán sửa được trong file trước khi ghi, hoặc ghi rồi kiểm lại trên sổ chi tiết của khách.

## 4. Ghi và đối chiếu

1. Bấm **Ghi vào hệ thống**.
2. Bấm **Đối chiếu** trên lô vừa ghi.
   - Cột *So với sổ cũ* lệch 1–5 đ ở KH001, KH034, KH042, KH068, KH074, KH086, KH088. Lý do: PDF chỉ hiện số đã làm tròn.
   - Có file Excel gốc `每日订单汇总表_(2).xlsx` thì gửi mình để lấy số lẻ chính xác.
3. Bảy khách lệch lớn: KH011, KH012, KH015, KH024, KH058, KH066, KH084.
   - Sheet đối chiếu của các khách này lập ở thời điểm khác, hoặc tính riêng hàng mẫu / quạt (`bao-cao-doi-chieu.md`, sheet `CAN_KIEM_TRA`).
   - Kế toán xác nhận số nào đúng.
4. Mở thử *Công nợ theo khách hàng* → KH034 (319 Đông Anh) → sổ chi tiết. Tổng công nợ / Đã thanh toán / Phí vận chuyển phải khớp sheet đối chiếu Excel.
5. Bấm **Xác nhận đã đối chiếu**.

## 5. Nếu sai

Bấm **Hoàn tác** trên lô. Sửa file, rồi chạy lại từ bước 1.

Hoàn tác bị chặn khi kế toán đã thu tiền theo khách vào chứng từ của lô. Khi đó báo mình.

## Lệnh deploy production (bạn chạy)

```powershell
.\infra\deploy.ps1 -Profile inoxpran-admin -Environment production -ConfirmProduction -Tag 20261017-084644
```
