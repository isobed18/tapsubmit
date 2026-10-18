// Bounded live read-only measurement of the production discovery/ranking/cache path.
// No browser, model, candidate upload or employer application.
import {readFileSync,writeFileSync,mkdirSync,mkdtempSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {Store} from '../web/lib/store.mjs';
import {IndexedSearch} from '../web/lib/indexed-search.mjs';
import {Discovery,discoveryRequest,applyRoute} from '../web/lib/discovery.mjs';
import {Boards} from '../web/lib/boards.mjs';
import {boardURL,refreshSources} from '../web/lib/sources.mjs';
import {profileFromText} from '../web/lib/profile.mjs';
import {hash} from '../web/lib/jobs.mjs';

const root=resolve(import.meta.dirname,'..'),value=(key,fallback)=>process.argv.includes(key)?process.argv[process.argv.indexOf(key)+1]:fallback;
const output=resolve(value('--output','reports/core-discovery.json')),profilePath=value('--profile',null),profile=profilePath?profileFromText(readFileSync(profilePath,'utf8')):null;
const parent=join(root,'.data/core-discovery');mkdirSync(parent,{recursive:true});const directory=resolve(value('--directory',mkdtempSync(join(parent,'run-')))),store=new Store(join(directory,'catalog.sqlite')),search=new IndexedSearch(store);
const percentile=(values,p)=>[...values].sort((a,b)=>a-b)[Math.min(values.length-1,Math.ceil(values.length*p)-1)];
const boardSamples=[['greenhouse','anthropic'],['lever','trendyol'],['ashby','langchain'],['workable','wingieenuygun'],['smartrecruiters','BoschGroup'],['personio','appliedai.jobs.personio.de']];
let discovery,firstBatch;
try{
 const start=performance.now(),sources=boardSamples.map(([provider,board])=>({id:provider+':'+board,provider,board,company:board,kind:'ats',url:provider==='smartrecruiters'?boardURL(provider,board)+'&q=AI':boardURL(provider,board),max_jobs:10,ttl_seconds:21600}));
 const bootstrap=await refreshSources(store,sources);await search.load();
 const boards=new Boards({store,search});
 discovery=new Discovery({store,search,root,onJobs:jobs=>{if(jobs.length&&firstBatch===null)firstBatch=performance.now();boards.note(jobs);}});
 const countries=value('--countries','turkey,usa').split(','),runs=[];
 for(const country of countries){
  const input={queries:process.argv.includes('--suggested')?undefined:['AI engineer','machine learning engineer','agentic AI'],sites:value('--sources','indeed,himalayas,remoteok,boards').split(','),country,limit:25,hours_old:168};
  const request=discoveryRequest(input,profile);firstBatch=null;const tick=performance.now(),task=discovery.start(request);
  while(task.running)await new Promise(resolve=>setTimeout(resolve,10));if(task.error)throw new Error(task.error);
  const complete=performance.now(),ranking=discovery.ranked(task,profile),cached=[];
  for(let i=0;i<5;i++){const begin=performance.now(),cachedTask=discovery.start(request);while(cachedTask.running)await new Promise(resolve=>setTimeout(resolve,1));discovery.ranked(cachedTask,profile);cached.push(performance.now()-begin);}
  const exclusions={};for(const row of ranking.excluded)for(const reason of row.match.conflicts)exclusions[reason]=(exclusions[reason]||0)+1;
  const routeCounts={};for(const job of ranking.results){const route=applyRoute(job),key=route.family||route.route;routeCounts[key]=(routeCounts[key]||0)+1;}
  const row={country,queries:request.queries,raw_unique:discovery.jobsFor(task).length,matching_jobs:ranking.results.length,auto_selectable_known_routes:ranking.results.filter(job=>job.match.auto_selectable&&applyRoute(job).automatable).length,first_batch_ms:firstBatch===null?null:Math.round(firstBatch-tick),complete_ms:Math.round(complete-tick),ranking_ms:Math.round(ranking.elapsed_ms*100)/100,cached_samples_ms:cached.map(n=>Math.round(n*100)/100),cached_p50_ms:Math.round(percentile(cached,.5)*100)/100,cached_p95_ms:Math.round(percentile(cached,.95)*100)/100,duplicates_removed:ranking.duplicates,exclusions,routes:routeCounts,sources:task.rows.map(({job_ids,key,done,...row})=>row),samples:ranking.results.slice(0,8).map(job=>({title:job.title,company:job.company,location:job.location,url:job.apply_url,route:applyRoute(job).family,posted_at:job.posted_at,score:job.match.score,seniority_conflict:job.match.seniority_conflict,minimum_years:job.match.minimum_years,geography:job.match.geography.status}))};
  runs.push(row);console.log(JSON.stringify({country,raw_unique:row.raw_unique,matching_jobs:row.matching_jobs,first_batch_ms:row.first_batch_ms,complete_ms:row.complete_ms,cached_p50_ms:row.cached_p50_ms,auto_selectable_known_routes:row.auto_selectable_known_routes}));
 }
 const hashes=Object.fromEntries(['discovery','scrapers','matching','sources','boards','store'].map(name=>[name,hash(readFileSync(join(root,'web/lib',name+'.mjs')))]));
 const report={utc:new Date().toISOString(),scope:'Live public HTTP discovery, six sample employer boards plus Indeed/Himalayas/Remote OK; 25 results/source/query, past week. Bounded coverage sample, not market recall or human-judged relevance accuracy. No application was submitted.',candidate_profile_used_locally:!!profile,candidate_profile_in_report:false,model_calls:0,browser_processes:0,gpu_inference:false,source_sha256:hashes,board_bootstrap_ms:Math.round(bootstrap.elapsed_ms),initial_index_setup_ms:Math.round(search.indexMs),indexing:'Incremental SQLite FTS5; maintenance time included in ingestion, no corpus worker clone',board_sources:bootstrap.sources,stats:{postings:store.stats().postings,chunks:store.stats().chunks,...store.pool.stats()},peak_node_rss_mb:Math.round(process.resourceUsage().maxRSS/1024*10)/10,runs};
 mkdirSync(resolve(output,'..'),{recursive:true});writeFileSync(output,JSON.stringify(report,null,2));
}finally{await search.close();store.close();}
