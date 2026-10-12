<#
.SYNOPSIS
  Giữ cho lệnh cũ chạy được: chuyển sang infra/deploy.ps1 với -Environment staging (xem các ví dụ trong file đó).
#>
param(
  [Parameter(Mandatory = $true)][string]$Profile,
  [string]$Tag,
  [switch]$SkipBuild,
  [switch]$SeedDemo,
  [switch]$ShowDemoPassword,
  [switch]$BackupNow,
  [switch]$RestoreDrill,
  [string]$SeedAdmin
)
$forward = @{} + $PSBoundParameters
& (Join-Path $PSScriptRoot '..\deploy.ps1') @forward -Environment staging
