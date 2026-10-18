// CV -> search plan -> relevance, for any profession and language, on CPU.
// One small multilingual encoder compares CV text with job titles; no per-CV weights, no role regexes.
import {VectorCache,dot,mean,textKey} from './semantic.mjs';
import {hash} from './jobs.mjs';
import {occupationFor,occupationAliases,occupationAnchors,occupationReferenceEntries} from './occupations.mjs';
import {profileFeatures,ROLES} from '../shared/features.mjs';
import {matchProfessionalTitles,professionalMatches,roleKey} from '../shared/professional.mjs';
import {parseQuery} from '../../demo/public/search-engine.mjs';

// Cross-sector seed of target roles. Data, not logic: the job pool adds every title it observes.
const SEED={en:`Software Engineer|Backend Developer|Frontend Developer|Full Stack Developer|Mobile Developer|iOS Developer|Android Developer|DevOps Engineer|Site Reliability Engineer|Cloud Engineer|Data Engineer|Data Scientist|Data Analyst|Business Intelligence Analyst|Machine Learning Engineer|AI Engineer|Computer Vision Engineer|NLP Engineer|Research Scientist|QA Engineer|Test Automation Engineer|Security Engineer|Cybersecurity Analyst|Network Engineer|System Administrator|IT Support Specialist|Database Administrator|Embedded Software Engineer|Game Developer|Product Manager|Project Manager|Program Manager|Scrum Master|Business Analyst|Product Designer|UX Designer|UI Designer|Graphic Designer|Technical Writer|Solutions Architect|Sales Engineer|Customer Success Manager|Account Executive|Sales Representative|Business Development Representative|Marketing Specialist|Digital Marketing Specialist|Content Writer|Social Media Specialist|SEO Specialist|Public Relations Specialist|Recruiter|HR Specialist|HR Business Partner|Payroll Specialist|Accountant|Financial Analyst|Auditor|Tax Specialist|Financial Controller|Investment Analyst|Bank Teller|Insurance Agent|Customer Service Representative|Call Center Agent|Office Manager|Administrative Assistant|Executive Assistant|Receptionist|Operations Manager|Supply Chain Specialist|Logistics Coordinator|Procurement Specialist|Warehouse Worker|Truck Driver|Delivery Driver|Mechanical Engineer|Electrical Engineer|Civil Engineer|Industrial Engineer|Chemical Engineer|Manufacturing Engineer|Quality Engineer|Production Planner|Maintenance Technician|Electrician|Welder|CNC Operator|Construction Worker|Architect|Interior Designer|Site Engineer|Environmental Engineer|Energy Engineer|Registered Nurse|Physician|General Practitioner|Dentist|Pharmacist|Physiotherapist|Psychologist|Medical Laboratory Technician|Radiology Technician|Caregiver|Veterinarian|Teacher|English Teacher|Mathematics Teacher|Preschool Teacher|University Lecturer|Teaching Assistant|Researcher|Lawyer|Legal Assistant|Paralegal|Compliance Specialist|Chef|Cook|Waiter|Barista|Hotel Receptionist|Housekeeper|Tour Guide|Flight Attendant|Pilot|Retail Sales Associate|Store Manager|Cashier|Real Estate Agent|Translator|Interpreter|Journalist|Editor|Video Editor|Photographer|Animator|Fitness Trainer|Security Guard|Cleaner|Social Worker|Event Coordinator|E-commerce Specialist|Category Manager|Merchandiser|Data Entry Clerk|Graduate Trainee|Software Engineering Intern|Machine Learning Intern|Data Science Intern|Marketing Intern|Finance Intern|Engineering Intern`.split('|'),
 tr:`Yazılım Mühendisi|Yazılım Geliştirici|Veri Analisti|Veri Bilimci|Makine Öğrenmesi Mühendisi|Yapay Zeka Mühendisi|Muhasebe Uzmanı|Mali Müşavir|Finans Uzmanı|Satış Temsilcisi|Satış Danışmanı|Müşteri Temsilcisi|Çağrı Merkezi Müşteri Temsilcisi|İnsan Kaynakları Uzmanı|İşe Alım Uzmanı|Pazarlama Uzmanı|Dijital Pazarlama Uzmanı|Grafik Tasarımcı|Proje Yöneticisi|Ürün Yöneticisi|İş Analisti|Makine Mühendisi|Elektrik Mühendisi|İnşaat Mühendisi|Endüstri Mühendisi|Kalite Mühendisi|Üretim Mühendisi|Bakım Teknisyeni|Elektrikçi|Kaynakçı|CNC Operatörü|Hemşire|Doktor|Diş Hekimi|Eczacı|Fizyoterapist|Psikolog|Öğretmen|İngilizce Öğretmeni|Okul Öncesi Öğretmeni|Avukat|Aşçı|Garson|Kasiyer|Mağaza Müdürü|Depo Personeli|Lojistik Uzmanı|Satın Alma Uzmanı|Şoför|Güvenlik Görevlisi|Temizlik Personeli|Sekreter|Ofis Asistanı|Stajyer|Teknik Destek Uzmanı|Sistem Yöneticisi|Ağ Uzmanı|Siber Güvenlik Uzmanı|Mobil Uygulama Geliştirici`.split('|'),
 de:`Softwareentwickler|Datenanalyst|Buchhalter|Vertriebsmitarbeiter|Pflegefachkraft|Krankenpfleger|Lehrer|Maschinenbauingenieur|Elektroingenieur|Bauingenieur|Kundenberater|Personalreferent|Projektleiter|Werkstudent|Praktikant|Koch|Verkäufer|Lagerarbeiter`.split('|')};
