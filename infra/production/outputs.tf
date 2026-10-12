output "public_ip" {
  description = "Tạo bản ghi A: domain_name → địa chỉ này (Cloudflare: chế độ DNS only, mây xám)."
  value       = module.app.public_ip
}

output "url" { value = module.app.url }
output "instance_id" { value = module.app.instance_id }
output "availability_zone" { value = module.app.availability_zone }
output "documents_bucket" { value = module.app.documents_bucket }
output "parameter_prefix" { value = module.app.parameter_prefix }
output "data_volume_id" { value = module.app.data_volume_id }
