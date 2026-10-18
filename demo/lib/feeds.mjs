import {BOARDS} from './sandbox.mjs';
import {SKILLS} from './taxonomy.mjs';
export function plainText(value){return String(value||'').replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi,'').replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/<\/?(?:p|div|li|br|h[1-6]|ul)\b[^>]*>/gi,'\n').replace(/<[^>]*>/g,'').replace(/&amp;/g,'&').replace(/&quot;/g,'"').replace(/&#(?:x([a-f0-9]+)|(\d+));/gi,(_,h,d)=>String.fromCodePoint(Number.parseInt(h||d,h?16:10))).replace(/&nbsp;/g,' ').replace(/[^\S\n]+/g,' ').replace(/\n{3,}/g,'\n\n').trim();}
export function enrich(title,description,location,explicit,type){
 const text=title+'\n'+description,skills=Object.entries(SKILLS).filter(([,pattern])=>new RegExp(pattern,'i').test(text)).map(([label])=>label);
 if(/\bGo\b(?=\s*[,/)]|\s+(?:programming|language))|(?:with|in|using|of|and|or)\s+Go\b/.test(text)&&!skills.includes('Go'))skills.push('Go');
 let workplace='unknown',seniority='unknown',employment_type='unknown';const signals={};
 if(['remote','hybrid','onsite','on-site'].includes(String(explicit).toLowerCase())){workplace=String(explicit).toLowerCase().replace('on-site','onsite');signals.workplace={method:'provider_field',text:explicit};}
 else for(const [value,re]of [['hybrid',/hybrid|hibrit/i],['remote',/remote|uzaktan/i],['onsite',/on.?site|in.office|ofisten/i]])if(re.test(location+' '+title)){workplace=value;signals.workplace={method:'location_or_title',text:location+' · '+title};break;}
 for(const [value,re]of [['intern',/\bintern(?:ship)?\b|stajyer|\bstaj\b/i],['lead',/\bstaff\b|\bprincipal\b|\blead\b|\bdirector\b|\bhead\b/i],['senior',/\bsenior\b|\bsr\.?\b|kıdemli/i],['junior',/\bjunior\b|\bjr\.?\b|new.grad|entry.level|graduate/i]])if(re.test(title)){seniority=value;signals.seniority={method:'title_rule',text:title};break;}
 for(const [value,re]of [['intern',/intern|staj/i],['part-time',/part.?time/i],['contract',/contract|temporary|freelance/i],['full-time',/full.?time/i]])if(re.test(type||'')){employment_type=value;signals.employment_type={method:'provider_field',text:type};break;}
 return {skills,workplace,seniority,employment_type,signals};
}
export function feedURL(provider,board){return provider==='greenhouse'?`https://boards-api.greenhouse.io/v1/boards/${board}/jobs?content=true`:provider==='lever'?`https://api.lever.co/v0/postings/${board}?mode=json`:`https://api.ashbyhq.com/posting-api/job-board/${board}`;}
export function normalizeFeed(provider,board,company,payload,seenAt=Date.now()/1000){
 const rows=provider==='lever'?payload:payload.jobs;if(!Array.isArray(rows))throw new Error('Invalid feed schema.');
 return rows.filter(j=>provider==='greenhouse'?j.internal_job_id!=null:provider==='ashby'?j.isListed!==false:true).map(j=>{
  const title=j.title||j.text;let description,location,locations,department,posted_at,explicit,type,salary=null;
  if(provider==='greenhouse'){description=plainText(j.content);location=j.location?.name||'';locations=[location,...(j.offices||[]).map(o=>o.name).filter(Boolean)];department=(j.departments||[]).map(d=>d.name).join(', ');posted_at=j.first_published;}
  else if(provider==='lever'){const c=j.categories||{};description=plainText([j.descriptionPlain||j.description,...(j.lists||[]).map(x=>x.text+'\n'+x.content),j.additionalPlain||j.additional,j.salaryDescriptionPlain].filter(Boolean).join('\n\n'));location=c.location||'';locations=[location,...(Array.isArray(c.allLocations)?c.allLocations:[])];department=c.department||'';posted_at=j.createdAt?String(j.createdAt):null;explicit=j.workplaceType;type=c.commitment;if(j.salaryRange){const s=j.salaryRange;salary={min:s.min,max:s.max,currency:s.currency,period:s.interval,source:'provider_field'};}}
  else{description=plainText(j.descriptionPlain||j.descriptionHtml);location=j.location||'';locations=[location,...(j.secondaryLocations||[]).map(x=>x.location).filter(Boolean)];department=j.department||'';posted_at=j.publishedAt;explicit=j.isRemote?'remote':null;type=j.employmentType;}
  return {id:`${provider}:${board}:${j.id}`,canonical_id:`${provider}:${board}:${provider==='greenhouse'?j.internal_job_id:j.id}`,provider,board,external_id:String(j.id),company,title,description,location,locations:[...new Set(locations)],department,posted_at:posted_at||null,salary,apply_url:j.applyUrl||j.absolute_url,seen_at:seenAt,source_url:feedURL(provider,board),...enrich(title,description,location,explicit,type)};
 });
}
export async function refreshCatalog(previous){
 const start=performance.now(),queue=[...BOARDS],results=[],byBoard=new Map(),overall=AbortSignal.timeout(25000);
 for(const job of previous?.jobs||[]){const key=job.provider+':'+job.board;if(!byBoard.has(key))byBoard.set(key,[]);byBoard.get(key).push(job);}
 async function worker(){while(queue.length){const [provider,board,company]=queue.shift(),url=feedURL(provider,board),tick=performance.now();try{
   const response=await fetch(url,{signal:AbortSignal.any([overall,AbortSignal.timeout(18000)]),headers:{'User-Agent':'ApplyBurst/0.2 read-only research'}});
   if(!response.ok)throw new Error(`HTTP ${response.status}`);
   const payload=await response.json(),jobs=normalizeFeed(provider,board,company,payload);byBoard.set(provider+':'+board,jobs);
   results.push({provider,board,url,status:response.status,jobs:jobs.length,outcome:'indexed',elapsed_ms:performance.now()-tick});
 }catch(error){results.push({provider,board,url,jobs:0,outcome:'failed',error:error.message,retained_jobs:byBoard.get(provider+':'+board)?.length||0,elapsed_ms:performance.now()-tick});}}}
 await Promise.all([worker(),worker()]);const jobs=[...byBoard.values()].flat();
 if(!jobs.length)throw new Error('No sources returned jobs. The previous index is unchanged.');
 if(!previous&&results.some(r=>r.outcome==='failed'))throw new Error('Live refresh was partial; the bundled catalog remains unchanged. Retry refresh to bootstrap the shared cache.');
 const revision=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(JSON.stringify(jobs)));
 return {schema_version:2,search_revision:[...new Uint8Array(revision)].map(x=>x.toString(16).padStart(2,'0')).join(''),generated_at:Date.now()/1000,jobs,sources:{kind:'live_read_only_discovery',elapsed_ms:performance.now()-start,total_indexed:jobs.length,boards:results},coverage:{jobs:jobs.length,unique_opportunities:new Set(jobs.map(j=>j.canonical_id||j.id)).size,with_description:jobs.filter(j=>j.description).length,with_skills:jobs.filter(j=>j.skills.length).length,workplace_known:jobs.filter(j=>j.workplace!=='unknown').length,seniority_known:jobs.filter(j=>j.seniority!=='unknown').length}};
}
