// End-to-end: real local server + Python companion + loopback German employer fixture, synthetic data only.
// Shows that labels, buttons and the confirmation are understood by meaning (no German rules exist).
// Usage: node scripts/e2e_multilingual.mjs <portal-port> <fixture-port> <data-dir>
import {readFileSync} from 'node:fs';
import {Store} from '../web/lib/store.mjs';
import {decorate} from '../web/lib/jobs.mjs';
const [port,fixturePort,dir]=process.argv.slice(2),base=`http://127.0.0.1:${port}/applyburst/api/`,origin=`http://127.0.0.1:${port}`,sleep=ms=>new Promise(r=>setTimeout(r,ms));
// One synthetic German job pointing at the loopback fixture.
const store=new Store(dir+'/portal.sqlite'),source={id:'fixture:de',provider:'fixture',board:'de',kind:'fixture'},jobId='fixture:de:de1';
// A freshly started app seeds and crawls first; wait for its write lock instead of failing.
for(let attempt=0;;attempt++){try{store.replaceSource(source,[decorate({id:jobId,canonical_id:jobId,source_id:source.id,provider:'fixture',board:'de',external_id:'de1',company:'Beispiel GmbH',title:'Softwareentwickler (m/w/d)',description:'Synthetic loopback fixture.',location:'Berlin',apply_url:`http://127.0.0.1:${fixturePort}/gh/de/jobs/501`,seen_at:Date.now()/1000,fixture_family:'greenhouse'})],{complete:true});break;}catch(error){if(!/locked|busy/i.test(error.message)||attempt>60)throw error;await sleep(1000);}}
store.close();
const creds=JSON.parse(readFileSync(dir+'/first-login.json','utf8'));
const login=await fetch(base+'login',{method:'POST',headers:{Origin:origin,'Content-Type':'application/json'},body:JSON.stringify(creds)}),cookie=login.headers.get('set-cookie').split(';')[0],csrf=(await (await fetch(base+'bootstrap',{headers:{Cookie:cookie}})).json()).csrf;
const post=async(p,b,raw)=>{const r=await fetch(base+p,{method:'POST',headers:{Cookie:cookie,Origin:origin,'X-CSRF-Token':csrf,...(raw?{}:{'Content-Type':'application/json'})},body:raw||JSON.stringify(b)});const j=await r.json();if(!r.ok)throw new Error(p+': '+j.error);return j;};
const get=async p=>(await fetch(base+p,{headers:{Cookie:cookie}})).json();
const form=new FormData();form.set('resume',new File(['Max Beispiel\nSoftwareentwickler\nE-Mail: max@example.test\nTelefon: +49 30 1234567\nBerlin, Deutschland\nPython, TypeScript, verteilte Systeme, 5 Jahre Erfahrung.\n'.repeat(2)],'synthetic-cv.txt'));
await post('resume',null,form);await post('profile',{name:'Max Beispiel',email:'max@example.test',phone:'+49 30 1234567',location:'Berlin, Germany',linkedin:'https://www.linkedin.com/in/max-beispiel'});
const waitRun=async label=>{const t=Date.now();for(;;){await sleep(700);const {browser}=await get('browser/status');if(!browser?.running){console.log(label,'finished in',((Date.now()-t)/1000).toFixed(1)+'s',JSON.stringify(browser?.counts||{}),browser?.error||'');return;}}};
const t0=Date.now();await post('applications/prepare',{ids:[jobId]});await waitRun('prepare #1');
let apps=await get('applications'),app=apps.applications.find(a=>a.job_id===jobId);
console.log('state:',app.state,'| asks for:',JSON.stringify((app.detail.missing||[]).map(m=>m.label)));
const custom=apps.questions.find(q=>/Warum/.test(q.label));
if(custom){await post('answers',{answers:[{fingerprint:custom.fingerprint,value:'Ich möchte an verteilten Systemen arbeiten.',label:custom.label,kind:custom.kind}]});await post('applications/prepare',{ids:[jobId]});await waitRun('prepare #2');}
apps=await get('applications');app=apps.applications.find(a=>a.job_id===jobId);
console.log('state:',app.state,'| fields:',JSON.stringify((app.detail.disclosure||[]).map(r=>r.label.replace(/\*$/,'')+'='+(typeof r.value==='string'?r.value.slice(0,24):r.value)+'('+r.source+')')));
if(app.state==='ready_to_submit'){const review=await post('applications/review',{ids:[jobId]});await post('applications/submit',{ids:[jobId],token:review.token});await waitRun('submit');}
apps=await get('applications');app=apps.applications.find(a=>a.job_id===jobId);
const received=await (await fetch(`http://127.0.0.1:${fixturePort}/__submissions`)).json();
console.log('final:',app.state,'| evidence:',JSON.stringify(app.detail.evidence||null),'| total',((Date.now()-t0)/1000).toFixed(1)+'s');
console.log('receiver got:',JSON.stringify(received.accepted.map(s=>({fields:s.fields,files:Object.fromEntries(Object.entries(s.files).map(([k,v])=>[k,v.filename]))}))));
