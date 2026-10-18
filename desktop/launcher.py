"""Nontechnical Windows launcher: bundled runtimes, local server, local browser sessions."""
import json
import hashlib
import os
import secrets
import socket
import subprocess
import sys
import threading
import time
import tkinter as tk
from pathlib import Path
from tkinter import filedialog,messagebox,ttk
from urllib.request import urlopen,Request
import webbrowser

CREATE_NO_WINDOW=0x08000000 if os.name=='nt' else 0
# The small multilingual CV/form reader (CPU, int8 ONNX). Pinned revision; every file is size- and hash-checked.
MODEL={'id':'Xenova/paraphrase-multilingual-MiniLM-L12-v2','revision':'2c4055b12046f11709e9df2c122e59ffbdc2f900','files':[
    ('config.json',673,'05b570bff786faa5c4604152aa16f19f77ed6dfc31e47dd0f3dd987078693ac7'),
    ('tokenizer_config.json',496,'3f5961b9ac86288cccdb97f32fb848d6187c78e1603958c53f3ea1f296b7d8a2'),
    ('tokenizer.json',17082913,'b60b6b43406a48bf3638526314f3d232d97058bc93472ff2de930d43686fa441'),
    ('onnx/model_quantized.onnx',118308126,'66fc00f5f29afcaff34092e1bdd20008ca3918265a82fb9695a551e510cc4ebc')]}

def model_folder(data):return data/'models'/MODEL['id']

def model_ready(data):
    folder=model_folder(data);return all((folder/name).is_file() and (folder/name).stat().st_size==size for name,size,_ in MODEL['files'])

def download_model(data,progress):
    """Download into .part files, verify size and SHA-256, then move into place. Resumes by file."""
    folder=model_folder(data);total=sum(size for _,size,_ in MODEL['files']);done=0
    for name,size,digest in MODEL['files']:
        target=folder/name
        if target.is_file() and target.stat().st_size==size:done+=size;progress(done,total);continue
        target.parent.mkdir(parents=True,exist_ok=True);part=target.with_name(target.name+'.part');hasher=hashlib.sha256();got=0
        url='https://huggingface.co/'+MODEL['id']+'/resolve/'+MODEL['revision']+'/'+name
        with urlopen(Request(url,headers={'User-Agent':'ApplyBurst-desktop'}),timeout=30) as response,part.open('wb') as out:
            while True:
                chunk=response.read(1<<20)
                if not chunk:break
                out.write(chunk);hasher.update(chunk);got+=len(chunk);progress(done+got,total)
        if got!=size or hasher.hexdigest()!=digest:
            part.unlink(missing_ok=True);raise RuntimeError('A downloaded file did not verify.')
        os.replace(part,target);done+=size
    return True

def resources():
    return Path(sys.executable).resolve().parent if getattr(sys,'frozen',False) else Path(__file__).resolve().parent.parent/'dist/ApplyBurst'

