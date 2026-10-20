# Báo cáo đối chiếu lịch sử công nợ (IMP-AR-01)

Nguồn: 21 PDF trong `Bo_PDF_Cong_no_cho_Claude_Code` (4 phần, 354 trang). SHA-256 từng file khớp `DANH_MUC_FILE.csv`. 154/154 sheet khớp số dòng "N dòng có nội dung".

- Sheet nguồn: `订单` 620 bút toán (gộp từ 1559 dòng hàng), 388 dòng 0 đ không nhập, 46 cờ.
- Ngày chốt: 2026-09-30. Bút toán sau ngày chốt: 49 (hệ thống tự so với ERP khi nhập).
- Kiểm tra số học dòng hàng (SL × đơn giá, + thuế): 1560 dòng, lệch 1.

## So với số tổng trên sheet đối chiếu của từng khách

| Mã KH | Khách | Còn lại (đọc từ 订单) | Còn lại (sheet Excel) | Chênh lệch | Ghi chú |
|---|---|---:|---:|---:|---|
| KH001 | CÔNG TY TNHH THƯƠNG MẠI CẢNH CƯỜNG | 772.291.997 | 772.291.993 | 4 | Làm tròn (PDF hiển thị số đã làm tròn đến đồng) |
| KH002 | CÔNG TY TNHH LỘC HƯNG THÁI | 315.238.000 | 315.238.000 | 0 | Khớp |
| KH005 | CÔNG TY TNHH THƯƠNG MẠI VÀ DỊCH VỤ ĐẠI PHÁT | 175.857.000 | 175.857.000 | 0 | Khớp |
| KH011 | Hợp Tác Xã Tân Sơn Quảng Ninh | 171.325.680 | 154.163.680 | 17.162.000 | Lệch: 20 dòng chỉ có ở 订单, 0 dòng chỉ có ở sheet đối chiếu (thường do sheet đối chiếu lập ở thời điểm khác hoặc tính riêng hàng mẫu / quạt) — chi tiết ở sheet CAN_KIEM_TRA |
| KH012 | CÔNG TY TNHH TM GIANG CHÂU | 212.210.000 | 207.890.000 | 4.320.000 | Lệch: 1 dòng chỉ có ở 订单, 0 dòng chỉ có ở sheet đối chiếu (thường do sheet đối chiếu lập ở thời điểm khác hoặc tính riêng hàng mẫu / quạt) — chi tiết ở sheet CAN_KIEM_TRA |
| KH015 | CÔNG TY TNHH MARSERRI VIỆT NAM | 132.891.000 | 180.000.000 | -47.109.000 | Lệch: 1 dòng chỉ có ở 订单, 0 dòng chỉ có ở sheet đối chiếu (thường do sheet đối chiếu lập ở thời điểm khác hoặc tính riêng hàng mẫu / quạt) — chi tiết ở sheet CAN_KIEM_TRA |
| KH024 | CÔNG TY TNHH ĐỒ GIA DỤNG MINH TRÍ | 166.356.000 | 131.906.000 | 34.450.000 | Lệch: 5 dòng chỉ có ở 订单, 1 dòng chỉ có ở sheet đối chiếu (thường do sheet đối chiếu lập ở thời điểm khác hoặc tính riêng hàng mẫu / quạt) — chi tiết ở sheet CAN_KIEM_TRA |
| KH034 | CÔNG TY TNHH THƯƠNG MẠI 319 ĐÔNG ANH | 364.740.992 | 364.740.997 | -5 | Làm tròn (PDF hiển thị số đã làm tròn đến đồng) |
| KH042 | CÔNG TY TNHH  THƯƠNG MẠI TỔNG HỢP BẰNG ÁNH | 502.930.188 | 502.930.191 | -3 | Làm tròn (PDF hiển thị số đã làm tròn đến đồng) |
| KH058 | CÔNG TY TNHH PHÁT TRIỂN SẢN XUẤT THƯƠNG MẠI DỊCH VỤ RỒNG VIỆT | 500.392.526 | 438.212.522 | 62.180.004 | Lệch: 5 dòng chỉ có ở 订单, 0 dòng chỉ có ở sheet đối chiếu (thường do sheet đối chiếu lập ở thời điểm khác hoặc tính riêng hàng mẫu / quạt) — chi tiết ở sheet CAN_KIEM_TRA |
| KH066 | CÔNG TY TNHH THƯƠNG MẠI GIANG MINH NGỌC | 526.526.000 | 545.275.995 | -18.749.995 | Lệch: 0 dòng chỉ có ở 订单, 2 dòng chỉ có ở sheet đối chiếu (thường do sheet đối chiếu lập ở thời điểm khác hoặc tính riêng hàng mẫu / quạt) — chi tiết ở sheet CAN_KIEM_TRA |
| KH068 | CÔNG TY TNHH NHÂN VƯỢNG | 756.604.198 | 756.604.193,06 | 4,94 | Làm tròn (PDF hiển thị số đã làm tròn đến đồng) |
| KH074 | CÔNG TY TNHH THƯƠNG MẠI VÀ DỊCH VỤ THẢO NGUYÊN HD | 143.884.997 | 143.884.999 | -2 | Làm tròn (PDF hiển thị số đã làm tròn đến đồng) |
| KH084 | CÔNG TY TNHH THƯƠNG MẠI THIẾT BỊ ĐIỆN CÔNG NGHIỆP VĨNH PHÚC | 44.723.999 | 109.073.999 | -64.350.000 | Lệch: 1 dòng chỉ có ở 订单, 0 dòng chỉ có ở sheet đối chiếu (thường do sheet đối chiếu lập ở thời điểm khác hoặc tính riêng hàng mẫu / quạt) — chi tiết ở sheet CAN_KIEM_TRA |
| KH086 | Vương Tuyết Mai | 32.432.768 | 32.432.769 | -1 | Làm tròn (PDF hiển thị số đã làm tròn đến đồng) |
| KH088 | CÔNG TY TNHH THƯƠNG MẠI & DỊCH VỤ SƠN HIỀN SL | 72.129.998 | 72.129.997 | 1 | Làm tròn (PDF hiển thị số đã làm tròn đến đồng) |
| KH091 | CÔNG TY TNHH ÁNH LUẬT | 141.746.000 | 141.746.000 | 0 | Khớp |

