# Bàn giao API bảng giá cho lần phát hành ERP tiếp theo

Release riêng: `20261112-103317-price-api`, dựng từ image production `20261111-151627` theo digest cố định. Bản vá bổ sung API ngay trong ERP, phục vụ APK `INOXPRAN-BaoGia-1.1.0.apk`.

**Đã kích hoạt production lúc 10:40 ngày 12/11/2026 (UTC+7).** HTTPS chính thức và APK release đã xác nhận lấy dữ liệu thật không đăng nhập: 101 sản phẩm, ảnh hợp lệ, hiện 0 chương trình khuyến mãi. APK qua 21 kiểm tra Android. Web/health trả 200, API ERP cũ giữ xác thực.

## Phạm vi bản vá

Chỉ bổ sung bốn file JavaScript của `price-catalog.config/controller/guard/service` và đăng ký chúng trong `catalog.module.js`. Đã đối chiếu hash: **337 file API còn lại giống hệt production trước đó**. Image web được gắn tag mới từ đúng digest cũ, không build lại giao diện. Mã phiếu trả hàng/hàng mẫu của đợt hồi quy hiện tại không nằm trong image bản vá.

Context build được tách tại `D:\INOXPRAN_PRICE_APP\erp-releases\20261112-103317-price-api`. Không chạy build ghi vào `apps/api/dist` của cây mã đang hồi quy, không commit/stash/reset các thay đổi đang làm của Claude.

## Khi Claude build staging/production tiếp theo

Giữ các file mã nguồn này trong bản build:

- `apps/api/src/modules/catalog/price-catalog.config.ts`
- `apps/api/src/modules/catalog/price-catalog.controller.ts`
- `apps/api/src/modules/catalog/price-catalog.guard.ts`
- `apps/api/src/modules/catalog/price-catalog.service.ts`
- `apps/api/src/modules/catalog/price-catalog.test.ts`
- Đăng ký controller/guard/service trong `apps/api/src/modules/catalog/catalog.module.ts`.

`PriceListService` và `brand-logo.ts` đã có trong image production nền nhưng hiện vẫn là file chưa được Git theo dõi trong cây mã. Cần giữ đầy đủ các phụ thuộc hiện có của bảng giá khi chuẩn bị commit/build từ Git.

`price-catalog.config.ts` chỉ chứa SHA-256 của khóa đọc trong APK, không chứa khóa gốc. Guard dùng dấu vân tay này nên không cần thay đổi file vận hành hoặc biến môi trường chung. `PRICE_CATALOG_ACCESS_KEY` là tùy chọn ghi đè khi cần xoay khóa có chủ đích; không tự đổi fingerprint trong khi nhân viên vẫn dùng APK hiện tại.

## Kiểm tra

```powershell
npm.cmd test -w @inoxpran/api -- price-catalog.test.ts
```

8 kiểm tra khóa đọc, GET-only, cấu trúc dữ liệu và giới hạn ảnh sản phẩm đã đạt. Chạy thử image mới trên máy chủ đã đọc được 101 sản phẩm, ảnh đại diện hợp lệ, không có khóa/sai khóa trả 401, API `/price-list` cũ vẫn yêu cầu đăng nhập ERP.

Lịch triển khai này chỉ dành cho production. Đợt hồi quy và phát hành staging của Claude tiếp tục theo quy trình hiện tại. Trước khi đưa bản ERP tiếp theo lên production, kiểm tra rằng các API `/api/v1/price-catalog/*` vẫn được giữ lại.

Biên bản, hash, image nền, kết quả chạy thử và rollback nằm trong `D:\INOXPRAN_PRICE_APP\erp-releases\20261112-103317-price-api`.
