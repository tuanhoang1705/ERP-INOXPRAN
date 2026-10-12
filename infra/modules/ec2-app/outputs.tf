output "public_ip" {
  description = "Tạo bản ghi A: domain_name → địa chỉ này (Cloudflare: chế độ DNS only, mây xám)."
  value       = aws_eip.app.public_ip
}

output "url" { value = "https://${var.domain_name}" }
output "instance_id" { value = aws_instance.app.id }
output "availability_zone" { value = local.az }
output "api_repository_url" { value = local.ecr_urls["api"] }
output "web_repository_url" { value = local.ecr_urls["web"] }
output "documents_bucket" { value = aws_s3_bucket.documents.id }
output "parameter_prefix" { value = local.param_prefix }
output "data_volume_id" { value = local.data_volume_id }
