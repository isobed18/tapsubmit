import {randomBytes,scryptSync,timingSafeEqual,createHash,randomUUID} from 'node:crypto';
import {existsSync,readFileSync} from 'node:fs';
import {join} from 'node:path';
const digest=value=>createHash('sha256').update(value).digest('hex');
export const passwordHash=(password,salt)=>scryptSync(String(password),salt,64,{N:16384,r:8,p:1}).toString('hex');
const LOGIN=/^[a-z0-9._%+@-]{3,120}$/;
// Accounts for everyone: one small table, salted scrypt, hashed session and extension tokens.
export class Users{
 constructor(db,{sessionSeconds=7*86400,maxAttempts=8,windowSeconds=900}={}){this.db=db;this.sessionSeconds=sessionSeconds;this.maxAttempts=maxAttempts;this.windowSeconds=windowSeconds;this.attempts=new Map();
  db.exec(`CREATE TABLE IF NOT EXISTS users(id TEXT PRIMARY KEY,login TEXT NOT NULL UNIQUE,name TEXT,salt TEXT NOT NULL,password_hash TEXT NOT NULL,created_at REAL NOT NULL,role TEXT NOT NULL DEFAULT 'user');
  CREATE TABLE IF NOT EXISTS user_sessions(token_hash TEXT PRIMARY KEY,user_id TEXT NOT NULL,csrf TEXT NOT NULL,expires REAL NOT NULL);
  CREATE TABLE IF NOT EXISTS user_tokens(token_hash TEXT PRIMARY KEY,user_id TEXT NOT NULL,label TEXT,created_at REAL NOT NULL,last_used REAL);
  CREATE TABLE IF NOT EXISTS user_settings(user_id TEXT NOT NULL,key TEXT NOT NULL,value TEXT NOT NULL,PRIMARY KEY(user_id,key));`);}
 // The original single-admin portal becomes the first account, keeping its password.
 migrateAdmin(directory){const file=join(directory,'admin.json');if(!existsSync(file))return null;const admin=JSON.parse(readFileSync(file,'utf8')),login=String(admin.username).toLowerCase();
  const existing=this.db.prepare('SELECT * FROM users WHERE login=?').get(login);if(existing)return existing;const id=randomUUID();
  this.db.prepare("INSERT INTO users VALUES(?,?,?,?,?,?,'admin')").run(id,login,admin.username,admin.salt,admin.password_hash,Date.now()/1000);return this.db.prepare('SELECT * FROM users WHERE id=?').get(id);}
 register(login,password,name=''){
  login=String(login||'').trim().toLowerCase();if(!LOGIN.test(login))throw new Error('Use an email address (or 3–120 letters, digits and . _ - @).');
  if(String(password||'').length<8)throw new Error('Use a password with at least 8 characters.');if(String(password).length>200)throw new Error('That password is too long.');
  if(this.db.prepare('SELECT 1 FROM users WHERE login=?').get(login))throw new Error('An account with this email already exists. Sign in instead.');
  const id=randomUUID(),salt=randomBytes(16).toString('hex');this.db.prepare("INSERT INTO users VALUES(?,?,?,?,?,?,'user')").run(id,login,String(name||'').slice(0,120),salt,passwordHash(password,salt),Date.now()/1000);return id;
 }
 login(login,password,ip){
  const now=Date.now()/1000;for(const [key,value]of this.attempts)if(now-value.start>this.windowSeconds)this.attempts.delete(key);
  const attempt=this.attempts.get(ip)||{start:now,count:0};if(attempt.count>=this.maxAttempts)return{status:429,error:'Too many attempts. Try again in 15 minutes.'};
  if(this.attempts.size>=5000&&!this.attempts.has(ip))return{status:429,error:'Sign-in is temporarily rate limited.'};attempt.count++;this.attempts.set(ip,attempt);
  const user=this.db.prepare('SELECT * FROM users WHERE login=?').get(String(login||'').trim().toLowerCase());
  const actual=Buffer.from(passwordHash(String(password||'').slice(0,200),user?.salt||'no-user-salt'),'hex'),expected=Buffer.from(user?.password_hash||'0'.repeat(128),'hex');
  if(!user||!timingSafeEqual(actual,expected))return{status:401,error:'Incorrect email or password.'};
  this.attempts.delete(ip);return{status:200,...this.startSession(user.id)};
 }
 startSession(userId){const now=Date.now()/1000;this.db.prepare('DELETE FROM user_sessions WHERE expires<?').run(now);const token=randomBytes(32).toString('base64url'),csrf=randomBytes(24).toString('base64url');
  this.db.prepare('INSERT INTO user_sessions VALUES(?,?,?,?)').run(digest(token),userId,csrf,now+this.sessionSeconds);return{token,csrf};}
 session(cookie=''){const match=String(cookie).match(/(?:^|;\s*)ab_session=([-_a-zA-Z0-9]{40,60})(?:;|$)/);if(!match)return null;
  const row=this.db.prepare('SELECT s.token_hash,s.csrf,s.expires,u.id user_id,u.login,u.name,u.role FROM user_sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=? AND s.expires>?').get(digest(match[1]),Date.now()/1000);return row||null;}
 logout(session){this.db.prepare('DELETE FROM user_sessions WHERE token_hash=?').run(session.token_hash);}
 // Bearer tokens for the browser extension: shown once, stored hashed, revocable.
 issueToken(userId,label='Browser extension'){const token='abx_'+randomBytes(30).toString('base64url');this.db.prepare('INSERT INTO user_tokens VALUES(?,?,?,?,NULL)').run(digest(token),userId,label,Date.now()/1000);return token;}
 tokenUser(header=''){const match=String(header).match(/^Bearer (abx_[-_a-zA-Z0-9]{30,60})$/);if(!match)return null;const hash=digest(match[1]);
  const row=this.db.prepare('SELECT t.token_hash,u.id user_id,u.login,u.name,u.role FROM user_tokens t JOIN users u ON u.id=t.user_id WHERE t.token_hash=?').get(hash);
  if(row)this.db.prepare('UPDATE user_tokens SET last_used=? WHERE token_hash=?').run(Date.now()/1000,hash);return row||null;}
 revokeTokens(userId){this.db.prepare('DELETE FROM user_tokens WHERE user_id=?').run(userId);}
 tokens(userId){return this.db.prepare('SELECT label,created_at,last_used FROM user_tokens WHERE user_id=? ORDER BY created_at DESC').all(userId);}
 count(){return this.db.prepare('SELECT count(*) n FROM users').get().n;}
}
// Per-user key/value settings (profile facts, answers, permissions, pacing, last search).
export class UserSettings{
 constructor(db){this.db=db;}
 get(userId,key){return JSON.parse(this.db.prepare('SELECT value FROM user_settings WHERE user_id=? AND key=?').get(userId,key)?.value||'null');}
 set(userId,key,value){if(value===null||value===undefined)this.db.prepare('DELETE FROM user_settings WHERE user_id=? AND key=?').run(userId,key);else this.db.prepare('INSERT OR REPLACE INTO user_settings VALUES(?,?,?)').run(userId,key,JSON.stringify(value));return value;}
}
