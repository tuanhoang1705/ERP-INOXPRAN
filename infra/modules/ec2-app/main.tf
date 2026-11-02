# Một môi trường INOXPRAN ERP (staging / production) trên một máy EC2 chạy Docker Compose
# (Caddy HTTPS + web + API + worker + MongoDB + Redis + ClamAV), dữ liệu MongoDB trên ổ EBS riêng, ảnh chứng từ trên S3.
# Không dùng ALB, NAT Gateway, ECS, ElastiCache, Atlas. Chi phí: infra/staging/README.md, infra/production/README.md.

data "aws_caller_identity" "current" {}

# Chọn AZ có bán loại máy đã chọn (không phải AZ nào ở Singapore cũng có mọi loại).
data "aws_ec2_instance_type_offerings" "app" {
  location_type = "availability-zone"
  filter {
    name   = "instance-type"
    values = [var.instance_type]
  }
}

data "aws_ssm_parameter" "al2023" {
  name = "/aws/service/ami-amazon-linux-latest/al2023-ami-kernel-default-x86_64"
}

locals {
  name         = "${var.project}-${var.environment}"
  title        = title(var.environment)
  az           = sort(data.aws_ec2_instance_type_offerings.app.locations)[0]
  param_prefix = "/${var.project}/${var.environment}"
  registry     = "${data.aws_caller_identity.current.account_id}.dkr.ecr.${var.aws_region}.amazonaws.com"
  # Image: mặc định mỗi môi trường có kho ECR riêng; create_ecr = false dùng kho có sẵn (shared_ecr_repositories).
  ecr_urls = var.create_ecr ? { for key, repo in aws_ecr_repository.app : key => repo.repository_url } : { for key, repo in data.aws_ecr_repository.shared : key => repo.repository_url }
  ecr_arns = var.create_ecr ? [for repo in aws_ecr_repository.app : repo.arn] : [for repo in data.aws_ecr_repository.shared : repo.arn]
}

# --- Mạng: một subnet công khai, không NAT Gateway ---

# Chấp nhận: không bật VPC Flow Logs (tốn phí CloudWatch); máy chỉ mở 80/443, truy cập quản trị qua SSM.
#trivy:ignore:AVD-AWS-0178
resource "aws_vpc" "main" {
  cidr_block           = var.vpc_cidr
  enable_dns_support   = true
  enable_dns_hostnames = true
  tags                 = { Name = local.name }
}

# Khóa security group mặc định của VPC (không quy tắc nào).
resource "aws_default_security_group" "default" {
  vpc_id = aws_vpc.main.id
}

resource "aws_internet_gateway" "main" {
  vpc_id = aws_vpc.main.id
  tags   = { Name = local.name }
}

resource "aws_subnet" "public" {
  vpc_id                  = aws_vpc.main.id
  cidr_block              = cidrsubnet(var.vpc_cidr, 8, 0)
  availability_zone       = local.az
  map_public_ip_on_launch = false
  tags                    = { Name = "${local.name}-public" }
}

resource "aws_route_table" "public" {
  vpc_id = aws_vpc.main.id
  route {
    cidr_block = "0.0.0.0/0"
    gateway_id = aws_internet_gateway.main.id
  }
  tags = { Name = "${local.name}-public" }
}

resource "aws_route_table_association" "public" {
  subnet_id      = aws_subnet.public.id
  route_table_id = aws_route_table.public.id
}

resource "aws_security_group" "app" {
  name        = local.name
  description = "${local.title} ERP: HTTP/HTTPS only, admin via SSM Session Manager"
  vpc_id      = aws_vpc.main.id
  # Chấp nhận: ERP truy cập từ văn phòng Paragon và kho Sơn Đồng qua Internet (HTTPS).
  #trivy:ignore:AVD-AWS-0107
  ingress {
    description = "HTTP for Lets Encrypt and redirect to HTTPS"
    from_port   = 80
    to_port     = 80
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
  }
  #trivy:ignore:AVD-AWS-0107
  ingress {
    description = "HTTPS"
    from_port   = 443
    to_port     = 443
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
  }
  # Chấp nhận: máy gọi MongoDB Atlas, S3, ECR, SSM, Let's Encrypt, Docker Hub, CDN cập nhật mẫu ClamAV —
  # dải IP công khai thay đổi theo nhà cung cấp, không liệt kê cố định được.
  #trivy:ignore:AVD-AWS-0104
  egress {
    description = "Outbound to Internet"
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }
}

