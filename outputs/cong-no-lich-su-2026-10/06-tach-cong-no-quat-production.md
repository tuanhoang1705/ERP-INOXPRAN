# Production: lịch sử công nợ đến 30/09, sửa nợ trùng KH001, tách nợ quạt cho 8 khách — các bước

**Phiên bản:** 19/10/2026, thay bản 17/10.
- Lịch sử chỉ nhập **đến hết 30/09**. Từ 01/10, kế toán nhập trên ERP.
- Dùng file **04c** (không dùng 04b).

**Người làm:** quản trị gốc. Kế toán ngồi cùng từ bước 1.

**Trước khi bắt đầu:** production chạy bản mới (lệnh deploy ở cuối file).

**Sau khi làm xong:**
- Lô lịch sử = sổ Excel đến 30/09, khớp tới từng đồng (báo cáo `07-doi-soat-cong-no-chinh-xac.md`). Các bút toán tháng 10 trước đây "nhập kèm" được gỡ ra; kế toán nhập trên ERP theo danh sách ở bước 5.
- KH001 hết bị tính trùng 66.150.000 đ:
  - sổ cũ BH2026090104 ngày 30/09 và phiếu ERP BH2026100104 ngày 01/10 là **cùng một lần xuất** (sổ xuất kho: phiếu SWK2026090104, xuất kho 01/10);
  - công nợ giữ ở phiếu ERP; tồn kho không đổi.
- Chỉ 8 khách được nợ riêng quạt / vợt muỗi có ô **"Công nợ Quạt & vợt muỗi"**.

Mọi bước đã diễn tập trên bản sao giống production: lô PDF có bút toán tháng 10 nhập kèm, phiếu thu tháng 10, phiếu ERP BH2026100104.

## 1. Thay lô lịch sử bằng file 04c

*Quản trị → Nhập dữ liệu ban đầu (Excel) → bảng "Các lô đã nhập"*. Ở dòng lô **Lịch sử công nợ · chốt 2026-09-30**:

1. Bấm **Thay bằng file mới** → chọn `04c-cong-no-lich-su-den-30-09.xlsx` (cùng thư mục).
2. Hộp thoại chạy thử hiện các phần sau:

   | Phần | Cần thấy |
   | --- | --- |
   | Bảng **Hiện tại → File mới** theo khách | Khách có bút toán tháng 10 trước đây "nhập kèm" sẽ đổi nhiều: phần tháng 10 được gỡ ra. **KH001 giảm khoảng 66,15 tr** (chứng từ trùng). Các khách khác chỉ khác phần lẻ, dưới 10 đ. |
   | **Trùng với phiếu BH trên ERP** | **Chỉ có 1 dòng:** KH001, LS00026 (BH2026090104) ↔ BH2026100104, trạng thái **"Đã ghép — không nhập"**. Có thêm dòng **"Nghi trùng — cần kiểm"** nào khác thì **dừng lại**, kiểm chứng từ xuất kho rồi báo mình. |
   | **Giữ số đã thu theo chứng từ** (có thể không có) | Chứng từ kế toán đã thu đủ theo số tròn cũ, số mới nhỏ hơn dưới 1 đ. Bình thường. |
   | **Sau ngày chốt — không nhập, đối chiếu với ERP** | 49 dòng tháng 10, mỗi dòng có trạng thái **Đã có trên ERP** / **Nghi trùng** / **Chưa có trên ERP — kế toán nhập**. Đây là danh sách việc của bước 5. |
   | Chữ đỏ "File còn lỗi" | Không được có. Nếu báo phiếu thu theo chứng từ trỏ vào chứng từ bị gỡ: báo mình. |

3. Bấm **Thay lô** → xác nhận.
4. Hộp **Đối chiếu** tự mở:
   - dòng trên cùng **Khớp**;
   - cột *Còn lại* từng khách bằng cột "Excel đến 30/09" ở mục 1 của báo cáo 07;
   - riêng KH001 thấp hơn đúng 66.149.999,95, vì khoản đó nằm ở phiếu ERP BH2026100104.
5. Bấm **Xác nhận đã đối chiếu**. Thay lô xóa các xác nhận cũ, nên cần xác nhận lại.

Phiếu thu kế toán đã ghi trên ERP giữ nguyên. Phiếu thu theo khách tự phân bổ lại.

## 2. Tạo nhóm "Quạt & vợt muỗi" cho 8 khách

*Công nợ → Nhóm công nợ tách riêng → Thêm nhóm*:

