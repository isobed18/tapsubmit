// One message -> reviewable settings. No conversation, browser session or GPU is involved.
// Deterministic rules read dates, salaries, hours, employment types, languages and the home city;
// an optional local model only adds values the rules missed, and every value must be grounded in the text.
import {randomUUID} from 'node:crypto';
import {preferenceSpec,savePreferences} from './preferences.mjs';
import {homeCountry} from './matching.mjs';
import {LANGUAGES,languageName,detectLanguage} from './languages.mjs';
const fold=s=>String(s||'').normalize('NFKD').replace(/[̀-ͯ]/g,'').replace(/ı/g,'i').toLowerCase().replace(/\s+/g,' ').trim();
const choice=values=>({type:['string','null'],enum:[...values,null]}),text={type:['string','null']},number={type:['number','null']};
const COUNTRY_IDS=['turkey','usa','uk','germany','netherlands','france','canada','ireland','spain','poland','uae','india','singapore','worldwide'];
const schema={type:'object',additionalProperties:false,properties:{weekly_hours:number,earliest_start_date:text,expected_graduation:text,employment_types:{type:'array',items:{type:'string',enum:['full_time','part_time','internship','contract','freelance']}},notice_period:text,relocation:choice(['Yes','No']),salary_amount:number,salary_currency:choice(['USD','EUR','GBP','TRY','CAD']),salary_period:choice(['month','year','hour']),salary_basis:choice(['gross','net']),work_authorization:choice(['Yes','No']),work_authorization_country:choice(['TR','US','GB','DE','CA']),visa_sponsorship:choice(['Yes','No']),visa_sponsorship_country:choice(['TR','US','GB','DE','CA']),home_location:text,cities:{type:'array',items:{type:'string'}},country:choice(COUNTRY_IDS),work_mode:choice(['remote_only','local_only','local_and_remote','anywhere'])}};
schema.required=Object.keys(schema.properties);

