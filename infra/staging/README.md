# Staging (~26 USD/tháng, chạy 24/7)

> Từ 06/10/2026 có hai môi trường trong cùng account AWS: **staging** (file này — phát triển, thử nghiệm, demo bằng dữ liệu mẫu) và **production** ([infra/production](../production/README.md), dữ liệu thật). Bản mới deploy staging trước, kiểm thử / demo xong mới phát hành **đúng image đó** lên production (`deploy.ps1 -Environment production -ConfirmProduction -Tag <tag staging>`). Tổng chi phí AWS ~50 USD/tháng, cảnh báo ngân sách 55 USD.
>
> Staging đặt `protect_data = false`, `allow_destroy = true`: khi không cần nữa có thể gỡ hẳn bằng `.\infra\tf.ps1 plan -Stack staging -Destroy -Profile inoxpran-admin` → đọc kỹ → `apply` (snapshot do DLM tạo xóa riêng: EC2 → Snapshots, tag `Backup = inoxpran-erp-staging`).

Môi trường staging cho khoảng 10 người dùng nội bộ: **một máy EC2** chạy toàn bộ ứng dụng và MongoDB bằng Docker Compose, dữ liệu MongoDB trên **ổ EBS riêng** (AWS chụp snapshot hằng ngày), ảnh bằng chứng đối chiếu trên **S3**. Không dùng ALB, NAT Gateway, ECS, ElastiCache hay MongoDB Atlas. Phương án ECS Fargate (`infra/terraform`) giữ lại cho production khi cần mở rộng.

```text
Người dùng ──HTTPS──▶ Elastic IP ──▶ EC2 t3a.small (Amazon Linux 2023, Docker Compose)
                                       ├─ Caddy :443  (Let's Encrypt tự động, HTTP → HTTPS)
                                       ├─ web (nginx) ─▶ api :3000 ─┬─ MongoDB 8.0 (replica set 1 node) ─▶ /data (EBS 10 GB)
                                       ├─ worker (BullMQ)           ├─ ClamAV (quét file tải lên)
                                       │                            └─ Redis (hàng đợi, AOF)
                                       └─ quyền IAM của máy: ECR (kéo image), SSM (cấu hình), S3 (ảnh)
Snapshot ổ /data hằng ngày 02:00, giữ 7 bản (Amazon Data Lifecycle Manager)
```

## Chi phí

Giá on-demand Singapore lấy từ AWS Pricing API ngày 03/10/2026.

| Hạng mục | Chạy 24/7 (đang dùng) | Theo giờ làm việc |
| --- | --- | --- |
| EC2 t3a.small (0,0236 USD/giờ) | 17,23 | 7,98 (338 giờ: 07:00–20:00, thứ 2–7) |
| Ổ hệ điều hành gp3 20 GB + ổ dữ liệu gp3 10 GB (0,096 USD/GB-tháng) | 2,88 | 2,88 |
| IP công khai IPv4 (0,005 USD/giờ, tính cả khi máy tắt) | 3,65 | 3,65 |
| Snapshot dữ liệu (0,05 USD/GB-tháng, chỉ tính phần thay đổi; dữ liệu demo ~10 MB) | < 0,1 | < 0,1 |
| S3, ECR, cảnh báo CloudWatch, SNS, SSM | ~0,5 | ~0,5 |
| **Tổng** | **~24 USD** | **~15 USD** |

Đổi chế độ: `office_hours_only` trong `staging.tfvars` (giờ bật/tắt: `start_schedule` / `stop_schedule`).

## Đánh đổi

- Một máy, không dự phòng: máy lỗi thì staging dừng đến khi AWS tự phục hồi (EC2 auto recovery) hoặc thay máy. Dữ liệu nằm trên ổ riêng nên thay máy không mất dữ liệu.
- Sao lưu: `mongodump` mỗi giờ lên S3 (`backups/hourly` 7 ngày, `daily` 35 ngày, `monthly` 12 tháng) cộng snapshot EBS hằng ngày — mất tối đa 1 giờ dữ liệu khi phải khôi phục. Diễn tập khôi phục: `.\infra\deploy.ps1 -Profile inoxpran-admin -SkipBuild -RestoreDrill`.
- MongoDB chỉ nghe trong mạng nội bộ Docker (không mở cổng) và bật xác thực (keyFile; tài khoản `root` và `erpapp` — mật khẩu tự sinh trong SSM, `server/mongo-init.js` tạo / đồng bộ mỗi lần khởi động), giống production.
- 2 GB RAM cho ClamAV (~950 MB), MongoDB (~150 MB, bộ đệm giới hạn 256 MB), API, worker: chạy thử dùng ~1,3 GB, còn 2 GB swap dự phòng. Nếu chậm: `instance_type = "t3a.medium"` (+17 USD/tháng khi chạy 24/7); đổi loại máy giữ nguyên dữ liệu.
- Hạ tầng dùng chung module `infra/modules/ec2-app` với production (`infra/production/README.md`). File vận hành `server/*` nằm trên S3 (`ops/server/`): sửa xong chạy `apply` rồi `deploy.ps1 -SkipBuild`, không thay máy. Sửa `user-data.sh.tftpl` thì `apply` thay máy mới (vài phút gián đoạn; ổ dữ liệu được tháo khỏi máy cũ sau khi tắt máy sạch sẽ, rồi gắn vào máy mới).

