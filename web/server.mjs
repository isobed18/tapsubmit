import {createServer} from 'node:http';
import {SharedPool} from './lib/shared-pool.mjs';
import {cvPreferenceDraft,applyCVPreferences,cvModelFill} from './lib/cv-settings.mjs';
import {resumeLanguages,LANGUAGES} from './lib/languages.mjs';
import {readFileSync,existsSync,mkdirSync,writeFileSync,copyFileSync,unlinkSync,statSync,createReadStream} from 'node:fs';
import {join} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {gzipSync} from 'node:zlib';
import {randomUUID} from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {Worker} from 'node:worker_threads';
import {Store} from './lib/store.mjs';
import {Auth,ensureAdmin,readAdmin} from './lib/auth.mjs';
import {decorate,hash} from './lib/jobs.mjs';
import {loadSources,refreshSources} from './lib/sources.mjs';
import {IndexedSearch} from './lib/indexed-search.mjs';
import {recommend} from './lib/recommendations.mjs';
import {SITES,siteForURL} from './lib/application-plan.mjs';
import {SOURCES,COUNTRIES,Discovery,discoveryRequest,suggestedQueries,applyRoute} from './lib/discovery.mjs';
import {inferLevel} from './shared/features.mjs';
import {Planner,PLAN_VERSION} from './lib/planner.mjs';
import {Intents} from './lib/intents.mjs';
import {Assistant} from './lib/assistant.mjs';
import {PreferenceEditor} from './lib/preference-editor.mjs';
import {geography,workArrangement,summarizeExclusions,homeCountry} from './lib/matching.mjs';
import {TelegramReview} from './lib/telegram.mjs';
import {semanticStats} from './lib/semantic.mjs';
import {Applications,BLOCKING,destinationKey} from './lib/applications.mjs';
import {Boards} from './lib/boards.mjs';
import {runWorker,workerCommand,workerEnv} from './lib/worker.mjs';
import {PREFERENCE_SCHEMA,savePreferences,inferPreferenceFromQuestion,preferenceSpec} from './lib/preferences.mjs';
import {publicDiscovery} from './lib/public-discovery.mjs';
import {cityOptions} from './lib/locations.mjs';
import {TRACKS,profileFromText,profileMatch,simpleQuery,resumeContacts,CONTACT_PARSER_VERSION} from './lib/profile.mjs';
import {ANSWERS,RESUME} from '../demo/lib/sandbox.mjs';
import {greenhouseSchema} from '../demo/lib/form-schema.mjs';

