import {randomUUID} from 'node:crypto';
import {normalizeLanguages} from './languages.mjs';
import {hash,normalizedJob} from './jobs.mjs';
import {resumePlan} from './recommendations.mjs';
import {siteForURL} from './application-plan.mjs';
import {runWorker} from './worker.mjs';
import {SCRAPERS,searchHTTP} from './scrapers.mjs';
import {rankJobs,homeCountry} from './matching.mjs';
import {inferLevel} from '../shared/features.mjs';
import {parseQuery} from '../../demo/public/search-engine.mjs';
import {simpleQuery} from './profile.mjs';

export const SOURCES=[
 {id:'linkedin',label:'LinkedIn',access:'Public job search, no login. Easy Apply jobs need your LinkedIn session to apply.',default:true},
 {id:'indeed',label:'Indeed',access:'Public job search, no login. Most jobs link to the employer form.',default:true},
 {id:'glassdoor',label:'Glassdoor',access:'Public location-based search. Availability depends on Glassdoor; some locations or requests may be blocked.'},
 {id:'google',label:'Google Jobs (experimental)',access:'Google usually blocks automated job searches, so this often returns nothing. Links point to the original postings.'},
 {id:'himalayas',label:'Himalayas (remote jobs)',access:'Large global remote-job board with full descriptions. You apply on the posting page.'},
 {id:'remoteok',label:'Remote OK',access:'Latest global remote jobs, filtered to your search. You apply on the posting page.'},
 {id:'jobicy',label:'Jobicy',access:'Public recent remote-job feed; saved locally and shared between queries.'},
 {id:'remotive',label:'Remotive',access:'Public remote-job feed, delayed 24 hours by the provider.'},
 {id:'arbeitnow',label:'Arbeitnow',access:'Public recent job feed; remote and onsite jobs. Employer application links.'},
 {id:'boards',label:'Company career sites',access:'Searches the saved company-job index. Application support depends on the destination form; some employers require an account.',default:true}
];
export const COUNTRIES=[['turkey','Türkiye'],['germany','Germany'],['uk','United Kingdom'],['usa','United States'],['netherlands','Netherlands'],['france','France'],['canada','Canada'],['ireland','Ireland'],['spain','Spain'],['poland','Poland'],['uae','United Arab Emirates'],['india','India'],['singapore','Singapore'],['worldwide','Worldwide']];
const SITE_URL={linkedin:'https://www.linkedin.com/jobs/',indeed:'https://www.indeed.com/',glassdoor:'https://www.glassdoor.com/',google:'https://www.google.com/search',himalayas:'https://himalayas.app/jobs',remoteok:'https://remoteok.com/',jobicy:'https://jobicy.com/',remotive:'https://remotive.com/',arbeitnow:'https://www.arbeitnow.com/'};
const PLAIN={agents:'agentic AI',ai:'AI engineer',ml:'machine learning engineer',vision:'computer vision engineer',backend:'Python backend developer',early:'machine learning intern'};
const ATS=new Set(['greenhouse','lever','ashby','workable','smartrecruiters','personio','bamboohr','workday']);
const CACHE_SECONDS=1800,RETIRE_DAYS=21;

