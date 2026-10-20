# Báo cáo đối chiếu lịch sử công nợ (IMP-AR-01)

Nguồn: sổ công nợ gốc `每日订单汇总表_.xlsx` (kế toán gửi 16/10/2026, SHA-256 `124cdb5f…8305`), đọc thẳng giá trị ô — số chính xác đến số lẻ. So với bản trích từ 21 PDF trước đó: 620/620 bút toán trùng khách / loại / ngày / số chứng từ, chỉ khác phần lẻ do PDF làm tròn (tổng chênh 12 đ).

- Sheet nguồn: `订单` 620 bút toán (gộp từ 1559 dòng hàng), 388 dòng 0 đ không nhập, 49 cờ.
- Ngày chốt: 2026-09-30. Bút toán sau ngày chốt: 49 (hệ thống tự so với ERP khi nhập).
- Kiểm tra số học dòng hàng (SL × đơn giá, + thuế): 1560 dòng, lệch 1.

## So với số tổng trên sheet đối chiếu của từng khách

| Mã KH | Khách | Còn lại (đọc từ 订单) | Còn lại (sheet Excel) | Chênh lệch | Ghi chú |
|---|---|---:|---:|---:|---|
| KH001 | CÔNG TY TNHH THƯƠNG MẠI CẢNH CƯỜNG | 772.291.992,85 | 772.291.992,85 | 0 | Khớp |
| KH002 | CÔNG TY TNHH LỘC HƯNG THÁI | 315.237.999,82 | 315.237.999,82 | 0 | Khớp |
| KH005 | CÔNG TY TNHH THƯƠNG MẠI VÀ DỊCH VỤ ĐẠI PHÁT | 175.856.999,9 | 175.856.999,9 | 0 | Khớp |
| KH011 | Hợp Tác Xã Tân Sơn Quảng Ninh | 171.325.679,91 | 154.163.679,9 | 17.162.000,01 | Lệch: 20 dòng chỉ có ở 订单, 0 dòng chỉ có ở sheet đối chiếu (thường do sheet đối chiếu lập ở thời điểm khác hoặc tính riêng hàng mẫu / quạt) — chi tiết ở sheet CAN_KIEM_TRA |
| KH012 | CÔNG TY TNHH TM GIANG CHÂU | 212.209.999,73 | 207.889.999,77 | 4.319.999,96 | Lệch: 1 dòng chỉ có ở 订单, 0 dòng chỉ có ở sheet đối chiếu (thường do sheet đối chiếu lập ở thời điểm khác hoặc tính riêng hàng mẫu / quạt) — chi tiết ở sheet CAN_KIEM_TRA |
| KH015 | CÔNG TY TNHH MARSERRI VIỆT NAM | 132.890.999,93 | 179.999.999,96 | -47.109.000,04 | Lệch: 1 dòng chỉ có ở 订单, 0 dòng chỉ có ở sheet đối chiếu (thường do sheet đối chiếu lập ở thời điểm khác hoặc tính riêng hàng mẫu / quạt) — chi tiết ở sheet CAN_KIEM_TRA |
| KH024 | CÔNG TY TNHH ĐỒ GIA DỤNG MINH TRÍ | 166.355.999,7 | 131.905.999,8 | 34.449.999,89 | Lệch: 5 dòng chỉ có ở 订单, 1 dòng chỉ có ở sheet đối chiếu (thường do sheet đối chiếu lập ở thời điểm khác hoặc tính riêng hàng mẫu / quạt) — chi tiết ở sheet CAN_KIEM_TRA |
| KH034 | CÔNG TY TNHH THƯƠNG MẠI 319 ĐÔNG ANH | 364.740.992,45 | 364.740.996,55 | -4,1 | Lệch vài đồng giữa sheet 订单 và sheet đối chiếu ngay trong file Excel |
| KH042 | CÔNG TY TNHH  THƯƠNG MẠI TỔNG HỢP BẰNG ÁNH | 502.930.191,44 | 502.930.191,44 | 0 | Khớp |
| KH058 | CÔNG TY TNHH PHÁT TRIỂN SẢN XUẤT THƯƠNG MẠI DỊCH VỤ RỒNG VIỆT | 500.392.521,18 | 438.212.521,5 | 62.179.999,67 | Lệch: 5 dòng chỉ có ở 订单, 0 dòng chỉ có ở sheet đối chiếu (thường do sheet đối chiếu lập ở thời điểm khác hoặc tính riêng hàng mẫu / quạt) — chi tiết ở sheet CAN_KIEM_TRA |
| KH066 | CÔNG TY TNHH THƯƠNG MẠI GIANG MINH NGỌC | 526.525.994,74 | 545.275.994,79 | -18.750.000,04 | Lệch: 0 dòng chỉ có ở 订单, 2 dòng chỉ có ở sheet đối chiếu (thường do sheet đối chiếu lập ở thời điểm khác hoặc tính riêng hàng mẫu / quạt) — chi tiết ở sheet CAN_KIEM_TRA |
| KH068 | CÔNG TY TNHH NHÂN VƯỢNG | 756.604.193,06 | 756.604.193,06 | 0 | Khớp |
| KH074 | CÔNG TY TNHH THƯƠNG MẠI VÀ DỊCH VỤ THẢO NGUYÊN HD | 143.884.999,32 | 143.884.999,32 | 0 | Khớp |
| KH084 | CÔNG TY TNHH THƯƠNG MẠI THIẾT BỊ ĐIỆN CÔNG NGHIỆP VĨNH PHÚC | 44.723.998,9 | 109.073.998,9 | -64.350.000 | Lệch: 1 dòng chỉ có ở 订单, 0 dòng chỉ có ở sheet đối chiếu (thường do sheet đối chiếu lập ở thời điểm khác hoặc tính riêng hàng mẫu / quạt) — chi tiết ở sheet CAN_KIEM_TRA |
| KH086 | Vương Tuyết Mai | 32.432.769,09 | 32.432.769,09 | 0 | Khớp |
| KH088 | CÔNG TY TNHH THƯƠNG MẠI & DỊCH VỤ SƠN HIỀN SL | 72.129.997,35 | 72.129.997,35 | 0 | Khớp |
| KH091 | CÔNG TY TNHH ÁNH LUẬT | 141.745.999,6 | 141.745.999,6 | 0 | Khớp |

