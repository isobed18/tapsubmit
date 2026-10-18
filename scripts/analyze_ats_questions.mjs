// Which application questions repeat across employers? Samples real Greenhouse postings from the local pool,
// reads each public application form (boards-api ?questions=true, read-only), groups questions by meaning and
// measures: if a candidate answered the top-K recurring questions once, what share of forms has every
// REQUIRED question answerable (CV identity facts are assumed known). Output: reports/ats-question-analysis.{json,md}
// Usage: node --no-warnings scripts/analyze_ats_questions.mjs [--jobs=1500] [--per-board=4]
import {DatabaseSync} from 'node:sqlite';
import {writeFileSync} from 'node:fs';
import {embed,dot} from '../web/lib/semantic.mjs';

const arg=(n,f)=>Number(process.argv.find(a=>a.startsWith(`--${n}=`))?.split('=')[1]??f);
const JOBS=arg('jobs',1500),PER_BOARD=arg('per-board',4);
const db=new DatabaseSync('.data/desktop-live/portal.sqlite',{readOnly:true});
const rows=db.prepare("SELECT json_extract(payload,'$.board') board,json_extract(payload,'$.external_id') id,json_extract(payload,'$.company') company FROM jobs WHERE active=1 AND json_extract(payload,'$.provider')='greenhouse' ORDER BY random()").all();
const perBoard=new Map(),sample=[];
for(const r of rows){const n=perBoard.get(r.board)||0;if(n>=PER_BOARD)continue;perBoard.set(r.board,n+1);sample.push(r);if(sample.length>=JOBS)break;}
console.log(`sampling ${sample.length} postings from ${perBoard.size} employers`);

// Identity/document fields every CV-based fill already covers (by the provider's own field names).
const KNOWN_FIELDS=new Set(['first_name','last_name','email','phone','resume','resume_text','cover_letter','cover_letter_text','preferred_name']);
const forms=[],queue=[...sample];let done=0;
async function worker(){while(queue.length){const r=queue.shift();try{const res=await fetch(`https://boards-api.greenhouse.io/v1/boards/${encodeURIComponent(r.board)}/jobs/${encodeURIComponent(r.id)}?questions=true`,{signal:AbortSignal.timeout(15000),headers:{'User-Agent':'ApplyBurst/0.3 read-only research'}});if(!res.ok)continue;const j=await res.json();
 const qs=[];for(const q of j.questions||[]){const f=q.fields?.[0]||{};if(KNOWN_FIELDS.has(f.name))continue;qs.push({label:String(q.label||'').trim(),required:!!q.required,type:f.type,options:(f.values||[]).map(v=>v.label).slice(0,12),field:f.name});}
 for(const q of j.location_questions||[]){const f=q.fields?.[0]||{};qs.push({label:String(q.label||'Location').trim(),required:!!q.required,type:f.type,options:[],field:'location',known:true});}
 const eeo=(j.compliance||[]).flatMap(c=>c.questions||[]).map(q=>({label:String(q.label||'').trim(),required:!!q.required,type:q.fields?.[0]?.type,options:(q.fields?.[0]?.values||[]).map(v=>v.label).slice(0,8),field:'eeo'}));
 forms.push({company:r.company,board:r.board,questions:qs,eeo});}catch{}finally{done++;if(done%250===0)console.log(`read ${done}/${sample.length}`);}}}
await Promise.all(Array.from({length:6},worker));

