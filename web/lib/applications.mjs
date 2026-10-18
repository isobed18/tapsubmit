import {createHash,randomBytes} from 'node:crypto';
const sha=value=>createHash('sha256').update(typeof value==='string'?value:JSON.stringify(value)).digest('hex');
// Once one of these is recorded, ApplyBurst never sends that application again by itself.
export const BLOCKING=new Set(['submitting','unknown_after_submit','confirmed','already_applied','marked_submitted']);
export const SUBMITTED_LIKE=new Set(['confirmed','already_applied','marked_submitted']);
export function destinationKey(url){
 try{const u=new URL(url);let path=u.pathname.replace(/\/(apply|application|thanks|confirmation)\/?$/i,'').replace(/\/+$/,'');
  // These query parameters identify the job itself; discarding them collapses different jobs.
  if(/(^|\.)greenhouse\.io$/.test(u.hostname)){
   const direct=path.match(/^\/([^/]+)\/jobs\/(\d+)$/),board=direct?.[1]||u.searchParams.get('for'),id=direct?.[2]||u.searchParams.get('token')||u.searchParams.get('gh_jid');
   if(board&&id)return `greenhouse:${board}:${id}`.toLowerCase();
  }
  if(u.hostname==='apply.workable.com'){const id=path.match(/\/(?:j|jobs)\/([a-z0-9]+)/i)?.[1];if(id)return 'workable:'+id.toLowerCase();}
  if(u.hostname.endsWith('linkedin.com')){const id=path.match(/\/jobs\/view\/(?:[^/]*-)?(\d+)/)?.[1];if(id)path='/jobs/view/'+id;}
  const identity=['jk','jobId','job_id','gh_jid','token','requisitionId'].filter(key=>u.searchParams.has(key)).sort().map(key=>key+'='+u.searchParams.get(key)).join('&');
  return (u.hostname.replace(/^www\./,'')+path+(identity?'?'+identity:'')).toLowerCase();}catch{return String(url||'');}
}
export class Applications{
 constructor(db){this.db=db;db.exec(`CREATE TABLE IF NOT EXISTS applications(job_id TEXT PRIMARY KEY,destination TEXT NOT NULL,state TEXT NOT NULL,plan_hash TEXT,detail TEXT NOT NULL,run_id TEXT,updated_at REAL NOT NULL,created_at REAL NOT NULL);
  CREATE INDEX IF NOT EXISTS applications_destination ON applications(destination);
  CREATE TABLE IF NOT EXISTS application_events(seq INTEGER PRIMARY KEY AUTOINCREMENT,job_id TEXT NOT NULL,run_id TEXT,state TEXT NOT NULL,detail TEXT NOT NULL,at REAL NOT NULL);
  CREATE TABLE IF NOT EXISTS review_tokens(token_hash TEXT PRIMARY KEY,binding TEXT NOT NULL,ids TEXT NOT NULL,expires REAL NOT NULL);`);}
 get(jobId){const row=this.db.prepare('SELECT * FROM applications WHERE job_id=?').get(jobId);return row?{...row,detail:JSON.parse(row.detail)}:null;}
 list(){return this.db.prepare('SELECT * FROM applications ORDER BY updated_at DESC LIMIT 500').all().map(row=>({...row,detail:JSON.parse(row.detail)}));}
 events(jobId){return this.db.prepare('SELECT * FROM application_events WHERE job_id=? ORDER BY seq').all(jobId).map(row=>({...row,detail:JSON.parse(row.detail)}));}
 set(jobId,url,state,detail={},runId=null){
  const now=Date.now()/1000,previous=this.get(jobId),plan=detail.plan_hash??previous?.plan_hash??null,merged={...(previous?.detail||{}),...detail};
  this.db.prepare(`INSERT INTO applications VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(job_id) DO UPDATE SET destination=excluded.destination,state=excluded.state,plan_hash=excluded.plan_hash,detail=excluded.detail,run_id=excluded.run_id,updated_at=excluded.updated_at`)
   .run(jobId,destinationKey(url),state,plan,JSON.stringify(merged),runId,now,previous?.created_at||now);
  this.db.prepare('INSERT INTO application_events(job_id,run_id,state,detail,at) VALUES(?,?,?,?,?)').run(jobId,runId,state,JSON.stringify(detail).slice(0,20000),now);
  return this.get(jobId);
 }
 // The same employer form reached through LinkedIn, Indeed or a board is one destination.
 blocker(jobId,url){
  const own=this.get(jobId);if(own&&BLOCKING.has(own.state))return own;
  return this.db.prepare(`SELECT * FROM applications WHERE destination=? AND state IN (${[...BLOCKING].map(()=>'?').join(',')}) LIMIT 1`).get(destinationKey(url),...BLOCKING)||null;
 }
 // After a crash or restart, an attempt that may have reached the final click is unknown, never retried.
 reconcile(activeIds=new Set()){
  const stale=this.db.prepare("SELECT job_id,destination FROM applications WHERE state IN ('submitting','preparing','submit_in_progress')").all().filter(row=>!activeIds.has(row.job_id));
  for(const row of stale){const current=this.get(row.job_id);
   if(current.state==='submitting')this.set(row.job_id,current.detail.url||row.destination,'unknown_after_submit',{note:'The browser stopped after the final click was recorded. Check the website before retrying; ApplyBurst will not resend it.'},current.run_id);
   else this.set(row.job_id,current.detail.url||row.destination,'not_started',{note:'The browser stopped before this application reached the final button. Nothing was submitted.'},current.run_id);}
  return stale.length;
 }
 binding(ids,revisions){return sha({ids,plans:ids.map(id=>this.get(id)?.plan_hash||null),...revisions});}
 createReview(ids,revisions,seconds=600){
  const token=randomBytes(24).toString('base64url');this.db.prepare('DELETE FROM review_tokens WHERE expires<?').run(Date.now()/1000);
  this.db.prepare('INSERT INTO review_tokens VALUES(?,?,?,?)').run(sha(token),this.binding(ids,revisions),JSON.stringify(ids),Date.now()/1000+seconds);return token;
 }
 // Valid only for exactly the reviewed IDs, prepared plans, resume, profile facts and answers.
 consumeReview(token,ids,revisions){
  const row=this.db.prepare('SELECT * FROM review_tokens WHERE token_hash=?').get(sha(String(token||'')));
  if(!row||row.expires<Date.now()/1000)return'This review expired. Review the batch again.';
  if(row.ids!==JSON.stringify(ids)||row.binding!==this.binding(ids,revisions))return'The batch, a prepared form, the resume or an answer changed after review. Review again.';
  this.db.prepare('DELETE FROM review_tokens WHERE token_hash=?').run(row.token_hash);return null;
 }
}
