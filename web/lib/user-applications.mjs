import {createHash,randomBytes} from 'node:crypto';
const sha=value=>createHash('sha256').update(typeof value==='string'?value:JSON.stringify(value)).digest('hex');
// Once recorded, ApplyBurst never sends that application again by itself.
export const BLOCKING=new Set(['submitting','unknown_after_submit','confirmed','already_applied','marked_submitted']);
export function destinationKey(url){
 try{const u=new URL(url);let path=u.pathname.replace(/\/(apply|application|thanks|confirmation)\/?$/i,'').replace(/\/+$/,'');
  if(u.hostname.endsWith('linkedin.com')){const id=path.match(/\/jobs\/view\/(?:[^/]*-)?(\d+)/)?.[1]||u.searchParams.get('currentJobId');if(id)path='/jobs/view/'+id;}
  return (u.hostname.replace(/^www\./,'')+path).toLowerCase();}catch{return String(url||'');}
}
// Application state per user. Jobs are shared; what a person applied to is theirs.
export class Applications{
 constructor(db){this.db=db;db.exec(`CREATE TABLE IF NOT EXISTS user_applications(user_id TEXT NOT NULL,job_id TEXT NOT NULL,destination TEXT NOT NULL,state TEXT NOT NULL,plan_hash TEXT,detail TEXT NOT NULL,updated_at REAL NOT NULL,created_at REAL NOT NULL,PRIMARY KEY(user_id,job_id));
  CREATE INDEX IF NOT EXISTS user_applications_destination ON user_applications(user_id,destination);
  CREATE INDEX IF NOT EXISTS user_applications_state ON user_applications(user_id,state);
  CREATE TABLE IF NOT EXISTS user_application_events(seq INTEGER PRIMARY KEY AUTOINCREMENT,user_id TEXT NOT NULL,job_id TEXT NOT NULL,state TEXT NOT NULL,detail TEXT NOT NULL,at REAL NOT NULL);
  CREATE INDEX IF NOT EXISTS user_application_events_user ON user_application_events(user_id,at);`);}
 get(userId,jobId){const row=this.db.prepare('SELECT * FROM user_applications WHERE user_id=? AND job_id=?').get(userId,jobId);return row?{...row,detail:JSON.parse(row.detail)}:null;}
 list(userId,limit=1000){return this.db.prepare('SELECT * FROM user_applications WHERE user_id=? ORDER BY updated_at DESC LIMIT ?').all(userId,limit).map(row=>({...row,detail:JSON.parse(row.detail)}));}
 byState(userId,states){return this.db.prepare(`SELECT * FROM user_applications WHERE user_id=? AND state IN (${states.map(()=>'?').join(',')}) ORDER BY updated_at`).all(userId,...states).map(row=>({...row,detail:JSON.parse(row.detail)}));}
 set(userId,jobId,url,state,detail={}){
  const now=Date.now()/1000,previous=this.get(userId,jobId),plan=detail.plan_hash??previous?.plan_hash??null,merged={...(previous?.detail||{}),...detail};
  this.db.prepare(`INSERT INTO user_applications VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(user_id,job_id) DO UPDATE SET destination=excluded.destination,state=excluded.state,plan_hash=excluded.plan_hash,detail=excluded.detail,updated_at=excluded.updated_at`)
   .run(userId,jobId,destinationKey(url),state,plan,JSON.stringify(merged),now,previous?.created_at||now);
  this.db.prepare('INSERT INTO user_application_events(user_id,job_id,state,detail,at) VALUES(?,?,?,?,?)').run(userId,jobId,state,JSON.stringify(detail).slice(0,20000),now);
  return this.get(userId,jobId);
 }
 // The same employer form reached through LinkedIn, Indeed or a board is one destination.
 blocker(userId,jobId,url){
  const own=this.get(userId,jobId);if(own&&BLOCKING.has(own.state))return own;
  return this.db.prepare(`SELECT * FROM user_applications WHERE user_id=? AND destination=? AND state IN (${[...BLOCKING].map(()=>'?').join(',')}) LIMIT 1`).get(userId,destinationKey(url),...BLOCKING)||null;
 }
 submittedSince(userId,seconds){return this.db.prepare("SELECT count(DISTINCT job_id) n FROM user_application_events WHERE user_id=? AND state='submitting' AND at>=?").get(userId,seconds).n;}
 counts(userId){return Object.fromEntries(this.db.prepare('SELECT state,count(*) n FROM user_applications WHERE user_id=? GROUP BY state').all(userId).map(r=>[r.state,r.n]));}
}
