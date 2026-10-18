"""One-click installer for the offline portable bundle. Data is never inside the payload."""
import os
import subprocess
import sys
import threading
import tkinter as tk
from pathlib import Path
from tkinter import filedialog,ttk
from zipfile import ZipFile

def main():
    window=tk.Tk();window.title('Install ApplyBurst');window.geometry('470x300');window.resizable(False,False)
    frame=ttk.Frame(window,padding=25);frame.pack(fill='both',expand=True);ttk.Label(frame,text='ApplyBurst',font=('Segoe UI',22,'bold')).pack(anchor='w')
    ttk.Label(frame,text='Your job search and application assistant.\nEverything needed is included. Your data stays local.').pack(anchor='w',pady=(8,16))
    destination=tk.StringVar(value=str(Path('D:/Apps/ApplyBurst') if Path('D:/').exists() else Path(os.environ['LOCALAPPDATA'])/'Programs/ApplyBurst'))
    ttk.Entry(frame,textvariable=destination).pack(fill='x');status=tk.StringVar(value='Choose a folder with space for the app and browser cache.');ttk.Label(frame,textvariable=status,wraplength=420).pack(anchor='w',pady=10)
    def choose():
        folder=filedialog.askdirectory(title='Install ApplyBurst in')
        if folder:destination.set(str(Path(folder)/'ApplyBurst'))
    ttk.Button(frame,text='Choose folder',command=choose).pack(anchor='w')
    def install():
        button.state(['disabled']);target=Path(destination.get()).resolve()
        def task():
            try:
                if (target/'ApplyBurst.exe').exists():raise RuntimeError('An app already exists here. Close it and choose a new folder; your data will not be overwritten.')
                payload=Path(getattr(sys,'_MEIPASS',Path(__file__).parent))/'ApplyBurst-payload.zip';target.mkdir(parents=True,exist_ok=True)
                with ZipFile(payload) as archive:
                    entries=archive.infolist()
                    for i,entry in enumerate(entries):
                        path=(target/entry.filename).resolve()
                        if not path.is_relative_to(target):raise RuntimeError('Invalid installer path.')
                        archive.extract(entry,target)
                        if i%20==0:window.after(0,lambda n=i:status.set(f'Installing… {int(n/max(1,len(entries))*100)}%'))
                subprocess.Popen([str(target/'ApplyBurst.exe')],cwd=target)
                window.after(0,window.destroy)
            except Exception as error:
                message=str(error);window.after(0,lambda:(status.set(message),button.state(['!disabled'])))
        threading.Thread(target=task,daemon=True).start()
    button=ttk.Button(frame,text='Install & open',command=install);button.pack(fill='x',pady=(15,0));window.mainloop()

if __name__=='__main__':main()
