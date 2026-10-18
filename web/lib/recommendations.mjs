import {TRACKS,profileMatch} from './profile.mjs';
export function resumePlan(profile){
 if(!profile)return[];const skills=new Set(profile.skills),has=(...names)=>names.some(name=>skills.has(name));
 const weights={agents:has('LangGraph','LangChain','Agentic AI')?6:0,ai:has('LLM','Gemini','RAG','Agentic AI')?5:0,ml:has('Machine learning','PyTorch','TensorFlow','scikit-learn')?4:0,vision:has('Computer vision','OpenCV','YOLO')?3:0,backend:has('Python')&&has('FastAPI','Django')?2:0,early:/student|expected|intern/i.test(profile.headline+' '+(profile.facts?.graduation||''))?1:0};
 return TRACKS.filter(track=>weights[track.id]).map(track=>({...track,weight:weights[track.id]})).sort((a,b)=>b.weight-a.weight);
}
export async function recommend(store,search,profile,{track='all',early=true,location='',workplace=''}={}){
 const start=performance.now(),plan=resumePlan(profile);if(!plan.length)return{total:0,results:[],suggested:[],query_ms:0,note:'Import a resume with relevant skills to generate suggestions.'};
 const filters={location,workplace},sets=await Promise.all(plan.map(async item=>{const query=early?'('+item.query+') NOT (level:senior OR level:lead)':item.query;return{...item,...await search.query(query,filters)};}));
 const candidates=new Map();
 for(const set of sets){if(track!=='all'&&set.id!==track)continue;set.results.forEach((job,rank)=>{const key=job.canonical_id||job.id,entry=candidates.get(key)||{job,score:0,tracks:[]};entry.score+=set.weight/(40+rank);entry.tracks.push(set.label);candidates.set(key,entry);});}
 const results=[...candidates.values()].map(entry=>{const full=store.getJob(entry.job.id),match=profileMatch(full,profile);return{...entry,match,score:entry.score+Math.min(match.overlap.length,8)*.003};}).sort((a,b)=>b.score-a.score||a.job.id.localeCompare(b.job.id)).slice(0,100).map(entry=>({...entry.job,match:entry.match,suggested_because:entry.tracks}));
 return{total:results.length,candidate_count:candidates.size,results,query_ms:performance.now()-start,suggested:sets.map(({id,label,total})=>({id,label,count:total})),strategy:'Resume-derived lexical searches + reciprocal rank fusion; no model calls',note:'Top suggestions from the resume search plan. Skills and title level do not establish eligibility.'};
}