# --- Kho image ---

resource "aws_ecr_repository" "app" {
  for_each             = var.create_ecr ? toset(["api", "web"]) : toset([])
  name                 = "${local.name}-${each.key}"
  image_tag_mutability = "IMMUTABLE"
  force_delete         = true
  image_scanning_configuration { scan_on_push = true }
  encryption_configuration { encryption_type = "AES256" }
}

resource "aws_ecr_lifecycle_policy" "app" {
  for_each   = aws_ecr_repository.app
  repository = each.value.name
  # Giữ 5 bản gần nhất để quay lại bản trước khi cần (mỗi bản ~0,3 GB, 0,10 USD/GB/tháng).
  policy = jsonencode({ rules = [
    { rulePriority = 1, description = "Giu 5 image gan nhat", selection = { tagStatus = "any", countType = "imageCountMoreThan", countNumber = 5 }, action = { type = "expire" } },
  ] })
}

data "aws_ecr_repository" "shared" {
  for_each = var.create_ecr ? {} : var.shared_ecr_repositories
  name     = each.value
}

# --- Ảnh bằng chứng đối chiếu (S3) ---

resource "aws_s3_bucket" "documents" {
  bucket = "${local.name}-${data.aws_caller_identity.current.account_id}-documents"
  # Chỉ bật khi gỡ bỏ cả môi trường (xóa luôn mọi phiên bản file trong bucket).
  force_destroy = var.allow_destroy
}

resource "aws_s3_bucket_public_access_block" "documents" {
  bucket                  = aws_s3_bucket.documents.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_versioning" "documents" {
  bucket = aws_s3_bucket.documents.id
  versioning_configuration { status = "Enabled" }
}

# Chấp nhận: SSE-S3 (AES256) đủ cho ảnh chứng từ nội bộ.
#trivy:ignore:AVD-AWS-0132
resource "aws_s3_bucket_server_side_encryption_configuration" "documents" {
  bucket = aws_s3_bucket.documents.id
  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
  }
}

resource "aws_s3_bucket_lifecycle_configuration" "documents" {
  bucket = aws_s3_bucket.documents.id
  rule {
    id     = "expire-old-versions"
    status = "Enabled"
    filter {}
    noncurrent_version_expiration { noncurrent_days = 30 }
  }
  # Ảnh tải lên mà không dùng (worker xóa sau 24 giờ): dọn hẳn phiên bản cũ sau 7 ngày.
  rule {
    id     = "purge-discarded-sales-evidence"
    status = "Enabled"
    filter { prefix = "sales-evidence/" }
    noncurrent_version_expiration { noncurrent_days = 7 }
    expiration { expired_object_delete_marker = true }
  }
  # Sao lưu MongoDB (server/backup.sh): mỗi giờ / mỗi ngày / mỗi tháng, bản cũ tự xóa.
  rule {
    id     = "expire-backups-hourly"
    status = "Enabled"
    filter { prefix = "backups/hourly/" }
    expiration { days = var.backup_hourly_days }
    noncurrent_version_expiration { noncurrent_days = 1 }
  }
  rule {
    id     = "expire-backups-daily"
    status = "Enabled"
    filter { prefix = "backups/daily/" }
    expiration { days = var.backup_daily_days }
    noncurrent_version_expiration { noncurrent_days = 1 }
  }
  rule {
    id     = "expire-backups-monthly"
    status = "Enabled"
    filter { prefix = "backups/monthly/" }
    expiration { days = var.backup_monthly_days }
    noncurrent_version_expiration { noncurrent_days = 1 }
  }
  rule {
    id     = "abort-incomplete-uploads"
    status = "Enabled"
    filter {}
    abort_incomplete_multipart_upload { days_after_initiation = 1 }
  }
}

resource "aws_s3_bucket_policy" "documents" {
  bucket = aws_s3_bucket.documents.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Sid       = "DenyInsecureTransport"
      Effect    = "Deny"
      Principal = "*"
      Action    = "s3:*"
      Resource  = [aws_s3_bucket.documents.arn, "${aws_s3_bucket.documents.arn}/*"]
      Condition = { Bool = { "aws:SecureTransport" = "false" } }
    }]
  })
  depends_on = [aws_s3_bucket_public_access_block.documents]
}