## Còn nợ theo khách (đọc từ 订单)

| Mã KH | Phát sinh (bán − trả) | Đã thu | Phí vận chuyển | Còn lại | Trước ngày chốt | Sau ngày chốt |
|---|---:|---:|---:|---:|---:|---:|
| KH001 | 993.624.399 | 221.332.402 | 0 | 772.291.997 | 822.291.997 | -50.000.000 |
| KH002 | 442.938.000 | 127.700.000 | 0 | 315.238.000 | 330.938.000 | -15.700.000 |
| KH003 | 0 | 7.120.000 | 0 | -7.120.000 | -7.120.000 | 0 |
| KH004 | 24.470.000 | 7.646.000 | 0 | 16.824.000 | 4.706.000 | 12.118.000 |
| KH005 | 227.437.000 | 50.000.000 | 1.580.000 | 175.857.000 | 175.857.000 | 0 |
| KH006 | 31.748.000 | 31.748.000 | 0 | 0 | 0 | 0 |
| KH007 | 65.603.259 | 7.442.963 | 0 | 58.160.296 | 58.160.296 | 0 |
| KH011 | 273.325.680 | 102.000.000 | 0 | 171.325.680 | 171.325.680 | 0 |
| KH012 | 323.862.000 | 111.652.000 | 0 | 212.210.000 | 207.890.000 | 4.320.000 |
| KH015 | 273.651.000 | 140.760.000 | 0 | 132.891.000 | 192.191.000 | -59.300.000 |
| KH017 | 1.600.000 | 1.600.000 | 0 | 0 | 0 | 0 |
| KH021 | 14.760.000 | 14.760.001 | 0 | -1 | -1 | 0 |
| KH024 | 413.146.000 | 242.108.000 | 4.682.000 | 166.356.000 | 131.906.000 | 34.450.000 |
| KH025 | 4.680.000 | 0 | 0 | 4.680.000 | 4.680.000 | 0 |
| KH028 | 0 | 2.520.000 | 0 | -2.520.000 | -2.520.000 | 0 |
| KH029 | 360.000 | 120.000 | 0 | 240.000 | 240.000 | 0 |
| KH034 | 824.255.992 | 450.000.000 | 9.515.000 | 364.740.992 | 686.012.992 | -321.272.000 |
| KH042 | 888.542.200 | 385.612.012 | 0 | 502.930.188 | 568.130.188 | -65.200.000 |
| KH043 | 780.000 | 780.000 | 0 | 0 | 0 | 0 |
| KH049 | 151.588.200 | 151.588.197 | 0 | 3 | 3 | 0 |
| KH050 | 2.400.000 | 6.300.000 | 0 | -3.900.000 | -3.900.000 | 0 |
| KH053 | 26.920.000 | 12.640.000 | 0 | 14.280.000 | 1.800.000 | 12.480.000 |
| KH055 | 43.804.000 | 29.412.000 | 0 | 14.392.000 | 20.340.000 | -5.948.000 |
| KH056 | 2.500.000 | 2.500.000 | 0 | 0 | 0 | 0 |
| KH058 | 1.044.093.470 | 527.560.000 | 1.140.000 | 500.392.526 | 438.212.526 | 62.180.000 |
| KH059 | 0 | 5.530.000 | 0 | -5.530.000 | 0 | -5.530.000 |
| KH062 | 0 | 9.130.000 | 0 | -9.130.000 | -9.130.000 | 0 |
| KH066 | 1.282.026.000 | 750.000.000 | 5.500.000 | 526.526.000 | 526.526.000 | 0 |
| KH067 | 3.770.000 | 3.770.000 | 0 | 0 | 0 | 0 |
| KH068 | 1.365.950.998 | 606.360.000 | 2.986.800 | 756.604.198 | 896.784.200 | -140.180.002 |
| KH070 | 111.880.000 | 111.880.002 | 0 | -2 | 27.479.999 | -27.480.001 |
| KH071 | 444.483.982 | 188.917.997 | 0 | 255.565.985 | 235.265.982 | 20.300.003 |
| KH074 | 343.472.002 | 195.954.885 | 3.632.120 | 143.884.997 | 143.884.997 | 0 |
| KH076 | 100.778.002 | 0 | 0 | 100.778.002 | 100.778.002 | 0 |
| KH080 | 12.480.000 | 0 | 0 | 12.480.000 | 0 | 12.480.000 |
| KH082 | 2.700.000 | 2.700.000 | 0 | 0 | 0 | 0 |
| KH083 | 7.560.000 | 7.560.000 | 0 | 0 | 0 | 0 |
| KH084 | 276.319.999 | 231.596.000 | 0 | 44.723.999 | 109.073.999 | -64.350.000 |
| KH086 | 103.189.998 | 70.000.000 | 757.230 | 32.432.768 | 32.432.768 | 0 |
| KH088 | 156.374.000 | 84.244.002 | 0 | 72.129.998 | 72.129.998 | 0 |
| KH089 | 2.160.000 | 2.160.000 | 0 | 0 | 0 | 0 |
| KH090 | 36.722.000 | 0 | 0 | 36.722.000 | 36.722.000 | 0 |
| KH091 | 194.126.000 | 50.000.000 | 2.380.000 | 141.746.000 | 40.798.000 | 100.948.000 |
| KH092 | 21.684.000 | 0 | 0 | 21.684.000 | 16.609.000 | 5.075.000 |
| KH094 | 2.827.000 | 2.827.000 | 0 | 0 | 2.827.000 | -2.827.000 |
| KH095 | 390.000 | 390.000 | 0 | 0 | 0 | 0 |