const MARKET_LANGUAGE={turkey:'tr',germany:'de'};
// Multilingual anchors for career stage, compared by meaning (not keyword lists over the CV).
const EARLY=['university student looking for an internship','new graduate with internship experience, entry level','üniversite öğrencisi, staj arıyor','yeni mezun, giriş seviyesi','Student auf der Suche nach einem Praktikum'];
const EXPERIENCED=['experienced professional with more than ten years of experience','senior specialist leading a team','on yılı aşkın deneyimli uzman, ekip lideri','erfahrene Fachkraft mit langjähriger Berufserfahrung'];
const LEVEL_WORDS=/\b(senior|sr\.?|lead|principal|staff|junior|jr\.?|head of|chief|intern|internship|trainee|working student|werkstudent|stajyer|kıdemli|uzman yardımcısı|i{1,3}|iv|v)\b|\(.*?\)|\[.*?\]/gi;
const NOISE=/(@|https?:\/\/|www\.|\+?\d[\d\s().-]{7,}\d|linkedin\.com|github\.com)/i;

export function normalizeTitle(title){
 let text=String(title||'').split(/\s[-–|/]\s|,|:/)[0].replace(LEVEL_WORDS,' ').replace(/[^\p{L}\p{N}+#.& ]/gu,' ').replace(/\s+/g,' ').trim();
 if(text.length<3||text.length>60||text.split(' ').length>6)return null;
 return text;
}
// CV text as a few professional chunks; contact lines are dropped before anything is embedded.
export function cvChunks(text,max=12){
 const lines=String(text||'').split(/\r?\n/).map(l=>l.replace(/\s+/g,' ').trim()).filter(l=>l.length>2&&!NOISE.test(l));
 const chunks=[];let current='';
 for(const line of lines){if((current+' '+line).length>320){if(current)chunks.push(current);current=line;}else current=current?current+' · '+line:line;if(chunks.length>=max)break;}
 if(current&&chunks.length<max)chunks.push(current);
 return chunks;
}
// Short lines near the top are where CVs state roles ("Yoğun Bakım Hemşiresi", "Sous Chef").
export function titleLines(text,max=12){return String(text||'').split(/\r?\n/).map(l=>l.replace(/\s+/g,' ').trim()).filter(l=>l.length>2&&!NOISE.test(l)).slice(0,max).filter(l=>l.split(' ').length<=7);}
// A graduation year still ahead is a student signal in every language (digits, not words).
// The encoder is case-sensitive: "BACKEND DEVELOPER" scores far from "Backend Developer". Shouting titles are
// lowercased (combining dots from Turkish İ removed); normal titles are left exactly as written.
export function tidyTitle(title){const text=String(title||'').trim();return /\p{Ll}/u.test(text)?text:text.toLowerCase().normalize('NFD').replace(/\u0307/g,'').normalize('NFC');}
export function futureYear(text,now=new Date()){const year=now.getFullYear();return[...String(text||'').matchAll(/\b(20\d\d)\b/g)].some(m=>Number(m[1])>year&&Number(m[1])<=year+6);}
export class Planner{
 constructor({store,dataDirectory}){this.store=store;this.cache=new VectorCache(store.db,dataDirectory);this.catalog=null;this.catalogAt=0;store.db.exec('CREATE TABLE IF NOT EXISTS job_relevance_cache(key TEXT PRIMARY KEY,value TEXT NOT NULL,created_at REAL NOT NULL); CREATE INDEX IF NOT EXISTS job_relevance_age ON job_relevance_cache(created_at);');}
 // Seed roles + normalized titles actually observed in the pool, refreshed at most every 10 minutes.
 async titleCatalog(){
  if(this.catalog&&Date.now()-this.catalogAt<600000)return this.catalog;
  const counts=new Map();for(const [lang,list]of Object.entries(SEED))for(const title of list)counts.set(title.toLowerCase(),{title,count:3,lang,seed:true});
  for(const row of this.store.db.prepare("SELECT json_extract(payload,'$.title') title FROM jobs WHERE active=1").all()){const t=normalizeTitle(row.title);if(!t)continue;const key=t.toLowerCase();const entry=counts.get(key)||{title:t,count:0};entry.count++;counts.set(key,entry);}
  const titles=[...counts.values()].sort((a,b)=>b.count-a.count).slice(0,6000);
  const vectors=await this.cache.vectors(titles.map(t=>t.title),'passage');
  this.catalog=titles.map((t,i)=>({...t,vector:vectors[i]}));this.catalogAt=Date.now();return this.catalog;
 }
 // Public role vocabulary for the browser: it finds these titles inside a CV locally and sends back only matches.
 // Includes the multilingual SEED roles plus multi-word ESCO occupations across professions.
 publicVocabulary(){
  if(this.publicRoles)return this.publicRoles;
  const primaryByLang=new Set(),seed=Object.entries(SEED).flatMap(([lang,list])=>list.map(title=>{const id=occupationFor(title)?.id||null,langKey=id?`${lang}:${id}`:null,attach=langKey&&!primaryByLang.has(langKey);if(attach)primaryByLang.add(langKey);return{title,occupation_id:id,aliases:attach?occupationAliases(title,lang):[]};}));
  const seenIds=new Set(seed.map(e=>e.occupation_id).filter(Boolean)),seenKeys=new Set(seed.map(e=>roleKey(e.title)));
  const extra=occupationReferenceEntries().filter(e=>!seenIds.has(e.occupation_id)&&!seenKeys.has(roleKey(e.title))).map(e=>({title:e.title,occupation_id:e.occupation_id,aliases:e.aliases.filter(a=>{const w=a.trim().split(/\s+/);return w.length>=2&&w.length<=5&&roleKey(a)!==roleKey(e.title);}).slice(0,5)})).filter(e=>e.title.trim().split(/\s+/).length>=2||e.aliases.length);
  this.publicRoles=[...seed,...extra];
  return this.publicRoles;
 }
 async vocabulary(){return this.publicVocabulary().map(entry=>entry.title);}
 async competitors(){
  if(!this.occupationCompetitors){const rows=occupationAnchors(),vectors=await this.cache.vectors(rows.map(row=>row.title),'passage');this.occupationCompetitors=rows.map((row,i)=>({...row,vector:vectors[i]}));}
  return this.occupationCompetitors;
 }
 // Professional signals are extracted locally. Public planning receives only validated labels/skills.
 // Keep each supported field instead of inferring a new career from generic CV section headings.
 async planSignals(titles,features,{country='worldwide',max=6}={}){
  const entries=this.publicVocabulary(),byName=new Map(entries.map(e=>[roleKey(e.title),e.title])),roles=[],anchors=new Map(),roleVectors=[];
  const add=(title,anchor=title,vector=null)=>{const canonical=byName.get(roleKey(title))||title;if(!roles.some(r=>roleKey(r)===roleKey(canonical))){roles.push(canonical);if(vector)roleVectors.push(vector);}anchors.set(canonical,anchor);};
  const valid=titles.filter(title=>byName.has(roleKey(title))),tv=valid.length?await this.cache.vectors(valid,'query'):[];
  const featureDefs=(features.roles||[]).map(id=>ROLES.find(r=>r.id===id)).filter(Boolean);
  const fv=featureDefs.length?await this.cache.vectors(featureDefs.map(r=>r.query),'query'):[];
  // Specific occupations outside the 28 ROLES buckets (e.g. Biomedical Engineer, Lawyer, Pharmacist,
  // Urban Planner, Industrial Engineer) lead when ROLES only matched a generic skill bucket.
  const genericOnly=featureDefs.length>0&&featureDefs.every(r=>['software','data-analysis','operations','finance','marketing'].includes(r.id));
  if(valid.length&&(!featureDefs.length||genericOnly&&!fv.some(v=>dot(v,tv[0])>=0.68)&&occupationFor(valid[0]))){
   add(valid[0],valid[0],tv[0]);
  }
  featureDefs.forEach((role,i)=>{
   if(!roleVectors.length||roleVectors.some(v=>dot(v,fv[i])>=0.65)||!genericOnly)add(role.query,role.anchor,fv[i]);
  });
  for(const [i,title]of valid.entries()){
   const id=occupationFor(title)?.id;
   if(!roleVectors.length||roleVectors.some(v=>dot(v,tv[i])>=0.68)||id&&roles.some(r=>occupationFor(anchors.get(r)||r)?.id===id))add(title,title,tv[i]);
  }
  if(!roles.length)return null;
  const primary=roles.slice(0,4),directions=[...primary];
  // ESCO's common concept expands the same profession (e.g. software engineer/developer).
  // Alternate queries broaden retrieval; the semantic target remains the declared profession.
  for(const title of primary){const identity=occupationFor(anchors.get(title));if(!identity)continue;const alternative=entries.find(e=>roleKey(e.title)!==roleKey(title)&&e.occupation_id===identity.id&&SEED.en.includes(e.title));if(alternative&&!directions.includes(alternative.title))directions.push(alternative.title);}
  // A reciprocal translation is safer than simply adding the nearest foreign engineer.
  // An AI title previously picked Yazılım Mühendisi although its reverse match is Software Engineer.
  const local=MARKET_LANGUAGE[country],catalog=await this.titleCatalog(),english=catalog.filter(e=>e.seed&&e.lang==='en');
  if(local)for(const title of primary){const id=occupationFor(anchors.get(title)||title)?.id,exactLocal=id&&SEED[local]?.find(t=>occupationFor(t)?.id===id),exactEn=id&&SEED.en.find(t=>occupationFor(t)?.id===id);if(exactEn&&!directions.some(d=>roleKey(d)===roleKey(exactEn))){directions.push(exactEn);anchors.set(exactEn,exactEn);}if(exactLocal&&!directions.some(d=>roleKey(d)===roleKey(exactLocal))){directions.push(exactLocal);anchors.set(exactLocal,exactLocal);continue;}const source=catalog.find(e=>roleKey(e.title)===roleKey(title)&&e.lang==='en');if(!source)continue;const twin=catalog.filter(e=>e.seed&&e.lang===local).map(e=>({...e,similarity:dot(source.vector,e.vector)})).sort((a,b)=>b.similarity-a.similarity)[0];if(!twin||twin.similarity<0.75)continue;const reverse=[...english].sort((a,b)=>dot(b.vector,twin.vector)-dot(a.vector,twin.vector))[0];if(reverse?.title===source.title){if(!directions.includes(twin.title))directions.push(twin.title);anchors.set(twin.title,twin.title);}}
  const early=features.level==='early';
  if(early&&!directions.some(d=>ENTRY_LEVEL.test(d))){
   const firstId=features.roles?.[0],internQuery=firstId==='agents'||firstId==='ai'||firstId==='ml'?'Machine Learning Intern':firstId==='data-science'||firstId==='data-analysis'||firstId==='data-engineering'?'Data Science Intern':firstId==='software'||firstId==='backend'||firstId==='frontend'||firstId==='mobile'||firstId==='devops'?'Software Engineering Intern':firstId==='marketing'?'Marketing Intern':firstId==='finance'||firstId==='accounting'?'Finance Intern':firstId==='mechanical'||firstId==='electrical'||firstId==='civil'?'Engineering Intern':null;
   if(internQuery&&!directions.some(d=>roleKey(d)===roleKey(internQuery))){
    if(directions.length>=max)directions.splice(max-1,1,internQuery);else directions.push(internQuery);
   }
  }
  const text=[...primary,'Skills: '+(features.skills||[]).join(', ')].join('\n');
  const targets=[...new Set([...primary,...primary.map(title=>anchors.get(title)),...directions.filter(title=>!SEED.en.includes(title)&&!ENTRY_LEVEL.test(title))])];
  const plan=await this.plan(text,{queries:targets,max:Math.max(max,targets.length),country,signals:false});
  plan.queries=directions.slice(0,max);plan.early=early;plan.explicit=false;plan.signal_titles=primary;
  return plan;
 }
 // Explicit queries win; otherwise the CV decides the directions. Returns plain search phrases in the
 // market's language plus English, chosen from clean seed roles (noisy pool titles never become queries).
 async plan(text,{queries=[],max=6,country='worldwide',signals=true}={}){
  if(signals&&!queries.length){const features=profileFeatures(text),titles=matchProfessionalTitles(text,this.publicVocabulary());const planned=await this.planSignals(titles,features,{country,max});if(planned)return planned;}
  const tick=performance.now(),chunks=cvChunks(text);if(!chunks.length&&!queries.length)return{queries:[],roles:[],early:false,elapsed_ms:0};
  const chunkVectors=chunks.length?await this.cache.vectors(chunks,'query'):[],cv=chunkVectors.length?mean(chunkVectors):null;
  const lines=titleLines(text),lineVectors=lines.length?await this.cache.vectors(lines,'query'):[];
  const anchors=await this.cache.vectors([...EARLY,...EXPERIENCED],'query'),probe=[...lineVectors,...chunkVectors];
  const best=(from,to)=>probe.length?Math.max(...probe.flatMap(v=>anchors.slice(from,to).map(a=>dot(v,a)))):0;
  const earlySim=best(0,EARLY.length),seniorSim=best(EARLY.length,anchors.length),early=futureYear(text)||earlySim>seniorSim+EARLY_MARGIN;
  const local=MARKET_LANGUAGE[country];
  if(queries.length){
   // Embed professional intent, not Boolean punctuation, field names or excluded occupations.
   // Keep the original query for exact filtering by rankJobs; title constraints steer role meaning.
   const phrases=queries.map(query=>{const terms=[];const visit=(node,negated=false)=>{if(node.type==='term'&&!negated&&(!node.field||node.field==='title'||node.field==='skill'||node.field==='description'))terms.push(node);if(node.child)visit(node.child,!negated);if(node.left)visit(node.left,negated);if(node.right)visit(node.right,negated);};visit(parseQuery(query));const titles=terms.filter(t=>t.field==='title');return(titles.length?titles:terms).map(t=>t.value).join(' ');}).filter(Boolean);
   const vectors=await this.cache.vectors(phrases,'query'),catalog=await this.titleCatalog(),rivals=[...catalog.filter(e=>e.seed&&(e.lang==='en'||e.lang===local)&&!phrases.some(p=>roleKey(p)===roleKey(e.title))).map(e=>({title:e.title,vector:e.vector})),...await this.competitors()];return{queries:queries.slice(0,max),roles:phrases.map((q,i)=>({title:q,score:1,vector:vectors[i]})),rivals,early,cv,explicit:true,stage:{early:+earlySim.toFixed(3),experienced:+seniorSim.toFixed(3)},elapsed_ms:Math.round(performance.now()-tick)};
  }
  const catalog=await this.titleCatalog();
  const maxOf=(vectors,entry)=>{let top=0;for(const v of vectors){const s=dot(v,entry.vector);if(s>top)top=s;}return top;};
  const score=entry=>0.5*(lineVectors.length?maxOf(lineVectors,entry):maxOf(chunkVectors,entry))+0.3*maxOf(chunkVectors,entry)+0.2*dot(cv,entry.vector);
  // Every seed language competes in its own language (a Turkish headline matches "Hemşire" better than any
  // English title). Translations to English are not trusted blindly: the encoder puts Maschinenbauingenieur
  // nearer "Industrial" than "Mechanical Engineer", so the English direction also weighs the CV's own evidence.
  // Third languages only add cross-lingual noise (an English teacher CV scored a Turkish title highest).
  const seeds=catalog.filter(e=>e.seed&&(e.lang==='en'||e.lang===local)),english=seeds.filter(e=>e.lang==='en'),scoreOf=new Map();
  const lineOf=entry=>lineVectors.length?maxOf(lineVectors,entry):0;
  const ranked=seeds.map(e=>{const s=score(e);scoreOf.set(e.title,s);return{...e,score:s,line:lineOf(e)};}).sort((a,b)=>b.score-a.score),top=ranked[0]?.score||0,topLine=ranked[0]?.line||0;
  // English for a local role: the translation best supported by meaning plus the CV's own evidence. Only one:
  // this encoder ties "Physician" with "Registered Nurse" for Hemşire, exactly as it ties "Civil Engineer" with
  // "Construction Worker" for İnşaat Mühendisi (scripts/probe_translations.mjs). The local role itself remains a
  // relevance anchor, so correct-language jobs still match.
  const englishFor=entry=>{if(entry.lang==='en')return[entry];const identity=occupationFor(entry.title),exact=identity&&english.find(e=>occupationFor(e.title)?.id===identity.id);if(exact)return[{...exact,score:scoreOf.get(exact.title)}];const best=english.map(e=>({...e,score:scoreOf.get(e.title),sim:dot(e.vector,entry.vector)})).filter(e=>e.sim>=0.6).sort((a,b)=>b.sim+b.score-a.sim-a.score)[0];return best?[best]:[];};
  // Target roles: only roles nearly as strong as the best one (a weak second role is how a nurse CV used to
  // search for physicians), skipping near-duplicates. Early careers may add their closest entry-level role.
  const targets=[];for(const candidate of ranked.slice(0,60)){if(targets.length>=max)break;if(targets.length&&candidate.score<top-TARGET_MARGIN)break;if(targets.length&&candidate.line<topLine-LINE_MARGIN)continue;if(Math.max(0,...targets.map(t=>dot(t.vector,candidate.vector)))>0.8)continue;targets.push(candidate);}
  const topEnglish=ranked.find(c=>c.lang==='en')?.score||top;
  if(early&&targets.length<max&&!targets.some(t=>ENTRY_LEVEL.test(t.title))){const entry=ranked.find(c=>c.lang==='en'&&ENTRY_LEVEL.test(c.title)&&c.score>=topEnglish-0.15);if(entry)targets.push(entry);}
  // Queries: English plus the market's language; roles in other languages only anchor relevance.
  const directions=[],add=entry=>{if(entry&&!directions.some(q=>q.title===entry.title))directions.push(entry);};
  for(const target of targets){add(target);if(directions.length===1&&!directions.some(q=>q.lang==='en'))englishFor(target).forEach(add);}
  if(local&&directions.length&&!directions.some(q=>q.lang===local)){const anchor=directions.find(q=>q.lang==='en')||directions[0],twin=seeds.filter(e=>e.lang===local).map(e=>({...e,score:scoreOf.get(e.title),sim:dot(e.vector,anchor.vector)})).sort((a,b)=>b.sim-a.sim)[0];if(twin&&twin.sim>=0.6)directions.splice(1,0,twin);}
  const picked=directions.slice(0,max+(local?1:0)),roles=[...new Map([...targets,...picked].map(r=>[r.title,r])).values()];
  // Compare with ALL unselected occupation anchors, not just siblings already close to the CV.
  // Filtering rivals by CV similarity missed Financial Analyst for Accountant, and management words in
  // a chef's CV hid Restaurant Manager. A clearly better alternative title is review evidence, not
  // authorization to apply. It can still be displayed; a user can choose that target explicitly.
  const rivals=[...seeds.filter(e=>!roles.some(r=>roleKey(r.title)===roleKey(e.title))).map(e=>({title:e.title,vector:e.vector})),...await this.competitors()];
  return{queries:picked.map(c=>c.title),roles:roles.map(c=>({title:c.title,score:+c.score.toFixed(3),vector:c.vector})),rivals,candidates:ranked.slice(0,12).map(c=>[c.title,+c.score.toFixed(3),c.lang]),early,cv,explicit:false,stage:{early:+earlySim.toFixed(3),experienced:+seniorSim.toFixed(3)},elapsed_ms:Math.round(performance.now()-tick),catalog_size:catalog.length};
 }
 pruneRelevanceCache({maxRows=25000,ttlSeconds=7*86400}={}){
  const now=Date.now()/1000;
  this.store.db.prepare('DELETE FROM job_relevance_cache WHERE created_at<?').run(now-ttlSeconds);
  const count=this.store.db.prepare('SELECT count(*) n FROM job_relevance_cache').get().n;
  if(count>maxRows){
   const excess=count-maxRows;
   this.store.db.prepare('DELETE FROM job_relevance_cache WHERE key IN (SELECT key FROM job_relevance_cache ORDER BY created_at ASC LIMIT ?)').run(excess);
  }
 }
 // Relevance of jobs to the plan: closest role by title, plus overall CV similarity. Cached job vectors.
 async relevance(jobs,plan){
  if(!jobs.length||!plan?.roles?.length)return new Map();
  // Every search direction is also a relevance anchor: a Turkish CV searched as "Supply Chain Specialist"
  // must recognise English "Logistics Specialist" postings, not only ones close to "Lojistik Uzmanı".
  if(!plan.query_anchored){plan.query_anchored=true;const extra=(plan.queries||[]).filter(q=>!plan.roles.some(r=>roleKey(r.title)===roleKey(q)));if(extra.length){const vectors=await this.cache.vectors(extra,'query');plan.roles=[...plan.roles,...extra.map((title,i)=>({title,score:0,vector:vectors[i]}))];}}
  // Exact reuse only: same model, role vectors, minimized profile vector and posting text.
  // This is not cross-CV similarity retrieval. Changes to either side invalidate the result.
  const relevanceKey=hash({version:PLAN_VERSION,model:textKey('model'),roles:plan.roles.map(r=>[r.title,hash(Buffer.from(r.vector.buffer,r.vector.byteOffset,r.vector.byteLength))]),rivals:plan.rivals?.length||0,cv:plan.cv?hash(Buffer.from(plan.cv.buffer,plan.cv.byteOffset,plan.cv.byteLength)):null});
  plan.relevance_key=relevanceKey;
  const get=this.store.db.prepare('SELECT value FROM job_relevance_cache WHERE key=?'),out=new Map(),missing=[],keys=new Map();
  for(const job of jobs){const key=hash([relevanceKey,job.title,String(job.description||'').replace(/<[^>]+>/g,' ').slice(0,400)]);keys.set(job.id,key);const cached=get.get(key);if(cached)out.set(job.id,JSON.parse(cached.value));else missing.push(job);}
  if(missing.length){const fresh=await this.freshRelevance(missing,plan),put=this.store.db.prepare('INSERT OR REPLACE INTO job_relevance_cache VALUES(?,?,?)'),now=Date.now()/1000;this.store.db.exec('BEGIN');try{for(const [id,value]of fresh){out.set(id,value);put.run(keys.get(id),JSON.stringify(value),now);}this.pruneRelevanceCache();this.store.db.exec('COMMIT');}catch(error){this.store.db.exec('ROLLBACK');throw error;}}
  return out;
 }
 async freshRelevance(jobs,plan){
  if(!jobs.length||!plan?.roles?.length)return new Map();
  const primary=title=>tidyTitle(title).split(/\s[-–—|]\s|\s*:\s*/)[0];
  const core=title=>normalizeTitle(title)||primary(title);
  const titles=await this.cache.vectors(jobs.map(j=>tidyTitle(j.title)),'passage'),heads=await this.cache.vectors(jobs.map(j=>primary(j.title)),'passage'),cores=await this.cache.vectors(jobs.map(j=>core(j.title)),'passage');
  // Domain prefixes (AI, software, robotics...) cannot conceal the function itself:
  // e.g. AI Healthcare Specialist / Software Support Engineer / Technical Mentor.
  const functionHeads=jobs.map(job=>primary(job.title).replace(/[^\p{L}\p{N}+# ]/gu,' ').trim().split(/\s+/).slice(-2).join(' '));
  const functionVectors=await this.cache.vectors(functionHeads,'passage');
  // The longer title+description text only matters for jobs whose title is already close to a target role.
  const near=jobs.map((job,i)=>plan.roles.some(r=>Math.max(dot(r.vector,titles[i]),dot(r.vector,cores[i]))>=RELEVANCE_FLOOR-0.1)),textOf=job=>[tidyTitle(job.title),String(job.description||'').replace(/<[^>]+>/g,' ').slice(0,400)].join(' · ');
  const wanted=plan.cv?jobs.filter((job,i)=>near[i]):[],vectors=wanted.length?await this.cache.vectors(wanted.map(textOf),'passage'):[],byId=new Map(wanted.map((job,i)=>[job.id,vectors[i]]));
  const texts=plan.cv?jobs.map(job=>byId.get(job.id)||null):null;
  const identities=new Set(plan.roles.map(r=>occupationFor(r.title)?.id).filter(Boolean));
  const targetKeys=new Set(plan.roles.map(r=>roleKey(r.title)));
  const competitors=(plan.rivals||[]).filter(r=>!ENTRY_LEVEL.test(r.title)&&!targetKeys.has(roleKey(r.title))&&!identities.has(r.occupation_id||occupationFor(r.title)?.id));
  const entries=occupationReferenceEntries();
  const out=new Map();jobs.forEach((job,i)=>{let role=-1,match=null,rival=-1,other=null;for(const r of plan.roles){const s=Math.max(dot(r.vector,titles[i]),dot(r.vector,cores[i]));if(s>role){role=s;match=r.title;}}for(const r of competitors){const s=Math.max(dot(r.vector,titles[i]),dot(r.vector,heads[i]),dot(r.vector,cores[i]),dot(r.vector,functionVectors[i]));if(s>rival){rival=s;other=r.title;}}
   const mentions=professionalMatches(primary(job.title),entries),targetMention=mentions.some(m=>targetKeys.has(roleKey(m.title))||m.occupation_id&&identities.has(m.occupation_id)),foreign=mentions.find(m=>!targetKeys.has(roleKey(m.title))&&!(m.occupation_id&&identities.has(m.occupation_id)));
   // "AI Sales Engineer" names Sales Engineer, not AI Engineer. Likewise a domain suffix
   // after a title separator cannot turn a sales job into a software engineering job.
   const namedRival=!targetMention&&foreign?foreign.title:null;
   const occupation=occupationFor(job.title),same=!!occupation&&identities.has(occupation.id)||mentions.some(m=>m.occupation_id&&identities.has(m.occupation_id));
   const rawOverall=texts?.[i]?dot(plan.cv,texts[i]):role,overall=same?Math.max(rawOverall,role*0.75):rawOverall;out.set(job.id,{role:+role.toFixed(3),overall:+overall.toFixed(3),score:+(0.7*role+0.3*overall).toFixed(3),closest_role:match,...(occupation?{occupation_id:occupation.id,occupation_match:same}:{}),...(same?{occupation_match:true}:{}),...(!same&&(namedRival||rival>=0.75&&rival-role>=RIVAL_MARGIN)?{rival:namedRival||other,rival_score:+rival.toFixed(3)}:{})});});
  return out;
 }
}
export const RELEVANCE_FLOOR=0.5;
// Bump when planning changes so stored CV plans are recomputed.
export const PLAN_VERSION='2026-10-18.7';
const TARGET_MARGIN=0.06,LINE_MARGIN=0.1,RIVAL_MARGIN=0.08,ENTRY_LEVEL=/\b(intern|trainee)\b/i;
const EARLY_MARGIN=0.15;
