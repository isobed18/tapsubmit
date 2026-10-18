// Service credential is accepted only on hidden stdin and sent to this Site.
import assert from 'node:assert/strict';
import {writeFileSync} from 'node:fs';
import {SearchEngine} from '../demo/public/search-engine.mjs';
import {ANSWERS,RESUME,sha256} from '../demo/lib/sandbox.mjs';

const origin='https://applyburst.decentbard5.chatgpt.site';
const input=await new Promise((resolve,reject)=>{
 let value='';const terminal=process.stdin.isTTY;
 const finish=()=>{process.stdin.removeListener('data',data);process.stdin.removeListener('end',end);if(terminal)process.stdin.setRawMode(false);process.stdin.pause();try{resolve(JSON.parse(value));}catch{reject(new Error('Expected one JSON input.'));}};
 const data=chunk=>{value+=chunk;if(value.length>65536)reject(new Error('Input too large.'));else if(/[\r\n]/.test(value))finish();};const end=()=>finish();
 if(terminal)process.stdin.setRawMode(true);process.stdin.setEncoding('utf8');process.stdin.on('data',data);process.stdin.once('end',end);process.stdin.resume();console.log('Ready for service-access JSON on stdin (input hidden).');
});
if(typeof input.token!=='string'||!input.token||/[\r\n]/.test(input.token))throw new Error('Service credential missing.');
async function request(path,options={}){
 const url=new URL(path,origin);assert.equal(url.origin,origin);
 const response=await fetch(url,{...options,headers:{'OAI-Sites-Authorization':'Bearer '+input.token},signal:AbortSignal.timeout(40000)});
 assert.equal(new URL(response.url).origin,origin);return response;
}
const begin=performance.now(),response=await request('/api/catalog');assert.equal(response.status,200);const catalog=await response.json();const engine=new SearchEngine(catalog);const query='skill:python AND (backend OR "distributed systems") NOT level:senior';const found=engine.search(query);assert.ok(found.total>=50);const jobs=found.results.slice(0,50);assert.equal(jobs.length,50);assert.equal(new Set(jobs.map(j=>j.canonical_id||j.id)).size,50);const bootstrapMs=performance.now()-begin;
const runId=crypto.randomUUID(),hash=await sha256(RESUME),receipts=[],queue=[...jobs],start=performance.now();
async function submit(job,{missing=false,resume=RESUME,id=job.id}={}){
 const form=new FormData();form.set('run_id',runId);form.set('job_id',id);for(const [key,value]of Object.entries(ANSWERS))if(!missing||key!=='email')form.set(key,value);form.set('resume',new Blob([resume]),'synthetic-resume.txt');return request('/api/sandbox/apply',{method:'POST',body:form});
}
async function execute(){while(queue.length){const job=queue.shift(),r=await submit(job);assert.equal(r.status,200);const receipt=await r.json();assert.equal(receipt.job_id,job.id);assert.equal(receipt.resume_sha256,hash);assert.equal(receipt.fields_verified,6);assert.equal(receipt.state,'confirmed_sandbox');receipts.push(receipt);}}
await Promise.all(Array.from({length:5},execute));const submissionSeconds=(performance.now()-start)/1000;
const reread=await request('/api/sandbox/receipts?run_id='+runId);assert.equal(reread.status,200);const stored=await reread.json();assert.equal(stored.count,50);assert.equal(new Set(stored.receipts.map(r=>r.job_id)).size,50);for(const r of stored.receipts)assert.ok(receipts.some(s=>r.job_id===s.job_id&&r.receipt_id===s.receipt_id&&r.resume_sha256===hash&&r.state==='confirmed_sandbox'));
const elapsedSeconds=(performance.now()-start)/1000;
const replay=await submit(jobs[0]);assert.equal(replay.status,200);assert.equal((await replay.json()).receipt_id,receipts.find(r=>r.job_id===jobs[0].id).receipt_id);
assert.equal((await submit(jobs[0],{resume:'corrupt bytes'})).status,422);assert.equal((await submit(jobs[0],{missing:true})).status,422);assert.equal((await submit(jobs[0],{id:'unknown:board:1'})).status,400);
const inspect=await request('/api/form-schema?job_id='+encodeURIComponent('greenhouse:stripe:8198280'));assert.equal(inspect.status,200);const schema=await inspect.json();assert.equal(schema.automatic_submission_verified,false);
const refreshStart=performance.now(),refresh=await request('/api/catalog',{method:'POST'});assert.equal(refresh.status,200);const refreshed=await refresh.json();assert.ok(refreshed.jobs.length>0);
const report={utc:new Date().toISOString(),origin,scope:'Hosted HTTPS API with supported private service access; Node desktop client; not browser or employer submissions',catalog_postings:catalog.jobs.length,unique_opportunities:new Set(catalog.jobs.map(j=>j.canonical_id||j.id)).size,query,query_matches:found.total,bootstrap_and_index_ms:bootstrapMs,query_ms:found.query_ms,run_id:runId,concurrency:5,confirmed:receipts.length,persisted:stored.count,unknown:0,receiver_verified:true,resume_bytes:receipts[0].resume_bytes,elapsed_seconds:elapsedSeconds,submission_seconds:submissionSeconds,verification_seconds:elapsedSeconds-submissionSeconds,checks:['50 unique selected opportunities','50 verified uploaded SHA-256 receipts','Independent D1 reread and identity/hash comparison','Replay preserves receipt identity','Corrupt resume rejected','Missing answer rejected','Unknown board rejected'],form_inspection:{required_groups:schema.required_groups,unresolved_required_groups:schema.unresolved_required_groups,automatic_submission_verified:false},refresh:{elapsed_ms:performance.now()-refreshStart,coverage:refreshed.coverage,sources:refreshed.sources},receipts};
writeFileSync(process.argv[2]||'reports/hosted-demo-v2.json',JSON.stringify(report,null,2));console.log(JSON.stringify({...report,receipts:undefined,refresh:{...report.refresh,sources:undefined}}));
