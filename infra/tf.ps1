<#
.SYNOPSIS
  Chạy Terraform cho hạ tầng INOXPRAN ERP bằng Docker — không cần cài Terraform / AWS CLI lên máy.

.EXAMPLE
  .\infra\tf.ps1 check
  Kiểm tra không cần tài khoản AWS: terraform fmt, validate, tflint, Trivy (lỗi cấu hình bảo mật).

.EXAMPLE
  .\infra\tf.ps1 bootstrap -Profile inoxpran-admin
  Tạo bucket S3 lưu Terraform state (chạy một lần cho mỗi tài khoản AWS).

.EXAMPLE
  .\infra\tf.ps1 plan -Profile inoxpran-readonly
  Xem trước thay đổi (chỉ ĐỌC). Kết quả lưu ở infra/staging/staging.tfplan để người duyệt xem.

.EXAMPLE
  .\infra\tf.ps1 apply -Profile inoxpran-admin
  Áp dụng ĐÚNG bản plan đã duyệt (staging.tfplan). Cần quyền ghi.

.EXAMPLE
  .\infra\tf.ps1 plan -Stack production -Profile inoxpran-admin
  Xem trước thay đổi production (production.tfvars → production.tfplan). Apply production chỉ sau khi người duyệt đồng ý.

.EXAMPLE
  .\infra\tf.ps1 plan -Stack staging -Destroy -Profile inoxpran-admin
  Xem trước việc GỠ BỎ toàn bộ staging (máy, ổ dữ liệu, bucket, kho image). Chặn với production.

.NOTES
  - -Stack staging (mặc định) và -Stack production: một máy EC2 + Docker Compose, dùng chung module
    infra/modules/ec2-app (infra/staging/README.md, infra/production/README.md).
    -Stack ecs: phương án ECS Fargate + ALB khi cần mở rộng (infra/terraform).
  - Thông tin đăng nhập lấy từ %USERPROFILE%\.aws (aws sso login) gắn chỉ-đọc vào container; riêng thư mục
    cache được ghi để làm mới phiên SSO.
#>
param(
  [Parameter(Mandatory = $true, Position = 0)][ValidateSet('check', 'bootstrap', 'plan', 'apply', 'output')][string]$Command,
  [ValidateSet('staging', 'production', 'ecs')][string]$Stack = 'staging',
  [string]$Profile = '',
  [string]$VarFile = '',
  [switch]$Destroy
)

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.Encoding]::UTF8
$stackDir = if ($Stack -eq 'ecs') { 'terraform' } else { $Stack }
$dir = Join-Path $PSScriptRoot $stackDir
if (-not $VarFile) { $VarFile = if ($Stack -eq 'ecs') { 'terraform.tfvars' } else { "$Stack.tfvars" } }
if ($Destroy -and ($Command -ne 'plan' -or $Stack -ne 'staging')) { throw '-Destroy chỉ dùng với: plan -Stack staging (production được bảo vệ, không gỡ bằng script).' }
$terraform = 'hashicorp/terraform:1.13.3'
$tflint = 'ghcr.io/terraform-linters/tflint:v0.53.0'
$trivy = 'aquasec/trivy:0.56.2'
$awsCli = 'amazon/aws-cli:2.27.0'
$region = 'ap-southeast-1'

function Invoke-Docker([string[]]$Arguments) {
  & docker @Arguments
  if ($LASTEXITCODE -ne 0) { throw "Lệnh thất bại (mã $LASTEXITCODE): docker $($Arguments -join ' ')" }
}

# Gắn cả thư mục infra để stack đọc được module dùng chung (../modules/ec2-app).
$mount = @('-v', "${PSScriptRoot}:/infra", '-w', "/infra/$stackDir")

