// Incremental SQLite FTS5 index: no per-process corpus copy or full-index rebuild.
import {parseQuery,fold,words} from '../../demo/public/search-engine.mjs';
import {postingIdentity} from './job-pool.mjs';
const columns=['title','description','skill','company','location','workplace','level','type','source'];
const token=value=>value==='c++'?'abcplusplus':value==='c#'?'abcsharp':value==='.net'?'abdotnet':value==='node.js'?'abnodejs':value;
export function registerTokenizer(db){db.function('ab_tokens',{deterministic:true},value=>words(value).map(token).join(' '));}
const expressions=alias=>["$.title","$.description","$.skills","$.company","$.location","$.workplace","$.seniority","$.employment_type","$.provider"].map(path=>`ab_tokens(COALESCE(json_extract(${alias}.payload,'${path}'),''))`).join(',');
export function ensureIndex(db){
 const start=performance.now();registerTokenizer(db);
 const version=db.prepare("SELECT value FROM private_settings WHERE key='fts_tokenizer_version'").get()?.value;
 if(version!=='2')db.exec('DROP TRIGGER IF EXISTS public_job_insert; DROP TRIGGER IF EXISTS public_job_update; DROP TRIGGER IF EXISTS public_job_delete; DROP TABLE IF EXISTS public_job_fts;');
 db.exec(`PRAGMA busy_timeout=5000;
 CREATE VIRTUAL TABLE IF NOT EXISTS public_job_fts USING fts5(${columns.join(',')},content='',contentless_delete=1,tokenize='unicode61 remove_diacritics 2');
 CREATE TRIGGER IF NOT EXISTS public_job_insert AFTER INSERT ON jobs WHEN new.active=1 BEGIN
  INSERT OR REPLACE INTO public_job_fts(rowid,${columns.join(',')}) VALUES(new.rowid,${expressions('new')}); END;
 CREATE TRIGGER IF NOT EXISTS public_job_update AFTER UPDATE ON jobs WHEN old.content_hash!=new.content_hash OR old.active!=new.active BEGIN
  DELETE FROM public_job_fts WHERE rowid=old.rowid;
  INSERT OR REPLACE INTO public_job_fts(rowid,${columns.join(',')}) SELECT new.rowid,${expressions('new')} WHERE new.active=1; END;
 CREATE TRIGGER IF NOT EXISTS public_job_delete AFTER DELETE ON jobs BEGIN DELETE FROM public_job_fts WHERE rowid=old.rowid; END;`);
 db.exec(`INSERT OR REPLACE INTO public_job_fts(rowid,${columns.join(',')}) SELECT j.rowid,${expressions('j')} FROM jobs j LEFT JOIN public_job_fts f ON f.rowid=j.rowid WHERE j.active=1 AND f.rowid IS NULL;
 DELETE FROM public_job_fts WHERE rowid NOT IN(SELECT rowid FROM jobs WHERE active=1);`);
 db.prepare("INSERT OR REPLACE INTO private_settings VALUES('fts_tokenizer_version','2')").run();
 return performance.now()-start;
}
const quoted=value=>'"'+String(value).replaceAll('"','""')+'"';
function ftsTerm(term){const tokens=words(term.value).map(token);if(!tokens.length)return'"__empty__"';return(term.field?term.field+':':'')+quoted(tokens.join(' '));}
export class IndexedSearch{
 constructor(store){this.store=store;this.db=store.db;this.persistent=true;this.generation=0;this.indexMs=ensureIndex(this.db);}
 async load(){this.generation=this.revision();}
 revision(){return this.db.prepare('SELECT COALESCE(max(seq),0) revision FROM index_events').get().revision;}
 async close(){}
 async query(query,filters={},limit=100){
  const tick=performance.now(),ast=parseQuery(String(query||'')),params=[],positive=[];
  function sql(node,negated=false){
   if(node.type==='all')return'1';
   if(node.type==='term'){const expression=ftsTerm(node);params.push(expression);if(!negated)positive.push(expression);return'j.rowid IN(SELECT rowid FROM public_job_fts WHERE public_job_fts MATCH ?)';}
   if(node.type==='not')return'(NOT '+sql(node.child,!negated)+')';
   return'('+sql(node.left,negated)+(node.type==='and'?' AND ':' OR ')+sql(node.right,negated)+')';
  }
  let where='j.active=1 AND '+sql(ast);
  if(filters.location){const cities=String(filters.location).split(/[;,|]/).map(s=>s.trim()).filter(Boolean);if(cities.length){where+=' AND ('+cities.map(()=>"j.rowid IN(SELECT rowid FROM public_job_fts WHERE public_job_fts MATCH ?)").join(' OR ')+(filters.include_remote?" OR json_extract(j.payload,'$.workplace')='remote'":'')+')';params.push(...cities.map(city=>ftsTerm({field:'location',value:city})));}}
  if(filters.providers?.length){where+=" AND json_extract(j.payload,'$.provider') IN ("+filters.providers.map(()=>'?').join(',')+')';params.push(...filters.providers);}
  if(filters.workplace){where+=" AND json_extract(j.payload,'$.workplace')=?";params.push(filters.workplace);}
  if(filters.max_age_hours){where+=' AND j.last_seen>=?';params.push(Date.now()/1000-Number(filters.max_age_hours)*3600);}
  const total=this.db.prepare('SELECT count(*) n FROM jobs j WHERE '+where).get(...params).n;
  // A negative OR branch can admit documents with no positive term. Rank positives in a
  // separate materialized CTE instead of accidentally filtering that branch away.
  const ranked=positive.length?'WITH lexical AS MATERIALIZED (SELECT rowid,bm25(public_job_fts,6,1,4,.5,.5,.2,.2,.2,.2) score FROM public_job_fts WHERE public_job_fts MATCH ?) ':'';
  const joins=positive.length?' LEFT JOIN lexical ON lexical.rowid=j.rowid ':'';
  const rows=this.db.prepare(`${ranked}SELECT j.id,j.payload,j.last_seen,${positive.length?'coalesce(lexical.score,0)':'0'} lexical_rank FROM jobs j ${joins} WHERE ${where} ORDER BY lexical_rank ASC,j.last_seen DESC,j.id LIMIT ?`).all(...(positive.length?[[...new Set(positive)].join(' OR ')]:[]),...params,Math.max(1,Math.min(1000,limit)));
  const seen=new Set(),results=[];for(const row of rows){const job=JSON.parse(row.payload),key=job.canonical_id||job.id;let target;try{target=postingIdentity(job.destination_url||job.apply_url);}catch{target=key;}if(seen.has(key)||seen.has(target))continue;seen.add(key);seen.add(target);const {description,...card}=job;results.push({...card,seen_at:row.last_seen,rank_score:-row.lexical_rank,evidence:[]});}
  return{query,total,results,matching_postings:total,duplicate_postings_removed:rows.length-results.length,query_ms:performance.now()-tick,strategy:'SQLite FTS5 BM25, incrementally maintained'};
 }
}