# --- File vận hành trên máy (compose, start.sh, sao lưu, kiểm tra sức khỏe, cấu hình CloudWatch agent) ---
# Máy đồng bộ ops/server/ mỗi lần khởi động / deploy (bootstrap.sh) → sửa file không phải thay máy.
resource "aws_s3_object" "server" {
  for_each = fileset("${path.module}/server", "*")
  bucket   = aws_s3_bucket.documents.id
  key      = "ops/server/${each.value}"
  source   = "${path.module}/server/${each.value}"
  etag     = filemd5("${path.module}/server/${each.value}")
}

# --- Cấu hình chạy (SSM Parameter Store, bậc Standard miễn phí) ---
# JWT_SECRET, MFA_ENCRYPTION_KEY, MONGO_* , DEMO_USER_PASSWORD (SecureString) do `infra/deploy.ps1` tự sinh và ghi trực tiếp,
# không đi qua Terraform nên không nằm trong state. Terraform chỉ tạo IMAGE_TAG; deploy.ps1 cập nhật giá trị.
resource "aws_ssm_parameter" "image_tag" {
  name  = "${local.param_prefix}/IMAGE_TAG"
  type  = "String"
  value = "none"
  lifecycle { ignore_changes = [value] }
}

# --- Quyền của máy chủ ---

resource "aws_iam_role" "app" {
  name               = local.name
  assume_role_policy = jsonencode({ Version = "2012-10-17", Statement = [{ Effect = "Allow", Principal = { Service = "ec2.amazonaws.com" }, Action = "sts:AssumeRole" }] })
}

# Quản trị qua SSM Session Manager / Run Command thay cho SSH (không mở cổng 22, không cần khóa SSH).
resource "aws_iam_role_policy_attachment" "ssm_core" {
  role       = aws_iam_role.app.name
  policy_arn = "arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore"
}

# CloudWatch agent (RAM, đĩa) và metric tự đẩy (AppHealthy, BackupSucceeded).
resource "aws_iam_role_policy_attachment" "cloudwatch_agent" {
  role       = aws_iam_role.app.name
  policy_arn = "arn:aws:iam::aws:policy/CloudWatchAgentServerPolicy"
}

resource "aws_iam_role_policy" "app" {
  role = aws_iam_role.app.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      { Effect = "Allow", Action = ["ecr:GetAuthorizationToken"], Resource = "*" },
      { Effect = "Allow", Action = ["ecr:BatchGetImage", "ecr:GetDownloadUrlForLayer", "ecr:BatchCheckLayerAvailability"], Resource = local.ecr_arns },
      { Effect = "Allow", Action = ["ssm:GetParameter", "ssm:GetParameters"], Resource = "arn:aws:ssm:${var.aws_region}:${data.aws_caller_identity.current.account_id}:parameter${local.param_prefix}/*" },
      { Effect = "Allow", Action = ["s3:GetObject", "s3:PutObject", "s3:AbortMultipartUpload"], Resource = "${aws_s3_bucket.documents.arn}/*" },
      # Kiểm tra bucket khi API khởi động (HeadBucket cần s3:ListBucket).
      { Effect = "Allow", Action = ["s3:ListBucket"], Resource = aws_s3_bucket.documents.arn },
      # Chỉ được xóa ảnh bằng chứng tải lên nhưng không dùng, ảnh bảo hành chụp nhầm (phiếu chưa trả) và file tab "Đính kèm"
      # của hồ sơ sản phẩm / đối tác / chứng từ mua; chứng từ khác không xóa được.
      { Effect = "Allow", Action = ["s3:DeleteObject"], Resource = ["${aws_s3_bucket.documents.arn}/sales-evidence/*", "${aws_s3_bucket.documents.arn}/warranty-photos/*", "${aws_s3_bucket.documents.arn}/product-files/*", "${aws_s3_bucket.documents.arn}/partner-files/*", "${aws_s3_bucket.documents.arn}/purchase-docs/*"] }
    ]
  })
}

resource "aws_iam_instance_profile" "app" {
  name = local.name
  role = aws_iam_role.app.name
}

# --- Máy chủ ---

