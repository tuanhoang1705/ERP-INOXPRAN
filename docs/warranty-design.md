# Thiết kế phân hệ Bảo hành – Sửa chữa – Dịch vụ

> Căn cứ: mẫu giấy "Phiếu sửa chữa / bảo hành / dịch vụ — 维修 / 保修 / 服务单" của công ty, Luật Bảo vệ quyền lợi người tiêu dùng số 19/2023/QH15 (Điều 30, hiệu lực 01/07/2024) và cách các hãng đồ gia dụng thường vận hành bảo hành.

## Quyết định đã chốt (03/10/2026) — giai đoạn 1 đã triển khai

| Nội dung | Quyết định | Trong hệ thống |
| --- | --- | --- |
| Thời hạn bảo hành | **12 tháng cho mọi sản phẩm** | Cấu hình `settings.warranty.warrantyMonths = 12`; hết hạn vào ngày tương ứng của tháng cuối (Bộ luật Dân sự 2015, Điều 147–148): hóa đơn 03/10/2026 → bảo hành hết ngày 03/10/2027. |
| Điều kiện bảo hành | Có hóa đơn: ngày bắt đầu = ngày hóa đơn. **Không có hóa đơn** (28/10/2026, WAR-NOINV-01 — sản phẩm chưa có serial / IMEI): nhân viên tiếp nhận chọn *Vẫn bảo hành* hoặc *Sửa có tính phí* | Tick "Khách không có hóa đơn" → bắt buộc chọn: *Vẫn bảo hành (công ty chịu chi phí)* → "Còn bảo hành · không HĐ"; *Sửa chữa có tính phí* → "Không thuộc diện bảo hành — không có hóa đơn", chỉ báo giá / từ chối. Ngày mua khách khai (không bắt buộc) chỉ để cảnh báo khi đã quá 12 tháng. |
| Hẹn trả | Mặc định **7 ngày**, chọn lại được bằng lịch | `turnaroundDays = 7`. |
| Màu | **Vàng khi đã qua 70% thời gian hẹn**, đỏ khi quá hẹn | Thời gian hẹn tính từ lúc tiếp nhận tới 23:59 ngày hẹn trả; `warningRatio = 0.7`. |
| Người làm | **Nhân viên bảo hành** tiếp nhận và xử lý; **Quản lý kho** có mọi quyền bảo hành và duyệt từ chối / đổi mới / hoàn tiền (WAR-ROLE-01, 28/10/2026 — trước đây Giám đốc duyệt); Giám đốc chỉ xem | Vai trò `WARRANTY`; tài khoản demo `baohanh@`, `baohanh2@inoxpran.vn`; Quản lý kho `kho@inoxpran.vn`. |
| Số serial | Sản phẩm **chưa in serial** trên thân | Ô serial không bắt buộc; nhận diện sản phẩm bằng **mã hàng + số hóa đơn** (dùng để đếm số lần bảo hành và cộng thời gian bảo hành trước). |

> **Ghi chú cho Ban Giám đốc về số serial.** Khi chưa có serial, hai chiếc cùng mã hàng trên cùng một hóa đơn không phân biệt được, nên việc đếm "lần bảo hành thứ 3" và cộng thời gian bảo hành chỉ chính xác ở mức hóa đơn. Khách cũng có thể mang hóa đơn của chiếc khác để bảo hành. Đề xuất: in tem serial / mã QR dán trên thân và hộp (theo lô sản xuất), ghi serial khi xuất kho (phiếu SWK). Khi có serial, hệ thống chỉ cần chuyển khóa nhận diện từ "mã hàng + hóa đơn" sang "serial", không phải đổi luồng.

## Giai đoạn 2 — đã triển khai (05/10/2026)

