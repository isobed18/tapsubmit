import {SKILLS} from '../../demo/lib/taxonomy.mjs';
import {resumeLanguages} from './languages.mjs';
import {EXTRA_SKILLS} from './jobs.mjs';
export const TRACKS=[
 {id:'agents',label:'AI agents',query:'(langgraph OR langchain OR agentic OR "tool calling" OR "function calling") AND (title:engineer OR title:developer OR title:research OR title:intern)'},
 {id:'ai',label:'AI engineer',query:'"AI engineer" OR "applied AI" OR "generative AI" OR "LLM engineer"'},
 {id:'ml',label:'Machine learning',query:'"machine learning" OR pytorch OR "ML engineer"'},
 {id:'vision',label:'Computer vision',query:'"computer vision" OR opencv OR "object detection" OR "image segmentation"'},
 {id:'backend',label:'Python backend',query:'skill:python AND (fastapi OR django OR backend)'},
 {id:'early',label:'Intern / graduate',query:'(level:intern OR level:junior) AND ("machine learning" OR python OR "artificial intelligence")'}
];
export function simpleQuery(text){
 if(/[():"]|\b(?:AND|OR|NOT)\b/.test(text))return text;
 const value=text.trim().toLowerCase();const aliases={agents:['ai agents','agentic','agentic system','agentic systems','langgraph','langchain'],ai:['ai engineer','ai engineering','generative ai','llm engineer'],ml:['machine learning','machine learning engineer','ml engineer'],vision:['computer vision','vision engineer'],backend:['python backend','backend python'],early:['intern','internship','graduate','early career','intern / graduate']};
 for(const [id,labels]of Object.entries(aliases))if(labels.includes(value))return TRACKS.find(t=>t.id===id).query;return text;
}
export const CONTACT_PARSER_VERSION=2;
export function resumeContacts(text){
 const lines=String(text).split(/\r?\n/).map(line=>line.trim()).filter(Boolean),header=lines.slice(0,12).join('\n').slice(0,1800);
 const labelled=label=>lines.map(line=>line.match(new RegExp('^(?:'+label+')\\s*[:：]\\s*(.+)$','iu'))?.[1]).find(Boolean)||'';
 const unique=values=>{const found=[...new Set(values)];return found.length===1?found[0]:'';};
 const emails=value=>[...value.matchAll(/[\p{L}\p{N}._%+-]+@[\p{L}\p{N}.-]+\.[\p{L}]{2,}/gu)].map(match=>match[0]);
 const phones=value=>[...value.matchAll(/(?<![\p{L}\d])(?:\+|00)?\d[\d\t ().-]{7,30}\d(?![\p{L}\d])/gu)].map(match=>match[0].replace(/\s+/g,' ').trim()).filter(value=>{const digits=value.replace(/\D/g,'');return digits.length>=10&&digits.length<=15;});
 const urls=host=>[...header.matchAll(new RegExp('(?:https?:\\/\\/)?(?:www\\.)?'+host+'\\/[^\\s<>|·]+','giu'))].map(match=>'https://'+match[0].replace(/^https?:\/\//i,'').replace(/[),.;]+$/,''));
 const location=labelled('location|address|konum|adres|standort|adresse');
 const contactLine=lines.slice(0,8).find(line=>line.includes('@'))||'';
 const place=contactLine.split(/[·|•]/).map(part=>part.trim()).filter(part=>part&&!part.includes('@')&&!/https?:|www\.|linkedin\.|github\.|\d{3}/i.test(part));
 return{email:unique(emails(labelled('e-?mail|e-?posta|courriel|correo(?: electrónico)?')))||unique(emails(header)),phone:unique(phones(labelled('phone|mobile|tel(?:ephone|efon)?|telefon|cep(?: telefonu)?|téléphone')))||unique(phones(header)),
  location:location||(place.length===1?place[0]:''),linkedin:labelled('linkedin')||unique(urls('linkedin\\.com/in')),github:labelled('github')||unique(urls('github\\.com'))};
}
export function profileFromText(text,filename='resume.docx'){
 const lines=text.split(/\r?\n/).map(s=>s.trim()).filter(Boolean),skills=Object.entries({...SKILLS,...EXTRA_SKILLS}).filter(([,pattern])=>new RegExp(pattern,'i').test(text)).map(([label])=>label);
 return{name:lines[0]||'Admin',headline:lines[1]||'',...resumeContacts(text),contact_parser_version:CONTACT_PARSER_VERSION,skills,languages:resumeLanguages(text),filename,imported_at:new Date().toISOString(),facts:{graduation:lines.find(l=>/2027.*expected|expected.*2027/i.test(l))||null,work_authorization:null,relocation:null,availability:null},tracks:TRACKS,notes:['Skills were extracted from the resume using rules. Overlap does not prove job eligibility.','Work authorization, relocation and start date need explicit answers before a real application.']};
}
export function profileMatch(job,profile){
 if(!profile)return{overlap:[],notes:['No resume imported.']};const known=new Set(profile.skills.map(s=>s.toLowerCase())),overlap=(job.skills||[]).filter(s=>known.has(s.toLowerCase()));
 const notes=[];if(['senior','lead'].includes(job.seniority))notes.push('Senior role: review experience requirements.');if(job.workplace==='remote')notes.push('Remote may still have country or timezone restrictions.');
 const years=[...job.description.matchAll(/(?:at least |minimum |minimum of )?(\d{1,2})\+?\s*(?:-|to\s*\d+\s*)?years?\s+(?:of )?(?:professional |relevant |industry |software |engineering |work )*experience/gi)].map(m=>Number(m[1])).filter(n=>n<=30);
 if(years.length&&Math.max(...years)>=3)notes.push(`Description mentions ${Math.max(...years)}+ years of experience; review the exact requirement.`);
 if(!profile.facts?.work_authorization)notes.push('Work authorization is unknown.');return{overlap,notes};
}
export function personalDraft(job,profile){
 const match=profileMatch(job,profile),skills=match.overlap.slice(0,4).join(', '),name=profile?.name||'Candidate';return{to:'',subject:`Application for ${job.title} at ${job.company}`,body:`Hello ${job.company} team,\n\nI am interested in your ${job.title} opening.${skills?' My resume includes experience and projects using '+skills+'.':''}\n\n${profile?.github?'Projects: '+profile.github+'\n':''}I would welcome the opportunity to discuss the role and my background.\n\nThank you,\n${name}`,note:'Draft only. Review before sending. No recipient is guessed and no mail is sent.'};
}
