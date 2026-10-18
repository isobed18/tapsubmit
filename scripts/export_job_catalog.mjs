// Public job metadata only. Never copy the local database, candidate tables or native apply sessions.
import {DatabaseSync} from 'node:sqlite';
import {mkdirSync,writeFileSync,statSync,createWriteStream,createReadStream} from 'node:fs';
import {join,resolve} from 'node:path';
import {createGzip} from 'node:zlib';
import {createHash} from 'node:crypto';
import {once} from 'node:events';
import {finished} from 'node:stream/promises';
const arg=(key,fallback)=>process.argv.find(a=>a.startsWith('--'+key+'='))?.slice(key.length+3)??fallback;
const dbFile=resolve(arg('db','.data/desktop-live/portal.sqlite')),output=resolve(arg('out','.data/public-catalog/'+Date.now())),limit=Number(arg('limit',Infinity)),shardSize=Number(arg('shard-size',25000)),textLimit=Math.max(0,Math.min(20000,Number(arg('description-chars',4000))));
mkdirSync(output,{recursive:true});
const db=new DatabaseSync(dbFile,{readOnly:true});
const started=performance.now(),manifest={schema_version:1,generated_at:new Date().toISOString(),records:0,skipped_private:0,skipped_nonpublic:0,description_excerpt_chars:textLimit,providers:{},shards:[],privacy:'Public posting fields only; no CVs, profiles, cookies, credentials, answers or application history.'};
function publicURL(value){try{const u=new URL(value);if(u.protocol!=='https:'||u.username||u.password||!u.hostname.includes('.')||u.hostname.endsWith('.test'))return null;
 if(/^(smartapply|apply|secure|auth)\.indeed\.com$/.test(u.hostname)||/\/(?:candidate|applicant|profile|login|signin)(?:\/|$)/i.test(u.pathname))return null;
 for(const key of u.searchParams.keys())if(/^(?:access_token|apiToken|csrf|session|sessionId|candidateId|applicantId|authorization)$/i.test(key))return null;
 for(const key of [...u.searchParams.keys()])if(/^utm_|^(gh_src|lever-source|trackingId|trk)$/i.test(key))u.searchParams.delete(key);
 u.hash='';return u.href;}catch{return null;}}
let sensitive=[];
try{const p=JSON.parse(db.prepare("SELECT value FROM private_settings WHERE key='profile'").get()?.value||'null');sensitive=[p?.email,p?.phone,p?.name].filter(v=>typeof v==='string'&&v.length>=8);}catch{}
let zip,file,stream,shardCount=0;
async function closeShard(){if(!zip)return;zip.end();await finished(stream);const hash=createHash('sha256');for await(const chunk of createReadStream(file))hash.update(chunk);manifest.shards.push({file:file.slice(output.length+1),records:shardCount,bytes:statSync(file).size,sha256:hash.digest('hex')});zip=null;}
function openShard(){file=join(output,'jobs-'+String(manifest.shards.length+1).padStart(4,'0')+'.jsonl.gz');zip=createGzip({level:4});stream=createWriteStream(file);zip.pipe(stream);shardCount=0;}
try{
 db.exec('BEGIN');manifest.index_cursor=db.prepare('SELECT coalesce(max(seq),0) n FROM index_events').get().n;
 manifest.active_postings_at_snapshot=db.prepare('SELECT count(*) n FROM jobs WHERE active=1').get().n;
 manifest.indexed_postings_at_snapshot=db.prepare('SELECT count(*) n FROM public_job_fts').get().n;
 for(const row of db.prepare('SELECT j.payload,j.first_seen,j.last_seen,m.pool_key FROM jobs j LEFT JOIN job_pool_members m ON m.job_id=j.id WHERE j.active=1 ORDER BY j.rowid').iterate()){
  if(manifest.records>=limit)break;const j=JSON.parse(row.payload),listing=publicURL(j.listing_url||j.apply_url),destination=publicURL(j.destination_url),apply=publicURL(j.apply_url)||listing;
  if(!listing||!apply){manifest.skipped_nonpublic++;continue;}
  const full=String(j.description||''),job={id:j.id,canonical_id:j.canonical_id||j.id,pool_key:row.pool_key,provider:j.provider,board:j.board||null,external_id:j.external_id||null,title:j.title,company:j.company||'',location:j.location||'',workplace:j.workplace||'unknown',seniority:j.seniority||'unknown',employment_type:j.employment_type||'unknown',skills:j.skills||[],listing_url:listing,apply_url:apply,destination_url:destination,description_excerpt:full.slice(0,textLimit),description_truncated:full.length>textLimit,posted_at:j.posted_at||null,first_seen:row.first_seen,last_seen:row.last_seen};
  const line=JSON.stringify(job)+'\n';if(sensitive.some(value=>line.toLocaleLowerCase().includes(value.toLocaleLowerCase()))){manifest.skipped_private++;continue;}
  if(!zip)openShard();if(!zip.write(line))await once(zip,'drain');shardCount++;manifest.records++;manifest.providers[job.provider]=(manifest.providers[job.provider]||0)+1;
  if(shardCount>=shardSize)await closeShard();
 }
 await closeShard();db.exec('COMMIT');manifest.elapsed_ms=Math.round(performance.now()-started);manifest.compressed_bytes=manifest.shards.reduce((n,s)=>n+s.bytes,0);
 writeFileSync(join(output,'manifest.json'),JSON.stringify(manifest,null,2)+'\n');console.log(JSON.stringify({output,...manifest},null,2));
}finally{db.close();}
