// Query-driven job search over plain HTTP. No browser, no Python, no API keys of ours.
// Every scraper returns plain job objects and reports throttling instead of hiding it.
import {geography} from './matching.mjs';
const UA='Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/155.0.0.0 Safari/537.36';
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const decode=text=>String(text||'').replace(/<[^>]*>/g,' ').replace(/&amp;/g,'&').replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&quot;/g,'"').replace(/&#39;|&#x27;/g,"'").replace(/&#(\d+);/g,(_,n)=>String.fromCodePoint(Number(n))).replace(/\s+/g,' ').trim();
// LinkedIn location IDs (Turkey verified 16 Oct 2026: 98 results with it, 4 without). Free-text locations are unreliable.
export const GEO_IDS={turkey:'102105699',germany:'101282230',uk:'101165590',usa:'103644278',netherlands:'102890719',france:'105015875',canada:'101174742',ireland:'104738515',spain:'105646813',poland:'105072130',uae:'104305776',india:'102713980',singapore:'102454443',worldwide:'92000000'};
const INDEED={turkey:['tr','TR','tr'],germany:['de','DE','de'],uk:['uk','GB','en'],usa:['www','US','en'],netherlands:['nl','NL','nl'],france:['fr','FR','fr'],canada:['ca','CA','en'],ireland:['ie','IE','en'],spain:['es','ES','es'],poland:['pl','PL','pl'],uae:['ae','AE','en'],india:['in','IN','en'],singapore:['sg','SG','en'],worldwide:['www','US','en']};
// Indeed's public mobile-app key, as used by the open-source JobSpy project.
const INDEED_KEY='161092c2017b5bbab13edb12461a62d5a833871e7cad6d9d475304573de67ac8';
// A remote job restricted to other countries is not shown; worldwide or unknown stays.
// Worldwide searches keep restricted remote rows here; ranking checks them against the person's home country.
export function remoteAllowed(restrictions,country){if(!country||country==='worldwide')return true;return geography({location_restriction:restrictions.join(' | '),workplace:'remote'},country).status!=='mismatch';}

const flights=new Map(),siteSlots=new Map();
const traffic={upstream_searches:0,coalesced_searches:0,upstream_requests:0,upstream_bytes:0,feed_cache_hits:0,conditional_304s:0,throttled_responses:0,errors:0,by_site:{}};
function parseRetryAfter(value){
 if(!value)return null;
 const seconds=Number(value);
 if(Number.isFinite(seconds)&&seconds>0)return Math.min(3600,Math.max(5,Math.round(seconds)));
 const date=Date.parse(value);
 if(Number.isFinite(date)){const diff=Math.round((date-Date.now())/1000);if(diff>0)return Math.min(3600,Math.max(5,diff));}
 return null;
}
function recordSite(site,{ms=0,bytes=0,throttled=false,error=false,cacheHit=false,notModified=false}={}){
 const entry=traffic.by_site[site]||(traffic.by_site[site]={requests:0,bytes:0,throttled:0,errors:0,cache_hits:0,conditional_304s:0,samples:[]});
 if(cacheHit){entry.cache_hits++;return;}
 entry.requests++;entry.bytes+=bytes;traffic.upstream_requests++;traffic.upstream_bytes+=bytes;
 if(throttled){entry.throttled++;traffic.throttled_responses++;}
 if(error){entry.errors++;traffic.errors++;}
 if(notModified)entry.conditional_304s++;
 if(ms>0){entry.samples.push(Math.round(ms));if(entry.samples.length>80)entry.samples.shift();}
}
function percentile(values,p){if(!values.length)return 0;const sorted=[...values].sort((a,b)=>a-b);return sorted[Math.min(sorted.length-1,Math.floor(sorted.length*p))];}
export function searchTraffic(){
 const by_site=Object.fromEntries(Object.entries(traffic.by_site).map(([site,s])=>[site,{requests:s.requests,bytes:s.bytes,throttled:s.throttled,errors:s.errors,cache_hits:s.cache_hits,conditional_304s:s.conditional_304s,p50_ms:percentile(s.samples,0.5),p95_ms:percentile(s.samples,0.95)}]));
 return{...traffic,by_site,in_flight:flights.size};
}

// One shared source snapshot serves different queries. Concurrent requests share the fetch.
// Expired entries retain ETag/Last-Modified so revalidation can return 304 Not Modified.
const feedCache=new Map();
async function sharedFeed(url,report,ttl=900000,site='feed'){
 const previous=feedCache.get(url),now=Date.now();
 if(previous?.data&&now-previous.at<ttl){
  traffic.feed_cache_hits++;recordSite(site,{cacheHit:true});
  report.feed_cache_age_seconds=Math.round((now-previous.at)/1000);report.feed_revision=previous.at;
  return previous.data;
 }
 if(previous?.inFlight){
  traffic.feed_cache_hits++;recordSite(site,{cacheHit:true});
  report.feed_revision=previous.at;return previous.inFlight;
 }
 const entry=previous||{at:now,data:null,etag:null,lastModified:null,inFlight:null};
 report.feed_revision=entry.at||now;
 entry.inFlight=(async()=>{
  const t0=performance.now(),headers={'user-agent':'ApplyBurst/0.6 (job search; read-only)',accept:'application/json'};
  if(entry.etag)headers['if-none-match']=entry.etag;
  if(entry.lastModified)headers['if-modified-since']=entry.lastModified;
  const response=await fetch(url,{headers,signal:AbortSignal.timeout(12000)});
  if(response.status===304&&entry.data){
   traffic.conditional_304s++;recordSite(site,{ms:performance.now()-t0,notModified:true});
   entry.at=Date.now();report.feed_cache_age_seconds=0;report.feed_revision=entry.at;
   return entry.data;
  }
  if(response.status===429||response.status===999){
   report.throttled=true;report.retry_after_seconds=parseRetryAfter(response.headers.get('retry-after'));
   recordSite(site,{ms:performance.now()-t0,throttled:true});
   throw new Error('Source returned HTTP '+response.status);
  }
  if(!response.ok){recordSite(site,{ms:performance.now()-t0,error:true});throw new Error('Source returned HTTP '+response.status);}
  const chunks=[];let size=0;
  for await(const chunk of response.body){size+=chunk.length;if(size>15_000_000)throw new Error('Feed exceeds 15MB budget.');chunks.push(chunk);}
  recordSite(site,{ms:performance.now()-t0,bytes:size});
  const data=JSON.parse(Buffer.concat(chunks).toString('utf8'));
  entry.data=data;entry.at=Date.now();entry.etag=response.headers.get('etag')||entry.etag;entry.lastModified=response.headers.get('last-modified')||entry.lastModified;
  report.feed_revision=entry.at;report.feed_cache_age_seconds=0;
  return data;
 })();
 feedCache.set(url,entry);
 try{return await entry.inFlight;}catch(error){if(!entry.data&&feedCache.get(url)===entry)feedCache.delete(url);throw error;}finally{entry.inFlight=null;}
}

async function linkedin(q,report){
 const needed=Math.max(1,q.limit-(q.existing_count||0)),startOffset=Math.max(0,Number(q.start_offset)||0),found=new Map(),params=new URLSearchParams({keywords:q.query});
 if(GEO_IDS[q.country])params.set('geoId',GEO_IDS[q.country]);if(q.location)params.set('location',q.location);
 // LinkedIn's native experience filter from the CV level (1 internship, 2 entry, 3 associate, 4 mid-senior, 5 director).
 const EXPERIENCE={early:'1,2',mid:'2,3,4',senior:'4,5'};if(EXPERIENCE[q.level])params.set('f_E',EXPERIENCE[q.level]);
 if(q.easy_apply)params.set('f_AL','true');if(q.hours_old)params.set('f_TPR','r'+q.hours_old*3600);if(q.remote)params.set('f_WT','2');
 let start=startOffset;
 for(let page=0;found.size<needed&&start<1000;start+=10,page++){
  if(page)await sleep(q.page_delay??4000);
  params.set('start',String(start));const t0=performance.now();
  const response=await fetch('https://www.linkedin.com/jobs-guest/jobs/api/seeMoreJobPostings/search?'+params,{headers:{'user-agent':UA,accept:'text/html','accept-language':'en-US,en;q=0.9'},signal:AbortSignal.timeout(20000)});
  if(response.status===999){
   report.captcha=true;report.throttled=true;report.stop_reason='captcha_required';
   recordSite('linkedin',{ms:performance.now()-t0,throttled:true});
   report.warnings.push(`LinkedIn checkpoint / CAPTCHA required. Please open LinkedIn in your browser to verify.`);break;
  }
  if(response.status===429){
   report.throttled=true;report.stop_reason='throttled';report.retry_after_seconds=parseRetryAfter(response.headers.get('retry-after'));
   recordSite('linkedin',{ms:performance.now()-t0,throttled:true});
   report.warnings.push(`LinkedIn throttled the search (HTTP 429) after ${found.size} results.`);break;
  }
  if(!response.ok){recordSite('linkedin',{ms:performance.now()-t0,error:true});report.stop_reason='failed';report.warnings.push('LinkedIn returned HTTP '+response.status+'.');break;}
  const html=await response.text();recordSite('linkedin',{ms:performance.now()-t0,bytes:Buffer.byteLength(html)});
  const cards=html.split(/<li[\s>]/).slice(1);let added=0;
  for(const card of cards){const id=card.match(/urn:li:jobPosting:(\d+)/)?.[1];if(!id||found.has(id))continue;
   const title=decode(card.match(/base-search-card__title[^>]*>([\s\S]*?)<\/h3>/)?.[1]),company=decode(card.match(/base-search-card__subtitle[^>]*>([\s\S]*?)<\/h4>/)?.[1]);
   const location=decode(card.match(/job-search-card__location[^>]*>([\s\S]*?)<\/span>/)?.[1]),posted=card.match(/<time[^>]*datetime="([^"]+)"/)?.[1]||null;if(!title)continue;
   found.set(id,{external_id:id,title,company,location,posted_at:posted,description:'',description_state:'card_only',listing_url:`https://www.linkedin.com/jobs/view/${id}/`,apply_url:`https://www.linkedin.com/jobs/view/${id}/`,apply_route:q.easy_apply?'linkedin_easy_apply':'unknown',workplace:/remote|uzaktan/i.test(location)?'remote':'unknown'});added++;if(found.size>=needed)break;}
  report.batch?.([...found.values()].slice(-added));
  report.next_offset=start+10;
  report.has_more=cards.length>=10&&added>0&&start+10<1000;
  if(cards.length<10||!added)break;
 }
 if(!report.stop_reason)report.stop_reason=report.has_more&&found.size>=needed?'budget_reached':'exhausted';
 return[...found.values()];
}

