param([switch]$Installer,[switch]$SkipCompile,[switch]$PackageOnly)
$ErrorActionPreference='Stop'
$taskRoot=(Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).Path
Set-Location -LiteralPath $taskRoot
$taskPython=Join-Path $taskRoot '.venv\Scripts\python.exe'
$taskRunningBundle=Join-Path $taskRoot 'dist\ApplyBurst'
$taskRunning=Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -and ($_.ExecutablePath -eq (Join-Path $taskRunningBundle 'ApplyBurst.exe') -or $_.ExecutablePath -eq (Join-Path $taskRunningBundle 'runtime\node.exe')) }
if ($taskRunning -and !$PackageOnly) { throw 'Close the portable ApplyBurst preview before rebuilding it. The public portal can stay running.' }
$env:PYINSTALLER_CONFIG_DIR='D:\cache\pyinstaller'
# Explicit hidden imports: exclude JobSpy/pandas/numpy/model stacks; discovery is plain Node HTTP.
if (!$PackageOnly) {
if (!$SkipCompile) {
$taskPreferenceData=(Join-Path $taskRoot 'config\preference_intents.json')+':config'
& $taskPython -m PyInstaller --noconfirm --onedir --name ApplyBurstWorker --distpath dist\worker-build --workpath build\worker --specpath build --paths . --collect-all playwright --add-data $taskPreferenceData --hidden-import applyburst.companion --hidden-import applyburst.live_search --exclude-module jobspy --exclude-module pandas --exclude-module numpy --exclude-module torch --exclude-module matplotlib --exclude-module pytest desktop\worker.py
if ($LASTEXITCODE) { throw 'Worker build failed' }
& $taskPython -m PyInstaller --noconfirm --onedir --windowed --name ApplyBurst --distpath dist --workpath build\launcher --specpath build desktop\launcher.py
if ($LASTEXITCODE) { throw 'Launcher build failed' }
}
$taskBundle=Join-Path $taskRoot 'dist\ApplyBurst'
New-Item -ItemType Directory -Path (Join-Path $taskBundle 'runtime'),(Join-Path $taskBundle 'app\web'),(Join-Path $taskBundle 'app\demo') -Force | Out-Null
Copy-Item -LiteralPath (Get-Command node).Source -Destination (Join-Path $taskBundle 'runtime\node.exe')
New-Item -ItemType Directory -Path (Join-Path $taskBundle 'runtime\worker') -Force | Out-Null
Get-ChildItem -LiteralPath (Join-Path $taskRoot 'dist\worker-build\ApplyBurstWorker') | ForEach-Object { Copy-Item -LiteralPath $_.FullName -Destination (Join-Path $taskBundle 'runtime\worker') -Recurse -Force }
foreach ($taskPath in @('web\server.mjs','web\search-worker.mjs','web\crawl-worker.mjs','web\shared','web\lib','web\public','config','scripts')) {
    $taskDest=Join-Path $taskBundle ('app\'+(Split-Path $taskPath -Parent))
    New-Item -ItemType Directory -Path $taskDest -Force | Out-Null
    Copy-Item -LiteralPath (Join-Path $taskRoot $taskPath) -Destination $taskDest -Recurse -Force
}
Copy-Item -LiteralPath (Join-Path $taskRoot 'demo\lib') -Destination (Join-Path $taskBundle 'app\demo\lib') -Recurse -Force
New-Item -ItemType Directory -Path (Join-Path $taskBundle 'app\demo\public') -Force | Out-Null
foreach ($taskFile in @('search-engine.mjs','jobs.json')) { Copy-Item -LiteralPath (Join-Path $taskRoot ('demo\public\'+$taskFile)) -Destination (Join-Path $taskBundle ('app\demo\public\'+$taskFile)) }
Copy-Item -LiteralPath (Join-Path $taskRoot 'LICENSE') -Destination $taskBundle
# CPU encoder runtime for Windows x64 only: the transformers.js Node build, ONNX Runtime's win32/x64 binaries
# and sharp (imported by transformers.js). The model itself is downloaded and verified by the launcher.
$taskModules=Join-Path $taskRoot 'web\node_modules'
$taskModulesOut=Join-Path $taskBundle 'app\web\node_modules'
if (Test-Path -LiteralPath $taskModulesOut) { Remove-Item -LiteralPath $taskModulesOut -Recurse -Force }
$taskRuntimeModules=@('@huggingface\transformers\package.json','@huggingface\transformers\LICENSE','@huggingface\transformers\dist\transformers.node.mjs','onnxruntime-common','onnxruntime-node\package.json','onnxruntime-node\dist','onnxruntime-node\bin\napi-v3\win32\x64','sharp\package.json','sharp\LICENSE','sharp\lib','@img\sharp-win32-x64','@img\colour','detect-libc','semver')
foreach ($taskItem in $taskRuntimeModules) {
    $taskFrom=Join-Path $taskModules $taskItem
    $taskTo=Join-Path $taskModulesOut $taskItem
    if (!(Test-Path -LiteralPath $taskFrom)) { throw ('Missing runtime module: '+$taskItem+'. Run npm install in web.') }
    New-Item -ItemType Directory -Path (Split-Path $taskTo -Parent) -Force | Out-Null
    Copy-Item -LiteralPath $taskFrom -Destination $taskTo -Recurse -Force
}
Copy-Item -LiteralPath (Join-Path $taskRoot 'web\package.json') -Destination (Join-Path $taskBundle 'app\web\package.json') -Force
}
$taskBundle=Join-Path $taskRoot 'dist\ApplyBurst'
& $taskPython -c "from pathlib import Path; from zipfile import ZipFile,ZIP_DEFLATED; root=Path('dist/ApplyBurst'); out=Path('dist/ApplyBurst-payload.zip'); files=[p for p in root.rglob('*') if p.is_file() and 'data' not in p.relative_to(root).parts]; z=ZipFile(out,'w',ZIP_DEFLATED,compresslevel=6,strict_timestamps=False); [z.write(p,p.relative_to(root)) for p in files]; z.close(); z=ZipFile(out); required=['ApplyBurst.exe','runtime/node.exe','runtime/worker/ApplyBurstWorker.exe','app/web/server.mjs','app/web/public/minimal.js','app/web/node_modules/@huggingface/transformers/dist/transformers.node.mjs','app/web/node_modules/onnxruntime-node/bin/napi-v3/win32/x64/onnxruntime_binding.node','app/web/node_modules/@img/sharp-win32-x64/lib/sharp-win32-x64.node']; assert all(n in z.namelist() for n in required), 'Incomplete installer payload'; assert z.testzip() is None, 'Corrupt installer payload'; print('Bundle ZIP:',out.stat().st_size,'bytes;',len(z.namelist()),'files')"
if ($LASTEXITCODE) { throw 'Payload creation or integrity verification failed; no installer will be built.' }
if ($Installer) {
    $taskPayload=(Join-Path $taskRoot 'dist\ApplyBurst-payload.zip')+':.'
    & $taskPython -m PyInstaller --noconfirm --onefile --windowed --name ApplyBurst-Setup --distpath dist --workpath build\installer --specpath build --add-data $taskPayload desktop\installer.py
    if ($LASTEXITCODE) { throw 'Installer build failed' }
}
Write-Output ('Desktop app: '+(Join-Path $taskBundle 'ApplyBurst.exe'))
