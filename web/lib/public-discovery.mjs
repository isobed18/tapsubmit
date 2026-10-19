// Registration-free discovery routes and shared client-side modules.
import {readFileSync,existsSync} from 'node:fs';
import {cityOptions} from './locations.mjs';
import {join} from 'node:path';
import {Discovery,discoveryRequest,COUNTRIES,applyRoute} from './discovery.mjs';
import {sanitizeFeatures,suggestedSearches,ROLES} from '../shared/features.mjs';
import {summarizeExclusions} from './matching.mjs';

const SOURCES=['indeed','himalayas','remoteok','jobicy','remotive','arbeitnow','boards','linkedin'];
const DEFAULT_SOURCES=SOURCES.filter(source=>source!=='linkedin');
export function publicDiscovery({root,store,search,base,publicOrigin,planner=null,publicOrigins=[],maxRunning=4,maxTasks=300,pool=null}){
 // Shared pool size shown to visitors: the exported harvest plus jobs visitors chose to share.
 const poolStats=()=>({...(pool?.stats()||{records:0}),shared_by_visitors:store.db.prepare("SELECT count(*) n FROM jobs WHERE active=1 AND source_id NOT LIKE '%:%'").get().n});
 const tasks=new Map(),limits=new Map();let vocabulary=null;
 const vocab=async()=>{if(!vocabulary){const entries=planner?.publicVocabulary()||[],titles=entries.map(e=>e.title);vocabulary={titles,entries,set:new Set(titles.map(x=>x.toLowerCase()))};}return vocabulary;};
 function limited(key,max,ms=60000){const now=Date.now();for(const[k,v]of limits)if(now-v.at>ms)limits.delete(k);const item=limits.get(key)||{at:now,n:0};limits.set(key,item);return++item.n>max;}
 return async({req,path,url,send,json,host})=>{
  const assets={
   '/assets/public-demo.js':['public-demo.js','text/javascript'], '/assets/public-demo.css':['public-demo.css','text/css'],
   '/assets/resume-reader.mjs':['resume-reader.mjs','text/javascript'],
   '/assets/pdf.min.mjs':['vendor/pdfjs/pdf.min.mjs','text/javascript'], '/assets/pdf.worker.min.mjs':['vendor/pdfjs/pdf.worker.min.mjs','text/javascript'],
  };
  if(req.method==='GET'&&assets[path]){const[file,type]=assets[path],full=join(root,'web/public',file);if(existsSync(full)){send(200,readFileSync(full),type);return true;}}
  if(req.method==='GET'&&path==='/assets/client-engine.mjs'){send(200,readFileSync(join(root,'web/public/client-engine.mjs'),'utf8').replaceAll('../shared/','./'),'text/javascript');return true;}
  if(req.method==='GET'&&path==='/assets/features.mjs'){send(200,readFileSync(join(root,'web/shared/features.mjs'),'utf8').replace('../../demo/lib/taxonomy.mjs','./taxonomy.mjs'),'text/javascript');return true;}
  if(req.method==='GET'&&path==='/assets/professional.mjs'){send(200,readFileSync(join(root,'web/shared/professional.mjs')),'text/javascript');return true;}
  if(req.method==='GET'&&path==='/assets/taxonomy.mjs'){send(200,readFileSync(join(root,'demo/lib/taxonomy.mjs')),'text/javascript');return true;}
  if(!path.startsWith('/api/public/'))return false;
  const ip=String(req.headers['cf-connecting-ip']||req.socket.remoteAddress||'local');
  if(limited('read:'+ip,240)){req.resume();send(429,{error:'Please wait a moment.'});return true;}
  if(path==='/api/public/vocabulary'&&req.method==='GET'){const v=await vocab();send(200,{titles:v.titles,entries:v.entries,note:'Declared occupations and their multilingual ESCO aliases. Matched locally; only professional labels are sent.'});return true;}
  // Startup configuration must stay independent of the size of the shared catalog.
  // No UI consumes pool totals here; counting every destination blocks all HTTP requests.
  if(path==='/api/public/config'&&req.method==='GET'){send(200,{mode:'public_discovery',countries:COUNTRIES,sources:SOURCES,default_sources:DEFAULT_SOURCES,resume_stays_in_browser:true,generative_llm:false,gpu_enabled:false,pool:poolStats(),source_url:process.env.APPLYBURST_SOURCE_URL||null,app_url:process.env.APPLYBURST_APP_URL||null});return true;}
  // City suggestions from the bundled per-country gazetteer (no geocoding service, at most 40 names).
  if(path==='/api/public/locations/cities'&&req.method==='GET'){send(200,{cities:await cityOptions(root,url.searchParams.get('country'),url.searchParams.get('q')||'')});return true;}
  if(path==='/api/public/pool/stats'&&req.method==='GET'){send(200,poolStats());return true;}
  if(path==='/api/public/pool/contribute'&&req.method==='POST'){
   // Optional, explicit opt-in only: public posting metadata, https links, small batches, rate limited.
   if(limited('contribute:'+ip,20)){req.resume();send(429,{error:'Please wait a moment.'});return true;}
   const input=await json(req,200000);if(input.consent!==true){send(400,{error:'Sharing jobs needs your explicit permission.'});return true;}
   const https=v=>{try{const u=new URL(String(v));return u.protocol==='https:'&&!u.username&&!u.password&&u.hostname.includes('.')&&!/(?:^|\.)(?:localhost|local|test|internal)$/.test(u.hostname)&&!/\/(?:candidate|applicant|login|signin)(?:\/|$)/i.test(u.pathname)?u.href:null;}catch{return null;}};
   const jobs=(Array.isArray(input.jobs)?input.jobs:[]).slice(0,200).filter(j=>https(j?.url||j?.apply_url||j?.destination_url)),valid=[];
   for(const j of jobs){
    if(!j?.id||!j?.title||!(j.url||j.apply_url||j.destination_url))continue;
    valid.push({
     id:String(j.id).slice(0,200),
     canonical_id:String(j.canonical_id||j.id).slice(0,200),
     title:String(j.title).slice(0,300),
     company:String(j.company||'').slice(0,200),
     location:String(j.location||'').slice(0,200),
     workplace:['remote','hybrid','onsite'].includes(j.workplace)?j.workplace:null,
     apply_url:String(j.apply_url||j.destination_url||j.url).slice(0,1000),
     destination_url:String(j.destination_url||j.apply_url||j.url).slice(0,1000),
     provider:String(j.provider||j.source||'community').slice(0,60),
     seniority:String(j.seniority||'').slice(0,60),
     seen_at:Date.now()/1000
    });
   }
   const added=valid.length?store.ingestCommunityJobs(valid):0;
   send(200,{ok:true,contributed:valid.length,added_to_index:added,pool:store.pool.stats()});
   return true;
  }
  if(path==='/api/public/search'&&req.method==='POST'){
   const publicHosts=new Set([new URL(publicOrigin).host,...publicOrigins.map(origin=>new URL(origin).host),'tapsubmit.com','www.tapsubmit.com']);
   const expected=publicHosts.has(host)?'https://'+host:'http://'+host;
   if(req.headers.origin!==expected||!String(req.headers['content-type']).startsWith('application/json')){req.resume();send(403,{error:'Invalid request origin.'});return true;}
   for(const[id,t]of tasks)if(Date.now()-t.at>1800000&&!t.discovery.task?.running)tasks.delete(id);
   if(tasks.size>=maxTasks||[...tasks.values()].filter(t=>t.discovery.task?.running).length>=maxRunning||limited('search:'+ip,8)||limited('search:global',40)){req.resume();send(429,{error:'Search is busy. Please try again shortly.'});return true;}
   const input=await json(req,12000),features=sanitizeFeatures(input.features||{}),v=await vocab();
   const explicitQuery=String(input.query||'').trim().slice(0,120);
   // Only public vocabulary titles and whitelisted skills arrive here; they form a minimal planning text in memory.
   const titles=[...new Set((Array.isArray(input.titles)?input.titles:[]).map(x=>String(x).slice(0,80)).filter(x=>v.set.has(x.toLowerCase())))].slice(0,8);
   if(explicitQuery&&v.set.has(explicitQuery.toLowerCase())&&!titles.some(t=>t.toLowerCase()===explicitQuery.toLowerCase()))titles.unshift(explicitQuery);
   const roleLabels=features.roles.map(id=>ROLES.find(r=>r.id===id)?.label).filter(Boolean);
   const baseLines=explicitQuery?[explicitQuery,...titles,...roleLabels]:[...titles,...roleLabels];
   const cvText=baseLines.join('\n')+(features.skills.length?'\nSkills: '+features.skills.join(', '):'');
   const selected=Array.isArray(input.queries)?[...new Set(input.queries.map(q=>String(q).trim().slice(0,120)).filter(Boolean))].slice(0,6):null;
   // The visible, editable chips are authoritative. Removing a role must not let the
   // server silently append it again from the original CV signals.
   const plan=selected?.length&&planner?await planner.plan([...selected,'Skills: '+features.skills.join(', ')].join('\n'),{queries:selected,country:features.country,max:6,signals:false}):planner&&(titles.length||features.roles.length||features.skills.length||explicitQuery)?await planner.planSignals(titles.length?titles:explicitQuery?[explicitQuery]:[],features,{country:features.country}):null;
   let queries=selected?selected:(explicitQuery?[explicitQuery,...(plan?.queries||[]).filter(q=>q.toLowerCase()!==explicitQuery.toLowerCase())].slice(0,4):(plan?.queries||suggestedSearches(features)));
   if(!queries.length){send(422,{error:'Upload your CV or type a role to search.'});return true;}
   const profile={headline:[...(explicitQuery?[explicitQuery]:[]),...titles,...roleLabels].join(', '),skills:features.skills,facts:{early_career:features.level==='early'}};
   const sites=Array.isArray(input.sites)?[...new Set(input.sites.filter(site=>SOURCES.includes(site)))]:DEFAULT_SOURCES;
   if(!sites.length){send(422,{error:'Choose at least one job source.'});return true;}
   const limit=[25,50,100,200,300].includes(Number(input.limit))?Number(input.limit):100;
   const hours_old=[24,72,168,720,2160,0].includes(Number(input.hours_old))&&input.hours_old!==''&&input.hours_old!=null?Number(input.hours_old):720;
   const discovery=new Discovery({store,search,root,planner}),request={...discoveryRequest({queries,planned:Boolean(plan?.roles?.length),sites,country:features.country,location:String(input.location||'').slice(0,160),work_mode:input.work_mode,remote:features.remote,limit,hours_old,level:['early','senior'].includes(features.level)?features.level:'unknown'},profile),cv_text:cvText,strict_relevance:Boolean(titles.length||features.roles.length)},task=discovery.start(request,{plan});
   tasks.set(task.id,{discovery,profile,at:Date.now()});send(202,{id:task.id,queries,titles:plan?.signal_titles||titles,country:request.country,sites,limit});return true;
  }
  if(path==='/api/public/stop'&&req.method==='POST'){
   if(!['http://'+url.host,'https://'+url.host].includes(req.headers.origin)){req.resume();send(403,{error:'Invalid request origin.'});return true;}
   const input=await json(req,1000),item=tasks.get(input.id);if(!item){send(404,{error:'Search expired.'});return true;}item.discovery.stop();send(200,{ok:true});return true;
  }
  if(path==='/api/public/status'&&req.method==='GET'){
   const item=tasks.get(url.searchParams.get('id'));if(!item){send(404,{error:'Search expired. Upload your CV again.'});return true;}
   const task=item.discovery.task,ranked=item.discovery.ranked(task,item.profile),jobs=ranked.results.filter(job=>task.request.country==='worldwide'||job.match.geography.status!=='unknown').slice(0,500).map(job=>{const r=applyRoute(job);return{id:job.id,title:job.title,company:job.company,location:job.location,workplace:job.workplace||null,url:job.destination_url||job.apply_url,listing_url:job.listing_url||job.apply_url,destination_url:job.destination_url||null,posted_at:job.posted_at,seen_at:job.seen_at,source:job.provider,route:r.label,family:r.family,automatable:r.automatable,review:!job.match.auto_selectable,closest_role:job.match.closest_role,skills:job.match.overlap.slice(0,5),experience_review:job.match.seniority_conflict||job.match.experience_review};});
   const checked=item.discovery.jobsFor(task).length,pending=Math.max(0,checked-task.semantic.size);
   const can_expand=!task.running&&task.request.limit<300&&task.rows.some(row=>row.has_more||row.count>=task.request.limit);
   const stop_reason=task.running?'searching':can_expand?'budget_reached':task.request.limit>=300&&task.rows.some(row=>row.stop_reason==='budget_reached'||row.count>=300)?'max_budget_reached':task.rows.some(row=>row.stop_reason==='throttled'||['throttled','cooling_down'].includes(row.state))?'throttled':'exhausted';
   send(200,{running:task.running,cancelled:!!task.cancelled,phase:task.phase||'searching',checked,pending,limit:task.request.limit,can_expand:can_expand&&!task.cancelled,stop_reason:task.cancelled?'stopped':stop_reason,filters:{country:task.request.country,location:task.request.location,work_mode:task.request.work_mode,hours_old:task.request.hours_old,limit:task.request.limit},excluded:ranked.excluded.length,exclusion_summary:summarizeExclusions(ranked.excluded),elapsed_ms:(task.finished_at||Date.now())-task.started_at,queries:task.request.queries,plan:task.plan_summary||null,jobs,rows:task.rows.map(({site,query,state,count,warnings,error,has_more,stop_reason:rowStop,resumed_from,captcha})=>({site,query,state,count,warnings,error,has_more,stop_reason:rowStop||null,captcha:!!captcha,...(resumed_from?{resumed_from}:{})})),error:task.error||null});return true;
  }
  return false;
 };
}

