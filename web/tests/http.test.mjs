import test from 'node:test';
import assert from 'node:assert/strict';
import {request} from 'node:http';
import {mkdtempSync,mkdirSync,readFileSync,rmSync,realpathSync} from 'node:fs';
import {join,resolve,dirname} from 'node:path';
import {createPortal} from '../server.mjs';
import {decorate} from '../lib/jobs.mjs';
import {ANSWERS,RESUME} from '../../demo/lib/sandbox.mjs';

// fetch() ignores a Host override, so explicit Host tests use node:http directly.
function raw(port,{method='GET',path,headers={},body}){
 return new Promise((resolve,reject)=>{const req=request({host:'127.0.0.1',port,method,path,headers},res=>{const chunks=[];res.on('data',chunk=>chunks.push(chunk));res.on('end',()=>resolve({status:res.statusCode,headers:res.headers,body:Buffer.concat(chunks).toString()}));});req.on('error',reject);if(body)req.write(body);req.end();});
}

test('private portal: authentication, CSRF, resume discovery and durable sandbox receipts',async()=>{
 const parent=resolve('.data/http-tests');mkdirSync(parent,{recursive:true});
 const directory=mkdtempSync(join(parent,'portal-')),previousTicket=process.env.APPLYBURST_DESKTOP_TICKET;
 process.env.APPLYBURST_DESKTOP_TICKET='synthetic-launcher-ticket';
 const app=await createPortal({directory,seed:false,mode:'local'});
 if(previousTicket===undefined)delete process.env.APPLYBURST_DESKTOP_TICKET;else process.env.APPLYBURST_DESKTOP_TICKET=previousTicket;
 try{
  const source={id:'test:board',provider:'test',board:'board',kind:'ats'};
  app.store.replaceSource(source,[decorate({id:'test:one',canonical_id:'test:one',source_id:source.id,provider:'test',board:'board',company:'Example',title:'AI Engineer',description:'Python FastAPI LangGraph agentic systems engineering.',location:'Ankara',apply_url:'https://example.test/job',seen_at:Date.now()/1000})],{complete:true});
  await app.search.load(app.store.catalog());
  await new Promise(resolve=>app.server.listen(0,'127.0.0.1',resolve));
  const origin='http://127.0.0.1:'+app.server.address().port,base=origin+'/applyburst/api/';
  for(const route of ['profile','recommendations','saved','browser/status','index/outbox'])assert.equal((await fetch(base+route)).status,401,route);
  assert.equal((await fetch(base+'refresh',{method:'POST'})).status,401);
  assert.equal((await fetch(base+'register',{method:'POST'})).status,403);
  const port=app.server.address().port,credentials={username:'synthetic-owner',password:'synthetic-login-password'};
  assert.equal((await (await fetch(base+'auth/status')).json()).registration_open,true);
  const launch=await fetch(origin+'/applyburst/desktop/start?ticket=synthetic-launcher-ticket',{redirect:'manual'});
  assert.equal(launch.status,302);assert.equal(launch.headers.get('set-cookie'),null);
  assert.equal((await fetch(base+'bootstrap')).status,401);
  const register=()=>fetch(base+'register',{method:'POST',headers:{Origin:origin,'Content-Type':'application/json'},body:JSON.stringify(credentials)});
  assert.equal((await register()).status,201);
  assert.equal((await register()).status,409);
  assert.equal((await (await fetch(base+'auth/status')).json()).registration_open,false);
  const owner=JSON.parse(readFileSync(join(directory,'admin.json'),'utf8'));
  assert.equal(owner.username,credentials.username);assert.equal(owner.password_hash.length,128);assert.equal(owner.password,undefined);
  // Unknown hosts (including DNS-rebinding names) are refused before any route, even health.
  for(const host of ['attacker.test','127.0.0.1.attacker.test','tapsubmit.com.attacker.test'])assert.equal((await raw(port,{path:'/healthz',headers:{Host:host}})).status,421,host);
  assert.equal((await raw(port,{path:'/healthz',headers:{Host:'tapsubmit.com'}})).status,200);
  const rawLogin=(host,originHeader)=>raw(port,{method:'POST',path:'/applyburst/api/login',headers:{Host:host,Origin:originHeader,'Content-Type':'application/json'},body:JSON.stringify(credentials)});
  const publicLogin=await rawLogin('tapsubmit.com','https://tapsubmit.com');
  assert.equal(publicLogin.status,200);assert.match(publicLogin.headers['set-cookie'][0],/HttpOnly; SameSite=Lax; Max-Age=43200; Secure$/);
  // The public host must not accept a loopback Origin, and loopback must not accept the public one without its host.
  assert.equal((await rawLogin('tapsubmit.com',origin)).status,403);
  assert.equal((await rawLogin('127.0.0.1:'+port,'https://attacker.test')).status,403);
  const login=async(originHeader=origin)=>fetch(base+'login',{method:'POST',headers:{Origin:originHeader,'Content-Type':'application/json'},body:JSON.stringify(credentials)});
  assert.equal((await login('https://attacker.test')).status,403);
  const response=await login();assert.equal(response.status,200);
  const cookie=response.headers.get('set-cookie').split(';')[0];assert.match(response.headers.get('set-cookie'),/HttpOnly; SameSite=Lax/);assert.doesNotMatch(response.headers.get('set-cookie'),/Secure/);
  const bootstrap=await (await fetch(base+'bootstrap',{headers:{Cookie:cookie}})).json();
  const headers={Cookie:cookie,Origin:origin,'X-CSRF-Token':bootstrap.csrf};
  assert.equal(bootstrap.mode,'local');assert.equal(bootstrap.gpu_enabled,false);assert.equal(bootstrap.profile,null);assert.equal(bootstrap.username,credentials.username);assert.ok(bootstrap.workspace_id);
  assert.equal((await fetch(base+'saved',{method:'POST',headers:{Cookie:cookie,Origin:origin,'Content-Type':'application/json'},body:'{"ids":[]}'})).status,403);
  assert.equal((await fetch(base+'saved',{method:'POST',headers:{...headers,Origin:'https://attacker.test','Content-Type':'application/json'},body:'{"ids":[]}'})).status,403);
  const form=new FormData();form.set('resume',new File(['Demo Candidate\nComputer Engineering Student\nLocation: Ankara\nPython FastAPI LangGraph PyTorch OpenCV\nExpected graduation 2027.'], 'resume.txt'));
  assert.equal((await fetch(base+'resume',{method:'POST',headers,body:form})).status,200);
  const suggestions=await (await fetch(base+'recommendations',{headers})).json();assert.ok(suggestions.results.some(job=>job.id==='test:one'));assert.equal(suggestions.results[0].description,undefined);
  assert.ok(suggestions.suggested.some(track=>track.id==='agents'));
  assert.equal((await fetch(base+'applications/prepare',{method:'POST',headers:{...headers,'Content-Type':'application/json'},body:'{"ids":["unknown"]}'})).status,400);
  assert.deepEqual((await (await fetch(base+'applications',{headers})).json()).applications,[]);
  const submit=async(file=RESUME)=>{const form=new FormData();form.set('job_id','test:one');form.set('run_id','http-test-run');for(const [name,value]of Object.entries(ANSWERS))form.set(name,value);form.set('resume',new File([file],'synthetic.txt'));return fetch(base+'sandbox/apply',{method:'POST',headers,body:form});};
  assert.equal((await submit('corrupted upload')).status,422);
  const first=await (await submit()).json(),replay=await (await submit()).json();assert.equal(first.state,'confirmed_sandbox');assert.equal(replay.receipt_id,first.receipt_id);
  const receipts=await (await fetch(base+'sandbox/receipts?run_id=http-test-run',{headers})).json();assert.equal(receipts.count,1);assert.equal(receipts.receipts[0].resume_bytes,Buffer.byteLength(RESUME));
  assert.ok(!app.store.db.prepare('SELECT text FROM job_chunks').all().some(row=>row.text.includes('Demo Candidate')));
  await fetch(base+'logout',{method:'POST',headers});assert.equal((await fetch(base+'profile',{headers})).status,401);
  const again=await login(),freshCookie=again.headers.get('set-cookie').split(';')[0],fresh=await(await fetch(base+'bootstrap',{headers:{Cookie:freshCookie}})).json();
  const changed=await fetch(base+'account/password',{method:'POST',headers:{Origin:origin,Cookie:freshCookie,'X-CSRF-Token':fresh.csrf,'Content-Type':'application/json'},body:JSON.stringify({current_password:credentials.password,new_password:'synthetic-new-password'})});
  assert.equal(changed.status,200);assert.ok(changed.headers.get('set-cookie'));
  assert.equal((await fetch(base+'bootstrap',{headers:{Cookie:freshCookie}})).status,401);
  assert.equal((await login()).status,401);
  const newLogin=await fetch(base+'login',{method:'POST',headers:{Origin:origin,'Content-Type':'application/json'},body:JSON.stringify({...credentials,password:'synthetic-new-password'})});assert.equal(newLogin.status,200);
  assert.notEqual(JSON.parse(readFileSync(join(directory,'admin.json'),'utf8')).password_hash,owner.password_hash);
 }finally{
  await app.close();
  // Delete only the unique test directory created here, after checking its parent.
  assert.equal(dirname(realpathSync(directory)),realpathSync(parent));rmSync(directory,{recursive:true});
 }
});
