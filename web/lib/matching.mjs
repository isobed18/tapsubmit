// CPU-only shortlist ranking. Scores order search evidence; they are not eligibility probabilities.
import {parseQuery,fold,words} from '../../demo/public/search-engine.mjs';
import {SKILLS} from '../../demo/lib/taxonomy.mjs';
import {EXTRA_SKILLS} from './jobs.mjs';
import {simpleQuery} from './profile.mjs';
import {destinationKey} from './applications.mjs';
import {languageConflict} from './languages.mjs';

const COUNTRIES={turkey:['turkey','turkiye','tr','istanbul','ankara','izmir'],usa:['united states','usa','us','san francisco','new york','seattle','boston'],uk:['united kingdom','uk','gb','london'],germany:['germany','deutschland','de','berlin','munich','münchen','muenchen','hamburg','bremen','heilbronn'],netherlands:['netherlands','nl','amsterdam'],france:['france','fr','paris'],canada:['canada','ca','toronto','vancouver'],ireland:['ireland','ie','dublin'],spain:['spain','es','madrid','barcelona'],poland:['poland','pl','warsaw'],uae:['united arab emirates','uae','dubai'],india:['india','in','bengaluru'],singapore:['singapore','sg']};
const EUROPE=new Set(['uk','germany','netherlands','france','ireland','spain','poland']),EU=new Set([...EUROPE].filter(c=>c!=='uk'));
const has=(text,value)=>(' '+fold(text).replace(/[^a-z0-9]+/g,' ')+' ').includes(' '+fold(value)+' ');
const CODES={TR:'turkey',US:'usa',GB:'uk',DE:'germany',NL:'netherlands',FR:'france',CA:'canada',IE:'ireland',ES:'spain',PL:'poland',AE:'uae',IN:'india',SG:'singapore'};
// Recognize advertised countries beyond the selectable search-country list. Intl ships with Node;
// this adds no geography download or inference service.
const REGION_NAMES=[];
const SKILL_PATTERNS=Object.entries({...SKILLS,...EXTRA_SKILLS}).map(([skill,pattern])=>[skill,new RegExp(pattern,'i')]);
const display=new Intl.DisplayNames(['en'],{type:'region'});
for(let a=65;a<=90;a++)for(let b=65;b<=90;b++){const code=String.fromCharCode(a,b),name=display.of(code);if(name&&name!==code&&!['DD','SU','YU','CS','ZR','BU','TP','FX','NT','AN','EU','EZ','UN','QO','ZZ'].includes(code))REGION_NAMES.push([CODES[code]||code.toLowerCase(),' '+fold(name).replace(/[^a-z0-9]+/g,' ')+' ']);}
export function workArrangement(job){
 const head=[job.title,job.location,job.workplace].filter(Boolean).join(' '),description=String(job.description||'');
 if(/\b(?:hybrid|hibrit|hybride|hibrido)\b/i.test(head)||/\bhybrid (?:role|position|working|work model|work arrangement)|(?:work(?:ing)? (?:model|arrangement)|çalışma modeli)\s*[:–-]\s*(?:hybrid|hibrit)|\b(?:in[- ]office|on[- ]site)\s+(?:at least )?\d\s+days?\s+(?:per |a )?week/i.test(description))return'hybrid';
 if(/\b(?:on[- ]site|onsite|yerinde)\b/i.test(head))return'onsite';
 return job.workplace||'unknown';
}
// Countries/regions a location text advertises, and whether one country is covered by them.
function advertisedCountries(text,job={}){
 const regions={emea:has(text,'emea'),europe:has(text,'europe'),eu:has(text,'eu')||has(text,'european union'),americas:has(text,'north america')||has(text,'americas')||has(text,'amer')||has(text,'latam')||has(text,'latin america')||has(text,'south america'),apac:has(text,'apac')||has(text,'asia pacific')||has(text,'asia')};
 let advertised=Object.entries(COUNTRIES).filter(([,names])=>names.filter(name=>name.length>2).some(name=>has(text,name))).map(([id])=>id);
 const normalized=' '+fold(text).replace(/[^a-z0-9]+/g,' ')+' ';
 advertised=[...new Set([...advertised,...REGION_NAMES.filter(([,name])=>normalized.includes(name)).map(([id])=>id)])];
 // Uppercase codes are a fallback. "in" is a preposition and CA often means California.
 if(!advertised.length){const last=!job.location_restriction&&text.split(',').length>=3?text.match(/,\s*([A-Z]{2})\s*$/)?.[1]:null;advertised=last&&CODES[last]?[CODES[last]]:[...new Set((text.match(/\b[A-Z]{2}\b/g)||[]).map(code=>CODES[code]).filter(Boolean))];}
 const covers=country=>advertised.includes(country)||regions.emea&&(EUROPE.has(country)||['turkey','uae'].includes(country))||regions.europe&&(EUROPE.has(country)||country==='turkey')||regions.eu&&EU.has(country)||regions.americas&&['usa','canada'].includes(country)&&!has(text,'latam')&&!has(text,'latin america')&&!has(text,'south america')||regions.apac&&['india','singapore'].includes(country);
 return{advertised,any:advertised.length>0||Object.values(regions).some(Boolean),covers};
}
const NAMES=Object.fromEntries(Object.entries(CODES).map(([code,id])=>[id,display.of(code)]));
const countryName=id=>NAMES[id]||(id.length===2?display.of(id.toUpperCase()):id);
// Names that identify a search country in a location string (used to pre-filter indexed pools).
export function countryTerms(id){return [...new Set([...(COUNTRIES[id]||[]).filter(name=>name.length>2),NAMES[id]].filter(Boolean))];}
// The country of a free-text home location such as "Ankara, Türkiye"; null when unclear.
export function homeCountry(text){
 if(!text)return null;const found=advertisedCountries(String(text));if(found.advertised.length===1)return found.advertised[0];
 const short=[['uk',/\bUK\b/],['usa',/\bUSA?\b/],['uae',/\bUAE\b/]].filter(([,re])=>re.test(text));return !found.advertised.length&&short.length===1?short[0][0]:null;
}
export function geography(job,country='worldwide',remote=false,location='',work_mode=null,home=null){
 const text=job.location_restriction||job.locations?.join(' | ')||job.location||'';
 const mode=work_mode||(remote?'remote_only':location?'local_and_remote':'anywhere'),workplace=workArrangement(job),cities=String(location).split(/[;,|]/).map(s=>s.trim()).filter(Boolean);
 if(mode==='remote_only'&&workplace!=='remote')return{status:workplace==='unknown'?'unknown':'mismatch',reason:'Remote-only was requested; this posting is '+workplace+'.'};
 if(mode==='local_only'&&workplace==='remote')return{status:'mismatch',reason:'Only selected-city onsite/hybrid roles were requested.'};
 if(cities.length&&(mode==='local_only'||mode==='local_and_remote'&&workplace!=='remote')&&!cities.some(city=>has(text,city)))return{status:'mismatch',reason:'The advertised location is outside your selected cities.'};
 if(!country||country==='worldwide'){
  // "Worldwide" covers global remote work, not remote jobs reserved for residents of other countries.
  if(workplace!=='remote'||!text||/\b(worldwide|anywhere|global)\b/i.test(text))return{status:'unrestricted'};
  const found=advertisedCountries(text,job);if(!found.any)return{status:'unrestricted'};
  if(home&&found.covers(home))return{status:'match',advertised_countries:found.advertised,reason:'Remote within your home country/region.'};
  return{status:'mismatch',advertised_countries:found.advertised,reason:'Remote only for residents of '+(found.advertised.map(countryName).join(', ')||'another region')+'.'};
 }
 if(!text)return{status:'unknown'};
 if(/\b(worldwide|anywhere|global)\b/i.test(text))return{status:'unrestricted'};
 const found=advertisedCountries(text,job);
 if(!found.any)return{status:'unknown'};
 return{status:found.covers(country)?'match':'mismatch',advertised_countries:found.advertised,reason:'From the advertised location; this does not establish work authorization.'};
}
export function postedMillis(value){const numeric=Number(value);if(value&&Number.isFinite(numeric)&&numeric>1e9)return numeric>1e11?numeric:numeric*1000;const date=Date.parse(value);return Number.isFinite(date)?date:null;}
function queryMatches(jobs,queries){
 const evidence=new Map(),weights={title:6,skill:4,company:2,location:1.5,description:1},fields=Object.keys(weights);
 // The shared corpus already has a BM25 index. A small returned shortlist needs no second
 // inverted index: evaluate the same Boolean/phrase grammar over normalized strings.
 const docs=jobs.map(job=>({job,fields:Object.fromEntries(Object.entries({title:job.title,description:job.description,skill:(job.skills||[]).join(' '),company:job.company,location:(job.locations||[job.location]).join(' '),workplace:job.workplace,level:job.seniority,type:job.employment_type,source:job.provider}).map(([key,value])=>[key,{raw:String(value||''),text:' '+words(value).join(' ')+' '}]))}));
 for(const query of queries){
  const ast=parseQuery(simpleQuery(query)),positive=[];
  const collect=(node,negated=false)=>{if(node.type==='term'&&!negated)positive.push(node);if(node.child)collect(node.child,!negated);if(node.left)collect(node.left,negated);if(node.right)collect(node.right,negated);};collect(ast);
  const matches=(doc,term)=>{const needle=' '+words(term.value).join(' ')+' ';return(term.field?[term.field]:fold(term.value)==='go'?['skill']:fields).filter(field=>doc.fields[field]?.text.includes(needle));};
  const evaluate=(doc,node)=>node.type==='all'?true:node.type==='term'?matches(doc,node).length>0:node.type==='not'?!evaluate(doc,node.child):node.type==='and'?evaluate(doc,node.left)&&evaluate(doc,node.right):evaluate(doc,node.left)||evaluate(doc,node.right);
  const found=[];
  for(const doc of docs){if(!evaluate(doc,ast))continue;let score=0;const terms=[];for(const term of positive)for(const field of matches(doc,term)){score+=weights[field]||1;const raw=doc.fields[field].raw,at=Math.max(0,fold(raw).indexOf(fold(term.value)));terms.push({field,term:term.value,snippet:raw.slice(Math.max(0,at-65),at+150)});}found.push({id:doc.job.id,score,evidence:terms});}
  found.sort((a,b)=>b.score-a.score||a.id.localeCompare(b.id));
  found.forEach((row,rank)=>{const entry=evidence.get(row.id)||{rrf:0,queries:[],evidence:[]};entry.rrf+=1/(40+rank);entry.queries.push(query);entry.evidence.push(...row.evidence);evidence.set(row.id,entry);});
 }
 return evidence;
}
export function requirements(job){
 const text=String(job.description||''),lines=text.split(/\n|[.!?]\s+/).map(line=>line.trim()).filter(Boolean);let inRequirements=false;const required=[];
 for(const line of lines){
  if(/^(?:benefits|what we offer|about (?:us|the company)|equal opportunity|compensation|perks)\b/i.test(line))inRequirements=false;
  if(/^(?:requirements|qualifications|what you (?:bring|need)|who you are|minimum qualifications|essential skills)\b/i.test(line))inRequirements=true;
  if(/\b(?:nice.to.have|bonus|preferred|a plus|not required)\b/i.test(line))continue;
  if(inRequirements||/\b(?:must have|required|minimum|at least|you (?:have|bring))\b/i.test(line))required.push(line);
 }
 const evidence=required.join('\n'),skills=SKILL_PATTERNS.filter(([,pattern])=>pattern.test(evidence)).map(([skill])=>skill);
 const years=[...evidence.matchAll(/(?:at least |minimum (?:of )?)?(\d{1,2})(?:\s*[-–]\s*\d{1,2})?\+?\s*years?\s+(?:of )?(?:(?:professional|relevant|industry|software|engineering|work)\s+)*experience/gi)].map(m=>Number(m[1])).filter(n=>n<=30);
 return{skills,minimum_years:years.length?Math.max(...years):null,evidence:required.slice(0,8).map(line=>line.slice(0,350))};
}
// Semantic relevance thresholds for paraphrase-multilingual-MiniLM title similarity, calibrated on the
// 4.1k-title pool (scripts/calibrate_relevance.mjs). These are routing cutoffs, not calibrated
// same-occupation probabilities; close but distinct roles need competing-anchor checks as well.
// Seniority/kind markers in titles (EN/TR/DE/ES/FR). Small and closed: job-title grammar, not a profession list.
const SENIOR_TITLE=/(?:^|[^\p{L}])(senior|sr\.?|lead|leader|principal|staff|director|head of|manager|vp|vice president|chief|architect|kıdemli|kidemli|müdür\p{L}*|mudur\p{L}*|yönetmen\p{L}*|yönetici\p{L}*|direktör\p{L}*|şef|leiter|leitung|jefe|directeur|responsable)(?=$|[^\p{L}])/iu;
const JUNIOR_TITLE=/(?:^|[^\p{L}])(intern|internship|stajyer|staj|trainee|apprentice|apprenticeship|ausbildung|azubi|alternant|aprendiz|çırak|working student|werkstudent|praktikant|praktikum|new grad(?:uate)?|entry[- ]level|yeni mezun|becario|stagiaire|alternance)(?=$|[^\p{L}])/iu;
const EXEC_TITLE=/(?:^|[^\p{L}])(director|head of|vp|vice president|chief|cto|ceo|cfo)(?=$|[^\p{L}])/iu;
export function levelConflict(job,level,minimumYears){
 const title=String(job.title||'');
 if(level==='early'){if(SENIOR_TITLE.test(title)&&!JUNIOR_TITLE.test(title))return 'Above your career level.';if(minimumYears>=3)return 'Asks for '+minimumYears+'+ years of experience.';}
 if(level==='mid'){if(JUNIOR_TITLE.test(title))return 'Internship or trainee role.';if(EXEC_TITLE.test(title))return 'Executive role above your career level.';}
 if(level==='senior'&&JUNIOR_TITLE.test(title))return 'Internship or trainee role.';
 return null;
}
export const RELEVANCE={auto:0.58,show:0.45,near:0.62,overall:0.3};
export function summarizeExclusions(excluded){
 const counts={};for(const row of excluded){const reason=row.match?.conflicts?.[0]||'',label=/closed/i.test(reason)?'closed':/older/i.test(reason)?'outside date window':/location|country|remote|hybrid|city|cities|onsite|residents/i.test(reason)?'outside work location':/languages\)/.test(reason)?'language you did not list':/career level|experience|Internship|trainee|Executive/i.test(reason)?'career level / experience':/pending/i.test(reason)?'matching pending':'role / query mismatch';counts[label]=(counts[label]||0)+1;}return counts;
}
export function rankJobs(jobs,{queries=[],profile=null,country='worldwide',location='',remote=false,work_mode=null,hours_old=168,now=Date.now(),queryEvidence=null,semantic=null,early:earlyHint=null,explicit=false,strict_relevance=false,level=null,targets=[],languages=[],home_country=null}={}){
 const start=performance.now(),evidence=queryEvidence||queryMatches(jobs,queries);
 const early=earlyHint??(!!profile&&(profile.plan?.early===true||profile.facts?.early_career===true)),known=new Set((profile?.skills||[]).map(fold));
 const structured=explicit&&queries.some(q=>/\b(?:title|description|skill|company|location|workplace|level|type|source):|\b(?:AND|OR|NOT)\b|[()"]/.test(q));
 const seen=new Set(),results=[],excluded=[];
 for(const job of jobs){
  const query=evidence.get(job.id),sem=semantic?.get(job.id)||null,geo=geography(job,country,remote,location,work_mode,home_country),posted=postedMillis(job.posted_at),required=requirements(job),overlap=(job.skills||[]).filter(s=>known.has(fold(s))),missing=required.skills.filter(s=>!known.has(fold(s))),conflicts=[];
  if(job.closed_signal)conflicts.push('Posting reports closed.');
  if(posted&&hours_old&&now-posted>hours_old*3600000)conflicts.push('Posting is older than the requested window.');
  if(geo.status==='mismatch')conflicts.push(geo.reason||'Advertised location excludes the requested country.');
  const language=languageConflict(job,languages);if(language)conflicts.push(language);
  if(structured&&!query)conflicts.push('The posting does not satisfy your explicit query constraints.');
  // Meaning decides relevance in any language; lexical evidence alone only counts until the job is scored.
  // Shown jobs must be the profession itself or very near it; a title that is clearly a neighbouring
  // occupation (rival) or only loosely similar is left out instead of padding the list.
  // A rival label alone is not irrelevance (ESCO neighbours include close siblings); it hides a job only
  // when the role similarity is also weak. Otherwise the job is shown as related, never auto-sent.
  if(sem){if(!sem.occupation_match&&(sem.role<RELEVANCE.show&&!(query&&sem.role>=RELEVANCE.show-0.08)||sem.rival&&sem.role<RELEVANCE.near))conflicts.push(sem.rival?`Closer to “${sem.rival}” than to your target roles.`:'The role is not close to the target roles.');}
  else if(!query)conflicts.push('The available title and description do not satisfy the search query.');
  if(strict_relevance){
   if(!sem)conflicts.push('Role matching is pending.');
   else if(sem.rival||!sem.occupation_match&&sem.role<RELEVANCE.auto||sem.overall!==undefined&&sem.overall<RELEVANCE.overall)conflicts.push('The occupation does not match the selected professional roles.');
  }
  // Career-level fit is a filter, not a demotion: a student never sees Head of ML, a lead never sees internships.
  const fit=levelConflict(job,level||(early?'early':null),required.minimum_years);if(fit)conflicts.push(fit);
  const senior=early&&(['senior','lead'].includes(job.seniority)||/\b(senior|lead|principal|staff|director|head of|manager)\b/i.test(job.title)),experience=early&&required.minimum_years>=3;
  // A title that clearly is another known role (a rival such as Frontend for a Backend CV) is shown, never auto-sent.
  // A semantic map means this run requires model evaluation. Discovery emits lexical results before
  // that asynchronous work finishes; they may be shown, but must never enter the automatic queue.
  const relevanceState=sem?'scored':semantic?'pending':'lexical';
  const relevant=sem?(sem.occupation_match||sem.role>=RELEVANCE.auto)&&!sem.rival&&(sem.overall===undefined||sem.overall>=RELEVANCE.overall):!semantic&&!!query;
  const score=(sem?sem.score*100:0)+(query?.rrf||0)*400+Math.min(6,overlap.length)-(senior?25:0)-(experience?15:0)+(geo.status==='match'?3:0)+(query?.evidence.some(e=>e.field==='title')?3:0);
  const match={score:Math.round(score*100)/100,relevance:sem,relevance_state:relevanceState,closest_role:sem?.closest_role||null,rival_role:sem?.rival||null,queries:query?.queries||[],evidence:query?.evidence.slice(0,6)||[],overlap,required_skills:required.skills,unverified_skills:missing,minimum_years:required.minimum_years,seniority_conflict:senior,experience_review:experience,topic_review:!relevant,geography:geo,freshness:posted?'posting_date':'observation_only',conflicts,auto_selectable:!conflicts.length&&relevant&&!senior&&!experience&&geo.status!=='unknown'};
  if(conflicts.length){excluded.push({id:job.id,match});continue;}
  results.push({...job,match});
 }
 results.sort((a,b)=>b.match.score-a.match.score||a.id.localeCompare(b.id));
 // Deduplicate by a provider identity or actual employer destination, never a fuzzy title/company.
 const unique=results.filter(job=>{const key=job.canonical_id||job.id,target=destinationKey(job.destination_url||job.apply_url);if(seen.has(key)||seen.has(target))return false;seen.add(key);seen.add(target);return true;});
 return{results:unique,excluded,duplicates:results.length-unique.length,elapsed_ms:performance.now()-start,strategy:'Multilingual title/CV meaning (small CPU encoder) + query evidence + location/freshness/seniority rules'};
}
