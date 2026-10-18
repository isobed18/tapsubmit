import {createHash} from 'node:crypto';
import {enrich,plainText,normalizeFeed} from '../../demo/lib/feeds.mjs';
export {plainText,normalizeFeed};
export const EXTRA_SKILLS={'LangGraph':'\\blanggraph\\b','LangChain':'\\blangchain\\b','Agentic AI':'\\bagentic\\b|AI agents?|agent.orchestration|tool.calling','RAG':'\\brag\\b|retrieval.augmented generation','Embeddings':'\\bembeddings?\\b','Gemini':'\\bgemini\\b','OpenCV':'\\bopencv\\b','YOLO':'\\byolo\\b','scikit-learn':'scikit.learn','Recommendation systems':'recommender|recommendation systems?'};
export const hash=value=>createHash('sha256').update(typeof value==='string'||ArrayBuffer.isView(value)?value:JSON.stringify(value)).digest('hex');
export function decorate(job){
 const metadata=enrich(job.title,job.description,job.location,job.workplace,job.employment_type);
 const text=job.title+'\n'+job.description;
 metadata.skills=[...new Set([...(job.skills||[]),...metadata.skills,...Object.entries(EXTRA_SKILLS).filter(([,pattern])=>new RegExp(pattern,'i').test(text)).map(([skill])=>skill)])];
 return {...job,...metadata,skills:metadata.skills,canonical_id:job.canonical_id||job.id,locations:job.locations||[job.location||''],signals:{...metadata.signals,...job.signals}};
}
export function normalizedJob(source,raw){
 const description=plainText(raw.description),title=plainText(raw.title),url=new URL(raw.apply_url);
 if(!['https:','http:'].includes(url.protocol)||!title||!raw.external_id)throw new Error('Invalid source job.');
 return decorate({id:`${source.provider}:${source.board}:${raw.external_id}`,canonical_id:raw.canonical_id,provider:source.provider,board:source.board,external_id:String(raw.external_id),company:raw.company||source.company||source.provider,title,description,location:raw.location||'',locations:raw.locations,apply_url:url.href,source_url:source.url||raw.source_url,source_id:source.id,source_kind:source.kind,seen_at:Date.now()/1000,posted_at:raw.posted_at||null,workplace:raw.workplace||'unknown',employment_type:raw.employment_type||'unknown',seniority:raw.seniority||'unknown',skills:raw.skills||[],salary:raw.salary||null,location_restriction:raw.location_restriction||null,provider_delay_hours:source.provider_delay_hours||0});
}
function ordered(value){if(Array.isArray(value))return value.map(ordered);if(value&&typeof value==='object')return Object.fromEntries(Object.keys(value).sort().map(key=>[key,ordered(value[key])]));return value;}
export function contentHash(job){const {seen_at,first_seen_at,last_seen_at,content_hash,...content}=job;return hash(ordered(content));}
export function chunkJob(job,size=1200,overlap=150){
 const heading=[job.title,job.company,job.location].filter(Boolean).join(' · '),text=heading+'\n'+job.description,revision=contentHash(job),chunks=[];
 for(let start=0;start<text.length;start+=size-overlap){const content=text.slice(start,start+size);chunks.push({id:hash(job.id+':'+revision+':'+chunks.length),job_id:job.id,content_hash:revision,ordinal:chunks.length,text:content});if(start+size>=text.length)break;}
 return chunks;
}
