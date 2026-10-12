#!/bin/bash
# Sao lưu MongoDB mỗi giờ lên S3 (systemd timer inoxpran-backup.timer, phút :05).
# - backups/hourly/: giữ theo vòng đời S3 (mặc định 7 ngày); bản lúc 02:xx giờ Việt Nam chép thêm vào backups/daily/
#   (35 ngày), ngày mùng 1 chép thêm vào backups/monthly/ (12 tháng).
# - Kết quả ghi vào collection system_jobs (màn Giám sát hệ thống) và metric CloudWatch INOXPRAN/BackupSucceeded
#   (cảnh báo email khi quá 3 giờ không có bản thành công).
set -uo pipefail
cd /opt/inoxpran
. ./base.env

param() {
  aws ssm get-parameter --region "$AWS_REGION" --name "$PARAM_PREFIX/$1" --with-decryption --query Parameter.Value --output text
}
root_pw="$(param MONGO_ROOT_PASSWORD)"
stamp="$(date -u +%Y%m%dT%H%M%SZ)"
hour="$(TZ=Asia/Ho_Chi_Minh date +%H)"
day="$(TZ=Asia/Ho_Chi_Minh date +%d)"
name="inoxpran-$APP_ENV-$stamp.archive.gz"
key="backups/hourly/$name"
mkdir -p /data/backup
file="/data/backup/$name"
status=FAILED
size=0
started="$(date +%s)"

if docker compose exec -T mongo mongodump --quiet --username root --password "$root_pw" --authenticationDatabase admin \
  --db inoxpran_erp --archive --gzip > "$file" && [ -s "$file" ]; then
  size="$(stat -c %s "$file")"
  if aws s3 cp --only-show-errors --region "$AWS_REGION" "$file" "s3://$S3_BUCKET/$key"; then
    status=SUCCESS
    if [ "$hour" = "02" ]; then
      aws s3 cp --only-show-errors --region "$AWS_REGION" "s3://$S3_BUCKET/$key" "s3://$S3_BUCKET/backups/daily/$name" || status=PARTIAL
      if [ "$day" = "01" ]; then
        aws s3 cp --only-show-errors --region "$AWS_REGION" "s3://$S3_BUCKET/$key" "s3://$S3_BUCKET/backups/monthly/$name" || status=PARTIAL
      fi
    fi
  fi
fi
rm -f "$file"
duration=$(( $(date +%s) - started ))

docker compose exec -T mongo mongosh --quiet --username root --password "$root_pw" --authenticationDatabase admin inoxpran_erp \
  --eval "db.system_jobs.insertOne({ type: 'BACKUP', status: '$status', at: new Date(), sizeBytes: $size, durationSeconds: $duration, location: 's3://$S3_BUCKET/$key' })" > /dev/null || true
succeeded=0
[ "$status" = SUCCESS ] && succeeded=1
aws cloudwatch put-metric-data --region "$AWS_REGION" --namespace INOXPRAN --metric-name BackupSucceeded \
  --dimensions Environment="$APP_ENV" --value "$succeeded" || true

echo "Sao lưu $status: $size byte trong ${duration}s → s3://$S3_BUCKET/$key"
[ "$status" = SUCCESS ]
