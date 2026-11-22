# Installs the single-executable exporter as a scheduled task that starts at logon and restarts
# on failure (docs/NATIVE.md). Run in PowerShell as the user who should own the data:
#   powershell -ExecutionPolicy Bypass -File packaging\install-windows.ps1 .\ecoflow-exporter-win-x64.exe
# Data and .env live in %LOCALAPPDATA%\ecoflow-exporter. Uninstall: -Uninstall.
param(
  [Parameter(Position = 0)] [string] $Source,
  [switch] $Uninstall
)
$ErrorActionPreference = 'Stop'
$name = 'ecoflow-exporter'
$data = Join-Path $env:LOCALAPPDATA $name
$bin = Join-Path $data 'ecoflow-exporter.exe'

if ($Uninstall) {
  Stop-ScheduledTask -TaskName $name -ErrorAction SilentlyContinue
  Unregister-ScheduledTask -TaskName $name -Confirm:$false -ErrorAction SilentlyContinue
  Remove-Item $bin -ErrorAction SilentlyContinue
  Write-Host "Removed the task and the binary. Your data is still in $data (delete it yourself)."
  exit 0
}
if (-not $Source) { throw 'usage: install-windows.ps1 <path to ecoflow-exporter .exe> | -Uninstall' }

New-Item -ItemType Directory -Force -Path $data | Out-Null
Copy-Item $Source $bin -Force
Unblock-File $bin
& $bin --self-check
if ($LASTEXITCODE -ne 0) { throw 'self-check failed' }
$envFile = Join-Path $data '.env'
if (-not (Test-Path $envFile)) { Set-Content $envFile '# See .env.example in the repository. The status page is http://127.0.0.1:9101/' }

$action = New-ScheduledTaskAction -Execute $bin -WorkingDirectory $data
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
  -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1)
Register-ScheduledTask -TaskName $name -Action $action -Trigger $trigger -Settings $settings -Force | Out-Null
Start-ScheduledTask -TaskName $name
Write-Host "Running. Status page: http://127.0.0.1:9101/  Data: $data"