export function suggestedQueries(profile){return resumePlan(profile).map(track=>({id:track.id,label:track.label,query:PLAIN[track.id]}));}
// Remote sites take plain keywords; local field syntax (title:, skill:) is not passed on.
export function remoteQuery(text){return String(text||'').replace(/\b(title|description|skill|company|location|workplace|level|type|source):/gi,'').replace(/\s+/g,' ').trim().slice(0,500);}
export function discoveryRequest(input,profile){
 const match_queries=[...new Set((Array.isArray(input.queries)?input.queries:[]).map(q=>String(q).trim().slice(0,500)).filter(Boolean))].slice(0,6);
 match_queries.forEach(parseQuery);
 const queries=match_queries.map(remoteQuery);
 if(!queries.length){const suggested=suggestedQueries(profile),selected=suggested.slice(0,3),early=suggested.find(item=>item.id==='early');if(early&&!selected.some(item=>item.id==='early'))selected.splice(2,1,early);queries.push(...selected.map(item=>item.query));}
 if(!queries.length)throw new Error('Enter what you are looking for, or upload a resume for suggestions.');
 const sites=[...new Set((Array.isArray(input.sites)?input.sites:SOURCES.filter(s=>s.default).map(s=>s.id)).filter(site=>SOURCES.some(s=>s.id===site)))];
 if(!sites.length)throw new Error('Choose at least one website.');
 const country=COUNTRIES.some(([id])=>id===input.country)?input.country:'turkey',hours=[24,72,168,720].includes(Number(input.hours_old))?Number(input.hours_old):168;
 const work_mode=['remote_only','local_only','local_and_remote','anywhere'].includes(input.work_mode)?input.work_mode:input.remote?'remote_only':input.location?'local_and_remote':'anywhere';
 return{queries,match_queries:match_queries.length?match_queries:queries,explicit:!!match_queries.length&&!input.planned,sites,location:String(input.location??'').trim().slice(0,160),work_mode,country,limit:Math.min(300,Math.max(5,Number(input.limit)||25)),easy_apply:!!input.easy_apply,hours_old:hours,remote:work_mode==='remote_only',force:!!input.force,linkedin_signed_in:!!input.linkedin_signed_in,level:['early','mid','senior','unknown'].includes(input.level)?input.level:null,
  // Working languages: explicit choice first, otherwise those found in the CV. Empty = no language filter.
  languages:normalizeLanguages(Array.isArray(input.languages)?input.languages:profile?.languages||[]),
  home_country:COUNTRIES.some(([id])=>id===input.home_country&&id!=='worldwide')?input.home_country:homeCountry(profile?.location)};
}
const JOB_BOARDS=new Set(['linkedin','indeed','glassdoor','ziprecruiter','wellfound','yc']);
export function applyRoute(job){
 if(process.env.APPLYBURST_DEMO_FIXTURES==='1'&&job.fixture_family&&/^http:\/\/127\.0\.0\.1:\d+\//.test(job.apply_url))return{route:'fixture',family:job.fixture_family,label:'Local test employer · '+job.fixture_family,automatable:true,login:null};
 const targetSite=siteForURL(job.destination_url||job.apply_url);
 if(['greenhouse','lever','ashby','workable'].includes(targetSite?.id))return{route:'ats',family:targetSite.id,label:targetSite.name+' form',automatable:true,login:null};
 if(targetSite?.id==='indeed')return{route:'indeed',family:'indeed',label:'Indeed Apply',automatable:true,login:'indeed'};
 if(targetSite?.id==='glassdoor')return{route:'glassdoor',family:'glassdoor',label:'Glassdoor Apply',automatable:true,login:'glassdoor'};
 if(targetSite?.id==='linkedin'&&job.provider!=='linkedin')return{route:'linkedin_unknown',family:'linkedin',label:'LinkedIn · checks Easy Apply or employer form',automatable:false,inspectable:true,login:'linkedin'};
 if(job.apply_route==='linkedin_easy_apply')return{route:'linkedin_easy_apply',family:'linkedin',label:'LinkedIn Easy Apply',automatable:true,login:'linkedin'};
 if(job.apply_route==='linkedin_offsite')return{route:'linkedin_offsite',family:null,label:'Company website (via LinkedIn)',automatable:false,login:'linkedin'};
 if(job.provider==='linkedin'&&!job.destination_url)return{route:'linkedin_unknown',family:'linkedin',label:'LinkedIn · checks Easy Apply or employer form',automatable:false,inspectable:true,login:'linkedin'};
 if(job.apply_route==='indeed'||job.provider==='indeed'&&!job.destination_url&&siteForURL(job.apply_url)?.id==='indeed')return{route:'indeed',family:'indeed',label:'Indeed Apply',automatable:true,login:'indeed'};
 if(job.apply_route==='glassdoor')return{route:'glassdoor',family:'glassdoor',label:'Glassdoor Apply',automatable:true,login:'glassdoor'};
 const site=targetSite,family=site&&!JOB_BOARDS.has(site.id)?site.id:null;
 if(['greenhouse','lever','ashby','workable'].includes(family))return{route:'ats',family,label:site.name+' form',automatable:true,login:null};
 if(family)return{route:'ats',family,label:site.name+' form · adapter coming',automatable:false,login:null};
 const boards={himalayas:['himalayas.app'],remoteok:['remoteok.com'],jobicy:['jobicy.com'],remotive:['remotive.com','remotive.io'],arbeitnow:['arbeitnow.com'],google:['google.com']};
 const hostname=(()=>{try{return new URL(job.destination_url||job.apply_url).hostname;}catch{return'';}})();
 const board=Object.keys(boards).find(id=>boards[id].some(host=>hostname===host||hostname.endsWith('.'+host)));
 if(board)return{route:'aggregator',family:board,label:'Resolve employer application',automatable:false,inspectable:true,resolve_only:true,login:null};
 const host=(()=>{try{return new URL(job.destination_url||job.apply_url).hostname.replace(/^www\./,'');}catch{return'';}})();
 return{route:'employer_site',family:null,label:host?'Company site · '+host:'Company site',automatable:false,login:null};
}
export class Discovery{
 constructor({store,search,root,profileDir=null,browserBusy=()=>false,onJobs=()=>{},afterRun=()=>{},planner=null,cvText=()=>null}){
  this.store=store;this.search=search;this.root=root;this.task=null;this.profileDir=profileDir;this.browserBusy=browserBusy;this.usingBrowser=false;this.onJobs=onJobs;this.afterRun=afterRun;this.planner=planner;this.cvText=cvText;
  store.db.exec(`CREATE TABLE IF NOT EXISTS search_queries(query_key TEXT PRIMARY KEY,site TEXT NOT NULL,query TEXT NOT NULL,options TEXT NOT NULL,last_success_at REAL,last_attempt_at REAL,outcome TEXT,error TEXT,count INTEGER,elapsed_seconds REAL);
   CREATE TABLE IF NOT EXISTS search_results(query_key TEXT NOT NULL,job_id TEXT NOT NULL,rank INTEGER NOT NULL,observed_at REAL NOT NULL,PRIMARY KEY(query_key,job_id));
   CREATE TABLE IF NOT EXISTS rate_events(seq INTEGER PRIMARY KEY AUTOINCREMENT,site TEXT NOT NULL,at REAL NOT NULL,outcome TEXT NOT NULL,count INTEGER,elapsed_seconds REAL,note TEXT);`);
 }
 // Search results not seen again for three weeks leave the active list; a later search revives them.
 retire(){const cutoff=Date.now()/1000-RETIRE_DAYS*86400,rows=this.store.db.prepare("SELECT id,content_hash FROM jobs WHERE source_id LIKE 'search:%' AND active=1 AND last_seen<?").all(cutoff);
  for(const row of rows){this.store.db.prepare('UPDATE jobs SET active=0 WHERE id=?').run(row.id);this.store.db.prepare('DELETE FROM job_chunks WHERE job_id=?').run(row.id);this.store.db.prepare('INSERT INTO index_events(job_id,content_hash,kind,created_at) VALUES(?,?,?,?)').run(row.id,row.content_hash,'expire',Date.now()/1000);}return rows.length;}
 throttle(site){const state=this.store.setting('throttle:'+site);return state&&state.until>Date.now()/1000?state:null;}
 sitesState(){return SOURCES.map(source=>({...source,cooling_until:this.throttle(source.id)?.until||null,recent:this.store.db.prepare('SELECT outcome,count,elapsed_seconds,at,note FROM rate_events WHERE site=? ORDER BY seq DESC LIMIT 5').all(source.id)}));}
 // Query key is independent of limit so deeper searches (100 -> 200 -> 300) continue from saved cursor/offset.
 key(site,query,request){return hash({site,query:query.toLowerCase(),location:request.location.toLowerCase(),country:request.country,easy_apply:site==='linkedin'?request.easy_apply:false,hours_old:request.hours_old,remote:request.remote,signed_in:site==='linkedin'&&request.linkedin_signed_in,...(site==='linkedin'&&request.level?{level:request.level}:{})});}
 legacyKey(site,query,request,limit=100){return hash({site,query:query.toLowerCase(),location:request.location.toLowerCase(),country:request.country,limit,easy_apply:site==='linkedin'?request.easy_apply:false,hours_old:request.hours_old,remote:request.remote,signed_in:site==='linkedin'&&request.linkedin_signed_in});}
 migrateLegacyQuery(row,request){
  let cached=this.store.db.prepare('SELECT * FROM search_queries WHERE query_key=?').get(row.key);
  if(cached)return cached;
  for(const lim of [100,25,200,300]){
   const oldKey=this.legacyKey(row.site,row.query,request,lim);
   const old=this.store.db.prepare('SELECT * FROM search_queries WHERE query_key=?').get(oldKey);
   if(old){
    this.store.db.prepare('INSERT OR REPLACE INTO search_queries VALUES(?,?,?,?,?,?,?,?,?,?)').run(row.key,old.site,old.query,old.options,old.last_success_at,old.last_attempt_at,old.outcome,old.error,old.count,old.elapsed_seconds);
    const oldResults=this.store.db.prepare('SELECT job_id,rank,observed_at FROM search_results WHERE query_key=?').all(oldKey);
    const ins=this.store.db.prepare('INSERT OR REPLACE INTO search_results VALUES(?,?,?,?)');
    for(const r of oldResults)ins.run(row.key,r.job_id,r.rank,r.observed_at);
    const oldMore=this.store.setting('search_more:'+oldKey);
    if(oldMore!==null&&oldMore!==undefined)this.store.setting('search_more:'+row.key,oldMore);
    return this.store.db.prepare('SELECT * FROM search_queries WHERE query_key=?').get(row.key);
   }
  }
  return null;
 }
 searchState(key,site,cached){
  const state=this.store.setting('search_state:'+key);
  if(state)return state;
  if(!cached)return null;
  const more=this.store.setting('search_more:'+key);
  const count=cached.count||0;
  const hasMore=more!==null&&more!==undefined?!!more:(['indeed','himalayas','linkedin'].includes(site)&&count>=20);
  return{fetched_limit:Math.max(count,100),has_more:hasMore,next_cursor:null,next_page:site==='himalayas'?Math.floor(count/20)+1:null,next_offset:count,stop_reason:hasMore?'budget_reached':'exhausted'};
 }
 cachedIds(key){return this.store.db.prepare('SELECT r.job_id FROM search_results r JOIN jobs j ON j.id=r.job_id AND j.active=1 WHERE r.query_key=? ORDER BY r.rank').all(key).map(row=>row.job_id);}
 ingest(site,rows,key,offset,score=true){
  const source={id:'search:'+site,provider:site,board:'search',kind:'targeted-search',url:SITE_URL[site]},jobs=[];
  for(const raw of rows){try{const job=normalizedJob(source,{...raw,seniority:undefined});Object.assign(job,{listing_url:raw.listing_url||job.apply_url,destination_url:raw.destination_url||null,apply_route:raw.apply_route||'unknown',description_state:raw.description_state||'missing',emails:raw.emails||[],provider_seniority:raw.seniority||null});
   if(raw.closed)job.closed_signal=true;if(process.env.APPLYBURST_DEMO_FIXTURES==='1'&&/^http:\/\/127[.]0[.]0[.]1:\d+\//.test(job.apply_url)&&['greenhouse','lever','ashby','linkedin','indeed'].includes(raw.fixture_family))job.fixture_family=raw.fixture_family;jobs.push(job);}catch{}}
  const unique=[...new Map(jobs.map(job=>[job.id,job])).values()];if(!unique.length)return[];
  this.store.replaceSource(source,unique,{complete:false,report:{outcome:'targeted_search',method:'query_driven'}});
  try{this.onJobs(unique);}catch{}
  if(score)this.scoreSoon(unique.map(job=>job.id));
  const now=Date.now()/1000,insert=this.store.db.prepare('INSERT INTO search_results VALUES(?,?,?,?) ON CONFLICT(query_key,job_id) DO UPDATE SET observed_at=excluded.observed_at');
  if(key)unique.forEach((job,index)=>insert.run(key,job.id,offset+index,now));return unique.map(job=>job.id);
 }
 // The plan's role vectors (from the CV, or from the person's own queries) score every job found.
 scoreSoon(ids){const task=this.task;if(!task?.planReady||!ids.length)return;task.scorePending=(task.scorePending||0)+1;task.scoring=(task.scoring||Promise.resolve()).then(()=>this.score(task,ids)).catch(error=>{task.plan_error=String(error.message).slice(0,200);}).finally(()=>{task.scorePending--;});}
 async score(task,ids){
  const plan=await task?.planReady;if(!plan?.roles?.length)return;
  const jobs=ids.filter(id=>!task.semantic.has(id)).map(id=>this.store.getJob(id)).filter(Boolean);if(!jobs.length)return;
  const tick=performance.now();for(const [id,value]of await this.planner.relevance(jobs,plan))task.semantic.set(id,value);task.semantic_ms=(task.semantic_ms||0)+performance.now()-tick;
 }
 start(request,{plan:providedPlan=null}={}){
  if(this.task?.running)throw new Error('A search is already running.');
  const task={id:randomUUID(),running:true,started_at:Date.now(),request,rows:[],semantic:new Map(),workers:new Set()};this.task=task;
  if(this.planner){const text=request.cv_text??this.cvText()??'';task.planReady=(providedPlan?Promise.resolve(providedPlan):this.planner.plan(text,{queries:request.explicit||!text?request.match_queries:[],country:request.country})).then(plan=>{task.plan_summary={roles:plan.roles.map(r=>r.title),early:plan.early,level:request.level||(request.explicit||!text?'unknown':plan.early?'early':inferLevel(text)==='senior'?'senior':'mid'),source:request.explicit||!text?'your search':'your CV',elapsed_ms:plan.elapsed_ms};return plan;}).catch(error=>{task.plan_error=error.message;return null;});}
  for(const [index,remote]of request.queries.entries())for(const site of request.sites){const query=site==='boards'?(request.match_queries?.[index]||remote):remote;
   const cities=request.location.split(/[;,|]/).map(s=>s.trim()).filter(Boolean).slice(0,5),scopes=['linkedin','indeed','glassdoor','google'].includes(site)&&!request.remote&&cities.length?cities:[request.remote?'':request.location];
   for(const location of scopes)task.rows.push({site,query,location,key:site==='boards'?null:this.key(site,query,{...request,location}),state:'queued',job_ids:[],count:0,warnings:[],has_more:false,stop_reason:null});}
  this.run(task).catch(error=>{task.error=error.message;}).finally(()=>{task.running=false;task.finished_at=Date.now();if(task.cancelled)task.phase='stopped';const {planReady,scoring,workers,...saved}=task;this.store.setting('last_discovery',{...saved,semantic:[...task.semantic],rows:task.rows.map(({job_ids,initial_ids,continuation,...row})=>({...row,job_ids:job_ids.slice(0,100)}))});});
  return task;
 }
 stop(){const task=this.task;if(!task?.running)return false;task.cancelled=true;task.phase='stopping';for(const worker of task.workers||[])worker.kill();for(const row of task.rows)if(row.state==='queued'){row.state='cancelled';row.stop_reason='stopped';}return true;}
 async run(task){
  const request=task.request,queue=[],boardRows=[],revision=this.store.revision;
  for(const row of task.rows){
   if(row.site==='boards'){boardRows.push(row);continue;}
   const cached=this.migrateLegacyQuery(row,request),fresh=cached?.last_success_at&&Date.now()/1000-cached.last_success_at<(cached.count?CACHE_SECONDS:300);
   const state=this.searchState(row.key,row.site,cached),allCachedIds=cached?this.cachedIds(row.key):[];
   const fetchedLimit=state?.fetched_limit||(cached?Math.max(allCachedIds.length,100):0);
   const canContinue=!!state?.has_more&&request.limit>fetchedLimit&&allCachedIds.length<request.limit;
   if(fresh&&!request.force&&!canContinue){
    const ids=allCachedIds.slice(0,request.limit);
    const hasMore=allCachedIds.length>request.limit||(!!state?.has_more&&request.limit<300);
    Object.assign(row,{state:'cached',job_ids:ids,count:ids.length,has_more:hasMore,stop_reason:hasMore?'budget_reached':(state?.stop_reason||'exhausted'),cache_age_seconds:Math.round(Date.now()/1000-cached.last_success_at)});
    this.scoreSoon(row.job_ids);continue;
   }
   const cooling=this.throttle(row.site==='linkedin'&&request.linkedin_signed_in?'linkedin_session':row.site);
   if(cooling){
    const ids=allCachedIds.slice(0,request.limit);
    Object.assign(row,{state:'cooling_down',job_ids:ids,count:ids.length,has_more:false,stop_reason:'throttled',cooling_until:cooling.until,note:'Paused after the site throttled us. Showing the last saved results.'});
    this.scoreSoon(row.job_ids);continue;
   }
   if(canContinue&&!request.force){row.continuation=state;row.initial_ids=allCachedIds;}
   queue.push(row);
  }
  // LinkedIn throttles by IP: one LinkedIn search at a time; other sites in parallel.
  const linked=queue.filter(row=>row.site==='linkedin'),others=queue.filter(row=>row.site!=='linkedin');
  const runAll=async rows=>{for(const row of rows){if(task.cancelled)break;await this.remote(row,request);}};
  const pool=async(rows,size)=>{const list=[...rows];await Promise.all(Array.from({length:Math.min(size,list.length)},async()=>{while(list.length&&!task.cancelled)await this.remote(list.shift(),request);}));};
  await Promise.all([runAll(linked),pool(others,4),Promise.all(boardRows.map(row=>this.boards(row,request)))]);
  if(task.cancelled)return;
  // Cached queries must pass the same gate as freshly fetched jobs. Never finish before
  // pending title/CV scoring, and never score an entire unfiltered feed on the hot path.
  task.phase='matching';if(task.scoring)await task.scoring;
  if(task.planReady){await this.score(task,this.jobsFor(task));if(task.plan_error)throw new Error('Role matching could not finish: '+task.plan_error);}
  task.phase='complete';
  if(this.store.revision!==revision)await this.search.load(this.search.persistent?null:this.store.catalog());
  try{this.afterRun();}catch{}
 }
 async boards(row,request){
  if(this.task?.cancelled){row.state='cancelled';return;}
  const tick=performance.now();
  const cacheKey=hash({query:row.query,request,revision:this.store.revision});
  this.boardCache??=new Map();const cached=this.boardCache.get(cacheKey);
  if(cached&&Date.now()-cached.at<30000){Object.assign(row,{...cached.row,state:'cached',elapsed_seconds:(performance.now()-tick)/1000});return;}
  try{const result=await this.search.query(simpleQuery(row.query),{location:request.work_mode==='remote_only'?'':request.location,include_remote:request.work_mode==='local_and_remote',workplace:request.remote?'remote':null,providers:[...ATS],country:request.country},Math.min(1000,Math.max(200,request.limit*6)));
   const queryEvidence=new Map(result.results.map((job,rank)=>[job.id,{rrf:1/(40+rank),queries:[row.query],evidence:job.evidence||[]}]));
   const raw=result.results.map(job=>this.store.getJob(job.id)).filter(job=>job&&ATS.has(job.provider));
   // Pre-filter before scoring: strict relevance needs scores, so it applies only in the second pass.
   const candidates=rankJobs(raw,{...request,queries:[row.query],queryEvidence,semantic:null,strict_relevance:false,level:this.task?.plan_summary?.level}).results.slice(0,Math.max(100,request.limit*3));await this.score(this.task,candidates.map(job=>job.id));
   const plan=await this.task?.planReady;
   const ranked=rankJobs(candidates,{...request,queries:[row.query],queryEvidence,semantic:this.task?.semantic,early:plan?.early??null,level:this.task?.plan_summary?.level,targets:this.task?.plan_summary?.roles});
   if(this.task?.cancelled){row.state='cancelled';row.stop_reason='stopped';return;}
   const ids=ranked.results.slice(0,request.limit).map(job=>job.id),hasMore=ranked.results.length>request.limit||request.limit<300&&result.total>result.results.length;
   Object.assign(row,{state:'done',job_ids:ids,count:ids.length,indexed_matches:result.total,examined:raw.length,policy_candidates:candidates.length,has_more:hasMore,stop_reason:hasMore?'budget_reached':'exhausted',elapsed_seconds:(performance.now()-tick)/1000,note:'Searched the saved company index; location and role filters determine matches.'});}
  catch(error){Object.assign(row,{state:'failed',stop_reason:'failed',error:error.message});}
  if(row.state==='done'){if(this.boardCache.size>30)this.boardCache.clear();this.boardCache.set(cacheKey,{at:Date.now(),row:{job_ids:row.job_ids,count:row.count,has_more:row.has_more,stop_reason:row.stop_reason,note:row.note}});}
 }
 async remote(row,request){
  const task=this.task;if(task?.cancelled){row.state='cancelled';row.stop_reason='stopped';return;}
  if(row.location!==undefined)request={...request,location:row.location};
  const cooling=this.throttle(row.site==='linkedin'&&request.linkedin_signed_in?'linkedin_session':row.site);
  if(cooling){const ids=this.cachedIds(row.key).slice(0,request.limit);Object.assign(row,{state:'cooling_down',job_ids:ids,count:ids.length,has_more:false,stop_reason:'throttled',cooling_until:cooling.until,note:'Paused after this source throttled an earlier query in the run.'});return;}
  row.state='searching';row.started_at=Date.now();const seen=new Set(),order=[];
  const canResume=!!row.continuation&&(row.site!=='indeed'||!!row.continuation.next_cursor);
  if(canResume){
   for(const id of row.initial_ids||[])if(!seen.has(id)){seen.add(id);order.push(id);}
   row.job_ids=[...order];row.count=order.length;row.resumed_from=order.length;
   this.scoreSoon(order);
  }
  // LinkedIn and Google search worldwide without a location; default to the chosen country.
  const country=COUNTRIES.find(([id])=>id===request.country),where=request.location||(['linkedin','google'].includes(row.site)&&request.country!=='worldwide'?country?.[1]||'':'');
  // "Easy Apply only" is a LinkedIn filter; on Indeed the same flag would mean Indeed Apply only.
  const input={site:row.site,query:row.query,location:where,country:request.country,limit:request.limit,easy_apply:row.site==='linkedin'&&request.easy_apply,hours_old:request.hours_old,remote:request.remote,level:row.site==='linkedin'?request.level:null};
  if(canResume){
   Object.assign(input,{cursor:row.continuation.next_cursor||null,start_page:row.continuation.next_page||1,start_offset:row.continuation.next_offset??order.length,existing_count:order.length});
  }
  // Signed-in LinkedIn search uses the PC browser profile, so it waits for nothing and never overlaps a browser task.
  const signed=row.site==='linkedin'&&request.linkedin_signed_in&&this.profileDir&&!this.browserBusy();
  if(row.site==='linkedin'&&request.linkedin_signed_in&&!signed)row.note='The PC browser is busy, so the public LinkedIn search was used.';
  if(signed){Object.assign(input,{signed_in:true,browser_profile:this.profileDir});this.usingBrowser=true;row.method='signed_in_browser';}
  const onEvent=event=>{
   if(task?.cancelled)return;
   if(event.type==='jobs'){const ids=this.ingest(row.site,event.jobs,row.key,order.length);for(const id of ids)if(!seen.has(id)){seen.add(id);order.push(id);}row.job_ids=[...order];row.count=order.length;row.phase=event.phase;}
   else if(event.type==='done')row.done=event;};
  let result;
  if(!signed&&SCRAPERS[row.site]){
   const tick=performance.now(),report={warnings:[],throttled:false,batch:jobs=>onEvent({type:'jobs',jobs}),catalog:(jobs,revision)=>{if(task?.cancelled)return;const key='feed_ingestion:'+row.site;if(this.store.setting(key)!==revision){this.ingest(row.site,jobs,null,0,false);this.store.setting(key,revision);}}};
   try{
    const jobs=await searchHTTP(row.site,input,report);
    if((!order.length||canResume&&order.length===(row.initial_ids?.length||0))&&jobs.length)onEvent({type:'jobs',jobs});
    row.done={outcome:order.length?'returned':report.captcha?'captcha_required':report.throttled?'throttled':'no_results',captcha:!!report.captcha,warnings:report.warnings,has_more:report.has_more,next_cursor:report.next_cursor,next_page:report.next_page,next_offset:report.next_offset,stop_reason:report.stop_reason,retry_after_seconds:report.retry_after_seconds,feed_cache_age_seconds:report.feed_cache_age_seconds,elapsed_seconds:(performance.now()-tick)/1000};
   }catch(error){row.done={outcome:'failed',stop_reason:'failed',error:error.message,warnings:report.warnings};}
   result={elapsed_ms:performance.now()-tick,stderr:''};
  }else{const worker=runWorker({root:this.root,module:'live_search',input,timeoutMs:120000,onEvent});task?.workers?.add(worker);try{result=await worker.done;}finally{task?.workers?.delete(worker);}}
  if(task?.cancelled){if(signed)this.usingBrowser=false;Object.assign(row,{state:'cancelled',stop_reason:'stopped'});return;}
  if(signed)this.usingBrowser=false;const done=row.done||{outcome:'failed',stop_reason:'failed',error:result.killed?'Timed out after 120 seconds.':(result.stderr.split('\n').filter(Boolean).at(-1)||'Worker exited.').slice(0,300)};
  const now=Date.now()/1000,throttled=[...(done.warnings||[]),done.error||''].some(w=>/HTTP (429|999)|throttl/i.test(w));
  // A complete fresh query replaces its membership; continuations and partial/throttled reads retain earlier evidence.
  const success=!throttled&&done.outcome!=='failed'&&!(done.warnings||[]).length;
  if(success&&!canResume){const previous=this.store.db.prepare('SELECT job_id FROM search_results WHERE query_key=?').all(row.key),remove=this.store.db.prepare('DELETE FROM search_results WHERE query_key=? AND job_id=?');for(const old of previous)if(!seen.has(old.job_id))remove.run(row.key,old.job_id);}
  const hasMore=!!done.has_more&&request.limit<300;
  const stopReason=done.stop_reason||(done.captcha?'captcha_required':throttled?'throttled':done.outcome==='failed'?'failed':done.has_more?'budget_reached':'exhausted');
  Object.assign(row,{state:done.captcha?'captcha_required':done.outcome==='failed'&&!order.length?'failed':order.length?'done':throttled?'throttled':'no_results',captcha:!!done.captcha,error:done.error||null,warnings:done.warnings||[],elapsed_seconds:done.elapsed_seconds??result.elapsed_ms/1000,feed_cache_age_seconds:done.feed_cache_age_seconds,details:done.details??null,has_more:hasMore,stop_reason:stopReason});
  const nextState={fetched_limit:Math.max(request.limit,row.continuation?.fetched_limit||0),has_more:!!done.has_more,next_cursor:done.next_cursor||null,next_page:done.next_page||null,next_offset:done.next_offset??order.length,stop_reason:stopReason,updated_at:now};
  this.store.setting('search_state:'+row.key,nextState);
  this.store.setting('search_more:'+row.key,!!done.has_more);
  this.store.db.prepare(`INSERT INTO search_queries VALUES(?,?,?,?,?,?,?,?,?,?) ON CONFLICT(query_key) DO UPDATE SET last_success_at=COALESCE(excluded.last_success_at,search_queries.last_success_at),last_attempt_at=excluded.last_attempt_at,outcome=excluded.outcome,error=excluded.error,count=excluded.count,elapsed_seconds=excluded.elapsed_seconds`)
   .run(row.key,row.site,row.query,JSON.stringify(input),success||order.length?now:null,now,done.outcome,done.error||(done.warnings||[]).join(' | ')||null,order.length,row.elapsed_seconds);
  this.store.db.prepare('INSERT INTO rate_events(site,at,outcome,count,elapsed_seconds,note) VALUES(?,?,?,?,?,?)').run(signed?'linkedin_session':row.site,now,throttled?'throttled':done.outcome,order.length,row.elapsed_seconds,(done.warnings||[]).join(' | ').slice(0,500)||null);
  const throttleKey=signed?'linkedin_session':row.site;
  if(throttled){
   const previous=this.store.setting('throttle:'+throttleKey),baseBackoff=Math.min(3600,previous?.backoff?previous.backoff*2:120);
   const backoff=Math.min(3600,Math.max(baseBackoff,Number(done.retry_after_seconds)||0))+Math.round(Math.random()*15);
   this.store.setting('throttle:'+throttleKey,{until:now+backoff,backoff,at:now,reason:(done.warnings||[])[0]||'throttled'});row.cooling_until=now+backoff;
   // Keep earlier results visible: a throttled or empty search never erases what was found before.
   if(!order.length){row.job_ids=this.cachedIds(row.key).slice(0,request.limit);row.count=row.job_ids.length;}
  }else if(order.length)this.store.setting('throttle:'+throttleKey,null);
 }
 // Interleave sites so the first screen shows every source, keeping each site's own ranking.
 jobsFor(task){
  const lists=task.rows.map(row=>row.job_ids),out=[],seen=new Set();
  for(let i=0;lists.some(list=>i<list.length);i++)for(const list of lists){const id=list[i];if(id&&!seen.has(id)){seen.add(id);out.push(id);}}
  return out;
 }
 ranked(task,profile=null){
  // JSON cannot preserve Map. Old snapshots stored {}; keep those results pending rather
  // than treating missing semantic evidence as permission to apply automatically.
  if(!(task.semantic instanceof Map))task.semantic=new Map(Array.isArray(task.semantic)?task.semantic:[]);
  const ids=this.jobsFor(task),key=hash({request:task.request,ids,profile,revision:this.store.revision,scored:task.semantic?.size||0,minute:Math.floor(Date.now()/60000)});
  if(this.rankCache?.key===key)return this.rankCache.result;
  const result=rankJobs(ids.map(id=>this.store.getJob(id)).filter(Boolean),{...task.request,queries:task.request.match_queries||task.request.queries,profile,semantic:task.semantic,early:task.plan_summary?.early??null,level:task.plan_summary?.level,targets:task.plan_summary?.roles});
  result.plan=task.plan_summary||null;result.scored=task.semantic?.size||0;
  this.rankCache={key,result};return result;
 }
}