resource "aws_instance" "app" {
  ami                         = data.aws_ssm_parameter.al2023.insecure_value
  instance_type               = var.instance_type
  subnet_id                   = aws_subnet.public.id
  vpc_security_group_ids      = [aws_security_group.app.id]
  iam_instance_profile        = aws_iam_instance_profile.app.name
  user_data_replace_on_change = true
  user_data = templatefile("${path.module}/user-data.sh.tftpl", {
    compose_version    = var.compose_version
    registry           = local.registry
    aws_region         = var.aws_region
    param_prefix       = local.param_prefix
    app_env            = var.environment
    mongo_cache_gb     = var.mongo_cache_gb
    api_heap_mb        = var.api_heap_mb
    site_domain        = var.domain_name
    acme_email         = var.alert_email
    enforce_mfa        = var.enforce_mfa
    data_volume_serial = replace(local.data_volume_id, "-", "")
    s3_bucket          = aws_s3_bucket.documents.id
    api_image          = local.ecr_urls["api"]
    web_image          = local.ecr_urls["web"]
  })

  # Không tính phí CPU vượt mức (chế độ unlimited mặc định của dòng T có thể phát sinh tiền).
  credit_specification { cpu_credits = "standard" }

  # Production: chặn xóa máy nhầm (muốn thay máy phải tắt bảo vệ trước).
  disable_api_termination = var.termination_protection

  # IMDSv2 bắt buộc; hop limit 2 để container (S3 SDK) lấy được quyền của máy qua mạng Docker.
  metadata_options {
    http_endpoint               = "enabled"
    http_tokens                 = "required"
    http_put_response_hop_limit = 2
  }

  root_block_device {
    volume_type = "gp3"
    volume_size = var.root_volume_gb
    encrypted   = true
  }

  tags = { Name = local.name }

  # AMI mới ra không tự thay máy; muốn cập nhật thì taint hoặc đổi user data.
  lifecycle { ignore_changes = [ami] }
  depends_on = [aws_internet_gateway.main, aws_ssm_parameter.image_tag, aws_s3_object.server]
}

# --- Dữ liệu MongoDB: ổ EBS riêng, giữ nguyên khi thay máy; snapshot hằng ngày ---

resource "aws_ebs_volume" "data" {
  count             = var.protect_data ? 1 : 0
  availability_zone = local.az
  size              = var.data_volume_gb
  type              = "gp3"
  encrypted         = true
  tags              = { Name = "${local.name}-data", Backup = local.name }
  # Ổ chứa toàn bộ dữ liệu MongoDB: Terraform từ chối xóa (thay máy vẫn giữ ổ).
  lifecycle { prevent_destroy = true }
}

# Môi trường dùng tạm (staging): cùng cấu hình nhưng gỡ được bằng terraform destroy (prevent_destroy không đặt theo biến được).
resource "aws_ebs_volume" "data_disposable" {
  count             = var.protect_data ? 0 : 1
  availability_zone = local.az
  size              = var.data_volume_gb
  type              = "gp3"
  encrypted         = true
  tags              = { Name = "${local.name}-data", Backup = local.name }
}

locals {
  data_volume_id = one(concat(aws_ebs_volume.data[*].id, aws_ebs_volume.data_disposable[*].id))
}

resource "aws_volume_attachment" "data" {
  device_name = "/dev/sdf"
  volume_id   = local.data_volume_id
  instance_id = aws_instance.app.id
  # Khi thay máy: tắt máy cũ trước (MongoDB đóng file sạch sẽ) rồi mới tháo ổ.
  stop_instance_before_detaching = true
}

resource "aws_iam_role" "dlm" {
  name               = "${local.name}-dlm"
  assume_role_policy = jsonencode({ Version = "2012-10-17", Statement = [{ Effect = "Allow", Principal = { Service = "dlm.amazonaws.com" }, Action = "sts:AssumeRole" }] })
}

resource "aws_iam_role_policy_attachment" "dlm" {
  role       = aws_iam_role.dlm.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSDataLifecycleManagerServiceRole"
}

resource "aws_dlm_lifecycle_policy" "data" {
  description        = "Daily snapshot of ${var.environment} MongoDB data volume"
  execution_role_arn = aws_iam_role.dlm.arn
  state              = "ENABLED"
  policy_details {
    resource_types = ["VOLUME"]
    target_tags    = { Backup = local.name }
    schedule {
      name      = "daily"
      copy_tags = true
      # 19:00 UTC = 02:00 giờ Việt Nam.
      create_rule {
        interval      = 24
        interval_unit = "HOURS"
        times         = ["19:00"]
      }
      retain_rule { count = var.snapshot_retention_days }
    }
  }
  depends_on = [aws_iam_role_policy_attachment.dlm]
}