## Triển khai lần đầu

Tất cả lệnh chạy qua Docker, không cần cài Terraform hay AWS CLI.

1. **Đăng nhập AWS** (hồ sơ có quyền ghi, cấu hình trong `%USERPROFILE%\.aws\config`):
   ```powershell
   docker run --rm -it -v "$env:USERPROFILE\.aws:/root/.aws" amazon/aws-cli:2.27.0 sso login --profile inoxpran-admin --no-browser --use-device-code
   ```
2. **Biến môi trường**: sao chép `staging.tfvars.example` → `staging.tfvars`, điền tên miền, email cảnh báo, `enforce_mfa`.
3. **Bucket lưu Terraform state** (một lần): `.\infra\tf.ps1 bootstrap -Profile inoxpran-admin`
4. **Xem trước và áp dụng**:
   ```powershell
   .\infra\tf.ps1 plan -Profile inoxpran-readonly    # người duyệt xem staging.tfplan
   .\infra\tf.ps1 apply -Profile inoxpran-admin      # áp dụng đúng bản plan đã duyệt
   ```
   Kết quả in ra `public_ip`. Lần đầu dịch vụ ứng dụng trên máy báo lỗi "ParameterNotFound" cho tới bước 6 — bình thường.
5. **DNS (Cloudflare)**: thêm bản ghi `A` `erp-staging` → `public_ip`, **Proxy status: DNS only** (mây xám) để Caddy tự xin chứng thư.
6. **Đưa ứng dụng lên**: `.\infra\deploy.ps1 -Profile inoxpran-admin` — build, đẩy image, tự sinh khóa JWT/MFA vào SSM Parameter Store, khởi động ứng dụng.
7. **Dữ liệu**, chọn một trong hai:
   - Dữ liệu trình diễn như máy dev: `.\infra\deploy.ps1 -Profile inoxpran-admin -SkipBuild -SeedDemo`. Mật khẩu chung của tài khoản demo tự sinh, xem bằng `-SkipBuild -ShowDemoPassword` hoặc AWS Console → Systems Manager → Parameter Store → `/inoxpran-erp/staging/DEMO_USER_PASSWORD` → Show decrypted value. Tài khoản demo không có MFA, nên đặt `enforce_mfa = false`.
   - Dữ liệu trắng: `.\infra\deploy.ps1 -Profile inoxpran-admin -SkipBuild -SeedAdmin it@inoxpran.com` tạo tài khoản quản trị có MFA, in mật khẩu và mã TOTP một lần (giữ `enforce_mfa = true` như production).
8. Xác nhận email đăng ký cảnh báo SNS gửi tới `alert_email`.

## Vận hành

- **Phiên bản mới**: `.\infra\deploy.ps1 -Profile inoxpran-admin` (build, đẩy ECR, khởi động lại container đã đổi). Máy đang tắt thì script bật máy, phiên bản mới chạy khi khởi động.
- **Xem log / vào máy**: AWS Console → EC2 → `inoxpran-erp-staging` → Connect → Session Manager, rồi `cd /opt/inoxpran && sudo docker compose logs -f api`.
- **Khôi phục dữ liệu từ snapshot**: EC2 → Snapshots (tag `Backup = inoxpran-erp-staging`) → Create volume (cùng AZ) → trong Terraform thay ổ `aws_ebs_volume.data` bằng ổ mới (`terraform import`) hoặc nhờ người phụ trách hạ tầng; làm trên bản sao trước khi đụng ổ đang chạy.
- **Bật máy ngoài giờ** (khi `office_hours_only = true`): AWS Console → EC2 → Start (máy tự tắt lại theo lịch).
