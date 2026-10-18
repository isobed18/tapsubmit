// Bounded model comparison: do job titles land nearest to their own occupation family across languages?
// Leave-one-out nearest neighbour over 14 families x EN/TR/DE/ES titles. Not a test suite.
// Usage: node scripts/probe_title_families.mjs <model> [<model> ...]
import {pipeline,env} from '../web/node_modules/@huggingface/transformers/dist/transformers.node.mjs';
import {readFileSync} from 'node:fs';
env.cacheDir=process.env.APPLYBURST_MODEL_CACHE||'D:/cache/models';
const FAMILIES={
 backend:['Backend Developer','Backend Engineer','Software Engineer, Backend','Backend Yazılım Geliştirici','Backend-Entwickler (m/w/d)','Desarrollador Backend'],
 frontend:['Frontend Developer','Frontend Engineer (React)','Frontend Geliştirici','Frontend-Entwickler','Desarrollador Frontend'],
 ml:['Machine Learning Engineer','AI Engineer','ML Engineer','Deep Learning Engineer','Yapay Zeka Mühendisi','KI-Ingenieur','Ingeniero de Machine Learning'],
 data_analyst:['Data Analyst','Business Intelligence Analyst','Veri Analisti','Datenanalyst','Analista de Datos'],
 qa:['QA Engineer','Test Automation Engineer','Yazılım Test Uzmanı','Softwaretester','Ingeniero QA'],
 nurse:['Registered Nurse','ICU Nurse','Hemşire','Yoğun Bakım Hemşiresi','Pflegefachkraft','Enfermera'],
 physician:['Physician','General Practitioner','Doktor','Pratisyen Hekim','Arzt','Médico'],
 accountant:['Accountant','Financial Accountant','Muhasebe Uzmanı','Muhasebeci','Buchhalter','Contable'],
 auditor:['Auditor','Internal Auditor','Denetçi','İç Denetçi','Wirtschaftsprüfer','Auditor Interno'],
 chef:['Chef','Sous Chef','Cook','Aşçı','Koch','Cocinero'],
 waiter:['Waiter','Server (Restaurant)','Garson','Kellner','Camarero'],
 sales:['Sales Representative','Account Executive','Satış Temsilcisi','Vertriebsmitarbeiter','Representante de Ventas'],
 mech:['Mechanical Engineer','Makine Mühendisi','Maschinenbauingenieur','Ingeniero Mecánico'],
 teacher:['Teacher','Primary School Teacher','Öğretmen','Lehrer','Profesor de Primaria']};
const seedText=readFileSync(new URL('../web/lib/planner.mjs',import.meta.url),'utf8'),seed=[...seedText.matchAll(/`([^`]+)`\.split\('\|'\)/g)].flatMap(m=>m[1].split('|'));
const fold=t=>' '+t.toLocaleLowerCase('tr').normalize('NFKD').replace(/[̀-ͯ]/g,'').replace(/ı/g,'i').replace(/\([^)]*\)/g,' ').replace(/[^\p{L}\p{N}]+/gu,' ').trim()+' ';
const grams=t=>{const f=fold(t),out=new Map();for(let i=0;i<f.length-2;i++){const g=f.slice(i,i+3);out.set(g,(out.get(g)||0)+1);}return out;};
const items=Object.entries(FAMILIES).flatMap(([family,titles])=>titles.map(title=>({family,title})));
const corpus=[...new Set([...seed,...Object.values(FAMILIES).flat()])],df=new Map();for(const t of corpus)for(const g of grams(t).keys())df.set(g,(df.get(g)||0)+1);
const tfidf=t=>{const v=new Map();let n=0;for(const [g,c]of grams(t)){const w=c*Math.log(1+corpus.length/(df.get(g)||1));v.set(g,w);n+=w*w;}n=Math.sqrt(n)||1;for(const [g,w]of v)v.set(g,w/n);return v;};
const lexv=items.map(i=>tfidf(i.title)),lex=(a,b)=>{let s=0;for(const [g,w]of lexv[a])s+=w*(lexv[b].get(g)||0);return s;};
for(const model of process.argv.slice(2)){
 const [id,mode='none']=model.split('#'),t0=performance.now(),ex=await pipeline('feature-extraction',id,{dtype:'q8',device:'cpu'}),load=performance.now()-t0;
 const pre=t=>mode==='e5'?'query: '+t:t,t1=performance.now(),out=await ex(items.map(i=>pre(i.title)),{pooling:'mean',normalize:true}),encode=performance.now()-t1;
 const [n,d]=out.dims,v=Array.from({length:n},(_,i)=>out.data.subarray(i*d,(i+1)*d)),dot=(a,b)=>{let s=0;for(let k=0;k<d;k++)s+=a[k]*b[k];return s;};
 for(const lambda of [0,0.15,0.3,0.45]){
 let correct=0,margins=[];const errors=[];
 items.forEach((item,i)=>{let same=-1,other=-1,otherTitle='';items.forEach((x,j)=>{if(i===j)return;const s=dot(v[i],v[j])+lambda*lex(i,j);if(x.family===item.family){if(s>same)same=s;}else if(s>other){other=s;otherTitle=x.title;}});if(same>other)correct++;else errors.push(`${item.title} -> ${otherTitle} (${other.toFixed(2)} vs ${same.toFixed(2)})`);margins.push(same-other);});
 margins.sort((a,b)=>a-b);
 console.log(`== ${id}${mode!=='none'?' ['+mode+']':''} lexical λ=${lambda}: nearest-family ${correct}/${n} · median margin ${margins[n>>1].toFixed(3)} · p10 ${margins[Math.floor(n*0.1)].toFixed(3)} · load ${Math.round(load)} ms · ${(encode/n).toFixed(1)} ms/title · rss ${Math.round(process.memoryUsage().rss/1048576)} MB`);
 if(lambda===0.3)for(const e of errors.slice(0,12))console.log('   x '+e);
 }
}