## Còn nợ theo khách (đọc từ 订单)

| Mã KH | Phát sinh (bán − trả) | Đã thu | Phí vận chuyển | Còn lại | Trước ngày chốt | Sau ngày chốt |
|---|---:|---:|---:|---:|---:|---:|
| KH001 | 993.624.394,85 | 221.332.402 | 0 | 772.291.992,85 | 822.291.992,85 | -50.000.000 |
| KH002 | 442.937.999,82 | 127.700.000 | 0 | 315.237.999,82 | 330.937.999,88 | -15.700.000,06 |
| KH003 | 0 | 7.120.000 | 0 | -7.120.000 | -7.120.000 | 0 |
| KH004 | 24.469.999,97 | 7.646.000 | 0 | 16.823.999,97 | 4.705.999,99 | 12.117.999,98 |
| KH005 | 227.436.999,9 | 50.000.000 | 1.580.000 | 175.856.999,9 | 175.856.999,9 | 0 |
| KH006 | 31.747.999,68 | 31.748.000 | 0 | -0,32 | -0,32 | 0 |
| KH007 | 65.603.259,1 | 7.442.963 | 0 | 58.160.296,1 | 58.160.296,1 | 0 |
| KH011 | 273.325.679,91 | 102.000.000 | 0 | 171.325.679,91 | 171.325.679,91 | 0 |
| KH012 | 323.861.999,73 | 111.652.000 | 0 | 212.209.999,73 | 207.889.999,77 | 4.319.999,96 |
| KH015 | 273.650.999,93 | 140.760.000 | 0 | 132.890.999,93 | 192.190.999,93 | -59.300.000 |
| KH017 | 1.600.000 | 1.600.000 | 0 | -0 | -0 | 0 |
| KH021 | 14.760.000,11 | 14.760.001 | 0 | -0,89 | -0,94 | 0,04 |
| KH024 | 413.145.999,7 | 242.108.000 | 4.682.000 | 166.355.999,7 | 131.905.999,8 | 34.449.999,89 |
| KH025 | 4.679.999,99 | 0 | 0 | 4.679.999,99 | 4.679.999,99 | 0 |
| KH028 | 0 | 2.520.000 | 0 | -2.520.000 | -2.520.000 | 0 |
| KH029 | 360.000 | 120.000 | 0 | 240.000 | 240.000 | 0 |
| KH034 | 824.255.992,45 | 450.000.000 | 9.515.000 | 364.740.992,45 | 686.012.994,26 | -321.272.001,81 |
| KH042 | 888.542.203,44 | 385.612.012 | 0 | 502.930.191,44 | 568.130.191,64 | -65.200.000,2 |
| KH043 | 780.000 | 780.000 | 0 | -0 | -0 | 0 |
| KH049 | 151.588.198,46 | 151.588.197 | 0 | 1,46 | 1,46 | 0 |
| KH050 | 2.400.000 | 6.300.000 | 0 | -3.900.000 | -3.900.000 | 0 |
| KH053 | 26.919.999,97 | 12.640.000 | 0 | 14.279.999,97 | 1.799.999,93 | 12.480.000,04 |
| KH055 | 43.803.999,96 | 29.412.000 | 0 | 14.391.999,96 | 20.339.999,95 | -5.947.999,99 |
| KH056 | 2.499.999,98 | 2.500.000 | 0 | -0,02 | 0 | -0,02 |
| KH058 | 1.044.093.464,83 | 527.560.000 | 1.140.000 | 500.392.521,18 | 438.212.521,5 | 62.179.999,67 |
| KH059 | 0 | 5.530.000 | 0 | -5.530.000 | 0 | -5.530.000 |
| KH062 | 0 | 9.130.000 | 0 | -9.130.000 | -9.130.000 | 0 |
| KH066 | 1.282.025.994,74 | 750.000.000 | 5.500.000 | 526.525.994,74 | 526.525.994,74 | 0 |
| KH067 | 3.769.999,98 | 3.770.000 | 0 | -0,02 | -0,02 | 0 |
| KH068 | 1.365.950.993,05 | 606.360.000 | 2.986.799,99 | 756.604.193,06 | 896.784.195,78 | -140.180.002,71 |
| KH070 | 111.880.000,61 | 111.880.002 | 0 | -1,39 | 27.479.999,18 | -27.480.000,57 |
| KH071 | 444.483.985,13 | 188.917.997 | 0 | 255.565.988,13 | 235.265.985,18 | 20.300.002,94 |
| KH074 | 343.472.004,1 | 195.954.885 | 3.632.119,78 | 143.884.999,32 | 143.884.999,32 | 0 |
| KH076 | 100.778.001,12 | 0 | 0 | 100.778.001,12 | 100.778.001,12 | 0 |
| KH080 | 12.480.000,09 | 0 | 0 | 12.480.000,09 | 0 | 12.480.000,09 |
| KH082 | 2.699.999,99 | 2.700.000 | 0 | -0,01 | -0,01 | 0 |
| KH083 | 7.560.000 | 7.560.000 | 0 | 0 | 0 | -0 |
| KH084 | 276.319.998,9 | 231.596.000 | 0 | 44.723.998,9 | 109.073.998,9 | -64.350.000 |
| KH086 | 103.189.999,09 | 70.000.000 | 757.230 | 32.432.769,09 | 32.432.769,09 | 0 |
| KH088 | 156.373.999,35 | 84.244.002 | 0 | 72.129.997,35 | 72.129.997,35 | 0 |
| KH089 | 2.160.000 | 2.160.000 | 0 | 0 | 0 | 0 |
| KH090 | 36.722.000,01 | 0 | 0 | 36.722.000,01 | 36.722.000,01 | 0 |
| KH091 | 194.125.999,6 | 50.000.000 | 2.380.000 | 141.745.999,6 | 40.797.999,79 | 100.947.999,82 |
| KH092 | 21.684.000,01 | 0 | 0 | 21.684.000,01 | 16.609.000,01 | 5.075.000,01 |
| KH094 | 2.827.000 | 2.827.000 | 0 | 0 | 2.827.000 | -2.827.000 |
| KH095 | 390.000 | 390.000 | 0 | -0 | -0 | 0 |

