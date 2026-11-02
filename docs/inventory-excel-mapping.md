# Đối chiếu file tồn kho của công ty với hệ thống kho ERP

Nguồn: `GS仓库出库汇总_完整列.pdf` (08/10/2026), gồm:
- 3 bảng tồn kho tháng 8, 9, 10 (`N月库存明细单`);
- nhật ký xuất / nhập tháng 8–9 (`出库汇总`);
- biên bản thiếu hàng khi mở thùng;
- danh sách khách hàng.

Mục đích:
- quyết định có phải sửa hệ thống kho cho khớp file Excel không;
- chuẩn bị dữ liệu nhập vào production.

## 1. Cách file Excel đang tính

**Bảng tồn tháng:** mỗi mã hàng một dòng. Các cột tính theo hai công thức sau (đã thử lại với số liệu thật):

| Công thức | Ví dụ |
| --- | --- |
| **Xuất tổng hợp** (综合出库) = tổng các cột xuất − tổng các cột nhập, kể cả nhập hàng mua | Tháng 9, INP6005: 76 bán + 5 tặng − 80 nhập = **1** |
| **Tồn cuối kỳ** (库存结余) = tồn cuối tháng trước − xuất tổng hợp | 531 − 1 = **530** |

- **Hàng lỗi khách trả** (使用不良) được **cộng lại vào tồn chung**. Ví dụ tháng 9, INP1001: 632 − 15 bán + 1 hàng lỗi = 618.
- **% tồn còn lại** = tồn cuối ÷ số nhập ban đầu (初始入库). Ví dụ INP6151: 1.059 ÷ 1.062 = 99,72%.

**Nhật ký xuất / nhập:** mỗi dòng là một chứng từ, gồm:
- khách hàng và mã KH;
- ngày và số phiếu bán (BH…), ngày và số phiếu xuất (SWK…), ngày và số phiếu nhập (NK…);
- model, số lượng theo từng loại;
- ghi chú, thủ kho, NVKD.

## 2. Đối chiếu từng cột

| Cột Excel | ERP hiện có | Đánh giá |
| --- | --- | --- |
| Tồn cuối tháng trước / Tồn cuối kỳ | Thẻ kho ghi từng phát sinh, tồn tính tức thời | Có dữ liệu, **thiếu báo cáo theo tháng** |
| 本月入库: nhập hàng mua | Phiếu nhập kho từ đơn mua / lô hàng nhập | Có |
| 本月出库: xuất bán | Phiếu xuất SWK theo phiếu bán BH | Có |
| 活动赠送·套餐搭配: hàng tặng KM / combo xuất | Dòng "hàng tặng" trên phiếu BH | Có trên phiếu, nhưng **thẻ kho gộp chung với xuất bán** |
| 损耗: hao hụt | Điều chỉnh giảm, lý do ghi tay | **Thiếu loại chuẩn** để cộng theo cột |
| 样品: hàng mẫu xuất / nhập lại | Điều chỉnh giảm / tăng, lý do ghi tay | **Thiếu loại chuẩn**; không theo dõi được mẫu chưa trả |
| 套餐搭配退回: hàng tặng / combo trả lại | Không có | **Thiếu phiếu trả hàng bán** |
| 滞销退货: hàng bán chậm khách trả | Không có | **Thiếu phiếu trả hàng bán** |
| 进口不良 / 使用不良: hàng lỗi nhập khẩu / do sử dụng | Phiếu khách trả (TH) loại *Hàng lỗi nhập khẩu* / *Hàng lỗi do sử dụng* nhập **kho hàng lỗi**, có cột nguyên nhân / ghi chú từng dòng (20/10/2026). Phiếu bảo hành không nhập hàng lỗi nữa (trước 20/10 có) | Có; nguyên nhân ghi ở từng dòng phiếu trả. ERP để hàng lỗi ở kho riêng (không bán nhầm), còn Excel cộng vào tồn chung → báo cáo phải cộng 2 kho khi so |
| 库存退货返厂: trả nhà máy | Không có | **Thiếu phiếu trả nhà cung cấp** |
| 综合出库, % tồn còn lại, 初始入库 | Không có | **Thiếu báo cáo** |
| Nhật ký có BH / SWK / NK, thủ kho, NVKD | Thẻ kho có số chứng từ | **Thiếu cột khách / NVKD / thủ kho và xuất Excel** |

## 3. Kết luận

