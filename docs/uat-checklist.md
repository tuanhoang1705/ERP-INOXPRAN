# UAT core ERP

## Bán hàng và kho

- [ ] Đơn thường tự duyệt và giữ đúng tồn khả dụng.
- [ ] Đơn vượt giá trị/chiết khấu/hạn mức vào hàng chờ đúng người duyệt.
- [ ] Hai người cùng giữ một SKU không thể vượt tồn.
- [ ] Retry cùng idempotency key không tạo order/shipment/movement trùng.
- [ ] Xuất kho làm giảm on-hand và reserved cùng transaction, tạo đúng công nợ.
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
