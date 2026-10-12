data "aws_availability_zones" "available" { state = "available" }
data "aws_caller_identity" "current" {}

locals {
  name = "${var.project}-${var.environment}"
  azs  = slice(data.aws_availability_zones.available.names, 0, 2)
}

module "vpc" {
  source  = "terraform-aws-modules/vpc/aws"
  version = "~> 6.0"

  name            = local.name
  cidr            = "10.42.0.0/16"
  azs             = local.azs
  public_subnets  = ["10.42.0.0/24", "10.42.1.0/24"]
  private_subnets = ["10.42.10.0/24", "10.42.11.0/24"]

  enable_nat_gateway     = true
  one_nat_gateway_per_az = var.environment == "production"
  single_nat_gateway     = var.environment != "production"
  enable_dns_hostnames   = true
  enable_dns_support     = true

  # Nhật ký lưu lượng mạng (điều tra sự cố an ninh), lưu CloudWatch 30 ngày.
  enable_flow_log                                 = true
  create_flow_log_cloudwatch_log_group            = true
  create_flow_log_cloudwatch_iam_role             = true
  flow_log_max_aggregation_interval               = 60
  flow_log_cloudwatch_log_group_retention_in_days = 30
}

resource "aws_ecr_repository" "api" {
  name                 = "${local.name}-api"
  image_tag_mutability = "IMMUTABLE"
  image_scanning_configuration { scan_on_push = true }
  encryption_configuration { encryption_type = "AES256" }
}

resource "aws_ecr_repository" "web" {
  name                 = "${local.name}-web"
  image_tag_mutability = "IMMUTABLE"
  image_scanning_configuration { scan_on_push = true }
  encryption_configuration { encryption_type = "AES256" }
}

resource "aws_ecr_lifecycle_policy" "images" {
  for_each   = { api = aws_ecr_repository.api.name, web = aws_ecr_repository.web.name }
  repository = each.value
  policy     = jsonencode({ rules = [{ rulePriority = 1, description = "Giữ 30 image gần nhất", selection = { tagStatus = "any", countType = "imageCountMoreThan", countNumber = 30 }, action = { type = "expire" } }] })
}

resource "aws_s3_bucket" "documents" {
  bucket = "${local.name}-${data.aws_caller_identity.current.account_id}-documents"
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

# Chấp nhận: SSE-S3 (AES256) do AWS quản lý khóa là đủ cho ảnh chứng từ nội bộ; chuyển sang KMS khóa riêng khi có yêu cầu kiểm toán.
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
    id     = "archive-old-versions"
    status = "Enabled"
    filter {}
    noncurrent_version_transition {
      noncurrent_days = 30
      storage_class   = "STANDARD_IA"
    }
    noncurrent_version_expiration { noncurrent_days = 365 }
  }
  # Ảnh bằng chứng chỉ bị xóa khi tải lên mà không dùng: dọn hẳn phiên bản cũ sau 7 ngày.
  # Ảnh đã gắn vào phiếu không bao giờ bị xóa nên không chịu ảnh hưởng.
  rule {
    id     = "purge-discarded-sales-evidence"
    status = "Enabled"
    filter { prefix = "sales-evidence/" }
    noncurrent_version_expiration { noncurrent_days = 7 }
    expiration { expired_object_delete_marker = true }
  }
  rule {
    id     = "abort-incomplete-uploads"
    status = "Enabled"
    filter {}
    abort_incomplete_multipart_upload { days_after_initiation = 1 }
  }
}

