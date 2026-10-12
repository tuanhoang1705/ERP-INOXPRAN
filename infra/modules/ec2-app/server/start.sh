#!/bin/bash
# Chạy khi máy khởi động và mỗi lần deploy (qua bootstrap.sh): kiểm tra ổ dữ liệu, đọc bí mật từ SSM Parameter Store,
# bật xác thực MongoDB, kéo image theo IMAGE_TAG rồi khởi động lại các container đã đổi.
set -euo pipefail
cd /opt/inoxpran
. ./base.env

# MongoDB phải ghi vào ổ EBS riêng (giữ dữ liệu khi thay máy), không ghi nhầm vào ổ hệ điều hành.
if ! mountpoint -q /data; then
  echo "Ổ dữ liệu chưa gắn vào /data — dừng để không ghi database lên ổ hệ điều hành." >&2
  exit 1
fi

param() {
  aws ssm get-parameter --region "$AWS_REGION" --name "$PARAM_PREFIX/$1" --with-decryption --query Parameter.Value --output text
}

tag="$(param IMAGE_TAG)"
if [ "$tag" = "none" ]; then
  echo "Chưa có image nào được deploy (IMAGE_TAG=none) — chạy infra/deploy.ps1 trên máy phát triển."
  exit 0
fi

umask 077
for name in JWT_SECRET MFA_ENCRYPTION_KEY MONGO_ROOT_PASSWORD MONGO_APP_PASSWORD MONGO_KEYFILE; do
  if ! param "$name" > /dev/null 2>&1; then
    echo "Thiếu $PARAM_PREFIX/$name trong SSM Parameter Store — chạy infra/deploy.ps1 (tự sinh bí mật) rồi thử lại." >&2
    exit 1
  fi
done
mongo_root="$(param MONGO_ROOT_PASSWORD)"
mongo_app="$(param MONGO_APP_PASSWORD)"

# Khóa nội bộ của replica set (bắt buộc khi bật xác thực); container mongo chạy bằng uid 999.
param MONGO_KEYFILE > mongo-keyfile.tmp
mv mongo-keyfile.tmp mongo-keyfile
chown 999:999 mongo-keyfile
chmod 400 mongo-keyfile

{
  for name in JWT_SECRET MFA_ENCRYPTION_KEY; do
    value="$(param "$name")"
    case "$value" in *"'"*) echo "Giá trị $name chứa dấu nháy đơn — không hỗ trợ" >&2; exit 1 ;; esac
    printf "%s='%s'\n" "$name" "$value"
  done
  # Mật khẩu chỉ gồm chữ và số (deploy.ps1 sinh) nên đặt thẳng vào chuỗi kết nối.
  printf "MONGODB_URI='mongodb://erpapp:%s@mongo:27017/inoxpran_erp?replicaSet=rs0&authSource=inoxpran_erp'\n" "$mongo_app"
} > secrets.env.tmp
mv secrets.env.tmp secrets.env
{ cat base.env; echo "IMAGE_TAG=$tag"; } > .env

docker compose pull --quiet
docker compose up -d --wait mongo
docker compose exec -T -e MONGO_ROOT_PASSWORD="$mongo_root" -e MONGO_APP_PASSWORD="$mongo_app" mongo mongosh --quiet /opt/mongo-init.js
docker compose up -d --remove-orphans
# Xóa image không còn container nào dùng và cũ hơn 7 ngày (bản cũ vẫn còn trên ECR để quay lại); giữ ổ hệ thống không đầy.
docker image prune -af --filter "until=168h" > /dev/null
echo "Đang chạy phiên bản $tag ($APP_ENV)"
