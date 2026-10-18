// Lightweight multilingual semantic layer: one small CPU encoder (multilingual MiniLM, int8 ONNX)
// for CV -> role planning, job ranking and form-label intents. No generative model, no GPU.
// Vectors are cached by content hash in the caller's store. Raw CV processing belongs only to
// the private local store; the public route passes whitelisted professional labels, never raw CVs.
import {createHash} from 'node:crypto';
import {join} from 'node:path';
import {existsSync,readFileSync} from 'node:fs';
import {gunzipSync} from 'node:zlib';

// Chosen on 17 Oct 2026 over multilingual-e5-small: 6/6 vs 5/6 cross-language CV->title top-1 and a far wider
// relevant/irrelevant margin (see scripts/probe_models.mjs). Max 128 tokens: titles and short summaries.
export const MODEL_ID=process.env.APPLYBURST_EMBED_MODEL||'Xenova/paraphrase-multilingual-MiniLM-L12-v2';
export const MODEL_VERSION=process.env.APPLYBURST_EMBED_VERSION||'pmml12-q8-single-v2';
let loading=null,extractor=null,lastUse=0;
const stats={loads:0,load_ms:null,texts:0,batches:0,ms:0};

export function modelCacheDir(dataDirectory){return process.env.APPLYBURST_MODEL_CACHE||(process.platform==='win32'&&!dataDirectory?'D:/cache/models':join(dataDirectory||'.','models'));}
// The model loads on first use (about 1-2 s from the local cache) and stays warm while used.
export async function encoder(dataDirectory){
 if(extractor)return extractor;
 loading??=(async()=>{const tick=performance.now();const {pipeline,env}=await import('@huggingface/transformers');
  env.cacheDir=modelCacheDir(dataDirectory);env.allowLocalModels=true;env.allowRemoteModels=process.env.APPLYBURST_OFFLINE!=='1';
  const threads=process.env.APPLYBURST_INFERENCE_THREADS?Math.max(1,Math.min(4,Number(process.env.APPLYBURST_INFERENCE_THREADS)||1)):null;
  extractor=await pipeline('feature-extraction',MODEL_ID,{dtype:'q8',device:'cpu',...(threads?{session_options:{intraOpNumThreads:threads,interOpNumThreads:1}}:{})});stats.loads++;stats.load_ms=Math.round(performance.now()-tick);return extractor;})()
  .finally(()=>{loading=null;});
 return loading;
}
export const semanticStats=()=>({...stats,model:MODEL_ID,version:MODEL_VERSION,loaded:!!extractor});
const clean=text=>String(text||'').replace(/\s+/g,' ').trim();
// e5-family models need "query: "/"passage: " prefixes; paraphrase models compare plain text symmetrically.
const prefixed=MODEL_ID.includes('e5');
export async function embed(texts,kind='passage',dataDirectory){
 if(!texts.length)return[];const model=await encoder(dataDirectory),tick=performance.now(),out=[];
 // One text per inference: the int8 model quantizes activations per batch, so batch-mates moved a pair's
 // similarity by up to 0.05 (scripts/probe_batch_effect.mjs). About 2 ms per title, 8 ms per 250 chars.
 for(const text of texts){const tensor=await model([(prefixed?kind+': ':'')+clean(text).slice(0,600)],{pooling:'mean',normalize:true});out.push(Float32Array.from(tensor.data.subarray(0,tensor.dims[1])));stats.batches++;}
 stats.texts+=texts.length;stats.ms+=performance.now()-tick;lastUse=Date.now();return out;
}
export function dot(a,b){let s=0;for(let i=0;i<a.length;i++)s+=a[i]*b[i];return s;}
export function mean(vectors){const out=new Float32Array(vectors[0].length);for(const v of vectors)for(let i=0;i<v.length;i++)out[i]+=v[i];let n=0;for(const x of out)n+=x*x;n=Math.sqrt(n)||1;for(let i=0;i<out.length;i++)out[i]/=n;return out;}
const toBlob=v=>Buffer.from(v.buffer,v.byteOffset,v.byteLength),fromBlob=b=>new Float32Array(b.buffer.slice(b.byteOffset,b.byteOffset+b.byteLength));
// Retain the installed default model's cache; custom model IDs must not reuse its vectors even
// when a caller forgets to set a custom version (dimensions can coincide while meanings differ).
const namespace=MODEL_ID==='Xenova/paraphrase-multilingual-MiniLM-L12-v2'?MODEL_VERSION:MODEL_ID+'\n'+MODEL_VERSION;
export const textKey=text=>createHash('sha256').update(namespace+'\n'+clean(text)).digest('hex').slice(0,32);
export function jobText(job){return [job.title,job.company,clean(job.description).slice(0,700)].filter(Boolean).join(' · ');}

// Shared vector cache for public job texts and job titles. Survives restarts; one row per distinct text.
export class VectorCache{
 constructor(db,dataDirectory){this.db=db;this.dataDirectory=dataDirectory;db.exec('CREATE TABLE IF NOT EXISTS text_vectors(key TEXT PRIMARY KEY,vector BLOB NOT NULL,created_at REAL NOT NULL)');this.seedPublicReferences();}
 seedPublicReferences(){
  const references=publicReferences();if(!references.length)return;
  const put=this.db.prepare('INSERT OR IGNORE INTO text_vectors VALUES(?,?,?)'),now=Date.now()/1000;
  this.db.exec('BEGIN');try{for(const [title,vector]of references)put.run(textKey('passage:'+title),vector,now);this.db.exec('COMMIT');}catch(error){this.db.exec('ROLLBACK');throw error;}
 }
 async vectors(texts,kind='passage'){
  const keys=texts.map(t=>textKey(kind+':'+t)),found=new Map(),missing=[];
  const get=this.db.prepare('SELECT vector FROM text_vectors WHERE key=?');
  keys.forEach((key,i)=>{const row=get.get(key);if(row)found.set(key,fromBlob(row.vector));else if(!missing.some(m=>m.key===key))missing.push({key,text:texts[i]});});
  if(missing.length){const fresh=await embed(missing.map(m=>m.text),kind,this.dataDirectory),put=this.db.prepare('INSERT OR REPLACE INTO text_vectors VALUES(?,?,?)'),now=Date.now()/1000;
   this.db.exec('BEGIN');try{missing.forEach((m,i)=>{put.run(m.key,toBlob(fresh[i]),now);found.set(m.key,fresh[i]);});this.db.exec('COMMIT');}catch(error){this.db.exec('ROLLBACK');throw error;}}
  return keys.map(key=>found.get(key));
 }
 count(){return this.db.prepare('SELECT count(*) n FROM text_vectors').get().n;}
}
let referenceVectors=null;
function publicReferences(){
 if(referenceVectors!==null)return referenceVectors;
 referenceVectors=[];const file=new URL('../../config/occupation-vectors.pmml12-q8.json.gz',import.meta.url);if(!existsSync(file))return referenceVectors;
 const data=JSON.parse(gunzipSync(readFileSync(file))),sourceHash=createHash('sha256').update(readFileSync(new URL('../../config/occupations.esco.json.gz',import.meta.url))).digest('hex');
 if(data.model!==MODEL_ID||data.version!==MODEL_VERSION||data.source_sha256!==sourceHash)return referenceVectors;
 referenceVectors=data.entries.map(([title,base64])=>[title,Buffer.from(base64,'base64')]);return referenceVectors;
}