| Nội dung | Trong hệ thống |
| --- | --- |
| Ảnh khi nhận / phiếu đã ký | Mục **Ảnh phiếu** trên chi tiết phiếu: 3 loại ảnh (khi nhận, phiếu đã ký, khác), chụp thẳng bằng điện thoại. Dùng chung chuỗi kiểm tra với ảnh đối chiếu phiếu bán: quét mã độc ClamAV (không quét được thì không nhận), chỉ nhận ảnh thật PNG/JPEG/WebP ≤ 8 MB, lưu S3 `warranty-photos/<phiếu>/<ảnh>`, xem qua API sau khi kiểm tra quyền. Tối đa 12 ảnh/phiếu; người tải lên xóa được ảnh chụp nhầm khi phiếu chưa trả, phiếu đã trả thì ảnh là chứng từ. |
| Danh mục mã lỗi | Bảo hành › **Danh mục mã lỗi**: mã theo nhóm hàng (không chọn nhóm = dùng chung), 18 mã mẫu. Ô "Mã lỗi" khi chẩn đoán chỉ hiện mã của nhóm hàng sản phẩm + mã dùng chung; máy chủ chặn mã ngoài danh mục. Mã đã dùng chỉ ngừng, không xóa (giữ báo cáo). |
| Đổi mới / hoàn tiền liên kết kho | Khi **trả khách** phiếu đổi mới: xuất 1 sản phẩm mới từ kho bán hàng (kiểm tra tồn khả dụng, thiếu thì chặn và báo) và nhập sản phẩm lỗi vào **kho hàng lỗi** (`KHO-SD-HL`, đánh dấu "Kho hàng lỗi" ở Danh mục › Kho). Hoàn tiền: nhập sản phẩm lỗi, bắt nhập số tiền hoàn (ghi làm chi phí bảo hành). Thẻ kho: `Xuất đổi bảo hành`, `Nhập hàng lỗi bảo hành`, tham chiếu số phiếu SC; quản lý kho / thủ kho nhận thông báo. Kho hàng lỗi không bán ra, không tính giá trị tồn và cảnh báo dưới định mức. |
| Phí dịch vụ → công nợ | Sửa ngoài bảo hành (khách đồng ý báo giá): khi trả máy tự sinh khoản phải thu `AR…` ghi số phiếu SC. Đại lý: hạn theo số ngày nợ của đại lý; khách vãng lai: ghi vào hồ sơ khách lẻ **KH000**, kèm tên / SĐT người trả, đến hạn ngay. Kế toán nhận thông báo; trang Công nợ có liên kết ngược về phiếu bảo hành. |
| Báo cáo | Bảo hành › **Báo cáo bảo hành** (Giám đốc, Quản lý kho, nhân viên bảo hành): tiếp nhận, đã trả, tỉ lệ đúng hẹn, thời gian xử lý trung bình, tỉ lệ từ chối, chi phí công ty chịu, doanh thu dịch vụ; biểu đồ theo tháng; lỗi theo mã lỗi / mã hàng; kết quả xử lý; sản phẩm bảo hành từ lần thứ 3. |

Còn để giai đoạn 3: ghi serial khi xuất kho (SWK); xuất linh kiện sửa chữa từ kho; đòi bảo hành nhà cung cấp cho hàng nằm trong kho hàng lỗi; phiếu chi hoàn tiền (hiện chỉ ghi số tiền hoàn làm chi phí); khách tự tra cứu bằng QR.

Các mục **(cần chốt)** dưới đây là đề xuất ban đầu, đã được thay bằng bảng quyết định trên.

## 1. Mục tiêu

1. Mỗi sản phẩm khách mang tới có **một phiếu điện tử** đủ các ô của mẫu giấy, in được đúng mẫu song ngữ Việt – Trung.
2. Hệ thống **tự xác định còn bảo hành / hết bảo hành** từ ngày mua và chính sách của mã hàng; kỹ thuật chỉ xác nhận hoặc ghi lý do loại trừ.
3. Mỗi phiếu có **ngày hẹn trả** chọn bằng lịch và tự đổi màu: không màu → vàng (sắp đến hẹn) → đỏ (quá hẹn).
4. Quản lý nhìn được: phiếu nào sắp trễ, ai đang giữ, lỗi nào hay gặp ở mã hàng nào, tốn bao nhiêu chi phí bảo hành.
5. Đáp ứng các nghĩa vụ của Luật 19/2023 (bảng ở mục 9).

## 2. Khái niệm

