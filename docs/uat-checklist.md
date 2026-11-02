# UAT core ERP

## Bán hàng và kho

- [ ] Đơn thường tự duyệt và giữ đúng tồn khả dụng.
- [ ] Đơn vượt giá trị/chiết khấu/hạn mức vào hàng chờ đúng người duyệt.
- [ ] Hai người cùng giữ một SKU không thể vượt tồn.
- [ ] Retry cùng idempotency key không tạo order/shipment/movement trùng.
- [ ] Xuất kho làm giảm on-hand và reserved cùng transaction; công nợ tạo khi xác nhận đã giao (AR-DLV-01).
- [ ] Không thể xuất khi reservation không còn hợp lệ.

## Mua hàng

- [ ] Đơn mua qua đúng ngưỡng duyệt.
- [ ] Nhập một phần cập nhật received quantity và trạng thái.
- [ ] Không thể nhập vượt số đã đặt.
- [ ] Nhập đủ chuyển `RECEIVED` và movement khớp projection.

## Công nợ

- [ ] Thu một phần/đủ cập nhật outstanding và trạng thái đúng.
- [ ] Tổng phân bổ khác số tiền hoặc vượt dư nợ bị từ chối.
- [ ] Tuổi nợ dùng ngày đến hạn theo `Asia/Ho_Chi_Minh` ở màn hình.

## Quyền và audit

- [ ] Nhân viên chỉ thao tác đúng vai trò và kho được cấp.
- [ ] Truy cập ID của kho/đơn ngoài phạm vi bị từ chối.
- [ ] MFA bắt buộc với admin, quản lý, kế toán trên production.
- [ ] Mọi thao tác tạo/duyệt/post có actor, timestamp UTC, correlation ID và before/after cần thiết.

## Hàng khác và ghi chú phiếu BH / SWK (26/10/2026)

- [ ] Form lập / sửa phiếu bán có **Thêm hàng khác**, từng dòng chọn được **Hàng tặng / Hàng đổi / Hàng bù**; cùng mã chọn ba loại vẫn giữ ba dòng riêng.
- [ ] Ba loại đều đơn giá / tiền hàng / thuế / chiết khấu 0; số lượng vẫn được giữ chỗ và trừ kho. Không thêm tiền công nợ hoặc doanh thu so với dòng bán thường.
- [ ] Lưu nháp, mở lại sửa, đổi loại, duyệt đề nghị sửa: loại và số lượng giữ đúng; hàng tặng cũ vẫn hiện Hàng tặng.
- [ ] Giao diện tiếng Trung có đủ ba lựa chọn. Phiếu hàng mẫu / kiểm định / xuất tặng riêng không hiện nút Thêm hàng khác.
- [ ] **Ghi chú nội bộ** đổi thành **Ghi chú**, hướng dẫn ghi rõ nội dung sẽ in trên BH và SWK.
- [ ] Bản in BH / SWK hiện **Ghi chú: …** dưới phần tiền bằng chữ, thay dòng Số chứng từ gốc kèm theo; giữ xuống dòng, ghi chú trống và 500 ký tự không lỗi bố cục; nội dung HTML được in như văn bản.

## Phân công bước phiếu BH (SAL-STEP-01, 26/10/2026)

- [ ] Admin mở *Người dùng & phân quyền → Phân công bước phiếu BH*, tích / bỏ tích từng bước cho tài khoản không phải Admin; quyền đặc biệt và tài khoản Admin bị khóa với Admin (chỉ quản trị gốc); Giám đốc / kiểm soát chỉ xem.
- [ ] Bỏ tích bước nào thì người đó mất nút bước đó và máy chủ chặn (403) ngay; tích thêm thì làm được.
- [ ] Thủ kho bị thu bước 4 không còn trong danh sách thủ kho; phiếu nháp đang chọn người đó phải đổi thủ kho mới phát hành được.
- [ ] Người không thuộc kho được tích bước 5 xác nhận giao được mọi phiếu đã xuất, nhận thông báo khi kho xuất xong; phiếu lưu tên người xác nhận giao.
- [ ] Thông báo từng bước tới đúng người được phân công; dòng thời gian phiếu hiện người phụ trách từng bước.

