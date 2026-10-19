// Data-driven phrase matching over declared occupation aliases, shared with the browser.
// A job catalog's arbitrary words ("Engineering", "Product") are never occupation labels.
export const roleKey=text=>String(text||'').toLowerCase().replaceAll('ı','i').normalize('NFKD').replace(/[\u0300-\u036f]/g,'').replace(/[^\p{L}\p{N}+#]+/gu,' ').replace(/\s+/g,' ').trim();
const indices=new WeakMap();
// A field of study names its practitioner: "Makine Mühendisliği" -> "Makine Mühendisi", "Mechanical Engineering" -> "Mechanical Engineer".
const DISCIPLINE={muhendisligi:'muhendisi',muhendislik:'muhendisi',engineering:'engineer',development:'developer',hemsirelik:'hemsire',ogretmenligi:'ogretmeni',ogretmenlik:'ogretmen'};
const same=(token,word)=>token===word||DISCIPLINE[token]===word;
export function professionalMatches(text,entries){
 let index=indices.get(entries);if(!index){index=new Map();indices.set(entries,index);for(const entry of entries)for(const alias of new Set([entry.title,...(entry.aliases||[])])){
  const words=roleKey(alias).split(' ');if(words.join('').length<4||words.length>12)continue;
  const list=index.get(words[0])||[];list.push({words,entry,direct:roleKey(alias)===roleKey(entry.title)});index.set(words[0],list);
 }}
 const tokens=roleKey(text).split(' '),hits=[];
 for(let at=0;at<tokens.length;at++)for(const item of index.get(tokens[at])||[]){if(item.words.every((word,i)=>same(tokens[at+i],word)))hits.push({...item,at,end:at+item.words.length});}
 hits.sort((a,b)=>b.words.length-a.words.length||Number(b.direct)-Number(a.direct)||a.at-b.at||a.entry.title.localeCompare(b.entry.title));
 // Resolve overlapping spans first without dropping repeated mentions of the same occupation across a CV.
 const spans=[];for(const hit of hits){if(spans.some(other=>other.at<hit.end&&other.end>hit.at))continue;spans.push(hit);}
 const byTitle=new Map();
 for(const hit of spans){
  const prev=byTitle.get(hit.entry.title);
  if(!prev)byTitle.set(hit.entry.title,{title:hit.entry.title,occupation_id:hit.entry.occupation_id||null,at:hit.at,words:hit.words.length,direct:hit.direct,count:1});
  else{prev.count++;if(hit.at<prev.at)prev.at=hit.at;if(hit.words.length>prev.words)prev.words=hit.words.length;if(hit.direct)prev.direct=true;}
 }
 const accepted=[...byTitle.values()].filter(h=>tokens.length<=25||h.words>1||h.count>1||h.at<=35);
 if(tokens.length>15){
  const score=h=>(h.at<8?4:h.at<20?2.5:h.at<40?1:0)+Math.min(4,h.count-1)*1.8+Math.min(4,h.words)*0.7+(h.direct?0.4:0)-(h.at>60&&h.count===1?2:0);
  accepted.sort((a,b)=>score(b)-score(a)||b.words-a.words||Number(b.direct)-Number(a.direct)||a.at-b.at||a.title.localeCompare(b.title));
 }else{
  accepted.sort((a,b)=>b.words-a.words||Number(b.direct)-Number(a.direct)||a.at-b.at||a.title.localeCompare(b.title));
 }
 return accepted;
}
export const matchProfessionalTitles=(text,entries,limit=8)=>professionalMatches(text,entries).slice(0,limit).map(hit=>hit.title);