if ($Command -eq 'check') {
  Write-Host "== [$Stack] terraform fmt" -ForegroundColor Cyan
  Invoke-Docker (@('run', '--rm') + $mount + @($terraform, 'fmt', '-check', '-diff', '-recursive'))
  if ($Stack -ne 'ecs') { Invoke-Docker (@('run', '--rm', '-v', "${PSScriptRoot}:/infra", '-w', '/infra/modules', $terraform, 'fmt', '-check', '-diff', '-recursive')) }
  Write-Host "== [$Stack] terraform init + validate" -ForegroundColor Cyan
  # Thư mục làm việc riêng: không đụng backend S3 đã khởi tạo cho plan/apply (check không cần tài khoản AWS).
  $offline = $mount + @('-e', 'TF_DATA_DIR=.terraform-check')
  Invoke-Docker (@('run', '--rm') + $offline + @($terraform, 'init', '-backend=false', '-input=false'))
  Invoke-Docker (@('run', '--rm') + $offline + @($terraform, 'validate'))
  Write-Host "== [$Stack] tflint" -ForegroundColor Cyan
  Invoke-Docker (@('run', '--rm', '-v', "${PSScriptRoot}:/data", '-w', "/data/$stackDir", $tflint, '--format', 'compact'))
  Write-Host "== [$Stack] Trivy (lỗi cấu hình bảo mật, mức MEDIUM trở lên)" -ForegroundColor Cyan
  # Bỏ qua module bên thứ ba tải về khi init (.terraform-check): chỉ quét cấu hình của dự án.
  $scanDirs = if ($Stack -eq 'ecs') { @("/infra/$stackDir") } else { @("/infra/$stackDir", '/infra/modules') }
  foreach ($scanDir in $scanDirs) {
    Invoke-Docker (@('run', '--rm', '-v', "${PSScriptRoot}:/infra", $trivy, 'config', '--skip-check-update', '--quiet', '--severity', 'MEDIUM,HIGH,CRITICAL', '--skip-dirs', "$scanDir/.terraform-check", '--skip-dirs', "$scanDir/.terraform", '--exit-code', '1', $scanDir))
  }
  Write-Host 'Tất cả kiểm tra đều đạt.' -ForegroundColor Green
  exit 0
}

# --- Các lệnh cần tài khoản AWS ---
$awsConfig = Join-Path $env:USERPROFILE '.aws'
if (-not (Test-Path $awsConfig) -and -not $env:AWS_ACCESS_KEY_ID) {
  throw 'Chưa có thông tin đăng nhập AWS: chạy "aws sso login" (xem infra/staging/README.md) hoặc đặt biến AWS_ACCESS_KEY_ID + AWS_SECRET_ACCESS_KEY.'
}
$awsArgs = @('-e', 'AWS_ACCESS_KEY_ID', '-e', 'AWS_SECRET_ACCESS_KEY', '-e', 'AWS_SESSION_TOKEN', '-e', "AWS_REGION=$region")
if (Test-Path $awsConfig) {
  foreach ($cache in @('sso\cache', 'cli\cache')) { New-Item -ItemType Directory -Force (Join-Path $awsConfig $cache) | Out-Null }
  $awsArgs += @('-v', "${awsConfig}:/root/.aws:ro", '-v', "$(Join-Path $awsConfig 'sso\cache'):/root/.aws/sso/cache", '-v', "$(Join-Path $awsConfig 'cli\cache'):/root/.aws/cli/cache")
}
if ($Profile) { $awsArgs += @('-e', "AWS_PROFILE=$Profile") }

function Invoke-Aws([string[]]$Arguments, [string[]]$Extra = @()) {
  $output = & docker @(@('run', '--rm') + $awsArgs + $Extra + @($awsCli) + $Arguments + @('--output', 'text'))
  if ($LASTEXITCODE -ne 0) { throw "AWS CLI thất bại: aws $($Arguments -join ' ')" }
  return $output
}

$account = (Invoke-Aws @('sts', 'get-caller-identity', '--query', 'Account')).Trim()
$stateBucket = "inoxpran-erp-tfstate-$account"
Write-Host "Tài khoản AWS: $account" -ForegroundColor DarkGray