## Hủy phiếu trả hàng (INV-RET-02, 27/10/2026)

- [x] Phiếu hàng mẫu nhập lại không có phiếu xuất mẫu: kho / Giám đốc bấm hủy, ghi lý do → tồn của các mã về như trước khi lập phiếu; phiếu theo phiếu xuất mẫu vẫn khóa.
- [x] Phiếu đã hủy biến mất với kho, kế toán, Giám đốc (danh sách, mở theo đường dẫn, thẻ kho, nhật ký xuất nhập); tài khoản quản trị gốc vẫn thấy với nhãn *Đã hủy*.
- [x] Thẻ kho sau khi ẩn: số dư chạy liền mạch, tồn hiện tại không đổi.

## Chứng từ đã hủy / đã xóa (DOC-HIDE-01, 27/10/2026)

- [ ] Phiếu BH đã hủy (trước và sau giao) không hiện với kho, kế toán, KD, Giám đốc, Admin thường: danh sách (cả tìm theo số), Tổng quan *Đơn hàng mới nhất*, mở theo đường dẫn → không tìm thấy; quản trị gốc vẫn thấy với nhãn *Đã hủy* và lọc *Đã hủy*.
- [ ] Người thường hủy phiếu xong được đưa về danh sách với thông báo "Đã hủy … Phiếu không còn hiển thị trong danh sách" (không nhắc quản trị gốc).
- [ ] Đề nghị hủy / xóa đã duyệt, yêu cầu sửa giá đã rút, đơn mua / lô nhập / kiểm kê / bảo hành đã hủy, chứng từ phải thu đã hủy trên sổ khách: người thường không thấy; số dư cuối sổ khách không đổi.
- [ ] Thẻ kho / nhật ký: dòng của phiếu BH hủy sau giao biến mất với người thường, tồn chạy liền mạch, tồn hiện tại như root; báo cáo tồn tháng không đổi.

## Hàng tặng / đổi / bù và menu chuột phải (SAL-KIND-01, SAL-CTX-01, 27/10/2026)

- [ ] Form phiếu BH: dòng hàng khác có ô chọn (thả xuống) Hàng tặng / Hàng đổi / Hàng bù, ô chọn và cả dòng tô màu cam / xanh / tím; trang phiếu và hộp đề nghị sửa cùng màu.
- [ ] Chuột phải vào dòng hàng: Sao chép dòng xuống dưới (con trỏ vào ô số lượng dòng mới), Thêm dòng trống, Tặng kèm, Xóa dòng; Esc / bấm ra ngoài đóng menu; Shift + chuột phải ra menu trình duyệt.
- [ ] Lưu phiếu có 2 dòng cùng mã: lưu đủ 2 dòng, giữ / xuất tồn cộng dồn.

## Mẫu PXK-001 / PXK-002 — thuế cả phiếu / thuế từng dòng (TPL-01, PRI-03, 27/10/2026)

- [ ] Lập phiếu mới: ô *Mẫu* mặc định "PXK-002 · thuế từng dòng" → cột "% thuế GTGT" và "Tiền thuế GTGT" cuối dòng; Σ thuế dòng = tiền thuế; tiền hàng + tiền thuế = tổng thanh toán (không lệch đồng nào).
- [ ] Đổi ô *Mẫu* sang PXK-001 → không còn 2 cột thuế, khung tổng tiền có lại ô chọn thuế suất chung.
- [ ] Mở sửa một phiếu cũ (PXK-001): vẫn một thuế suất cho cả phiếu, tổng tiền không đổi.
- [ ] Phiếu PXK-002 có 2 thuế suất: trang phiếu ghi "Theo từng dòng" và 2 cột thuế dòng; bản in ghi "Theo từng dòng".
- [ ] Hộp "Xử lý công nợ" phiếu trả hàng: đơn giá chưa thuế, % thuế GTGT, tiền thuế GTGT; tổng giảm nợ = cộng tiền hàng + tiền thuế.

## Trả hàng trừ vào tổng nợ (AR-RET-01, 27/10/2026)

