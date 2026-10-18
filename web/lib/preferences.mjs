import {readFileSync} from 'node:fs';
const RAW_SCHEMA=JSON.parse(readFileSync(new URL('../../config/preference_intents.json',import.meta.url),'utf8'));
export const PREFERENCE_SCHEMA=RAW_SCHEMA.map(({patterns,...spec})=>spec);
const PATTERNS=RAW_SCHEMA.map(spec=>({spec,re:new RegExp('^(?:'+spec.patterns.join('|')+')$','i')}));
const COUNTRIES={US:/\bunited states\b|\bu[.]?s[.]?a?\b/i,GB:/\bunited kingdom\b|\bu[.]?k\b/i,TR:/\bturkey\b|\bturkiye\b/i,DE:/\bgermany\b|\bdeutschland\b/i,CA:/\bcanada\b/i};
function normLabel(value){
 return String(value||'').normalize('NFKC').replace(/[ıİ]/g,'i').toLowerCase().replace(/[*✱]+/g,' ').replace(/\((?:required|optional|zorunlu|isteğe bağlı)\)/gi,' ').normalize('NFKD').replace(/[\u0300-\u036f]/g,'').replace(/\s+/g,' ').replace(/^[\s:?.-]+|[\s:?.-]+$/g,'');
}
export function preferenceSpec(id){
 const known=PREFERENCE_SCHEMA.find(spec=>spec.id===id);if(known)return known;
 let match=id.match(/^salary:(USD|EUR|GBP|TRY|CAD):(year|month|hour):(gross|net)$/);
 if(match)return{id,label:'Expected salary',kind:'number',min:0,max:1e9,unit:match.slice(1).join(' ')};
 match=id.match(/^work_authorization:(US|GB|TR|DE|CA)$/);if(match)return{id,label:'Work authorization',kind:'choice',unit:match[1]};
 match=id.match(/^visa_sponsorship:(US|GB|TR|DE|CA):now_or_future$/);if(match)return{id,label:'Visa sponsorship now or in future',kind:'choice',unit:match[1]};
 match=id.match(/^years_experience:([a-z0-9+#.-]{2,25})$/);if(match)return{id,label:`Years of ${match[1]} experience`,kind:'number',min:0,max:60,unit:'years'};
 match=id.match(/^language_proficiency:(english|turkish|german|french|spanish|arabic)$/);if(match)return{id,label:`${match[1][0].toUpperCase()+match[1].slice(1)} proficiency`,kind:'choice',unit:match[1]};
 return null;
}
export function inferPreferenceFromQuestion(question){
 if(question?.preference?.id&&preferenceSpec(question.preference.id))return preferenceSpec(question.preference.id);
 const label=normLabel(question?.label),kind=String(question?.kind||'text');
 if(['file','checkbox_group','password','hidden','checkbox'].includes(kind)||!label)return null;
 for(const {spec,re} of PATTERNS){
  if(['radio','yesno'].includes(kind)&&spec.kind!=='choice')continue;
  if(spec.id==='salary_statement'&&!['text','textarea'].includes(kind))continue;
  if(re.test(label)){const {patterns,...clean}=spec;return clean;}
 }
 const skillExp=label.match(/^(?:how many )?years of (?:work |professional |hands[- ]on |industry )?experience (?:do you have )?(?:with|in|using) ([a-z0-9+#.-]{2,25})$/)||label.match(/^(?:how many )?years of ([a-z0-9+#.-]{2,25}) (?:work |professional )?experience(?: do you have)?$/);
 if(skillExp&&!['radio','yesno'].includes(kind)&&!['work','professional','relevant','industry','total'].includes(skillExp[1]))return preferenceSpec('years_experience:'+skillExp[1]);
 const langMatch=label.match(/^(?:what is your )?(?:level of )?(?:proficiency|fluency) in (english|turkish|german|french|spanish|arabic)$/)||label.match(/^(?:your )?(english|turkish|german|french|spanish|arabic) (?:proficiency|fluency|level)$/);
 if(langMatch)return preferenceSpec('language_proficiency:'+(langMatch[1]||langMatch[2]));
 const countries=Object.entries(COUNTRIES).filter(([,re])=>re.test(label)).map(([c])=>c);
 if(countries.length===1&&['select','radio','yesno','combobox'].includes(kind)){
  if(/(authorized|authorised|authorization|authorisation).*\bwork\b/.test(label)&&!/not authorized|without|full.time|part.time|citizen|national|sponsor/.test(label))return preferenceSpec('work_authorization:'+countries[0]);
  if(/\brequire\b.*\bsponsor(?:ship)?\b/.test(label)&&!/not require|without|remain|opt|h.?1b|extension/.test(label)&&/now.*future/.test(label))return preferenceSpec('visa_sponsorship:'+countries[0]+':now_or_future');
 }
 return null;
}
export function savePreferences(store,items,settingKey='user_preferences'){
 if(!Array.isArray(items)||items.length>100)throw new Error('Invalid preferences.');
 const bank={...(store.setting(settingKey)||{})};
 for(const item of items){
  const spec=preferenceSpec(String(item.id||''));if(!spec)throw new Error('Unknown preference.');
  if(item.value===null||item.value===''){delete bank[spec.id];continue;}
  if(item.confirmed!==true)throw new Error('Confirm reuse of this answer.');
  let value=String(item.value).trim();if(value.length>2000)throw new Error('Preference is too long.');
  if(spec.kind==='number'){const n=Number(value);if(!Number.isFinite(n)||n<spec.min||n>spec.max)throw new Error('Invalid numeric preference.');value=String(n);}
  if(spec.kind==='url'){let u;try{u=new URL(value);}catch{}if(!u||!['http:','https:'].includes(u.protocol)||u.username||u.password)throw new Error('Enter a public portfolio or website URL.');}
  if(spec.kind==='date'&&(!/^\d{4}-\d{2}-\d{2}$/.test(value)||Number.isNaN(Date.parse(value))))throw new Error('Use YYYY-MM-DD.');
  // source: 'cv' or 'notes' when filled automatically; absent when the person typed it.
  bank[spec.id]={value,confirmed:true,updated_at:Date.now()/1000,...(['cv','notes'].includes(item.source)?{source:item.source}:{})};
 }
 store.setting(settingKey,bank);return bank;
}

