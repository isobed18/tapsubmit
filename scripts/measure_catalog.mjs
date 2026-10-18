// Read-only pool/index audit against the already recorded discovery run. No CV or cookies exported.
import {DatabaseSync} from 'node:sqlite';
import {readFileSync,writeFileSync,createReadStream} from 'node:fs';
import {createHash} from 'node:crypto';
import {createGunzip} from 'node:zlib';
import {createInterface} from 'node:readline';
import {join} from 'node:path';
import {IndexedSearch} from '../web/lib/indexed-search.mjs';
import {postingIdentity} from '../web/lib/job-pool.mjs';
import {hash} from '../web/lib/jobs.mjs';
import {simpleQuery} from '../web/lib/profile.mjs';
import {Discovery} from '../web/lib/discovery.mjs';

const db=new DatabaseSync('.data/desktop-live/portal.sqlite',{readOnly:true});
db.exec('PRAGMA busy_timeout=5000; BEGIN');
const ats=['greenhouse','lever','ashby','workable','smartrecruiters','personio','bamboohr','workday'];
const setting=key=>JSON.parse(db.prepare('SELECT value FROM private_settings WHERE key=?').get(key)?.value||'null');
const run=setting('last_discovery');
const report={at:new Date().toISOString(),read_only:true,no_real_submissions:true,
 pool:{active:db.prepare('SELECT count(*) n FROM jobs WHERE active=1').get().n,indexed:db.prepare('SELECT count(*) n FROM public_job_fts').get().n,providers:db.prepare("SELECT json_extract(payload,'$.provider') provider,count(*) jobs FROM jobs WHERE active=1 GROUP BY provider").all(),boards:db.prepare('SELECT provider,status,count(*) boards FROM ats_boards GROUP BY provider,status').all()},
 discovery:{started_at:run?.started_at,finished_at:run?.finished_at,sources:[],unique_found:0,external_source_unique:0,external_source_ats_overlap:0,ats_destination_overlap:0,ats_overlap_definition:'Exact canonical application URL shared with an active ATS posting. external_source_* excludes the company-board search itself. Lower bound: unresolved aggregator links do not match until opened.'},fts:[],persistence:{}};
const bySite=new Map(),ids=new Set();
for(const row of run?.rows||[]){let entry=bySite.get(row.site);if(!entry)bySite.set(row.site,entry={source:row.site,rows:0,unique_ids:new Set(),states:{},errors:new Set(),max_seconds:0});entry.rows++;entry.states[row.state]=(entry.states[row.state]||0)+1;entry.max_seconds=Math.max(entry.max_seconds,row.elapsed_seconds||0);if(row.error)entry.errors.add(row.error);for(const id of row.job_ids||[]){ids.add(id);entry.unique_ids.add(id);}}
report.discovery.sources=[...bySite.values()].map(({unique_ids,errors,...s})=>({...s,unique_found:unique_ids.size,errors:[...errors]}));
report.discovery.unique_found=ids.size;
const get=db.prepare('SELECT payload FROM jobs WHERE id=?'),overlap=db.prepare(`SELECT j.id FROM job_pool_members m JOIN jobs j ON j.id=m.job_id AND j.active=1 WHERE m.pool_key=? AND json_extract(j.payload,'$.provider') IN (${ats.map(()=>'?').join(',')}) LIMIT 1`);
for(const id of ids){const row=get.get(id);if(!row)continue;const job=JSON.parse(row.payload),external=!ats.includes(job.provider);if(external)report.discovery.external_source_unique++;try{if(overlap.get(hash(postingIdentity(job.destination_url||job.apply_url)),...ats)){report.discovery.ats_destination_overlap++;if(external)report.discovery.external_source_ats_overlap++;}}catch{}}
for(const query of [...new Set([...(run?.request.match_queries||run?.request.queries||[]),'title:"Logistics Specialist" OR title:"Lojistik"','title:"Registered Nurse" OR title:"Nurse"'])]){
 const result=await IndexedSearch.prototype.query.call({db},simpleQuery(query),{},100);
 report.fts.push({query,total:result.total,returned:result.results.length,ms:Math.round(result.query_ms*100)/100,providers:[...new Set(result.results.map(job=>job.provider))]});
}
// Exercise both older {} and new serialized Map snapshots against the actual ranking path.
if(run){const fakeStore={revision:0,getJob:id=>{const row=get.get(id);return row?JSON.parse(row.payload):null;}},discovery=Object.assign(Object.create(Discovery.prototype),{store:fakeStore});
 for(const [key,semantic]of [['legacy',{}],['serialized',[[ids.values().next().value,{overall:0.1,role:0.1,rival:true}]]]]){try{const result=discovery.ranked({...run,semantic},null);report.persistence[key]={ok:true,scored:result.scored,shown:result.results.length};}catch(error){report.persistence[key]={ok:false,error:error.message};}}
}
db.exec('COMMIT');db.close();

const summary=JSON.parse(readFileSync('.data/public-catalog-export-last.json','utf8')),manifest=JSON.parse(readFileSync(join(summary.output,'manifest.json'),'utf8'));
const allowed=new Set(['id','canonical_id','pool_key','provider','board','external_id','title','company','location','workplace','seniority','employment_type','skills','listing_url','apply_url','destination_url','description_excerpt','description_truncated','posted_at','first_seen','last_seen']);
let lines=0,unexpected=0,checksumFailures=0,invalidURLs=0;
for(const shard of manifest.shards){const path=join(summary.output,shard.file),sha=createHash('sha256');for await(const chunk of createReadStream(path))sha.update(chunk);if(sha.digest('hex')!==shard.sha256)checksumFailures++;
 const reader=createInterface({input:createReadStream(path).pipe(createGunzip()),crlfDelay:Infinity});
 for await(const line of reader){const job=JSON.parse(line);lines++;unexpected+=Object.keys(job).filter(key=>!allowed.has(key)).length;for(const key of ['listing_url','apply_url','destination_url'])if(job[key]&&!/^https:\/\//.test(job[key]))invalidURLs++;}
}
report.export={records:manifest.records,shards:manifest.shards.length,compressed_bytes:manifest.compressed_bytes,elapsed_ms:manifest.elapsed_ms,verified_lines:lines,checksum_failures:checksumFailures,unexpected_fields:unexpected,invalid_urls:invalidURLs,skipped_nonpublic:manifest.skipped_nonpublic,privacy:manifest.privacy};
writeFileSync('reports/catalog-source-comparison.json',JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report,null,2));
