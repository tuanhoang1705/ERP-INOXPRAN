#!/bin/bash
# Diễn tập khôi phục (infra/deploy.ps1 -RestoreDrill): tải bản sao lưu mới nhất trên S3, khôi phục vào một MongoDB tạm
# (container riêng, không đụng dữ liệu đang chạy), so số bản ghi từng collection với dữ liệu hiện tại rồi xóa bản tạm.
set -euo pipefail
cd /opt/inoxpran
. ./base.env

param() {
  aws ssm get-parameter --region "$AWS_REGION" --name "$PARAM_PREFIX/$1" --with-decryption --query Parameter.Value --output text
}
root_pw="$(param MONGO_ROOT_PASSWORD)"
latest="$(aws s3 ls --region "$AWS_REGION" "s3://$S3_BUCKET/backups/hourly/" | sort | tail -1 | awk '{print $4}')"
if [ -z "$latest" ]; then
  echo "Chưa có bản sao lưu nào trong s3://$S3_BUCKET/backups/hourly/" >&2
  exit 1
fi
work=/data/backup/drill
rm -rf "$work" && mkdir -p "$work"
aws s3 cp --only-show-errors --region "$AWS_REGION" "s3://$S3_BUCKET/backups/hourly/$latest" "$work/$latest"

docker rm -f inoxpran-restore-drill > /dev/null 2>&1 || true
docker run -d --name inoxpran-restore-drill -v "$work:/backup" mongo:8.0 mongod --bind_ip_all --wiredTigerCacheSizeGB 0.25 > /dev/null
cleanup() { docker rm -f inoxpran-restore-drill > /dev/null 2>&1 || true; rm -rf "$work"; }
trap cleanup EXIT
for attempt in $(seq 1 60); do
  docker exec inoxpran-restore-drill mongosh --quiet --eval 'db.adminCommand({ ping: 1 }).ok' > /dev/null 2>&1 && break
  sleep 2
done

started="$(date +%s)"
docker exec inoxpran-restore-drill mongorestore --quiet --archive="/backup/$latest" --gzip
seconds=$(( $(date +%s) - started ))

count_js='const out = {}; db.getCollectionNames().sort().forEach((name) => { out[name] = db.getCollection(name).countDocuments({}); }); print(JSON.stringify(out));'
restored="$(docker exec inoxpran-restore-drill mongosh --quiet inoxpran_erp --eval "$count_js")"
live="$(docker compose exec -T mongo mongosh --quiet --username root --password "$root_pw" --authenticationDatabase admin inoxpran_erp --eval "$count_js")"

echo "Bản sao lưu: $latest — khôi phục mất ${seconds} giây"
RESTORED="$restored" LIVE="$live" python3 - <<'PY'
import json, os
restored = json.loads(os.environ["RESTORED"])
live = json.loads(os.environ["LIVE"])
names = sorted(set(restored) | set(live))
print(f"{'collection':32} {'bản sao lưu':>12} {'đang chạy':>12}")
for name in names:
    a, b = restored.get(name, 0), live.get(name, 0)
    mark = "" if a == b else "  (phát sinh sau giờ sao lưu)" if a < b else "  !!"
    print(f"{name:32} {a:>12} {b:>12}{mark}")
print(f"Tổng: {sum(restored.values())} bản ghi khôi phục / {sum(live.values())} đang chạy")
PY
