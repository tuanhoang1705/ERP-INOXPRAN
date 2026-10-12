terraform {
  # 1.10+: backend S3 khóa state bằng file (use_lockfile).
  required_version = ">= 1.10.0"
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 6.0"
    }
  }
  # State riêng của production (cùng bucket với staging, khác key). Tên bucket truyền lúc init:
  # infra/tf.ps1 tự điền inoxpran-erp-tfstate-<account id>.
  backend "s3" {
    key          = "production/terraform.tfstate"
    region       = "ap-southeast-1"
    encrypt      = true
    use_lockfile = true
  }
}

provider "aws" {
  region = var.aws_region
  default_tags {
    tags = {
      Project     = var.project
      Environment = "production"
      ManagedBy   = "Terraform"
    }
  }
}
