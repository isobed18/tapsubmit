"""Run the current source against the user's existing local workspace; no installer rebuild."""
import json
import os
import secrets
import socket
import subprocess
import sys
import time
import webbrowser
from pathlib import Path
from urllib.request import urlopen

root=Path(__file__).resolve().parents[1]
directory=root/'.data/desktop-live';directory.mkdir(parents=True,exist_ok=True)
port=int(os.environ.get('APPLYBURST_LOCAL_PORT','53357'));origin=f'http://127.0.0.1:{port}'
with socket.socket() as sock:
    if sock.connect_ex(('127.0.0.1',port))==0:
        print('Local workspace is already listening: '+origin+'/applyburst/');sys.exit(0)
ticket=secrets.token_urlsafe(32)
env={**os.environ,'APPLYBURST_DATA':str(directory),'APPLYBURST_PORT':str(port),'APPLYBURST_MODE':'local','APPLYBURST_DESKTOP_TICKET':ticket,'APPLYBURST_PYTHON':str(root/'.venv/Scripts/python.exe')}
env.pop('APPLYBURST_WORKER',None)
out=open(directory/'source-server.stdout.log','a',encoding='utf8');err=open(directory/'source-server.stderr.log','a',encoding='utf8')
node=__import__('shutil').which('node');assert node,'Node is not installed in this development environment.'
process=subprocess.Popen([node,str(root/'web/server.mjs')],cwd=root,env=env,stdout=out,stderr=err,creationflags=0x08000000 if os.name=='nt' else 0)
(directory/'source-process.json').write_text(json.dumps({'process_id':process.pid,'port':port,'root':str(root),'url':origin+'/applyburst/'}),encoding='utf8')
for _ in range(60):
    try:
        with urlopen(origin+'/healthz',timeout=1) as response:
            if json.load(response)['status']=='ok':break
    except Exception:
        if process.poll() is not None:raise RuntimeError('Source server stopped. Check the local stderr log.')
        time.sleep(.25)
else:raise RuntimeError('Source server did not become ready.')
webbrowser.open(origin+'/applyburst/desktop/start?ticket='+ticket)
print('Current local application ready: '+origin+'/applyburst/ (PID '+str(process.pid)+')')