**Không phải làm lại hệ thống kho.**
- Thẻ kho của ERP ghi từng phát sinh, chi tiết hơn Excel.
- Bảng `月库存明细单` chỉ là báo cáo cộng từ thẻ kho theo tháng.

**Đã bổ sung 4 phần (08/10/2026)** để kho bỏ được Excel:

| Phần | Màn hình | Cách dùng |
| --- | --- | --- |
| 1. Loại phát sinh chuẩn | *Kho & Giao hàng › Tồn kho › Điều chỉnh tồn* | Chọn loại khi ghi phiếu: tăng = kiểm kê thừa / hàng mẫu nhập lại; giảm = kiểm kê thiếu / hao hụt / hàng mẫu xuất. Xuất bán tự tách **hàng tặng / combo** theo dòng 🎁 của phiếu BH. Bảo hành đổi mới ghi "xuất đổi bảo hành", hàng lỗi khách trả ghi bằng phiếu khách trả loại "hàng lỗi do sử dụng" (từ 20/10/2026 phiếu bảo hành không tự nhập hàng lỗi) |
| 2. Phiếu trả hàng | *Kho & Giao hàng › Phiếu trả hàng* | **Khách trả hàng** (số TH…): chọn khách, loại (bán chậm / hàng tặng–combo trả lại / lỗi nhập khẩu / lỗi do sử dụng), kho nhận (hàng lỗi tự chọn kho hàng lỗi), số phiếu BH gốc nếu có (không trả quá số đã xuất). **Trả nhà máy** (số XT…): chọn NCC, đơn mua gốc nếu có, không xuất quá tồn khả dụng. Phiếu chỉ ghi kho; khách trả (trừ hàng tặng) tự tính giá trị theo giá phiếu BH gốc và **báo kế toán** — kế toán giảm công nợ / xuất hóa đơn điều chỉnh rồi bấm "Đã điều chỉnh công nợ" (ghi số chứng từ) |
| 3. Tồn kho tháng | *Kho & Giao hàng › Tồn kho tháng* | Chọn tháng, kho (hoặc "Tất cả kho (gộp)" như file Excel). Cột song ngữ đúng thứ tự `月库存明细单`; % tồn còn lại tô màu như file; tháng hiện tại có "Tồn có sẵn" và "Đối chiếu sổ" (✓ khi thẻ kho khớp tồn đang ghi). **Xuất Excel** giống hệt file `TỒN KHO.xlsx` của kho (30/10/2026): cùng bố cục 2 dòng tiêu đề, màu đầu cột, font 等线 14 đậm, công thức E / R / S và dòng 合计; bỏ 移动数据 / 数据查验 và cột ghi chú (31/10/2026 — chiếm nhiều diện tích); 现货库存 = số đếm kiểm kê đã chốt trong tháng, lệch thì tô vàng ô tồn cuối kỳ; mã ERP còn tồn mà không đếm cũng tô vàng. **Cột R 综合出库 = xuất ròng trong tháng = tổng xuất (bán, tặng, mẫu, hao hụt, trả NCC…) − tổng nhập (hàng mua, khách trả, mẫu mang về…)**: dương = tồn giảm, âm = nhập nhiều hơn xuất; tồn cuối kỳ S = tồn tháng trước F − R (VD INP1003: 1.728 − 374 = 1.354). **Tồn đầu kỳ nhập hệ thống lúc lên ERP (lô IMP 13/10/2026) tính vào F "tồn tháng trước"**, không tính là nhập trong tháng (31/10/2026) |
| 4. Nhật ký xuất nhập | *Kho & Giao hàng › Nhật ký xuất nhập* | Mỗi phát sinh một dòng: khách / NCC, mã KH, phiếu BH và ngày, số phiếu xuất (SWK, XT, ADJ…) / nhập (GR, TH…), mã hàng, loại, ghi chú, thủ kho, NVKD. Lọc theo kho, loại, mã hàng / số phiếu. **Xuất Excel** theo bố cục `出库汇总` (số lượng nằm đúng cột loại) |

