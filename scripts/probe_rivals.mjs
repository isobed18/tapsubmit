// Bounded check of target vs rival roles: which job titles a CV plan would send automatically.
// Synthetic CVs; snapshot pool from measure_planner.mjs. Prints, per profile, accepted vs rejected titles.
import {Planner} from '../web/lib/planner.mjs';
import {Store} from '../web/lib/store.mjs';
import {RELEVANCE,rankJobs} from '../web/lib/matching.mjs';
import {writeFileSync,readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {occupationStats} from '../web/lib/occupations.mjs';
import {semanticStats} from '../web/lib/semantic.mjs';
const store=new Store('.data/model-eval/planner.sqlite'),planner=new Planner({store,dataDirectory:'.data/model-eval'});
const CASES={
 backend:{cv:'Deniz Example\nBackend Software Engineer\nPython, FastAPI, PostgreSQL, Docker, REST APIs and distributed systems. Four years building backend services.\nExperience: Backend Engineer at Example Corp (2021–2025): designed APIs, data pipelines and CI/CD.',country:'turkey',
  yes:['Backend Engineer','Backend Developer','Software Engineer, Backend','Backend Engineer (Python)','Softwareentwickler Backend (m/w/d)','Backend Yazılım Geliştirici','Senior Backend Engineer','Python Backend Developer','Software Engineer'],
  no:['Frontend Developer','Frontend Engineer (React)','iOS Developer','Data Analyst','Account Executive','Graphic Designer','QA Engineer','Sales Engineer','Registered Nurse','UX Designer']},
 nurse:{cv:'Ayşe Örnek\nYoğun Bakım Hemşiresi\nHasta takibi, ilaç uygulamaları, yoğun bakım protokolleri, 6 yıl deneyim. Ankara Şehir Hastanesi.',country:'turkey',
  yes:['Hemşire','Yoğun Bakım Hemşiresi','Registered Nurse','ICU Nurse','Staff Nurse','Servis Hemşiresi'],
  no:['Physician','Doktor','Pharmacist','Medical Sales Representative','Dental Assistant','Accountant','Software Engineer','Veteriner Hekim']},
 ml:{cv:'Can Demo\nMachine Learning Engineer\nPyTorch, computer vision, LLM fine-tuning, MLOps; 3 years training and deploying models.',country:'germany',
  yes:['Machine Learning Engineer','AI Engineer','ML Engineer','Deep Learning Engineer','Computer Vision Engineer','Applied Scientist','KI-Ingenieur'],
  no:['Frontend Developer','Data Analyst','Sales Manager','Mechanical Engineer','Product Designer','Recruiter','IT Support Specialist']},
 accountant:{cv:'Demo Person\nSenior Accountant\nIFRS reporting, month-end close, reconciliations, SAP, audits; 9 years in manufacturing.',country:'uk',
  yes:['Accountant','Senior Accountant','Financial Accountant','Management Accountant','Staff Accountant'],
  no:['Financial Analyst','Auditor','Bookkeeper','HR Specialist','Sales Representative','Software Engineer','Tax Advisor']},
 chef:{cv:'Demo Cook\nSous Chef\nMenu planning, kitchen team supervision, food safety (HACCP), banquet service for 300 guests',country:'usa',
  yes:['Sous Chef','Chef','Line Cook','Cook','Chef de Partie','Head Chef'],
  no:['Dishwasher','Waiter','Bartender','Restaurant Manager','Food Scientist','Software Engineer']}
};
const report={utc:new Date().toISOString(),scope:'Five synthetic CV profiles, 33 intended and 38 negative titles. Local CPU role-routing check, not real employer submissions, market recall or a representative accuracy benchmark. Title gate is comparable with prior rival-roles.txt; pipeline gate also checks CV similarity and default production rankJobs. All synthetic jobs are worldwide; no authorization is inferred.',profiles:[],source_sha256:{}};
for(const [name,c]of Object.entries(CASES)){
 const tick=performance.now();
 const plan=await planner.plan(c.cv,{country:c.country});
 const jobs=[...c.yes,...c.no].map((title,i)=>({id:name+i,title,description:'',location:'Worldwide',apply_url:'https://example.test/jobs/'+name+i}));
 const rel=await planner.relevance(jobs,plan);
 const ranked=rankJobs(jobs,{queries:plan.queries,semantic:rel,early:plan.early,hours_old:0}),actual=new Map([...ranked.results.map(j=>[j.id,j.match]),...ranked.excluded.map(j=>[j.id,j.match])]);
 const verdict=job=>{const r=rel.get(job.id),auto=(r.occupation_match||r.role>=RELEVANCE.auto)&&!r.rival,show=r.occupation_match||r.role>=RELEVANCE.show;return{auto,show,r};};
 const fmt=job=>{const {auto,show,r}=verdict(job);return `${auto?'AUTO':show?'show':' -- '} ${job.title} (${r.role}${r.rival?' rival '+r.rival+' '+r.rival_score:''})`;};
 console.log(`\n== ${name}: roles ${plan.roles.map(r=>r.title).join(' | ')} · rivals ${plan.rivals.length}`);
 console.log(' should apply:');for(const job of jobs.slice(0,c.yes.length))console.log('  ',fmt(job));
 console.log(' should NOT auto-apply:');for(const job of jobs.slice(c.yes.length))console.log('  ',fmt(job));
 const tp=jobs.slice(0,c.yes.length).filter(j=>verdict(j).auto).length,fp=jobs.slice(c.yes.length).filter(j=>verdict(j).auto).length;
 console.log(` => recall ${tp}/${c.yes.length} · false auto ${fp}/${c.no.length}`);
 const decisions=jobs.map((job,i)=>({title:job.title,expected:i<c.yes.length?'intended':'negative',title_gate_auto:!!verdict(job).auto,pipeline_auto:actual.get(job.id)?.auto_selectable||false,semantic:rel.get(job.id)}));
 report.profiles.push({name,queries:plan.queries,elapsed_ms:Math.round(performance.now()-tick),intended:c.yes.length,negative:c.no.length,title_true:tp,title_false:fp,pipeline_true:decisions.filter(d=>d.expected==='intended'&&d.pipeline_auto).length,pipeline_false:decisions.filter(d=>d.expected==='negative'&&d.pipeline_auto).length,decisions});
}
report.totals=Object.fromEntries(['intended','negative','title_true','title_false','pipeline_true','pipeline_false'].map(k=>[k,report.profiles.reduce((sum,p)=>sum+p[k],0)]));
const checkJob={id:'gate',title:'Backend Developer',description:'Python APIs',skills:['Python'],location:'Worldwide',apply_url:'https://example.test/gate'};
const pending=rankJobs([checkJob],{queries:['Backend Developer'],semantic:new Map()});
const constrained=rankJobs([checkJob],{queries:['title:Frontend AND NOT skill:Python'],explicit:true,semantic:new Map([['gate',{role:1,score:1,overall:1,occupation_match:true}]])});
report.gates={unscored_auto_count:pending.results.filter(j=>j.match.auto_selectable).length,explicit_constraint_mismatch_auto_count:constrained.results.filter(j=>j.match.auto_selectable).length};
if(report.gates.unscored_auto_count||report.gates.explicit_constraint_mismatch_auto_count)throw new Error('Automatic routing gate failed.');
report.taxonomy=occupationStats();report.encoder=semanticStats();report.process_rss_mb=Math.round(process.memoryUsage().rss/1048576);
for(const file of ['web/lib/planner.mjs','web/lib/matching.mjs','web/lib/occupations.mjs','config/occupations.esco.json.gz'])report.source_sha256[file]=createHash('sha256').update(readFileSync(file)).digest('hex');
writeFileSync('reports/model-layer/application-routing-18oct.json',JSON.stringify(report,null,2)+'\n');store.close();
console.log(JSON.stringify({totals:report.totals,rss_mb:report.process_rss_mb}));
