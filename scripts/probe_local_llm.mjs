// Bounded probe: can a small CPU LLM (Qwen2.5-0.5B-Instruct, int8 ONNX via transformers.js) do the two
// assistant jobs fast enough? (1) map a free-form reply to an offered option, (2) draft a short answer from a CV.
import {pipeline,env} from '../web/node_modules/@huggingface/transformers/dist/transformers.node.mjs';
env.cacheDir=process.env.APPLYBURST_MODEL_CACHE||'D:/cache/models';
const t0=performance.now();
const generator=await pipeline('text-generation','onnx-community/Qwen2.5-0.5B-Instruct',{dtype:'q8',device:'cpu'});
const load=performance.now()-t0;
async function ask(messages,max=80){const t=performance.now();const out=await generator(messages,{max_new_tokens:max,do_sample:false});return{text:out[0].generated_text.at(-1).content.trim(),ms:Math.round(performance.now()-t)};}
const cases=[
 [{role:'system',content:'Map the candidate reply to exactly one of the options. Answer with the option text only.'},{role:'user',content:'Question: Will you now or in the future require visa sponsorship?\nOptions: Yes | No\nReply: hayır vizeye ihtiyacım yok, türk vatandaşıyım ve burada çalışabilirim'}],
 [{role:'system',content:'Map the candidate reply to exactly one of the options. Answer with the option text only.'},{role:'user',content:'Question: What is your notice period?\nOptions: Immediately | 2 weeks | 1 month | More than 1 month\nReply: şu an çalışıyorum, bir ay önceden haber vermem lazım'}],
 [{role:'system',content:'You write short, factual job application answers using ONLY facts from the CV. 2 sentences, first person, no invented facts.'},{role:'user',content:'CV: Logistics specialist, 4 years, shipment planning (120+ shipments/day), customs coordination, SAP MM, WMS, Istanbul.\nJob: Supply Chain Specialist at Example Retail.\nQuestion: Why are you interested in this role?'}],
];
console.log('load_ms',Math.round(load));
for(const c of cases){const r=await ask(c,c[0].content.startsWith('You write')?90:12);console.log(r.ms+'ms |',r.text.replace(/\s+/g,' '));}
console.log('rss_mb',Math.round(process.memoryUsage().rss/1048576));