# Địa chỉ IP cố định để trỏ tên miền (giữ nguyên khi máy tắt/bật hoặc được thay mới).
resource "aws_eip" "app" {
  domain     = "vpc"
  instance   = aws_instance.app.id
  tags       = { Name = local.name }
  depends_on = [aws_internet_gateway.main]
}

# --- Cảnh báo ---

# Chấp nhận: topic chỉ chứa cảnh báo vận hành, không có dữ liệu khách hàng.
#trivy:ignore:AVD-AWS-0095
resource "aws_sns_topic" "alerts" {
  name = "${local.name}-alerts"
}

# --- Log ứng dụng tập trung (D7, 22/10/2026) ---
# Docker đẩy log api / worker / web / caddy vào nhóm này (server/compose.yaml, driver awslogs) — không mất log khi cập nhật
# phiên bản, tra cứu bằng CloudWatch Logs Insights. Quyền ghi log có sẵn trong CloudWatchAgentServerPolicy của máy.
# Chấp nhận: mã hóa mặc định của CloudWatch Logs (không dùng KMS riêng — thêm phí, log không chứa mật khẩu / token).
#trivy:ignore:AVD-AWS-0017
resource "aws_cloudwatch_log_group" "app" {
  name              = "${local.param_prefix}/app"
  retention_in_days = var.log_retention_days
}

# Lỗi máy chủ: dòng log mức error trở lên (pino level ≥ 50) của API / worker.
resource "aws_cloudwatch_log_metric_filter" "app_errors" {
  name           = "${local.name}-app-errors"
  log_group_name = aws_cloudwatch_log_group.app.name
  pattern        = "{ $.level >= 50 }"
  metric_transformation {
    # Staging và production chung một account: tên số liệu tách theo môi trường (bộ lọc log không gắn dimension tĩnh được).
    name          = "AppErrors-${var.environment}"
    namespace     = "INOXPRAN"
    value         = "1"
    default_value = "0"
  }
}

resource "aws_cloudwatch_metric_alarm" "app_errors" {
  alarm_name          = "${local.name}-app-errors"
  alarm_description   = "May chu ghi tu 5 loi tro len trong 10 phut - xem log ${local.param_prefix}/app"
  namespace           = "INOXPRAN"
  metric_name         = aws_cloudwatch_log_metric_filter.app_errors.metric_transformation[0].name
  statistic           = "Sum"
  period              = 600
  evaluation_periods  = 1
  threshold           = 5
  comparison_operator = "GreaterThanOrEqualToThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = [aws_sns_topic.alerts.arn]
  ok_actions          = [aws_sns_topic.alerts.arn]
}

resource "aws_sns_topic_subscription" "email" {
  topic_arn = aws_sns_topic.alerts.arn
  protocol  = "email"
  endpoint  = var.alert_email
}

# Máy chủ lỗi phần cứng/hệ điều hành. Khi máy tắt theo lịch không có số liệu → không báo.
resource "aws_cloudwatch_metric_alarm" "status_check" {
  alarm_name          = "${local.name}-status-check"
  namespace           = "AWS/EC2"
  metric_name         = "StatusCheckFailed"
  statistic           = "Maximum"
  period              = 60
  evaluation_periods  = 3
  threshold           = 0
  comparison_operator = "GreaterThanThreshold"
  treat_missing_data  = "notBreaching"
  dimensions          = { InstanceId = aws_instance.app.id }
  alarm_actions       = [aws_sns_topic.alerts.arn]
}

locals {
  # Máy tắt theo giờ làm việc thì không có số liệu ngoài giờ → không coi là lỗi.
  missing_data = var.office_hours_only ? "notBreaching" : "breaching"
}

# Ứng dụng không khỏe (server/health.sh đẩy AppHealthy mỗi 5 phút); máy chết / mất số liệu cũng báo.
resource "aws_cloudwatch_metric_alarm" "app_unhealthy" {
  alarm_name          = "${local.name}-app-unhealthy"
  alarm_description   = "API / Caddy / worker khong chay on dinh 10 phut"
  namespace           = "INOXPRAN"
  metric_name         = "AppHealthy"
  dimensions          = { Environment = var.environment }
  statistic           = "Minimum"
  period              = 300
  evaluation_periods  = 2
  threshold           = 1
  comparison_operator = "LessThanThreshold"
  treat_missing_data  = local.missing_data
  alarm_actions       = [aws_sns_topic.alerts.arn]
  ok_actions          = [aws_sns_topic.alerts.arn]
}

