<#
.SYNOPSIS
  Triển khai INOXPRAN ERP lên staging hoặc production (máy EC2 + Docker Compose) qua SSM, không cần SSH.

.EXAMPLE
  .\infra\deploy.ps1 -Profile inoxpran-admin -Environment staging
  Staging: build image API/web, đẩy lên kho ECR của staging (tag theo thời gian), cập nhật máy chủ. Lần đầu tự sinh bí mật
  (JWT_SECRET, MFA_ENCRYPTION_KEY, MONGO_ROOT_PASSWORD, MONGO_APP_PASSWORD, MONGO_KEYFILE) vào SSM Parameter Store.

.EXAMPLE
  .\infra\deploy.ps1 -Profile inoxpran-admin -Environment production -ConfirmProduction -Tag 20261006-090000
  Production: phát hành ĐÚNG image đã chạy thử trên staging (kéo từ kho staging, đẩy sang kho production, không build lại).
  Tag đang chạy trên staging: SSM /inoxpran-erp/staging/IMAGE_TAG. Không có -Tag thì build trực tiếp (dự phòng).

.EXAMPLE
  .\infra\deploy.ps1 -Profile inoxpran-admin -Environment production -ConfirmProduction -SkipBuild -Tag 20261006-090000
  Quay lại một bản cũ còn trong ECR (giữ 5 bản gần nhất): chỉ đổi IMAGE_TAG rồi cập nhật máy chủ, không build.

.EXAMPLE
  .\infra\deploy.ps1 -Profile inoxpran-admin -Environment production -ConfirmProduction -SkipBuild -SeedAdmin it@inoxpran.com
  Tạo tài khoản quản trị gốc (root) có MFA. Mật khẩu và mã thiết lập MFA in một lần trên màn hình người chạy.

.EXAMPLE
  .\infra\deploy.ps1 -Profile inoxpran-admin -Environment staging -SkipBuild -SeedDemo
  Staging: nạp dữ liệu trình diễn (bị chặn ở production). -ShowDemoPassword in mật khẩu tài khoản demo.

.EXAMPLE
  .\infra\deploy.ps1 -Profile inoxpran-admin -Environment production -ConfirmProduction -SkipBuild -BackupNow
  Sao lưu MongoDB ngay lên S3. -RestoreDrill: diễn tập khôi phục bản mới nhất vào MongoDB tạm và so số bản ghi.
#>
param(
  [Parameter(Mandatory = $true)][string]$Profile,
  [Parameter(Mandatory = $true)][ValidateSet('staging', 'production')][string]$Environment,
  [string]$Tag = (Get-Date -Format 'yyyyMMdd-HHmmss'),
  [switch]$SkipBuild,
  [switch]$ConfirmProduction,
  [switch]$SeedDemo,
  [switch]$ShowDemoPassword,
  [switch]$BackupNow,
  [switch]$RestoreDrill,
  [ValidatePattern('^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$')][string]$SeedAdmin
)

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.Encoding]::UTF8
$root = Resolve-Path (Join-Path $PSScriptRoot '..')
$region = 'ap-southeast-1'
$project = 'inoxpran-erp'
$name = "$project-$Environment"
$prefix = "/$project/$Environment"
$repoBase = $name
$production = $Environment -eq 'production'
$awsCli = 'amazon/aws-cli:2.27.0'

if ($production) {
  if (-not $ConfirmProduction) { throw 'Thao tác trên production: thêm -ConfirmProduction để xác nhận.' }
  if ($SeedDemo -or $ShowDemoPassword) { throw 'Production không có dữ liệu trình diễn (-SeedDemo / -ShowDemoPassword bị chặn).' }
}

$awsConfig = Join-Path $env:USERPROFILE '.aws'
foreach ($cache in @('sso\cache', 'cli\cache')) { New-Item -ItemType Directory -Force (Join-Path $awsConfig $cache) | Out-Null }
$work = Join-Path ([IO.Path]::GetTempPath()) "inoxpran-deploy-$([guid]::NewGuid())"
New-Item -ItemType Directory $work | Out-Null
$awsArgs = @('-e', "AWS_PROFILE=$Profile", '-e', "AWS_REGION=$region",
  '-v', "${awsConfig}:/root/.aws:ro", '-v', "$(Join-Path $awsConfig 'sso\cache'):/root/.aws/sso/cache", '-v', "$(Join-Path $awsConfig 'cli\cache'):/root/.aws/cli/cache",
  '-v', "${work}:/in:ro")

