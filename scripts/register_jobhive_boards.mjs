// Register more company boards from the open JobHive company lists (storage.stapply.ai/jobhive).
// Only company identifiers are taken; postings are fetched by our harvester from each ATS's own public API.
// The running `harvest_ats_baseline.mjs --loop` indexes rows with status 'new' on its next pass.
// Usage: node --no-warnings scripts/register_jobhive_boards.mjs [--db=.data/desktop-live/portal.sqlite]
import {DatabaseSync} from 'node:sqlite';
import {boardURL} from '../web/lib/sources.mjs';
const arg=(key,fallback)=>process.argv.find(a=>a.startsWith('--'+key+'='))?.slice(key.length+3)??fallback;
const db=new DatabaseSync(arg('db','.data/desktop-live/portal.sqlite'));db.exec('PRAGMA busy_timeout=30000');
const BASE='https://storage.stapply.ai/jobhive/v1/';
// JobHive slug/url -> our board identity per provider.
const BOARD={
 greenhouse:(slug)=>slug.toLowerCase(),lever:(slug)=>slug.toLowerCase(),ashby:(slug)=>slug,bamboohr:(slug)=>slug.toLowerCase(),
 smartrecruiters:(slug)=>slug,workable:(slug)=>slug.toLowerCase(),personio:(slug)=>slug.toLowerCase(),
 workday:(slug,url)=>{const m=String(url).match(/^https:\/\/([a-z0-9-]+)\.(wd\d{1,2})\.myworkdayjobs\.com\/(?:[a-z]{2}-[A-Z]{2}\/)?([\w-]+)/i);return m?`${m[1].toLowerCase()}|${m[2].toLowerCase()}|${m[3]}`:null;},
};
function rows(csv){
 // name,slug,url with simple quoting
 const out=[];for(const line of csv.split(/\r?\n/).slice(1)){if(!line.trim())continue;const cells=[];let cur='',quoted=false;for(let i=0;i<line.length;i++){const c=line[i];if(quoted){if(c==='"'&&line[i+1]==='"'){cur+='"';i++;}else if(c==='"')quoted=false;else cur+=c;}else if(c==='"')quoted=true;else if(c===','){cells.push(cur);cur='';}else cur+=c;}cells.push(cur);out.push({name:cells[0],slug:cells[1],url:cells[2]});}
 return out;
}
const add=db.prepare("INSERT OR IGNORE INTO ats_boards(provider,board,company,found_from,added_at,status) VALUES(?,?,?,?,?,'new')"),report={};
for(const [provider,toBoard]of Object.entries(BOARD)){
 const response=await fetch(BASE+provider+'/companies.csv',{signal:AbortSignal.timeout(60000)});if(!response.ok){report[provider]={error:'HTTP '+response.status};continue;}
 let registered=0,invalid=0,seen=0;db.exec('BEGIN');
 for(const row of rows(await response.text())){seen++;const board=toBoard(String(row.slug||'').trim(),row.url);if(!board){invalid++;continue;}try{boardURL(provider,board);}catch{invalid++;continue;}registered+=add.run(provider,board,row.name||null,'jobhive:'+provider,Date.now()/1000).changes;}
 db.exec('COMMIT');report[provider]={listed:seen,new_boards:registered,invalid};
}
console.log(JSON.stringify(report));db.close();