def main():
    bundle=resources();window=tk.Tk();window.title('ApplyBurst');window.geometry('440x330');window.resizable(False,False);window.configure(bg='#fbfcfe')
    frame=ttk.Frame(window,padding=28);frame.pack(fill='both',expand=True)
    ttk.Label(frame,text='applyburst',font=('Segoe UI',22,'bold')).pack(anchor='w');status=tk.StringVar(value='Starting your private workspace…');ttk.Label(frame,textvariable=status,wraplength=370).pack(anchor='w',pady=(20,14))
    progress=ttk.Progressbar(frame,mode='indeterminate');progress.pack(fill='x');progress.start(12)
    # Portable alongside the app. No admin rights, PATH edits, Python or Node installation.
    data=Path(os.environ.get('APPLYBURST_DATA') or bundle/'data').resolve();data.mkdir(parents=True,exist_ok=True)
    server=[None];address=[None];logs=[];notes=[];control=secrets.token_urlsafe(32)
    mutex=[None]
    def ui(fn):window.after(0,fn)
    def open_existing(url,token):
        request=Request(url+'desktop/open',method='POST',headers={'X-Desktop-Control':token})
        with urlopen(request,timeout=3) as response:path=json.load(response)['path']
        from urllib.parse import urlsplit
        origin=urlsplit(url);webbrowser.open(origin.scheme+'://'+origin.netloc+path)
    def open_workspace():
        if not address[0]:return
        try:open_existing(address[0],control)
        except Exception:status.set('The app is not responding. Close ApplyBurst and open it again.')
    def start():
        try:
            if os.name=='nt':
                import ctypes
                from ctypes import wintypes
                kernel=ctypes.windll.kernel32;kernel.CreateMutexW.restype=wintypes.HANDLE
                mutex[0]=kernel.CreateMutexW(None,False,'Local\\ApplyBurst-'+hashlib.sha256(str(data).casefold().encode()).hexdigest()[:24]);already=kernel.GetLastError()==183
                if already:
                    try:
                        previous=json.loads((data/'desktop-process.json').read_text(encoding='utf-8'));open_existing(previous['url'],previous['control'])
                        ui(window.destroy)
                    except Exception:ui(lambda:(progress.stop(),status.set('ApplyBurst is already starting or running. Use its existing window.')))
                    return
            node=bundle/'runtime/node.exe';worker=bundle/'runtime/worker/ApplyBurstWorker.exe';root=bundle/'app'
            if not node.is_file() or not worker.is_file():raise RuntimeError('App files are missing. Reinstall ApplyBurst into an empty folder.')
            profile=data/'browser-profile';profile.mkdir(exist_ok=True)
            channel=None
            for name,paths in [('chrome',[Path(os.environ.get('PROGRAMFILES','C:/Program Files'))/'Google/Chrome/Application/chrome.exe',Path(os.environ.get('LOCALAPPDATA',''))/'Google/Chrome/Application/chrome.exe']),('msedge',[Path(os.environ.get('PROGRAMFILES(X86)','C:/Program Files (x86)'))/'Microsoft/Edge/Application/msedge.exe'])]:
                if any(path.is_file() for path in paths):channel=name;break
            env={**os.environ,'APPLYBURST_DATA':str(data),'APPLYBURST_MODE':'local','APPLYBURST_WORKER':str(worker),'PLAYWRIGHT_BROWSERS_PATH':str(data/'browsers'),'PYTHONIOENCODING':'utf-8'}
            if channel and not (profile/'applyburst-browser.json').exists():(profile/'applyburst-browser.json').write_text(json.dumps({'channel':channel}),encoding='utf-8')
            if not channel:
                ui(lambda:status.set('Setting up the application browser. This first download may take a few minutes…'))
                result=subprocess.run([str(worker),'--install-browser'],env=env,stdout=subprocess.PIPE,stderr=subprocess.STDOUT,creationflags=CREATE_NO_WINDOW)
                if result.returncode:raise RuntimeError('Browser setup failed. Check your internet connection and reopen ApplyBurst.')
            # One-time CV reader setup (about 135 MB). Without it, typed role searches still work.
            env['APPLYBURST_MODEL_CACHE']=str(data/'models')
            if not model_ready(data):
                def shown(done,total):
                    percent=int(done*100/total)
                    if shown.last!=percent:shown.last=percent;ui(lambda:(progress.configure(mode='determinate',maximum=100,value=percent),status.set(f'Setting up the CV reader (135 MB, one time) · {percent}%')))
                shown.last=-1
                ui(lambda:(progress.stop(),progress.configure(mode='determinate',value=0)))
                try:download_model(data,shown)
                except Exception:
                    notes.append('The CV reader could not be downloaded, so search by typing a role for now. Reopen ApplyBurst with internet to finish setup.')
                ui(lambda:(progress.configure(mode='indeterminate'),progress.start(12),status.set('Starting your private workspace…')))
            if model_ready(data):env['APPLYBURST_OFFLINE']='1'
            with socket.socket() as sock:sock.bind(('127.0.0.1',0));port=sock.getsockname()[1]
            ticket=secrets.token_urlsafe(32);origin=f'http://127.0.0.1:{port}';env.update(APPLYBURST_PORT=str(port),APPLYBURST_PUBLIC_ORIGIN=origin,APPLYBURST_DESKTOP_TICKET=ticket,APPLYBURST_CONTROL_TOKEN=control)
            for name in ['server.stdout.log','server.stderr.log']:logs.append((data/name).open('ab'))
            server[0]=subprocess.Popen([str(node),'--no-warnings=ExperimentalWarning',str(root/'web/server.mjs')],cwd=root,env=env,stdout=logs[0],stderr=logs[1],creationflags=CREATE_NO_WINDOW)
            for _ in range(100):
                if server[0].poll() is not None:raise RuntimeError('The local server stopped. See server.stderr.log in the data folder.')
                try:
                    with urlopen(origin+'/healthz',timeout=1) as response:
                        if response.status==200:break
                except OSError:time.sleep(.2)
            else:raise RuntimeError('The app did not start. Close it and try again.')
            address[0]=origin+'/applyburst/';(data/'desktop-process.json').write_text(json.dumps({'port':port,'pid':server[0].pid,'url':address[0],'control':control}),encoding='utf-8')
            webbrowser.open(origin+'/applyburst/desktop/start?ticket='+ticket)
            ready='Ready. Your browser is the app window. Keep ApplyBurst running while jobs are being applied to.'+(' '+notes[0] if notes else '')
            ui(lambda:(progress.stop(),progress.pack_forget(),status.set(ready),open_button.state(['!disabled'])))
        except Exception as error:
            message=str(error);ui(lambda:(progress.stop(),status.set(message)))
    def close():
        if server[0] and server[0].poll() is None:
            if not messagebox.askyesno('Close ApplyBurst?','This stops the local server. Finish or stop any application run first.'):return
            try:
                request=Request(address[0]+'desktop/stop',method='POST',headers={'X-Desktop-Control':control})
                with urlopen(request,timeout=3):pass
                server[0].wait(timeout=10)
            except Exception:server[0].terminate()
        for log in logs:log.close()
        window.destroy()
    open_button=ttk.Button(frame,text='Open ApplyBurst',command=open_workspace);open_button.state(['disabled']);open_button.pack(fill='x',pady=(16,8))
    ttk.Button(frame,text='Open local data folder',command=lambda:os.startfile(str(data))).pack(fill='x')
    ttk.Label(frame,text='No account setup or scripts. Runs on your CPU; your CV and sign-ins stay on this computer.',wraplength=370).pack(anchor='w',pady=(15,0))
    window.protocol('WM_DELETE_WINDOW',close);threading.Thread(target=start,daemon=True).start();window.mainloop()

if __name__=='__main__':main()
