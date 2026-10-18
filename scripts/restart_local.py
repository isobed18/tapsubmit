"""Restart the source-run local workspace without opening a new browser tab (sessions persist in its database)."""
import json
import os
import shutil
import subprocess
import time
from pathlib import Path
from urllib.request import urlopen

root = Path(__file__).resolve().parents[1]
directory = root / '.data/desktop-live'
record = directory / 'source-process.json'
meta = json.loads(record.read_text(encoding='utf8'))
port = meta['port']
listing = subprocess.run(['powershell', '-NoProfile', '-Command', f"$c=Get-NetTCPConnection -LocalPort {port} -State Listen -ErrorAction SilentlyContinue|Select-Object -First 1;if($c){{$p=Get-CimInstance Win32_Process -Filter ('ProcessId='+$c.OwningProcess);$c.OwningProcess;$p.CommandLine}}"], capture_output=True, text=True).stdout.splitlines()
if listing:
    pid, command = int(listing[0]), ' '.join(listing[1:])
    if pid != meta['process_id'] or r'web\server.mjs' not in command:
        raise SystemExit(f'Port {port} is not the recorded local workspace; nothing stopped.')
    children = subprocess.run(['powershell', '-NoProfile', '-Command', f"(Get-CimInstance Win32_Process | Where-Object {{ $_.ParentProcessId -eq {pid} -and $_.Name -ne 'conhost.exe' }}).Count"], capture_output=True, text=True).stdout.strip()
    if children not in ('', '0'):
        raise SystemExit('A browser task is active in the local workspace; not restarting.')
    subprocess.run(['powershell', '-NoProfile', '-Command', f'Stop-Process -Id {pid} -Confirm:$false'], check=True)
    time.sleep(1)
env = {**os.environ, 'APPLYBURST_DATA': str(directory), 'APPLYBURST_PORT': str(port), 'APPLYBURST_MODE': 'local', 'APPLYBURST_PYTHON': str(root / '.venv/Scripts/python.exe')}
env.pop('APPLYBURST_WORKER', None)
env.pop('APPLYBURST_DESKTOP_TICKET', None)
if Path('D:/cache/models').is_dir():
    env.setdefault('APPLYBURST_MODEL_CACHE', 'D:/cache/models')
out = open(directory / 'source-server.stdout.log', 'a', encoding='utf8')
err = open(directory / 'source-server.stderr.log', 'a', encoding='utf8')
process = subprocess.Popen([shutil.which('node'), str(root / 'web/server.mjs')], cwd=root, env=env, stdout=out, stderr=err, creationflags=0x08000000 if os.name == 'nt' else 0)
record.write_text(json.dumps({**meta, 'process_id': process.pid}), encoding='utf8')
for _ in range(80):
    try:
        with urlopen(f'http://127.0.0.1:{port}/healthz', timeout=1) as response:
            if json.load(response)['status'] == 'ok':
                print(f'Local workspace restarted on port {port} (PID {process.pid}); existing browser tabs keep working.')
                break
    except Exception:
        time.sleep(0.25)
else:
    raise SystemExit('The local workspace did not become ready; see source-server.stderr.log.')
