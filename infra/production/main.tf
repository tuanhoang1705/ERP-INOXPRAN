# Production INOXPRAN ERP (~10 người dùng): một máy EC2 chạy Docker Compose (module dùng chung infra/modules/ec2-app).
# Môi trường duy nhất từ 06/10/2026 (đã bỏ staging để giữ chi phí ≤ 25 USD/tháng): bắt buộc MFA, chặn xóa máy,
# sao lưu mỗi giờ, không có dữ liệu trình diễn, kho image ECR riêng (infra/deploy.ps1 -Environment production).
# Chi phí và vận hành: infra/production/README.md.

module "app" {
  source = "../modules/ec2-app"

  project                 = var.project
  environment             = "production"
  aws_region              = var.aws_region
  domain_name             = var.domain_name
  alert_email             = var.alert_email
  vpc_cidr                = "10.44.0.0/16"
  instance_type           = var.instance_type
  root_volume_gb          = var.root_volume_gb
  data_volume_gb          = var.data_volume_gb
  snapshot_retention_days = var.snapshot_retention_days
  office_hours_only       = false
  enforce_mfa             = true
  termination_protection  = true
  backup_hourly_days      = 7
  backup_daily_days       = 35
  backup_monthly_days     = 365
  create_ecr              = true
  monthly_budget_usd      = var.monthly_budget_usd
}
