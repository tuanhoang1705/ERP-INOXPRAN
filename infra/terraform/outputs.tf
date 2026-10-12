output "load_balancer_dns" { value = aws_lb.app.dns_name }
output "documents_bucket" { value = aws_s3_bucket.documents.id }
output "runtime_secret_arn" { value = aws_secretsmanager_secret.runtime.arn }
output "api_repository_url" { value = aws_ecr_repository.api.repository_url }
output "web_repository_url" { value = aws_ecr_repository.web.repository_url }
output "redis_primary_endpoint" {
  value     = aws_elasticache_replication_group.redis.primary_endpoint_address
  sensitive = true
}
