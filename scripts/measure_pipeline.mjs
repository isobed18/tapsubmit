// Production HTTP API + worker + independent loopback receiver, synthetic facts only.
// Start the receiver with .venv/Scripts/python.exe -m uvicorn
// applyburst.form_fixtures:make_app --factory --host 127.0.0.1 --port 8797.
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {createPortal} from '../web/server.mjs';
import {SCRAPERS} from '../web/lib/scrapers.mjs';
import {hash} from '../web/lib/jobs.mjs';
import {semanticStats} from '../web/lib/semantic.mjs';
process.env.APPLYBURST_DEMO_FIXTURES='1';process.env.APPLYBURST_HEADLESS='1';
const root=resolve('.'),receiver=process.env.APPLYBURST_RECEIVER||'http://127.0.0.1:8797';
assert.match(receiver,/^http:\/\/127\.0\.0\.1:\d+$/);
mkdirSync('.data/pipeline-proof',{recursive:true});const directory=mkdtempSync('.data/pipeline-proof/run-');
const app=await createPortal({directory,seed:false,mode:'local',provisionAdmin:true}),original=SCRAPERS.indeed;
const started=Date.now(),prefix='pipeline-'+started,synthetic=Buffer.from('ApplyBurst synthetic resume; no real candidate.\n'.repeat(64));
let base,headers;
const post=async(path,input)=>{const r=await fetch(base+path,{method:'POST',headers:{...headers,'Content-Type':'application/json'},body:JSON.stringify(input)}),data=await r.json();assert.ok(r.ok,JSON.stringify(data));return data;};
try{
 const baseline=(await(await fetch(receiver+'/__submissions')).json()).accepted.length;
 app.store.setting('profile',{name:'Synthetic Demo Candidate',email:'candidate@example.test',phone:'+90 555 000 00 00',location:'Ankara, Turkey',skills:['Python'],facts:{}});
 app.store.setting('resume_file','synthetic.txt');writeFileSync(join(directory,'synthetic.txt'),synthetic);
 app.store.setting('pace',{concurrency:2,linkedin_apply_seconds:1,confirm_timeout:3,fast_prepare_seconds:3});
 await new Promise(r=>app.server.listen(0,'127.0.0.1',r));const origin='http://127.0.0.1:'+app.server.address().port;base=origin+'/applyburst/api/';
 const credentials=JSON.parse(readFileSync(join(directory,'first-login.json'))),login=await fetch(base+'login',{method:'POST',headers:{Origin:origin,'Content-Type':'application/json'},body:JSON.stringify(credentials)}),cookie=login.headers.get('set-cookie').split(';')[0],boot=await(await fetch(base+'bootstrap',{headers:{Cookie:cookie}})).json();headers={Origin:origin,Cookie:cookie,'X-CSRF-Token':boot.csrf};
 await post('preferences',{preferences:[{id:'weekly_hours',value:'32',confirmed:true},{id:'salary:TRY:month:gross',value:'50000',confirmed:true},{id:'work_authorization:TR',value:'Yes',confirmed:true}]});
 await post('settings/permissions',{daily_cap:50,paused:false,sites:{lever:true,greenhouse:true}});await post('settings/profile',{profile:'controlled_auto',consent:true});
 const rows=Array.from({length:50},(_,i)=>{const scenario=i===47?'preferences_unknown':i===48?'preferences_ambiguous':i===49?'slow_prepare':'preferences',family=i===49?'greenhouse':'lever',path=family==='greenhouse'?'/gh/'+scenario+'/jobs/':'/lever/'+scenario+'/';return{external_id:prefix+'-'+i,title:'AI Engineer',company:'Synthetic Example',description:'Python engineering.',location:'Ankara, Turkey',posted_at:new Date().toISOString(),apply_url:receiver+path+prefix+'-'+i,fixture_family:family};});
 SCRAPERS.indeed=async(q,report)=>{report.batch(rows.slice(0,24));await new Promise(r=>setTimeout(r,6000));report.batch([...rows.slice(24),{...rows[0],external_id:prefix+'-duplicate'}]);return rows;};
 const tick=Date.now();await post('automation/start',{queries:['AI Engineer'],sites:['indeed'],country:'turkey',hours_old:168,limit:50,application_limit:50,auto_apply:true});
 let status;const deadline=Date.now()+120000;
 do{await new Promise(r=>setTimeout(r,100));status=await(await fetch(base+'automation/status',{headers})).json();if(status.automation?.error)throw new Error(status.automation.error);}while((status.automation?.state!=='complete'||status.browser?.running)&&Date.now()<deadline);
 assert.equal(status.automation.state,'complete');assert.equal(status.browser.running,false);
 const apps=app.applications.list(),counts={};for(const row of apps)counts[row.state]=(counts[row.state]||0)+1;
 const received=(await(await fetch(receiver+'/__submissions')).json()).accepted.slice(baseline);
 assert.equal(counts.confirmed,47);assert.equal(counts.needs_answers,2);assert.equal(counts.deferred_slow,1);assert.equal(received.length,47);assert.equal(new Set(received.map(r=>r.job_id)).size,47);
 assert.ok(received.every(r=>r.fields.weekly_hours==='32'&&r.fields.expected_salary==='50000'&&r.fields['cards[c1][field0]']==='Yes'&&r.files.resume.sha256===hash(synthetic)));
 const auto=status.automation;assert.ok(auto.first_confirmed_at<auto.discovery_finished_at,'First confirmation must precede search completion.');
 const report={utc:new Date().toISOString(),scope:'Production local HTTP API/CPU role encoder/worker + independent synthetic employer receiver. Two discovery batches separated by 6s; 50 distinct jobs plus one duplicate listing. Explicit AI Engineer query. No real account/employer/mail used. Three synthetic explicit preferences.',
  jobs:50,states:counts,receiver_count:received.length,unique_receipts:47,receiver_fields_and_resume_hash_verified:true,duplicate_destination_not_sent:true,
  first_application_started_ms:auto.first_application_started_at-tick,first_confirmed_ms:auto.first_confirmed_at-tick,discovery_finished_ms:auto.discovery_finished_at-tick,first_confirmation_before_search_finished:true,
  total_ms:Date.now()-tick,fast_prepare_budget_seconds:3,production_default_prepare_budget_seconds:12,concurrency:2,encoder:semanticStats(),gpu_inference:false,packaged_worker:!!process.env.APPLYBURST_WORKER,...(process.env.APPLYBURST_WORKER?{worker_exe_sha256:hash(readFileSync(process.env.APPLYBURST_WORKER))}:{}),
  fallback_reasons:apps.filter(a=>a.state!=='confirmed').map(a=>({state:a.state,missing:(a.detail.missing||[]).map(q=>q.label),note:a.detail.note})),
  source_sha256:Object.fromEntries(['web/server.mjs','applyburst/companion.py','applyburst/formscan.py','applyburst/formfill.py','applyburst/preferences.py','config/preference_intents.json'].map(path=>[path,hash(readFileSync(path))]))};
 writeFileSync(process.env.APPLYBURST_REPORT||'reports/application-pipeline.json',JSON.stringify(report,null,2));console.log(JSON.stringify(report));
}finally{SCRAPERS.indeed=original;await app.close();}