# Chỉ chấp nhận truy cập qua TLS.
resource "aws_s3_bucket_policy" "documents" {
  bucket = aws_s3_bucket.documents.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = concat([{
      Sid       = "DenyInsecureTransport"
      Effect    = "Deny"
      Principal = "*"
      Action    = "s3:*"
      Resource  = [aws_s3_bucket.documents.arn, "${aws_s3_bucket.documents.arn}/*"]
      Condition = { Bool = { "aws:SecureTransport" = "false" } }
      }], var.enable_s3_malware_protection ? [{
      # File bị GuardDuty gắn THREATS_FOUND: không ai đọc được nữa (trừ chính GuardDuty để quét lại).
      Sid       = "DenyReadOfInfectedObjects"
      Effect    = "Deny"
      Principal = "*"
      Action    = ["s3:GetObject", "s3:GetObjectVersion"]
      Resource  = "${aws_s3_bucket.documents.arn}/*"
      Condition = {
        StringEquals    = { "s3:ExistingObjectTag/GuardDutyMalwareScanStatus" = "THREATS_FOUND" }
        StringNotEquals = { "aws:PrincipalArn" = aws_iam_role.guardduty_s3_malware[0].arn }
      }
    }] : [])
  })
  depends_on = [aws_s3_bucket_public_access_block.documents]
}

resource "aws_secretsmanager_secret" "runtime" {
  name                    = "${local.name}/runtime"
  recovery_window_in_days = var.environment == "production" ? 30 : 7
  description             = "JSON: MONGODB_URI, JWT_SECRET, MFA_ENCRYPTION_KEY, MISA_APP_ID, MISA_ACCESS_CODE"
}

resource "aws_security_group" "alb" {
  name   = "${local.name}-alb"
  vpc_id = module.vpc.vpc_id
  ingress {
    from_port   = 80
    to_port     = 80
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
  }
  ingress {
    from_port   = 443
    to_port     = 443
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
  }
  # ALB chỉ cần chuyển tiếp tới container web (cổng 8080) trong VPC.
  egress {
    from_port   = 8080
    to_port     = 8080
    protocol    = "tcp"
    cidr_blocks = [module.vpc.vpc_cidr_block]
  }
}

resource "aws_security_group" "app" {
  name   = "${local.name}-app"
  vpc_id = module.vpc.vpc_id
  ingress {
    from_port       = 8080
    to_port         = 8080
    protocol        = "tcp"
    security_groups = [aws_security_group.alb.id]
  }
  # Chấp nhận: task gọi MongoDB Atlas, S3, Secrets Manager, ECR, SES, CDN cập nhật mẫu ClamAV — đều là
  # dải IP công khai thay đổi theo AWS/nhà cung cấp, không liệt kê cố định được. Đi qua NAT, không có cổng vào.
  #trivy:ignore:AVD-AWS-0104
  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }
}

resource "aws_security_group" "redis" {
  name   = "${local.name}-redis"
  vpc_id = module.vpc.vpc_id
  ingress {
    from_port       = 6379
    to_port         = 6379
    protocol        = "tcp"
    security_groups = [aws_security_group.app.id]
  }
  # Không khai báo egress: Redis chỉ trả lời kết nối từ app, không chủ động kết nối ra ngoài
  # (Terraform xóa quy tắc "cho phép tất cả" mặc định của AWS).
}

resource "aws_elasticache_subnet_group" "redis" {
  name       = local.name
  subnet_ids = module.vpc.private_subnets
}

resource "aws_elasticache_replication_group" "redis" {
  replication_group_id       = substr(local.name, 0, 40)
  description                = "ERP jobs and cache"
  engine                     = "redis"
  engine_version             = "7.1"
  node_type                  = var.environment == "production" ? "cache.t4g.small" : "cache.t4g.micro"
  port                       = 6379
  num_cache_clusters         = var.environment == "production" ? 2 : 1
  automatic_failover_enabled = var.environment == "production"
  multi_az_enabled           = var.environment == "production"
  at_rest_encryption_enabled = true
  transit_encryption_enabled = true
  subnet_group_name          = aws_elasticache_subnet_group.redis.name
  security_group_ids         = [aws_security_group.redis.id]
  snapshot_retention_limit   = var.environment == "production" ? 7 : 1
  apply_immediately          = false
}

