# Đối soát công nợ ERP với sổ Excel gốc — mốc 30/09/2026

*Cập nhật 19/10/2026.* Lịch sử công nợ trên ERP **chỉ gồm sổ Excel đến hết 30/09**. Từ 01/10, kế toán nhập trên ERP.

**Sổ Excel:** `每日订单汇总表_.xlsx` (kế toán gửi 16/10/2026), sheet `订单`.
**ERP:** lô lịch sử sau khi **Thay bằng file mới** bằng `04c-cong-no-lich-su-den-30-09.xlsx`, diễn tập trên bản sao giống production.
**File kèm theo:**
- `07-doi-soat-cong-no-chinh-xac.xlsx`: bản chi tiết của báo cáo này.
- `09-giao-dich-thang-10-can-co-tren-erp.xlsx`: 49 bút toán tháng 10 để kế toán nhập.
- `每日订单汇总表_-da-sua-KH068.xlsx`: sổ Excel đã sửa ô KH068.

## Kết luận

- **Số dư đến 30/09 của 46 khách: ERP = sổ Excel, làm tròn đến đồng chênh 0 đ.** Phần lẻ dưới đồng lệch nhiều nhất 0,0356 đ.
- **KH001 bị ghi nợ trùng 66.150.000 đ, đã sửa.** Hai phiếu sau là **cùng một lần xuất**:
  - sổ cũ BH2026090104 ngày 30/09;
  - phiếu ERP BH2026100104 ngày 01/10.
- Bằng chứng nằm ở sổ xuất kho: phiếu xuất SWK2026090104, đơn ngày 30/09, **xuất kho 01/10**, khớp từng dòng (7 mã nồi cơm × 15 cái + hàng tặng, 2 máy sấy bù).
- Cách sửa: file 04c ghép dòng sổ cũ với phiếu ERP. Dòng sổ cũ không nhập; công nợ nằm ở phiếu ERP. Tồn kho giữ đúng vì hàng xuất thật ngày 01/10.
- Khi đã đủ bút toán tháng 10 trên ERP, KH001 còn **772.291.993 đ**, khớp Excel.
- **Tháng 10:** 49 bút toán của Excel không nhập từ file. Kế toán kiểm từng dòng theo file 09. Hệ thống cũng tự đánh dấu "đã có / nghi trùng / chưa có trên ERP" khi chạy thử thay lô.
- **Nợ quạt đến 30/09:** 7/8 khách khớp sheet kế toán.
  - KH058 nay cũng khớp (136.200.000): khoản 620.000 lệch trước đây là đơn quạt tháng 10.
  - KH068: sheet quên trừ 19,4 tr hàng trả; ERP đúng.

## 1. Số dư từng khách đến 30/09

