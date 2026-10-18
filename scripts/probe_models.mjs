// Compare small multilingual encoders on cross-language CV -> title neighbours (bounded probe, not a suite).
import {pipeline,env} from '../web/node_modules/@huggingface/transformers/dist/transformers.node.mjs';
env.cacheDir='D:/cache/models';
const titles=['Machine Learning Engineer','Registered Nurse','Hemşire','Muhasebe Uzmanı','Accountant','Frontend Developer','Data Analyst','Sales Representative','Mechanical Engineer','Maschinenbauingenieur','Teacher','Öğretmen','Software Engineer Intern','Senior Backend Engineer','Satış Temsilcisi','Krankenpfleger'];
const cvs={tr_nurse:['Yoğun bakım hemşiresi, 6 yıl deneyim, hasta bakımı, ilaç uygulama, Ankara',['Hemşire','Registered Nurse','Krankenpfleger']],en_ml_student:['Computer engineering student, PyTorch, LangGraph agents, computer vision projects, internship',['Machine Learning Engineer','Software Engineer Intern']],de_mech:['Maschinenbauingenieur mit SolidWorks und Fertigungserfahrung, München',['Maschinenbauingenieur','Mechanical Engineer']],en_accountant:['Accountant with IFRS, SAP, month-end close, tax filings',['Accountant','Muhasebe Uzmanı']],tr_sales:['Saha satış temsilcisi, müşteri portföyü yönetimi, hedef bazlı satış, B2B',['Satış Temsilcisi','Sales Representative']],en_teacher:['Primary school teacher, lesson planning, classroom management, 8 years',['Teacher','Öğretmen']]};
for(const [model,mode,dtype] of [['Xenova/multilingual-e5-small','asym','q8'],['Xenova/multilingual-e5-small','sym','q8'],['Xenova/paraphrase-multilingual-MiniLM-L12-v2','none','q8']]){
 const t0=performance.now();const ex=await pipeline('feature-extraction',model,{dtype,device:'cpu'});const load=performance.now()-t0;
 const pre=(t,k)=>mode==='none'?t:mode==='sym'?'query: '+t:k+': '+t;
 const emb=async(xs,k)=>{const o=await ex(xs.map(x=>pre(x,k)),{pooling:'mean',normalize:true});const [r,d]=o.dims;return Array.from({length:r},(_,i)=>o.data.subarray(i*d,(i+1)*d));};
 const tv=await emb(titles,'passage');let hits1=0,hits2=0;const lines=[];
 for(const [name,[text,good]] of Object.entries(cvs)){const [v]=await emb([text],'query');const ranked=titles.map((t,i)=>[t,tv[i].reduce((s,x,j)=>s+x*v[j],0)]).sort((a,b)=>b[1]-a[1]);if(good.includes(ranked[0][0]))hits1++;if(ranked.slice(0,2).every(([t])=>good.includes(t))||good.length<2&&good.includes(ranked[0][0]))hits2++;lines.push(name.padEnd(13)+ranked.slice(0,3).map(([t,s])=>t+' '+s.toFixed(3)).join(' | '));}
 const batch=Array.from({length:64},(_,i)=>'Senior Python developer to build data pipelines and APIs with FastAPI, PostgreSQL and AWS. '.repeat(3)+i);const t1=performance.now();await emb(batch,'passage');const ms=performance.now()-t1;
 console.log(`== ${model} [${mode}] top1 ${hits1}/6, top2-all-correct ${hits2}/6, load ${Math.round(load)}ms, ${(ms/64).toFixed(1)}ms/job`);for(const l of lines)console.log('   '+l);
}
console.log('rss_mb',Math.round(process.memoryUsage().rss/1048576));
