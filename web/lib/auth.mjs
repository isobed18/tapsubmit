import {randomBytes,scryptSync,timingSafeEqual,createHash} from 'node:crypto';
import {readFileSync,writeFileSync,existsSync,mkdirSync,renameSync,unlinkSync} from 'node:fs';
import {join} from 'node:path';
const digest=value=>createHash('sha256').update(value).digest('hex');
export function passwordHash(password,salt){return scryptSync(password,salt,64,{N:16384,r:8,p:1}).toString('hex');}
export function readAdmin(directory){const file=join(directory,'admin.json');return existsSync(file)?JSON.parse(readFileSync(file,'utf8')):null;}
export function ensureAdmin(directory,username='admin'){
 mkdirSync(directory,{recursive:true});const file=join(directory,'admin.json');if(existsSync(file))return JSON.parse(readFileSync(file,'utf8'));
 const password=randomBytes(15).toString('base64url'),salt=randomBytes(16).toString('hex'),admin={username,salt,password_hash:passwordHash(password,salt),created_at:new Date().toISOString()};
 writeFileSync(file,JSON.stringify(admin,null,2),{mode:0o600,flag:'wx'});writeFileSync(join(directory,'first-login.json'),JSON.stringify({username,password},null,2),{mode:0o600,flag:'wx'});return admin;
}
export class Auth{
 constructor(store,admin,{directory=null,allowMembers=false,sessionSeconds=43200,maxAttempts=6,windowSeconds=900}={}){
  this.store=store;this.admin=admin;this.directory=directory;this.allowMembers=allowMembers;this.sessionSeconds=sessionSeconds;this.maxAttempts=maxAttempts;this.windowSeconds=windowSeconds;this.attempts=new Map();
  this.store.db.exec('CREATE TABLE IF NOT EXISTS users(username TEXT PRIMARY KEY,salt TEXT NOT NULL,password_hash TEXT NOT NULL,created_at TEXT NOT NULL,password_changed_at TEXT); CREATE TABLE IF NOT EXISTS session_users(token_hash TEXT PRIMARY KEY,username TEXT NOT NULL);');
 }
 register(username,password){
  if(!this.allowMembers&&(this.admin||!this.directory||readAdmin(this.directory)))throw Object.assign(new Error('This computer already has an owner account. Sign in instead.'),{status:409});
  username=String(username||'').trim().toLowerCase();
  if(!/^[a-z0-9][a-z0-9._@-]{2,79}$/.test(username))throw new Error('Use 3–80 letters, digits, dots, underscores or hyphens for your username.');
  this.validatePassword(password);
  if(this.allowMembers){
   const exists=this.store.db.prepare('SELECT username FROM users WHERE username=?').get(username)||(this.admin&&this.admin.username.toLowerCase()===username);
   if(exists)throw Object.assign(new Error('That username is already taken. Sign in instead.'),{status:409});
   const salt=randomBytes(16).toString('hex'),hash=passwordHash(password,salt),now=new Date().toISOString();
   this.store.db.prepare('INSERT INTO users(username,salt,password_hash,created_at) VALUES(?,?,?,?)').run(username,salt,hash,now);
   if(!this.admin&&this.directory&&!existsSync(join(this.directory,'admin.json'))){
    const admin={username,salt,password_hash:hash,created_at:now};writeFileSync(join(this.directory,'admin.json'),JSON.stringify(admin,null,2),{mode:0o600});this.admin=admin;
   }
   return this.createSession(username);
  }
  const salt=randomBytes(16).toString('hex'),admin={username,salt,password_hash:passwordHash(password,salt),created_at:new Date().toISOString()};
  // One owner per local data directory. Exclusive creation also prevents registration races.
  writeFileSync(join(this.directory,'admin.json'),JSON.stringify(admin,null,2),{mode:0o600,flag:'wx'});
  this.admin=admin;this.store.db.prepare('DELETE FROM sessions').run();return this.createSession(username);
 }
 validatePassword(password){if(typeof password!=='string'||password.length<8||password.length>200)throw new Error('Use a password with 8–200 characters.');}
 changePassword(current,password,username=null){
  const targetUser=username?String(username).trim().toLowerCase():null;
  const member=this.allowMembers&&targetUser?this.store.db.prepare('SELECT * FROM users WHERE username=?').get(targetUser):null;
  if(member){
   this.validatePassword(password);
   const actual=Buffer.from(passwordHash(String(current||'').slice(0,1024),member.salt),'hex');
   if(!timingSafeEqual(actual,Buffer.from(member.password_hash,'hex')))throw Object.assign(new Error('Your current password is incorrect.'),{status:400});
   const salt=randomBytes(16).toString('hex'),hash=passwordHash(password,salt),changed=new Date().toISOString();
   this.store.db.prepare('UPDATE users SET salt=?,password_hash=?,password_changed_at=? WHERE username=?').run(salt,hash,changed,member.username);
   const tokens=this.store.db.prepare('SELECT token_hash FROM session_users WHERE username=?').all(member.username);
   for(const t of tokens)this.store.db.prepare('DELETE FROM sessions WHERE token_hash=?').run(t.token_hash);
   this.store.db.prepare('DELETE FROM session_users WHERE username=?').run(member.username);
   return this.createSession(member.username);
  }
  if(!this.admin||!this.directory)throw new Error('No local account is configured.');
  this.validatePassword(password);
  const actual=Buffer.from(passwordHash(String(current||'').slice(0,1024),this.admin.salt),'hex');
  if(!timingSafeEqual(actual,Buffer.from(this.admin.password_hash,'hex')))throw Object.assign(new Error('Your current password is incorrect.'),{status:400});
  const salt=randomBytes(16).toString('hex'),updated={...this.admin,salt,password_hash:passwordHash(password,salt),password_changed_at:new Date().toISOString()};
  const file=join(this.directory,'admin.json'),temporary=file+'.'+randomBytes(6).toString('hex')+'.tmp';
  writeFileSync(temporary,JSON.stringify(updated,null,2),{mode:0o600,flag:'wx'});renameSync(temporary,file);
  this.admin=updated;if(existsSync(join(this.directory,'first-login.json')))unlinkSync(join(this.directory,'first-login.json'));
  this.store.db.prepare('DELETE FROM sessions').run();this.store.db.prepare('DELETE FROM session_users').run();return this.createSession(this.admin.username);
 }
 login(username,password,ip){
  const normalized=String(username||'').trim().toLowerCase();
  const member=this.allowMembers?this.store.db.prepare('SELECT * FROM users WHERE username=?').get(normalized):null;
  const account=member||(this.admin&&this.admin.username.toLowerCase()===normalized?this.admin:null);
  if(!this.admin&&!this.allowMembers)return{status:409,error:'Create the owner account on this computer first.'};
  const now=Date.now()/1000;for(const [key,value]of this.attempts)if(now-value.start>this.windowSeconds)this.attempts.delete(key);
  const attempt=this.attempts.get(ip)||{start:now,count:0};if(attempt.count>=this.maxAttempts)return{status:429,error:'Too many attempts. Try again in 15 minutes.'};
  if(this.attempts.size>=2000&&!this.attempts.has(ip))return{status:429,error:'Sign-in is temporarily rate limited.'};
  attempt.count++;this.attempts.set(ip,attempt);
  const target=account||this.admin||{salt:'00000000000000000000000000000000',password_hash:'0'.repeat(128),username:''};
  const actual=Buffer.from(passwordHash(String(password||'').slice(0,1024),target.salt),'hex'),expected=Buffer.from(target.password_hash,'hex');
  if(!account||!timingSafeEqual(actual,expected))return{status:401,error:'Incorrect username or password.'};
  this.attempts.delete(ip);return this.createSession(account.username);
 }
 createSession(username=this.admin?.username){
  if(!username&&!this.admin)throw new Error('Create the local account first.');
  const user=username||this.admin.username,now=Date.now()/1000;this.store.db.prepare('DELETE FROM sessions WHERE expires<?').run(now);
  const token=randomBytes(32).toString('base64url'),csrf=randomBytes(24).toString('base64url'),expires=now+this.sessionSeconds,hash=digest(token);
  this.store.db.prepare('INSERT INTO sessions VALUES(?,?,?)').run(hash,csrf,expires);
  this.store.db.prepare('INSERT OR REPLACE INTO session_users VALUES(?,?)').run(hash,user);
  return{status:200,token,csrf,expires,username:user};
 }
 session(cookie=''){
  const match=cookie.match(/(?:^|;\s*)ab_session=([-_a-zA-Z0-9]{40,60})(?:;|$)/);if(!match)return null;
  const row=this.store.db.prepare('SELECT token_hash,csrf,expires FROM sessions WHERE token_hash=? AND expires>?').get(digest(match[1]),Date.now()/1000);
  if(!row)return null;
  const userRow=this.store.db.prepare('SELECT username FROM session_users WHERE token_hash=?').get(row.token_hash);
  return{...row,username:userRow?.username||this.admin?.username||'admin'};
 }
 logout(session){this.store.db.prepare('DELETE FROM sessions WHERE token_hash=?').run(session.token_hash);this.store.db.prepare('DELETE FROM session_users WHERE token_hash=?').run(session.token_hash);}
}