function Invoke-Aws([string[]]$Arguments) {
  $output = & docker @(@('run', '--rm') + $awsArgs + @($awsCli) + $Arguments + @('--output', 'text'))
  if ($LASTEXITCODE -ne 0) { throw "AWS CLI thất bại: aws $($Arguments -join ' ')" }
  return ($output -join "`n").Trim()
}

function Test-Aws([string[]]$Arguments) {
  $ErrorActionPreference = 'Continue'
  & docker @(@('run', '--rm') + $awsArgs + @($awsCli) + $Arguments) 2>&1 | Out-Null
  return $LASTEXITCODE -eq 0
}

function Test-Parameter([string]$Key) { return Test-Aws @('ssm', 'get-parameter', '--name', "$prefix/$Key") }

# Windows PowerShell 5.1 làm mất dấu nháy kép khi truyền JSON cho chương trình ngoài → ghi JSON ra file trong thư mục tạm.
function Write-Input([string]$File, $Value) {
  [IO.File]::WriteAllText((Join-Path $work $File), ($Value | ConvertTo-Json -Depth 6 -Compress))
  return "file:///in/$File"
}

function Set-Secret([string]$Key, [string]$Value) {
  if ($Value.Contains("'")) { throw "$Key không được chứa dấu nháy đơn." }
  $inputFile = Write-Input 'secret.json' @{ Name = "$prefix/$Key"; Value = $Value; Type = 'SecureString'; Overwrite = $true }
  try { Invoke-Aws @('ssm', 'put-parameter', '--cli-input-json', $inputFile) | Out-Null }
  finally { Remove-Item (Join-Path $work 'secret.json') -ErrorAction SilentlyContinue }
  Write-Host "  Đã ghi $prefix/$Key" -ForegroundColor Green
}

