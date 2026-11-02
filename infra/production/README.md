# Production (~25 USD/tháng)

Production chạy trên **một máy EC2 t3a.small (2 GB RAM + 2 GB swap)** với Docker Compose (Caddy HTTPS, web, API, worker, MongoDB, Redis, ClamAV), đủ cho ~10 người dùng. Cấu hình dùng module `infra/modules/ec2-app`, account AWS 627367419586.

Staging ([infra/staging](../staging/README.md), 24/7, ~26 USD/tháng) dùng để thử nghiệm và demo. Bản mới deploy staging trước; production chỉ nhận **đúng image đã chạy trên staging** (không build lại). Tổng chi phí AWS ~50 USD/tháng.

| Hạng mục | Production |
| --- | --- |
| Máy | t3a.small, CPU chế độ `standard` (không tính phí vượt mức), **chặn xóa máy** (`disable_api_termination`) |
| Tên miền | erp.inoxpran.com |
| MFA tài khoản đặc quyền | **bắt buộc** (Quản trị, Giám đốc, Kế toán) |
| Dữ liệu | thật; nạp dữ liệu demo **bị chặn** |
| MongoDB | bật xác thực (keyFile; tài khoản `root` và `erpapp` chỉ đọc/ghi CSDL `inoxpran_erp`) |
| Sao lưu | mỗi giờ bằng `mongodump` lên S3 (`backups/hourly` giữ 7 ngày, `daily` 35 ngày, `monthly` 12 tháng) + snapshot ổ dữ liệu hằng ngày giữ 7 bản; ổ dữ liệu có `prevent_destroy` |
| Cảnh báo email | máy lỗi, ứng dụng không khỏe 10 phút, 3 giờ không có bản sao lưu, RAM > 90%, đĩa `/` > 85% hoặc `/data` > 80% (SNS) |
| Ngân sách | AWS Budgets 55 USD/tháng cho **cả account** (production + staging): email khi chi phí thực vượt, hoặc dự báo cuối tháng vượt |
| Image | kho ECR riêng `inoxpran-erp-production-api/web` (nhận image từ staging), giữ 5 bản gần nhất để quay lại |

## Chi phí ước tính production (giá on-demand Singapore)

| Hạng mục | USD/tháng |
| --- | --- |
| EC2 t3a.small 24/7 (0,0236 USD/giờ) | ~17,2 |
| Ổ gp3 16 GB hệ điều hành + 10 GB dữ liệu (0,096 USD/GB) | ~2,5 |
| IPv4 công khai | 3,65 |
| Snapshot EBS (7 bản, chỉ tính phần thay đổi) | < 0,3 |
| S3 (ảnh chứng từ + sao lưu nén) | < 0,5 |
| ECR (5 bản image) | < 0,2 |
| CloudWatch: 9 metric + 6 cảnh báo (cả account có 2 môi trường nên vượt hạn mức miễn phí 10 metric / 10 cảnh báo, ~2,6 USD tính chung) | ~1,3 |
| CloudWatch Logs (D7, 22/10/2026): log ứng dụng ~0,1–0,3 GB/tháng × 0,57 USD/GB nhập + lưu 30 ngày; thêm 1 metric + 1 cảnh báo lỗi | < 0,6 |
| AWS Budgets, SNS email, SSM Parameter Store, DLM | 0 |
| **Tổng production** | **~25** |

Cộng staging 24/7 (~26 USD) → cả account **~50 USD/tháng**.

Chưa gồm thuế (nếu AWS tính); ngân sách tính theo hóa đơn thực, có thuế. Muốn giảm:
- **Savings Plan 1 năm** cho máy (cam kết theo giờ, không trả trước): EC2 còn ~11–12 USD → tổng ~18 USD. Cam kết 1 năm, quyết định của công ty.
- **Tắt máy ngoài giờ** (`office_hours_only = true`, 07:00–20:00 thứ 2–7): EC2 còn ~8 USD; ngoài giờ không truy cập được, sao lưu chỉ chạy khi máy bật.
- Nhiều người dùng hơn (> 15–20) hoặc RAM thường xuyên > 90%: nâng t3a.medium (4 GB, ~+17 USD/tháng).

## Khởi tạo lần đầu

1. Sao chép `production.tfvars.example` → `production.tfvars` (bị `.gitignore` chặn), điền `domain_name` và `alert_email`.
2. `.\infra\tf.ps1 plan -Stack production -Profile inoxpran-admin` → người duyệt xem → `.\infra\tf.ps1 apply -Stack production -Profile inoxpran-admin`.
3. Cloudflare: tạo bản ghi **A** `erp` → `public_ip` (output), chế độ **DNS only** (mây xám) để Caddy tự lấy chứng thư Let's Encrypt.
4. Xác nhận email đăng ký cảnh báo SNS (AWS gửi thư "Subscription Confirmation"). Email ngân sách do AWS Budgets gửi thẳng, không cần xác nhận.
5. Phát hành image đang chạy trên staging (xem SSM `/inoxpran-erp/staging/IMAGE_TAG`):
   ```powershell
   .\infra\deploy.ps1 -Profile inoxpran-admin -Environment production -ConfirmProduction -Tag <tag staging>
   ```
   Lần đầu script tự sinh bí mật (JWT, khóa MFA, mật khẩu MongoDB, keyFile) vào SSM `/inoxpran-erp/production/*`. Không ai cần biết các bí mật này.