- [ ] Hộp *Xử lý công nợ* không còn khung xem trước "Trừ vào công nợ".
- [ ] Khách có nợ nhóm (VD QUAT-VOT-68) + nợ thường: *Xử lý công nợ* mặc định *Tổng công nợ* → chỉ trừ nợ thường (BH gốc trước, rồi hạn trả cũ nhất); nợ nhóm giữ nguyên; vượt nợ thường → khách trả trước.
- [ ] Chọn *Nhóm X* → trừ phần nhóm X trước.
- [ ] Phiếu đã ghi: *Đổi nơi trừ* sang nhóm rồi về tổng — xem trước đúng, sổ khách cập nhật, có nhật ký.

## Giám đốc chỉ xem, Quản lý kho phụ trách bảo hành (ROLE-DIR-01, WAR-ROLE-01, 28/10/2026)

- [ ] Đăng nhập Giám đốc, mở lần lượt Danh mục, Đơn hàng, Kho, Giá & KM, Công nợ, Bảo hành, Báo cáo: xem được như trước, không còn nút Thêm / Sửa / Xóa / Lưu / Thanh toán / Nhận hàng / Kiểm kê / Xử lý công nợ.
- [ ] Giám đốc vẫn duyệt được phiếu BH ngoại lệ, đơn mua từ ngưỡng, yêu cầu sửa đơn giá; vẫn đổi mật khẩu và đọc thông báo.
- [ ] Tài khoản Giám đốc kiêm Kế toán (hoặc Admin) vẫn làm được việc của vai trò kia.
- [ ] Quản lý kho: thấy menu Bảo hành, tiếp nhận phiếu, chẩn đoán, đề nghị đổi mới → phiếu "Chờ duyệt" (menu "Chờ Quản lý kho duyệt") → tự duyệt, trả khách; thêm / sửa mã lỗi; xem báo cáo.
- [ ] Nhân viên bảo hành không tự duyệt được; Giám đốc mở phiếu chờ duyệt chỉ thấy, không có nút duyệt.
- [ ] *Người dùng & phân quyền → Ma trận quyền*: cột Giám đốc chỉ có "Chỉ xem toàn bộ" và 3 việc duyệt + xem báo cáo.

## Công nợ khi giao thành công, bảo hành không hóa đơn, ảnh điện thoại (AR-DLV-01, WAR-NOINV-01, 28/10/2026)

- [ ] Thủ kho lập SWK: phiếu hiện "Đã xuất kho · chờ giao"; sổ công nợ khách chưa có phiếu, có dòng "Đã xuất kho, chờ giao: … phiếu"; báo cáo doanh số chưa tính.
- [ ] Bấm *Xác nhận đã giao* (trang phiếu) hoặc *Đã giao* (Kho → Giao hàng): hộp "Hoàn thành giao hàng?" giữa màn hình nêu mã phiếu, khách, tổng tiền, hạn thanh toán; *Hủy* không đổi gì; *Hoàn thành* → phiếu "Đã giao", sổ công nợ có chứng từ, hạn = hôm nay + số ngày nợ; kế toán nhận thông báo.
- [ ] Phiếu đã xuất chưa giao vẫn tính vào hạn mức khi phát hành phiếu mới (vượt hạn mức → chờ duyệt).
- [ ] Lập phiếu khách trả hàng theo phiếu chưa giao → báo "chưa giao thành công"; sau khi giao thì lập được.
- [ ] Tiếp nhận bảo hành: chọn sản phẩm khi chưa nhập hóa đơn → chỉ gợi ý (không báo đỏ); ô hóa đơn có dấu *; tick "Khách không có hóa đơn" → hai ô Số / Ngày hóa đơn ẩn đi, bắt buộc chọn *Vẫn bảo hành* / *Sửa chữa có tính phí*; chọn *Vẫn bảo hành* → phiếu "Còn bảo hành · không HĐ", sửa miễn phí; ngày mua khai quá 12 tháng → cảnh báo vàng.
- [ ] Danh sách phiếu bảo hành: phiếu chờ duyệt hiện badge "Chờ duyệt".
- [ ] Chụp ảnh bằng điện thoại (iPhone + Android) tải lên phiếu bảo hành: lên được nhiều ảnh liền, hiện "Đang nén x/y · đã tải x/y"; ảnh lưu ~0,3–0,6 MB, đúng chiều; tệp đính kèm / Excel > 1 MB tải lên được.
- [ ] Kế toán lập phiếu BH, bấm vào đơn giá (29/10/2026): hộp "Mở sửa đơn giá" chỉ cần lý do, bấm *Mở sửa giá* → sửa được ngay, không chờ duyệt; trang phiếu ghi người cấp là chính kế toán; mục *Duyệt sửa giá* hiện trong menu kế toán.