| Khái niệm | Quy ước |
| --- | --- |
| Phiếu bảo hành | Mã `SC` + năm tháng + số thứ tự, VD `SC2026100001` (khác tiền tố `BH` của phiếu xuất kho bán hàng). **1 phiếu = 1 sản phẩm** đúng như mẫu giấy (một ô Sản phẩm, một ô Serial); mỗi phiếu tối đa 5 dòng lỗi. Khách mang nhiều máy thì tạo nhiều phiếu trong một lần tiếp nhận (tự chép thông tin khách). |
| Diện bảo hành | **Còn bảo hành** (miễn phí) · **Hết bảo hành** (dịch vụ tính phí, cần khách đồng ý báo giá) · **Không thuộc diện bảo hành** (lỗi do sử dụng: rơi vỡ, cháy nổ do nguồn điện, tự ý sửa, mất tem…). |
| Hạn bảo hành sản phẩm | Ngày bắt đầu + số tháng theo chính sách, cộng thêm thời gian các lần bảo hành trước (luật: thời gian thực hiện bảo hành không tính vào thời hạn bảo hành). |
| Hẹn trả | Ngày tiếp nhận → ngày hẹn trả khách. Là căn cứ tô màu. |

## 3. Quy trình và trạng thái

```text
 Tiếp nhận ─▶ Kiểm tra / chẩn đoán ─┬─▶ Đang sửa ─┬─▶ Kiểm tra sau sửa ─▶ Chờ trả khách ─▶ Đã trả (đóng)
                                    │   ▲          └─▶ Chờ linh kiện ─┘
                                    ├─▶ Chờ khách duyệt báo giá (hết BH) ─▶ Đang sửa / Trả lại không sửa
                                    ├─▶ Đề nghị đổi mới / hoàn tiền ─▶ (Trưởng BH duyệt) ─▶ Chờ trả khách
                                    └─▶ Từ chối bảo hành (lý do + khách xác nhận) ─▶ Chờ trả khách
 Hủy: chỉ khi tiếp nhận nhầm, phải ghi lý do.
```

| Bước | Ai làm | Việc trong hệ thống |
| --- | --- | --- |
| Tiếp nhận | Kỹ thuật BH, nhân viên KD (nhận từ đại lý), kế toán | Tra khách (SĐT / mã đại lý), tra sản phẩm (mã hàng, serial, phiếu BH xuất bán); ghi phụ kiện kèm theo, tình trạng ngoại quan, chụp ảnh; chọn ngày hẹn trả; in **phiếu tiếp nhận** giao khách (có ghi thời gian thực hiện bảo hành). |
| Kiểm tra / chẩn đoán | Kỹ thuật BH | Ghi hiện tượng, **nguyên nhân gốc**, mã lỗi; xác nhận diện bảo hành. |
| Báo giá (hết BH) | Kỹ thuật BH | Ghi chi phí dự kiến; lưu bằng chứng khách đồng ý/không đồng ý (ảnh Zalo như luồng đối chiếu phiếu BH). |
| Sửa / thay linh kiện | Kỹ thuật BH | Biện pháp khắc phục, linh kiện thay (mã, số lượng). |
| Kiểm tra sau sửa | Kỹ thuật BH (người khác người sửa nếu có) | Tích **chức năng – an toàn – hiệu suất** (bắt buộc trước khi sang "Chờ trả"). |
| Đổi mới / hoàn tiền / từ chối / miễn phí ngoài BH | Trưởng bộ phận BH duyệt | Bắt buộc lý do; từ chối phải có xác nhận của khách. |
| Trả khách | Kỹ thuật BH / KD | Ghi ngày trả, người nhận, khách ký phiếu; hệ thống tính thời gian BH còn lại. |

## 4. Xác định còn / hết bảo hành

1. **Ngày bắt đầu bảo hành (cần chốt)** — đề xuất thứ tự ưu tiên:
   1. Ngày mua của người tiêu dùng (hóa đơn, phiếu bảo hành của đại lý — chụp ảnh lưu kèm).
   2. Nếu không có: ngày INOXPRAN giao hàng cho đại lý (lấy tự động từ phiếu SWK / phiếu BH đã xuất).
   3. Nhập tay, có ảnh chứng từ.
