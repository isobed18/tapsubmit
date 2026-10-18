import {spawn} from 'node:child_process';
import {existsSync} from 'node:fs';
import {join} from 'node:path';

// Packaged desktop build: one worker executable with subcommands. Development: the repository venv.
export function workerCommand(root,module){
 if(process.env.APPLYBURST_WORKER)return{command:process.env.APPLYBURST_WORKER,args:['--worker',module]};
 const python=process.env.APPLYBURST_PYTHON||(process.platform==='win32'?join(root,'.venv/Scripts/python.exe'):join(root,'.venv/bin/python'));
 return{command:python,args:['-m','applyburst.'+module]};
}
export function workerEnv(){
 const env={...process.env,PYTHONIOENCODING:'utf-8',PYTHONUNBUFFERED:'1'};
 if(!env.PLAYWRIGHT_BROWSERS_PATH&&process.platform==='win32'&&existsSync('D:\\cache\\ms-playwright'))env.PLAYWRIGHT_BROWSERS_PATH='D:\\cache\\ms-playwright';
 return env;
}
// One JSON request on stdin, JSON-line events on stdout. keepStdin leaves the command channel open.
export function runWorker({root,module,input,onEvent=()=>{},timeoutMs=120000,keepStdin=false}){
 const {command,args}=workerCommand(root,module),started=Date.now();
 const child=spawn(command,[...args,'--request','-'],{cwd:root,env:workerEnv(),windowsHide:true,stdio:['pipe','pipe','pipe']});
 let buffer='',stderr='',spawnError=null;const events=[];
 child.on('error',error=>{spawnError=error;});
 child.stdout.setEncoding('utf8');
 child.stdout.on('data',chunk=>{buffer+=chunk;let index;while((index=buffer.indexOf('\n'))>=0){const line=buffer.slice(0,index).trim();buffer=buffer.slice(index+1);if(!line)continue;let event;try{event=JSON.parse(line);}catch{continue;}if(event.type!=='frame')events.push(event);try{onEvent(event);}catch(error){stderr+='\nevent handler: '+error.message;}}});
 child.stderr.setEncoding('utf8');child.stderr.on('data',chunk=>{stderr=(stderr+chunk).slice(-6000);});
 child.stdin.on('error',()=>{});child.stdin.write(JSON.stringify(input)+'\n');if(!keepStdin)child.stdin.end();
 const timer=setTimeout(()=>{child.kill();},timeoutMs);
 const done=new Promise(resolve=>child.on('close',code=>{clearTimeout(timer);resolve({code,events,stderr:spawnError?String(spawnError.message):stderr,elapsed_ms:Date.now()-started,killed:child.killed});}));
 return{child,done,send(command){if(!child.stdin.destroyed&&child.stdin.writable)child.stdin.write(JSON.stringify(command)+'\n');},close(){if(!child.stdin.destroyed)child.stdin.end();},kill(){child.kill();}};
}