# Sao lưu: 3 giờ liền không có bản thành công.
resource "aws_cloudwatch_metric_alarm" "backup_missing" {
  alarm_name          = "${local.name}-backup-missing"
  alarm_description   = "Khong co ban sao luu MongoDB thanh cong trong 3 gio"
  namespace           = "INOXPRAN"
  metric_name         = "BackupSucceeded"
  dimensions          = { Environment = var.environment }
  statistic           = "Maximum"
  period              = 3600
  evaluation_periods  = 3
  threshold           = 1
  comparison_operator = "LessThanThreshold"
  treat_missing_data  = local.missing_data
  alarm_actions       = [aws_sns_topic.alerts.arn]
  ok_actions          = [aws_sns_topic.alerts.arn]
}

resource "aws_cloudwatch_metric_alarm" "memory_high" {
  alarm_name          = "${local.name}-memory-high"
  alarm_description   = "RAM tren 90% trong 15 phut"
  namespace           = "CWAgent"
  metric_name         = "mem_used_percent"
  dimensions          = { InstanceId = aws_instance.app.id }
  statistic           = "Average"
  period              = 300
  evaluation_periods  = 3
  threshold           = 90
  comparison_operator = "GreaterThanThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = [aws_sns_topic.alerts.arn]
}

resource "aws_cloudwatch_metric_alarm" "disk_high" {
  for_each            = { root = { path = "/", threshold = 85 }, data = { path = "/data", threshold = 80 } }
  alarm_name          = "${local.name}-disk-${each.key}-high"
  alarm_description   = "O dia ${each.value.path} tren ${each.value.threshold}%"
  namespace           = "CWAgent"
  metric_name         = "disk_used_percent"
  dimensions          = { InstanceId = aws_instance.app.id, path = each.value.path }
  statistic           = "Maximum"
  period              = 300
  evaluation_periods  = 2
  threshold           = each.value.threshold
  comparison_operator = "GreaterThanThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = [aws_sns_topic.alerts.arn]
}

# --- Ngân sách: email khi chi phí cả account AWS vượt hạn mức tháng hoặc dự báo cuối tháng vượt ---

resource "aws_budgets_budget" "monthly" {
  count        = var.monthly_budget_usd > 0 ? 1 : 0
  name         = "${local.name}-monthly"
  budget_type  = "COST"
  limit_amount = format("%.1f", var.monthly_budget_usd) # AWS lưu dạng "55.0"; định dạng khác làm plan luôn báo thay đổi
  limit_unit   = "USD"
  time_unit    = "MONTHLY"

  dynamic "notification" {
    for_each = [
      { type = "ACTUAL", threshold = 100 },
      { type = "FORECASTED", threshold = 100 },
    ]
    content {
      comparison_operator        = "GREATER_THAN"
      threshold                  = notification.value.threshold
      threshold_type             = "PERCENTAGE"
      notification_type          = notification.value.type
      subscriber_email_addresses = [var.alert_email]
    }
  }
}

# --- Bật/tắt theo giờ làm việc (EventBridge Scheduler, nằm trong hạn mức miễn phí) ---

resource "aws_iam_role" "scheduler" {
  count = var.office_hours_only ? 1 : 0
  name  = "${local.name}-scheduler"
  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Service = "scheduler.amazonaws.com" }
      Action    = "sts:AssumeRole"
      Condition = { StringEquals = { "aws:SourceAccount" = data.aws_caller_identity.current.account_id } }
    }]
  })
}

resource "aws_iam_role_policy" "scheduler" {
  count  = var.office_hours_only ? 1 : 0
  role   = aws_iam_role.scheduler[0].id
  policy = jsonencode({ Version = "2012-10-17", Statement = [{ Effect = "Allow", Action = ["ec2:StartInstances", "ec2:StopInstances"], Resource = aws_instance.app.arn }] })
}

resource "aws_scheduler_schedule" "power" {
  for_each = var.office_hours_only ? { start = var.start_schedule, stop = var.stop_schedule } : {}

  name                         = "${local.name}-${each.key}"
  schedule_expression          = each.value
  schedule_expression_timezone = "Asia/Ho_Chi_Minh"
  flexible_time_window { mode = "OFF" }
  target {
    arn      = "arn:aws:scheduler:::aws-sdk:ec2:${each.key}Instances"
    role_arn = aws_iam_role.scheduler[0].arn
    input    = jsonencode({ InstanceIds = [aws_instance.app.id] })
  }
}