## Cần kế toán xem

- Đảo ngày / thiếu ngày: 27 dòng đảo ngày/tháng (Excel hiểu ngày gõ tay kiểu tháng/ngày), 20 dòng thiếu ngày (tạm lấy ngày dòng trước) — danh sách ở sheet CAN_KIEM_TRA.
- Chưa gắn được khách: GUOZHUOHAN [(để trống)] — 6 dòng, ảnh hưởng 0 đ (không đưa vào file nhập).
- Chưa gắn được khách: Trần Ngọc Dũng [(để trống)] — 32 dòng, ảnh hưởng 0 đ (không đưa vào file nhập).
- Chưa gắn được khách: SHENZHEN MEISHENGFA TRADE CO.,LTD [NCC01] — 15 dòng, ảnh hưởng 0 đ (không đưa vào file nhập).
- Chưa gắn được khách: (không tên — mã trống) [(để trống)] — 16 dòng, ảnh hưởng 0 đ (không đưa vào file nhập).
- Chưa gắn được khách: KHO [KHO] — 4 dòng, ảnh hưởng 0 đ (không đưa vào file nhập).
- Chưa gắn được khách: Nguyễn Anh Tuấn [(để trống)] — 2 dòng, ảnh hưởng 880.000,01 đ (không đưa vào file nhập).
- Số học dòng hàng lệch: 每日订单汇总表_.xlsx · 订单!843: SL 10 × 2564.81 = 25648.10 ≠ 2564810 hoặc 2564810 + 205184.8 ≠ 2769994.8 (đơn giá trong Excel có vẻ thiếu chữ số — file nhập dùng thành tiền cột V).
- Ngày ở khối nhập tay (dòng < 1012 của 订单) có ngày ≤ 12 vẫn giữ theo Excel; chỉ đảo khi ngày rơi sau mốc của khối hoặc ở tương lai.
