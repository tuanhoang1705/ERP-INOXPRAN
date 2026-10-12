variable "project" {
  type    = string
  default = "inoxpran-erp"
}

variable "environment" {
  type        = string
  description = "staging hoặc production: đặt tên tài nguyên (inoxpran-erp-<môi trường>), tiền tố tham số SSM."
  validation {
    condition     = contains(["staging", "production"], var.environment)
    error_message = "environment phải là staging hoặc production."
  }
}

variable "aws_region" {
  type    = string
  default = "ap-southeast-1"
}

variable "domain_name" {
  type        = string
  description = "Tên miền của môi trường, VD erp.inoxpran.com. Bản ghi A trỏ về Elastic IP (output public_ip)."
}

variable "alert_email" {
  type        = string
  description = "Email nhận cảnh báo máy chủ và thông báo của Let's Encrypt."
}

variable "vpc_cidr" {
  type        = string
  description = "Dải mạng riêng của môi trường (không trùng giữa staging / production)."
}

variable "instance_type" {
  type        = string
  description = "x86_64 (image build trên máy Windows). t3a.small: 2 GB RAM; t3a.medium: 4 GB RAM."
}

variable "root_volume_gb" {
  type    = number
  default = 20
}

variable "office_hours_only" {
  type        = bool
  description = "Tự bật/tắt máy theo giờ làm việc để giảm chi phí (dữ liệu trên ổ EBS riêng và S3, không mất khi tắt)."
  default     = false
}

variable "start_schedule" {
  type        = string
  description = "Giờ bật máy (cron EventBridge, giờ Việt Nam)."
  default     = "cron(0 7 ? * MON-SAT *)"
}

variable "stop_schedule" {
  type        = string
  description = "Giờ tắt máy (cron EventBridge, giờ Việt Nam)."
  default     = "cron(0 20 ? * MON-SAT *)"
}

variable "compose_version" {
  type        = string
  description = "Phiên bản Docker Compose cài trên máy."
  default     = "v2.29.7"
}

variable "enforce_mfa" {
  type        = bool
  description = "Bắt buộc xác thực 2 lớp cho tài khoản đặc quyền (ADMIN / DIRECTOR / ACCOUNTANT)."
  default     = true
}

variable "data_volume_gb" {
  type        = number
  description = "Ổ EBS riêng cho dữ liệu MongoDB."
  default     = 10
}

variable "snapshot_retention_days" {
  type        = number
  description = "Số bản snapshot hằng ngày của ổ dữ liệu được giữ lại."
  default     = 7
}

variable "create_ecr" {
  type        = bool
  description = "true: tạo kho image ECR riêng của môi trường. false: dùng kho có sẵn trong shared_ecr_repositories."
  default     = true
}

variable "shared_ecr_repositories" {
  type        = map(string)
  description = "Tên kho ECR dùng lại khi create_ecr = false, khóa api / web."
  default     = {}
}

variable "termination_protection" {
  type        = bool
  description = "Chặn xóa máy chủ qua API (production: true)."
  default     = false
}

variable "mongo_cache_gb" {
  type        = string
  description = "Bộ nhớ đệm WiredTiger của MongoDB (GB): 0.25 cho máy 2 GB, 0.75 cho máy 4 GB."
  default     = "0.25"
}

variable "api_heap_mb" {
  type        = number
  description = "Giới hạn heap Node.js của API (MB)."
  default     = 384
}

variable "backup_hourly_days" {
  type        = number
  description = "Số ngày giữ bản sao lưu mỗi giờ (S3 backups/hourly/)."
  default     = 7
}

variable "backup_daily_days" {
  type        = number
  description = "Số ngày giữ bản sao lưu hằng ngày lúc 02:00 (S3 backups/daily/)."
  default     = 35
}

variable "monthly_budget_usd" {
  type        = number
  description = "Hạn mức chi phí tháng của cả account AWS (USD); 0 = không tạo ngân sách. Email tới alert_email khi vượt hoặc dự báo cuối tháng vượt."
  default     = 0
}

variable "allow_destroy" {
  type        = bool
  description = "true: môi trường dùng tạm (staging) — terraform destroy xóa được bucket S3 còn file."
  default     = false
}

variable "protect_data" {
  type        = bool
  description = "true (production): ổ dữ liệu MongoDB có prevent_destroy. false: môi trường dùng tạm, gỡ được bằng terraform destroy."
  default     = true
}

variable "backup_monthly_days" {
  type        = number
  description = "Số ngày giữ bản sao lưu ngày mùng 1 hằng tháng (S3 backups/monthly/)."
  default     = 365
}
