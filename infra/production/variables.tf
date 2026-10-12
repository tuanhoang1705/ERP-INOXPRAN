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
  description = "Tên miền production, VD erp.inoxpran.com. Bản ghi A trỏ về Elastic IP (output public_ip)."
}

variable "alert_email" {
  type        = string
  description = "Email nhận cảnh báo (máy chủ, ứng dụng, sao lưu, RAM / đĩa, ngân sách) và thông báo của Let's Encrypt."
}

variable "instance_type" {
  type        = string
  description = "t3a.small: 2 vCPU, 2 GB RAM (+ swap) — đủ cho ~10 người dùng kèm ClamAV. Đông người hơn: t3a.medium (4 GB, ~+17 USD/tháng)."
  default     = "t3a.small"
}

variable "root_volume_gb" {
  type        = number
  description = "Ổ hệ điều hành + image Docker + swap."
  default     = 16
}

variable "data_volume_gb" {
  type        = number
  description = "Ổ EBS riêng cho dữ liệu MongoDB, chữ ký ClamAV và bản sao lưu tạm (tăng được sau, không mất dữ liệu)."
  default     = 10
}

variable "snapshot_retention_days" {
  type        = number
  description = "Số bản snapshot hằng ngày của ổ dữ liệu được giữ lại (ngoài bản sao lưu MongoDB mỗi giờ trên S3)."
  default     = 7
}

variable "monthly_budget_usd" {
  type        = number
  description = "Hạn mức chi phí tháng của cả account AWS (production ~24 + staging 24/7 ~26 USD): email khi vượt hoặc dự báo cuối tháng vượt."
  default     = 55
}