2. **Hạn bảo hành** = ngày bắt đầu + số tháng theo chính sách của mã hàng (lưu cố định vào phiếu tại thời điểm tiếp nhận) + tổng số ngày các lần bảo hành trước.
3. **Còn bảo hành** nếu ngày tiếp nhận ≤ hạn bảo hành; **hết bảo hành** nếu quá hạn. Kỹ thuật có thể chuyển sang **không thuộc diện bảo hành** sau khi kiểm tra, bắt buộc chọn lý do loại trừ và có xác nhận của khách.
4. **Thay linh kiện**: linh kiện đó có hạn bảo hành mới tính từ ngày thay. **Đổi sản phẩm mới**: hạn bảo hành tính lại từ ngày đổi.
5. **Lần thứ 3**: hệ thống đếm số lần bảo hành của cùng sản phẩm (serial) trong thời hạn; từ lần thứ 3 mà vẫn lỗi thì cảnh báo và đề xuất **đổi mới hoặc hoàn tiền**.

## 5. Hẹn trả và 3 mức màu

- Khi tiếp nhận: chọn **ngày tiếp nhận** (mặc định hôm nay) và **ngày hẹn trả** bằng lịch; hệ thống gợi ý ngày hẹn = ngày tiếp nhận + số ngày mặc định của nhóm hàng (**cần chốt**, đề xuất 7 ngày) và hiện "hẹn X ngày".
- Màu tính theo ngày (giờ Việt Nam), cho phiếu chưa trả khách:

| Màu | Điều kiện | Ý nghĩa |
| --- | --- | --- |
| Không màu (trắng) | Còn **hơn N ngày** đến ngày hẹn | Trong thời gian an toàn |
| **Vàng** | Còn **từ 0 đến N ngày** (N mặc định 2, **cần chốt**) | Cảnh báo sắp đến hẹn |
| **Đỏ** | Đã **quá ngày hẹn** mà chưa trả | Quá hạn |

- Phiếu đã trả: không tô màu, ghi "Đúng hẹn" hoặc "Trễ X ngày".
- **Dời hẹn**: được phép (VD chờ linh kiện), bắt buộc lý do; hệ thống giữ **ngày hẹn gốc** để đo tỉ lệ đúng hẹn và lưu lịch sử dời hẹn.
- **Tự động nhắc**: mỗi sáng và mỗi giờ, phiếu vừa chuyển vàng/đỏ được báo tới kỹ thuật phụ trách và Trưởng bộ phận BH (chuông thông báo, có tiếng Trung); dashboard có ô "Phiếu bảo hành quá hẹn".

```text
 Số phiếu       Khách hàng            Sản phẩm        Diện BH     Tiếp nhận  Hẹn trả     Còn       Trạng thái
 SC2026100012   Đại lý Minh Phát      INP2102 (Chảo)  Còn BH      01/10      08/10       5 ngày    Đang sửa
▌SC2026100009   Siêu thị Hùng Vương   INP6004 (Quạt)  Hết BH      28/09      04/10       1 ngày    Chờ linh kiện     ← vàng
▌SC2026100004   Khách lẻ – 0912…      INP1503 (Nồi)   Còn BH      22/09      29/09       trễ 4     Kiểm tra sau sửa  ← đỏ
```

## 6. Thông tin trên phiếu

Giữ đủ các ô của mẫu giấy, bổ sung những ô cần cho quản lý và cho luật.

| Phần | Trường (theo mẫu giấy) | Bổ sung |
| --- | --- | --- |
| Đầu phiếu | Số phiếu, Ngày tiếp nhận, Khách hàng / Đại lý, SĐT, Địa chỉ, Nhân viên tiếp nhận | Ngày hẹn trả, Kỹ thuật phụ trách, Kênh tiếp nhận (đại lý gửi / khách mang tới / nhận tại nhà) |
| Sản phẩm | Sản phẩm / Model, Số serial, Ngày mua / Ngày xuất bán, Trạng thái bảo hành | Liên kết mã hàng và phiếu BH xuất bán, Hạn bảo hành (tự tính), Phụ kiện kèm theo, Tình trạng ngoại quan, Ảnh khi nhận, Sản phẩm cho mượn dùng tạm (nếu có) |
| Dòng lỗi (tối đa 5) | STT, Mã lỗi / Mã SP, Ngày nhận, Tình trạng / Hiện tượng, Nguyên nhân xác định, Biện pháp khắc phục, Mã BH / Linh kiện, Ghi chú | Mã lỗi chọn từ danh mục theo nhóm hàng |
| Kết quả | Kết quả xử lý, Ngày hoàn tất, Linh kiện thay thế, Chi phí / Giá trị dịch vụ, Thời gian bảo hành còn lại (tự tính), Trạng thái cuối | Ai chịu chi phí (công ty / khách / nhà cung cấp), Kiểm tra sau sửa (chức năng – an toàn – hiệu suất), Ngày trả và người nhận |
| Xác nhận | Khách hàng / Đại lý ký, Kỹ thuật / Bộ phận bảo hành ký | Ảnh phiếu đã ký (lưu S3, quét mã độc như ảnh đối chiếu hiện có) |