## Phân vùng NVKD, Excel thương hiệu, file tồn kho theo mẫu, ô tìm chức năng (PV-01, XLS-01, 30/10/2026)

- [ ] *Danh mục › Phân vùng NVKD*: bảng 34 tỉnh mới / 63 tỉnh cũ đúng người phụ trách; gán thêm tỉnh cho một NVKD (tỉnh của người khác → hỏi chuyển khách); danh sách khách lệch vùng + nút chuyển.
- [ ] Thêm khách: chọn tỉnh mới → tỉnh cũ chỉ còn các tỉnh thuộc nó; tỉnh đã giao → NVKD tự điền, khóa; Hà Nội hỏi kênh NPP / bán lẻ; kế toán chọn NVKD khác vùng bị chặn; Admin đặt ngoại lệ có lý do.
- [ ] Lập phiếu BH: chọn khách → NVKD tự chọn theo khách, khóa ô (Admin đổi được).
- [ ] Bảng điều khiển → Xuất Excel: có cột "NV phụ trách", sheet "Theo nhân viên KD", "Theo tỉnh thành"; chữ to, đầu bảng navy, dòng tổng tô cam nhạt; in thử A4 ngang.
- [ ] Sổ công nợ khách, nhật ký xuất nhập, file mẫu nhập dữ liệu: cùng khung thương hiệu.
- [ ] Thủ kho: *Tồn kho tháng* → Xuất Excel → mở cạnh file `TỒN KHO.xlsx`: cùng tiêu đề, cột, màu, công thức; tồn cuối khớp màn hình.
- [ ] Ô "Tìm chức năng" nằm trên thanh trên cùng; phiếu kiểm kê (2 bước) không còn bị che nút "Kiểm tra" / "Chốt kiểm kê".

## Doanh thu / đã thu, thanh toán ngay, Excel công nợ, mã NK, đơn mua theo lô, đổi email (DB-REV-02, AR-PAYNOW-01, AR-XLS-02, NK-01, PO-FLOW-02, USR-EMAIL-01, 31/10/2026)

- [ ] Bảng điều khiển: card "Doanh thu tháng · trước thuế" (số chính) + dòng "Sau thuế (gồm VAT)"; card "Đã thu tháng" = tổng phiếu thu trong tháng, ghi số phiếu và phần thanh toán ngay.
- [ ] Lập phiếu BH chọn "Thanh toán ngay" → ô Hình thức thu mặc định "Chưa thu — ghi công nợ" (giao xong vẫn là công nợ, hạn = ngày giao); chọn chuyển khoản / tiền mặt → giao xong phiếu tự có phiếu thu PAY, sổ công nợ không còn nợ, card "Đã thu" tăng; kế toán "Bỏ ghi thu tự động" (ghi lý do) → chứng từ mở lại, thành nợ quá hạn.
- [ ] Bấm "Công nợ" trên thanh trên cùng → mở *Công nợ theo khách hàng*.
- [ ] *Công nợ theo khách hàng* → Xuất Excel: chọn 3 tháng, tất cả khách → mở cạnh file 收付明细汇总表: mỗi tháng một sheet, cùng tiêu đề / cột / màu vàng / font; E tháng sau trỏ J tháng trước; tổng J sheet cuối = "Tổng còn nợ" trên trang. Chọn 2 khách → file chỉ có 2 khách đó.
- [ ] Hồ sơ khách: ô "Tên tiếng Trung" — in dòng thứ 2 cột tên khách của file Excel công nợ.
- [ ] Kho lập phiếu khách trả hàng / hàng mẫu nhập lại → số NKyyyymm####; phiếu cũ sau khi chạy script hiện số NK theo ghi chú, dòng nhỏ "Mã cũ TH…"; 3 phiếu cùng ghi NK2026100033 thành NK2026100033, -2, -3.
- [ ] Đơn mua USD/CNY: thanh tiến trình 5 bước; kế toán ghi cọc xong vẫn thấy nút "Tạo lô hàng nhập" (cảnh báo nếu chưa có lô); tạo lô trong đơn → thủ kho mở lô bấm "Nhập kho lô" (kể cả lô chưa bấm khởi hành). Đơn ngoại tệ không còn nút nhập kho trực tiếp; đơn VND vẫn có.
- [ ] Quản trị › Người dùng: sửa email một tài khoản thử → người đó bị đăng xuất, đăng nhập bằng email mới được, email cũ không được; đổi sang email đã có → báo trùng.