| Ô | Điền |
| --- | --- |
| Mã nhóm | `QUAT-VOT` |
| Tên nhóm | Quạt & vợt muỗi |
| Nhóm hàng | tích **QUAT — Quạt điện & quạt tích điện** |
| Mã hàng thêm | `INP7901, INP7902, INP6401` |
| Áp dụng cho | **Chỉ khách được chọn** (mặc định) |
| Thêm khách… | KH001, KH002, KH034, KH042, KH058, KH068, KH071, KH074 |

Bấm **Lưu**. Bảng nhóm phải hiện cột *Áp dụng cho* là **8 khách**.

**Mã cũ INP6401:** 11 dòng xuất trước đây ghi chung, không rõ xanh (A) hay đen (B).
- Ở mục *Mã hàng cũ trong sổ công nợ*, **để nguyên "Chưa ghép"**.
- `INP6401` đã có trong *Mã hàng thêm*, nên vẫn tính là quạt.
- Các mã cũ khác đã ghép: giữ nguyên.

(Nếu nhóm đã tạo từ trước thì chỉ cần kiểm lại các ô trên.)

## 3. Xem trước → Áp dụng

Bấm **Xem trước**:
- Cột *Thay đổi* không có dòng **Lỗi dữ liệu**.
- Chỉ 8 khách trên có nợ nhóm.

Số nợ quạt mong đợi, tính đến 30/09 (màn hình làm tròn đến đồng):

| Khách | Hệ thống | Sheet kế toán | Ghi chú |
| --- | ---: | ---: | --- |
| KH001 Cảnh Cường | 187.100.000 | 187.100.000 | khớp |
| KH002 Lộc Hưng Thái | 110.000.000 | 110.000.000 | khớp |
| KH034 319 Đông Anh | 63.600.000 | 63.600.000 | khớp |
| KH042 Bằng Ánh | 42.520.000 | 42.520.000 | khớp |
| KH058 Rồng Việt | 136.200.000 | 136.200.000 | khớp. Khoản 620.000 lệch trước đây là đơn quạt tháng 10, sẽ nằm ở phiếu ERP |
| KH071 Gia Bảo | 99.799.999 | 99.799.999 | khớp |
| KH074 Thảo Nguyên HD | 18.000.000 | 18.000.000 | khớp |
| KH068 Nhân Vượng (NPP Thế Tài) | 124.749.999 | 144.149.999 | Sheet quên trừ 3 dòng trả hàng 10/09 (19,4 tr). Hệ thống đúng; Excel đã sửa sẵn: `每日订单汇总表_-da-sua-KH068.xlsx` |

Phiếu BH tháng 10 có quạt / vợt trên ERP tự cộng thêm phần nhóm của phiếu đó.

Bấm **Áp dụng** → xác nhận.

## 4. Kiểm tra

- *Công nợ theo khách hàng*: cột **Nợ nhóm tách riêng** có số ở đúng 8 khách.
- *Tuổi nợ & cảnh báo quá hạn*: cột **Nợ nhóm tách riêng** có số.
- Mở sổ **KH001**: không còn chứng từ lịch sử AR2610-00054 (BH2026090104); phiếu BH2026100104 vẫn còn.
- Mở sổ **KH068**:
  - ô *Công nợ Quạt & vợt muỗi* là 124.749.999;
  - *Còn lại trừ nhóm tách riêng* + *Công nợ Quạt & vợt muỗi* = *Còn lại*.
- Mở sổ **KH066**: không có ô nhóm; ô tích *Cho nợ riêng Quạt & vợt muỗi* bỏ trống.

Nếu sai ở bước tách nhóm: bấm **Hoàn tác** ở mục *Các lần áp dụng*.

## 5. Kế toán nhập phần tháng 10 trên ERP

Dùng file `09-giao-dich-thang-10-can-co-tren-erp.xlsx`: 49 bút toán tháng 10 của sổ Excel (24 bán, 19 thu, 4 trả, 2 phí vận chuyển; 23 khách).

- Trạng thái thật trên production xem ở bảng **"Sau ngày chốt"** (hộp Đối chiếu của lô, hoặc chạy thử Thay bằng file mới).
- **Đã có trên ERP:** đánh dấu số phiếu vào file, không làm gì thêm.
- **Nghi trùng:** mở phiếu ERP được gợi ý để xác nhận. Nếu đúng là nó thì đánh dấu, **không lập thêm**.
- **Chưa có trên ERP:** lập trên ERP đúng ngày chứng từ (phiếu BH / thu tiền / khách trả hàng / ghi phí vận chuyển khách trả).
- Phiếu BH sếp lập từ đầu tháng 10 có thể mang số khác sổ Excel. So theo khách + ngày + số tiền + dòng hàng trước khi lập mới.