Ghi chú:
- Xem "Tất cả kho (gộp)": cộng cả kho hàng lỗi (như Excel đang cộng hàng lỗi vào tồn), bỏ chuyển kho nội bộ. Xem từng kho: có thêm cột chuyển kho đến / đi.
- Cột riêng của ERP (xuất đổi bảo hành, kiểm kê thừa / thiếu, tồn đầu kỳ nhập hệ thống, chuyển kho) chỉ hiện trên màn hình khi tháng có phát sinh. File Excel theo mẫu gộp chúng vào cột gần nghĩa để công thức tồn cuối của mẫu vẫn đúng: G += chuyển kho đến; H = xuất bán − nhập lại do hủy / sửa phiếu + xuất bổ sung; I = hao hụt + kiểm kê thiếu + xuất đổi bảo hành − kiểm kê thừa; J += xuất kiểm định; P += nhập lại sau kiểm định; Q += chuyển kho đi. Tồn đầu kỳ nhập hệ thống cộng vào F (tồn tháng trước) của tháng nhập.
- Dữ liệu trước 08/10/2026 chưa ghi loại được xếp theo nghiệp vụ (VD điều chỉnh cũ → kiểm kê thừa / thiếu).

## 4. Chuẩn bị nhập dữ liệu production

**Tồn đầu kỳ** (sheet `TON_DAU_KY`):
1. **Chốt ngày:** ví dụ hết 31/10/2026. Kiểm kê thực tế cùng ngày.
2. **Số lượng:** lấy cột **库存结余** của tháng chốt. Dòng có ghi chú "实际库存多 / 少 1 台" thì dùng **số kiểm kê thực tế**.
3. **Mã kho:**
   - `KHO-SD` cho hàng bán được;
   - hàng lỗi đã để riêng thì dùng `KHO-SD-HL` (kho hàng lỗi). Excel đang cộng chung, nên phải đếm tách khi kiểm kê.
4. **Giá vốn:** file tồn kho chỉ có số lượng. Kế toán lấy giá vốn bình quân tại ngày chốt từ MISA, điền vào cột "Giá vốn".

**Mã hàng** chỉ được gồm chữ hoa, số và `. _ / -`:
- `INP6401黑` → `INP6401-DEN`, `INP6401蓝` → `INP6401-XANH` (đề xuất). Tên Trung đặt ở cột "Tên tiếng Trung".
- `INP6404-18`, `INP6404-16`, `INP6209A` giữ nguyên.

**Hàng không bán** (áo mưa, quần áo công nhân, kệ trưng bày, rượu, băng keo 481): đề xuất **không đưa vào ERP**, vì là vật tư nội bộ.
- Nếu vẫn cần theo dõi: thêm cờ "không bán" cho sản phẩm (ERP chưa có), mã dạng `VT-AOMUA-TRANG-XL`.

**Số nhập ban đầu** (初始入库): điền cột tùy chọn **"Số lượng nhập ban đầu"** của sheet `TON_DAU_KY` (lấy cột 初始入库 của tháng chốt, không nhỏ hơn số tồn).
- % tồn còn lại = tồn cuối ÷ (số nhập ban đầu + hàng mua nhập sau ngày chốt).
- Mã để trống cột này thì báo cáo không tính % (hiện "—").

**Khách hàng** (sheet `KHACH_HANG`):

| Cột trong danh sách hiện tại | Đưa vào ERP |
| --- | --- |
| 地区 (VD 南定) | "Mã khu vực". Khai báo trước ở sheet `KHU_VUC` |
| 对应销售 (VD 陈玉铿) | "Mã NVKD". Khai báo trước ở sheet `NVKD` với mã và họ tên tiếng Việt |
| Tên tiếng Trung | Tạm đặt ở "Tên viết tắt" (tối đa 60 ký tự). Hồ sơ khách chưa có ô tên Trung riêng |
| MST / CCCD chủ hộ | "Mã số thuế" |
| ĐT di động người liên hệ | "ĐT người liên hệ" |

Dòng "样品", "零售", "样板返还仓库" trong nhật ký **không phải khách hàng**:
- 样品 / 样板: phiếu mẫu;
- 零售: khách lẻ, dùng mã khách lẻ chung.

**Công nợ đầu kỳ:** file tồn kho không có. Lấy sổ chi tiết phải thu từ MISA, mỗi chứng từ còn nợ một dòng.

**Phát sinh trong tháng chốt** (các dòng `出库汇总`): **không cần nhập**, chỉ cần số tồn cuối.

Quy trình nhập theo [data-import.md](data-import.md):
1. chạy thử trên **staging**;
2. đối chiếu tồn theo kho và công nợ theo khách với Excel / MISA;
3. hoàn tác, rồi nhập **production** đúng ngày chốt.
