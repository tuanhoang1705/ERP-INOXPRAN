# INOXPRAN ERP

Nền tảng ERP nội bộ/PWA cho luồng mua hàng → tồn kho → bán B2B → công nợ → thu tiền. Đồ án đại học chỉ được dùng làm nguồn tham khảo nghiệp vụ và ngôn ngữ giao diện; mã nguồn này được xây mới cho INOXPRAN.

## Phạm vi hiện đã triển khai

- Đăng nhập cookie HttpOnly, TOTP MFA, khóa tạm sau đăng nhập sai, CSRF, rate limit, RBAC và phạm vi kho.
- Danh mục sản phẩm/nhiều đơn vị tính, khách hàng–nhà cung cấp và nhiều kho; thêm / sửa / xóa trên giao diện theo vai trò (Giám đốc và tài khoản kho quản lý sản phẩm, nhóm hàng, kho, vị trí lưu, nhà cung cấp; kinh doanh quản lý khách; hạn mức công nợ chỉ Giám đốc / kế toán đổi). Bản ghi đã phát sinh chứng từ chỉ chuyển "Ngừng sử dụng", không xóa; bảng quyền dùng chung API và giao diện tại `packages/contracts/src/shared/catalog-access.ts`.
- Mọi danh sách lớn phân trang phía máy chủ (`?page=&pageSize=` → `{ rows, total, page, pageSize }`; không truyền `page` thì trả mảng như cũ cho ô chọn trong form), tìm kiếm / lọc chạy trên máy chủ.
- Đơn mua, ngưỡng duyệt, nhận hàng từng phần và sổ nhập kho.
- Sổ kho bất biến, projection tồn thực/giữ chỗ/khả dụng, điều chỉnh kho và chặn tồn âm.
- Điều chuyển kho nguyên tử, ghi hai movement đối ứng và rollback toàn bộ nếu một vế lỗi.
- Giá/chiết khấu theo cấu hình, duyệt ngoại lệ, reservation nguyên tử, xuất kho và sinh công nợ.
- Luồng "Phiếu xuất kho bán hàng" theo chứng từ thật: kế toán lập/phát hành phiếu `BH` → kinh doanh đối chiếu với khách (xác nhận hoặc trả về sửa, tự nhả hàng giữ) → kho lập phiếu `SWK`, xuất hàng → giao. Mẫu chứng từ `PXK-001` (một thuế suất cho cả phiếu; danh mục mẫu tại `packages/contracts/src/shared/sales-templates.ts`). Hàng tặng giá 0; thuế suất chọn theo phiếu (3% · 5% · 8% · 10% · KCT), giá niêm yết đã gồm thuế quy về đơn giá chưa thuế; form tính tiền tức thời bằng cùng hàm máy chủ dùng khi lưu (`packages/contracts/src/shared/sales-math.ts`); số tiền bằng chữ, mẫu in A4 đúng phiếu giấy (`/print/sales-issue/:id?type=BH|SWK`).
- Đối chiếu với khách bắt buộc đính kèm ảnh chụp màn hình (dán Ctrl+V; kiểm tra chữ ký file, lưu SHA-256, người tải, thời điểm). Mọi file được quét mã độc bằng ClamAV trước khi lưu (có mã độc → chặn, ghi audit, cảnh báo quản trị; ClamAV không phản hồi → từ chối nhận file), production thêm lớp GuardDuty Malware Protection for S3. Ảnh lưu trên Amazon S3 (khóa `sales-evidence/<phiếu>/<ảnh>`), API đọc hộ sau khi kiểm tra quyền xem phiếu; ảnh tải lên mà không dùng được worker xóa cả file lẫn bản ghi sau 24 giờ. Mỗi phiếu chọn thủ kho tiếp nhận; nhân viên thủ kho chỉ thấy phiếu của mình, quản lý kho xem toàn bộ; chỉ thủ kho được giao lập SWK / xác nhận giao (kiểm tra ở máy chủ). Đăng nhập chọn nơi làm việc: văn phòng hoặc kho.
- Thu nhiều lần, phân bổ thanh toán, tuổi nợ và dashboard điều hành.
- Bảo hành – sửa chữa – dịch vụ: phiếu theo mẫu giấy song ngữ Việt – Trung, bảo hành 12 tháng từ ngày hóa đơn (bắt buộc hóa đơn), hẹn trả 7 ngày tô vàng khi qua 70% thời gian hẹn và đỏ khi quá hẹn, nhắc tự động, Giám đốc duyệt từ chối / đổi mới / hoàn tiền; giai đoạn 2: ảnh khi nhận / phiếu đã ký (S3 + ClamAV, dùng chung `EvidenceIntakeService` với ảnh đối chiếu), danh mục mã lỗi theo nhóm hàng, đổi mới / hoàn tiền tự xuất hàng mới và nhập hàng lỗi vào kho hàng lỗi, phí sửa ngoài bảo hành sinh công nợ, báo cáo bảo hành ([warranty-design.md](docs/warranty-design.md)).
- Transactional outbox, BullMQ worker, thông báo trong ứng dụng và điều hướng đến chứng từ cần duyệt.
- Audit trail, correlation ID, optimistic concurrency và `Idempotency-Key` cho lệnh quan trọng.
- Giá theo cấp (Net NPP / đại lý / bán lẻ), chiết khấu bậc doanh số lũy kế, khuyến mãi theo nhóm hàng, trần chiết khấu và báo giá tức thời trên form đơn hàng (Giải thuật 1, 2 của đồ án).
- Rà soát công nợ quá hạn 06:00 hằng ngày, phân 3 mức cảnh báo, tự khóa/mở khóa đặt hàng đại lý nợ >60 ngày (Giải thuật 3).
- Báo cáo doanh số theo đại lý & khu vực có bộ lọc, in/PDF và xuất Excel; tuổi nợ theo đại lý; thẻ kho.
- Danh mục sản phẩm, hồ sơ đại lý, khu vực & nhân viên kinh doanh, bảng giá, khuyến mãi, người dùng (chế độ xem).
- Svelte PWA responsive theo đúng bản thiết kế Figma của đồ án (Inter, navy #123B5E, cam #E2703A); API OpenAPI tại `/api/docs`.
- Giao diện song ngữ Tiếng Việt / 简体中文 (Paraglide JS): chọn ở màn đăng nhập hoặc thanh trên cùng, lần đầu theo ngôn ngữ trình duyệt. Chứng từ in luôn bằng tiếng Việt; dữ liệu nghiệp vụ (tên hàng, khách, nhóm hàng) giữ nguyên. Xem [architecture.md](docs/architecture.md#đa-ngôn-ngữ).
- Docker local, container production, CI và baseline Terraform cho AWS Singapore.

Chưa được xem là đã nghiệm thu production: tích hợp MISA/hóa đơn điện tử, đổi/trả hàng, kiểm kê, email/SMS, quản trị người dùng trên giao diện, import dữ liệu thật, kế toán tổng hợp, load/security test độc lập và diễn tập backup. Xem [production-readiness.md](docs/production-readiness.md).

## Kiến trúc

```text
Svelte 5 PWA / Nginx :8080
             │ /api/v1
             ▼
NestJS + Fastify :3000 ── MongoDB Atlas replica set
             ├─────────── Redis/BullMQ worker + transactional outbox
             ├─────────── ClamAV (quét mã độc file tải lên, chạy kèm trong task)
             ├─────────── S3 (ảnh bằng chứng đối chiếu; GuardDuty Malware Protection; dev: S3Mock)
             ├─────────── SES (email, giai đoạn kế tiếp)
             └─────────── MISA AMIS adapter (giai đoạn 2)
```

API là modular monolith để giữ transaction nghiệp vụ đơn giản ở quy mô dưới 50 người dùng. Chứng từ đã post không sửa/xóa; thay đổi phải qua điều chỉnh hoặc đảo giao dịch.

## Chạy local

Yêu cầu: Node.js 24, npm và Docker Desktop.

```powershell
Copy-Item .env.example .env
# Thay JWT_SECRET, MFA_ENCRYPTION_KEY và mật khẩu admin trong .env
npm.cmd install
docker compose up -d   # MongoDB, Redis, Mailpit, S3Mock (S3 giả lập, cổng 9090), ClamAV (quét mã độc, cổng 3310, ~1,5 GB RAM)
npm.cmd run seed:admin
npm.cmd run seed:demo   # dữ liệu demo INOXPRAN, tự chặn khi NODE_ENV=production
# npm.cmd run seed:demo:reset  # xóa dữ liệu nghiệp vụ (dev) rồi tạo lại dữ liệu demo sạch
npm.cmd run dev:api
npm.cmd run dev:worker
npm.cmd run dev:web
```

- Web: `http://localhost:5173`
- API: `http://localhost:3000/api/v1`
- OpenAPI: `http://localhost:3000/api/docs`
- Mailpit: `http://localhost:8025`

Dữ liệu demo dùng 101 mã hàng và 3 mức giá từ bảng báo giá INOXPRAN 29/09/2026, kho Sơn Đồng; đại lý và giao dịch là giả định. Quy tắc và kịch bản trình diễn: [demo-business-rules.md](docs/demo-business-rules.md).

Tài khoản demo (MFA tắt, mật khẩu chung lấy từ `DEMO_USER_PASSWORD` trong `.env`): `giamdoc@`, `truongkd@`, `kinhdoanh@`, `kho@`, `kho2@`, `ketoan@`, `baohanh@`, `baohanh2@inoxpran.vn` (nhân viên bảo hành).

Lệnh seed admin in TOTP secret đúng một lần ra terminal; lưu vào password manager và thêm vào ứng dụng xác thực. Không commit `.env`.

## Kiểm chứng

```powershell
npm.cmd run check
npm.cmd test
npm.cmd run build
npm.cmd run smoke:api  # cần Docker, seed và API đang chạy
npm.cmd run smoke:worker  # cần Redis, API và worker đang chạy
```

Smoke API thực hiện: MFA login → bán/giữ/xuất → công nợ/thu tiền → mua/nhập → chuyển kho → dashboard; đồng thời kiểm tra replay, xung đột khóa idempotency và rollback transaction. Smoke worker kiểm tra outbox → BullMQ → thông báo → đánh dấu đã đọc.

## Triển khai

- Docker images: [Dockerfile.api](Dockerfile.api), [Dockerfile.web](Dockerfile.web).
- Reverse proxy/security headers: [default.conf](infra/nginx/default.conf).
- **Staging** (~26 USD/tháng, 24/7, dữ liệu mẫu): một máy EC2 t3a.small chạy Docker Compose, hướng dẫn trong [infra/staging](infra/staging/README.md). Lệnh: `.\infra\tf.ps1 check|plan|apply -Stack staging`, `.\infra\deploy.ps1 -Environment staging`.
- **Production** (~24 USD/tháng, dữ liệu thật, `https://erp.inoxpran.com`): cùng module, MongoDB bật xác thực, sao lưu mỗi giờ lên S3, cảnh báo email, ngân sách cả account 55 USD/tháng. Phát hành đúng image đã chạy trên staging: `.\infra\deploy.ps1 -Environment production -ConfirmProduction -Tag <tag staging>`. Hướng dẫn trong [infra/production](infra/production/README.md).
- Khi cần mở rộng: phương án ECS Fargate + ALB trong [infra/terraform](infra/terraform) (`.\infra\tf.ps1 <lệnh> -Stack ecs`). Trước khi apply: MongoDB Atlas M10+ cùng vùng `AWS / ap-southeast-1` có PITR, chứng thư ACM, JSON secret runtime trong AWS Secrets Manager.
- Pipeline kiểm tra: [.github/workflows/ci.yml](.github/workflows/ci.yml).

Không dùng database local cho staging/production.

## Cấu trúc

```text
apps/api              NestJS REST API và script vận hành
apps/web              SvelteKit PWA
packages/contracts    Zod schema và type dùng chung
infra/modules/ec2-app Module một máy EC2 + Docker Compose (Caddy, ClamAV, Redis, MongoDB), S3, SSM, cảnh báo
infra/production      Production (module ec2-app)
infra/staging         Staging (module ec2-app)
infra/terraform       Phương án production: ECS Fargate, ALB, Redis, S3, logs, alarms
docs                   Kiến trúc, UAT, migration và readiness
```

Mọi thay đổi nghiệp vụ quan trọng nên đi kèm test engine thuần, integration test transaction và một kịch bản UAT có chủ nghiệp vụ ký xác nhận.

Để chuẩn bị workshop, điền [phiếu chốt quy tắc nghiệp vụ](docs/business-rules-questionnaire.md) và đính kèm các file mẫu được liệt kê ở cuối tài liệu.

Để trình diễn trước khi có dữ liệu thật, dùng [bộ quy tắc DEMO](docs/demo-business-rules.md), [hướng dẫn bàn giao theo phòng ban](docs/department-data-guide.md) và workbook mẫu trong `outputs/erp-demo-2026-10-01/`.
