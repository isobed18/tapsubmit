// CV -> reusable application settings. Rules read the CV first; an optional local CPU model may only
// fill fields the rules left empty, and every value must appear in the CV. Precedence when saving:
// a value the person typed > application notes > CV. A new CV replaces only CV-sourced values.
import {randomUUID} from 'node:crypto';
import {savePreferences,preferenceSpec} from './preferences.mjs';
import {dateMentions} from './preference-editor.mjs';
const fold=s=>String(s||'').normalize('NFKD').replace(/[̀-ͯ]/g,'').replace(/ı/g,'i').replace(/İ/g,'i').toLowerCase().replace(/\s+/g,' ').trim();
const HEADINGS={
 experience:/^(?:work |professional |relevant |employment |career )?(?:experience|experiences|employment|work history|career history|is deneyimi|deneyim|tecrube|berufserfahrung|beruflicher werdegang|berufliche erfahrung|werdegang|experience professionnelle|experiences professionnelles|parcours professionnel|experiencia|esperienza)\b/,
 education:/^(?:education|academic|egitim|ogrenim|ausbildung|bildung|studium|formation|educacion|formacion|istruzione)\b/,
 other:/^(?:skills|technical|projects|personal projects|languages|certifications?|certificates|courses|awards|honou?rs|publications|references|interests|hobbies|volunteer|summary|profile|professional profile|about|objective|contact|ozet|profil|yetenek|yetkinlik|beceri|uzmanlik|projeler|diller|sertifika|referans|hobi|kenntnisse|kompetenz|technische|sprachen|projekte|competences|langues|habilidades|idiomas|extracurricular|activities|leadership|achievements)\b/,
};
export function sections(text){
 const out={header:[],experience:[],education:[],other:[]};let current='header';
 for(const raw of String(text||'').split(/\r?\n/)){
  const line=raw.trim();if(!line)continue;
  const key=fold(line).replace(/[^a-z ]/g,' ').replace(/\s+/g,' ').trim(),words=key.split(' ').length;
  // A heading is short and set apart (upper case, trailing colon or at most three words).
  const heading=key.length<=40&&words<=5&&(line===line.toLocaleUpperCase('tr')||/:\s*$/.test(line)||words<=3)&&Object.entries(HEADINGS).find(([,re])=>re.test(key))?.[0];
  if(heading){current=heading;continue;}
  out[current].push(line);
 }
 return out;
}
const PRESENT=/\b(?:present|current(?:ly)?|now|ongoing|today|halen|devam ediyor|gunumuz|hala|heute|aktuell|bis jetzt|aujourd'hui|actualidad|presente)\b/;
const MONTH_NUM=/\b(0?[1-9]|1[0-2])[./](\d{4})\b/g;
// Date ranges such as "Jan 2022 – Present", "03/2020 - 06/2022", "2019 – 2021".
function ranges(line,today){
 const f=fold(line),points=[];
 for(const d of dateMentions(f,today))points.push({at:d.at,month:Number(d.value.slice(0,4))*12+Number(d.value.slice(5,7)||1)-1});
 for(const m of f.matchAll(MONTH_NUM))if(!points.some(p=>Math.abs(p.at-m.index)<3))points.push({at:m.index,month:Number(m[2])*12+Number(m[1])-1});
 for(const m of f.matchAll(/\b(19[6-9]\d|20[0-4]\d)\b/g))if(!points.some(p=>!p.yearOnly&&m.index>=p.at&&m.index<=p.at+20))points.push({at:m.index,month:Number(m[1])*12,yearOnly:true});
 points.sort((a,b)=>a.at-b.at);
 const now=Number(today.slice(0,4))*12+Number(today.slice(5,7))-1,present=f.match(PRESENT);
 if(points.length>=2){const [a,b]=points;return{start:a.month,end:b.month,present:false};}
 if(points.length===1&&present&&present.index>points[0].at)return{start:points[0].month,end:now,present:true};
 return null;
}
const ROLE=/engineer|developer|programmer|manager|intern|analyst|specialist|designer|consultant|scientist|researcher|assistant|associate|coordinator|officer|director|lead|architect|administrator|technician|teacher|lecturer|nurse|driver|accountant|cook|chef|sales|representative|agent|supervisor|operator|founder|executive|editor|writer|mudur|muhendis|uzman|stajyer|gelistirici|asistan|sorumlu|yonetici|ogretmen|sofor|temsilci|entwickler|ingenieur|berater|praktikant|leiter|developpeur|ingenieur|stagiaire|desarrollador|ingeniero|becario/;
const INTERN=/\bintern(?:ship)?\b|\bstaj|praktik|stagiaire|becari|trainee|werkstudent|working student/;
function splitRole(line){
 line=line.replace(/\s{2,}.*$/,'').replace(/\(.*$/,'').trim();
 const parts=line.split(/\s+(?:at|@|—|–|-|\||·|,)\s+|\s+(?:at|@)\s+|\s*[|·—–]\s*/).map(s=>s.replace(/\(.*?\)/g,'').replace(/\b(?:19|20)\d{2}\b.*$/,'').trim()).filter(s=>s&&!/\d{4}/.test(s)&&s.length<=80);
 const role=parts.find(p=>ROLE.test(fold(p)));if(!role)return null;
 // "Acme Ltd, Edinburgh, UK" -> "Acme Ltd"; keep legal suffixes such as ", Inc.".
 const clean=p=>p.split(/,\s*/).reduce((name,piece,i)=>i===0?piece:/^(?:inc|llc|ltd|gmbh|a\.?s|s\.?a|plc|co)\b/i.test(piece)?name+', '+piece:name,'').trim();
 const company=parts.filter(p=>p!==role).map(clean).find(p=>p&&!PRESENT.test(fold(p))&&!/^(?:remote|hybrid|on-?site|full[- ]time|part[- ]time)$/i.test(p)&&!/^(?:turkey|turkiye|germany|usa|uk|ankara|istanbul|izmir|london|berlin)$/i.test(fold(p)));
 return{title:role,company:company||null};
}
const DEGREES=[
 ['Doctorate (PhD)',/\bph\.? ?d\b|doctorate|doctoral|doktora|promotion\b|doctorat|doctorado/],
 ["Master's degree",/\bmaster|\bm\.? ?sc?\b|\bmba\b|\bm\.? ?eng\b|\bm\.?a\.\b|yuksek lisans|diplom-|magister|maestria/],
 ["Bachelor's degree",/\bbachelor|\bb\.? ?sc?\b|\bb\.? ?eng\b|\bb\.?a\.\b|\bbs\b|(?<!yuksek |on )lisans\b|lisans ogrencisi|undergraduate|licence\b|grado en|licenciatura/],
 ['Associate degree',/associate degree|on lisans|meslek yuksekokulu/],
 ['High school',/high school|\blise\b|abitur|baccalaureat|bachillerato/],
];
const SCHOOL=/(?:Université|Universidad|Universität|Università|Universidade)(?:\s+(?:de|du|des|di|del|der|of)\b)?(?:\s+(?:[\p{Lu}][\p{L}.&'’-]*|\d{1,2})){1,4}|(?:[\p{Lu}][\p{L}.&'’-]*\s+){0,6}(?:University|Universität|Université|Universidad|Università|Institute of Technology|Institute|Polytechnic|College)(?:\s+(?:of|for|de|di)\s+(?:[\p{Lu}][\p{L}.&'’-]*\s*){1,4})?|(?:[\p{Lu}][\p{L}.&'’-]*\s+){1,6}(?:Üniversitesi|Universitesi|Enstitüsü|Yüksekokulu)/u;
const URL=/(?:https?:\/\/)?(?:www\.)?[a-z0-9-]+(?:\.[a-z0-9-]+)*\.(?:com|net|org|io|dev|app|me|co|ai|tech|site|xyz|page|github\.io|vercel\.app|netlify\.app)(?:\/[^\s|,;)]*)?/gi;
export function cvPreferenceDraft(text,today=new Date().toISOString().slice(0,10)){
 const parts=sections(text),fields=[],add=(id,value,evidence)=>{if(value!==null&&value!==undefined&&value!==''&&!fields.some(f=>f.id===id))fields.push({id,value:String(value),evidence:String(evidence).slice(0,300)});};
 const education=parts.education.length?parts.education:String(text).split(/\r?\n/).filter(l=>SCHOOL.test(l)||DEGREES.some(([,re])=>re.test(fold(l))));
 // Highest degree; an unfinished one is marked as in progress.
 const level=DEGREES.find(([,re])=>education.some(l=>re.test(fold(l))));
 if(level){
  const line=education.findIndex(l=>level[1].test(fold(l))),block=education.slice(Math.max(0,line-2),line+3).join(' '),range=ranges(block,today),future=/expected|anticipated|beklenen|devam|ongoing|voraussichtlich|en cours|present|current|halen/.test(fold(block));
  const years=[...block.matchAll(/\b(19[6-9]\d|20[0-4]\d)\b/g)].map(m=>+m[1]),grad=years.length?Math.max(...years):null,inProgress=future||grad&&grad>Number(today.slice(0,4));
  add('education',level[0]+(inProgress?' (in progress)':''),block);
  const school=education.slice(Math.max(0,line-2),line+3).map(l=>l.match(SCHOOL)?.[0]?.trim()).find(Boolean)||education.map(l=>l.match(SCHOOL)?.[0]?.trim()).find(Boolean);
  if(school)add('university',school.replace(/[,\s]+$/,''),school);
  if(grad&&!(range?.present&&!future)){add('graduation_year',grad,block);const month=dateMentions(fold(block),today).map(d=>d.value).filter(v=>v.startsWith(String(grad))).pop();if(inProgress)add('expected_graduation',month?month.slice(0,7):String(grad),block);}
 }else{const school=education.map(l=>l.match(SCHOOL)?.[0]?.trim()).find(Boolean);if(school)add('university',school,school);}
 // Experience: merge non-internship ranges into whole years; the current entry gives title/company.
 const spans=[];let current=null;
 parts.experience.forEach((line,i)=>{
  const range=ranges(line,today);if(!range)return;
  const context=parts.experience.slice(Math.max(0,i-2),i+2),entry=context.map(splitRole).find(Boolean)||null,intern=context.some(l=>INTERN.test(fold(l)));
  if(range.end>=range.start&&range.end-range.start<12*45&&!intern)spans.push([range.start,range.end]);
  if(range.present&&!current&&entry)current=entry;
 });
 // Summary-only CVs: "6 yıl genel muhasebe", "over 6 years of experience", "über 6 Jahren Erfahrung".
 if(!spans.length){const m=fold([...parts.header,...parts.other].join(' | ')).match(/(\d{1,2})\+?\s*(?:years?|yil|yillik|jahren?|ans|anos)\b(?![^|]{0,15}\b(?:old|yasinda|alt)\b)/);if(m&&+m[1]<=45)add('years_experience',m[1],m[0]);}
 if(spans.length){spans.sort((a,b)=>a[0]-b[0]);let total=0,[s,e]=spans[0];for(const [a,b]of spans.slice(1)){if(a<=e){e=Math.max(e,b);continue;}total+=e-s;[s,e]=[a,b];}total+=e-s;add('years_experience',Math.floor(total/12),parts.experience.join(' ').slice(0,300));}
 if(current){add('current_title',current.title,current.title);if(current.company)add('current_company',current.company,current.company);}
 // Personal website/portfolio from the CV header (not LinkedIn/GitHub/mail).
 const head=parts.header.slice(0,8).join(' ').replace(/\S+@\S+/g,' ');
 const site=[...head.matchAll(URL)].map(m=>m[0].replace(/[.)]+$/,'')).find(u=>!/linkedin\.com|github\.com/i.test(u));
 if(site){const url=/^https?:/.test(site)?site:'https://'+site;add(/portfolio|behance|dribbble/i.test(site)?'portfolio_url':'website',url,site);}
 return fields.filter(f=>{try{return !!savePreferences({setting:(_k,v)=>v||{}},[{id:f.id,value:f.value,confirmed:true}])[f.id];}catch{return false;}});
}
// Merge CV values: never replace something the person typed or wrote in notes; replace older CV values.
export function applyCVPreferences(store,fields){
 const bank=store.setting('user_preferences')||{},filled=[];
 const stale=Object.entries(bank).filter(([id,v])=>v.source==='cv'&&!fields.some(f=>f.id===id)).map(([id])=>({id,value:null}));
 const items=fields.filter(f=>!bank[f.id]||bank[f.id].source==='cv').map(f=>({id:f.id,value:f.value,confirmed:true,source:'cv'}));
 if(items.length||stale.length){savePreferences(store,[...stale,...items]);filled.push(...items.map(i=>i.id));}
 return filled;
}
const SCHEMA={type:'object',additionalProperties:false,properties:{current_title:{type:['string','null']},current_company:{type:['string','null']},university:{type:['string','null']},degree_level:{type:['string','null'],enum:['high_school','associate','bachelor','master','doctorate',null]},graduation_year:{type:['number','null']},degree_in_progress:{type:['boolean','null']}}};
SCHEMA.required=Object.keys(SCHEMA.properties);
// Optional model pass for CV layouts the rules cannot read. Same single CPU queue, unloaded afterwards.
export function cvModelFill({assistant,store,text,revision,onDone=()=>{}}){
 const settings=assistant.llmSettings(),controller=new AbortController(),id=randomUUID();assistant.controllers.add(controller);
 assistant.jobDraftQueue=(assistant.jobDraftQueue||Promise.resolve()).then(async()=>{try{
  if(assistant.closed)return;
  const shown=await assistant.fetch(assistant.endpoint+'/api/show',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({model:settings.model}),signal:AbortSignal.timeout(5000)}).catch(()=>null),info=shown?.ok?await shown.json():null;
  if(!info||info.remote_host||info.remote_model||info.details?.format!=='gguf')return;
  const prompt='Extract facts from the CV into the schema. current_title/current_company: the job marked present/current, else null. university: the most recent school, copied exactly. degree_level: highest degree started. graduation_year: its (expected) graduation year. degree_in_progress: true if not finished. Copy names exactly as written; null when unsure.';
  const response=await assistant.fetch(assistant.endpoint+'/api/chat',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({model:settings.model,messages:[{role:'system',content:prompt},{role:'user',content:String(text).slice(0,6000)}],format:SCHEMA,stream:false,think:false,keep_alive:0,options:{num_gpu:0,num_thread:2,num_ctx:4096,num_predict:300,temperature:0}}),signal:AbortSignal.any([controller.signal,AbortSignal.timeout(180000)])});
  if(!response.ok||store.setting('resume_revision')!==revision)return;
  const raw=JSON.parse((await response.json()).message?.content||'{}'),source=fold(text),grounded=v=>typeof v==='string'&&v.trim().length>1&&source.includes(fold(v)),fields=[];
  if(grounded(raw.current_title))fields.push({id:'current_title',value:raw.current_title.trim()});
  if(grounded(raw.current_company))fields.push({id:'current_company',value:raw.current_company.trim()});
  if(grounded(raw.university))fields.push({id:'university',value:raw.university.trim()});
  if(Number.isInteger(raw.graduation_year)&&source.includes(String(raw.graduation_year)))fields.push({id:'graduation_year',value:String(raw.graduation_year)});
  const levels={high_school:'High school',associate:'Associate degree',bachelor:"Bachelor's degree",master:"Master's degree",doctorate:'Doctorate (PhD)'};
  if(levels[raw.degree_level])fields.push({id:'education',value:levels[raw.degree_level]+(raw.degree_in_progress?' (in progress)':'')});
  // Model values only fill empty fields; they never replace rules, notes or typed values.
  const bank=store.setting('user_preferences')||{},items=fields.filter(f=>preferenceSpec(f.id)&&!bank[f.id]).map(f=>({...f,confirmed:true,source:'cv'}));
  if(items.length)savePreferences(store,items);onDone(items.map(i=>i.id));
 }catch{}finally{assistant.controllers.delete(controller);}});
 return id;
}