## Xóa tất cả thông báo, tồn kho gộp mã, kiểm kê gộp, giá riêng từng khách (NOTI-02, INV-ALL-01, KK-ALL-01, PRI-CUST-01, 31/10/2026)

- [ ] Chuông thông báo → "Xóa tất cả" → xác nhận → khung trống; tài khoản khác vẫn còn thông báo của họ.
- [ ] *Tồn kho khả dụng* "Tất cả kho": mỗi mã một dòng, có "gồm n hàng lỗi"; chọn kho hàng lỗi: không còn dòng tồn 0, không số đỏ.
- [ ] Xuất Excel công nợ: bấm "Tháng này / Quý này / 3 tháng gần nhất" → nút sáng; sửa tay ô tháng → nút tắt.
- [ ] Bắt đầu kiểm kê: không chọn kho, phiếu "Tất cả kho"; mã ở 2 kho hiện "SĐ … · lỗi …"; Sửa ERP chọn kho hàng lỗi → chỉ kho lỗi đổi.
- [ ] Hồ sơ khách → tab Giá riêng: dán 2 cột từ Excel, lưu; lập phiếu BH cho khách đó → giá tự điền, nhãn "Giá riêng", chiết khấu 0, không xin quyền sửa giá; NVKD chỉ xem.

## Liên phòng ban (rà soát 22/10/2026 — giả lập 10 ngày trên bản sao production)

- [x] Tồn kho = thẻ kho, giữ chỗ = phiếu giữ, công nợ "đã thu" = phân bổ phiếu thu, phiếu bán đã xuất có công nợ đúng tổng, trả hàng / nhập mua khớp thẻ kho (kiểm sau mỗi ngày).
- [x] Mỗi lần chuyển việc (KD → kế toán → duyệt → KD đối chiếu → kho → kế toán; kho → kế toán khi khách trả; bảo hành → Giám đốc / kho / kế toán) có thông báo tới đúng người.
- [x] Thông báo "chờ đối chiếu khách" chỉ tới NVKD đề nghị / phụ trách phiếu.
- [x] Gửi lại cùng mã thao tác (mạng chập chờn) không tạo phiếu thu trùng; hai người cùng giữ một mã không giữ vượt tồn.
- [x] Mọi trang danh sách (trừ báo cáo tồn kho tháng dạng Excel) vừa màn 1366 px, không gọi API lặp.
- [x] Trả hàng giảm công nợ (D1, 22/10/2026): kế toán "Xử lý công nợ" → phiếu giảm nợ trừ vào phiếu BH gốc / nợ cũ nhất / khách trả trước, đúng phần nhóm tách riêng; sửa / hủy phiếu TH hoặc hủy phiếu BH → phiếu giảm nợ tự hủy, công nợ trở lại như trước.
- [x] Sổ phải trả NCC (D2, 22/10/2026): đặt cọc → âm; nhập kho / sửa phiếu nhập → tăng / giảm và báo kế toán; trả nhà máy theo đơn → giảm; đơn ngoại tệ tách tiền tệ, quy VND theo tỷ giá đơn; kinh doanh / kho không xem được.
- [ ] "Việc của tôi" (D3) — chờ chốt.
- [ ] Phân quyền thực tế theo bảng đã chốt (D4), MFA tài khoản quyền cao (D5).
