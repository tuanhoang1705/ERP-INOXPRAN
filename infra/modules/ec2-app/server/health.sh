#!/bin/bash
# Kiểm tra ứng dụng mỗi 5 phút (systemd timer inoxpran-health.timer): API khỏe (healthcheck của container),
# Caddy và worker đang chạy → đẩy metric CloudWatch INOXPRAN/AppHealthy = 1, ngược lại 0 (cảnh báo email).
set -uo pipefail
cd /opt/inoxpran
. ./base.env

state() { docker inspect -f "$2" "inoxpran-$1-1" 2>/dev/null; }
healthy=0
if [ "$(state api '{{.State.Health.Status}}')" = "healthy" ] \
  && [ "$(state caddy '{{.State.Running}}')" = "true" ] \
  && [ "$(state worker '{{.State.Running}}')" = "true" ]; then
  healthy=1
fi
aws cloudwatch put-metric-data --region "$AWS_REGION" --namespace INOXPRAN --metric-name AppHealthy \
  --dimensions Environment="$APP_ENV" --value "$healthy"
