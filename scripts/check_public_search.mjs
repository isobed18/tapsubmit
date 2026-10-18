// Public discovery path on a snapshot of the public job store (no crawl, live read-only searches like the
// public site). Sends only vocabulary titles + whitelisted skills, exactly what the browser sends.
// Usage: node --no-warnings scripts/check_public_search.mjs [snapshot-source]
import {DatabaseSync} from 'node:sqlite';
import {mkdirSync,rmSync,existsSync} from 'node:fs';
import {createPortal} from '../web/server.mjs';
const source=process.argv[2]||'.data/discovery/portal.sqlite',dir='.data/public-check';rmSync(dir,{recursive:true,force:true});mkdirSync(dir,{recursive:true});
{const db=new DatabaseSync(source,{readOnly:true});db.exec(`VACUUM INTO '${dir}/portal.sqlite'`);db.close();}
const app=await createPortal({directory:dir,seed:false,mode:'discovery',publicOrigin:'https://tapsubmit.com'});
await new Promise(r=>app.server.listen(0,'127.0.0.1',r));const origin='http://127.0.0.1:'+app.server.address().port,base=origin+'/applyburst/api/public/';
const CASES=[['TR nurse',['Hemşire'],{country:'turkey',skills:[],roles:[],level:'experienced'}],['UK accountant',['Accountant'],{country:'uk',skills:['Excel'],roles:[],level:'experienced'}],['TR backend',['Backend Developer'],{country:'turkey',skills:['Python','PostgreSQL'],roles:[],level:'experienced'}]];
for(const [name,titles,features]of CASES){
 const t0=Date.now(),start=await fetch(base+'search',{method:'POST',headers:{Origin:origin,'Content-Type':'application/json'},body:JSON.stringify({titles,features})}),started=await start.json();
 if(!start.ok){console.log(name,'->',start.status,started.error);continue;}
 let status,first=null;for(;;){await new Promise(r=>setTimeout(r,500));status=await(await fetch(base+'status?id='+started.id)).json();if(first===null&&status.jobs.length)first=Date.now()-t0;if(!status.running)break;}
 const auto=status.jobs.filter(j=>!j.review);
 console.log(`${name}: queries ${JSON.stringify(started.queries)} · ${status.jobs.length} jobs (${auto.length} strong) · first ${first} ms · done ${Date.now()-t0} ms · sources ${status.rows.map(r=>r.site+':'+r.state+':'+r.count).join(' ')}`);
 for(const j of status.jobs.slice(0,6))console.log('    ',j.review?'~':'+',j.title,'|',j.company,'|',String(j.location||'').slice(0,30),'|',j.source);
}
await app.close();