## Cần kế toán xem

- Đảo ngày / thiếu ngày: 27 dòng đảo ngày/tháng (Excel hiểu ngày gõ tay kiểu tháng/ngày), 17 dòng thiếu ngày (tạm lấy ngày dòng trước) — danh sách ở sheet CAN_KIEM_TRA.
- Chưa gắn được khách: GUOZHUOHAN [(để trống)] — 6 dòng, ảnh hưởng 0 đ (không đưa vào file nhập).
- Chưa gắn được khách: Trần Ngọc Dũng [(để trống)] — 32 dòng, ảnh hưởng 0 đ (không đưa vào file nhập).
- Chưa gắn được khách: SHENZHEN MEISHENGFA TRADE CO.,LTD [NCC01] — 15 dòng, ảnh hưởng 0 đ (không đưa vào file nhập).
- Chưa gắn được khách: KHO [KHO] — 4 dòng, ảnh hưởng 0 đ (không đưa vào file nhập).
- Chưa gắn được khách: Nguyễn Anh Tuấn [(để trống)] — 2 dòng, ảnh hưởng 880.000 đ (không đưa vào file nhập).
- Số học dòng hàng lệch: Claude_Phan_1_Doan_11_trang_190-209.pdf · trang 207 · 订单!843: SL 10.00 × 2565 = 25650.00 ≠ 2564810 hoặc 2564810 + 205185 ≠ 2769995 (đơn giá hiển thị bị cắt trên PDF — dùng thành tiền).
- Ngày ở khối nhập tay (dòng < 1012 của 订单) có ngày ≤ 12 vẫn giữ theo Excel; chỉ đảo khi ngày rơi sau mốc của khối hoặc ở tương lai.
