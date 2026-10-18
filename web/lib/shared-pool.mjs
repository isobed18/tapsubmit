// Local app <-> shared job pool on tapsubmit.com. Both directions are optional and off by default:
// - download: the public pool export becomes a read-only local index searched next to your own pool;
// - share: after a search, public posting fields of found jobs are sent (never CV, answers, accounts).
import {createWriteStream,existsSync,mkdirSync,renameSync,rmSync,statSync} from 'node:fs';
import {join} from 'node:path';
import {Readable} from 'node:stream';
import {pipeline} from 'node:stream/promises';
import {PublicPool,buildPoolIndex} from './public-pool.mjs';
const ORIGIN=process.env.APPLYBURST_POOL_ORIGIN||'https://tapsubmit.com';
function publicURL(value){try{const u=new URL(String(value));if(u.protocol!=='https:'||u.username||u.password||!u.hostname.includes('.')||/(?:^|\.)(?:localhost|local|test|internal)$/.test(u.hostname)||/\/(?:candidate|applicant|login|signin|apply\/.*session)(?:\/|$)/i.test(u.pathname))return null;u.hash='';return u.href;}catch{return null;}}
export class SharedPool{
 constructor({store,directory,fetchImpl=fetch}){
  this.store=store;this.dir=join(directory,'shared-pool');this.fetch=fetchImpl;this.state={state:'idle'};
  this.pool=existsSync(join(this.dir,'pool.sqlite'))?new PublicPool(join(this.dir,'pool.sqlite'),join(this.dir,'manifest.json')):null;
 }
 settings(){return{share:false,use_pool:false,...(this.store.setting('shared_pool')||{})};}
 configure(input){const next={...this.settings()};if(typeof input.share==='boolean')next.share=input.share;if(typeof input.use_pool==='boolean')next.use_pool=input.use_pool;this.store.setting('shared_pool',next);return next;}
 // Search wrapper: when the downloaded pool is enabled, company-site searches include it.
 attach(search,store){
  const own=store.getJob.bind(store),self=this;store.getJob=id=>own(id)||(self.active()?self.pool.get(id):null);
  return new Proxy(search,{get(target,key){
   if(key==='query')return async(query,filters,limit)=>{const a=await target.query(query,filters,limit);if(!self.active())return a;const b=await self.pool.query(query,filters,limit),seen=new Set(a.results.map(r=>r.id));return{...a,results:[...a.results,...b.results.filter(r=>!seen.has(r.id))].slice(0,limit),total:a.total+b.total};};
   const value=target[key];return typeof value==='function'?value.bind(target):value;}});
 }
 active(){return !!this.pool?.db&&this.settings().use_pool;}
 async status(){
  let remote=null;try{const r=await this.fetch(ORIGIN+'/api/public/pool/stats',{signal:AbortSignal.timeout(4000)});if(r.ok)remote=await r.json();}catch{}
  return{...this.settings(),origin:ORIGIN,remote,local:this.pool?.db?this.pool.stats():null,download:this.state};
 }
 download(){
  if(['downloading','indexing'].includes(this.state.state))return this.state;
  this.state={state:'downloading',started_at:Date.now()};
  (async()=>{try{
   mkdirSync(this.dir,{recursive:true});const gz=join(this.dir,'jobs.jsonl.gz.part');
   const response=await this.fetch(ORIGIN+'/download/jobs.jsonl.gz',{signal:AbortSignal.timeout(30*60000)});if(!response.ok)throw Error('The shared pool is not available right now.');
   this.state.bytes=Number(response.headers.get('content-length'))||null;await pipeline(Readable.fromWeb(response.body),createWriteStream(gz));
   const manifest=await this.fetch(ORIGIN+'/download/jobs-manifest.json').then(r=>r.ok?r.text():'{}').catch(()=>'{}');
   this.state.state='indexing';renameSync(gz,join(this.dir,'jobs.jsonl.gz'));
   const {writeFileSync}=await import('node:fs');writeFileSync(join(this.dir,'manifest.json'),manifest);
   this.pool?.db?.close();this.pool=null;const target=join(this.dir,'pool.sqlite'),tmp=target+'.part';
   const result=await buildPoolIndex(join(this.dir,'jobs.jsonl.gz'),tmp);if(existsSync(target))rmSync(target);renameSync(tmp,target);rmSync(join(this.dir,'jobs.jsonl.gz'));
   this.pool=new PublicPool(target,join(this.dir,'manifest.json'));this.configure({use_pool:true});
   this.state={state:'ready',records:result.records,bytes:statSync(target).size,finished_at:Date.now()};
  }catch(error){this.state={state:'failed',error:String(error.message||error).slice(0,200)};}})();
  return this.state;
 }
 // Sends only public posting fields of jobs that came from public sources, in small batches.
 async share(jobs){
  if(!this.settings().share)return{shared:0};
  const rows=[];for(const job of jobs){const url=publicURL(job.destination_url||job.apply_url||job.listing_url);if(!url||!job.title)continue;rows.push({id:job.id,title:job.title,company:job.company||'',location:job.location||'',workplace:job.workplace||null,url,provider:job.provider});}
  let shared=0;for(let i=0;i<rows.length;i+=200){try{const r=await this.fetch(ORIGIN+'/api/public/pool/contribute',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({consent:true,jobs:rows.slice(i,i+200)}),signal:AbortSignal.timeout(15000)});if(r.ok)shared+=(await r.json()).contributed||0;}catch{}}
  this.store.setting('shared_pool_last',{at:Date.now(),shared});return{shared};
 }
}