# Chấp nhận: ERP được truy cập qua Internet từ văn phòng Paragon và kho Sơn Đồng (HTTPS, WAF/IP allowlist có thể bổ sung sau).
#trivy:ignore:AVD-AWS-0053
resource "aws_lb" "app" {
  name                       = substr(local.name, 0, 32)
  load_balancer_type         = "application"
  internal                   = false
  subnets                    = module.vpc.public_subnets
  security_groups            = [aws_security_group.alb.id]
  enable_deletion_protection = var.environment == "production"
  drop_invalid_header_fields = true
}

resource "aws_lb_target_group" "web" {
  name        = substr("${local.name}-web", 0, 32)
  port        = 8080
  protocol    = "HTTP"
  vpc_id      = module.vpc.vpc_id
  target_type = "ip"
  health_check {
    path                = "/api/v1/health"
    matcher             = "200"
    interval            = 30
    healthy_threshold   = 2
    unhealthy_threshold = 3
  }
  deregistration_delay = 30
}

resource "aws_lb_listener" "http" {
  load_balancer_arn = aws_lb.app.arn
  port              = 80
  protocol          = "HTTP"
  default_action {
    type = "redirect"
    redirect {
      port        = "443"
      protocol    = "HTTPS"
      status_code = "HTTP_301"
    }
  }
}

resource "aws_lb_listener" "https" {
  load_balancer_arn = aws_lb.app.arn
  port              = 443
  protocol          = "HTTPS"
  ssl_policy        = "ELBSecurityPolicy-TLS13-1-2-2021-06"
  certificate_arn   = var.certificate_arn
  default_action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.web.arn
  }
}

resource "aws_ecs_cluster" "app" {
  name = local.name
  setting {
    name  = "containerInsights"
    value = "enabled"
  }
}

resource "aws_cloudwatch_log_group" "app" {
  name              = "/ecs/${local.name}"
  retention_in_days = var.environment == "production" ? 90 : 14
}

resource "aws_iam_role" "execution" {
  name               = "${local.name}-execution"
  assume_role_policy = jsonencode({ Version = "2012-10-17", Statement = [{ Effect = "Allow", Principal = { Service = "ecs-tasks.amazonaws.com" }, Action = "sts:AssumeRole" }] })
}

resource "aws_iam_role_policy_attachment" "execution" {
  role       = aws_iam_role.execution.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy"
}

resource "aws_iam_role_policy" "execution_secrets" {
  role   = aws_iam_role.execution.id
  policy = jsonencode({ Version = "2012-10-17", Statement = [{ Effect = "Allow", Action = ["secretsmanager:GetSecretValue"], Resource = aws_secretsmanager_secret.runtime.arn }] })
}

resource "aws_iam_role" "task" {
  name               = "${local.name}-task"
  assume_role_policy = jsonencode({ Version = "2012-10-17", Statement = [{ Effect = "Allow", Principal = { Service = "ecs-tasks.amazonaws.com" }, Action = "sts:AssumeRole" }] })
}

resource "aws_iam_role_policy" "task" {
  role = aws_iam_role.task.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      { Effect = "Allow", Action = ["s3:GetObject", "s3:PutObject", "s3:AbortMultipartUpload"], Resource = "${aws_s3_bucket.documents.arn}/*" },
      # Kiểm tra bucket khi khởi động (HeadBucket cần s3:ListBucket).
      { Effect = "Allow", Action = ["s3:ListBucket"], Resource = aws_s3_bucket.documents.arn },
      # Chỉ được xóa ảnh bằng chứng tải lên nhưng không dùng (worker dọn sau 24 giờ), ảnh bảo hành chụp nhầm (phiếu chưa trả)
      # và file tab "Đính kèm" của hồ sơ sản phẩm / đối tác / chứng từ mua; chứng từ khác không xóa được.
      { Effect = "Allow", Action = ["s3:DeleteObject"], Resource = ["${aws_s3_bucket.documents.arn}/sales-evidence/*", "${aws_s3_bucket.documents.arn}/warranty-photos/*", "${aws_s3_bucket.documents.arn}/product-files/*", "${aws_s3_bucket.documents.arn}/partner-files/*", "${aws_s3_bucket.documents.arn}/purchase-docs/*"] },
      { Effect = "Allow", Action = ["ses:SendEmail", "ses:SendRawEmail"], Resource = "*" }
    ]
  })
}

