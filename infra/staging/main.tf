# Staging dùng tạm: dựng khi cần thử lớn rồi gỡ (terraform destroy xóa được cả ổ dữ liệu và bucket).
# Từ 06/10/2026 không chạy thường trực để giữ chi phí ≤ 25 USD/tháng — xem infra/staging/README.md.

module "app" {
  source = "../modules/ec2-app"

  project                 = var.project
  environment             = "staging"
  aws_region              = var.aws_region
  domain_name             = var.domain_name
  alert_email             = var.alert_email
  vpc_cidr                = "10.43.0.0/16"
  instance_type           = var.instance_type
  root_volume_gb          = var.root_volume_gb
  office_hours_only       = var.office_hours_only
  start_schedule          = var.start_schedule
  stop_schedule           = var.stop_schedule
  compose_version         = var.compose_version
  enforce_mfa             = var.enforce_mfa
  data_volume_gb          = var.data_volume_gb
  snapshot_retention_days = var.snapshot_retention_days
  create_ecr              = true
  protect_data            = false
  allow_destroy           = true
}

# Tài nguyên tạo trước khi tách module (05/10/2026): chuyển địa chỉ trong state, không tạo lại.
moved {
  from = aws_vpc.main
  to   = module.app.aws_vpc.main
}
moved {
  from = aws_default_security_group.default
  to   = module.app.aws_default_security_group.default
}
moved {
  from = aws_internet_gateway.main
  to   = module.app.aws_internet_gateway.main
}
moved {
  from = aws_subnet.public
  to   = module.app.aws_subnet.public
}
moved {
  from = aws_route_table.public
  to   = module.app.aws_route_table.public
}
moved {
  from = aws_route_table_association.public
  to   = module.app.aws_route_table_association.public
}
moved {
  from = aws_security_group.app
  to   = module.app.aws_security_group.app
}
moved {
  from = aws_ecr_repository.app
  to   = module.app.aws_ecr_repository.app
}
moved {
  from = aws_ecr_lifecycle_policy.app
  to   = module.app.aws_ecr_lifecycle_policy.app
}
moved {
  from = aws_s3_bucket.documents
  to   = module.app.aws_s3_bucket.documents
}
moved {
  from = aws_s3_bucket_public_access_block.documents
  to   = module.app.aws_s3_bucket_public_access_block.documents
}
moved {
  from = aws_s3_bucket_versioning.documents
  to   = module.app.aws_s3_bucket_versioning.documents
}
moved {
  from = aws_s3_bucket_server_side_encryption_configuration.documents
  to   = module.app.aws_s3_bucket_server_side_encryption_configuration.documents
}
moved {
  from = aws_s3_bucket_lifecycle_configuration.documents
  to   = module.app.aws_s3_bucket_lifecycle_configuration.documents
}
moved {
  from = aws_s3_bucket_policy.documents
  to   = module.app.aws_s3_bucket_policy.documents
}
moved {
  from = aws_ssm_parameter.image_tag
  to   = module.app.aws_ssm_parameter.image_tag
}
moved {
  from = aws_iam_role.app
  to   = module.app.aws_iam_role.app
}
moved {
  from = aws_iam_role_policy_attachment.ssm_core
  to   = module.app.aws_iam_role_policy_attachment.ssm_core
}
moved {
  from = aws_iam_role_policy.app
  to   = module.app.aws_iam_role_policy.app
}
moved {
  from = aws_iam_instance_profile.app
  to   = module.app.aws_iam_instance_profile.app
}
moved {
  from = aws_instance.app
  to   = module.app.aws_instance.app
}
moved {
  from = aws_ebs_volume.data
  to   = module.app.aws_ebs_volume.data
}
moved {
  from = module.app.aws_ebs_volume.data
  to   = module.app.aws_ebs_volume.data_disposable[0]
}
moved {
  from = aws_volume_attachment.data
  to   = module.app.aws_volume_attachment.data
}
moved {
  from = aws_iam_role.dlm
  to   = module.app.aws_iam_role.dlm
}
moved {
  from = aws_iam_role_policy_attachment.dlm
  to   = module.app.aws_iam_role_policy_attachment.dlm
}
moved {
  from = aws_dlm_lifecycle_policy.data
  to   = module.app.aws_dlm_lifecycle_policy.data
}
moved {
  from = aws_eip.app
  to   = module.app.aws_eip.app
}
moved {
  from = aws_sns_topic.alerts
  to   = module.app.aws_sns_topic.alerts
}
moved {
  from = aws_sns_topic_subscription.email
  to   = module.app.aws_sns_topic_subscription.email
}
moved {
  from = aws_cloudwatch_metric_alarm.status_check
  to   = module.app.aws_cloudwatch_metric_alarm.status_check
}
moved {
  from = aws_iam_role.scheduler
  to   = module.app.aws_iam_role.scheduler
}
moved {
  from = aws_iam_role_policy.scheduler
  to   = module.app.aws_iam_role_policy.scheduler
}
moved {
  from = aws_scheduler_schedule.power
  to   = module.app.aws_scheduler_schedule.power
}
