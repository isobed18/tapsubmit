// Search-quality diagnosis on a snapshot of the local job store with a SYNTHETIC CV (never a real one).
// Live public sources are queried read-only. Prints where each shown job came from and why it was kept.
// Usage: node --no-warnings scripts/diagnose_search.mjs <cv.txt> [country] [store-snapshot-source]
import {DatabaseSync} from 'node:sqlite';
import {readFileSync,rmSync,mkdirSync,writeFileSync} from 'node:fs';
import {createPortal} from '../web/server.mjs';
import {discoveryRequest,SOURCES} from '../web/lib/discovery.mjs';
const [cvFile,country='turkey',source='.data/desktop-live/portal.sqlite']=process.argv.slice(2),dir='.data/diag/run';
rmSync(dir,{recursive:true,force:true});mkdirSync(dir,{recursive:true});
{const db=new DatabaseSync(source,{readOnly:true});db.exec(`VACUUM INTO '${dir}/portal.sqlite'`);db.close();}
// Strip personal state from the snapshot: only the job pool is needed.
{const db=new DatabaseSync(dir+'/portal.sqlite');for(const t of ['applications','application_events','sessions','users','review_tokens'])try{db.exec(`DELETE FROM ${t}`)}catch{};try{db.exec("DELETE FROM settings WHERE key NOT LIKE 'throttle:%' AND key NOT LIKE 'feed_ingestion:%' AND key NOT LIKE 'search_state:%'")}catch{};db.close();}
const app=await createPortal({directory:dir,seed:false,mode:'local',automaticRefresh:false,provisionAdmin:true});
const cv=readFileSync(cvFile,'utf8'),planner=app.discovery.planner,t0=Date.now();
const plan=await planner.plan(cv,{country});
console.log('PLAN',JSON.stringify({queries:plan.queries,roles:plan.roles.map(r=>r.title),early:plan.early,level:plan.level,ms:plan.elapsed_ms}));
const sites=SOURCES.filter(s=>s.default||['himalayas','remoteok','jobicy','remotive','arbeitnow'].includes(s.id)).map(s=>s.id);
const task=app.discovery.start({...discoveryRequest({queries:plan.queries,planned:true,sites,country,hours_old:168,limit:Number(process.env.DIAG_LIMIT||25)},null),cv_text:cv});
while(task.running||task.scorePending)await new Promise(r=>setTimeout(r,300));
await new Promise(r=>setTimeout(r,800));
const ranked=app.discovery.ranked(task,null),SEN=/\b(senior|sr\.?|lead|principal|staff|director|head of|manager|vp|chief|architect)\b/i,EDU=/\b(teacher|tutor|instructor|lecturer|professor|trainer|teaching|education|öğretmen|eğitmen|akademisyen|curriculum)\b/i;
const rows=ranked.results.map(j=>({title:j.title,company:j.company,provider:j.provider,route:j.apply_route,role:j.match.relevance?.role,closest:j.match.closest_role,rival:j.match.rival_role,auto:j.match.auto_selectable,senior:SEN.test(j.title),edu:EDU.test(j.title),years:j.match.minimum_years,q:j.match.queries?.join('|')}));
const by=k=>Object.entries(rows.reduce((a,r)=>(a[r[k]]=(a[r[k]]||0)+1,a),{})).sort((a,b)=>b[1]-a[1]);
console.log('SOURCES',JSON.stringify(task.rows.map(r=>[r.site,r.query,r.state,r.count])));
console.log('SHOWN',rows.length,'excluded',ranked.excluded.length,'auto',rows.filter(r=>r.auto).length,'senior-titled',rows.filter(r=>r.senior).length,'education-titled',rows.filter(r=>r.edu).length,'3+yrs',rows.filter(r=>r.years>=3).length,'elapsed',Date.now()-t0,'ms');
console.log('BY PROVIDER',JSON.stringify(by('provider')));
for(const r of rows)console.log((r.auto?'AUTO':'show').padEnd(5),(r.senior?'SEN ':'')+(r.edu?'EDU ':'')+(r.years>=3?r.years+'y ':''),String(r.role??'-').padEnd(6),r.provider.padEnd(10),r.title.slice(0,60),'|',(r.company||'').slice(0,25),'| close:',r.closest,r.rival?'| rival:'+r.rival:'');
const excluded=ranked.excluded.map(e=>{const j=app.store.getJob(e.id);return{title:j?.title,company:j?.company,provider:j?.provider,role:e.match.relevance?.role,rival:e.match.rival_role,why:e.match.conflicts};});
writeFileSync('.data/diag/last.json',JSON.stringify({plan:{queries:plan.queries,roles:plan.roles.map(r=>r.title)},rows,excluded,timing:task.rows.map(r=>[r.site,r.query,r.state,r.count,r.elapsed_seconds])},null,1));
await app.close();