| Mã KH | Khách | Excel đến 30/09 | ERP đến 30/09 | Chênh | Tháng 10 theo Excel | Còn lại theo Excel (16/10) |
|---|---|---:|---:|---:|---:|---:|
| KH001 | CÔNG TY TNHH THƯƠNG MẠI CẢNH CƯỜNG | 822.291.992,85 | 822.291.992,86 | 0 | -50.000.000,00 | 772.291.992,85 |
| KH002 | CÔNG TY TNHH LỘC HƯNG THÁI | 330.937.999,88 | 330.937.999,88 | 0 | -15.700.000,06 | 315.237.999,82 |
| KH003 | CÔNG TY TNHH XUẤT NHẬP KHẨU TỔNG HỢP PHÚ HƯNG THỊNH | -7.120.000,00 | -7.120.000,00 | 0 | — | -7.120.000,00 |
| KH004 | Lê Thị ánh Nguyệt | 4.705.999,99 | 4.705.999,99 | 0 | 12.117.999,98 | 16.823.999,97 |
| KH005 | CÔNG TY TNHH THƯƠNG MẠI VÀ DỊCH VỤ ĐẠI PHÁT | 175.856.999,90 | 175.856.999,90 | 0 | — | 175.856.999,90 |
| KH006 | CÔNG TY CỔ PHẦN GIA DỤNG CHÂU ÂU EUROHI | -0,32 | -0,32 | 0 | — | -0,32 |
| KH007 | CÔNG TY TNHH ĐẦU TƯ THƯƠNG MẠI QUỐC TẾ VIỆT LỢI | 58.160.296,10 | 58.160.296,10 | 0 | — | 58.160.296,10 |
| KH011 | Hợp Tác Xã Tân Sơn Quảng Ninh | 171.325.679,91 | 171.325.679,91 | 0 | — | 171.325.679,91 |
| KH012 | CÔNG TY TNHH TM GIANG CHÂU | 207.889.999,77 | 207.889.999,77 | 0 | 4.319.999,96 | 212.209.999,73 |
| KH015 | CÔNG TY TNHH MARSERRI VIỆT NAM | 192.190.999,93 | 192.190.999,90 | 0 | -59.300.000,00 | 132.890.999,93 |
| KH017 | Nguyễn Thị Thanh Hương | 0,00 | 0,00 | 0 | — | 0,00 |
| KH021 | Hộ Kinh Doanh Đào Thị Quỳnh Hoa | -0,94 | -0,94 | 0 | 0,04 | -0,89 |
| KH024 | CÔNG TY TNHH ĐỒ GIA DỤNG MINH TRÍ | 131.905.999,80 | 131.905.999,81 | 0 | 34.449.999,89 | 166.355.999,70 |
| KH025 | CÔNG TY TNHH GIA DỤNG YẾN NGUYỄN | 4.679.999,99 | 4.679.999,99 | 0 | — | 4.679.999,99 |
| KH028 | Nguyễn Thị Thu Hương | -2.520.000,00 | -2.520.000,00 | 0 | — | -2.520.000,00 |
| KH029 | Hồ Thế Anh | 240.000,00 | 240.000,00 | 0 | — | 240.000,00 |
| KH034 | CÔNG TY TNHH THƯƠNG MẠI 319 ĐÔNG ANH | 686.012.994,26 | 686.012.994,26 | 0 | -321.272.001,81 | 364.740.992,45 |
| KH042 | CÔNG TY TNHH THƯƠNG MẠI TỔNG HỢP BẰNG ÁNH | 568.130.191,64 | 568.130.191,65 | 0 | -65.200.000,20 | 502.930.191,44 |
| KH043 | Anh Huy | 0,00 | 0,00 | 0 | — | 0,00 |
| KH049 | CÔNG TY TNHH XUẤT NHẬP KHẨU HOÀNG TÂN | 1,46 | 1,46 | 0 | — | 1,46 |
| KH050 | Cửa hàng Phương Bắc | -3.900.000,00 | -3.900.000,00 | 0 | — | -3.900.000,00 |
| KH053 | CÔNG TY TNHH SƠN HÙNG | 1.799.999,93 | 1.799.999,94 | 0 | 12.480.000,04 | 14.279.999,97 |
| KH055 | Nguyễn Lệ Nây | 20.339.999,95 | 20.339.999,96 | 0 | -5.947.999,99 | 14.391.999,96 |
| KH056 | Thanh Anh | 0,00 | 0,00 | 0 | -0,02 | -0,02 |
| KH058 | CÔNG TY TNHH PHÁT TRIỂN SẢN XUẤT THƯƠNG MẠI DỊCH VỤ RỒNG VIỆT | 438.212.521,50 | 438.212.521,50 | 0 | 62.179.999,67 | 500.392.521,18 |
| KH059 | Tuấn Lan | 0,00 | 0,00 | 0 | -5.530.000,00 | -5.530.000,00 |
| KH062 | CÔNG TY TNHH ĐẦU TƯ THƯƠNG MẠI XUÂN HÙNG | -9.130.000,00 | -9.130.000,00 | 0 | — | -9.130.000,00 |
| KH066 | CÔNG TY TNHH THƯƠNG MẠI GIANG MINH NGỌC | 526.525.994,74 | 526.525.994,78 | 0 | — | 526.525.994,74 |
| KH067 | NGUYỄN THỊ MINH NGỌC | -0,02 | -0,02 | 0 | — | -0,02 |
| KH068 | CÔNG TY TNHH NHÂN VƯỢNG | 896.784.195,78 | 896.784.195,75 | 0 | -140.180.002,71 | 756.604.193,06 |
| KH070 | CÔNG TY TNHH DỊCH VỤ THƯƠNG MẠI TÙNG TRANG | 27.479.999,18 | 27.479.999,18 | 0 | -27.480.000,57 | -1,39 |
| KH071 | Công Ty TNHH Gia Bảo HP | 235.265.985,18 | 235.265.985,18 | 0 | 20.300.002,94 | 255.565.988,13 |
| KH074 | CÔNG TY TNHH THƯƠNG MẠI VÀ DỊCH VỤ THẢO NGUYÊN HD | 143.884.999,32 | 143.884.999,32 | 0 | — | 143.884.999,32 |
| KH076 | CÔNG TY TNHH THƯƠNG MẠI VÀ DỊCH VỤ ĐỨC ĐÀN | 100.778.001,12 | 100.778.001,12 | 0 | — | 100.778.001,12 |
| KH080 | CÔNG TY TNHH DỊCH VỤ THƯƠNG MẠI VÀ TỔNG HỢP AN THỊNH | 0,00 | 0,00 | 0 | 12.480.000,09 | 12.480.000,09 |
| KH082 | CÔNG TY TNHH THIẾT BỊ BẾP VÀ GIA DỤNG AN PHÚ | -0,01 | -0,01 | 0 | — | -0,01 |
| KH083 | Nguyễn Đức Tuấn | 0,00 | 0,01 | 0 | 0,00 | 0,00 |
| KH084 | CÔNG TY TNHH THƯƠNG MẠI THIẾT BỊ ĐIỆN CÔNG NGHIỆP VĨNH PHÚC | 109.073.998,90 | 109.073.998,91 | 0 | -64.350.000,00 | 44.723.998,90 |
| KH086 | Vương Tuyết Mai | 32.432.769,09 | 32.432.769,09 | 0 | — | 32.432.769,09 |
| KH088 | CÔNG TY TNHH THƯƠNG MẠI & DỊCH VỤ SƠN HIỀN SL | 72.129.997,35 | 72.129.997,35 | 0 | — | 72.129.997,35 |
| KH089 | Nguyễn Văn Y | 0,00 | 0,00 | 0 | — | 0,00 |
| KH090 | CÔNG TY CỔ PHẦN ĐIỆN MÁY TÂY BẮC | 36.722.000,01 | 36.722.000,01 | 0 | — | 36.722.000,01 |
| KH091 | CÔNG TY TNHH ÁNH LUẬT | 40.797.999,79 | 40.797.999,78 | 0 | 100.947.999,82 | 141.745.999,60 |
| KH092 | CÔNG TY TNHH NỘI THẤT T&H HOMES T&H | 16.609.000,01 | 16.609.000,00 | 0 | 5.075.000,01 | 21.684.000,01 |
| KH094 | Nguyễn Tuấn Hoàng | 2.827.000,00 | 2.827.000,00 | 0 | -2.827.000,00 | 0,00 |
| KH095 | Trần Ngọc Kiên | 0,00 | 0,00 | 0 | — | 0,00 |

