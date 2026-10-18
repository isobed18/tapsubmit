import {scrapeSource,boardURL} from './sources.mjs';
// Employer boards discovered through LinkedIn/Indeed/aggregator links. Indexing a whole board turns one
// search hit into every open job at that company, all on forms that need no login.
export function boardRef(url){
 try{const u=new URL(url),host=u.hostname.toLowerCase(),parts=u.pathname.split('/').filter(Boolean);
  if(/(^|\.)greenhouse\.io$/.test(host)){if(parts[0]==='embed'){const board=u.searchParams.get('for');return board?{provider:'greenhouse',board}:null;}if(parts[0]&&parts[1]==='jobs')return{provider:'greenhouse',board:parts[0]};return null;}
  if(host==='jobs.lever.co'||host==='jobs.eu.lever.co')return parts[0]?{provider:'lever',board:parts[0]}:null;
  if(host==='jobs.ashbyhq.com')return parts[0]&&parts[0]!=='api'?{provider:'ashby',board:parts[0]}:null;
  if(host==='apply.workable.com'&&parts[0]&&parts[0]!=='j'&&parts[0]!=='api')return{provider:'workable',board:parts[0]};
  if(['jobs.smartrecruiters.com','careers.smartrecruiters.com'].includes(host)&&parts[0])return{provider:'smartrecruiters',board:parts[0]};
  if(/^[a-z0-9-]+\.jobs\.personio\.(com|de)$/.test(host))return{provider:'personio',board:host};
 }catch{}return null;
}
const SHORT=/^https:\/\/(grnh\.se|apply\.workable\.com\/j)\//i;
export class Boards{
 constructor({store,search}){this.store=store;this.search=search;this.short=new Map();this.running=null;
  store.db.exec(`CREATE TABLE IF NOT EXISTS ats_boards(provider TEXT NOT NULL,board TEXT NOT NULL,company TEXT,found_from TEXT,added_at REAL NOT NULL,status TEXT NOT NULL,last_refresh REAL,jobs INTEGER,error TEXT,PRIMARY KEY(provider,board));`);}
 add(ref,company,jobId){if(!ref||!/^[-A-Za-z0-9_.]{1,80}$/.test(ref.board))return false;
  // Boards already in the static registry are refreshed by the normal source refresh.
  if(this.store.state(ref.provider+':'+ref.board))return false;
  return this.store.db.prepare("INSERT OR IGNORE INTO ats_boards(provider,board,company,found_from,added_at,status) VALUES(?,?,?,?,?,'new')").run(ref.provider,ref.board,company||null,jobId||null,Date.now()/1000).changes>0;}
 note(jobs){let added=0;for(const job of jobs){const url=job.destination_url||job.apply_url;const ref=boardRef(url);if(ref){if(this.add(ref,job.company,job.id))added++;}else if(url&&SHORT.test(url)&&this.short.size<500)this.short.set(url,{company:job.company,job:job.id});}return added;}
 // Short links redirect to the real board; follow a few hops without downloading pages.
 async resolveShort(limit=25){const items=[...this.short.entries()].slice(0,limit);let added=0;
  await Promise.all(Array.from({length:3},async()=>{while(items.length){const [url,meta]=items.shift();this.short.delete(url);let current=url;
   for(let hop=0;hop<5;hop++){let response;try{response=await fetch(current,{redirect:'manual',signal:AbortSignal.timeout(8000),headers:{'User-Agent':'ApplyBurst/0.4 read-only research'}});}catch{break;}
    const next=response.headers.get('location');if(response.body)try{await response.body.cancel();}catch{}if(!next||response.status<300||response.status>=400)break;current=new URL(next,current).href;if(!/^https:\/\//i.test(current))break;const ref=boardRef(current);if(ref){if(this.add(ref,meta.company,meta.job))added++;this.store.patchJob(meta.job,{destination_url:current});break;}}}}));return added;}
 sources(){return this.store.db.prepare("SELECT * FROM ats_boards WHERE status IN ('indexed','failed')").all().map(row=>({id:row.provider+':'+row.board,kind:'ats',provider:row.provider,board:row.board,company:row.company,url:boardURL(row.provider,row.board),ttl_seconds:21600,harvested:true}));}
 async indexNew(limit=15){
  if(this.running)return this.running;
  this.running=(async()=>{const rows=this.store.db.prepare("SELECT * FROM ats_boards WHERE status='new' ORDER BY added_at LIMIT ?").all(limit);let indexed=0;
   await Promise.all(Array.from({length:3},async()=>{while(rows.length){const row=rows.shift(),source={id:row.provider+':'+row.board,kind:'ats',provider:row.provider,board:row.board,company:row.company,url:boardURL(row.provider,row.board),ttl_seconds:21600};
    try{const result=await scrapeSource(source,{timeoutMs:30000});this.store.replaceSource(source,result.jobs,{complete:result.complete,report:{...result.report,harvested_from:row.found_from}});
     this.store.db.prepare("UPDATE ats_boards SET status='indexed',last_refresh=?,jobs=?,error=NULL WHERE provider=? AND board=?").run(Date.now()/1000,result.jobs.length,row.provider,row.board);indexed++;}
    catch(error){this.store.db.prepare("UPDATE ats_boards SET status='failed',last_refresh=?,error=? WHERE provider=? AND board=?").run(Date.now()/1000,String(error.message).slice(0,300),row.provider,row.board);}}}));
   if(indexed)await this.search.load(this.search.persistent?null:this.store.catalog());return indexed;})().finally(()=>{this.running=null;});
  return this.running;
 }
 stats(){return{boards:this.store.db.prepare('SELECT provider,status,count(*) n,sum(jobs) jobs FROM ats_boards GROUP BY provider,status').all(),pending_short_links:this.short.size,indexing:!!this.running};}
}
