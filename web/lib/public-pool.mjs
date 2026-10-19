// Read-only shared job pool for the public site: public posting metadata (no descriptions, no candidate
// data) exported from the harvester, indexed once at image build time. It never touches the volume.
import {DatabaseSync} from 'node:sqlite';
import {createReadStream,existsSync,readFileSync,rmSync,statSync} from 'node:fs';
import {createGunzip} from 'node:zlib';
import {createInterface} from 'node:readline';
import {decorate} from './jobs.mjs';
import {postedMillis,countryTerms} from './matching.mjs';
const fold=s=>String(s??'').normalize('NFKD').replace(/\p{M}/gu,'').toLowerCase().replaceAll('ı','i');
const terms=text=>[...new Set(fold(text).split(/[^\p{L}\p{N}+#]+/u).filter(t=>t.length>1&&!['and','or','not','near','the','of'].includes(t)))].slice(0,8);
const quote=t=>'"'+t.replaceAll('"','')+'"';
// Compact rows: [provider,board,title,company,location,workplace,seniority,posted_at,apply_url,listing_url|0,destination_url|0,last_seen]
const companyFromBoard=board=>String(board||'').replace(/[-_]+/g,' ').replace(/(^|\s)(\p{Ll})/gu,(_,space,c)=>space+c.toUpperCase()).slice(0,120);
function unpack(id,text){const [provider,board,title,company,location,workplace,seniority,posted_at,apply_url,listing,destination,last_seen]=JSON.parse(text);return{id,canonical_id:id,provider,board,title,company,location,workplace,seniority,posted_at,apply_url,listing_url:listing||apply_url,destination_url:destination||apply_url,last_seen};}
export async function buildPoolIndex(source,target){
 if(existsSync(target))rmSync(target);
 const db=new DatabaseSync(target);
 db.exec("PRAGMA journal_mode=OFF;PRAGMA synchronous=OFF;CREATE TABLE p(n INTEGER PRIMARY KEY,id TEXT UNIQUE,posted INTEGER,j TEXT);CREATE VIRTUAL TABLE f USING fts5(title,company,location,content='',tokenize='unicode61 remove_diacritics 2');");
 const ins=db.prepare('INSERT OR IGNORE INTO p(id,posted,j) VALUES(?,?,?)'),fts=db.prepare('INSERT INTO f(rowid,title,company,location) VALUES(?,?,?,?)');let n=0;
 db.exec('BEGIN');
 for await(const line of createInterface({input:createReadStream(source).pipe(createGunzip())})){
  const j=JSON.parse(line),company=j.company||companyFromBoard(j.board),slim=[j.provider,j.board,j.title,company,j.location,j.workplace,j.seniority,j.posted_at,j.apply_url,j.listing_url===j.apply_url?0:j.listing_url,j.destination_url===j.apply_url?0:j.destination_url,Math.round(j.last_seen||j.first_seen||0)];
  // Same parser as ranking (Lever sends epoch milliseconds as strings); unknown dates sort last.
  const time=postedMillis(j.posted_at),r=ins.run(String(j.id),time?Math.round(time/1000):null,JSON.stringify(slim));if(!r.changes)continue;n++;
  fts.run(r.lastInsertRowid,String(j.title??''),String(company??''),String(j.location??''));
 }
 db.exec('COMMIT');db.exec('VACUUM');db.close();return{records:n,bytes:statSync(target).size};
}
export class PublicPool{
 constructor(file,manifestFile){
  this.db=existsSync(file)?new DatabaseSync(file,{readOnly:true}):null;
  this.manifest=existsSync(manifestFile)?JSON.parse(readFileSync(manifestFile,'utf8')):null;
  this.records=this.db?this.db.prepare('SELECT count(*) n FROM p').get().n:0;
 }
 stats(){return{records:this.records,generated_at:this.manifest?.generated_at||null,download_bytes:this.manifest?.compressed_bytes||null};}
 get(id){
  if(!this.db)return null;const row=this.db.prepare('SELECT j FROM p WHERE id=?').get(String(id));if(!row)return null;
  const j=unpack(id,row.j);return decorate({...j,description:'',description_state:'missing',source_id:j.provider+':'+j.board,source_kind:'ats',seen_at:j.last_seen||j.first_seen});
 }
 // Same shape as IndexedSearch.query; freshest title matches first; cities narrow non-remote rows.
 async query(query,filters={},limit=100){
  if(!this.db)return{results:[],total:0};
  // Queries arrive in the engine's grammar, e.g. '"machine learning" OR pytorch OR "ML engineer"':
  // each OR branch is a phrase or an all-words group on the title; NOT branches and field names are dropped.
  const branches=String(query).replace(/\b(?:title|description|skill|company|location|workplace|level|type|source):/gi,' ').split(/\s+OR\s+/i).map(b=>b.replace(/\bNOT\b.*$/i,'').replace(/[()]/g,' ').trim()).filter(Boolean)
   .map(b=>{const words=terms(b);return !words.length?null:/^".*"$/.test(b)&&words.length>1?'"'+words.join(' ')+'"':'('+words.map(quote).join(' ')+')';}).filter(Boolean).slice(0,8);
  if(!branches.length)return{results:[],total:0};const words=terms(query);
  const cities=String(filters.location||'').split(/[;,|]/).map(terms).filter(t=>t.length);
  let match='title:('+branches.join(' OR ')+')';
  // A chosen country (no cities) narrows the pool to locations naming it; remote rows stay when allowed.
  const country=!cities.length&&filters.country&&filters.country!=='worldwide'?countryTerms(filters.country).map(terms).filter(t=>t.length):[];
  if(country.length&&filters.workplace!=='remote')match+=' AND location:('+country.map(c=>'('+c.map(quote).join(' ')+')').join(' OR ')+(filters.include_remote?' OR "remote"':'')+')';
  if(cities.length&&!filters.include_remote&&filters.workplace!=='remote')match+=' AND location:('+cities.map(c=>'('+c.map(quote).join(' ')+')').join(' OR ')+')';
  const rows=this.db.prepare('SELECT p.id,p.j FROM p JOIN (SELECT p.n FROM f JOIN p ON p.n=f.rowid WHERE f MATCH ? ORDER BY p.posted DESC NULLS LAST LIMIT ?) s ON s.n=p.n ORDER BY p.posted DESC NULLS LAST').all(match,Math.min(5000,limit*5));
  const providers=filters.providers?new Set(filters.providers):null,results=[];
  for(const row of rows){
   const j=unpack(row.id,row.j);if(providers&&!providers.has(j.provider))continue;
   if(filters.workplace==='remote'&&j.workplace!=='remote')continue;
   if(cities.length&&filters.include_remote&&j.workplace!=='remote'&&!cities.some(c=>c.every(t=>fold(j.location).includes(t))))continue;
   results.push({id:row.id,evidence:[{field:'title',term:words.join(' '),snippet:j.title}]});if(results.length>=limit)break;
  }
  return{results,total:rows.length};
 }
}