const INDEED_QUERY=`query GetJobData { jobSearch( {WHAT} {WHERE} limit: 100 {CURSOR} sort: DATE {FILTERS} ) { pageInfo { nextCursor } results { job { key title sourceEmployerName dateOnIndeed description { html } location { countryCode admin1Code city } employer { name } recruit { viewJobUrl } attributes { key label } } } } }`;
async function indeed(q,report){
 const [domain,code,language]=INDEED[q.country]||INDEED.usa,filters=[];
 if(q.hours_old)filters.push(`{ date: { field: "dateOnIndeed", start: "${q.hours_old}h" } }`);if(q.remote)filters.push('{ keyword: { field: "attributes", keys: ["DSQF7"] } }');
 const jobs=new Map(),needed=Math.max(1,q.limit-(q.existing_count||0));let cursor=q.cursor||null;
 for(let page=0;jobs.size<needed&&page<3;page++){
  const query=INDEED_QUERY.replace('{WHAT}','what: '+JSON.stringify(q.query)).replace('{WHERE}',q.location?`location: {where: ${JSON.stringify(q.location)}, radius: 50, radiusUnit: MILES}`:'').replace('{CURSOR}',cursor?`cursor: "${cursor}"`:'').replace('{FILTERS}',filters.length?`filters: [${filters.join(', ')}]`:'');
  const t0=performance.now();
  const response=await fetch('https://apis.indeed.com/graphql',{method:'POST',signal:AbortSignal.timeout(25000),headers:{'content-type':'application/json',accept:'application/json','indeed-api-key':INDEED_KEY,'indeed-co':code,'indeed-locale':language+'-'+code,'accept-language':'en-US,en;q=0.9',
   'user-agent':'Mozilla/5.0 (iPhone; CPU iPhone OS 16_6_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 Indeed App 193.1','indeed-app-info':'appv=193.1; appid=com.indeed.jobsearch; osv=16.6.1; os=ios; dtype=phone'},body:JSON.stringify({query})});
  if(response.status===429){
   report.throttled=true;report.stop_reason='throttled';report.retry_after_seconds=parseRetryAfter(response.headers.get('retry-after'));
   recordSite('indeed',{ms:performance.now()-t0,throttled:true});
   report.warnings.push('Indeed throttled the search (HTTP 429).');break;
  }
  if(!response.ok){recordSite('indeed',{ms:performance.now()-t0,error:true});report.stop_reason='failed';report.warnings.push('Indeed returned HTTP '+response.status+'.');break;}
  const rawText=await response.text();recordSite('indeed',{ms:performance.now()-t0,bytes:Buffer.byteLength(rawText)});
  const data=JSON.parse(rawText),search=data?.data?.jobSearch;if(!search){report.stop_reason='exhausted';report.warnings.push('Indeed: '+JSON.stringify(data?.errors||'no results').slice(0,200));break;}
  const batch=[];
  for(const {job}of search.results||[]){if(!job||jobs.has(job.key))continue;const direct=job.recruit?.viewJobUrl,external=direct&&/^https:\/\//.test(direct)&&!new URL(direct).hostname.endsWith('indeed.com')?direct:null;
   const keys=new Set((job.attributes||[]).map(a=>a.key)),loc=job.location||{},listing=`https://${domain}.indeed.com/viewjob?jk=${job.key}`;
   const item={external_id:job.key,title:job.title,company:job.employer?.name||job.sourceEmployerName||'',location:[loc.city,loc.admin1Code,loc.countryCode].filter(Boolean).join(', '),description:job.description?.html||'',description_state:job.description?.html?'present':'missing',
    listing_url:listing,apply_url:external||listing,destination_url:external,apply_route:external?'employer_site':'indeed',posted_at:job.dateOnIndeed?new Date(job.dateOnIndeed).toISOString():null,workplace:keys.has('DSQF7')&&!keys.has('PAXZC')?'remote':keys.has('PAXZC')?'hybrid':'unknown',employment_type:(job.attributes||[]).map(a=>a.label).find(l=>/full|part|intern|staj|contract|tam|yarı/i.test(l||''))||'unknown'};
   jobs.set(job.key,item);batch.push(item);if(jobs.size>=needed)break;}
  report.batch?.(batch);cursor=search.pageInfo?.nextCursor||null;report.next_cursor=cursor;report.has_more=!!cursor&&batch.length>0;if(!cursor||!batch.length)break;
 }
 if(!report.stop_reason)report.stop_reason=report.has_more&&jobs.size>=needed?'budget_reached':'exhausted';
 return[...jobs.values()];
}

