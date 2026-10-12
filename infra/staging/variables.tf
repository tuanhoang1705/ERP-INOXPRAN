variable "project" {
  type    = string
  default = "inoxpran-erp"
}

variable "aws_region" {
  type    = string
  default = "ap-southeast-1"
}

variable "domain_name" {
  type        = string
  description = "Tên miền staging, VD erp-staging.inoxpran.com. Bản ghi A trỏ về Elastic IP (output public_ip)."
}

variable "alert_email" {
  type        = string
  description = "Email nhận cảnh báo máy chủ lỗi và thông báo của Let's Encrypt."
}

variable "instance_type" {
  type        = string
  description = "x86_64 (image build trên máy Windows). t3a.small: 2 vCPU, 2 GB RAM — đủ cho ~10 người dùng kèm ClamAV."
  default     = "t3a.small"
}

variable "root_volume_gb" {
  type    = number
  default = 20
}

variable "office_hours_only" {
  type        = bool
  description = "Tự bật/tắt máy theo giờ làm việc để giảm chi phí (dữ liệu nằm ở MongoDB Atlas và S3, không mất khi tắt)."
  default     = true
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
  description = "Bắt buộc MFA cho ADMIN/ACCOUNTANT như production. Tài khoản demo (seed) không có MFA nên cần false nếu dùng dữ liệu trình diễn."
  default     = true
}

variable "data_volume_gb" {
  type        = number
  description = "Ổ EBS riêng cho dữ liệu MongoDB (demo ~10 MB; 10 GB còn dư nhiều)."
  default     = 10
}

variable "snapshot_retention_days" {
  type        = number
  description = "Số bản snapshot hằng ngày của ổ dữ liệu được giữ lại."
  default     = 7
}
