// Bounded measurement of CV -> search plan for synthetic profiles across professions and languages.
// Uses a snapshot copy of the local job pool; prints plans and timing. Not a test suite.
import {DatabaseSync} from 'node:sqlite';
import {existsSync,mkdirSync,rmSync} from 'node:fs';
import {Planner} from '../web/lib/planner.mjs';
import {semanticStats} from '../web/lib/semantic.mjs';
const source=process.argv[2]||'.data/desktop-live/portal.sqlite',copy='.data/model-eval/planner.sqlite';mkdirSync('.data/model-eval',{recursive:true});
if(!existsSync(copy)){const db=new DatabaseSync(source,{readOnly:true});db.exec(`VACUUM INTO '${copy}'`);db.close();}
const db=new DatabaseSync(copy),store={db};
const PROFILES={
 tr_nurse:'Ayşe Demo\nYoğun Bakım Hemşiresi\n6 yıl deneyim. Hasta bakımı, ilaç uygulama, triyaj, hasta dosyası yönetimi.\nAnkara Şehir Hastanesi, Yoğun Bakım Ünitesi',
 en_ml_student:'Demo Student\nComputer Engineering Student (expected 2027)\nProjects: LangGraph multi-agent assistant, YOLO object detection, PyTorch model training\nInternship: AI research intern',
 de_mech:'Max Demo\nMaschinenbauingenieur\n8 Jahre Erfahrung in Konstruktion und Fertigung, SolidWorks, FEM-Analyse, Lean Production, München',
 en_senior_accountant:'Demo Person\nSenior Accountant, CPA\n12 years: IFRS reporting, SAP FI, month-end close, consolidation, audit liaison',
 tr_sales:'Demo Kişi\nSaha Satış Temsilcisi\nB2B müşteri portföyü yönetimi, hedef bazlı satış, bayi ziyaretleri, CRM kullanımı. İstanbul',
 en_teacher:'Demo Teacher\nPrimary School Teacher\nLesson planning, classroom management, differentiated instruction, 8 years in public schools',
 en_frontend:'Demo Dev\nFrontend Developer\nReact, TypeScript, Next.js, accessibility, design systems; 4 years building SaaS dashboards',
 tr_civil_grad:'Demo Mezun\nİnşaat Mühendisi (Yeni Mezun)\nSaha stajı: betonarme yapı denetimi, AutoCAD, metraj ve hakediş hazırlama',
 en_chef:'Demo Cook\nSous Chef\nMenu planning, kitchen team supervision, food safety (HACCP), banquet service for 300 guests',
 en_junior_analyst:'Demo Analyst\nJunior Data Analyst\nSQL, Excel, Power BI dashboards, A/B test reporting; 1 year experience after graduation',
 es_marketing:'Demo Persona\nEspecialista en Marketing Digital\nCampañas en redes sociales, SEO, Google Ads, análisis de métricas, Madrid',
 en_warehouse:'Demo Worker\nWarehouse Associate\nForklift certified, inventory counts, order picking and packing, shipping and receiving'
};
const planner=new Planner({store,dataDirectory:'.data/model-eval'});
const t0=performance.now();await planner.titleCatalog();const catalogMs=performance.now()-t0;
const rows=[];
const MARKET={tr_nurse:'turkey',tr_sales:'turkey',tr_civil_grad:'turkey',de_mech:'germany',es_marketing:'spain'};
for(const [name,text] of Object.entries(PROFILES)){const plan=await planner.plan(text,{country:MARKET[name]||'usa'});rows.push({name,queries:plan.queries,early:plan.early,ms:plan.elapsed_ms});console.log(name.padEnd(20),(plan.early?'[early] ':'        ')+plan.queries.join(' | ')+'  ('+plan.elapsed_ms+' ms, stage '+plan.stage.early+'/'+plan.stage.experienced+')');}
console.log(JSON.stringify({catalog_size:(await planner.titleCatalog()).length,catalog_first_build_ms:Math.round(catalogMs),cached_vectors:planner.cache.count(),rss_mb:Math.round(process.memoryUsage().rss/1048576),...semanticStats()}));
