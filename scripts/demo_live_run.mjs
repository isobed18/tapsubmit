// Local-app live demo: the real server, planner, worker and browser companion against loopback SYNTHETIC
// employers (applyburst.form_fixtures). Synthetic CV and facts only; nothing reaches a real employer.
// Two fake sources stream jobs in batches so the UI shows search and applications overlapping.
// Usage: node --no-warnings scripts/demo_live_run.mjs <port> <receiver-origin>
//   receiver: .venv/Scripts/python.exe -m uvicorn applyburst.form_fixtures:make_app --factory --port 8795
import {mkdirSync} from 'node:fs';
import {randomUUID} from 'node:crypto';
import {createPortal} from '../web/server.mjs';
import {SCRAPERS} from '../web/lib/scrapers.mjs';
const port=Number(process.argv[2]||8793),receiver=process.argv[3]||'http://127.0.0.1:8795';
if(!/^http:\/\/127\.0\.0\.1:\d+$/.test(receiver))throw new Error('The receiver must be a loopback origin.');
process.env.APPLYBURST_DEMO_FIXTURES='1';process.env.APPLYBURST_HEADLESS='1';process.env.APPLYBURST_DESKTOP_TICKET=randomUUID()+randomUUID();
mkdirSync('.data/demo-live',{recursive:true});const directory='.data/demo-live/run-'+Date.now();
const app=await createPortal({directory,seed:false,mode:'local',provisionAdmin:true}),run=Date.now().toString(36);
const job=(n,title,company,family,scenario,location='İstanbul, Türkiye')=>{
 const id=`${run}-${n}`,path=family==='greenhouse'?`/gh/${scenario}/jobs/${id}`:family==='lever'?`/lever/${scenario}/${id}`:null;
 return{external_id:id,title,company,description:title+' role. Synthetic loopback employer for the ApplyBurst demo.',location,posted_at:new Date().toISOString(),apply_url:path?receiver+path:`https://careers.example.org/jobs/${id}`,...(path?{fixture_family:family}:{})};
};
const BATCHES={
 indeed:[[400,[job(1,'Backend Engineer (Python)','Synthetic Labs','lever','preferences'),job(2,'Python Developer','Example Data','greenhouse','happy'),job(3,'Account Executive','Example Sales','lever','preferences'),job(4,'Backend Developer','Example Retail','lever','preferences_unknown'),job(5,'Senior Backend Developer','Example Bank','lever','preferences')]],
  [5500,[job(11,'Software Engineer, Backend','Example Cloud','lever','preferences'),job(12,'Backend Engineer','Example Insurance',null,null),job(13,'Backend Platform Engineer','Example Payments','greenhouse','happy'),job(14,'Registered Nurse','Example Hospital','lever','preferences'),job(15,'Backend Developer (Go)','Example Mobility','lever','preferences')]]],
 linkedin:[[2200,[job(6,'Softwareentwickler Backend (m/w/d)','Beispiel GmbH','greenhouse','de'),job(7,'Data Engineer','Example Logistics','lever','preferences'),job(8,'Python Backend Developer','Example Travel','greenhouse','happy'),job(9,'Graphic Designer','Example Studio','lever','preferences'),job(10,'Frontend Developer','Example Media','lever','preferences')]]]
};
// DEMO_REAL=1 keeps the real search sources (live, read-only) to reproduce UI issues with real volumes.
if(process.env.DEMO_REAL!=='1')for(const [site,batches]of Object.entries(BATCHES))SCRAPERS[site]=async(query,report)=>{const all=[];let at=0;for(const [when,rows]of batches){await new Promise(r=>setTimeout(r,when-at));at=when;report.batch(rows);all.push(...rows);}return all;};
await new Promise(resolve=>app.server.listen(port,'127.0.0.1',resolve));
const origin=`http://127.0.0.1:${port}`,base=origin+'/applyburst/api/';
// Seed the synthetic candidate through the same API the UI uses.
const {readFileSync}=await import('node:fs'),{join}=await import('node:path');
const credentials=JSON.parse(readFileSync(join(directory,'first-login.json'))),login=await fetch(base+'login',{method:'POST',headers:{Origin:origin,'Content-Type':'application/json'},body:JSON.stringify(credentials)}),cookie=login.headers.get('set-cookie').split(';')[0];
const csrf=(await(await fetch(base+'bootstrap',{headers:{Cookie:cookie}})).json()).csrf,headers={Cookie:cookie,Origin:origin,'X-CSRF-Token':csrf};
const post=async(path,body,raw)=>{const r=await fetch(base+path,{method:'POST',headers:raw?headers:{...headers,'Content-Type':'application/json'},body:raw||JSON.stringify(body)}),data=await r.json();if(!r.ok)throw new Error(path+': '+data.error);return data;};
const form=new FormData();form.set('resume',new File(['Deniz Example\nBackend Software Engineer\ndeniz@example.test · +90 555 000 00 00 · İstanbul, Türkiye\nPython, FastAPI, PostgreSQL, Docker, REST APIs and distributed systems. Four years building backend services.\nExperience: Backend Engineer at Example Corp (2021–2025): designed APIs, data pipelines and CI/CD.\nEducation: BSc Computer Engineering, 2020.\n'],'synthetic-cv.txt'));
const uploaded=await post('resume',null,form);
await post('profile',{name:'Deniz Example',email:'deniz@example.test',phone:'+90 555 000 00 00',location:'İstanbul, Türkiye',linkedin:'https://www.linkedin.com/in/deniz-example'});
await post('preferences',{preferences:[{id:'weekly_hours',value:'40',confirmed:true},{id:'salary:TRY:month:gross',value:'90000',confirmed:true},{id:'work_authorization:TR',value:'Yes',confirmed:true}]});
await post('settings/pace',{concurrency:2,linkedin_apply_seconds:1,confirm_timeout:15});
console.log(JSON.stringify({plan:uploaded.profile.plan?.queries,directory}));
console.log('Open (one-time, this synthetic test instance only): '+origin+'/applyburst/desktop/start?ticket='+process.env.APPLYBURST_DESKTOP_TICKET);
for(const signal of ['SIGINT','SIGTERM'])process.on(signal,async()=>{await app.close();process.exit(0);});
