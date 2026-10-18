// Shared job pool from public ATS company directories (Greenhouse, Lever, Ashby, BambooHR, Workday).
// Boards are registered in `ats_boards` of the SERVER's database and indexed through the same path the app
// uses (normalised jobs, complete snapshots, closed jobs dropped only on complete reads). With --loop it keeps
// running: index new boards, then refresh every indexed board when its TTL expires, forever.
// Public read-only APIs, 3 concurrent requests, one board at a time per host family. Stop with Ctrl+C.
// Usage: node --no-warnings scripts/harvest_ats_baseline.mjs [--limit=N|--all] [--loop] [--db=.data/desktop-live/portal.sqlite]
import {mkdirSync,existsSync,readFileSync,writeFileSync,appendFileSync} from 'node:fs';
import {join} from 'node:path';
import {Store} from '../web/lib/store.mjs';
import {Boards} from '../web/lib/boards.mjs';
import {boardURL,refreshSources} from '../web/lib/sources.mjs';

const arg=(name,fallback)=>process.argv.find(a=>a.startsWith(`--${name}=`))?.split('=').slice(1).join('=')??fallback;
const DB_PATH=arg('db',process.env.APPLYBURST_DB||'.data/desktop-live/portal.sqlite'),ALL=process.argv.includes('--all'),LOOP=process.argv.includes('--loop');
const LIMIT=ALL?Infinity:Number(arg('limit',150)),TTL=Number(arg('ttl',21600)),CACHE_DIR=join(process.cwd(),'config/ats_companies'),LOG=arg('log','.data/harvest.log');
const DIRECTORY='https://raw.githubusercontent.com/Feashliaa/job-board-aggregator/main/data/';
const PROVIDERS={greenhouse:'greenhouse_companies.json',lever:'lever_companies.json',ashby:'ashby_companies.json',bamboohr:'bamboohr_companies.json',workday:'workday_companies.json'};
const log=line=>{const text=`${new Date().toISOString()} ${line}`;console.log(text);try{appendFileSync(LOG,text+'\n');}catch{}};
async function companies(provider){
 mkdirSync(CACHE_DIR,{recursive:true});const file=join(CACHE_DIR,provider+'.json');
 if(existsSync(file))try{const list=JSON.parse(readFileSync(file,'utf8'));if(list.length)return list;}catch{}
 const response=await fetch(DIRECTORY+PROVIDERS[provider],{signal:AbortSignal.timeout(60000)});if(!response.ok)throw new Error(provider+' directory HTTP '+response.status);
 const list=await response.json();writeFileSync(file,JSON.stringify(list));return list;
}
const slugOf=entry=>String(typeof entry==='string'?entry:entry?.slug||entry?.token||entry?.board||entry?.name||'').trim();
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
let stopping=false;for(const signal of ['SIGINT','SIGTERM'])process.on(signal,()=>{stopping=true;log('stopping after the current batch');});

const store=new Store(DB_PATH),boards=new Boards({store,search:{persistent:true,load:async()=>{}}});
try{
 const add=store.db.prepare("INSERT OR IGNORE INTO ats_boards(provider,board,company,found_from,added_at,status) VALUES(?,?,?,?,?,'new')");let registered=0;
 for(const provider of Object.keys(PROVIDERS)){
  const list=(await companies(provider)).map(slugOf).filter(Boolean).slice(0,LIMIT);
  for(const board of list){try{boardURL(provider,board);}catch{continue;}registered+=add.run(provider,provider==='workday'?board:board.toLowerCase(),null,'directory:'+provider,Date.now()/1000).changes;}
 }
 log(`registered ${registered} new boards; active postings ${store.stats().postings}`);
 for(let pass=1;!stopping;pass++){
  // 1) New boards first: the pool grows as fast as politeness allows.
  let indexed=0;for(;;){if(stopping)break;const n=await boards.indexNew(30);indexed+=n;const left=store.db.prepare("SELECT count(*) n FROM ats_boards WHERE status='new'").get().n;if(!left)break;if(indexed%300<30)log(`indexing: +${indexed} boards this pass, ${left} waiting, ${store.stats().postings} active postings`);}
  if(indexed)log(`pass ${pass}: indexed ${indexed} new boards; ${store.stats().postings} active postings`);
  if(!LOOP||stopping)break;
  // 2) Refresh indexed boards whose TTL expired (fresh ones are skipped inside refreshSources).
  const rows=store.db.prepare("SELECT provider,board,company FROM ats_boards WHERE status='indexed' ORDER BY COALESCE(last_refresh,0) ASC LIMIT 2000").all();
  const sources=rows.map(r=>({id:r.provider+':'+r.board,kind:'ats',provider:r.provider,board:r.board,company:r.company,url:boardURL(r.provider,r.board),ttl_seconds:TTL}));
  // A stuck upstream request must not stall the loop forever (observed: silent for 3 h on 18 Oct).
  const report=await Promise.race([refreshSources(store,sources),sleep(30*60000).then(()=>null)]);
  if(!report){log(`pass ${pass}: refresh exceeded 30 min; continuing`);continue;}
  const refreshed=report.sources.filter(s=>s.outcome!=='cached').length;
  for(const s of report.sources)if(s.outcome!=='cached'){const [provider,...rest]=String(s.id||s.source_id||'').split(':');store.db.prepare('UPDATE ats_boards SET last_refresh=? WHERE provider=? AND board=?').run(Date.now()/1000,provider,rest.join(':'));}
  log(`pass ${pass}: refreshed ${refreshed} stale boards in ${Math.round(report.elapsed_ms/1000)} s; ${report.stats.postings} active postings`);
  for(let i=0;i<60&&!stopping;i++)await sleep(10000);
 }
}finally{store.close();log('harvester stopped');}