- "ERP đến 30/09" = lô lịch sử + chứng từ đã ghép phiếu ERP (KH001: 66.149.999,95, công nợ nằm ở phiếu ERP BH2026100104).
- "Tháng 10 theo Excel" là phần kế toán nhập trên ERP. Âm nghĩa là giảm nợ (thu tiền, trả hàng).

## 2. Sheet đối chiếu của kế toán so với `订单`

| Mã KH | Sheet | `订单` (đến 16/10) | Sheet đối chiếu | Chênh | Lý do |
|---|---|---:|---:|---:|---|
| KH001 | Cảnh Cường | 772.291.992,85 | 772.291.992,85 | 0,00 | Khớp |
| KH002 | Đức Lương | 315.237.999,82 | 315.237.999,82 | 0,00 | Khớp |
| KH005 | Đại Phát | 175.856.999,90 | 175.856.999,90 | 0,00 | Khớp |
| KH011 | Tùng Anh | 171.325.679,91 | 154.163.679,90 | 17.162.000,01 | Sheet "Tùng Anh" dừng trước 20 dòng có ở 订单 (đơn và thu tiền sau). 订单 đầy đủ hơn. |
| KH012 | Trường An | 212.209.999,73 | 207.889.999,77 | 4.319.999,96 | Sheet "Trường An" chưa có phiếu xuất ngày 16/10/2026 (订单!2208, 4.320.000). |
| KH015 | Bá Hiến (2) | 132.890.999,93 | 179.999.999,96 | -47.109.000,04 | Sheet "Bá Hiến (2)" chưa có khoản thu 03/10/2026 (订单!2001, 59.300.000) và tách riêng hàng mẫu 12.191.000. |
| KH024 | Minh Trí | 166.355.999,70 | 131.905.999,80 | 34.449.999,89 | Sheet "Minh Trí" lập ở thời điểm khác: 5 dòng chỉ có ở 订单, 1 dòng chỉ có ở sheet. |
| KH034 | 319 ĐÔng Anh | 364.740.992,45 | 364.740.996,55 | -4,10 | Một dòng ngày 13/01/2026 (INP1003): 订单!163 là công thức = 6.799.999,896; sheet "319 ĐÔng Anh"!P5 gõ tay 6.800.004. Lệch 4,10 đ. Kế toán chọn số đúng. |
| KH042 | BẰNG ÁNH | 502.930.191,44 | 502.930.191,44 | 0,00 | Khớp |
| KH058 | Rồng Việt | 500.392.521,18 | 438.212.521,50 | 62.179.999,67 | Sheet "Rồng Việt" chưa có 5 dòng ở 订单 và có cột chiết khấu 15.000.943,66. Bạn và kế toán đối soát riêng. |
| KH066 | GMN | 526.525.994,74 | 545.275.994,79 | -18.750.000,04 | Sheet "GMN" có 2 dòng không có ở 订单 (tổng 18.750.000). |
| KH068 | NPP Thế Tài | 756.604.193,06 | 756.604.193,06 | 0,00 | Khớp |
| KH074 | Thảo Nguyên HD | 143.884.999,32 | 143.884.999,32 | 0,00 | Khớp |
| KH084 | Sơn Thúy | 44.723.998,90 | 109.073.998,90 | -64.350.000,00 | Sheet "Sơn Thúy" chưa có khoản thu 02/10/2026 (订单!2000, 64.350.000). |
| KH086 | NPP Cường Diệp | 32.432.769,09 | 32.432.769,09 | 0,00 | Khớp |
| KH088 | Sơn Thùy | 72.129.997,35 | 72.129.997,35 | 0,00 | Khớp |
| KH091 | Ánh Luật | 141.745.999,60 | 141.745.999,60 | 0,00 | Khớp |

