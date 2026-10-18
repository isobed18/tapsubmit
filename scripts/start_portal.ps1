param([int]$Port = 8788, [string]$PublicOrigin='https://tapsubmit.com', [ValidateSet('discovery','local')][string]$Mode='discovery', [string]$DataDirectory, [switch]$Refresh)
$ErrorActionPreference = 'Stop'
$taskProjectRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).Path
$taskPortalDirectory = Join-Path $taskProjectRoot '.data\portal'
if (!$DataDirectory) { $DataDirectory = Join-Path $taskProjectRoot ('.data\'+$(if ($Mode -eq 'discovery') {'discovery'} else {'portal'})) }
New-Item -ItemType Directory -Path $DataDirectory -Force | Out-Null
New-Item -ItemType Directory -Path $taskPortalDirectory -Force | Out-Null
$taskServerPath = Join-Path $taskProjectRoot 'web\server.mjs'
$taskNodePath = (Get-Command node -ErrorAction Stop).Source
$taskPidFile = Join-Path $taskPortalDirectory 'server-process.json'
if (Test-Path -LiteralPath $taskPidFile) {
    $taskPrevious = Get-Content -LiteralPath $taskPidFile -Raw | ConvertFrom-Json
    $taskExisting = Get-CimInstance Win32_Process -Filter ('ProcessId=' + $taskPrevious.process_id)
    if ($taskExisting -and $taskExisting.CommandLine.Contains($taskServerPath)) {
        Write-Output ('ApplyBurst is already running on port ' + $taskPrevious.port)
        exit 0
    }
}
$taskArguments = @('--no-warnings=ExperimentalWarning', ('"' + $taskServerPath + '"'))
if ($Refresh) { $taskArguments += '--refresh' }
$env:APPLYBURST_PORT = [string]$Port
$env:APPLYBURST_PUBLIC_ORIGIN = $PublicOrigin
$env:APPLYBURST_MODE = $Mode
$env:APPLYBURST_DATA = $DataDirectory
if (!$env:APPLYBURST_MODEL_CACHE -and (Test-Path -LiteralPath 'D:\cache\models')) { $env:APPLYBURST_MODEL_CACHE = 'D:\cache\models' }
$taskProcess = Start-Process -FilePath $taskNodePath -ArgumentList $taskArguments -WorkingDirectory $taskProjectRoot -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $taskPortalDirectory 'server.stdout.log') -RedirectStandardError (Join-Path $taskPortalDirectory 'server.stderr.log')
@{process_id=$taskProcess.Id;port=$Port;project=$taskProjectRoot;started_at=(Get-Date).ToUniversalTime().ToString('o')} | ConvertTo-Json | Set-Content -LiteralPath $taskPidFile
for ($taskAttempt=0; $taskAttempt -lt 30; $taskAttempt++) {
    try {
        $taskHealth = Invoke-RestMethod -Uri ('http://127.0.0.1:' + $Port + '/healthz') -TimeoutSec 1
        if ($taskHealth.status -eq 'ok') { Write-Output ('ApplyBurst ready: http://127.0.0.1:' + $Port + '/applyburst/ (PID ' + $taskProcess.Id + ')'); exit 0 }
    } catch {}
    Start-Sleep -Milliseconds 250
}
throw 'The portal did not become ready. Inspect .data/portal/server.stderr.log.'