// Group by meaning: exact normalised label first, then merge paraphrases (cosine >= 0.86) of distinct labels.
const norm=s=>s.toLowerCase().replace(/<[^>]+>/g,' ').replace(/[*✱?:.()"']/g,' ').replace(/\s+/g,' ').trim();
const all=forms.flatMap((f,fi)=>f.questions.map(q=>({...q,form:fi,key:norm(q.label)}))).filter(q=>q.key);
const keys=[...new Set(all.map(q=>q.key))],counts=new Map();for(const q of all)counts.set(q.key,(counts.get(q.key)||0)+1);
keys.sort((a,b)=>counts.get(b)-counts.get(a));
const vectors=await embed(keys.map(k=>k.slice(0,200))),cluster=new Map(),heads=[];
keys.forEach((k,i)=>{let best=-1,bi=-1;for(const h of heads){const s=dot(vectors[i],vectors[h]);if(s>best){best=s;bi=h;}}if(best>=0.86)cluster.set(k,keys[bi]);else{heads.push(i);cluster.set(k,k);}});
const groups=new Map();for(const q of all){const head=cluster.get(q.key);const g=groups.get(head)||{question:head,forms:new Set(),required:0,total:0,labels:new Map(),types:new Map(),options:new Map(),known:false};
 g.forms.add(q.form);g.total++;if(q.required)g.required++;g.labels.set(q.label,(g.labels.get(q.label)||0)+1);g.types.set(q.type,(g.types.get(q.type)||0)+1);if(q.options.length)g.options.set(q.options.join(' | '),(g.options.get(q.options.join(' | '))||0)+1);g.known||=!!q.known;groups.set(head,g);}
const ranked=[...groups.values()].map(g=>({question:[...g.labels.entries()].sort((a,b)=>b[1]-a[1])[0][0],share_of_forms:+(g.forms.size/forms.length).toFixed(4),forms:g.forms.size,required_rate:+(g.required/g.total).toFixed(2),
 type:[...g.types.entries()].sort((a,b)=>b[1]-a[1])[0][0],variants:g.labels.size,examples:[...g.labels.keys()].slice(0,4),options:[...g.options.entries()].sort((a,b)=>b[1]-a[1])[0]?.[0]?.slice(0,160)||null,known_from_cv:g.known,head:g.question})).sort((a,b)=>b.forms-a.forms);

// Coverage: a form is fully answerable when each REQUIRED non-EEO question is either known from the CV
// or among the top-K recurring groups the person answered once.
const groupOf=q=>cluster.get(q.key),requiredHeads=forms.map((f,fi)=>new Set(all.filter(q=>q.form===fi&&q.required&&!q.known).map(groupOf)));
const coverage=[0,5,10,15,20,30,50,100].map(k=>{const answered=new Set(ranked.slice(0,k).map(g=>g.head));const ok=requiredHeads.filter(s=>[...s].every(h=>answered.has(h))).length;return{answered_top:k,fully_answerable_forms:+(ok/forms.length).toFixed(3)};});
const noRequired=requiredHeads.filter(s=>!s.size).length;
const summary={forms:forms.length,employers:new Set(forms.map(f=>f.board)).size,questions_beyond_identity:all.length,distinct_labels:keys.length,meaning_groups:groups.size,forms_with_no_extra_required:+(noRequired/forms.length).toFixed(3),eeo_forms:+(forms.filter(f=>f.eeo.length).length/forms.length).toFixed(3),coverage};
console.log(JSON.stringify(summary,null,1));
for(const g of ranked.slice(0,40))console.log(`${(g.share_of_forms*100).toFixed(1).padStart(5)}%  req ${String(Math.round(g.required_rate*100)).padStart(3)}%  ${String(g.type).padEnd(28)} ${g.question.replace(/\s+/g,' ').slice(0,90)}`);
writeFileSync('reports/ats-question-analysis.json',JSON.stringify({note:'Read-only Greenhouse public application forms sampled from the local pool. EEO/demographic questions are optional and excluded from coverage.',summary,top:ranked.slice(0,150)},null,1));
writeFileSync('reports/ats-question-analysis.md',`# Recurring application questions (Greenhouse sample)\n\n${summary.forms} forms from ${summary.employers} employers. Identity/CV fields excluded.\n\n| If the person answers the top-K recurring questions once | Forms with every required question answerable |\n|---|---|\n${coverage.map(c=>`| ${c.answered_top} | ${(c.fully_answerable_forms*100).toFixed(1)}% |`).join('\n')}\n\n| Share of forms | Required | Type | Question (most common wording) |\n|---|---|---|---|\n${ranked.slice(0,60).map(g=>`| ${(g.share_of_forms*100).toFixed(1)}% | ${Math.round(g.required_rate*100)}% | ${g.type} | ${g.question.replace(/\|/g,'/').replace(/\s+/g,' ').slice(0,140)} |`).join('\n')}\n`);

// ---- Coverage by canonical intent (the classifier the filler uses), not by wording -----------------------
writeFileSync('.data/diag/gh_forms.json',JSON.stringify(forms));
const {Store}=await import('../web/lib/store.mjs'),{Intents}=await import('../web/lib/intents.mjs');
const istore=new Store('.data/diag/intents.sqlite'),intents=new Intents({store:istore,dataDirectory:'.data/diag'});
const labels=[...new Set(all.map(q=>q.label.slice(0,200)))],classes=await intents.classify('fields',labels),intentOf=new Map(labels.map((l,i)=>[l,classes[i]?.label||null]));
const reqIntents=forms.map((f,fi)=>all.filter(q=>q.form===fi&&q.required&&!q.known).map(q=>({intent:intentOf.get(q.label.slice(0,200)),type:q.type,label:q.label})));
const intentForms=new Map();reqIntents.forEach(list=>{for(const i of new Set(list.map(q=>q.intent).filter(Boolean)))intentForms.set(i,(intentForms.get(i)||0)+1);});
const answerable=reqIntents.filter(list=>list.every(q=>q.intent)).length;
const freeText=reqIntents.filter(list=>list.some(q=>!q.intent&&/textarea|input_text/.test(q.type))).length,closedUnknown=reqIntents.filter(list=>list.some(q=>!q.intent&&!/textarea|input_text/.test(q.type))).length;
const byIntent={summary:{forms:forms.length,required_all_mapped_to_known_intents:+(answerable/forms.length).toFixed(3),forms_with_unmapped_required_free_text:+(freeText/forms.length).toFixed(3),forms_with_unmapped_required_choice:+(closedUnknown/forms.length).toFixed(3)},intents:[...intentForms.entries()].sort((a,b)=>b[1]-a[1]).map(([intent,n])=>({intent,share_of_forms:+(n/forms.length).toFixed(3)})),
 unmapped_required_examples:Object.entries(reqIntents.flat().filter(q=>!q.intent).reduce((a,q)=>(a[q.label.slice(0,110)]=(a[q.label.slice(0,110)]||0)+1,a),{})).sort((a,b)=>b[1]-a[1]).slice(0,40)};
console.log('\nBY INTENT',JSON.stringify(byIntent.summary));for(const i of byIntent.intents)console.log(`  ${(i.share_of_forms*100).toFixed(1).padStart(5)}%  ${i.intent}`);
console.log('UNMAPPED REQUIRED (top):');for(const [l,n] of byIntent.unmapped_required_examples.slice(0,25))console.log(`  ${String(n).padStart(4)}  ${l}`);
writeFileSync('reports/ats-question-intents.json',JSON.stringify(byIntent,null,1));istore.close();