Danh sách từng dòng lệch nằm ở sheet `DONG_LECH`.

**KH034 lệch 4,10 đ:**
- `订单`!163 là công thức, ra 6.799.999,896;
- sheet "319 ĐÔng Anh"!P5 gõ tay 6.800.004.

Kế toán chọn số đúng. Nếu sửa `订单` thì gửi lại file để mình dựng lại file nhập.

## 3. Nợ quạt & vợt muỗi đến 30/09 — 8 khách

| Mã KH | Khách | Sheet kế toán | ERP | Chênh | Ghi chú |
|---|---|---:|---:|---:|---|
| KH001 | CÔNG TY TNHH THƯƠNG MẠI CẢNH CƯỜNG | 187.099.999,61 | 187.099.999,61 | 0,00 | Khớp |
| KH002 | CÔNG TY TNHH LỘC HƯNG THÁI | 110.000.000,16 | 110.000.000,16 | 0,00 | Khớp |
| KH034 | CÔNG TY TNHH THƯƠNG MẠI 319 ĐÔNG ANH | 63.599.999,99 | 63.599.999,99 | 0,00 | Khớp |
| KH042 | CÔNG TY TNHH THƯƠNG MẠI TỔNG HỢP BẰNG ÁNH | 42.519.999,72 | 42.519.999,72 | 0,00 | Khớp |
| KH058 | CÔNG TY TNHH PHÁT TRIỂN SẢN XUẤT THƯƠNG MẠI DỊCH VỤ RỒNG VIỆT | 136.199.999,56 | 136.199.999,56 | 0,00 | Khớp (khoản 620.000 lệch trước đây là đơn quạt tháng 10 — nằm ở phiếu ERP khi kế toán nhập) |
| KH068 | CÔNG TY TNHH NHÂN VƯỢNG | 144.149.999,28 | 124.749.999,45 | -19.399.999,83 | Sheet quên trừ hàng trả, ERP đúng (mục 4) |
| KH071 | Công Ty TNHH Gia Bảo HP | 99.799.998,70 | 99.799.998,70 | 0,00 | Khớp |
| KH074 | CÔNG TY TNHH THƯƠNG MẠI VÀ DỊCH VỤ THẢO NGUYÊN HD | 18.000.000,01 | 18.000.000,01 | 0,00 | Khớp |

