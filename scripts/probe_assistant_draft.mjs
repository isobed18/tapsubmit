// One bounded, synthetic CPU-only drafting probe through the production assistant. No answers are saved.
import {writeFileSync,mkdirSync} from 'node:fs';
import {Assistant} from '../web/lib/assistant.mjs';
const model=process.argv[2]||'qwen2.5:3b',missing=process.argv.includes('--missing-facts'),turkish=process.argv.includes('--turkish'),data=new Map();
const store={setting(k,v){if(v!==undefined)data.set(k,structuredClone(v));return data.has(k)?structuredClone(data.get(k)):undefined;}};
const question={key:'synthetic-essay',fingerprint:'f'.repeat(64),job_id:'fictional',label:missing?'What is your current monthly salary and notice period?':turkish?'Bu tedarik zinciri pozisyonuyla neden ilgileniyorsunuz?':'Why are you interested in this supply-chain role?',kind:'textarea',options:[],jobs:[{id:'fictional',title:'Supply Chain Specialist',company:'Synthetic Example Retail'}]};
const notes='Fictional candidate. Logistics specialist. Four years of shipment planning, customs coordination, SAP MM and WMS.'+(missing?' No motivation was provided.':' Approved motivation, supplied by the candidate: I enjoy improving delivery reliability and want a supply-chain role where I can coordinate shipments and customs.');
const assistant=new Assistant({store,pendingQuestions:()=>[question],saveAnswers:()=>{throw Error('A probe must never save an answer.');},candidateNotes:()=>notes});
assistant.setLLM({enabled:true,model});assistant.sync();const start=performance.now();await assistant.handle('/draft','web',question.key);
while(assistant.drafting)await new Promise(r=>setTimeout(r,250));
const status=await assistant.llmStatus(),state=assistant.state(),report={date:new Date().toISOString(),model,synthetic_only:true,missing_facts:missing,question_language:turkish?'tr':'en',cpu_requested:true,elapsed_ms:Math.round(performance.now()-start),gpu_bytes:status.loaded?.gpu_bytes||0,draft:state.draft?.text||null,last_message:state.messages.at(-1)?.text,inference:status.last_draft,automatic_use:false};
mkdirSync('reports',{recursive:true});writeFileSync('reports/assistant-draft-'+model.replace(/[^a-zA-Z0-9.-]/g,'_')+(missing?'-missing':turkish?'-tr':'')+'.json',JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report,null,2));assistant.close();
// Only unload our CPU probe model; never stop a model another process has put on the GPU.
if(status.loaded&&status.loaded.gpu_bytes===0)await fetch('http://127.0.0.1:11434/api/generate',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({model,keep_alive:0,options:{num_gpu:0}}),signal:AbortSignal.timeout(10000)});