function New-RandomSecret {
  $bytes = New-Object byte[] 48
  [Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
  return [Convert]::ToBase64String($bytes)
}

# Mật khẩu chỉ gồm chữ và số (dễ gõ, không vướng ký tự đặc biệt của shell / chuỗi kết nối).
function New-RandomPassword([int]$Length = 18) {
  $alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789'
  $bytes = New-Object byte[] $Length
  [Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
  return -join ($bytes | ForEach-Object { $alphabet[$_ % $alphabet.Length] })
}

function Get-Instance {
  $row = Invoke-Aws @('ec2', 'describe-instances', '--filters', "Name=tag:Name,Values=$name", 'Name=instance-state-name,Values=pending,running,stopping,stopped',
    '--query', 'Reservations[].Instances[].[InstanceId,State.Name]')
  if (-not $row) { throw "Không thấy máy $name — chạy .\infra\tf.ps1 apply -Stack $Environment trước." }
  $parts = $row -split '\s+'
  return @{ Id = $parts[0]; State = $parts[1] }
}

# Chạy lệnh trên máy chủ qua SSM Run Command, chờ xong và in kết quả.
# PowerShell 5.1 thêm CRLF khi pipe chuỗi sang chương trình ngoài → ECR báo 400; đưa token qua file không xuống dòng.
function Connect-Registry {
  $tokenFile = Join-Path $work 'ecr-token'
  [IO.File]::WriteAllText($tokenFile, (Invoke-Aws @('ecr', 'get-login-password')))
  & cmd /c "docker login --username AWS --password-stdin $registry < `"$tokenFile`""
  $loginExit = $LASTEXITCODE
  Remove-Item $tokenFile
  if ($loginExit -ne 0) { throw 'Đăng nhập ECR thất bại.' }
}

function Invoke-Remote([string]$Script, [int]$TimeoutSeconds = 900) {
  $instance = Get-Instance
  $parameters = Write-Input 'command.json' @{ commands = @($Script); executionTimeout = @("$TimeoutSeconds") }
  $commandId = Invoke-Aws @('ssm', 'send-command', '--instance-ids', $instance.Id, '--document-name', 'AWS-RunShellScript',
    '--parameters', $parameters, '--timeout-seconds', '60', '--query', 'Command.CommandId')
  $status = 'Pending'
  while ($status -in @('Pending', 'InProgress', 'Delayed', '')) {
    Start-Sleep -Seconds 5
    $ErrorActionPreference = 'Continue'
    $status = (& docker @(@('run', '--rm') + $awsArgs + @($awsCli, 'ssm', 'get-command-invocation', '--command-id', $commandId, '--instance-id', $instance.Id, '--query', 'Status', '--output', 'text')) 2>$null) -join ''
    $ErrorActionPreference = 'Stop'
    Write-Host '.' -NoNewline
  }
  Write-Host ''
  Invoke-Aws @('ssm', 'get-command-invocation', '--command-id', $commandId, '--instance-id', $instance.Id, '--query', '[StandardOutputContent,StandardErrorContent]') | Write-Host
  if ($status -ne 'Success') { throw "Lệnh trên máy chủ kết thúc với trạng thái $status." }
}

try {
  $account = Invoke-Aws @('sts', 'get-caller-identity', '--query', 'Account')
  $registry = "$account.dkr.ecr.$region.amazonaws.com"
  Write-Host "== $Environment (account $account)" -ForegroundColor Cyan

  if ($ShowDemoPassword) {
    Write-Host "Mật khẩu chung tài khoản demo: $(Invoke-Aws @('ssm', 'get-parameter', '--name', "$prefix/DEMO_USER_PASSWORD", '--with-decryption', '--query', 'Parameter.Value'))"
    return
  }

  # Bí mật tự sinh lần đầu, sau đó giữ nguyên (đổi JWT_SECRET đăng xuất mọi người; đổi MFA_ENCRYPTION_KEY làm mất MFA đã cài;
  # mật khẩu MongoDB do mongo-init.js đồng bộ mỗi lần khởi động).
  foreach ($key in @('JWT_SECRET', 'MFA_ENCRYPTION_KEY', 'MONGO_KEYFILE')) {
    if (-not (Test-Parameter $key)) { Set-Secret $key (New-RandomSecret) }
  }
  foreach ($key in @('MONGO_ROOT_PASSWORD', 'MONGO_APP_PASSWORD')) {
    if (-not (Test-Parameter $key)) { Set-Secret $key (New-RandomPassword 32) }
  }

  if ($SkipBuild -and $PSBoundParameters.ContainsKey('Tag')) {
    # Quay lại bản cũ: image phải còn trong ECR.
    foreach ($app in @('api', 'web')) {
      if (-not (Test-Aws @('ecr', 'describe-images', '--repository-name', "$repoBase-$app", '--image-ids', "imageTag=$Tag"))) { throw "Không có image $repoBase-$app`:$Tag trong ECR." }
    }
    Write-Host "== Chuyển về bản $Tag" -ForegroundColor Cyan
    Invoke-Aws @('ssm', 'put-parameter', '--name', "$prefix/IMAGE_TAG", '--type', 'String', '--value', $Tag, '--overwrite') | Out-Null
  } elseif ($production -and -not $SkipBuild -and $PSBoundParameters.ContainsKey('Tag')) {
    # Phát hành đúng image đã kiểm thử trên staging: kéo về, gắn tên kho production, đẩy lên (ECR dùng lại layer, không build lại).
    Write-Host "== Phát hành image staging $Tag lên production" -ForegroundColor Cyan
    Connect-Registry
    foreach ($app in @('api', 'web')) {
      $sourceRepo = "$project-staging-$app"
      if (-not (Test-Aws @('ecr', 'describe-images', '--repository-name', $sourceRepo, '--image-ids', "imageTag=$Tag"))) {
        throw "Không có image $sourceRepo`:$Tag — tag phải là bản đã deploy lên staging (SSM /$project/staging/IMAGE_TAG)."
      }
      $target = "$registry/$repoBase-${app}:$Tag"
      if (Test-Aws @('ecr', 'describe-images', '--repository-name', "$repoBase-$app", '--image-ids', "imageTag=$Tag")) { Write-Host "  $target đã có"; continue }
      & docker pull "$registry/${sourceRepo}:$Tag"
      if ($LASTEXITCODE -ne 0) { throw "Kéo image $sourceRepo thất bại." }
      & docker tag "$registry/${sourceRepo}:$Tag" $target
      & docker push $target
      if ($LASTEXITCODE -ne 0) { throw "Đẩy image $app thất bại." }
    }
    Invoke-Aws @('ssm', 'put-parameter', '--name', "$prefix/IMAGE_TAG", '--type', 'String', '--value', $Tag, '--overwrite') | Out-Null
  } elseif (-not $SkipBuild) {
    Write-Host "== Build và đẩy image $Tag" -ForegroundColor Cyan
    foreach ($app in @('api', 'web')) {
      & docker build -f (Join-Path $root "Dockerfile.$app") -t "$registry/$repoBase-${app}:$Tag" $root
      if ($LASTEXITCODE -ne 0) { throw "Build image $app thất bại." }
    }
    Connect-Registry
    foreach ($app in @('api', 'web')) {
      & docker push "$registry/$repoBase-${app}:$Tag"
      if ($LASTEXITCODE -ne 0) { throw "Đẩy image $app thất bại." }
    }
    Invoke-Aws @('ssm', 'put-parameter', '--name', "$prefix/IMAGE_TAG", '--type', 'String', '--value', $Tag, '--overwrite') | Out-Null
  }

  # Khởi động / cập nhật ứng dụng: đồng bộ file vận hành từ S3 rồi chạy start.sh (chỉ tạo lại container có thay đổi).
  $instance = Get-Instance
  if ($instance.State -eq 'running') {
    Write-Host '== Cập nhật máy chủ' -ForegroundColor Cyan
    Invoke-Remote 'if [ -x /opt/inoxpran/bootstrap.sh ]; then /opt/inoxpran/bootstrap.sh; else /opt/inoxpran/start.sh; fi && cd /opt/inoxpran && docker compose ps --format "table {{.Service}}\t{{.Status}}"'
  } else {
    # Máy đang tắt (theo lịch giờ làm việc): bật lên, khi khởi động máy tự chạy phiên bản hiện tại.
    Write-Host "== Máy đang $($instance.State) — bật máy, ứng dụng sẽ chạy khi khởi động" -ForegroundColor Yellow
    Invoke-Aws @('ec2', 'start-instances', '--instance-ids', $instance.Id) | Out-Null
  }

  if ($SeedDemo) {
    Write-Host '== Nạp dữ liệu trình diễn' -ForegroundColor Cyan
    if (-not (Test-Parameter 'DEMO_USER_PASSWORD')) { Set-Secret 'DEMO_USER_PASSWORD' (New-RandomPassword) }
    # Máy chủ tự đọc mật khẩu demo từ SSM (không đi qua lệnh/nhật ký). seed-demo tự chặn khi NODE_ENV=production
    # để bảo vệ production; staging cố ý chạy với development.
    Invoke-Remote 'cd /opt/inoxpran && . ./base.env && pw="$(aws ssm get-parameter --region "$AWS_REGION" --name "$PARAM_PREFIX/DEMO_USER_PASSWORD" --with-decryption --query Parameter.Value --output text)" && docker compose run --rm --no-deps -e NODE_ENV=development -e DEMO_USER_PASSWORD="$pw" api node apps/api/dist/scripts/seed-demo.js' 1800
    Write-Host "Mật khẩu tài khoản demo: chạy lại với -ShowDemoPassword, hoặc AWS Console → Systems Manager → Parameter Store → $prefix/DEMO_USER_PASSWORD → Show decrypted value." -ForegroundColor Green
  }

  if ($SeedAdmin) {
    Write-Host "== Tạo tài khoản quản trị gốc $SeedAdmin" -ForegroundColor Cyan
    $script = 'cd /opt/inoxpran && pw="$(openssl rand -base64 18)" && docker compose run --rm --no-deps -e ADMIN_EMAIL={0} -e ADMIN_PASSWORD="$pw" api node apps/api/dist/scripts/seed-admin.js && echo "Mật khẩu quản trị (chỉ hiện lần này): $pw"' -f $SeedAdmin
    Invoke-Remote $script
  }

  if ($BackupNow) {
    Write-Host '== Sao lưu ngay' -ForegroundColor Cyan
    Invoke-Remote '/opt/inoxpran/backup.sh' 1800
  }

  if ($RestoreDrill) {
    Write-Host '== Diễn tập khôi phục từ bản sao lưu mới nhất' -ForegroundColor Cyan
    Invoke-Remote '/opt/inoxpran/restore-drill.sh' 1800
  }
} finally {
  Remove-Item -Recurse -Force $work
}
