variable "project" {
  type        = string
  description = "Tên ngắn dùng làm prefix tài nguyên."
  default     = "inoxpran-erp"
}

variable "environment" {
  type        = string
  description = "development, staging hoặc production."
  validation {
    condition     = contains(["development", "staging", "production"], var.environment)
    error_message = "environment phải là development, staging hoặc production."
  }
}

variable "aws_region" {
  type    = string
  default = "ap-southeast-1"
}

variable "domain_name" {
  type        = string
  description = "Tên miền ERP đã có chứng thư ACM tại Singapore."
}

variable "certificate_arn" {
  type        = string
  description = "ARN chứng thư ACM cho domain_name."
}

variable "api_image" {
  type        = string
  description = "URI image API bất biến, nên dùng digest hoặc tag commit SHA."
}

variable "web_image" {
  type        = string
  description = "URI image web bất biến, nên dùng digest hoặc tag commit SHA."
}

variable "desired_count" {
  type    = number
  default = 2
}

variable "alert_email" {
  type        = string
  description = "Email nhận cảnh báo CloudWatch/SNS."
}

variable "enable_s3_malware_protection" {
  type        = bool
  description = "Bật Amazon GuardDuty Malware Protection for S3 (lớp quét thứ hai cho file tải lên)."
  default     = true
}

variable "clamav_image" {
  type        = string
  description = "Image ClamAV chạy kèm API (lớp quét thứ nhất). Nên sao lưu vào ECR và ghim digest để tránh giới hạn tải của Docker Hub."
  default     = "clamav/clamav:1.4"
}

variable "task_cpu" {
  type        = number
  description = "vCPU của task ECS (1024 = 1 vCPU)."
  default     = 1024
}

variable "task_memory" {
  type        = number
  description = "Bộ nhớ task ECS (MB). ClamAV cần khoảng 1,5–2 GB khi nạp bộ nhận diện, nên mặc định 4096."
  default     = 4096
}