// ---- Deterministic reading ---------------------------------------------------------------------
const MONTHS=Object.fromEntries(Object.entries({1:'january jan ocak januar janvier enero gennaio',2:'february feb subat februar fevrier febrero febbraio',3:'march mar mart marz mars marzo',4:'april apr nisan avril abril aprile',5:'may mayis mai mayo maggio',6:'june jun haziran juni juin junio giugno',7:'july jul temmuz juli juillet julio luglio',8:'august aug agustos aout agosto',9:'september sep sept eylul septembre septiembre settembre',10:'october oct ekim oktober octobre octubre ottobre',11:'november nov kasim novembre noviembre',12:'december dec aralik dezember decembre diciembre dicembre'}).flatMap(([n,names])=>names.split(' ').map(name=>[name,Number(n)])));
const MONTH='('+Object.keys(MONTHS).sort((a,b)=>b.length-a.length).join('|')+')';
const pad=n=>String(n).padStart(2,'0'),validDate=(y,m,d)=>{const t=new Date(Date.UTC(y,m-1,d));return t.getUTCFullYear()===y&&t.getUTCMonth()===m-1&&t.getUTCDate()===d;};
const START=/\b(?:start|starting|begin|join|available|availability|basla\w*|musait\w*|ise giris|anfangen|beginn\w*|verfugbar|eintritt\w*|disponible|commencer|empezar|incorporacion)/;
const GRADUATION=/\b(?:graduat\w*|mezun\w*|abschluss\w*|diplom\w*|degree|lisans|bachelor|master|bitir\w*)/;
// Clauses: sentences, then "and"/"ve"/"und" joins, so "start Oct 19, 2026, and graduate July 2027" splits.
const clauses=folded=>folded.split(/[.;!?\n]+(?=\s|$)|,?\s+(?:and|but|while|ve|ama|und|aber|et|mais|y|pero)\s+/).map(s=>s.trim()).filter(Boolean);
export function dateMentions(clause,today){
 const found=[],taken=[],add=(match,value,precision)=>{if(taken.some(([a,b])=>match.index<b&&a<match.index+match[0].length))return;taken.push([match.index,match.index+match[0].length]);found.push({value,precision,at:match.index});};
 for(const m of clause.matchAll(/\b(\d{4})-(\d{1,2})-(\d{1,2})\b/g))if(validDate(+m[1],+m[2],+m[3]))add(m,`${m[1]}-${pad(m[2])}-${pad(m[3])}`,'day');
 for(const m of clause.matchAll(/\b(\d{1,2})[./](\d{1,2})[./](\d{4})\b/g)){const [a,b]=[+m[1],+m[2]],[d,mo]=b>12?[b,a]:[a,b];if(validDate(+m[3],mo,d))add(m,`${m[3]}-${pad(mo)}-${pad(d)}`,'day');}
 for(const m of clause.matchAll(new RegExp('\\b'+MONTH+'\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?,?\\s+(\\d{4})\\b','g'))){const mo=MONTHS[m[1]];if(validDate(+m[3],mo,+m[2]))add(m,`${m[3]}-${pad(mo)}-${pad(m[2])}`,'day');}
 for(const m of clause.matchAll(new RegExp('\\b(\\d{1,2})(?:st|nd|rd|th|\\.)?\\s+(?:of\\s+)?'+MONTH+'\\.?,?\\s+(\\d{4})\\b','g'))){const mo=MONTHS[m[2]];if(validDate(+m[3],mo,+m[1]))add(m,`${m[3]}-${pad(mo)}-${pad(m[1])}`,'day');}
 for(const m of clause.matchAll(new RegExp('\\b'+MONTH+'\\.?,?\\s+(\\d{4})\\b','g')))add(m,`${m[2]}-${pad(MONTHS[m[1]])}`,'month');
 for(const m of clause.matchAll(/\b(?:immediately|right away|asap|as soon as possible|hemen|derhal|sofort|ab sofort|immediatement|inmediatamente)\b/g))add(m,today,'day');
 return found;
}
const CURRENCY=[['TRY',/^(?:try|tl|₺|lira|turk lirasi)$/],['USD',/^(?:usd|\$|us\$|dollars?|dolar)$/],['EUR',/^(?:eur|€|euros?)$/],['GBP',/^(?:gbp|£|pounds?|sterlin)$/],['CAD',/^(?:cad|c\$)$/]];
const CUR='(try|tl|₺|lira|usd|us\\$|\\$|dollars?|dolar|eur|€|euros?|gbp|£|pounds?|sterlin|cad|c\\$)';
const NUM='(\\d{1,3}(?:[.,\\s]\\d{3})+|\\d+(?:[.,]\\d+)?)\\s*(k|bin|thousand)?';
const SALARY=/salar|maas|ucret|wage|\bpay\b|\brate\b|hourly|stundensatz|compensation|gehalt|salaire|salario|sueldo|beklenti|expect|income|gelir/;
const amount=(num,scale)=>{const plain=/^\d{1,3}(?:[.,\s]\d{3})+$/.test(num)?Number(num.replace(/[.,\s]/g,'')):Number(num.replace(',','.'));return scale?plain*1000:plain;};
const currencyOf=word=>CURRENCY.find(([,re])=>re.test(word))?.[0]||null;
function salaries(sentence){
 if(!SALARY.test(sentence))return [];
 const rows=[],seen=new Set();
 for(const re of [new RegExp(NUM+'\\s*'+CUR+'(?![a-z])','g'),new RegExp('(?<![a-z])'+CUR+'\\s*'+NUM,'g')])
  for(const m of sentence.matchAll(re)){const [num,scale,cur]=re.source.startsWith('(\\d')?[m[1],m[2],m[3]]:[m[2],m[3],m[1]],currency=currencyOf(cur),value=amount(num.trim(),scale);if(!currency||!(value>0)||seen.has(currency+value))continue;seen.add(currency+value);rows.push({currency,amount:value,at:m.index});}
 const period=/month|\/mo\b|aylik|ayda|monat|mois|mensuel|\bmes\b|mensual/.test(sentence)?'month':/year|annual|yillik|yilda|jahr|annuel|\ban\b|anual|\bano\b/.test(sentence)?'year':/hour|saatlik|stunde|heure|\bhora\b/.test(sentence)?'hour':null;
 const basis=/\bnet\b/.test(sentence)?'net':/gross|brut|brutto|bruto/.test(sentence)?'gross':null;
 return rows.sort((a,b)=>a.at-b.at).map(row=>({...row,period,basis}));
}
const HOME=/\b(?:based in|live in|living in|located in|residing in|reside in|i am in|i'm in|currently in|wohne in|lebe in|j'habite a|vivo en)\s+([\p{Lu}][\p{L}'’-]+(?:,?\s+[\p{Lu}][\p{L}'’-]+){0,2})/u;
const HOME_TR=/([\p{Lu}][\p{L}-]+)['’]?(?:da|de|ta|te)(?:yim|yım|yum|yüm|\s+(?:yaşıyorum|oturuyorum|ikamet ediyorum))\b/u;
const LANGUAGE_CUE=/speak|language|fluent|native|mother tongue|bilingual|proficien|\b[abc][12]\b|konus|\bdil|seviye|ileri|duzey|bilirim|biliyorum|anadil|sprech|sprache|flie|parle|langue|hablo|idioma/;
export function ruleDraft(text,today){
 const folded=fold(text),out={fields:[],dates:[],salaries:[],home:null,languages:[],work_mode:null};
 for(const clause of clauses(folded)){
  const dates=dateMentions(clause,today);out.dates.push(...dates.map(d=>d.value));
  const kind=GRADUATION.test(clause)?'graduation':START.test(clause)?'start':null;
  for(const date of dates){
   if(kind==='start'&&date.precision==='day'&&!out.fields.some(f=>f.id==='earliest_start_date'))out.fields.push({id:'earliest_start_date',value:date.value,evidence:clause});
   if(kind==='start'&&date.precision==='month'&&!out.fields.some(f=>f.id==='earliest_start_date'))out.fields.push({id:'earliest_start_date',value:date.value+'-01',evidence:clause});
   if(kind==='graduation'&&!out.fields.some(f=>f.id==='expected_graduation')){out.fields.push({id:'expected_graduation',value:date.value.slice(0,7),evidence:clause},{id:'graduation_year',value:date.value.slice(0,4),evidence:clause});}
  }
 }
 // Salaries are read per sentence so "60,000 TRY or 1,500 USD per month" keeps the shared period.
 for(const sentence of folded.split(/[.;!?\n]+(?=\s|$)/))out.salaries.push(...salaries(sentence).map(row=>({...row,evidence:sentence.trim()})));
 if(out.salaries.length){
  for(const s of out.salaries)if(s.period&&s.basis)out.fields.push({id:`salary:${s.currency}:${s.period}:${s.basis}`,value:String(s.amount),evidence:s.evidence});
  const phrase=s=>`${s.amount.toLocaleString('en-US')} ${s.currency}${s.period?' per '+s.period:''}${s.basis?' '+s.basis:''}`;
  out.fields.push({id:'salary_statement',value:out.salaries.map(phrase).join(' or '),evidence:out.salaries[0].evidence});
 }
 const hours=folded.match(/(\d{1,3}(?:[.,]\d)?)\s*(?:hours?|hrs?|saat|stunden|std|heures|horas)\s*(?:per|a|\/|each|in a|pro|par|por|la)?\s*(?:week|wk|woche|semaine|semana)/)||folded.match(/haftada\s*(\d{1,3}(?:[.,]\d)?)\s*saat/)||folded.match(/(\d{1,3})\s*(?:hours?|saat)\s*(?:weekly|haftalik)/);
 if(hours)out.fields.push({id:'weekly_hours',value:hours[1].replace(',','.'),evidence:hours[0]});
 const types=[['Full-time',/full[- ]?time|tam zaman|vollzeit|temps plein|tiempo completo/],['Part-time',/part[- ]?time|yari zaman|teilzeit|temps partiel|medio tiempo|tiempo parcial/],['Internship',/\bintern(?:ship)?\b|\bstaj|praktikum|stage\b|practicas/],['Contract',/\bcontract\b|sozlesmeli|befristet|contrat|\bcontrato\b/],['Freelance',/freelance|serbest/]].filter(([,re])=>re.test(folded)).map(([label])=>label);
 if(types.length)out.fields.push({id:'employment_type',value:types.join(', '),evidence:folded});
 if(/\b(?:willing|open|happy|able) to relocate|relocation (?:is )?(?:ok|fine|possible)|tasinabilirim|tasinmaya acigim|umzug moglich/.test(folded))out.fields.push({id:'relocation',value:'Yes',evidence:folded});
 else if(/\b(?:not (?:willing|open|able) to relocate|no relocation|cannot relocate|can't relocate)|tasinmak istemiyorum|tasinamam/.test(folded))out.fields.push({id:'relocation',value:'No',evidence:folded});
 const home=String(text).match(HOME)||String(text).match(HOME_TR);if(home)out.home=home[1].replace(/[,\s]+$/,'');
 for(const sentence of folded.split(/[.;!?\n]+/))if(LANGUAGE_CUE.test(sentence))for(const part of sentence.split(/,|\s(?:and|ve|und|et|y)\s/))for(const code of Object.keys(LANGUAGES))if(languageName(code).test(part)&&!/beginner|basic|baslangic|temel|\ba[12]\b/.test(part))out.languages.push(code);
 // The message's own language is one the person demonstrably works in.
 const written=detectLanguage(text);if(written&&out.languages.length)out.languages.push(written.code);
 const remote=/remote|uzaktan|home ?office|telework|work from home|evden/.test(folded),local=/on[- ]?site|onsite|office|hybrid|hibrit|ofis|yerinde|in person|vor ort/.test(folded);
 if(/\b(?:remote only|only remote|fully remote|100% remote|exclusively remote)|(?:yalnizca|sadece) (?:remote|uzaktan)|nur remote/.test(folded))out.work_mode='remote_only';
 else if(/\bno remote|not remote|remote istemiyorum|(?:onsite|on-site|office) only|only (?:onsite|on-site|in the office)/.test(folded))out.work_mode='local_only';
 else if(remote&&local)out.work_mode='local_and_remote';
 else if(remote)out.work_mode='remote_only';
 return out;
}

// ---- Model output: map, then accept only grounded values ---------------------------------------
function modelFields(raw,source){
 const fields=[],numbers=[...source.matchAll(/\d+(?:[.,]\d+)*/g)].flatMap(match=>[match[0],match[0].replace(/[,.]/g,''),match[0].replace(',','.')]).map(Number);
 for(const id of ['weekly_hours','earliest_start_date','notice_period','relocation'])if(raw[id]!==null&&raw[id]!==undefined){if(id==='weekly_hours'&&!numbers.includes(Number(raw[id])))continue;fields.push({id,value:String(raw[id]),evidence:source});}
 if(raw.expected_graduation)fields.push({id:'expected_graduation',value:String(raw.expected_graduation).slice(0,7),evidence:source});
 if(Array.isArray(raw.employment_types)&&raw.employment_types.length)fields.push({id:'employment_type',value:raw.employment_types.map(t=>({full_time:'Full-time',part_time:'Part-time',internship:'Internship',contract:'Contract',freelance:'Freelance'})[t]).filter(Boolean).join(', '),evidence:source});
 if(raw.salary_amount!==null&&raw.salary_amount!==undefined&&numbers.includes(Number(raw.salary_amount))&&raw.salary_currency&&raw.salary_period&&raw.salary_basis)fields.push({id:`salary:${raw.salary_currency}:${raw.salary_period}:${raw.salary_basis}`,value:String(raw.salary_amount),evidence:source});
 if(raw.work_authorization&&raw.work_authorization_country)fields.push({id:'work_authorization:'+raw.work_authorization_country,value:raw.work_authorization,evidence:source});
 if(raw.visa_sponsorship&&raw.visa_sponsorship_country)fields.push({id:'visa_sponsorship:'+raw.visa_sponsorship_country+':now_or_future',value:raw.visa_sponsorship,evidence:source});
 return fields;
}
export function validatePreferenceDraft(raw,text,today=new Date().toISOString().slice(0,10)){
 raw=raw||{};const source=fold(text),evidence=s=>!!s&&source.includes(fold(s)),fields=[],issues=[],rules=ruleDraft(text,today);
 const types=['employment_type'],model=Array.isArray(raw.fields)?raw.fields:modelFields(raw,text);
 // Rules first; a model value fills only ids the rules did not find (salary keys by currency).
 const candidates=[...rules.fields.map(f=>({...f,by:'rules'})),...model.filter(f=>!rules.fields.some(r=>r.id===f.id||r.id.startsWith('salary:')&&f.id.startsWith('salary:')&&r.id.split(':')[1]===f.id.split(':')[1])).map(f=>({...f,by:'model'}))];
 for(const item of candidates.slice(0,40)){
  const spec=preferenceSpec(String(item.id||''));if(!spec||!evidence(item.evidence)){issues.push('An unsupported or ungrounded field was omitted.');continue;}
  if(fields.some(f=>f.id===spec.id))continue;
  if(item.by==='model'){
   if(spec.id==='notice_period'&&!/notice|ihbar|kundigungsfrist|preavis/.test(source)){issues.push('Notice period was not explicitly stated; it was omitted.');continue;}
   // A model date must equal a date written in the message (any format), or "immediately".
   if(spec.id==='earliest_start_date'&&!rules.dates.includes(String(item.value))){issues.push('A start date not written in the message was omitted.');continue;}
   if(spec.id==='expected_graduation'&&!rules.dates.some(d=>d.startsWith(String(item.value)))){issues.push('A graduation date not written in the message was omitted.');continue;}
   if(spec.id==='relocation'&&!/relocat|tasin|umzug|demenag|mudanza|move to/.test(source)){issues.push('Relocation was not explicitly stated; it was omitted.');continue;}
   if(types.includes(spec.id)&&!/time|zaman|intern|staj|contract|sozlesme|freelance|serbest|zeit|temps|tiempo/.test(source))continue;
   if(spec.id.startsWith('salary:')){const [,currency,period,basis]=spec.id.split(':'),cur={TRY:/\btry\b|₺|\btl\b|lira/,USD:/\busd\b|dollar|dolar|\$/,EUR:/\beur\b|euro|€/,GBP:/\bgbp\b|pound|£/,CAD:/\bcad\b|canadian/}[currency],per={month:/month|aylik|ayda|monat|mois/,year:/year|annual|yillik|jahr|annuel/,hour:/hour|saat|stund|heure/}[period];if(!cur.test(source)||!per.test(source)||!(basis==='net'?/\bnet\b/:/gross|brut/).test(source)){issues.push('Salary saved as text for written questions; numeric salary fields need currency, period and gross/net.');continue;}}
   if(spec.id.startsWith('work_authorization:')&&!/authori[sz]|work permit|right to work|calisma izni|arbeitserlaubnis|permis de travail/.test(source)){issues.push('Work authorization must be explicitly stated.');continue;}
   if(spec.id.startsWith('visa_sponsorship:')&&!/sponsor|visa|vize/.test(source)){issues.push('Visa sponsorship must be explicitly stated.');continue;}
  }
  let normalized;try{normalized=savePreferences({setting:(_key,value)=>value||{}},[{id:spec.id,value:item.value,confirmed:true}])[spec.id];}catch{issues.push('Invalid '+spec.label+' was omitted.');continue;}
  if(normalized)fields.push({id:spec.id,label:spec.label+(spec.unit?' · '+spec.unit:''),value:normalized.value,evidence:item.evidence,by:item.by});
 }
 if(rules.salaries.some(s=>!s.basis||!s.period))issues.push('Salary saved as text for written questions; numeric salary fields need currency, period and gross/net.');
 const modelHome=raw.home_location&&source.includes(fold(raw.home_location))?String(raw.home_location):null,home=(rules.home||modelHome||'').slice(0,160)||null;
 const cities=[...new Set([...(Array.isArray(raw.cities)?raw.cities:[]).filter(city=>typeof city==='string'&&city.trim()&&source.includes(fold(city))).map(c=>c.trim())])].slice(0,10);
 const work_mode=['remote_only','local_only','local_and_remote','anywhere'].includes(raw.work_mode)?raw.work_mode:rules.work_mode;
 // A local preference without named cities uses the home city.
 const homeCity=home?.split(',')[0].trim();if(!cities.length&&homeCity&&['local_only','local_and_remote'].includes(work_mode))cities.push(homeCity);
 const country=COUNTRY_IDS.includes(raw.country)&&raw.country!=='worldwide'?raw.country:homeCountry(home)||(raw.country==='worldwide'?'worldwide':null);
 return{fields,home_location:home,search:{location:cities.join('; '),country,work_mode,languages:[...new Set(rules.languages)]},notes:text,issues:[...new Set(issues)]};
}
const PROMPT='Read the USER message and extract ALL explicitly stated application preferences into the schema. Use null (or an empty list) for any missing fact. weekly_hours and salary_amount are NUMBERS, never words. Dates are YYYY-MM-DD; expected_graduation is YYYY-MM. Give salary_amount/currency/period even when gross or net is not stated (then salary_basis=null). employment_types lists every stated type (full_time, part_time, internship, contract, freelance). Do not infer work authorization or visa sponsorship from a city or availability. Work mode remote_only means ONLY remote, local_only means onsite/hybrid only in specified cities, local_and_remote means named cities plus remote. home_location is where the person lives ("based in", "live in"); a home city can also be a preferred city unless remote-only. Example: "Berlin. Remote only. 45000 EUR per year gross; 40 hours per week. Start 2026-11-01." means weekly_hours=40, salary_amount=45000, salary_currency=EUR, salary_period=year, salary_basis=gross, earliest_start_date=2026-11-01, home_location=Berlin, country=germany, work_mode=remote_only. All unrelated values null. Never copy the example values; read only the actual USER text.';
export class PreferenceEditor{
 constructor({assistant}){this.assistant=assistant;this.current=null;}
 snapshot(){if(!this.current)return null;const {controller,...row}=this.current;return row;}
 start(text,today=new Date().toISOString().slice(0,10)){
  text=String(text||'').trim();if(text.length<5||text.length>8000)throw Error('Describe your preferences in 5–8,000 characters.');
  if(this.current&&['queued','running'].includes(this.current.state))throw Error('A settings message is already being processed.');
  const assistant=this.assistant,settings=assistant.llmSettings(),controller=new AbortController(),row=this.current={id:randomUUID(),state:'queued',controller};assistant.controllers.add(controller);
  // Rules are instant; the preview is usable even when no model is installed.
  row.preview=validatePreferenceDraft({},text,today);row.method='rules';
  assistant.jobDraftQueue=(assistant.jobDraftQueue||Promise.resolve()).then(async()=>{try{
   if(controller.signal.aborted||assistant.closed){row.state='cancelled';return;}row.state='running';
   const shown=await assistant.fetch(assistant.endpoint+'/api/show',{method:'POST',redirect:'error',headers:{'Content-Type':'application/json'},body:JSON.stringify({model:settings.model}),signal:AbortSignal.any([controller.signal,AbortSignal.timeout(5000)])}).catch(()=>null),info=shown?.ok?await shown.json():null;
   if(!info||info.remote_host||info.remote_model||info.details?.format!=='gguf'){row.state='ready';row.note='Read with rules only; install the optional local model for more flexible wording.';return;}
   assistant.llmCalls=(assistant.llmCalls||0)+1;
   const response=await assistant.fetch(assistant.endpoint+'/api/chat',{method:'POST',redirect:'error',headers:{'Content-Type':'application/json'},body:JSON.stringify({model:settings.model,messages:[{role:'system',content:PROMPT+' Today: '+today+'.'},{role:'user',content:text}],format:schema,stream:false,think:false,keep_alive:0,options:{num_gpu:0,num_thread:2,num_ctx:4096,num_predict:700,temperature:0}}),signal:AbortSignal.any([controller.signal,AbortSignal.timeout(120000)])});
   if(!response.ok)throw Error('The local model could not read this message.');const data=await response.json();if(controller.signal.aborted)return;
   this.lastContent=data.message?.content||'';const result=JSON.parse(this.lastContent||'{}');this.lastRaw=result;row.preview=validatePreferenceDraft(result,text,today);row.method='rules+model';row.state='ready';row.elapsed_ms=Math.round((data.total_duration||0)/1e6);
  }catch(error){if(controller.signal.aborted){row.state='cancelled';return;}
   // The rules preview stays valid when the optional model fails.
   row.state='ready';row.note=(error.name==='TimeoutError'?'The local model timed out':error.message)+' Values below were read with rules only.';
  }finally{assistant.controllers.delete(controller);}});
  return this.snapshot();
 }
}