if ($Command -eq 'bootstrap') {
  # PowerShell 5.1 coi dòng stderr của chương trình ngoài là lỗi khi ErrorActionPreference = Stop.
  $ErrorActionPreference = 'Continue'
  & docker @(@('run', '--rm') + $awsArgs + @($awsCli, 's3api', 'head-bucket', '--bucket', $stateBucket)) 2>&1 | Out-Null
  $exists = $LASTEXITCODE -eq 0
  $ErrorActionPreference = 'Stop'
  if ($exists) { Write-Host "Bucket state $stateBucket đã có." -ForegroundColor Green; exit 0 }
  # Windows PowerShell 5.1 làm mất dấu nháy kép khi truyền JSON cho chương trình ngoài → ghi ra file rồi gắn vào container.
  $tmp = Join-Path ([IO.Path]::GetTempPath()) "inoxpran-bootstrap-$([guid]::NewGuid())"
  New-Item -ItemType Directory $tmp | Out-Null
  try {
    $policy = @{ Version = '2012-10-17'; Statement = @(@{ Sid = 'DenyInsecureTransport'; Effect = 'Deny'; Principal = '*'; Action = 's3:*'; Resource = @("arn:aws:s3:::$stateBucket", "arn:aws:s3:::$stateBucket/*"); Condition = @{ Bool = @{ 'aws:SecureTransport' = 'false' } } }) }
    [IO.File]::WriteAllText((Join-Path $tmp 'policy.json'), ($policy | ConvertTo-Json -Depth 8))
    [IO.File]::WriteAllText((Join-Path $tmp 'encryption.json'), '{"Rules":[{"ApplyServerSideEncryptionByDefault":{"SSEAlgorithm":"AES256"}}]}')
    $files = @('-v', "${tmp}:/in:ro")
    Invoke-Aws @('s3api', 'create-bucket', '--bucket', $stateBucket, '--create-bucket-configuration', "LocationConstraint=$region") | Out-Null
    Invoke-Aws @('s3api', 'put-public-access-block', '--bucket', $stateBucket, '--public-access-block-configuration', 'BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true') | Out-Null
    Invoke-Aws @('s3api', 'put-bucket-versioning', '--bucket', $stateBucket, '--versioning-configuration', 'Status=Enabled') | Out-Null
    Invoke-Aws @('s3api', 'put-bucket-encryption', '--bucket', $stateBucket, '--server-side-encryption-configuration', 'file:///in/encryption.json') $files | Out-Null
    Invoke-Aws @('s3api', 'put-bucket-policy', '--bucket', $stateBucket, '--policy', 'file:///in/policy.json') $files | Out-Null
  } finally {
    Remove-Item -Recurse -Force $tmp
  }
  Write-Host "Đã tạo bucket state $stateBucket (chặn public, mã hóa, lưu phiên bản, chỉ nhận TLS)." -ForegroundColor Green
  exit 0
}

$initArgs = @('init', '-input=false', '-reconfigure')
if ($Stack -ne 'ecs') { $initArgs += "-backend-config=bucket=$stateBucket" }
Invoke-Docker (@('run', '--rm') + $mount + $awsArgs + @($terraform) + $initArgs)

$planFile = [IO.Path]::GetFileNameWithoutExtension($VarFile) + '.tfplan'
switch ($Command) {
  'plan' {
    if (-not (Test-Path (Join-Path $dir $VarFile))) {
      throw "Không thấy $VarFile trong $dir. Sao chép $VarFile.example (hoặc terraform.tfvars.example) và điền giá trị."
    }
    # Plan chỉ đọc state (quyền ReadOnlyAccess không ghi được file khóa).
    $planArgs = @('plan', '-input=false', '-lock=false', "-var-file=$VarFile", "-out=$planFile")
    if ($Destroy) { $planArgs += '-destroy' }
    Invoke-Docker (@('run', '--rm') + $mount + $awsArgs + @($terraform) + $planArgs)
    if ($Destroy) { Write-Host 'BẢN PLAN NÀY XÓA TOÀN BỘ STAGING (kể cả dữ liệu) — đọc kỹ trước khi apply.' -ForegroundColor Red }
    Write-Host "Đã lưu bản plan: $planFile — chưa có gì thay đổi trên AWS. Người duyệt xem xong thì chạy: .\infra\tf.ps1 apply -Stack $Stack -Profile <hồ sơ có quyền ghi>" -ForegroundColor Green
  }
  'apply' {
    if (-not (Test-Path (Join-Path $dir $planFile))) { throw "Chưa có bản plan $planFile — chạy lệnh plan trước." }
    Invoke-Docker (@('run', '--rm') + $mount + $awsArgs + @($terraform, 'apply', '-input=false', $planFile))
    Remove-Item (Join-Path $dir $planFile)
    Invoke-Docker (@('run', '--rm') + $mount + $awsArgs + @($terraform, 'output'))
  }
  'output' {
    Invoke-Docker (@('run', '--rm') + $mount + $awsArgs + @($terraform, 'output'))
  }
}
