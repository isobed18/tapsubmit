import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {join} from 'node:path';
import {gzipSync} from 'node:zlib';
import {BOARDS} from '../../demo/lib/sandbox.mjs';
import {feedURL} from '../../demo/lib/feeds.mjs';
import {decorate,hash,normalizedJob,normalizeFeed,plainText} from './jobs.mjs';

// Workday boards are "tenant|wdN|site" (public directory format); BambooHR boards are the company subdomain.
export function workdayParts(board){const [tenant,wd,site]=String(board).split('|');if(!/^[a-z0-9-]+$/i.test(tenant||'')||!/^wd\d{1,2}$/i.test(wd||'')||!/^[\w-]+$/.test(site||''))throw new Error('Invalid Workday board.');return{tenant,wd,site,origin:`https://${tenant}.${wd}.myworkdayjobs.com`};}
export function boardURL(provider,board){if(provider==='bamboohr'){if(!/^[a-z0-9-]+$/i.test(board))throw new Error('Invalid BambooHR board.');return `https://${board}.bamboohr.com/careers/list`;}if(provider==='workday'){const w=workdayParts(board);return `${w.origin}/wday/cxs/${w.tenant}/${w.site}/jobs`;}if(provider==='personio'){const host=board.includes('.')?board:board+'.jobs.personio.de';if(!/^[a-z0-9-]+\.jobs\.personio\.(com|de)$/i.test(host))throw new Error('Invalid Personio board host.');return `https://${host}/xml?language=en`;}return provider==='workable'?`https://apply.workable.com/api/v1/widget/accounts/${encodeURIComponent(board)}?details=true`:provider==='smartrecruiters'?`https://api.smartrecruiters.com/v1/companies/${encodeURIComponent(board)}/postings?limit=40`:feedURL(provider,encodeURIComponent(board));}
export function loadSources(root){return [...BOARDS.map(([provider,board,company])=>({id:provider+':'+board,kind:'ats',provider,board,company,url:feedURL(provider,board),ttl_seconds:900})),...JSON.parse(readFileSync(join(root,'config/sources.json'),'utf8'))].map(s=>({...s,url:s.url||(s.provider==='smartrecruiters'?`https://api.smartrecruiters.com/v1/companies/${s.board}/postings?q=${encodeURIComponent(s.query||'')}&limit=${s.max_jobs||40}`:boardURL(s.provider,s.board))}));}
// Workable's public per-company widget feed: every open job with its description.
export function parseWorkable(source,payload){
 if(!Array.isArray(payload?.jobs))throw new Error('Invalid Workable feed.');
 return payload.jobs.map(j=>normalizedJob(source,{external_id:j.shortcode,title:j.title,company:payload.name||source.company,description:j.description,location:[j.city,j.state,j.country].filter(Boolean).join(', '),
  workplace:String(j.telecommuting).toLowerCase()==='true'?'remote':'unknown',employment_type:j.employment_type,apply_url:j.url,posted_at:j.published_on||j.created_at}));
}
function tag(xml,name){const match=xml.match(new RegExp('<'+name+'(?:\\s[^>]*)?>([\\s\\S]*?)<\\/'+name+'>','i'));return match?match[1].replace(/^\s*<!\[CDATA\[([\s\S]*)\]\]>\s*$/,'$1').trim():'';}
export function parsePersonio(source,xml){
 if(!/<workzag-jobs\b/i.test(xml)||/<!ENTITY|<!DOCTYPE/i.test(xml))throw new Error('Invalid Personio XML feed.');
 return [...xml.matchAll(/<position\b[^>]*>([\s\S]*?)<\/position>/gi)].map(([,row])=>{
  const id=tag(row,'id');if(!/^\d+$/.test(id))throw new Error('Invalid Personio posting identity.');
  const sections=[...row.matchAll(/<jobDescription\b[^>]*>([\s\S]*?)<\/jobDescription>/gi)].map(([,section])=>plainText(tag(section,'name'))+'\n'+plainText(tag(section,'value')));
  const locations=[...row.matchAll(/<office\b[^>]*>([\s\S]*?)<\/office>/gi)].map(([,place])=>plainText(place));
  return normalizedJob(source,{external_id:id,title:tag(row,'name'),company:plainText(tag(row,'subcompany'))||source.company,description:sections.join('\n\n'),location:[...new Set(locations)].join(' · '),locations:[...new Set(locations)],employment_type:tag(row,'schedule'),seniority:tag(row,'seniority'),apply_url:new URL('/job/'+id+'?language=en',source.url).href,posted_at:tag(row,'createdAt')||null});
 });
}
export function parseRSS(source,xml){
 if(!/<rss\b|<feed\b/i.test(xml)||/<!ENTITY/i.test(xml))throw new Error('Invalid or unsupported RSS document.');
 const items=[...xml.matchAll(/<item\b[^>]*>([\s\S]*?)<\/item>/gi)];
 return items.map(([,item])=>{const fullTitle=plainText(tag(item,'title')),split=fullTitle.indexOf(': '),url=plainText(tag(item,'link')),company=split>0?fullTitle.slice(0,split):source.provider;
 return normalizedJob(source,{external_id:hash(tag(item,'guid')||url),title:split>0?fullTitle.slice(split+2):fullTitle,company,description:tag(item,'content:encoded')||tag(item,'description'),location:plainText(tag(item,'region'))||'Remote — check listing restrictions',workplace:'remote',apply_url:url,posted_at:tag(item,'pubDate')});});
}
export function parseJSONLD(source,html){
 const rows=[];function visit(value){if(Array.isArray(value)){value.forEach(visit);return;}if(!value||typeof value!=='object')return;if([value['@type']].flat().includes('JobPosting'))rows.push(value);if(value['@graph'])visit(value['@graph']);}
 for(const [,json]of html.matchAll(/<script\b[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)){try{visit(JSON.parse(json));}catch{}}
 if(!rows.length)throw new Error('No JobPosting JSON-LD found; browser rendering is not used.');
 return rows.filter(j=>!j.validThrough||!Number.isFinite(Date.parse(j.validThrough))||Date.parse(j.validThrough)>Date.now()).map(j=>{
 const locations=[j.jobLocation].flat().filter(Boolean).map(l=>[l.address?.addressLocality,l.address?.addressRegion,typeof l.address?.addressCountry==='object'?l.address.addressCountry.name:l.address?.addressCountry].filter(Boolean).join(', '));
 const url=j.url||source.url,match=url.match(/jobs\.smartrecruiters\.com\/([^/]+)\/(\d+)/);
 return normalizedJob(source,{external_id:String(j.identifier?.value||hash(url)),canonical_id:match?`smartrecruiters:${match[1]}:${match[2]}`:undefined,title:j.title,description:j.description,company:j.hiringOrganization?.name,location:locations.join(' · '),locations,workplace:j.jobLocationType==='TELECOMMUTE'?'remote':'unknown',employment_type:[j.employmentType].flat().filter(Boolean).join(', '),apply_url:url,posted_at:j.datePosted});});
}
export function parsePythonJob(source,html,url){
 const description=html.match(/<div class="job-description">([\s\S]*?)<\/div>\s*<!-- end \.job-post-content -->/i)?.[1],title=plainText(description?.match(/<h2>\s*Job Title\s*<\/h2>([\s\S]*?)<h2>/i)?.[1]||''),companyBlock=plainText(html.match(/<span class="company-name">([\s\S]*?)<\/span>/i)?.[1]||''),location=plainText(html.match(/<span class="listing-location">([\s\S]*?)<\/span>/i)?.[1]||'');
 if(!description||!title)throw new Error('Python.org job markup changed.');
 const afterBreak=html.match(/<span class="company-name">[\s\S]*?<br\s*\/?>\s*([^<]+)/i)?.[1];const company=plainText(afterBreak||companyBlock.split('\n').map(s=>s.trim()).filter(s=>s&&s!=='New'&&s!==title).at(-1)||'Not specified'),noRemote=/No telecommuting/i.test(description);
 return normalizedJob(source,{external_id:url.match(/\/jobs\/(\d+)/)?.[1],title,company,description,location,workplace:noRemote?'onsite':/remote|telecommut/i.test(location)?'remote':'unknown',apply_url:url,posted_at:html.match(/<time datetime="([^"]+)"/)?.[1]});
}
export function parseAggregator(source,payload){
 const rows=source.provider==='remotive'?payload.jobs:payload.data;if(!Array.isArray(rows))throw new Error('Invalid aggregator payload.');
 return rows.map(j=>normalizedJob(source,{external_id:j.id||j.slug,title:j.title,company:j.company_name,description:j.description,location:j.candidate_required_location||j.location,location_restriction:j.candidate_required_location,workplace:source.provider==='remotive'||j.remote===true?'remote':'unknown',employment_type:source.provider==='remotive'?j.job_type?.replaceAll('_','-'):(j.job_types||[]).join(', '),skills:[],apply_url:j.url,posted_at:j.publication_date||(j.created_at?new Date(j.created_at*1000).toISOString():null)}));
}
export function smartJob(source,j){const loc=j.location||{},description=Object.values(j.jobAd?.sections||{}).map(s=>(s.title||'')+'\n'+(s.text||'')).join('\n\n');return normalizedJob(source,{external_id:j.id,title:j.name,company:j.company?.name,description,location:loc.fullLocation||[loc.city,loc.region,loc.country].filter(Boolean).join(', '),workplace:loc.remote?'remote':loc.hybrid?'hybrid':'unknown',employment_type:j.typeOfEmployment?.label,apply_url:j.applyUrl||`https://jobs.smartrecruiters.com/${source.board}/${j.id}`,posted_at:j.releasedDate});}

async function get(source,url,context){
 const remote=new URL(url);if(remote.protocol!=='https:'||remote.origin!==new URL(source.url).origin)throw new Error('Source origin changed.');
 const response=await context.fetch(url,{headers:{'User-Agent':'ApplyBurst/0.3 read-only research'},signal:context.signal,redirect:'error'});if(!response.ok)throw new Error(`HTTP ${response.status}`);
 if(Number(response.headers.get('content-length')||0)>30_000_000)throw new Error('Source exceeds 30MB budget.');
 const chunks=[];let size=0;for await(const chunk of response.body){size+=chunk.length;if(size>30_000_000)throw new Error('Source exceeds 30MB budget.');chunks.push(chunk);}const raw=Buffer.concat(chunks),digest=hash(raw);
 if(context.snapshotDir){const folder=join(context.snapshotDir,hash(source.id).slice(0,16));mkdirSync(folder,{recursive:true});writeFileSync(join(folder,digest+'.gz'),gzipSync(raw));}
 return{raw,text:raw.toString('utf8'),bytes:size,digest};
}
export function uniquePostings(jobs){const found=new Map();for(const job of jobs){const previous=found.get(job.id);if(previous&&(previous.title!==job.title||previous.company!==job.company))throw new Error('Conflicting source posting identity.');if(!previous)found.set(job.id,job);}return [...found.values()];}
// Workday's public career-site API: POST, 20 postings per page. Large tenants are read up to maxPages and
// reported incomplete, so jobs missing from a partial read are never closed.
// 50 pages x 20 = up to 1,000 postings per tenant (large employers were truncated at 200).
async function scrapeWorkday(source,{fetch:fetchImpl,signal,maxPages=50}){
 const w=workdayParts(source.board),jobs=[];let offset=0,total=null,requests=0;
 while(requests<maxPages){
  const response=await fetchImpl(source.url,{method:'POST',headers:{'Content-Type':'application/json','Accept':'application/json','User-Agent':'ApplyBurst/0.3 read-only research'},body:JSON.stringify({appliedFacets:{},limit:20,offset,searchText:''}),signal,redirect:'error'});requests++;
  if(!response.ok)throw new Error(`HTTP ${response.status}`);
  // Only the first page carries the real total; later pages report 0.
  const payload=await response.json();if(offset===0)total=Number(payload.total||0);
  for(const p of payload.jobPostings||[]){if(!p.externalPath||!p.title)continue;const days=/(\d+)\+? days? ago/i.exec(p.postedOn||'')?.[1],posted=/today/i.test(p.postedOn||'')?0:/yesterday/i.test(p.postedOn||'')?1:days!=null?Number(days):null;
   try{jobs.push(normalizedJob(source,{external_id:p.externalPath.split('/').pop(),title:p.title,company:source.company||w.tenant,description:'',location:p.locationsText||'',apply_url:`${w.origin}/en-US/${w.site}${p.externalPath}`,posted_at:posted==null?null:new Date(Date.now()-posted*86400000).toISOString()}));}catch{}}
  offset+=20;if(!(payload.jobPostings||[]).length||offset>=total)break;
 }
 return{jobs,complete:total!=null&&jobs.length>=total,total,requests};
}
export function parseBambooHR(source,payload){
 if(!Array.isArray(payload?.result))throw new Error('Invalid BambooHR feed.');
 return payload.result.map(j=>normalizedJob(source,{external_id:j.id,title:j.jobOpeningName,company:source.company||source.board,description:'',location:[j.location?.city,j.location?.state,j.location?.country].filter(Boolean).join(', ')||(j.isRemote?'Remote':''),workplace:j.isRemote?'remote':'unknown',employment_type:j.employmentStatusLabel,apply_url:`https://${source.board}.bamboohr.com/careers/${encodeURIComponent(j.id)}`}));
}
export async function scrapeSource(source,{fetch:fetchImpl=fetch,snapshotDir,timeoutMs=45000}={}){
 if(source.provider==='workday'){const tick=performance.now(),result=await scrapeWorkday(source,{fetch:fetchImpl,signal:AbortSignal.timeout(timeoutMs)});const jobs=result.jobs.map(j=>decorate({...j,source_id:source.id,source_kind:'ats'}));return{jobs,complete:result.complete,report:{outcome:'ok',count:jobs.length,total:result.total,requests:result.requests,elapsed_ms:performance.now()-tick}};}
 const tick=performance.now(),context={fetch:fetchImpl,snapshotDir,signal:AbortSignal.timeout(timeoutMs)},first=await get(source,source.url,context);let jobs,complete=false,total=null,requests=1;
 if(['greenhouse','lever','ashby'].includes(source.provider)){jobs=normalizeFeed(source.provider,source.board,source.company,JSON.parse(first.text)).map(j=>decorate({...j,source_id:source.id,source_kind:'ats'}));complete=true;}
 else if(source.provider==='workable'){jobs=parseWorkable(source,JSON.parse(first.text));complete=true;}
 else if(source.provider==='bamboohr'){jobs=parseBambooHR(source,JSON.parse(first.text)).map(j=>decorate({...j,source_id:source.id,source_kind:'ats'}));complete=true;}
 else if(source.provider==='personio'){jobs=parsePersonio(source,first.text);complete=true;}
 else if(source.kind==='rss')jobs=parseRSS(source,first.text);
 else if(source.kind==='html-jsonld'){jobs=parseJSONLD(source,first.text);complete=true;}
 else if(source.provider==='python'){
  const links=[...new Set([...first.text.matchAll(/href="(\/jobs\/\d+\/)"/g)].map(m=>new URL(m[1],source.url).href))].slice(0,source.max_jobs||20);if(!links.length)throw new Error('Python.org listing markup changed.');jobs=[];const queue=[...links];
  async function hydrate(){while(queue.length){const url=queue.shift(),page=await get(source,url,context);requests++;jobs.push(parsePythonJob(source,page.text,url));}}await Promise.all([hydrate(),hydrate()]);complete=false;
 }
 else if(source.kind==='aggregator'){
  let payload=JSON.parse(first.text);jobs=parseAggregator(source,payload);complete=source.provider==='remotive';let pages=1;
  while(source.provider==='arbeitnow'&&payload.links?.next&&pages<(source.max_pages||1)){const next=await get(source,payload.links.next,context);payload=JSON.parse(next.text);jobs.push(...parseAggregator(source,payload));pages++;requests++;}if(source.provider==='arbeitnow')complete=!payload.links?.next;
 }else if(source.provider==='smartrecruiters'){
  const payload=JSON.parse(first.text),rows=payload.content;if(!Array.isArray(rows))throw new Error('Invalid SmartRecruiters list.');total=payload.totalFound;jobs=[];const queue=rows.slice(0,source.max_jobs||40);complete=total<=queue.length;
  async function hydrate(){while(queue.length){const row=queue.shift(),detail=await get(source,`https://api.smartrecruiters.com/v1/companies/${source.board}/postings/${encodeURIComponent(row.id)}`,context);requests++;jobs.push(smartJob(source,JSON.parse(detail.text)));}}await Promise.all([hydrate(),hydrate(),hydrate()]);
 }else throw new Error('Unsupported source adapter.');
 const unique=uniquePostings(jobs);return{jobs:unique,complete,report:{outcome:complete?'indexed':'partial_sample',url:source.url,elapsed_ms:performance.now()-tick,bytes:first.bytes,response_hash:first.digest,requests,total_available:total,duplicate_entries_removed:jobs.length-unique.length,provider_delay_hours:source.provider_delay_hours||0}};
}
export async function refreshSources(store,sources,{fetch:fetchImpl=fetch,snapshotDir,force=false}={}){
 const tick=performance.now(),queue=[...sources],reports=[];
 async function worker(){while(queue.length){const source=queue.shift(),state=store.state(source.id);if(!force&&state?.observed_at&&Date.now()/1000-state.observed_at<(source.ttl_seconds||900)){reports.push({...state,outcome:'cached',source_id:source.id});continue;}
  try{const result=await scrapeSource(source,{fetch:fetchImpl,snapshotDir});store.replaceSource(source,result.jobs,result);reports.push(store.state(source.id));}
  catch(error){const report={...state,id:source.id,kind:source.kind,provider:source.provider,board:source.board,outcome:'failed',error:error.message,last_attempt_at:Date.now()/1000,retained_jobs:store.db.prepare('SELECT count(*) n FROM jobs WHERE source_id=? AND active=1').get(source.id).n};store.saveState(source.id,report);reports.push(report);}
 }}await Promise.all([worker(),worker(),worker()]);return{utc:new Date().toISOString(),elapsed_ms:performance.now()-tick,sources:reports,stats:store.stats()};
}