Nhập đủ xong, còn nợ mỗi khách bằng cột "Còn lại theo Excel (đến 16/10)" của báo cáo 07, cộng phát sinh trên ERP sau 16/10. Ví dụ KH001: **772.291.993**.

## 6. Thêm hoặc bớt khách được nợ riêng sau này

Khách mới mặc định **không** tách:
- **Nhanh:** Admin mở sổ công nợ khách → tích **Cho nợ riêng Quạt & vợt muỗi**. Hệ thống tách lại ngay.
- Hoặc sửa nhóm → *Thêm khách…* → Lưu → Xem trước → Áp dụng.

## 7. Nhóm hàng mẫu riêng cho một khách (VD KH015 Marserri)

Mỗi khách một nhóm, ví dụ `MAU-KH015`:
1. *Nhóm công nợ tách riêng* → **Thêm nhóm**:
   - mã `MAU-KH015`;
   - tên "Hàng mẫu Marserri";
   - tích **Chỉ gắn tay theo chứng từ**.
2. Mở sổ công nợ **KH015** → ở 3 chứng từ xuất mẫu bấm **Gắn nhóm** → chọn nhóm vừa tạo, ghi lý do:
   - 08/06/2026, BH00209: 620.000;
   - 08/06/2026: 3.739.999,96;
   - 15/06/2026: 7.831.000.
3. Kiểm tra:
   - Trang Nhóm, cột **Hàng khách đang nợ**: "KH015 · 24 mã · 24 cái · 12.191.000". Bấm **Xem mã hàng** để xem từng mã INP3001 … INP6602.
   - Sổ KH015, ô "Công nợ Hàng mẫu Marserri" = 12.191.000; "Còn lại trừ nhóm tách riêng" = 120.700.000 (như sheet của kế toán).

Ba mã INP1201–1203 xuất mẫu ngày 16/06 có giá 0 đ, không phải công nợ, nên không hiện.

**Sửa / xóa nhóm:** bấm **Sửa** ở dòng nhóm.
- Đổi mã thì chứng từ và phiếu thu đã gắn nhóm đổi theo.
- **Xóa nhóm** thì phần nợ nhóm về nợ thường; tổng nợ không đổi.

Nhóm Quạt – Vợt cũng hiện số cái từng mã của 8 khách. Diễn tập: khớp sổ Excel đến 30/09, kể cả hàng trả (KH042 66 cái, KH068 309 cái).

## 8. Gắn tay theo chứng từ khác (nếu kế toán muốn)

Cách làm giống mục 7: tạo nhóm tích **Chỉ gắn tay theo chứng từ**, rồi trên sổ chi tiết của khách bấm **Gắn nhóm** ở dòng chứng từ. Ví dụ:
- **KH071 Gia Bảo, nhóm "Đơn năm 2025"** (`DON-2025`, 93.847.989):
  - 22/12/2025: 3.760.000;
  - 30/12/2025, HĐ 00000004: 90.087.986.

## Từ nay về sau

- **Phiếu BH mới có quạt / vợt muỗi của 8 khách:** phần nhóm tự tách khi xuất kho.
- **NPP trả riêng tiền quạt:** *Thu tiền* → ô **Trừ vào** → **Thu cho nhóm: Quạt & vợt muỗi**.
- **Gặp thêm chứng từ sổ cũ trùng phiếu ERP:** ghi số phiếu ERP vào cột **"Phiếu ERP (trùng)"** của dòng đó trong file 04c, rồi Thay bằng file mới. Hoặc báo mình.

## Việc còn mở

- **KH058:** số dư lệch sheet "Rồng Việt" 62.180.000. Sheet chưa có 5 dòng ở `订单` và có cột chiết khấu. Bạn và kế toán đối soát.
- **KH034 lệch 4,10 đ** ngay trong file Excel:
  - `订单`!163 = 6.799.999,896;
  - sheet "319 ĐÔng Anh"!P5 gõ tay 6.800.004.

  Kế toán chọn số đúng.

## Lệnh deploy production (bạn chạy)

```powershell
.\infra\deploy.ps1 -Profile inoxpran-admin -Environment production -ConfirmProduction -Tag 20261019-171438
```
