$ErrorActionPreference = 'Stop'
$taskProjectRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).Path
$taskServerPath = Join-Path $taskProjectRoot 'web\server.mjs'
$taskPidFile = Join-Path $taskProjectRoot '.data\portal\server-process.json'
if (!(Test-Path -LiteralPath $taskPidFile)) { Write-Output 'No managed portal process.'; exit 0 }
$taskMetadata = Get-Content -LiteralPath $taskPidFile -Raw | ConvertFrom-Json
$taskProcess = Get-CimInstance Win32_Process -Filter ('ProcessId=' + $taskMetadata.process_id)
if ($taskProcess) {
    if (!$taskProcess.CommandLine.Contains($taskServerPath)) { throw 'PID belongs to another process. Nothing was stopped.' }
    Stop-Process -Id $taskProcess.ProcessId
}
Write-Output 'ApplyBurst stopped.'