resource "aws_ecs_task_definition" "app" {
  family                   = local.name
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = var.task_cpu
  memory                   = var.task_memory
  execution_role_arn       = aws_iam_role.execution.arn
  task_role_arn            = aws_iam_role.task.arn

  container_definitions = jsonencode([
    {
      # Lớp quét mã độc thứ nhất: clamd chỉ nghe trong task (cùng network namespace awsvpc), không mở cổng ra ngoài.
      # Image chính thức đã kèm bộ nhận diện; freshclam trong container tự cập nhật.
      name              = "clamav", image = var.clamav_image, essential = true
      memoryReservation = 1536
      healthCheck       = { command = ["CMD", "clamdcheck.sh"], interval = 30, timeout = 10, retries = 5, startPeriod = 300 }
      logConfiguration  = { logDriver = "awslogs", options = { "awslogs-group" = aws_cloudwatch_log_group.app.name, "awslogs-region" = var.aws_region, "awslogs-stream-prefix" = "clamav" } }
    },
    {
      name         = "api", image = var.api_image, essential = true
      portMappings = [{ containerPort = 3000, protocol = "tcp" }]
      environment = [
        { name = "NODE_ENV", value = "production" },
        { name = "PORT", value = "3000" },
        { name = "WEB_ORIGIN", value = "https://${var.domain_name}" },
        { name = "MONGODB_DATABASE", value = "inoxpran_erp" },
        { name = "COOKIE_SECURE", value = "true" },
        { name = "MFA_ENFORCE_PRIVILEGED", value = "true" },
        { name = "AWS_REGION", value = var.aws_region },
        { name = "AWS_S3_BUCKET", value = aws_s3_bucket.documents.id },
        { name = "MALWARE_SCAN_MODE", value = "clamav" },
        { name = "CLAMAV_HOST", value = "127.0.0.1" },
        { name = "CLAMAV_PORT", value = "3310" },
        { name = "REDIS_URL", value = "rediss://${aws_elasticache_replication_group.redis.primary_endpoint_address}:6379" }
      ]
      # API chỉ khởi động khi ClamAV đã nạp xong bộ nhận diện (file tải lên luôn được quét).
      dependsOn = [{ containerName = "clamav", condition = "HEALTHY" }]
      secrets = [
        { name = "MONGODB_URI", valueFrom = "${aws_secretsmanager_secret.runtime.arn}:MONGODB_URI::" },
        { name = "JWT_SECRET", valueFrom = "${aws_secretsmanager_secret.runtime.arn}:JWT_SECRET::" },
        { name = "MFA_ENCRYPTION_KEY", valueFrom = "${aws_secretsmanager_secret.runtime.arn}:MFA_ENCRYPTION_KEY::" }
      ]
      healthCheck      = { command = ["CMD-SHELL", "node -e \"fetch('http://127.0.0.1:3000/api/v1/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))\""], interval = 30, timeout = 5, retries = 3, startPeriod = 30 }
      logConfiguration = { logDriver = "awslogs", options = { "awslogs-group" = aws_cloudwatch_log_group.app.name, "awslogs-region" = var.aws_region, "awslogs-stream-prefix" = "api" } }
    },
    {
      name      = "worker", image = var.api_image, essential = true
      command   = ["node", "apps/api/dist/worker.js"]
      dependsOn = [{ containerName = "api", condition = "HEALTHY" }]
      environment = [
        { name = "NODE_ENV", value = "production" },
        { name = "MONGODB_DATABASE", value = "inoxpran_erp" },
        { name = "AWS_REGION", value = var.aws_region },
        { name = "AWS_S3_BUCKET", value = aws_s3_bucket.documents.id },
        { name = "REDIS_URL", value = "rediss://${aws_elasticache_replication_group.redis.primary_endpoint_address}:6379" }
      ]
      secrets = [
        { name = "MONGODB_URI", valueFrom = "${aws_secretsmanager_secret.runtime.arn}:MONGODB_URI::" }
      ]
      logConfiguration = { logDriver = "awslogs", options = { "awslogs-group" = aws_cloudwatch_log_group.app.name, "awslogs-region" = var.aws_region, "awslogs-stream-prefix" = "worker" } }
    },
    {
      name             = "web", image = var.web_image, essential = true
      portMappings     = [{ containerPort = 8080, protocol = "tcp" }]
      dependsOn        = [{ containerName = "api", condition = "HEALTHY" }]
      logConfiguration = { logDriver = "awslogs", options = { "awslogs-group" = aws_cloudwatch_log_group.app.name, "awslogs-region" = var.aws_region, "awslogs-stream-prefix" = "web" } }
    }
  ])
}

