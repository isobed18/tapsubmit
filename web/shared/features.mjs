// Shared CPU-only feature extraction. No identity/contact fields leave this module.
import {SKILLS} from '../../demo/lib/taxonomy.mjs';
export const VERSION=1;
export const fold=value=>String(value||'').toLowerCase().replaceAll('ı','i').normalize('NFKD').replace(/[\u0300-\u036f]/g,'');
const EXTRA={LangGraph:'\\blanggraph\\b',LangChain:'\\blangchain\\b','Agentic AI':'agentic|ai agents?|tool.calling|function.calling','RAG':'\\brag\\b|retrieval.augmented','Embeddings':'\\bembeddings?\\b',OpenCV:'\\bopencv\\b',YOLO:'\\byolo\\b','scikit-learn':'scikit.learn',Excel:'\\bexcel\\b',PowerBI:'power ?bi',Tableau:'\\btableau\\b',Figma:'\\bfigma\\b',Sketch:'\\bsketch\\b',Salesforce:'salesforce',HubSpot:'hubspot',SEO:'\\bseo\\b',SAP:'\\bsap\\b',IFRS:'\\bifrs\\b',AutoCAD:'autocad',SolidWorks:'solidworks',MATLAB:'matlab',PLC:'\\bplc\\b',Kotlin:'kotlin',Swift:'\\bswift\\b',Flutter:'flutter',Bash:'\\bbash\\b',Git:'\\bgit\\b',Selenium:'selenium',Playwright:'playwright',Cypress:'cypress',Accounting:'accounting|muhasebe',Recruiting:'recruiting|recruitment|ise alim','Project management':'project management|proje yonetimi','Customer support':'customer support|musteri destek','Clinical nursing':'registered nurse|clinical nursing|hemsire'};
export const SKILL_PATTERNS={...SKILLS,...EXTRA};
const role=(id,label,query,pattern,skills=[],anchor=query)=>({id,label,query,pattern,skills,anchor});
export const ROLES=[
 role('agents','AI agents','AI engineer','agentic|ai agent|langgraph|tool.calling',['LangGraph','LangChain','Agentic AI','RAG'],'artificial intelligence engineer'),
 role('ai','AI engineering','AI engineer','\\bai engineer|artificial intelligence|generative ai|\\bllm',['LLM','RAG','LangChain'],'artificial intelligence engineer'),
 role('ml','Machine learning','machine learning engineer','machine learning|makine ogre|\\bml engineer|deep learning',['Machine learning','PyTorch','TensorFlow','scikit-learn']),
 role('vision','Computer vision','computer vision engineer','computer vision|bilgisayarli goru|image segmentation',['Computer vision','OpenCV','YOLO']),
 role('data-science','Data science','data scientist','data scien|veri bilim|statistical model',['Python','SQL','Machine learning']),
 role('data-analysis','Data analysis','data analyst','data analy|business intelligen|veri anali',['SQL','Excel','PowerBI','Tableau']),
 role('data-engineering','Data engineering','data engineer','data engineer|veri muhendis|etl pipeline',['SQL','Spark','Kafka','Python']),
 role('backend','Backend development','backend developer','backend|back.end|api develop',['Python','FastAPI','Django','Node.js','Java','Go']),
 role('frontend','Frontend development','frontend developer','frontend|front.end|web developer',['JavaScript','TypeScript','React']),
 role('software','Software engineering','software engineer','software engineer|software develop|yazilim muhendis|full.?stack',['Python','Java','C++','JavaScript']),
 role('mobile','Mobile development','mobile developer','mobile develop|android|ios develop',['Kotlin','Swift','Flutter']),
 role('devops','DevOps / platform','devops engineer','devops|platform engineer|site reliability|cloud engineer',['AWS','Azure','GCP','Kubernetes','Terraform','Linux']),
 role('security','Cybersecurity','security engineer','cybersecurity|cyber security|security engineer|siber guven',['Linux','Python','Bash']),
 role('qa','QA / testing','QA engineer','quality assurance|test engineer|software tester',['Selenium','Playwright','Cypress']),
 role('design','Product / UX design','product designer','ux design|ui design|product design|kullanici deneyimi',['Figma','Sketch']),
 role('product','Product management','product manager','product manag|urun yonet|product owner',['Project management']),
 role('marketing','Marketing','marketing specialist','marketing (?:specialist|manager|coordinator|director|analyst|intern)|digital market|pazarlama (?:uzman|yonet|sorumlu)|especialista en marketing|seo specialist',['SEO','HubSpot']),
 role('sales','Sales','sales representative','sales representative|account executive|satis temsil|satis danisman|business develop|vertriebsmitarbeiter',['Salesforce','HubSpot']),
 role('finance','Finance','financial analyst','financial analy|finance (?:manager|specialist|analyst|director|officer)|investment analy|finans (?:uzman|yonet|analist)',['Excel','IFRS','SAP']),
 role('accounting','Accounting','accountant','\\baccountant\\b|senior accountant|financial accountant|muhasebe uzman|muhasebeci|mali musavir|buchhalter',['Accounting','Excel','SAP']),
 role('hr','Human resources','recruiter','human resources|recruiter|talent acquisition|insan kaynak|ise alim|personalreferent',['Recruiting']),
 role('support','Customer support','customer support','customer support|customer success|customer service representative|musteri destek|musteri temsil|kundenberater',['Customer support']),
 role('mechanical','Mechanical engineering','mechanical engineer','mechanical engineer|makine muhendis|maschinenbauingenieur',['SolidWorks','AutoCAD','MATLAB']),
 role('electrical','Electrical engineering','electrical engineer','electrical engineer|elektrik(?:-elektronik)? muhendis|electronics engineer|elektroingenieur',['MATLAB','PLC']),
 role('civil','Civil engineering','civil engineer','civil engineer|insaat muhendis|\\bbauingenieur\\b',['AutoCAD']),
 role('nursing','Nursing','registered nurse','registered nurse|clinical nursing|\\bnurse\\b|hemsire|krankenpfleger|pflegefachkraft',['Clinical nursing']),
 role('education','Teaching','teacher','\\bteacher\\b|school teacher|ogretmen|egitimci|\\blehrer\\b',[]),
 role('operations','Operations','operations specialist','operations (?:specialist|manager|coordinator|director)|operasyon (?:uzman|yonet|sorumlu)|supply chain|logistics (?:coordinator|specialist|manager)|lojistik uzman',[]),
];
const compiledSkills=Object.entries(SKILL_PATTERNS).map(([name,pattern])=>[name,new RegExp(pattern,'i')]);
const rolePatterns=ROLES.map(item=>[item,new RegExp(item.pattern,'i')]);
export function extractSkills(text){return compiledSkills.filter(([,pattern])=>pattern.test(text)).map(([name])=>name);}
export function extractRoles(text,skills=[],title=''){
 const plain=fold(text),heading=fold(title),known=new Set(skills);
 // Repeated domain evidence outranks a long generic web-stack skills list. A single
 // frontend project must not drown out nine agent/LLM references in a specialist CV.
 return rolePatterns.map(([item,pattern])=>{const hits=(plain.match(new RegExp(item.pattern,'gi'))||[]).length,generic=['software','backend','frontend'].includes(item.id);return{id:item.id,score:(heading&&pattern.test(heading)?3:0)+Math.min(6,hits)*1.5+Math.min(generic?1:3,item.skills.filter(s=>known.has(s)).length*.8)};}).filter(item=>item.score>=2.4).sort((a,b)=>b.score-a.score||a.id.localeCompare(b.id)).slice(0,4).map(item=>item.id);
}
export function inferLevel(text){const value=fold(text);if(/\b(student|undergraduate|ogrenci|intern|internship|stajyer|staji|yeni mezun|new graduate|recent graduate|entry[- ]level|graduate trainee|werkstudent|praktikant|berufseinsteiger|recien graduado|stagiaire)\b|expected.{0,35}20\d\d|20\d\d.{0,20}expected/.test(value))return'early';if(/\b(senior|principal|staff|director|lead|head of)\b|kidemli|\b(?:[89]|[12]\d)\+?\s*(?:years?|yil|jahre|ans|anos)\b/.test(value.slice(0,700)))return'senior';return'unknown';}
export function regionHint(text){const head=fold(text).slice(0,900);for(const [country,pattern]of [['turkey',/turkiye|turkey|istanbul|ankara|izmir|bursa|antalya/],['germany',/germany|deutschland|berlin|munchen|munich|hamburg|frankfurt/],['uk',/united kingdom|\buk\b|london|manchester|edinburgh/],['usa',/united states|\busa\b|san francisco|new york|seattle|austin|boston/],['netherlands',/netherlands|nederland|amsterdam|rotterdam|eindhoven/],['canada',/canada|toronto|vancouver|montreal/],['france',/france|paris|lyon|toulouse/],['spain',/spain|espana|madrid|barcelona|valencia/],['poland',/poland|polska|warsaw|warszawa|krakow/],['ireland',/ireland|dublin|cork/],['uae',/united arab emirates|\buae\b|dubai|abu dhabi/],['india',/\bindia\b|bengaluru|bangalore|mumbai|hyderabad/],['singapore',/singapore/]])if(pattern.test(head))return country;return'worldwide';}
export function profileFeatures(text){const clean=String(text||'').slice(0,100000),skills=extractSkills(clean),roles=extractRoles(clean,skills,clean.split(/\r?\n/).filter(Boolean).slice(0,5).join(' '));return{v:VERSION,roles,skills,level:inferLevel(clean),country:regionHint(clean),remote:false};}
export function sanitizeFeatures(input){
 const roleIds=new Set(ROLES.map(item=>item.id)),skillIds=new Set(Object.keys(SKILL_PATTERNS)),countries=new Set(['turkey','germany','uk','usa','netherlands','france','canada','ireland','spain','poland','uae','india','singapore','worldwide']);
 return{v:VERSION,roles:[...new Set((Array.isArray(input?.roles)?input.roles:[]).filter(id=>roleIds.has(id)))].slice(0,4),skills:[...new Set((Array.isArray(input?.skills)?input.skills:[]).filter(id=>skillIds.has(id)))].sort().slice(0,50),level:['early','senior','unknown'].includes(input?.level)?input.level:'unknown',country:countries.has(input?.country)?input.country:'worldwide',remote:input?.remote===true};
}
export function suggestedSearches(input){const p=sanitizeFeatures(input),roles=p.roles.map(id=>ROLES.find(item=>item.id===id)).filter(Boolean),queries=roles.slice(0,3).map(item=>item.query);if(p.level==='early'&&roles.length)queries.splice(2,1,roles[0].id==='agents'||roles[0].id==='ai'||roles[0].id==='ml'?'machine learning intern':roles[0].query+' intern');return[...new Set(queries)].slice(0,3);}
export function sparseVector(input){const p=sanitizeFeatures(input),vector={};for(const id of p.roles)vector['role:'+id]=4;for(const id of p.skills)vector['skill:'+id]=1;return vector;}
export function cosine(a,b){let dot=0,aa=0,bb=0;for(const [key,value]of Object.entries(a)){aa+=value*value;dot+=value*(b[key]||0);}for(const value of Object.values(b))bb+=value*value;return aa&&bb?dot/Math.sqrt(aa*bb):0;}
export function jobFeatures(job){const skills=job.skills?.length?job.skills:extractSkills(job.title+'\n'+job.description),title=fold(job.title),direct=rolePatterns.filter(([,pattern])=>pattern.test(title)).map(([item])=>item.id);return{roles:direct.length?direct:extractRoles(String(job.description||'').slice(0,1000),skills,job.title).slice(0,2),skills};}