- Phiếu BH tháng 10 có quạt / vợt trên ERP tự cộng thêm phần nhóm khi xuất kho.
- KH066, KH007, KH053, KH055 không tách nợ quạt.

## 4. KH068 — sửa ô tổng nợ quạt trong file Excel

Sheet "NPP Thế Tài", ô I148 cộng thiếu 3 dòng trả hàng ngày 10/09/2026 (ô P97:P99, tổng −19.399.999,82). Bản sao đã sửa: `每日订单汇总表_-da-sua-KH068.xlsx`. Bản này chỉ đổi ô I148 và giá trị ô I150.

```
=P46+SUM(P52:P60)+P66+P67+P85+SUM(P97:P99)+SUM(P101:P103)
```

Kết quả: I148 = **124.749.999,46**. ERP ra 124.749.999,45. Cả hai hiển thị 124.749.999 đ.

## 5. Kiểm tra trên production

1. **Thay bằng file mới** với 04c. Ở bước chạy thử:
   - Bảng "Trùng với phiếu BH trên ERP" chỉ có KH001 LS00026 ↔ BH2026100104, trạng thái "Đã ghép". Nếu có dòng "Nghi trùng" khác: dừng lại, kiểm chứng từ xuất kho, rồi báo mình.
   - Bảng "Sau ngày chốt" là danh sách việc cho kế toán: dòng "Chưa có trên ERP" thì nhập trên ERP.
   - Khách có bút toán tháng 10 trước đây được "nhập kèm" sẽ chênh lớn. Điều này đúng, vì phần đó chuyển sang cho kế toán nhập trên ERP.
2. **Đối chiếu:** cột "Còn lại" từng khách bằng cột "Excel đến 30/09" ở mục 1. Riêng KH001 thấp hơn đúng 66.149.999,95 vì công nợ đó nằm ở phiếu ERP.
3. Khi kế toán nhập đủ tháng 10: sổ từng khách bằng cột "Còn lại theo Excel (16/10)", cộng phát sinh trên ERP sau 16/10.
