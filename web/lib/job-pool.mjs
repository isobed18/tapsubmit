// Storage only. Source postings retain provenance; this table has one row per destination.
// No CVs, embeddings, similarity queries or shared-profile recommendations live here.
import {hash} from './jobs.mjs';

export function postingIdentity(value){
 const u=new URL(value);if(!['https:','http:'].includes(u.protocol))throw new Error('Invalid posting URL.');
 u.hostname=u.hostname.toLowerCase().replace(/^www\./,'');u.username='';u.password='';
 const host=u.hostname,path=u.pathname.replace(/\/+$/,'');
 if(/(^|\.)greenhouse\.io$/.test(host)){
  const direct=path.match(/^\/([^/]+)\/jobs\/(\d+)$/),board=direct?.[1]||u.searchParams.get('for'),id=direct?.[2]||u.searchParams.get('token')||u.searchParams.get('gh_jid');
  if(board&&id)return 'greenhouse:'+board.toLowerCase()+':'+id;
 }
 if(host==='apply.workable.com'){const id=path.match(/\/(?:j|jobs)\/([a-z0-9]+)/i)?.[1];if(id)return 'workable:'+id.toLowerCase();}
 if(/(^|\.)linkedin\.com$/.test(host)){const id=path.match(/\/jobs\/view\/(?:[^/]*-)?(\d+)/)?.[1];if(id)return 'linkedin:'+id;}
 if(/(^|\.)indeed\.[a-z.]+$/.test(host)){const id=u.searchParams.get('jk')||u.searchParams.get('vjk');if(id)return 'indeed:'+id;}
 if(['jobs.lever.co','jobs.eu.lever.co','jobs.ashbyhq.com'].includes(host))u.pathname=path.replace(/\/(apply|application|thanks|confirmation)$/i,'');
 else u.pathname=path||'/';
 // Keep unrecognized parameters: they can identify different requisitions. Remove only tracking.
 for(const name of [...u.searchParams.keys()])if(/^utm_|^(gh_src|lever-source|trackingId|trk)$/i.test(name))u.searchParams.delete(name);
 u.searchParams.sort();if(!/^#(?:\/|!)/.test(u.hash))u.hash='';
 return u.href;
}

export class JobPool{
 constructor(db){this.db=db;db.exec(`
  CREATE TABLE IF NOT EXISTS job_pool(pool_key TEXT PRIMARY KEY,url TEXT NOT NULL,latest_job_id TEXT NOT NULL REFERENCES jobs(id),first_seen REAL NOT NULL,last_seen REAL NOT NULL);
  CREATE TABLE IF NOT EXISTS job_pool_members(job_id TEXT PRIMARY KEY REFERENCES jobs(id),pool_key TEXT NOT NULL REFERENCES job_pool(pool_key));
  CREATE INDEX IF NOT EXISTS job_pool_members_key ON job_pool_members(pool_key);
 `);}
 observe(job,now){
  const url=job.destination_url||job.apply_url;let identity;try{identity=postingIdentity(url);}catch{return;}
  const key=hash(identity),previous=this.db.prepare('SELECT pool_key FROM job_pool_members WHERE job_id=?').get(job.id)?.pool_key;
  this.db.prepare(`INSERT INTO job_pool VALUES(?,?,?,?,?) ON CONFLICT(pool_key) DO UPDATE SET url=excluded.url,latest_job_id=excluded.latest_job_id,last_seen=excluded.last_seen WHERE excluded.last_seen>=job_pool.last_seen`).run(key,url,job.id,now,now);
  this.db.prepare('INSERT INTO job_pool_members VALUES(?,?) ON CONFLICT(job_id) DO UPDATE SET pool_key=excluded.pool_key').run(job.id,key);
  if(previous&&previous!==key){
   const survivor=this.db.prepare('SELECT m.job_id,j.last_seen FROM job_pool_members m JOIN jobs j ON j.id=m.job_id WHERE m.pool_key=? ORDER BY j.last_seen DESC LIMIT 1').get(previous);
   if(survivor)this.db.prepare('UPDATE job_pool SET latest_job_id=?,last_seen=? WHERE pool_key=?').run(survivor.job_id,survivor.last_seen,previous);
   else this.db.prepare('DELETE FROM job_pool WHERE pool_key=?').run(previous);
  }
 }
 backfill(){this.db.exec('BEGIN');try{for(const row of this.db.prepare('SELECT payload,first_seen,last_seen FROM jobs ORDER BY last_seen').iterate()){const job=JSON.parse(row.payload);this.observe(job,row.last_seen);this.db.prepare('UPDATE job_pool SET first_seen=min(first_seen,?) WHERE pool_key=(SELECT pool_key FROM job_pool_members WHERE job_id=?)').run(row.first_seen,job.id);}this.db.exec('COMMIT');}catch(error){this.db.exec('ROLLBACK');throw error;}}
 stats(){return this.db.prepare(`SELECT count(*) saved_destinations,coalesce(sum(EXISTS(SELECT 1 FROM job_pool_members m JOIN jobs j ON j.id=m.job_id AND j.active=1 WHERE m.pool_key=p.pool_key)),0) active_destinations FROM job_pool p`).get();}
}