## 7. Danh mục cần thiết lập

| Danh mục | Nội dung |
| --- | --- |
| Chính sách bảo hành | Theo nhóm hàng (6 nhóm hiện có), cho phép ghi đè theo mã hàng: số tháng bảo hành, số ngày hẹn trả mặc định, ngưỡng vàng N, phạm vi và các trường hợp loại trừ (luật yêu cầu công bố công khai). |
| Mã lỗi | Theo nhóm hàng, VD `NOI-01` bong lớp chống dính, `QUAT-03` động cơ không quay. |
| Lý do loại trừ | Rơi vỡ, cháy nổ do nguồn điện, vào nước, tự ý tháo sửa, mất tem / serial, dùng sai hướng dẫn… |
| Kết quả xử lý | Sửa chữa, Thay linh kiện, Đổi sản phẩm mới, Hoàn tiền, Từ chối bảo hành, Trả lại không sửa. |

Thời hạn bảo hành từng nhóm hàng **(cần chốt)**:

| Nhóm hàng | Thời hạn (tháng) | Hẹn trả mặc định (ngày) |
| --- | --- | --- |
| Nồi & bộ nồi inox | ? | 7 |
| Chảo inox & chống dính | ? | 7 |
| Nồi & chảo gang tráng men | ? | 7 |
| Điện gia dụng nhà bếp | ? | 7 |
| Quạt điện & quạt tích điện | ? | 7 |
| Chăm sóc cá nhân & tiện ích | ? | 7 |

## 8. Màn hình

1. **Danh sách phiếu bảo hành**: mặc định sắp theo ngày hẹn trả; lọc theo màu, trạng thái, kỹ thuật, khách, diện BH; ô đếm nhanh "Đỏ / Vàng / Đang xử lý".
2. **Tiếp nhận**: gõ SĐT / mã đại lý / số phiếu BH / serial → tự điền khách, sản phẩm, ngày mua, hiện ngay **Còn BH (đến dd/mm/yyyy)** hoặc **Hết BH**; chọn ngày hẹn bằng lịch.
3. **Chi tiết phiếu**: các bước như mục 3, dòng thời gian (ai làm gì, lúc nào), dời hẹn có lý do, ảnh, in phiếu.
4. **In phiếu**: đúng bố cục mẫu giấy A4 ngang, song ngữ Việt – Trung, có logo INOXPRAN.
5. **Tra cứu bảo hành**: theo serial / SĐT — lịch sử các lần bảo hành của sản phẩm.
6. **Báo cáo**: tỉ lệ đúng hẹn, thời gian xử lý trung bình, lỗi theo mã hàng / mã lỗi, chi phí bảo hành theo tháng / mã hàng, tỉ lệ từ chối, sản phẩm bảo hành từ 3 lần.

Giao diện có tiếng Việt và tiếng Trung như các màn hình hiện tại.

## 9. Đối chiếu Luật 19/2023/QH15, Điều 30 khoản 2

| Nghĩa vụ | Hệ thống đáp ứng |
| --- | --- |
| a) Công bố chính sách bảo hành: thời điểm, thời hạn, nội dung, phạm vi, phương thức, trường hợp loại trừ | Danh mục chính sách theo nhóm/mã hàng; in kèm trên phiếu. |
| c) Cấp văn bản tiếp nhận bảo hành ghi rõ thời gian thực hiện; thời gian này không tính vào thời hạn bảo hành; linh kiện thay / sản phẩm đổi mới được tính lại thời hạn | In phiếu tiếp nhận có ngày hẹn trả; hạn bảo hành tự cộng thời gian các lần bảo hành; tính lại hạn khi thay linh kiện / đổi mới. |
| d) Cung cấp sản phẩm tương tự dùng tạm hoặc hình thức giải quyết phù hợp theo thỏa thuận | Ô "sản phẩm cho mượn dùng tạm" và nhắc thu hồi khi trả máy. |
| đ) Đổi mới hoặc trả tiền khi hết thời gian thực hiện mà không sửa được, hoặc đã bảo hành từ 3 lần trở lên mà vẫn lỗi | Cảnh báo khi quá hẹn mà chưa sửa được và khi đến lần thứ 3; luồng đổi mới / hoàn tiền có duyệt. |
| e) Chịu chi phí sửa chữa, vận chuyển đi – về | Trường "ai chịu chi phí" và chi phí vận chuyển; báo cáo chi phí bảo hành. |

