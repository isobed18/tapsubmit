// Working-language eligibility. CPU-only rules: posting language from function words/scripts and
// explicit proficiency requirements. Unknown or mixed language never excludes a job.
const fold=value=>String(value||'').normalize('NFKD').replace(/\p{M}/gu,'').toLowerCase().replaceAll('ı','i');
export const LANGUAGES={
 en:{label:'English',names:'english|ingilizce|englisch|anglais|ingles|inglese|engels',stop:'the and of to for with you our are will your this that from have has be on as an at or'},
 tr:{label:'Turkish',names:'turkish|turkce|turkisch|turc|turco',stop:'ve bir bu icin ile olarak olan cok veya ya sahip tercihen deneyimli aranan konusunda ilgili gibi daha'},
 de:{label:'German',names:'german|deutsch|almanca|allemand|aleman|tedesco|duits',stop:'und der die das mit fur wir sie ist ein eine zu von auf im den dem nicht ihre bei unser unsere als auch oder sowie'},
 fr:{label:'French',names:'french|francais|franzosisch|fransizca|frances|francese|frans',stop:'et le les des du pour avec vous nous est une dans sur au aux votre notre qui que sont vos nos'},
 es:{label:'Spanish',names:'spanish|espanol|castellano|spanisch|ispanyolca|espagnol|spagnolo',stop:'y el los las del para con es una por que su sus nuestro como usted tu equipo experiencia'},
 pt:{label:'Portuguese',names:'portuguese|portugues|portugiesisch|portekizce|portugais|portoghese',stop:'e o os as do da dos das para com voce nos uma um em por que seu sua nosso nossa sao'},
 it:{label:'Italian',names:'italian|italiano|italienisch|italyanca|italien',stop:'e il gli della delle del per con voi noi una che sono nostro nostra nella degli alla'},
 nl:{label:'Dutch',names:'dutch|nederlands|niederlandisch|hollandaca|felemenkce|neerlandais',stop:'en het van een voor met je wij zijn op te ons onze jouw bij ook naar wat heb'},
 pl:{label:'Polish',names:'polish|polski|polnisch|lehce|polonais',stop:'i w na z do jest sie oraz dla ze nie od po jak przez lub bedzie pracy'},
 sv:{label:'Swedish',names:'swedish|svenska|schwedisch|isvecce|suedois',stop:'och att det som for med ar pa av ett vi du har till hos eller samt'},
 da:{label:'Danish / Norwegian',names:'danish|dansk|norwegian|norsk|danca|norvecce',stop:'og at det som for med er pa af et vi du har til hos eller samt vil'},
 ru:{label:'Russian',names:'russian|russkiy|russisch|rusca|russe',script:/\p{Script=Cyrillic}/gu},
 ar:{label:'Arabic',names:'arabic|arabisch|arapca|arabe',script:/\p{Script=Arabic}/gu},
 zh:{label:'Chinese',names:'chinese|mandarin|cantonese|chinesisch|cince|chinois',script:/\p{Script=Han}/gu},
 ja:{label:'Japanese',names:'japanese|japanisch|japonca|japonais',script:/[\p{Script=Hiragana}\p{Script=Katakana}]/gu},
 ko:{label:'Korean',names:'korean|koreanisch|korece|coreen',script:/\p{Script=Hangul}/gu},
};
const STOP=Object.entries(LANGUAGES).filter(([,l])=>l.stop).map(([code,l])=>[code,new Set(l.stop.split(' '))]);
// Turkish language names take suffixes (ingilizcem, almancam, turkcemiz).
export const languageName=code=>new RegExp('(?:^|[^a-z])(?:'+LANGUAGES[code].names.replace(/(\w+c[ea])(?=\||$)/g,'$1[a-z]{0,4}')+')(?=$|[^a-z])');
const NAME=Object.keys(LANGUAGES).map(code=>[code,languageName(code)]);
export const LANGUAGE_CODES=Object.keys(LANGUAGES);
export function normalizeLanguages(values){return [...new Set((Array.isArray(values)?values:String(values||'').split(/[,;\s]+/)).map(v=>String(v).toLowerCase().trim()).filter(code=>LANGUAGES[code]))].slice(0,12);}
// Returns {code,confidence} for the dominant language, or null when the text is short or mixed.
export function detectLanguage(text){
 const raw=String(text||'').slice(0,4000);
 for(const [code,l]of Object.entries(LANGUAGES))if(l.script&&(raw.match(l.script)||[]).length>=20)return{code,mixed:false};
 const tokens=fold(raw).split(/[^a-z]+/).filter(Boolean).slice(0,600),scores=STOP.map(([code,set])=>[code,tokens.reduce((n,t)=>n+set.has(t),0)]).sort((a,b)=>b[1]-a[1]);
 const [best,second]=scores;if(!best||best[1]<8||best[1]<second[1]*1.6)return null;
 // A posting with a substantial second language (e.g. German intro + English role text) is mixed.
 return{code:best[0],second:second[1]>=Math.max(6,best[1]*0.35)?second[0]:null};
}
const REQUIRED=/fluen|native|mother tongue|proficien|business|professional|excellent|very good|strong|advanced|c1|c2|b2|required|must|mandatory|essential|written and (?:spoken|verbal)|(?:spoken|verbal) and written|fliessend|verhandlungssicher|sehr gut|gute|kenntnisse|courant|bilingue|maitrise|imprescindible|nativo|fluido|akici|ileri duzey|iyi derecede|zorunlu|vloeiend|biegl/;
const OPTIONAL=/\b(?:a plus|plus|nice to have|bonus|advantage|advantageous|prefer|preferred|preferably|desirable|beneficial|wunschenswert|von vorteil|ein plus|atout|valorable|se valorara|tercihen|tercih sebebi|arti|avantaj|avantajdir)\b/;
// Languages a posting explicitly asks for, from sentences that name a language with a proficiency/requirement cue.
export function requiredLanguages(job){
 const text=fold([job.title,job.description].filter(Boolean).join('\n')).slice(0,20000),found=new Set();
 for(const sentence of text.split(/[\n.;!?•·]+/)){
  if(sentence.length>400||!REQUIRED.test(sentence)||OPTIONAL.test(sentence))continue;
  for(const [code,re]of NAME)if(re.test(sentence))found.add(code);
 }
 // Compounds such as "Deutschkenntnisse"/"Englischkenntnisse" carry the requirement in one word.
 for(const [code,stem]of [['de','deutschkenntniss'],['en','englischkenntniss'],['fr','franzosischkenntniss']])if(text.includes(stem)&&!/deutschkenntnisse[^.\n]{0,40}(?:von vorteil|wunschenswert|ein plus)/.test(text))found.add(code);
 return [...found];
}
// Null = acceptable or uncertain. A reason = the posting needs a language the person did not list.
export function languageConflict(job,known){
 const languages=normalizeLanguages(known);if(!languages.length)return null;
 const label=code=>LANGUAGES[code]?.label||code,missing=requiredLanguages(job).filter(code=>!languages.includes(code));
 if(missing.length)return 'Requires '+missing.map(label).join(', ')+' (not in your languages).';
 const posting=detectLanguage([job.title,job.description].filter(Boolean).join('\n'));
 if(posting&&!languages.includes(posting.code)&&!(posting.second&&languages.includes(posting.second)))return 'Posting is written in '+label(posting.code)+' (not in your languages).';
 return null;
}
// Languages in a CV: the language it is written in plus languages listed with a level or under a languages heading.
export function resumeLanguages(text){
 const lines=String(text||'').split(/\r?\n/),found=new Set(),written=detectLanguage(text);if(written)found.add(written.code);
 const heading=/^\s*(?:languages?|language skills|diller|yabanci diller?|sprachen|sprachkenntnisse|langues|idiomas|lingue|talen)\s*:?\s*/i,level=/native|fluent|mother tongue|bilingual|proficien|advanced|intermediate|upper|beginner|elementary|basic|working|business|professional|\b[abc][12]\b|anadil|ileri|orta|baslangic|iyi|muttersprache|fliessend|grundkenntnisse|courant|langue maternelle|nativo|toefl|ielts|yds|yokdil|cambridge|goethe|delf|dele/;
 lines.forEach((line,index)=>{
  const folded=fold(line),section=heading.test(fold(line).replace(/[^a-z: ]/g,''))||index>0&&heading.test(fold(lines[index-1]).replace(/[^a-z: ]/g,'').trim())&&folded.length<200;
  if(!section&&!level.test(folded))return;
  // Beginner/basic levels are not working languages.
  for(const part of folded.split(/[,;|]|\s\/\s|\s{3,}/))if(!/beginner|elementary|basic|\ba[12]\b|baslangic|temel|grundkenntnisse|debutant|notions|basico/.test(part))for(const [code,re]of NAME)if(re.test(part))found.add(code);
 });
 return [...found];
}
