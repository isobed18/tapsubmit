import {DatabaseSync} from 'node:sqlite';
import {mkdirSync} from 'node:fs';
import {dirname} from 'node:path';
import {chunkJob,contentHash} from './jobs.mjs';
import {JobPool} from './job-pool.mjs';
import {registerTokenizer} from './indexed-search.mjs';

export class Store{
 constructor(filename){this.revision=0;if(filename!==':memory:')mkdirSync(dirname(filename),{recursive:true});this.db=new DatabaseSync(filename);this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
 CREATE TABLE IF NOT EXISTS jobs(id TEXT PRIMARY KEY,canonical_id TEXT NOT NULL,source_id TEXT NOT NULL,content_hash TEXT NOT NULL,payload TEXT NOT NULL,active INTEGER NOT NULL DEFAULT 1,first_seen REAL NOT NULL,last_seen REAL NOT NULL);
 CREATE INDEX IF NOT EXISTS jobs_source ON jobs(source_id,active);
 CREATE TABLE IF NOT EXISTS source_state(id TEXT PRIMARY KEY,state TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS job_chunks(id TEXT PRIMARY KEY,job_id TEXT NOT NULL REFERENCES jobs(id),content_hash TEXT NOT NULL,ordinal INTEGER NOT NULL,text TEXT NOT NULL);
 CREATE INDEX IF NOT EXISTS chunks_job ON job_chunks(job_id);
 CREATE TABLE IF NOT EXISTS index_events(seq INTEGER PRIMARY KEY AUTOINCREMENT,job_id TEXT NOT NULL,content_hash TEXT NOT NULL,kind TEXT NOT NULL,created_at REAL NOT NULL);
 CREATE TABLE IF NOT EXISTS sessions(token_hash TEXT PRIMARY KEY,csrf TEXT NOT NULL,expires REAL NOT NULL);
 CREATE TABLE IF NOT EXISTS receipts(key TEXT PRIMARY KEY,run_id TEXT NOT NULL,job_id TEXT NOT NULL,payload_hash TEXT NOT NULL,payload TEXT NOT NULL,created_at REAL NOT NULL);
 CREATE INDEX IF NOT EXISTS receipts_run ON receipts(run_id);
 CREATE TABLE IF NOT EXISTS private_settings(key TEXT PRIMARY KEY,value TEXT NOT NULL);`);
 registerTokenizer(this.db);this.pool=new JobPool(this.db);if(!this.setting('job_pool_storage_v1')){this.pool.backfill();this.setting('job_pool_storage_v1',true);}}
 state(id){return JSON.parse(this.db.prepare('SELECT state FROM source_state WHERE id=?').get(id)?.state||'null');}
 saveState(id,state){this.db.prepare('INSERT OR REPLACE INTO source_state VALUES(?,?)').run(id,JSON.stringify(state));}
 replaceSource(source,jobs,{complete=false,report={}}={}){
  const now=Date.now()/1000,ids=new Set(),upsert=this.db.prepare(`INSERT INTO jobs VALUES(?,?,?,?,?,1,?,?) ON CONFLICT(id) DO UPDATE SET canonical_id=excluded.canonical_id,source_id=excluded.source_id,content_hash=excluded.content_hash,payload=excluded.payload,active=1,last_seen=excluded.last_seen`);let changed=0,closed=0;
  this.db.exec('BEGIN');try{
   for(const job of jobs){if(ids.has(job.id))throw new Error('Duplicate posting in source snapshot.');ids.add(job.id);const old=this.db.prepare('SELECT content_hash,active FROM jobs WHERE id=?').get(job.id),revision=contentHash(job);upsert.run(job.id,job.canonical_id||job.id,source.id,revision,JSON.stringify(job),now,job.seen_at||now);
    this.pool.observe(job,job.seen_at||now);
    if(!old||old.content_hash!==revision||!old.active){changed++;this.db.prepare('DELETE FROM job_chunks WHERE job_id=?').run(job.id);for(const chunk of chunkJob(job))this.db.prepare('INSERT INTO job_chunks VALUES(?,?,?,?,?)').run(chunk.id,job.id,revision,chunk.ordinal,chunk.text);this.db.prepare('INSERT INTO index_events(job_id,content_hash,kind,created_at) VALUES(?,?,?,?)').run(job.id,revision,'upsert',now);}
   }
   if(complete)for(const old of this.db.prepare('SELECT id,content_hash FROM jobs WHERE source_id=? AND active=1').all(source.id)){if(!ids.has(old.id)){this.db.prepare('UPDATE jobs SET active=0 WHERE id=?').run(old.id);this.db.prepare('DELETE FROM job_chunks WHERE job_id=?').run(old.id);this.db.prepare('INSERT INTO index_events(job_id,content_hash,kind,created_at) VALUES(?,?,?,?)').run(old.id,old.content_hash,'delete',now);closed++;}}
   const previous=this.state(source.id)||{},lastFailure=previous.error?{error:previous.error,at:previous.last_attempt_at}:previous.last_failure;
   const {error,last_attempt_at,retained_jobs,...history}=previous;
   this.saveState(source.id,{...history,...report,...(lastFailure?{last_failure:lastFailure}:{}),id:source.id,kind:source.kind,provider:source.provider,board:source.board,jobs:jobs.length,complete,observed_at:now,changed,closed});this.db.exec('COMMIT');this.revision++;return{changed,closed};
  }catch(error){this.db.exec('ROLLBACK');throw error;}
 }
 catalog(){const jobs=this.db.prepare('SELECT payload,last_seen,first_seen FROM jobs WHERE active=1 ORDER BY id').all().map(r=>({...JSON.parse(r.payload),seen_at:r.last_seen,first_seen_at:r.first_seen}));return{schema_version:3,generated_at:Date.now()/1000,jobs};}
 getJob(id){const row=this.db.prepare('SELECT payload,last_seen FROM jobs WHERE id=? AND active=1').get(id);return row?{...JSON.parse(row.payload),seen_at:row.last_seen}:null;}
 stats(){return{postings:this.db.prepare('SELECT count(*) n FROM jobs WHERE active=1').get().n,opportunities:this.db.prepare('SELECT count(DISTINCT canonical_id) n FROM jobs WHERE active=1').get().n,chunks:this.db.prepare('SELECT count(*) n FROM job_chunks').get().n,index_events:this.db.prepare('SELECT count(*) n FROM index_events').get().n,embedding_models:0,sources:this.db.prepare('SELECT state FROM source_state ORDER BY id').all().map(r=>JSON.parse(r.state))};}
 // Small facts learned later (for example the employer form behind a LinkedIn listing). Not a content revision.
 patchJob(id,fields){const row=this.db.prepare('SELECT payload,last_seen FROM jobs WHERE id=?').get(id);if(!row)return null;const job={...JSON.parse(row.payload),...fields};this.db.exec('BEGIN');try{this.db.prepare('UPDATE jobs SET payload=? WHERE id=?').run(JSON.stringify(job),id);this.pool.observe(job,row.last_seen);this.db.exec('COMMIT');}catch(error){this.db.exec('ROLLBACK');throw error;}this.revision++;return job;}
 ingestCommunityJobs(jobs){
  const now=Date.now()/1000,ids=new Set(),upsert=this.db.prepare(`INSERT INTO jobs VALUES(?,?,?,?,?,1,?,?) ON CONFLICT(id) DO UPDATE SET canonical_id=excluded.canonical_id,source_id=excluded.source_id,content_hash=excluded.content_hash,payload=excluded.payload,active=1,last_seen=excluded.last_seen`);let added=0;
  this.db.exec('BEGIN');try{
   for(const job of jobs){
    if(!job?.id||!job?.title||ids.has(job.id))continue;
    ids.add(job.id);
    const id=String(job.id).slice(0,200),canonical_id=String(job.canonical_id||job.id).slice(0,200),source_id=String(job.source_id||job.provider||job.source||'community').slice(0,60);
    const old=this.db.prepare('SELECT content_hash,active FROM jobs WHERE id=?').get(id),revision=contentHash(job);
    upsert.run(id,canonical_id,source_id,revision,JSON.stringify(job),now,job.seen_at||now);
    this.pool.observe(job,job.seen_at||now);
    if(!old||old.content_hash!==revision||!old.active){
     added++;this.db.prepare('DELETE FROM job_chunks WHERE job_id=?').run(id);
     for(const chunk of chunkJob(job))this.db.prepare('INSERT INTO job_chunks VALUES(?,?,?,?,?)').run(chunk.id,id,revision,chunk.ordinal,chunk.text);
     this.db.prepare('INSERT INTO index_events(job_id,content_hash,kind,created_at) VALUES(?,?,?,?)').run(id,revision,'upsert',now);
    }
   }
   this.db.exec('COMMIT');this.revision++;return added;
  }catch(error){this.db.exec('ROLLBACK');throw error;}
 }
 setting(key,value){if(value!==undefined)this.db.prepare('INSERT OR REPLACE INTO private_settings VALUES(?,?)').run(key,JSON.stringify(value));return JSON.parse(this.db.prepare('SELECT value FROM private_settings WHERE key=?').get(key)?.value||'null');}
 close(){this.db.close();}
}