Nội dung luật cần bộ phận pháp chế / kế toán xác nhận lại trước khi công bố chính sách.

## 10. Liên kết với các phân hệ khác

| Phân hệ | Liên kết |
| --- | --- |
| Bán hàng | Lấy khách, mã hàng, ngày giao từ phiếu BH / SWK; mở phiếu bảo hành từ chi tiết phiếu xuất bán. |
| Kho (**đã làm** giai đoạn 2) | Đổi mới: xuất hàng mới, nhập hàng lỗi vào **kho hàng lỗi / chờ trả nhà cung cấp**; hoàn tiền: nhập hàng lỗi. Xuất linh kiện cho sửa chữa: giai đoạn 3. |
| Công nợ (**đã làm** giai đoạn 2) | Phí dịch vụ ngoài bảo hành sinh khoản phải thu (đại lý / khách lẻ KH000). |
| Thông báo, nhật ký | Dùng chung outbox, chuông thông báo (song ngữ), nhật ký kiểm toán như các phiếu hiện có. |
| Người dùng | Vai trò mới: **Kỹ thuật bảo hành**, **Trưởng bộ phận bảo hành**. |

## 11. Lộ trình đề xuất

| Giai đoạn | Nội dung |
| --- | --- |
| 1 — **đã làm (03/10/2026)** | Cấu hình chính sách (12 tháng, hóa đơn bắt buộc, hẹn 7 ngày, vàng 70%); lý do loại trừ; phiếu đủ trường mẫu giấy; tự tính còn/hết bảo hành, cộng thời gian bảo hành trước, cảnh báo lần thứ 3; hẹn trả + 3 màu + nhắc tự động mỗi giờ + ô cảnh báo trên dashboard; luồng trạng thái, báo giá, Giám đốc duyệt; kiểm tra sau sửa; dời hẹn có lý do; in phiếu song ngữ có logo; danh sách lọc theo màu / trạng thái; vai trò Nhân viên bảo hành; tiếng Trung. **Chưa làm**: ảnh khi nhận / phiếu đã ký, danh mục mã lỗi riêng (đang nhập tự do), báo cáo. |
| 2 — **đã làm (05/10/2026)** | Ảnh khi nhận / phiếu đã ký (S3 + quét mã độc); danh mục mã lỗi theo nhóm hàng; đổi mới / hoàn tiền liên kết kho (kho hàng lỗi); phí dịch vụ sang công nợ; báo cáo bảo hành. |
| 2b | Ghi serial khi xuất kho (SWK) để tra cứu chính xác; xuất linh kiện sửa chữa từ kho. |
| 3 | Báo cáo chất lượng theo mã hàng; đòi bảo hành nhà cung cấp; khách tự tra cứu bảo hành bằng mã QR trên phiếu. |

## 12. Cần INOXPRAN chốt

1. Thời hạn bảo hành từng nhóm hàng (bảng mục 7) và có mã hàng nào khác nhóm không.
2. ~~Ngày bắt đầu bảo hành tính từ đâu khi khách không có hóa đơn (mục 4.1).~~ Đã chốt 28/10/2026: nhân viên tiếp nhận chọn vẫn bảo hành / sửa có phí, ngày mua khách khai chỉ để tham khảo (WAR-NOINV-01).
3. Số ngày hẹn trả mặc định và ngưỡng vàng N.
4. Ai được tiếp nhận; ai duyệt từ chối / đổi mới / hoàn tiền.
5. Sản phẩm hiện có số serial in trên thân / hộp chưa; nếu chưa, tra cứu theo mã hàng + ngày mua.
6. Có cho khách mượn sản phẩm dùng tạm không, áp dụng cho nhóm hàng nào.
