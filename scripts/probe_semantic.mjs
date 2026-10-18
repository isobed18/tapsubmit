// Bounded probe of the semantic layer: load time, speed, RSS and a few cross-language neighbours.
import {embed,dot,semanticStats} from '../web/lib/semantic.mjs';
const titles=['Machine Learning Engineer','Registered Nurse','Hemşire','Muhasebe Uzmanı','Accountant','Frontend Developer','Data Analyst','Sales Representative','Mechanical Engineer','Maschinenbauingenieur','Teacher','Öğretmen','Software Engineer Intern','Senior Backend Engineer'];
const t0=performance.now(),tv=await embed(titles,'passage'),first=performance.now()-t0;
const cvs={tr_nurse:'Yoğun bakım hemşiresi, 6 yıl deneyim, hasta bakımı, ilaç uygulama, Ankara',en_ml_student:'Computer engineering student, PyTorch, LangGraph agents, computer vision projects, internship',de_mech:'Maschinenbauingenieur mit SolidWorks und Fertigungserfahrung, München',en_accountant:'Accountant with IFRS, SAP, month-end close, tax filings'};
for(const [name,text] of Object.entries(cvs)){const [v]=await embed([text],'query');console.log(name.padEnd(14),titles.map((t,i)=>[t,dot(v,tv[i])]).sort((a,b)=>b[1]-a[1]).slice(0,4).map(([t,s])=>t+' '+s.toFixed(3)).join(' | '));}
const batch=Array.from({length:64},(_,i)=>'Senior Python developer to build data pipelines and APIs with FastAPI, PostgreSQL and AWS. '.repeat(3)+i);
const t1=performance.now();await embed(batch,'passage');const ms=performance.now()-t1;
console.log(JSON.stringify({first_call_ms_including_load:Math.round(first),batch64_ms:Math.round(ms),per_job_ms:+(ms/64).toFixed(1),rss_mb:Math.round(process.memoryUsage().rss/1048576),...semanticStats()}));