6. Tạo tài khoản quản trị gốc (root), có MFA:
   ```powershell
   .\infra\deploy.ps1 -Profile inoxpran-admin -Environment production -ConfirmProduction -SkipBuild -SeedAdmin it@inoxpran.com
   ```
   Mật khẩu và mã thiết lập MFA in **một lần** trên màn hình người chạy. Quét mã bằng Google / Microsoft Authenticator, đăng nhập, rồi đổi mật khẩu tại *Tài khoản của tôi*.
7. Root tạo tài khoản cho từng người ở *Tổng quan › Người dùng & phân quyền*. Hệ thống sinh mật khẩu tạm; người dùng bắt buộc đổi mật khẩu ở lần đăng nhập đầu, và bật MFA nếu có vai trò Quản trị / Giám đốc / Kế toán.

## Vận hành

- **Phát hành bản mới:** kiểm thử trên máy → `deploy.ps1 -Environment staging` → kiểm thử / demo trên staging → `deploy.ps1 -Environment production -ConfirmProduction -Tag <tag staging>` (bước 5). Nên phát hành ngoài giờ làm việc và sao lưu ngay trước (`-BackupNow`); API khởi động lại mất ~1 phút.
- **Quay lại bản trước:** `deploy.ps1 -Environment production -ConfirmProduction -SkipBuild -Tag <tag cũ>` (xem tag trong ECR, giữ 5 bản).
- **Sửa file máy chủ** (`infra/modules/ec2-app/server/*`):
  - chạy `tf.ps1 plan / apply -Stack production` để cập nhật bản trên S3 (không thay máy);
  - sau đó chạy `deploy.ps1 -Environment production -ConfirmProduction -SkipBuild` để máy đồng bộ.
- **Giám sát:** màn *Giám sát hệ thống* (trạng thái MongoDB, Redis, worker, ClamAV, S3, sao lưu, lỗi 5xx, đăng nhập) và email cảnh báo.
- **Log máy chủ (D7, 22/10/2026):** api / worker / web / caddy ghi lên CloudWatch Logs nhóm `/inoxpran-erp/production/app`, giữ 30 ngày, mỗi container một luồng (`inoxpran-api-1`, …) — không mất khi cập nhật phiên bản.
  - Xem: AWS Console → CloudWatch → Log groups → `/inoxpran-erp/production/app`, hoặc **Logs Insights**, ví dụ lỗi 24 giờ qua: `fields @timestamp, msg, err.message | filter level >= 50 | sort @timestamp desc`; yêu cầu chậm: `filter msg = "request completed" and responseTime > 1000`.
  - Từ 5 dòng lỗi máy chủ trong 10 phút → email cảnh báo (`inoxpran-erp-production-app-errors`).
  - `docker compose logs` trên máy vẫn dùng được (Docker giữ bản sao cục bộ).
- **Sao lưu ngay:** `deploy.ps1 -Environment production -ConfirmProduction -SkipBuild -BackupNow`.
- **Diễn tập khôi phục:** `deploy.ps1 -Environment production -ConfirmProduction -SkipBuild -RestoreDrill`. Script tải bản mới nhất, khôi phục vào MongoDB tạm, so số bản ghi từng bảng với dữ liệu đang chạy. Nên chạy hằng tháng và ghi kết quả vào `docs/production-readiness.md`.
- **RPO / RTO:**
  - RPO 1 giờ (sao lưu mỗi giờ); nếu ổ dữ liệu còn nguyên, khôi phục từ snapshot EBS.
  - RTO khoảng 1–2 giờ: dựng máy bằng Terraform (ổ dữ liệu giữ nguyên) hoặc khôi phục `mongorestore` từ S3.
- **Thay máy:**
  - tắt `termination_protection` trong `infra/production/main.tf` → plan / apply → bật lại;
  - ổ dữ liệu được tháo khỏi máy cũ sau khi tắt máy sạch sẽ, rồi gắn vào máy mới.

## Rủi ro khi dùng chung account với staging

- Người có quyền quản trị account chạm được cả production: mọi tài nguyên có tag `Environment`, tên `inoxpran-erp-production-*`, tham số SSM `/inoxpran-erp/production/*`; nên tạo permission set riêng chặn theo tag và hạ AdministratorAccess sau giai đoạn triển khai.
- Staging và production khác máy, khác VPC, khác bucket, khác CSDL: nạp lại dữ liệu demo hay lỗi trên staging không ảnh hưởng production.