async function himalayas(q,report){
 const jobs=[],seen=new Set(),needed=Math.max(1,q.limit-(q.existing_count||0)),startPage=Math.max(1,Number(q.start_page)||1),maxPage=Math.min(20,startPage+Math.ceil(needed/20)+2);
 for(let page=startPage;jobs.length<needed&&page<=maxPage;page++){
  const params=new URLSearchParams({q:q.query,page:String(page),sort:'relevant'});if(q.country!=='worldwide'&&INDEED[q.country])params.set('country',INDEED[q.country][1]);
  const t0=performance.now();
  const response=await fetch(`https://himalayas.app/jobs/api/search?${params}`,{headers:{'user-agent':'ApplyBurst/0.6 (job search; read-only)',accept:'application/json'},signal:AbortSignal.timeout(20000)});
  if(response.status===429){
   report.throttled=true;report.stop_reason='throttled';report.retry_after_seconds=parseRetryAfter(response.headers.get('retry-after'));
   recordSite('himalayas',{ms:performance.now()-t0,throttled:true});
   report.warnings.push('Himalayas throttled the search (HTTP 429).');break;
  }
  if(!response.ok){recordSite('himalayas',{ms:performance.now()-t0,error:true});report.stop_reason='failed';report.warnings.push('Himalayas returned HTTP '+response.status+'.');break;}
  const rawText=await response.text();recordSite('himalayas',{ms:performance.now()-t0,bytes:Buffer.byteLength(rawText)});
  const rows=(JSON.parse(rawText)).jobs||[];report.next_page=page+1;report.has_more=rows.length>0&&page<20;if(!rows.length)break;const batch=[];
  for(const row of rows){const restrictions=row.locationRestrictions||[],identity=String(row.guid||row.applicationLink);if(seen.has(identity)||!remoteAllowed(restrictions,q.country)||!/^https:\/\//.test(row.applicationLink||''))continue;seen.add(identity);
   if(q.hours_old&&row.pubDate&&Date.now()/1000-row.pubDate>q.hours_old*3600)continue;
   batch.push({external_id:String(row.guid||row.applicationLink).split('/').pop().slice(0,120),title:row.title,company:row.companyName||'',location:restrictions.join(', ')||'Remote (worldwide)',location_restriction:restrictions.join(', ')||null,description:row.description||row.excerpt||'',description_state:row.description?'present':'missing',
    listing_url:row.applicationLink,apply_url:row.applicationLink,apply_route:'link_out',posted_at:row.pubDate?new Date(row.pubDate*1000).toISOString():null,workplace:'remote',employment_type:row.employmentType||'unknown'});}
  const selected=batch.slice(0,needed-jobs.length);jobs.push(...selected);report.batch?.(selected);
 }
 if(!report.stop_reason)report.stop_reason=report.has_more&&(jobs.length>=needed||report.next_page>maxPage)?'budget_reached':'exhausted';
 return jobs;
}

async function remoteok(q,report){
 let rows;try{rows=await sharedFeed('https://remoteok.com/api',report,900000,'remoteok');}catch(error){report.warnings.push('Remote OK: '+error.message);if(/HTTP 429/.test(error.message)){report.throttled=true;report.stop_reason='throttled';}else report.stop_reason='failed';return[];}
 const words=(q.query.toLowerCase().match(/[a-z0-9+#.]+/g)||[]).filter(w=>w.length>1);
 const catalog=rows.filter(row=>row?.id&&/^https:\/\//.test(row.url||'')).map(row=>{const location=String(row.location||'').trim();return{external_id:String(row.id),title:row.position,company:row.company||'',location:location||'Remote (location not provided)',location_restriction:location||null,description:row.description||'',description_state:row.description?'present':'missing',skills:row.tags||[],listing_url:row.url,apply_url:/^https:\/\//.test(row.apply_url||'')?row.apply_url:row.url,apply_route:'link_out',posted_at:row.date||null,workplace:'remote',employment_type:'unknown'};});
 report.catalog?.(catalog,report.feed_revision);
 const matched=catalog.filter(job=>{const text=[job.title,...(job.skills||[]),job.company,decode(job.description)].join(' ').toLowerCase(),posted=Date.parse(job.posted_at);return words.every(word=>text.includes(word))&&remoteAllowed(job.location_restriction?[job.location_restriction]:[],q.country)&&(!q.hours_old||!Number.isFinite(posted)||Date.now()-posted<=q.hours_old*3600000);});
 const start=Math.max(0,Number(q.start_offset)||0),jobs=matched.slice(start,q.limit);
 report.next_offset=start+jobs.length;report.has_more=matched.length>q.limit;report.stop_reason=report.has_more?'budget_reached':'exhausted';
 report.batch?.(jobs);return jobs;
}

// Whole public feeds are fetched once, shared across keyword queries, and saved in the
// repository's local pool. No browser is launched for these sources.
async function aggregate(provider,q,report){
 const urls={jobicy:'https://jobicy.com/api/v2/remote-jobs?count=100',remotive:'https://remotive.com/api/remote-jobs',arbeitnow:'https://www.arbeitnow.com/api/job-board-api'};
 let payload;
 try{payload=await sharedFeed(urls[provider],report,provider==='remotive'?21600000:900000,provider);}
 catch(error){if(/HTTP 429/.test(error.message)){report.throttled=true;report.stop_reason='throttled';}else report.stop_reason='failed';throw error;}
 const rows=provider==='arbeitnow'?payload.data:payload.jobs;
 if(!Array.isArray(rows))throw new Error('Invalid '+provider+' feed.');
 const catalog=rows.flatMap(row=>{
  const url=row.url;if(!/^https:\/\//.test(url||''))return[];
  const jobicy=provider==='jobicy',remotive=provider==='remotive',location=jobicy?row.jobGeo:remotive?row.candidate_required_location:row.location;
  const direct=[row.apply_url,row.applicationUrl,row.jobApplyLink].find(value=>typeof value==='string'&&/^https:\/\//.test(value));
  let posted=jobicy?row.pubDate:remotive?row.publication_date:row.created_at?new Date(row.created_at*1000).toISOString():null;
  if(posted&&!/Z$|[+-]\d\d:\d\d$/.test(posted))posted=posted.replace(' ','T')+'Z';
  return[{external_id:String(row.id||row.slug),title:jobicy?row.jobTitle:row.title,company:jobicy?row.companyName:row.company_name,
   location:location||'Location not provided',location_restriction:location||null,description:(jobicy?row.jobDescription:row.description)||'',description_state:'present',
   listing_url:url,apply_url:direct||url,destination_url:direct||null,apply_route:'link_out',posted_at:posted,workplace:remotive||jobicy||row.remote===true?'remote':'unknown',
   employment_type:jobicy?(row.jobType||[]).join(', '):remotive?row.job_type:(row.job_types||[]).join(', ')}];
 });
 report.catalog?.(catalog,report.feed_revision);
 const keywords=q.query.toLowerCase().split(/\s+/).filter(Boolean),matched=catalog.filter(job=>{
  const text=(job.title+' '+decode(job.description)).toLowerCase(),posted=Date.parse(job.posted_at);
  return keywords.every(word=>text.includes(word))&&remoteAllowed(job.location_restriction?[job.location_restriction]:[],q.country)&&(!q.remote||job.workplace==='remote')&&(!q.hours_old||!Number.isFinite(posted)||Date.now()-posted<=q.hours_old*3600000);
 });
 const start=Math.max(0,Number(q.start_offset)||0),jobs=matched.slice(start,q.limit);
 report.next_offset=start+jobs.length;report.has_more=matched.length>q.limit;report.stop_reason=report.has_more?'budget_reached':'exhausted';
 if(provider==='remotive')report.warnings.push('Remotive public feed is delayed by 24 hours by the provider.');
 report.batch?.(jobs);return jobs;
}
export const SCRAPERS={linkedin,indeed,himalayas,remoteok,jobicy:(q,r)=>aggregate('jobicy',q,r),remotive:(q,r)=>aggregate('remotive',q,r),arbeitnow:(q,r)=>aggregate('arbeitnow',q,r)};

// Identical simultaneous public searches share one upstream read. Source-wide slots keep
// several visitors from multiplying outbound concurrency; sharedFeed also coalesces catalogs.
async function sourceSlot(site,work){
 const state=siteSlots.get(site)||{active:0,waiting:[]};siteSlots.set(site,state);
 const cap=site==='linkedin'?1:2;if(state.active>=cap)await new Promise(resolve=>state.waiting.push(resolve));else state.active++;
 try{return await work();}finally{const next=state.waiting.shift();if(next)next();else state.active--;}
}
export async function searchHTTP(site,input,report){
 const key=JSON.stringify([site,input.query,input.country,input.location,input.limit,input.hours_old,input.remote,input.easy_apply,input.cursor||null,input.start_page||1,input.start_offset||0,input.level||null]);
 let flight=flights.get(key);
 if(!flight){
  flight={listeners:new Set(),batches:[],catalogs:[],report:{warnings:[],throttled:false}};flights.set(key,flight);traffic.upstream_searches++;
  flight.report.batch=jobs=>{flight.batches.push(jobs);for(const listener of flight.listeners)listener.batch?.(jobs);};
  flight.report.catalog=(jobs,revision)=>{flight.catalogs.push([jobs,revision]);for(const listener of flight.listeners)listener.catalog?.(jobs,revision);};
  flight.promise=sourceSlot(site,()=>SCRAPERS[site](input,flight.report)).finally(()=>flights.delete(key));
 }else traffic.coalesced_searches++;
 flight.listeners.add(report);for(const jobs of flight.batches)report.batch?.(jobs);for(const [jobs,revision]of flight.catalogs)report.catalog?.(jobs,revision);
 try{return await flight.promise;}finally{
  flight.listeners.delete(report);
  for(const field of ['warnings','throttled','captcha','feed_cache_age_seconds','has_more','next_cursor','next_page','next_offset','stop_reason','retry_after_seconds'])if(flight.report[field]!==undefined)report[field]=flight.report[field];
 }
}