const ROOT=fileURLToPath(new URL('..',import.meta.url));
const LOGIN_SITES={linkedin:'LinkedIn',indeed:'Indeed',glassdoor:'Glassdoor'};
const DEFAULT_PACE={linkedin_apply_seconds:4,concurrency:2,confirm_timeout:45,fast_prepare_seconds:12};
export async function createPortal({root=ROOT,directory=process.env.APPLYBURST_DATA||join(root,'.data/portal'),base='/applyburst',publicOrigin=process.env.APPLYBURST_PUBLIC_ORIGIN||'https://tapsubmit.com',seed=true,automaticRefresh=seed,mode=process.env.APPLYBURST_MODE||'local',provisionAdmin=false}={}){
 mkdirSync(directory,{recursive:true});let browserRun=null,desktopTicket=process.env.APPLYBURST_DESKTOP_TICKET||null,automation=null,automationMonitor=null,assistant=null,telegram=null,preferenceEditor=null;
 // Production local installs register their owner. Public website allows member registration.
 const store=new Store(join(directory,'portal.sqlite')),admin=mode!=='local'||provisionAdmin?ensureAdmin(directory):readAdmin(directory),auth=new Auth(store,admin,{directory,allowMembers:mode!=='local'}),search=new IndexedSearch(store),sources=loadSources(root);
 const workspaceId=store.setting('workspace_id')||store.setting('workspace_id',randomUUID());
 const applications=new Applications(store.db),profileDir=join(directory,'browser-profile'),boards=new Boards({store,search});
 // Every search result can reveal an employer board; index those boards in the background after the search.
 const planner=new Planner({store,dataDirectory:directory}),intents=new Intents({store,dataDirectory:directory}),localCV=()=>existsSync(join(directory,'resume.txt'))?readFileSync(join(directory,'resume.txt'),'utf8'):null;
 // CV -> search directions for any profession/language: explicit queries win, otherwise the CV plan decides.
 // The CV's career level travels with every search (typed queries too) so sources can filter natively.
 async function withPlan(input){const text=localCV(),inferred=text?inferLevel(text):null,level=inferred==='unknown'?'mid':inferred;if(Array.isArray(input.queries)&&input.queries.some(q=>String(q).trim()))return{...input,level};if(!text)return input;const plan=await planner.plan(text,{country:input.country||'turkey'});return{...input,queries:plan.queries,planned:true,level:plan.early?'early':level};}
 // Optional shared pool: searched when downloaded and enabled; found jobs are shared only with permission.
 const sharedPool=new SharedPool({store,directory});
 const runJobs=()=>[...new Set((discovery.task?.rows||[]).flatMap(row=>row.job_ids||[]))].map(id=>store.getJob(id)).filter(job=>job&&!String(job.source_id||'').startsWith('shared'));
 const discovery=new Discovery({store,search:sharedPool.attach(search,store),root,planner,cvText:localCV,profileDir,browserBusy:()=>!!browserRun?.running,onJobs:jobs=>boards.note(jobs),afterRun:()=>{boards.resolveShort().then(()=>boards.indexNew()).catch(()=>{});if(mode==='local')sharedPool.share(runJobs()).catch(()=>{});}});
 if(seed&&!store.setting('seeded')){
  const seedCatalog=JSON.parse(readFileSync(join(root,'demo/public/jobs.json'),'utf8')),groups=new Map();
  for(const raw of seedCatalog.jobs){const source_id=raw.provider+':'+raw.board,job=decorate({...raw,source_id,source_kind:'ats'});if(!groups.has(source_id))groups.set(source_id,[]);groups.get(source_id).push(job);}
  for(const [id,jobs]of groups){const source={id,provider:jobs[0].provider,board:jobs[0].board,kind:'ats'};store.replaceSource(source,jobs,{complete:true,report:{outcome:'bundled_snapshot'}});store.saveState(id,{...store.state(id),observed_at:Math.min(...jobs.map(j=>j.seen_at))});}store.setting('seeded',true);
 }
 const resumeFile=join(directory,'resume.txt');if(existsSync(resumeFile)){const text=readFileSync(resumeFile,'utf8'),revision=hash(text);if(store.setting('resume_revision')!==revision){store.setting('profile',profileFromText(text));store.setting('resume_revision',revision);}}
 // Repair missing contact extraction in already-uploaded CVs without replacing user edits or retrying applications.
 // CV -> Settings: rules first (instant); the optional local model only fills empty fields, when local drafts are enabled.
 function fillFromCV(text,withModel=false){const revision=hash(text);let filled=[];try{filled=applyCVPreferences(store,cvPreferenceDraft(text));}catch{}store.setting('cv_preferences_revision',revision);if(withModel&&assistant?.llmSettings().enabled)cvModelFill({assistant,store,text,revision:store.setting('resume_revision')});return filled;}
 if(existsSync(resumeFile)&&store.setting('profile')&&store.setting('cv_preferences_revision')!==hash(readFileSync(resumeFile,'utf8')))fillFromCV(readFileSync(resumeFile,'utf8'));
 if(existsSync(resumeFile)){const profile=store.setting('profile');if(profile&&!Array.isArray(profile.languages))store.setting('profile',{...profile,languages:resumeLanguages(readFileSync(resumeFile,'utf8'))});}
 if(existsSync(resumeFile)){const profile=store.setting('profile');if(profile&&profile.contact_parser_version!==CONTACT_PARSER_VERSION){const contacts=resumeContacts(readFileSync(resumeFile,'utf8'));for(const [key,value]of Object.entries(contacts))if(!profile[key]&&value)profile[key]=value;profile.contact_parser_version=CONTACT_PARSER_VERSION;store.setting('profile',profile);}}
 // A CV planned by an older planner is planned again in the background (the chips on screen stay current).
 if(existsSync(resumeFile)&&store.setting('profile')&&store.setting('profile').plan?.version!==PLAN_VERSION)planner.plan(readFileSync(resumeFile,'utf8'),{country:store.setting('last_country')||'turkey'}).then(plan=>{const current=store.setting('profile');if(current)store.setting('profile',{...current,plan:{queries:plan.queries,roles:plan.roles.map(r=>r.title),early:plan.early,model:'paraphrase-multilingual-MiniLM-L12-v2',version:PLAN_VERSION,elapsed_ms:plan.elapsed_ms}});}).catch(()=>{});
 // A previous process may have died mid-run: never leave an attempt looking active or retryable when it may have been sent.
 applications.reconcile();discovery.retire();
 await search.load();let refreshing=null,lastRefresh=store.setting('last_refresh'),refreshStarted=0;const limits=new Map(),recommendationCache=new Map();
 const limited=(key,max=120,seconds=60)=>{const now=Date.now();for(const [id,entry]of limits)if(now-entry.start>seconds*1000)limits.delete(id);let entry=limits.get(key);if(!entry){entry={start:now,count:0};limits.set(key,entry);}return ++entry.count>max;};
 let activeCrawler=null;
 async function refresh(){if(refreshing)return refreshing;refreshStarted=Date.now();refreshing=(async()=>{const worker=new Worker(new URL('./crawl-worker.mjs',import.meta.url),{workerData:{root,directory}});activeCrawler=worker;const report=await new Promise((resolve,reject)=>{worker.once('message',message=>message.error?reject(new Error(message.error)):resolve(message.report));worker.once('error',reject);worker.once('exit',code=>{if(code)reject(new Error('Crawler stopped with code '+code));});});store.revision++;await search.load();lastRefresh=report;store.setting('last_refresh',report);writeFileSync(join(directory,'last-refresh.json'),JSON.stringify(report,null,2));return report;})().finally(()=>{activeCrawler=null;refreshing=null;});return refreshing;}
 const refreshTimer=automaticRefresh?setInterval(()=>refresh().catch(()=>{}),15*60*1000):null,initialRefresh=automaticRefresh?setTimeout(()=>refresh().catch(()=>{}),1500):null;refreshTimer?.unref();initialRefresh?.unref();
 async function body(req,maximum=100000){if(Number(req.headers['content-length']||0)>maximum)throw Object.assign(new Error('Request too large.'),{status:413});const chunks=[];let bytes=0;for await(const chunk of req){bytes+=chunk.length;if(bytes>maximum)throw Object.assign(new Error('Request too large.'),{status:413});chunks.push(chunk);}return Buffer.concat(chunks);}
 const json=async(req,maximum)=>{const raw=(await body(req,maximum)).toString();try{return JSON.parse(raw||'{}');}catch{throw new Error('Invalid JSON.');}};

 // ---- Candidate facts and the revisions a review is bound to -------------------------------
 const resumePath=()=>join(directory,store.setting('resume_file')||'resume.docx');
 function candidate(){const p=store.setting('profile')||{};return{name:p.name||'',email:p.email||'',phone:p.phone||'',location:p.location||'',linkedin:p.linkedin||'',github:p.github||'',resume_path:existsSync(resumePath())?resumePath():null};}
 function revisions(){const {resume_path,...facts}=candidate();return{resume:store.setting('resume_revision')||null,resume_file:resume_path?hash(readFileSync(resume_path)):null,facts:hash(facts),answers:hash([store.setting('answer_bank')||{},store.setting('scoped_answers')||{}]),preferences:hash(store.setting('user_preferences')||{}),policy:hash(store.setting('search_policy')||{})};}
 function policyFit(job){const policy=store.setting('search_policy');return policy?geography(job,policy.country,policy.remote,policy.location,policy.work_mode,policy.home_country||homeCountry(store.setting('profile')?.location)):{status:'unrestricted'};}
 const pace=()=>({...DEFAULT_PACE,...(store.setting('pace')||{})});
 // Permission modes. "review" needs the exact-batch review screen. "auto_known" submits prepared applications whose
 // every value came from the resume, a derived phone code or a saved answer. "auto_all" also accepts values the
 // website itself prefilled. Unknown questions always stop; nothing is ever resent automatically.
 const PERMISSION_DEFAULT={mode:'review',sites:{linkedin:true,indeed:false,glassdoor:false,greenhouse:true,lever:true,ashby:true,workable:true},daily_cap:25,paused:false};
 const permissions=()=>{const saved=store.setting('permissions')||{};return{...PERMISSION_DEFAULT,...saved,sites:{...PERMISSION_DEFAULT.sites,...(saved.sites||{})}};};
 // Safety profiles chosen on the main screen. Each maps onto the permission mode the durable intent check
 // enforces. Automatic profiles need one explicit consent for their scope; Start never widens it silently.
 const PROFILES={find_only:{mode:'review',task:null},prepare_review:{mode:'review',task:'prepare'},controlled_auto:{mode:'auto_known',task:'auto'},full_auto:{mode:'auto_all',task:'auto'}};
 const profileName=()=>PROFILES[store.setting('automation_profile')]?store.setting('automation_profile'):'find_only';
 const consents=()=>store.setting('profile_consents')||{};
 function submittedToday(){const start=new Date();start.setHours(0,0,0,0);return store.db.prepare("SELECT count(DISTINCT job_id) n FROM application_events WHERE state='submitting' AND at>=?").get(start.getTime()/1000).n;}
 function autoEligible(app,job,perm){
  if(perm.mode==='review'||perm.paused||!app||app.state!=='ready_to_submit'||!app.plan_hash||!job)return false;
  // Loopback fixture jobs stand in for a real family only in local end-to-end runs.
  const route=applyRoute(job),fixture=job.fixture_family&&/^http:\/\/127\.0\.0\.1:/.test(applyTarget(job)),family=fixture?job.fixture_family:route.family;if(!(canPrepare(job)||fixture)||!perm.sites[family])return false;
  const allowed=perm.mode==='auto_all'?new Set(['resume','approved_answer','derived_from_phone','user_preference','site_prefilled']):new Set(['resume','approved_answer','derived_from_phone','user_preference']);
  return(app.detail.disclosure||[]).every(row=>allowed.has(row.source));
 }
 function autoSubmitAfter(run){
  const perm=permissions();if(perm.mode==='review'||perm.paused||run.task!=='prepare')return;
  const room=Math.max(0,perm.daily_cap-submittedToday());if(!room)return;
  const ids=run.order.filter(id=>{const app=applications.get(id),job=store.getJob(id);return autoEligible(app,job,perm)&&!applications.blocker(id,applyTarget(job))?.state;}).slice(0,room);
  if(!ids.length)return;
  const plans={},jobs=ids.map(id=>{const job=store.getJob(id),app=applications.get(id),url=applyTarget(job);plans[id]=app.plan_hash;applications.set(id,url,'ready_to_submit',{authorized_by:'permission_mode:'+perm.mode},run.id);
   return{id,url,title:job.title,company:job.company,expected_plan:app.plan_hash,...(job.fixture_family&&/^http:\/\/127\.0\.0\.1:/.test(url)?{family:job.fixture_family}:{})};});
  try{startBrowser('submit',{jobs,review:{ids,plans,authorized_by:'permission_mode:'+perm.mode},options:{headless:true,watch_seconds:0,human_timeout:2}});}catch(error){run.auto_error=error.message;}
 }
 function sessions(){return Object.fromEntries(Object.keys(LOGIN_SITES).map(site=>[site,store.setting('session:'+site)||{signed_in:false,checked_at:null}]));}
 function canPrepare(job){if(policyFit(job).status==='mismatch')return false;const route=applyRoute(job);return route.automatable||route.inspectable&&(!route.login||!!sessions()[route.login]?.signed_in);}
 function applyTarget(job){const route=applyRoute(job);if(route.route==='linkedin_easy_apply'||route.route==='linkedin_unknown'||route.route==='linkedin_offsite')return job.listing_url||job.apply_url;return job.destination_url||job.apply_url;}
 function jobCard(job){const app=applications.get(job.id),route=applyRoute(job);return{id:job.id,title:job.title,company:job.company,location:job.location,provider:job.provider,workplace:job.workplace,employment_type:job.employment_type,seniority:job.provider_seniority||job.seniority,posted_at:job.posted_at,seen_at:job.seen_at,description_state:job.description_state||(job.description?'present':'missing'),listing_url:job.listing_url||job.apply_url,destination_url:job.destination_url||null,route,application:app?{state:app.state,updated_at:app.updated_at}:null,skills:(job.skills||[]).slice(0,8),closed_signal:!!job.closed_signal};}

 // ---- Live run feed ---------------------------------------------------------------------------
 // One card per job: discovery decides found/matching/matched, the durable application table decides the
 // application stage. Every poll re-derives the same cards, so reconnecting never replays or double-counts.
 const STAGE={preparing:'filling',submit_in_progress:'filling',submitting:'sending',confirmed:'confirmed',already_applied:'confirmed',marked_submitted:'confirmed',ready_to_submit:'ready',policy_mismatch:'needs_you',needs_answers:'needs_you',needs_login:'needs_you',needs_human:'needs_you',needs_human_verification:'needs_you',deferred_slow:'needs_you',unknown_after_submit:'uncertain'};
 const SOURCE_LABEL=Object.fromEntries(SOURCES.map(source=>[source.id,source.label.replace(/\s*\(.*\)$/,'')]));
 let feedTask=null,feedOrder=new Map();
 function feedBase(){
  const task=discovery.task;if(!task){const saved=store.setting('last_feed');return saved?{...saved,saved:true}:null;}
  if(feedTask!==task.id){feedTask=task.id;feedOrder=new Map();}
  const ranked=discovery.ranked(task,store.setting('profile')),raw=discovery.jobsFor(task),results=new Map(ranked.results.map(job=>[job.id,job]));
  // Until the CV plan has scored a job, it is "matching"; afterwards it is shown or silently excluded.
  const scoring=!task.plan_error&&(!task.plan_summary||task.plan_summary.roles?.length>0),auto=automation?.id===task.id?automation:null,queued=new Set(auto?.ids||[]),cards=[];
  for(const id of raw){
   const job=results.get(id)||(scoring&&!task.semantic?.has(id)?store.getJob(id):null);if(!job)continue;
   const route=applyRoute(job),m=job.match;
   const stage=!m||scoring&&!task.semantic?.has(id)?'matching':queued.has(id)?'queued':m.auto_selectable&&(route.automatable||route.inspectable)?'matched':!route.automatable&&!route.inspectable?'manual':'related';
   if(!feedOrder.has(id))feedOrder.set(id,feedOrder.size);
   cards.push({id,order:feedOrder.get(id),title:job.title,company:job.company||'',location:String(job.location||'').split(/[;|]/)[0].trim().slice(0,60),workplace:job.workplace||null,source:SOURCE_LABEL[job.provider]||job.provider,target:route.label,family:route.family,url:job.listing_url||job.apply_url,stage,role:m?.closest_role||null,fit:m?.relevance?(m.relevance.occupation_match?1:Math.round(m.relevance.role*1000)/1000):null,
    why:stage==='related'?(task.plan_error?'Role matching is unavailable; this job will not be applied to automatically':m.rival_role?`Closer to “${m.rival_role}” than to your target roles`:m.seniority_conflict?'Senior role; your CV reads early-career':m.experience_review?'Asks for 3+ years of experience':m.geography?.status==='unknown'?'Location not stated':'Related, but not close enough to apply automatically'):null});
  }
  const metric=at=>auto&&at?at-auto.started_at:null;
  const sourceTotals=new Map(task.request.sites.map(site=>[site,new Set(task.rows.filter(row=>row.site===site).flatMap(row=>row.job_ids)).size]));
  const sourceMatches=new Map(task.request.sites.map(site=>[site,ranked.results.filter(job=>site==='boards'?!SOURCES.some(s=>s.id===job.provider):job.provider===site).length]));
  return{run:{id:task.id,profile:auto?.profile||null,auto:!!auto?.auto_apply,state:auto?.state||(task.running?'searching':'complete'),paused:!!auto?.paused,search_running:!!task.running,started_at:task.started_at,finished_at:auto?.finished_at||task.finished_at||null,error:auto?.error||task.error||task.plan_error||null,
   phase:task.phase||'searching',filters:{country:task.request.country,location:task.request.location,work_mode:task.request.work_mode,hours_old:task.request.hours_old,limit:task.request.limit},can_expand:!task.running&&!task.cancelled&&task.request.limit<300&&task.rows.some(row=>row.has_more),exclusion_summary:summarizeExclusions(ranked.excluded),
   plan:task.plan_summary||null,queries:task.request.queries,sources:task.rows.map(row=>({site:SOURCE_LABEL[row.site]||row.site,site_id:row.site,query:row.query,state:row.state,count:row.count,source_total:sourceTotals.get(row.site),source_matched:sourceMatches.get(row.site),has_more:row.has_more,method:row.method||(['linkedin','indeed','glassdoor','google'].includes(row.site)?'public_http':null),indexed_matches:row.indexed_matches,examined:row.examined,error:row.error,note:row.note,warnings:row.warnings})),found:raw.length,matched:ranked.results.length,excluded:ranked.excluded.length,duplicates:ranked.duplicates,
   metrics:auto?{first_job_ms:metric(auto.first_job_at),first_match_ms:metric(auto.first_match_at),first_application_ms:metric(auto.first_application_started_at),first_confirmed_ms:metric(auto.first_confirmed_at),search_ms:metric(auto.discovery_finished_at),total_ms:metric(auto.finished_at)}:null},cards:cards.slice(0,400)};
 }
 function saveFeed(){try{const base=feedBase();if(base&&!base.saved){const {saved,...rest}=base;store.setting('last_feed',rest);}}catch{}}
 function runFeed(){
  const base=feedBase();if(!base)return{run:null,cards:[],counts:{}};
  const apps=new Map(applications.list().map(app=>[app.job_id,app])),run=browserRun,since=(base.run.started_at||0)/1000-1,facts=candidate(),bank=store.setting('answer_bank')||{},scoped=store.setting('scoped_answers')||{},prefs=store.setting('user_preferences')||{};
  const queued=new Set(automation?.id===base.run.id?automation.ids:[]);
  const cards=base.cards.map(card=>{
   // A job queued in this run shows "queued" until this run touches it, not a stale state from an earlier run.
   const app=apps.get(card.id);if(!app||queued.has(card.id)&&app.updated_at<since)return card;
   let stage=STAGE[app.state]||'skipped';if(stage==='filling'&&run?.stages?.[card.id]!=='filling')stage='opening';
   const questions=(app.detail.missing||[]).filter(question=>{if(question.fact&&facts[question.fact]||bank[question.fingerprint]!==undefined||scoped[app.job_id]?.[question.fingerprint]!==undefined)return false;const spec=inferPreferenceFromQuestion(question);return !(spec&&prefs[spec.id]?.confirmed&&prefs[spec.id]?.value!==undefined);});
   return{...card,stage,app_state:app.state,earlier:app.updated_at<since,updated_at:Math.round(app.updated_at*1000),note:String(app.detail.note||app.detail.error||'').slice(0,240)||null,missing:questions.length,questions,disclosure:{fields:Array.isArray(app.detail.disclosure)?app.detail.disclosure:(app.detail.disclosure?.fields||[])},
    evidence:stage==='confirmed'&&(app.detail.evidence||app.detail.confirmation)?{kind:app.detail.evidence?.kind||'verified',text:String(app.detail.confirmation||app.detail.evidence?.text||app.detail.evidence?.url||app.detail.note||'').slice(0,160)}:null,confirm_seconds:app.detail.confirm_seconds??null};});
  const counts={};for(const card of cards)counts[card.stage]=(counts[card.stage]||0)+1;
  const state=base.saved&&['searching','applying'].includes(base.run.state)?'interrupted':base.run.state;
  return{run:{...base.run,state,search_running:base.saved?false:base.run.search_running,browser_running:!!run?.running&&run.id===automation?.browser_run_id},cards,counts};
 }

 // ---- The single browser on this PC ---------------------------------------------------------
 const compact=event=>{const {disclosure,missing,steps,...rest}=event;return{...rest,missing_count:missing?.length,disclosure_count:disclosure?.length};};
 function browserSummary(){if(!browserRun)return null;const {worker,events,review,frame,...run}=browserRun;run.frame_seq=frame?.seq||0;return{...run,events:events.slice(-40),jobs:run.order.map(id=>{const job=store.getJob(id);return{id,title:job?.title||id,company:job?.company||'',state:applications.get(id)?.state||'queued'};})};}
 function startBrowser(task,{jobs=[],review=null,site=null,options={}}={}){
  if(browserRun?.running||discovery.usingBrowser)throw new Error(browserRun?.task==='login'?'Finish signing in, then close the separate Chrome sign-in window. Your connection will be saved automatically.':'The browser is running another task. Wait for it to finish, or stop that run.');
  const run={id:randomUUID(),task,site,running:true,started_at:Date.now(),events:[],order:jobs.map(job=>job.id),review,needs_human:null,waiting:null,counts:null,error:null,revisions:revisions()};
  // Browser work runs headless and is shown through the live view, unless windows on the PC are switched on.
  const input={task,site,browser_profile:profileDir,jobs,profile:candidate(),answers:store.setting('answer_bank')||{},scoped_answers:store.setting('scoped_answers')||{},preferences:store.setting('user_preferences')||{},permission:permissions(),search_policy:store.setting('search_policy')||{},headless:task==='live'||(process.env.APPLYBURST_HEADLESS==='1'||!store.setting('show_browser_windows'))&&task!=='login',concurrency:pace().concurrency,fast_prepare_seconds:pace().fast_prepare_seconds||12,linkedin_pace_seconds:pace().linkedin_apply_seconds,indeed_pace_seconds:2,confirm_timeout:pace().confirm_timeout,human_timeout:600,...options};
  // Authenticated native Apply flows use the ordinary installed browser window.
  if(['prepare','auto','submit','open','inspect'].includes(task)&&jobs.some(job=>['indeed','glassdoor'].includes(siteForURL(job.url)?.id)))input.headless=false;
  run.worker=runWorker({root,module:'companion',input,keepStdin:true,timeoutMs:4*3600*1000,onEvent:event=>onBrowserEvent(run,event)});
  run.worker.done.then(result=>{run.running=false;run.finished_at=Date.now();if(!run.events.length&&result.code)run.error=(result.stderr||'').split('\n').filter(Boolean).at(-1)?.slice(0,300)||'The browser worker could not start.';applications.reconcile();autoSubmitAfter(run);if(automation&&!['stopped','complete'].includes(automation.state)&&!browserRun?.running&&!(automation.id===discovery.task?.id&&discovery.task.running)){automation.state='complete';automation.finished_at??=Date.now();}saveFeed();
   drainRetries();});
  browserRun=run;return run;
 }
 function onBrowserEvent(run,event){
  // Form labels/buttons/messages the rules could not place are classified by meaning, in any language.
  if(event.type==='classify'){const texts=(event.texts||[]).slice(0,80).map(t=>String(t).slice(0,200)),options=event.kind==='buttons'?{floor:0.5,margin:0.04}:event.kind==='polarity'?{floor:0.5,margin:0.05}:{};
   (event.kind==='success'?intents.success(texts):intents.classify(event.kind,texts,options)).then(results=>run.worker.send({type:'classify_result',seq:event.seq,results})).catch(()=>run.worker.send({type:'classify_result',seq:event.seq,results:[]}));return;}
  // Live-view frames are kept only as the latest image in memory; input text never comes back as an event.
  if(event.type==='frame'){run.frame={seq:event.seq,data:event.data,width:event.width,height:event.height,url:event.url};return;}
  if(event.type==='stream'){run.stream={state:event.state,reason:event.reason,job_id:event.job_id||null,url:event.url||null};return;}
  if(event.type==='stream_input_error'){run.input_error=event.error;return;}
  if(event.type==='stage'){(run.stages??={})[event.job_id]=event.stage;return;}
  if(event.type==='route_resolved'){
   const job=store.getJob(event.job_id),destination=String(event.destination||'');
   // Keep stable public application targets; native candidate workflows stay in the private application ledger.
   if(job&&/^https:\/\//.test(destination)){const u=new URL(destination),privateFlow=!!u.username||!!u.password||/^(?:smartapply|apply|secure|auth)\.indeed\.com$/.test(u.hostname)||/\/(?:candidate|applicant|profile|login|signin)(?:\/|$)/i.test(u.pathname)||[...u.searchParams.keys()].some(key=>/^(?:access_token|apiToken|csrf|session|sessionId|candidateId|applicantId|authorization)$/i.test(key));if(!privateFlow){const updated=store.patchJob(job.id,{destination_url:destination,apply_route:'employer_site'});boards.note([updated]);}}
   return;
  }
  run.events.push(compact(event));if(run.events.length>400)run.events.shift();
  const job=event.job_id?store.getJob(event.job_id):null,url=job?applyTarget(job):'';
  if(event.type==='job_started'){run.current=event.job_id;if(automation&&automation.browser_run_id===run.id)automation.first_application_started_at??=Date.now();applications.set(event.job_id,url,['submit','auto'].includes(run.task)?'submit_in_progress':'preparing',{url,title:job?.title,company:job?.company},run.id);}
  else if(event.type==='intent'){
   // Record "submitting" durably BEFORE acknowledging; without this ack the companion never clicks.
   const unchanged=hash(run.revisions)===hash(revisions()),reviewed=unchanged&&run.task==='submit'&&run.review?.plans[event.job_id]===event.plan_hash,perm=permissions(),actual=event.destination||url;
   const fixture=job?.fixture_family&&/^http:\/\/127\.0\.0\.1:/.test(actual);
   const family=fixture?job.fixture_family:siteForURL(actual)?.id,allowed=perm.mode==='auto_all'?new Set(['resume','approved_answer','derived_from_phone','user_preference','site_prefilled']):new Set(['resume','approved_answer','derived_from_phone','user_preference']);
   const automatic=unchanged&&run.task==='auto'&&perm.mode!=='review'&&!perm.paused&&submittedToday()<perm.daily_cap&&perm.sites[family]&&policyFit(job).status!=='mismatch'&&family===event.family&&Array.isArray(event.disclosure)&&event.disclosure.length>0&&event.disclosure.every(row=>allowed.has(row.source));
   const fit=policyFit(job),policy=store.setting('search_policy')||{},policyAllowed=fit.status!=='mismatch'&&!(policy.work_mode==='remote_only'&&fit.status==='unknown');
   const target=automatic?actual:url,other=applications.blocker(event.job_id,target),ok=!!(reviewed||automatic)&&policyAllowed&&(!other||other.job_id===event.job_id&&!BLOCKING.has(other.state));
   if(ok)applications.set(event.job_id,target,'submitting',{url:target,plan_hash:event.plan_hash,intent_at:Date.now()/1000,authorized_by:automatic?'permission_mode:'+perm.mode:run.review.authorized_by||'reviewed_batch'},run.id);
   const reason=ok?null:!unchanged?'Your resume, facts or saved answers changed during this run. Review again; nothing sent.':!policyAllowed?(fit.reason||'This job does not have a verified match to your work-location preferences.')+' Nothing sent.':perm.paused?'Automatic applications are paused. Nothing sent.':submittedToday()>=perm.daily_cap?'Your daily application limit was reached. Nothing sent.':other?'This destination already has an application or uncertain attempt. Nothing sent.':'Automatic permission does not cover this form. Nothing sent.';
   run.worker.send({type:'intent_ack',seq:event.seq,recorded:ok,reason});
  }
  else if(event.type==='result'){const {type,at,...detail}=event;
   if(job?.provider==='linkedin'&&event.family==='linkedin'&&['inspected','needs_answers','ready_to_submit','confirmed','plan_changed','submit_rejected','unknown_after_submit'].includes(event.state))store.patchJob(job.id,{apply_route:'linkedin_easy_apply'});
   if(event.state==='confirmed'&&automation&&automation.browser_run_id===run.id)automation.first_confirmed_at??=Date.now();
   // A LinkedIn listing that applies on the employer site: remember where, so the next Prepare fills that form.
   if(event.state==='employer_site_redirect'&&event.destination&&/^https:\/\//.test(event.destination)&&job){store.patchJob(job.id,{destination_url:event.destination,apply_route:'employer_site'});const route=applyRoute(store.getJob(job.id));detail.note=route.automatable?'The employer form is '+route.label+'. Prepare again to fill it.':'Applies on '+route.label+'.';}
   const target=applications.get(event.job_id)?.detail?.url||url;applications.set(event.job_id,target,event.state,{...detail,title:job?.title,company:job?.company,url:target},run.id);if(telegram?.settings().enabled)assistant?.sync();if(event.state==='confirmed')telegram?.notifyApplication(event,job);}
  else if(event.type==='observed_confirmation')applications.set(event.job_id,url,'confirmed',{evidence:event.evidence,confirmed_by:'you, in the browser',confirmed_at:event.confirmed_at},run.id);
  else if(event.type==='needs_human')run.needs_human=event.job_id;
  else if(event.type==='waiting_for_user')run.waiting=event.open_jobs;
  else if(event.type==='finished')run.counts=event.counts;
  else if(event.type==='login_state')store.setting('session:'+event.site,{signed_in:event.signed_in,checked_at:Date.now()/1000,browser:event.browser,evidence:event.evidence});
  else if(event.type==='session')for(const [site,state]of Object.entries(event.sites||{}))store.setting('session:'+site,{...state,checked_at:Date.now()/1000});
  else if(event.type==='error')run.error=event.message;
 }
 function prepareJobs(ids){
  if(!Array.isArray(ids)||!ids.length||ids.length>50)throw new Error('Choose 1–50 jobs.');
  if(!candidate().resume_path)throw new Error('Upload your resume first.');
  return ids.map(id=>{const job=store.getJob(id);if(!job)throw new Error('A selected job is no longer available.');const url=applyTarget(job),block=applications.blocker(id,url);
   if(block)throw new Error(`Already ${block.state.replaceAll('_',' ')}: ${job.title} at ${job.company}. Resolve it in History first.`);
   // Loopback fixture families exist only for local end-to-end runs; real hosts pick their adapter by domain.
   const family=job.fixture_family&&/^http:\/\/127\.0\.0\.1:/.test(url)?{family:job.fixture_family}:{};return{id,url,title:job.title,company:job.company,workplace:workArrangement(job),location:job.location,...family};});
 }

 // Retry after answers: same profile rules as Start; continues the current run on screen when there is one.
 const pendingRetry=new Set();
 function retryJobs(ids){
  const profile=profileName(),spec=PROFILES[profile];if(spec.task==='auto'&&consents()[profile])store.setting('permissions',{...permissions(),mode:spec.mode,paused:false,changed_at:Date.now()/1000});
  const jobs=prepareJobs(ids),auto=permissions().mode!=='review'&&!permissions().paused,run=startBrowser(auto?'auto':'prepare',{jobs,options:{human_timeout:2}});
  if(automation&&discovery.task&&automation.id===discovery.task.id&&!['searching','applying'].includes(automation.state))Object.assign(automation,{state:'applying',browser_run_id:run.id,paused:false});
  else if(auto)automation={id:randomUUID(),state:'applying',auto_apply:true,ids,started_at:Date.now(),browser_run_id:run.id};
  return run;
 }
 // One path for every way an answer arrives (review form, assistant chat, Telegram): validate, store,
 // learn reusable preferences, then retry exactly the applications it unblocks.
 function saveAnswers(input){
  const {answers}=input;if(!Array.isArray(answers)||answers.length>200)throw new Error('Too many answers.');const bank=store.setting('answer_bank')||{},labels=store.setting('answer_labels')||{},scoped=store.setting('scoped_answers')||{},prefUpdates=[];
  for(const item of answers){if(!/^([a-f0-9]{64}|q_[a-f0-9]{6,16})$/.test(item.fingerprint))throw new Error('Invalid question.');if(item.value===null||item.value===''){if(item.job_id)delete scoped[item.job_id]?.[item.fingerprint];else delete bank[item.fingerprint];delete labels[item.fingerprint];continue;}
   const value=Array.isArray(item.value)?item.value.map(String).slice(0,30):String(item.value);if(JSON.stringify(value).length>4000)throw new Error('An answer is too long.');
   if(item.job_id){if(!store.getJob(item.job_id))throw new Error('Unknown application.');scoped[item.job_id]??={};scoped[item.job_id][item.fingerprint]=value;}
   else{bank[item.fingerprint]=value;if(!Array.isArray(value)){const spec=inferPreferenceFromQuestion(item);if(spec)prefUpdates.push({id:spec.id,value,confirmed:true});}}
   labels[item.fingerprint]={label:String(item.label||'').slice(0,300),kind:String(item.kind||'').slice(0,30),updated_at:Date.now()/1000};}
  store.setting('answer_bank',bank);store.setting('answer_labels',labels);store.setting('scoped_answers',scoped);
  for(const item of answers)assistant?.cancelJobDrafts(item.fingerprint);
  if(prefUpdates.length){try{savePreferences(store,prefUpdates);}catch{}}
  let retrying=[],queued=false;
  if(input.retry){retrying=unblocked();if(retrying.length){if(browserRun?.running||discovery.task?.running){for(const id of retrying)pendingRetry.add(id);queued=true;}else{retryJobs(retrying.slice(0,50));for(const id of retrying.slice(50))pendingRetry.add(id);}}}
 return{saved:answers.length,retrying,queued};
 }
 function drainRetries(){if(!pendingRetry.size||browserRun?.running||discovery.task?.running)return;const ids=[...pendingRetry].filter(id=>applications.get(id)?.state==='needs_answers');pendingRetry.clear();for(const id of ids.slice(50))pendingRetry.add(id);if(ids.length)try{retryJobs(ids.slice(0,50));}catch{}}
 // Jobs waiting only on answers that are now saved (by exact fingerprint or semantic preference): retried automatically.
 function unblocked(){const bank=store.setting('answer_bank')||{},scoped=store.setting('scoped_answers')||{},prefs=store.setting('user_preferences')||{};
  const facts=candidate();return applications.list().filter(app=>app.state==='needs_answers'&&(app.detail.missing||[]).length&&(app.detail.missing||[]).every(m=>{if(m.fact&&facts[m.fact])return true;if(m.fingerprint&&(bank[m.fingerprint]!==undefined||scoped[app.job_id]?.[m.fingerprint]!==undefined))return true;const spec=inferPreferenceFromQuestion(m);return Boolean(spec&&prefs[spec.id]?.confirmed&&prefs[spec.id]?.value!==undefined);})).map(app=>app.job_id);}
 function pendingQuestions(){
  const grouped=new Map(),bank=store.setting('answer_bank')||{},scoped=store.setting('scoped_answers')||{},prefs=store.setting('user_preferences')||{};
  for(const app of applications.list())if(app.state==='needs_answers')for(const item of app.detail.missing||[]){
   if(item.fact&&candidate()[item.fact]||!item.fingerprint||bank[item.fingerprint]!==undefined||scoped[app.job_id]?.[item.fingerprint]!==undefined)continue;
   const spec=inferPreferenceFromQuestion(item);if(spec&&prefs[spec.id]?.confirmed)continue;
   // Reuse only an identified preference with a defined scope. An unlabeled-context yes/no answer
   // (for example work rights without a named country) must not leak into another application.
   const jobScoped=!spec;
   const key=item.fingerprint+(jobScoped?':'+app.job_id:''),job=store.getJob(app.job_id),entry=grouped.get(key)||{...item,...(item.kind==='checkbox'&&!item.options?.length?{options:['Yes','No']}:{}),key,...(jobScoped?{job_id:app.job_id}:{}),jobs:[]};
   if(!entry.jobs.some(j=>j.id===app.job_id))entry.jobs.push({id:app.job_id,title:job?.title||app.detail.title||app.job_id,company:job?.company||app.detail.company||''});grouped.set(key,entry);
  }
  return[...grouped.values()];
 }
 if(mode==='local'){
  assistant=new Assistant({store,pendingQuestions,saveAnswers,candidateNotes:()=>{const {resume_path,...details}=candidate();return JSON.stringify({notes:store.setting('candidate_notes')||'',details,preferences:store.setting('user_preferences')||{},cv:localCV()?.slice(0,5000)||''});}});
  preferenceEditor=new PreferenceEditor({assistant});
  telegram=new TelegramReview({store,assistant});telegram.start();
 }
 const publicHandler=publicDiscovery({root,store,search,base,publicOrigin,planner});
 const CSP="default-src 'self'; script-src 'self'; worker-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self' http://127.0.0.1:* http://localhost:* https://remoteok.com https://jobicy.com https://remotive.com https://www.arbeitnow.com https://boards-api.greenhouse.io https://api.lever.co; frame-ancestors 'none'; base-uri 'self'; form-action 'self'";
 const PUBLIC_HOSTS=new Set([new URL(publicOrigin).host,'tapsubmit.com','www.tapsubmit.com']);
 const PUBLIC_ORIGINS=new Set([publicOrigin,'https://tapsubmit.com','https://www.tapsubmit.com']);
 const server=createServer(async(req,res)=>{
  let path='';
  const host=req.headers.host||'',isPublicHost=PUBLIC_HOSTS.has(host),local=/^(?:127\.0\.0\.1|localhost):\d+$/.test(host),origin=req.headers.origin;
  const bridgeOrigin=local&&PUBLIC_ORIGINS.has(origin)&&req.headers['x-applyburst-bridge']==='1';
  const extOrigin=typeof origin==='string'&&origin.startsWith('chrome-extension://')&&req.headers['x-applyburst-extension']==='1';
  const corsOrigin=bridgeOrigin?origin:extOrigin?origin:null;
  const corsHeaders=corsOrigin?{'Access-Control-Allow-Origin':corsOrigin,'Access-Control-Allow-Credentials':'true','Access-Control-Allow-Private-Network':'true','Access-Control-Allow-Methods':'GET, POST, OPTIONS','Access-Control-Allow-Headers':'Content-Type, X-CSRF-Token, X-ApplyBurst-Bridge, X-ApplyBurst-Extension, Authorization'}:{};
  function send(status,value,type='application/json',headers={}){if(res.writableEnded)return;let bytes=Buffer.isBuffer(value)?value:Buffer.from(type==='application/json'?JSON.stringify(value):String(value));const extra={};if(bytes.length>1024&&/\bgzip\b/.test(req.headers['accept-encoding']||'')){bytes=gzipSync(bytes);extra['Content-Encoding']='gzip';extra.Vary='Accept-Encoding';}res.writeHead(status,{'Content-Type':type,'Cache-Control':'no-store','X-Content-Type-Options':'nosniff','X-Frame-Options':'DENY','Referrer-Policy':'same-origin','Content-Security-Policy':CSP,...corsHeaders,...extra,...headers,'Content-Length':bytes.length});res.end(bytes);}
  try{
   if(!isPublicHost&&!local){send(421,{error:'Unknown host.'});return;}
   if(req.method==='OPTIONS'&&corsOrigin){res.writeHead(204,{'Access-Control-Allow-Origin':corsOrigin,'Access-Control-Allow-Credentials':'true','Access-Control-Allow-Private-Network':'true','Access-Control-Allow-Methods':'GET, POST, OPTIONS','Access-Control-Allow-Headers':'Content-Type, X-CSRF-Token, X-ApplyBurst-Bridge, X-ApplyBurst-Extension, Authorization','Access-Control-Max-Age':'600'});res.end();return;}
   const url=new URL(req.url,'http://'+host);path=url.pathname;if(path==='/healthz'){send(200,{status:'ok'});return;}
   const isTapSubmitHost=host==='tapsubmit.com'||host==='www.tapsubmit.com';
   if(path==='/'&&req.method==='GET'&&!isTapSubmitHost){send(302,'','text/plain',{Location:base+'/'});return;}
   if(path===base){send(302,'','text/plain',{Location:base+'/'});return;}
   if(path.startsWith(base+'/'))path=path.slice(base.length);
   else if(!isTapSubmitHost&&!path.startsWith('/assets/')&&!path.startsWith('/api/')&&!path.startsWith('/download/')){send(404,{error:'Not found.'});return;}
   if(path==='/download/extension'&&req.method==='GET'){const extZip=join(root,'dist/tapsubmit-extension.zip');if(!existsSync(extZip)){send(404,{error:'Browser extension package is being prepared.'});return;}res.writeHead(200,{'Content-Type':'application/zip','Content-Length':statSync(extZip).size,'Content-Disposition':'attachment; filename="tapsubmit-extension.zip"','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});createReadStream(extZip).pipe(res);return;}
   if(await publicHandler({req,path,url,send,json,host}))return;
   const asset={'/assets/app.js':['app.js','text/javascript'],'/assets/style.css':['style.css','text/css']}[path];if(asset&&req.method==='GET'){send(200,readFileSync(join(root,'web/public',asset[0])),asset[1]);return;}
   const modernAsset={'/assets/auth.js':['auth.js','text/javascript'],'/assets/city-picker.mjs':['city-picker.mjs','text/javascript'],'/assets/tom-select.js':['vendor/tom-select/tom-select.min.js','text/javascript'],'/assets/tom-select.css':['vendor/tom-select/tom-select.min.css','text/css'],'/assets/review-settings.mjs':['review-settings.mjs','text/javascript'],'/assets/minimal.js':['minimal.js','text/javascript'],'/assets/minimal.css':['minimal.css','text/css']}[path];if(modernAsset&&req.method==='GET'){send(200,readFileSync(join(root,'web/public',modernAsset[0])),modernAsset[1]);return;}
   if(path==='/api/locations/cities'&&req.method==='GET'&&mode==='local'){if(limited('cities',180)){send(429,{error:'Please wait a moment.'});return;}send(200,{cities:await cityOptions(root,url.searchParams.get('country'),url.searchParams.get('q')||'')});return;}
   if(path==='/desktop/start'&&req.method==='GET'&&local&&mode==='local'&&desktopTicket&&url.searchParams.get('ticket')===desktopTicket){desktopTicket=null;send(302,'','text/plain',{Location:base+'/'});return;}
   if(path==='/desktop/stop'&&req.method==='POST'&&local&&mode==='local'&&process.env.APPLYBURST_CONTROL_TOKEN&&req.headers['x-desktop-control']===process.env.APPLYBURST_CONTROL_TOKEN){send(200,{ok:true});setImmediate(()=>server.emit('desktop-quit'));return;}
   if(path==='/desktop/open'&&req.method==='POST'&&local&&mode==='local'&&process.env.APPLYBURST_CONTROL_TOKEN&&req.headers['x-desktop-control']===process.env.APPLYBURST_CONTROL_TOKEN){desktopTicket=randomUUID()+randomUUID();send(200,{path:base+'/desktop/start?ticket='+desktopTicket});return;}
   const session=auth.session(req.headers.cookie);
   if(path==='/'&&req.method==='GET'){send(200,readFileSync(join(root,'web/public/minimal.html')),'text/html; charset=utf-8');return;}
   if(path==='/legacy-demo'&&req.method==='GET'){send(200,readFileSync(join(root,'web/public/public-demo.html')),'text/html; charset=utf-8');return;}
   if(path==='/api/device/ping'&&req.method==='GET'&&local){send(200,{available:true,mode,workspace_id:workspaceId,authenticated:!!session,sessions:sessions()});return;}
   // Public job detail lookup works for both guests and signed-in members.
   if(path==='/api/job'&&req.method==='GET'){const job=store.getJob(url.searchParams.get('id'));if(!job){send(404,{error:'This posting is unavailable.'});return;}const app=session?applications.get(job.id):null;
    send(200,{job:{...jobCard(job),description:job.description,apply_url:job.apply_url},match:session?profileMatch(job,store.setting('profile')):null,application:app,events:app?applications.events(job.id).slice(-20):[]});return;}
   // Each public host accepts its own https origin; loopback accepts its own origin, bridge from publicOrigins, or extension.
   const validOrigin=isPublicHost?(origin==='https://'+host||extOrigin):(origin==='http://'+host||bridgeOrigin||extOrigin);
   if(path==='/api/auth/status'&&req.method==='GET'){send(200,{configured:!!auth.admin,registration_open:mode!=='local'||!auth.admin,allow_members:mode!=='local',authenticated:!!session,username:session?.username||null,workspace_id:workspaceId,client_reset_id:store.setting('client_reset_id')||null});return;}
   const secureCookie=isPublicHost?'; Secure':'';
   const cookiePath=isTapSubmitHost?'/':base;
   if(path==='/api/register'&&req.method==='POST'){
    if(!validOrigin||!String(req.headers['content-type']).startsWith('application/json')){send(403,{error:'Invalid registration origin.'});return;}
    if(limited('registration:'+(req.headers['cf-connecting-ip']||req.socket.remoteAddress||'local'),12,900)){send(429,{error:'Please wait before trying again.'});return;}
    const data=await json(req,3000),result=auth.register(data.username,data.password);
    send(201,{ok:true,username:result.username,csrf:result.csrf},'application/json',{'Set-Cookie':`ab_session=${result.token}; Path=${cookiePath}; HttpOnly; SameSite=Lax; Max-Age=43200${secureCookie}`});return;
   }
   if(path==='/api/login'&&req.method==='POST'){
    if(!validOrigin||!String(req.headers['content-type']).startsWith('application/json')){send(403,{error:'Invalid login origin.'});return;}if(limited('global-login',30)){send(429,{error:'Please wait before signing in again.'});return;}
    const data=await json(req,5000),ip=String(req.headers['cf-connecting-ip']||req.socket.remoteAddress||'local'),result=auth.login(data.username,data.password,ip);
    if(result.status!==200){send(result.status,{error:result.error});return;}
    send(200,{ok:true,username:result.username,csrf:result.csrf},'application/json',{'Set-Cookie':`ab_session=${result.token}; Path=${cookiePath}; HttpOnly; SameSite=Lax; Max-Age=43200${secureCookie}`});return;
   }
   if(!session){req.resume();send(401,{error:'Sign in required.'});return;}
   if(path==='/download/windows'&&req.method==='GET'){const installer=process.env.APPLYBURST_INSTALLER||join(root,'dist/ApplyBurst-Setup.exe');if(!existsSync(installer)){send(404,{error:'Windows installer is being prepared.'});return;}res.writeHead(200,{'Content-Type':'application/octet-stream','Content-Length':statSync(installer).size,'Content-Disposition':'attachment; filename="ApplyBurst-Setup.exe"','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});createReadStream(installer).pipe(res);return;}
   if(req.method!=='GET'&&(!validOrigin||req.headers['x-csrf-token']!==session.csrf)){send(403,{error:'Session check failed. Reload the page.'});return;}
   if(limited('admin-requests',600)){send(429,{error:'Too many requests. Please wait a moment.'});return;}
   if(path.startsWith('/api/assistant')||path.startsWith('/api/telegram')){
    if(!local||mode!=='local'||!assistant){send(404,{error:'Available in the local workspace only.'});return;}
    if(path==='/api/assistant/llm'&&req.method==='GET'){send(200,await assistant.llmStatus());return;}
    if(path==='/api/assistant/llm'&&req.method==='POST'){assistant.setLLM(await json(req,1000));send(200,await assistant.llmStatus());return;}
    if(path==='/api/assistant/install'&&req.method==='POST'){const input=await json(req,1000);send(202,await assistant.installModel(input.model));return;}
    if(path==='/api/assistant/notes'&&req.method==='GET'){send(200,{notes:store.setting('candidate_notes')||''});return;}
    if(path==='/api/assistant/notes'&&req.method==='POST'){const input=await json(req,12000);if(typeof input.notes!=='string'||input.notes.length>8000)throw new Error('Candidate notes must be at most 8,000 characters.');store.setting('candidate_notes',input.notes.trim());send(200,{saved:true});return;}
    if(path==='/api/telegram'&&req.method==='GET'){send(200,telegram.status());return;}
    if(path==='/api/telegram'&&req.method==='POST'){send(200,await telegram.configure(await json(req,2000)));return;}
    send(404,{error:'Not found.'});return;
   }
   const savedKey=mode!=='local'&&session.username!==auth.admin?.username?`saved:${session.username}`:'saved_jobs';
   if(path==='/api/extension/sync'&&req.method==='GET'){
    const profile=store.setting('profile'),rp=candidate().resume_path,resumeFile=store.setting('resume_file')||'resume.pdf';
    const mime=/\.pdf$/i.test(resumeFile)?'application/pdf':/\.docx$/i.test(resumeFile)?'application/vnd.openxmlformats-officedocument.wordprocessingml.document':'text/plain';
    const resume=rp&&existsSync(rp)?{filename:resumeFile,mime,base64:readFileSync(rp).toString('base64')}:null;
    send(200,{ok:true,authenticated:true,username:session.username||auth.admin?.username,profile,resume,preferences:store.setting('user_preferences')||{},answer_bank:store.setting('answer_bank')||{},answers:store.setting('answer_bank')||{},saved_ids:(store.setting(savedKey)||[]),permissions:permissions()});return;
   }
   if(path==='/api/extension/event'&&req.method==='POST'){
    const ev=await json(req,30000),jobId=String(ev.job_id||'').slice(0,200),state=String(ev.state||'');
    if(!jobId||!['preparing','ready_to_submit','submitting','confirmed','needs_answers','needs_human','deferred_slow','skipped'].includes(state))throw new Error('Invalid extension event.');
    if(state==='confirmed'&&!ev.detail?.confirmation&&!ev.detail?.note)throw new Error('Confirmed application requires confirmation evidence.');
    const job=store.getJob(jobId);const urlTarget=ev.url||(job?applyTarget(job):'');
    const saved=applications.set(jobId,urlTarget,state,{...(ev.detail||{}),title:ev.title||job?.title||jobId,company:ev.company||job?.company||'',via:'extension'});
    send(200,{ok:true,application:saved});return;
   }
   if(path==='/api/saved'&&req.method==='GET'){
    const ids=(store.setting(savedKey)||[]).filter(id=>typeof id==='string');
    const jobs=ids.map(id=>store.getJob(id)).filter(Boolean).map(job=>jobCard(job));
    send(200,{ids,jobs});return;
   }
   if(path==='/api/saved'&&req.method==='POST'){
    const input=await json(req,20000);let current=new Set((store.setting(savedKey)||[]).filter(id=>typeof id==='string'));
    if(Array.isArray(input.ids))current=new Set(input.ids.filter(id=>typeof id==='string').slice(0,500));
    else if(typeof input.id==='string'){if(input.saved===false)current.delete(input.id);else current.add(input.id);}
    const ids=[...current].slice(0,500);store.setting(savedKey,ids);
    send(200,{ids,count:ids.length});return;
   }
   if(path==='/api/logout'&&req.method==='POST'){auth.logout(session);send(200,{ok:true},'application/json',{'Set-Cookie':`ab_session=; Path=${base}; HttpOnly; SameSite=Lax; Max-Age=0${secureCookie}`});return;}
   if(path==='/api/account/password'&&req.method==='POST'){
    if(limited('password:'+session.token_hash,6,900)){send(429,{error:'Too many password attempts. Please wait.'});return;}
    const data=await json(req,3000),result=auth.changePassword(data.current_password,data.new_password,session.username);
    send(200,{ok:true},'application/json',{'Set-Cookie':`ab_session=${result.token}; Path=${base}; HttpOnly; SameSite=Lax; Max-Age=43200${secureCookie}`});return;
   }
   if(path==='/api/bootstrap'&&req.method==='GET'){const profile=store.setting('profile'),savedIds=(store.setting(savedKey)||[]).filter(id=>typeof id==='string');
    send(200,{mode,workspace_id:workspaceId,username:session.username||auth.admin?.username,csrf:session.csrf,saved_ids:savedIds,profile:profile?{name:profile.name,headline:profile.headline,skills:profile.skills,location:profile.location,languages:profile.languages||[],filename:profile.filename,imported_at:profile.imported_at}:null,sources:discovery.sitesState(),countries:COUNTRIES,languages:Object.entries(LANGUAGES).map(([id,l])=>[id,l.label]),suggested:profile?.plan?.queries?.length?profile.plan.queries.map((query,i)=>({id:'plan'+i,label:query,query})):suggestedQueries(profile),sessions:sessions(),login_sites:LOGIN_SITES,browser:browserSummary(),pace:pace(),show_browser_windows:!!store.setting('show_browser_windows'),permissions:{...permissions(),submitted_today:submittedToday()},safety_profile:profileName(),consented:Object.keys(consents()),plan:profile?.plan?.queries?{queries:profile.plan.queries,roles:profile.plan.roles,early:profile.plan.early}:null,last_search:discovery.task?{id:discovery.task.id}:store.setting('last_discovery')?{id:store.setting('last_discovery').id}:null,gpu_enabled:false,model_calls:semanticStats().batches,generative_model_calls:assistant?.llmCalls||0,local_drafts_enabled:!!assistant?.llmSettings().enabled,encoder:semanticStats()});return;}

   // ---- Discovery ---------------------------------------------------------------------------
   if(path==='/api/discovery/start'&&req.method==='POST'){const input=await json(req,10000);const request=discoveryRequest(await withPlan(input),store.setting('profile'));store.setting('search_policy',{...(store.setting('search_policy')||{}),country:request.country,location:request.location,remote:request.remote,work_mode:request.work_mode,languages:request.languages,home_country:request.home_country});const task=discovery.start(request);send(202,{id:task.id,queries:task.request.queries,planned:!task.request.explicit});return;}
   if(path==='/api/automation/start'&&req.method==='POST'){
    const input=await json(req,10000);if(browserRun?.running||automation?.state==='searching'||automation?.state==='applying')throw new Error('A run is already active.');
    // The saved safety profile decides what this run may do; the request cannot widen it.
    const profile=profileName(),spec=PROFILES[profile];if(spec.task&&!candidate().resume_path)throw new Error('Add your resume first.');
    if(spec.task==='auto'){if(!consents()[profile])throw new Error('Allow automatic applications for this profile first.');store.setting('permissions',{...permissions(),mode:spec.mode,paused:false,changed_at:Date.now()/1000});}
    if(COUNTRIES.some(([id])=>id===input.country))store.setting('last_country',input.country);
    const request=discoveryRequest(await withPlan(input),store.setting('profile'));store.setting('search_policy',{...(store.setting('search_policy')||{}),country:request.country,location:request.location,remote:request.remote,work_mode:request.work_mode,languages:request.languages,home_country:request.home_country});const task=discovery.start(request);automation={id:task.id,profile,task:spec.task,state:'searching',auto_apply:!!spec.task,paused:false,started_at:Date.now(),ids:[]};
    const cap=Math.min(50,Math.max(1,Number(input.application_limit)||25)),queued=new Set(),destinations=new Set();
    const pump=()=>{
     if(!automation||automation.id!==task.id||automation.state==='stopped'){clearInterval(automationMonitor);automationMonitor=null;return;}
     const ranked=discovery.ranked(task,store.setting('profile'));automation.search_running=task.running;automation.selection={matched:ranked.results.length,excluded:ranked.excluded.length,duplicates:ranked.duplicates,ranking_ms:ranked.elapsed_ms};
     if(!automation.first_job_at&&discovery.jobsFor(task).length)automation.first_job_at=Date.now();
     if(!automation.first_match_at&&ranked.results.some(job=>job.match.auto_selectable))automation.first_match_at=Date.now();
     const ids=[];
     for(const job of ranked.results){const route=applyRoute(job),target=destinationKey(applyTarget(job));if(queued.size+ids.length>=cap)break;if(!queued.has(job.id)&&!destinations.has(target)&&job.match.auto_selectable&&canPrepare(job)&&(spec.task!=='auto'||route.resolve_only||permissions().sites[route.family])&&!applications.blocker(job.id,applyTarget(job))){ids.push(job.id);destinations.add(target);}}
     if(automation.auto_apply&&!automation.paused&&ids.length&&!discovery.usingBrowser){
      try{
       const jobs=prepareJobs(ids);
       if(!automation.browser_run_id){const run=startBrowser(automation.task,{jobs,options:{headless:true,watch_seconds:0,human_timeout:2,stream_jobs:true}});automation.browser_run_id=run.id;automation.first_queue_at=Date.now();}
       else if(browserRun?.running&&browserRun.id===automation.browser_run_id){browserRun.order.push(...ids);browserRun.worker.send({type:'add_jobs',jobs});}
       else throw new Error('The application worker stopped; remaining jobs need review.');
       for(const id of ids)queued.add(id);automation.ids=[...queued];automation.state='applying';
      }catch(error){automation.error=error.message;automation.state='complete';clearInterval(automationMonitor);automationMonitor=null;if(browserRun?.running)browserRun.worker.send({type:'jobs_complete'});return;}
     }else for(const id of ids){const job=store.getJob(id);destinations.delete(destinationKey(applyTarget(job)));}
     // The last batch may still be scoring when the search ends: finish only after its jobs were ranked.
     if(!task.running&&!task.scorePending){
      if(automation.auto_apply&&ids.length&&discovery.usingBrowser)return;
      // While paused, keep feeding nothing but stay alive so Resume can still queue the matches.
      if(automation.paused&&automation.auto_apply)return;
      clearInterval(automationMonitor);automationMonitor=null;automation.discovery_finished_at=Date.now();
      if(automation.browser_run_id&&browserRun?.running)browserRun.worker.send({type:'jobs_complete'});
      else{automation.state='complete';automation.finished_at=Date.now();}
      saveFeed();setTimeout(drainRetries,50);
     }
    };
    automationMonitor=setInterval(pump,150);automationMonitor.unref();pump();send(202,{automation,queries:task.request.queries,planned:!task.request.explicit});return;
   }
   if(path==='/api/pool'&&req.method==='GET'){send(200,await sharedPool.status());return;}
   if(path==='/api/pool'&&req.method==='POST'){const input=await json(req,2000);sharedPool.configure(input);send(200,await sharedPool.status());return;}
   if(path==='/api/pool/download'&&req.method==='POST'){sharedPool.download();send(202,await sharedPool.status());return;}
   if(path==='/api/automation/status'&&req.method==='GET'){send(200,{automation,browser:browserSummary(),applications:applications.list(),sessions:sessions()});return;}
   if(path==='/api/run/feed'&&req.method==='GET'){send(200,runFeed());return;}
   if(path==='/api/run/clear'&&req.method==='POST'){
    await json(req,500);
    if(discovery.task?.running||browserRun?.running||pendingRetry.size||automation&&['searching','applying'].includes(automation.state))throw new Error('Stop the current run and wait for it to finish before clearing results.');
    if(automationMonitor){clearInterval(automationMonitor);automationMonitor=null;}
    automation=null;discovery.task=null;discovery.rankCache=null;
    store.setting('last_feed',null);store.setting('last_discovery',null);
    send(200,{ok:true});return;
   }
   if(path==='/api/automation/pause'&&req.method==='POST'){
    // Soft pause: forms already open finish; no new application starts until Resume. Search keeps running.
    const {paused}=await json(req,500);if(!automation||!['searching','applying'].includes(automation.state))throw new Error('Nothing is running.');
    automation.paused=!!paused;if(browserRun?.running&&browserRun.id===automation.browser_run_id)browserRun.worker.send({type:paused?'pause':'resume'});send(200,{automation});return;
   }
   if(path==='/api/automation/stop'&&req.method==='POST'){discovery.stop();if(automation&&automation.state!=='complete'){automation.state='stopped';automation.finished_at=Date.now();}if(browserRun?.running){browserRun.worker.send({type:'close'});browserRun.worker.close();}store.setting('permissions',{...permissions(),paused:true});saveFeed();send(200,{ok:true});return;}
   if(path==='/api/settings/profile'&&req.method==='POST'){
    const input=await json(req,2000),name=String(input.profile||'');if(!PROFILES[name])throw new Error('Unknown safety profile.');
    if(automation&&['searching','applying'].includes(automation.state))throw new Error('Stop the current run before changing the profile.');
    const given=consents();if(PROFILES[name].task==='auto'&&!given[name]){if(input.consent!==true){send(200,{consent_required:true,profile:name,scope:{sites:Object.entries(permissions().sites).filter(([,on])=>on).map(([site])=>site),daily_cap:permissions().daily_cap,mode:PROFILES[name].mode}});return;}given[name]={at:Date.now()/1000,sites:permissions().sites,daily_cap:permissions().daily_cap};store.setting('profile_consents',given);}
    store.setting('automation_profile',name);store.setting('permissions',{...permissions(),mode:PROFILES[name].mode,changed_at:Date.now()/1000});
    send(200,{profile:name,consented:Object.keys(consents()),permissions:{...permissions(),submitted_today:submittedToday()}});return;
   }
   if(path==='/api/settings/consent'&&req.method==='POST'){const {profile}=await json(req,500),given=consents();delete given[profile];store.setting('profile_consents',given);if(profileName()===profile&&PROFILES[profile]?.task==='auto'){store.setting('automation_profile','prepare_review');store.setting('permissions',{...permissions(),mode:'review'});}send(200,{consented:Object.keys(given),profile:profileName()});return;}
   if(path==='/api/discovery/status'&&req.method==='GET'){
    const task=discovery.task||store.setting('last_discovery');if(!task){send(200,{task:null,jobs:[]});return;}
    const ranked=discovery.ranked(task,store.setting('profile')),jobs=ranked.results.map(job=>({...jobCard(job),match:job.match}));
    send(200,{task:{id:task.id,running:!!task.running,started_at:task.started_at,finished_at:task.finished_at||null,request:task.request,error:task.error||null,rows:task.rows.map(({job_ids,done,...row})=>row)},jobs,matching:{excluded:ranked.excluded,duplicates:ranked.duplicates,ranking_ms:ranked.elapsed_ms,strategy:ranked.strategy}});return;
   }

   // ---- Applications ------------------------------------------------------------------------
   if(path==='/api/preferences/message'){
    if(!local||mode!=='local'||!preferenceEditor){send(404,{error:'Local settings only.'});return;}
    if(req.method==='GET'){send(200,{draft:preferenceEditor.snapshot()});return;}
    if(req.method==='POST'){
     const input=await json(req,12000);
     if(input.apply===true){const draft=preferenceEditor.snapshot();if(draft?.id!==input.draft_id||draft.state!=='ready')throw new Error('Generate and review the current settings preview first.');const preview=draft.preview;savePreferences(store,preview.fields.map(f=>({id:f.id,value:f.value,confirmed:true,source:'notes'})));store.setting('candidate_notes',preview.notes);store.setting('preference_message',preview.notes);const profile=store.setting('profile');if(profile&&preview.home_location)store.setting('profile',{...profile,location:preview.home_location});const old=store.setting('search_policy')||{},search={...old,...Object.fromEntries(Object.entries(preview.search).filter(([,value])=>value!==null&&value!==''&&!(Array.isArray(value)&&!value.length)))};search.remote=search.work_mode==='remote_only';store.setting('search_policy',search);assistant.cancelJobDrafts();send(200,{saved:true,search_policy:search,preferences:store.setting('user_preferences')||{}});return;}
     send(202,{draft:preferenceEditor.start(input.text,input.today)});return;
    }
   }
   if(path==='/api/applications/draft'){
    if(!local||mode!=='local'||!assistant){send(404,{error:'Available in the local workspace only.'});return;}
    if(req.method==='GET'){const id=url.searchParams.get('id'),fingerprint=url.searchParams.get('fingerprint');if(!store.getJob(id))throw new Error('Unknown application.');send(200,{draft:assistant.jobDraft(id,fingerprint)});return;}
    if(req.method==='POST'){const {id,fingerprint}=await json(req,1000),job=store.getJob(id),app=applications.get(id),q=app?.detail?.missing?.find(item=>item.fingerprint===fingerprint);if(!job||app?.state!=='needs_answers'||!q)throw new Error('This question is no longer waiting.');send(202,{draft:assistant.startJobDraft({...q,job_id:id,jobs:[{id,title:job.title,company:job.company}]})});return;}
   }
   if(path==='/api/applications'&&req.method==='GET'){
    const rows=applications.list().map(app=>{const job=store.getJob(app.job_id);return{job_id:app.job_id,state:app.state,updated_at:app.updated_at,plan_hash:app.plan_hash,title:job?.title||app.detail.title||app.job_id,company:job?.company||app.detail.company||'',route:job?applyRoute(job):null,detail:{note:app.detail.note,error:app.detail.error,evidence:app.detail.evidence,missing:app.detail.missing,disclosure:app.state==='ready_to_submit'?app.detail.disclosure:undefined,destination:app.detail.destination,url:app.detail.url,elapsed_ms:app.detail.elapsed_ms,confirm_seconds:app.detail.confirm_seconds}};});
    send(200,{applications:rows,questions:pendingQuestions()});return;
   }
   if(path==='/api/applications/prepare'&&req.method==='POST'){
    const {ids}=await json(req,30000);retryJobs(ids);send(202,browserSummary());return;}
    if(path==='/api/applications/prepare-one'&&req.method==='POST'){
     const {id,auto_submit}=await json(req,4000);
     const jobs=prepareJobs([id]);
     const taskMode=auto_submit?'auto':'prepare';
     let run=browserRun;
     if(browserRun?.running&&browserRun.task===taskMode){browserRun.order.push(id);browserRun.worker.send({type:'add_jobs',jobs});}
     else run=startBrowser(taskMode,{jobs,options:{headless:true,watch_seconds:0,human_timeout:2}});
     if(run?.worker?.done)await Promise.race([run.worker.done,new Promise(r=>setTimeout(r,15000))]);
     const finalApp=applications.get(id),fields=Array.isArray(finalApp?.detail?.disclosure)?finalApp.detail.disclosure:(finalApp?.detail?.disclosure?.fields||[]);
     send(200,{ok:true,job_id:id,state:finalApp?.state||'preparing',detail:finalApp?.detail?{...finalApp.detail,disclosure:{fields}}:{}});return;}
    if(path==='/api/applications/submit-one'&&req.method==='POST'){
     const {id}=await json(req,8000),job=store.getJob(id),app=applications.get(id);if(!job)throw new Error('Job unavailable.');const urlTarget=applyTarget(job);
     let run;
     if(browserRun?.running||discovery.usingBrowser)throw Object.assign(new Error('Another browser task is running. This application remains ready; try again when it finishes.'),{status:409});
     if(app?.state!=='ready_to_submit'||!app.plan_hash)throw Object.assign(new Error('Prepare and review this application before submitting.'),{status:409});
     const blocked=applications.blocker(id,urlTarget);if(blocked)throw Object.assign(new Error('This application or its destination was already submitted. Check History.'),{status:409});
     const token=applications.createReview([id],revisions());const problem=applications.consumeReview(token,[id],revisions());if(problem)throw new Error(problem);
     const plans={[id]:app.plan_hash},jobs=[{id,url:urlTarget,title:job.title,company:job.company,expected_plan:app.plan_hash,...(job.fixture_family&&/^http:\/\/127\.0\.0\.1:/.test(urlTarget)?{family:job.fixture_family}:{})}];
     // The durable 'submitting' record is written only when the worker requests its final-click intent.
     run=startBrowser('submit',{jobs,review:{ids:[id],plans},options:{headless:true,watch_seconds:0,human_timeout:2}});
     if(run?.worker?.done)await Promise.race([run.worker.done,new Promise(r=>setTimeout(r,15000))]);
     const finalApp=applications.get(id),fields=Array.isArray(finalApp?.detail?.disclosure)?finalApp.detail.disclosure:(finalApp?.detail?.disclosure?.fields||[]);
     send(200,{ok:true,job_id:id,state:finalApp?.state||'submitting',detail:finalApp?.detail?{...finalApp.detail,disclosure:{fields}}:{}});return;}
   if(path==='/api/applications/inspect'&&req.method==='POST'){const {ids}=await json(req,30000);send(202,startBrowser('inspect',{jobs:prepareJobs(ids),options:{headless:true,watch_seconds:0}})&&browserSummary());return;}
   if(path==='/api/applications/open'&&req.method==='POST'){const {id}=await json(req,2000),jobs=prepareJobs([id]);send(202,startBrowser('open',{jobs,options:{watch_seconds:1800}})&&browserSummary());return;}
   if(path==='/api/answers'&&req.method==='GET'){const bank=store.setting('answer_bank')||{},labels=store.setting('answer_labels')||{};send(200,{answers:Object.entries(bank).map(([fingerprint,value])=>({fingerprint,value,...(labels[fingerprint]||{})}))});return;}
   if(path==='/api/preferences'&&req.method==='GET'){const preferences=store.setting('user_preferences')||{},extra=Object.keys(preferences).filter(id=>!PREFERENCE_SCHEMA.some(s=>s.id===id)).map(preferenceSpec).filter(Boolean);send(200,{schema:[...PREFERENCE_SCHEMA,...extra],preferences,search_policy:store.setting('search_policy')||null});return;}
   if(path==='/api/preferences'&&req.method==='POST'){const {preferences}=await json(req,30000);send(200,{preferences:savePreferences(store,preferences)});return;}
   if(path==='/api/pool/contribute'&&req.method==='POST'){
    const input=await json(req,200000),jobs=Array.isArray(input.jobs)?input.jobs:[];
    const added=jobs.length?store.ingestCommunityJobs(jobs):0;
    send(200,{ok:true,contributed:jobs.length,added_to_index:added,pool:store.pool.stats()});return;
   }
   if(path==='/api/answers'&&req.method==='POST'){
    const input=await json(req,60000);send(200,saveAnswers(input));return;
   }
   if(path==='/api/applications/review'&&req.method==='POST'){
    const {ids}=await json(req,30000);if(!Array.isArray(ids)||!ids.length||ids.length>50)throw new Error('Choose 1–50 prepared applications.');
    const jobs=ids.map(id=>{const job=store.getJob(id),app=applications.get(id);if(!job||!app||app.state!=='ready_to_submit'||!app.plan_hash)throw new Error('Prepare this job again before submitting: '+(job?.title||id));const target=applyTarget(job),block=applications.blocker(id,target);if(block&&block.job_id!==id)throw new Error('Already applied through another listing: '+job.title);
     return{id,title:job.title,company:job.company,destination:(()=>{try{return new URL(target).hostname.replace(/^www\./,'');}catch{return target;}})(),url:target,route:applyRoute(job),fields:app.detail.disclosure||[],prepared_at:app.updated_at};});
    const token=applications.createReview(ids,revisions());
    send(200,{token,jobs,expires_in:600,disclosure:'Each employer below receives the values listed for it, plus your resume file where shown. Values marked "already on the website" were filled by that website (for example from your LinkedIn profile).'});return;
   }
   if(path==='/api/applications/submit'&&req.method==='POST'){
    const {ids,token}=await json(req,30000);if(browserRun?.running)throw new Error('The browser on this PC is busy.');if(!Array.isArray(ids)||!ids.length||ids.length>50)throw new Error('Choose 1–50 reviewed applications.');
    const problem=applications.consumeReview(token,ids,revisions());if(problem)throw new Error(problem);
    const plans={},jobs=ids.map(id=>{const job=store.getJob(id),app=applications.get(id),url=applyTarget(job);plans[id]=app.plan_hash;return{id,url,title:job.title,company:job.company,expected_plan:app.plan_hash,...(job.fixture_family&&/^http:\/\/127\.0\.0\.1:/.test(url)?{family:job.fixture_family}:{})};});
    startBrowser('submit',{jobs,review:{ids,plans}});send(202,browserSummary());return;
   }
   if(path==='/api/applications/resolve'&&req.method==='POST'){
    const {id,outcome}=await json(req,2000),app=applications.get(id);if(!app||!['unknown_after_submit','submit_rejected','plan_changed','failed_before_submit'].includes(app.state))throw new Error('Only unresolved attempts can be marked.');
    if(!['submitted','not_submitted'].includes(outcome))throw new Error('Choose submitted or not submitted.');
    send(200,applications.set(id,app.detail.url||'',outcome==='submitted'?'marked_submitted':'marked_not_submitted',{note:outcome==='submitted'?'You confirmed it was submitted.':'You confirmed it was not submitted; it can be prepared again.'}));return;
   }

   // ---- The browser on this PC --------------------------------------------------------------
   if(path==='/api/browser/status'&&req.method==='GET'){send(200,{browser:browserSummary(),sessions:sessions()});return;}
   if(path==='/api/browser/login'&&req.method==='POST'){
    // Always show the real site's address bar in the installed browser. Application-window
    // preferences and older clients requesting "remote" must never embed credential entry.
    const {site}=await json(req,2000);if(!LOGIN_SITES[site])throw new Error('Choose LinkedIn, Indeed or Glassdoor.');
    startBrowser('login',{site,options:{plain:true,login_seconds:3600}});
    send(202,browserSummary());return;
   }
   if(path==='/api/browser/frame'&&req.method==='GET'){const after=Number(url.searchParams.get('after'))||0,frame=browserRun?.running?browserRun.frame:null;
    if(!frame||frame.seq<=after){res.writeHead(204,{'Cache-Control':'no-store'});res.end();return;}send(200,{seq:frame.seq,width:frame.width,height:frame.height,url:frame.url,data:frame.data,stream:browserRun.stream||null});return;}
   if(path==='/api/browser/input'&&req.method==='POST'){
    const input=await json(req,4000);if(!browserRun?.running)throw new Error('The live browser is not running.');
    const kinds={click:()=>Number.isFinite(input.x)&&Number.isFinite(input.y),type:()=>typeof input.text==='string'&&input.text.length<=500,key:()=>['Enter','Backspace','Tab','Escape','ArrowDown','ArrowUp','Space','Delete'].includes(input.key),scroll:()=>Number.isFinite(input.dy),back:()=>true,navigate:()=>/^https:\/\//.test(input.url||'')};
    if(!kinds[input.kind]?.())throw new Error('Unsupported input.');
    browserRun.worker.send({type:'input',kind:input.kind,x:input.x,y:input.y,text:input.text,key:input.key,dy:input.dy,url:input.url});send(200,{ok:true});return;
   }
   if(path==='/api/settings/permissions'&&req.method==='POST'){
    const input=await json(req,3000),current=permissions();if(input.mode!==undefined&&!['review','auto_known','auto_all'].includes(input.mode))throw new Error('Unknown permission mode.');
    const next={mode:input.mode??current.mode,paused:input.paused===undefined?current.paused:!!input.paused,daily_cap:Math.min(200,Math.max(1,Number(input.daily_cap??current.daily_cap)||25)),sites:{...current.sites}};
    for(const [site,on]of Object.entries(input.sites||{}))if(site in current.sites)next.sites[site]=!!on;
    store.setting('permissions',{...next,changed_at:Date.now()/1000});send(200,{...permissions(),submitted_today:submittedToday()});return;
   }
   if(path==='/api/settings/windows'&&req.method==='POST'){const {show}=await json(req,500);store.setting('show_browser_windows',!!show);send(200,{show_browser_windows:!!show});return;}
   if(path==='/api/browser/session'&&req.method==='POST'){startBrowser('session',{options:{headless:true,sites:Object.keys(LOGIN_SITES)}});send(202,browserSummary());return;}
   if(path==='/api/browser/done'&&req.method==='POST'){if(browserRun?.running){browserRun.worker.send({type:'close'});browserRun.worker.close();}send(200,{ok:true});return;}
   if(path==='/api/settings/pace'&&req.method==='POST'){const input=await json(req,2000),next={linkedin_apply_seconds:Math.min(120,Math.max(1,Number(input.linkedin_apply_seconds)||DEFAULT_PACE.linkedin_apply_seconds)),concurrency:Math.min(4,Math.max(1,Number(input.concurrency)||DEFAULT_PACE.concurrency)),confirm_timeout:Math.min(300,Math.max(15,Number(input.confirm_timeout)||DEFAULT_PACE.confirm_timeout))};store.setting('pace',next);send(200,next);return;}

   // ---- Resume --------------------------------------------------------------------------------
   if(path==='/api/profile'&&req.method==='GET'){send(200,{profile:store.setting('profile'),resume_file:candidate().resume_path?store.setting('resume_file'):null});return;}
   if(path==='/api/profile'&&req.method==='POST'){
    // The facts forms receive. Edited here, never inferred: prepared plans must be prepared again.
    const input=await json(req,5000),profile=store.setting('profile');if(!profile)throw new Error('Upload your resume first.');const next={...profile};
    for(const [key,max]of [['name',120],['email',200],['phone',40],['location',120],['linkedin',300],['github',300]]){if(input[key]===undefined)continue;const value=String(input[key]).trim();if(value.length>max)throw new Error(key+' is too long.');next[key]=value;}
    if(next.email&&!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(next.email))throw new Error('Enter a valid email address.');if(next.phone&&!/^\+?[\d\s().-]{6,}$/.test(next.phone))throw new Error('Enter the phone number with country code, for example +90 5xx xxx xx xx.');
    for(const key of ['linkedin','github'])if(next[key]&&!/^https:\/\//.test(next[key]))throw new Error('Links must start with https://');
    next.edited_at=new Date().toISOString();store.setting('profile',next);send(200,{profile:next});return;
   }
   if(path==='/api/resume'&&req.method==='POST'){
    const maximum=12*1024*1024,raw=await body(req,maximum+100000),form=await new Request('http://local.test',{method:'POST',headers:{'content-type':req.headers['content-type']||''},body:raw}).formData(),file=form.get('resume');
    if(!(file instanceof File)||file.size>maximum||!(/\.(pdf|docx|txt)$/i.test(file.name))){send(422,{error:'Upload a PDF, DOCX or UTF-8 TXT resume, up to 12 MB.'});return;}
    const extension=file.name.toLowerCase().split('.').at(-1),temporary=join(directory,randomUUID()+'.'+extension),textFile=temporary+'.txt';writeFileSync(temporary,Buffer.from(await file.arrayBuffer()),{mode:0o600});
    try{let text;if(extension!=='txt'){const {command}=workerCommand(root,'companion'),args=process.env.APPLYBURST_WORKER?['--worker','import_resume',temporary,'--output',textFile]:[join(root,'scripts/import_resume.py'),temporary,'--output',textFile];try{await promisify(execFile)(command,args,{cwd:root,timeout:12000,windowsHide:true,maxBuffer:10000,env:workerEnv()});}catch(error){let message='This CV could not be read. Try a text PDF, DOCX or UTF-8 TXT.';try{message=JSON.parse(error.stdout).error||message;}catch{}if(error.killed)message='Reading this CV took too long. Try a smaller text PDF, DOCX or TXT.';throw Object.assign(new Error(message),{status:422});}text=readFileSync(textFile,'utf8');}else text=readFileSync(temporary,'utf8');
     if(text.trim().length<80||text.length>100000)throw new Error('The resume did not contain enough readable text.');const profile=profileFromText(text,file.name.replace(/[^a-zA-Z0-9_. -]/g,'').slice(0,100));writeFileSync(resumeFile,text,{mode:0o600});copyFileSync(temporary,join(directory,'resume.'+extension));try{const plan=await planner.plan(text,{country:store.setting('last_country')||'turkey'});profile.plan={queries:plan.queries,roles:plan.roles.map(r=>r.title),early:plan.early,model:'paraphrase-multilingual-MiniLM-L12-v2',version:PLAN_VERSION,elapsed_ms:plan.elapsed_ms};}catch(error){profile.plan={error:String(error.message).slice(0,200)};}store.setting('profile',profile);store.setting('resume_revision',hash(text));store.setting('resume_file','resume.'+extension);recommendationCache.clear();const cvFilled=fillFromCV(text,true);send(200,{profile,cv_preferences:cvFilled,suggested:profile?.plan?.queries?.length?profile.plan.queries.map((query,i)=>({id:'plan'+i,label:query,query})):suggestedQueries(profile)});
    }finally{for(const file of [temporary,textFile])if(existsSync(file))unlinkSync(file);}return;
   }

   // ---- Developer lab: local index, source refresh, synthetic sandbox ---------------------------
   if(path==='/api/search'&&req.method==='GET'){const query=simpleQuery((url.searchParams.get('q')||'AI agents').slice(0,450)),result=await search.query(query,{location:url.searchParams.get('location')||''});result.results=result.results.slice(0,50).map(job=>jobCard(store.getJob(job.id)||job));send(200,result);return;}
   if(path==='/api/recommendations'&&req.method==='GET'){const profile=store.setting('profile'),key=hash([store.setting('resume_revision'),search.generation]);let result=recommendationCache.get(key);if(!result){result=await recommend(store,search,profile,{});recommendationCache.set(key,result);}send(200,{...result,results:result.results.slice(0,50)});return;}
   if(path==='/api/application-sites'&&req.method==='GET'){send(200,{targets:SITES,verified_submission_sites:SITES.filter(site=>site.submission_verified).length,note:'Configured targets are routing metadata, not verified submission coverage.'});return;}
   if(path==='/api/refresh'&&req.method==='POST'){if(!refreshing&&Date.now()-refreshStarted<60000){send(429,{error:'A refresh was just requested. Please wait a minute.'});return;}refresh().catch(()=>{});send(202,{running:true});return;}
   if(path==='/api/status'&&req.method==='GET'){send(200,{stats:store.stats(),boards:boards.stats(),index_ms:search.indexMs,refreshing:!!refreshing,last_refresh:lastRefresh,rate_events:store.db.prepare('SELECT site,at,outcome,count,elapsed_seconds,note FROM rate_events ORDER BY seq DESC LIMIT 60').all(),embedding_models:semanticStats().loaded?1:0,encoder:semanticStats(),gpu_enabled:false});return;}
   if(path==='/api/index/outbox'&&req.method==='GET'){const after=Math.max(0,Number(url.searchParams.get('after'))||0),events=store.db.prepare('SELECT * FROM index_events WHERE seq>? ORDER BY seq LIMIT 100').all(after);send(200,{events,next_cursor:events.at(-1)?.seq||after,embedding_models:semanticStats().loaded?1:0});return;}
   if(path==='/api/form-schema'&&req.method==='GET'){
    const job=store.getJob(url.searchParams.get('id'));if(!job){send(404,{error:'Job unavailable.'});return;}if(job.provider!=='greenhouse'){send(200,{inspection:'browser_required',note:'Use Prepare to read this form in the browser.',automatic_submission_verified:false});return;}
    const key='schema:'+job.id,cached=store.setting(key);if(cached&&Date.now()/1000-cached.inspected_at<3600){send(200,cached);return;}
    const response=await fetch(`https://boards-api.greenhouse.io/v1/boards/${encodeURIComponent(job.board)}/jobs/${encodeURIComponent(job.external_id)}?questions=true`,{signal:AbortSignal.timeout(15000)});if(!response.ok)throw new Error('Employer schema is unavailable.');const result=greenhouseSchema(job.id,await response.json());store.setting(key,result);send(200,result);return;
   }
   if(path==='/api/sandbox/apply'&&req.method==='POST'){
    const bytes=await body(req,100000),form=await new Request('http://local.test',{method:'POST',headers:{'content-type':req.headers['content-type']||''},body:bytes}).formData(),jobId=String(form.get('job_id')||''),runId=String(form.get('run_id')||'');
    if(!store.getJob(jobId)||!/^[-a-zA-Z0-9]{8,80}$/.test(runId))throw new Error('Invalid sandbox identity.');for(const [key,value]of Object.entries(ANSWERS))if(form.get(key)!==value){send(422,{error:'Only the synthetic sandbox profile is accepted.'});return;}
    const file=form.get('resume');if(!(file instanceof File)||file.size>50000){send(422,{error:'Synthetic resume required.'});return;}const upload=Buffer.from(await file.arrayBuffer()),resumeHash=hash(upload);if(resumeHash!==hash(RESUME)){send(422,{error:'Synthetic resume bytes did not match.'});return;}
    const key=hash(auth.admin.username+':'+runId+':'+jobId),payloadHash=hash(JSON.stringify(ANSWERS)+resumeHash+jobId),receipt={receipt_id:key.slice(0,24),job_id:jobId,run_id:runId,state:'confirmed_sandbox',received_at:Date.now(),resume_sha256:resumeHash,resume_bytes:upload.length,fields_verified:6,destination:'ApplyBurst sandbox only'};
    store.db.prepare('INSERT OR IGNORE INTO receipts VALUES(?,?,?,?,?,?)').run(key,runId,jobId,payloadHash,JSON.stringify(receipt),Date.now()/1000);const stored=store.db.prepare('SELECT payload_hash,payload FROM receipts WHERE key=?').get(key);if(stored.payload_hash!==payloadHash){send(409,{error:'Idempotency conflict.'});return;}send(200,JSON.parse(stored.payload));return;
   }
   if(path==='/api/sandbox/receipts'&&req.method==='GET'){const runId=url.searchParams.get('run_id')||'';if(!/^[-a-zA-Z0-9]{8,80}$/.test(runId))throw new Error('Invalid run ID.');const receipts=store.db.prepare('SELECT payload FROM receipts WHERE run_id=? ORDER BY job_id LIMIT 100').all(runId).map(r=>JSON.parse(r.payload));send(200,{run_id:runId,count:receipts.length,receipts});return;}
   send(404,{error:'Not found.'});
  }catch(error){send(error.status||400,{error:error.message==='Unexpected end of JSON input'?'Invalid JSON.':error.message});}
 });
 server.requestTimeout=20000;server.headersTimeout=10000;
 return{server,store,auth,search,applications,discovery,assistant,refresh,directory,get browser(){return browserRun;},async close(){clearTimeout(initialRefresh);clearInterval(refreshTimer);telegram?.close();assistant?.close();if(activeCrawler){await activeCrawler.terminate();if(refreshing)await refreshing.catch(()=>{});}if(automationMonitor)clearInterval(automationMonitor);if(browserRun?.running){const run=browserRun;run.worker.send({type:'close'});run.worker.close();let timeout;await Promise.race([run.worker.done,new Promise(resolve=>{timeout=setTimeout(resolve,8000);})]);clearTimeout(timeout);if(run.running){run.worker.kill();await run.worker.done;}}await new Promise(resolve=>server.listening?server.close(resolve):resolve());await search.close();store.close();}};
}
if(process.argv[1]&&pathToFileURL(process.argv[1]).href===import.meta.url){
 const app=await createPortal(),port=Number(process.env.APPLYBURST_PORT||8788);app.server.listen(port,'127.0.0.1',()=>console.log(`ApplyBurst listening at http://127.0.0.1:${port}/applyburst/`));
 for(const signal of ['SIGINT','SIGTERM'])process.on(signal,async()=>{await app.close();process.exit(0);});app.server.on('desktop-quit',async()=>{await app.close();process.exit(0);});
 if(process.argv.includes('--refresh'))app.refresh().then(report=>console.log('Source refresh complete: '+report.stats.postings+' postings.')).catch(error=>console.error('Source refresh failed: '+error.message));
}