resource "aws_ecs_service" "app" {
  name                               = local.name
  cluster                            = aws_ecs_cluster.app.id
  task_definition                    = aws_ecs_task_definition.app.arn
  desired_count                      = var.desired_count
  launch_type                        = "FARGATE"
  platform_version                   = "LATEST"
  deployment_minimum_healthy_percent = 100
  deployment_maximum_percent         = 200
  enable_execute_command             = true
  health_check_grace_period_seconds  = 60
  network_configuration {
    subnets          = module.vpc.private_subnets
    security_groups  = [aws_security_group.app.id]
    assign_public_ip = false
  }
  load_balancer {
    target_group_arn = aws_lb_target_group.web.arn
    container_name   = "web"
    container_port   = 8080
  }
  depends_on = [aws_lb_listener.https]
}

resource "aws_appautoscaling_target" "ecs" {
  max_capacity       = var.environment == "production" ? 8 : 2
  min_capacity       = var.desired_count
  resource_id        = "service/${aws_ecs_cluster.app.name}/${aws_ecs_service.app.name}"
  scalable_dimension = "ecs:service:DesiredCount"
  service_namespace  = "ecs"
}

resource "aws_appautoscaling_policy" "cpu" {
  name               = "${local.name}-cpu"
  policy_type        = "TargetTrackingScaling"
  resource_id        = aws_appautoscaling_target.ecs.resource_id
  scalable_dimension = aws_appautoscaling_target.ecs.scalable_dimension
  service_namespace  = aws_appautoscaling_target.ecs.service_namespace
  target_tracking_scaling_policy_configuration {
    predefined_metric_specification {
      predefined_metric_type = "ECSServiceAverageCPUUtilization"
    }
    target_value = 60
  }
}

# Chấp nhận: topic chỉ chứa nội dung cảnh báo vận hành, không có dữ liệu khách hàng; EventBridge/CloudWatch không gửi được
# vào topic mã hóa bằng khóa AWS-managed alias/aws/sns, muốn mã hóa phải tạo khóa KMS riêng.
#trivy:ignore:AVD-AWS-0095
resource "aws_sns_topic" "alerts" { name = "${local.name}-alerts" }
resource "aws_sns_topic_subscription" "email" {
  topic_arn = aws_sns_topic.alerts.arn
  protocol  = "email"
  endpoint  = var.alert_email
}

resource "aws_cloudwatch_metric_alarm" "unhealthy" {
  alarm_name          = "${local.name}-unhealthy-targets"
  namespace           = "AWS/ApplicationELB"
  metric_name         = "UnHealthyHostCount"
  statistic           = "Maximum"
  period              = 60
  evaluation_periods  = 2
  threshold           = 0
  comparison_operator = "GreaterThanThreshold"
  dimensions          = { LoadBalancer = aws_lb.app.arn_suffix, TargetGroup = aws_lb_target_group.web.arn_suffix }
  alarm_actions       = [aws_sns_topic.alerts.arn]
}
