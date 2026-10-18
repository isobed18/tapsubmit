export const FIELDS = new Set(['title','description','skill','company','location','workplace','level','type','source']);
const aliases = new Map([['postgres','postgresql'],['k8s','kubernetes'],['turkiye','turkey'],['onsite','onsite'],['on-site','onsite']]);
export function fold(text) { return String(text ?? '').toLowerCase().replaceAll('ı','i').normalize('NFKD').replace(/[\u0300-\u036f]/g,''); }
export function words(text) { return (fold(text).match(/c\+\+|c#|\.net|node\.js|[a-z0-9]+/g) || []).map(x=>aliases.get(x)||x); }
function canonical(text) { return words(text).join(' '); }

export function parseQuery(query) {
  if (query.length > 500) throw new Error('Use at most 500 characters.');
  const tokens=[]; let i=0;
  while(i<query.length) {
    if (/\s/.test(query[i])) {i++;continue;}
    if ('()'.includes(query[i])) {tokens.push({type:query[i++]});continue;}
    let field=null, value='', quoted=false;
    const prefix=query.slice(i).match(/^([a-z_]+):/i);
    if(prefix) {field=prefix[1].toLowerCase();i+=prefix[0].length;if(!FIELDS.has(field)) throw new Error(`Unknown field “${field}”.`);}
    if(query[i]==='"') {quoted=true;i++;const start=i;while(i<query.length&&query[i]!=='"') i++;if(i===query.length) throw new Error('Close the quoted phrase.');value=query.slice(start,i++);}
    else {const start=i;while(i<query.length&&!/[\s()]/.test(query[i])) i++;value=query.slice(start,i);}
    if(!value) throw new Error('Add a value after the field name.');
    const op=!field&&!quoted&&['AND','OR','NOT'].includes(value.toUpperCase())?value.toUpperCase():null;
    tokens.push(op?{type:op}:{type:'term',field,value,quoted});
    if(tokens.length>80) throw new Error('Use at most 80 query terms and operators.');
  }
  let cursor=0,depth=0;
  const peek=()=>tokens[cursor]?.type;
  function unary(){
    if(++depth>16) throw new Error('Too many nested expressions.');
    let node;
    if(peek()==='NOT'){cursor++;node={type:'not',child:unary()};}
    else if(peek()==='('){cursor++;node=or();if(peek()!==')')throw new Error('Close the parenthesis.');cursor++;}
    else if(peek()==='term')node=tokens[cursor++];
    else throw new Error('Expected a search term or phrase.');
    depth--;return node;
  }
  function and(){let node=unary();while(peek()==='AND'||['term','NOT','('].includes(peek())){if(peek()==='AND')cursor++;node={type:'and',left:node,right:unary()};}return node;}
  function or(){let node=and();while(peek()==='OR'){cursor++;node={type:'or',left:node,right:and()};}return node;}
  if(!tokens.length)return {type:'all'};
  const ast=or();if(cursor!==tokens.length)throw new Error('Unexpected closing parenthesis.');return ast;
}
function intersection(a,b){const small=a.size<b.size?a:b,big=small===a?b:a;return new Set([...small].filter(x=>big.has(x)));}
function positiveTerms(ast,negated=false,out=[]){if(ast.type==='term'&&!negated)out.push(ast);if(ast.child)positiveTerms(ast.child,!negated,out);if(ast.left)positiveTerms(ast.left,negated,out);if(ast.right)positiveTerms(ast.right,negated,out);return out;}
function postedTime(value){if(!value)return null;const numeric=Number(value);if(Number.isFinite(numeric)&&numeric>1e10)return numeric;const parsed=Date.parse(value);return Number.isFinite(parsed)?parsed:null;}
const searchable=['title','skill','company','location','description'];
const weights={title:5,skill:4,company:2,location:1.5,description:1,workplace:2,level:2,type:2,source:1};
class PackedPostings {
 constructor(packed){this.data=packed.values;this.keys=new Map(packed.terms.map((key,i)=>[key,i]));this.cache=new Map();}
 get(key){if(this.cache.has(key))return this.cache.get(key);const index=this.keys.get(key);if(index===undefined)return undefined;const flat=this.data[index],map=new Map();for(let i=0;i<flat.length;i+=2)map.set(flat[i],flat[i+1]);this.cache.set(key,map);return map;}
}
function normalized(doc,field){if(!(field in doc.normalized))doc.normalized[field]=' '+words(doc.fields[field]).join(' ')+' ';return doc.normalized[field];}
function locationText(job){let value=(job.locations?.length?job.locations:[job.location]).join(' · ');if(/\b(istanbul|ankara|izmir|antalya|bursa|kocaeli|eskisehir|diyarbakir)\b/.test(fold(value))&&!/turkey|turkiye/.test(fold(value)))value+=' · Turkey';return value;}

export class SearchEngine {
  constructor(catalog,packed=null) {
    const start=performance.now();this.catalog=catalog;this.jobs=catalog.jobs;this.byId=new Map();this.postings=new Map();this.docs=[];
    const usePacked=packed&&catalog.search_revision&&packed.search_revision===catalog.search_revision&&packed.ids?.length===this.jobs.length&&packed.ids.every((id,i)=>id===this.jobs[i].id);
    this.prebuilt=!!usePacked;
    if(usePacked)this.postings=new PackedPostings(packed);
    const ids=new Set();
    for(const job of this.jobs){
      if(ids.has(job.id))throw new Error('Duplicate canonical job identity in catalog.');ids.add(job.id);
      const fields={title:job.title,description:job.description,skill:(job.skills||[]).join(' · ')+((job.skills||[]).includes('Go')?' · Golang':''),company:job.company,
        location:locationText(job),workplace:job.workplace,level:job.seniority,type:job.employment_type,source:job.provider};
      const normalized={},counts=new Map();let length=0;
      if(usePacked){this.docs.push({job,fields,normalized,length:packed.lengths[this.docs.length]});this.byId.set(job.id,this.docs.length-1);continue;}
      for(const [field,text] of Object.entries(fields)){
        const tokens=words(text);normalized[field]=' '+tokens.join(' ')+' ';length+=tokens.length;
        for(const word of tokens){const key=field+':'+word;counts.set(key,(counts.get(key)||0)+1);}
      }
      const index=this.docs.length;
      for(const [key,tf] of counts){if(!this.postings.has(key))this.postings.set(key,new Map());this.postings.get(key).set(index,tf);}
      this.docs.push({job,fields,normalized,length});this.byId.set(job.id,index);
    }
    this.averageLength=this.docs.reduce((sum,d)=>sum+d.length,0)/Math.max(1,this.docs.length);
    this.all=new Set(this.docs.map((_,i)=>i));
    this.initMs=performance.now()-start;
  }
  termLookup(term){
    const tokens=words(term.value),fields=term.field?[term.field]:fold(term.value)==='go'?['skill']:searchable;
    if(!tokens.length)return new Set();let candidates=new Set();
    for(const field of fields){
      let found=null;
      for(const word of tokens){const postings=this.postings.get(field+':'+word);const ids=new Set(postings?.keys()||[]);found=found===null?ids:intersection(found,ids);if(!found.size)break;}
      if(tokens.length>1)found=new Set([...found].filter(id=>normalized(this.docs[id],field).includes(' '+tokens.join(' ')+' ')));
      for(const id of found||[])candidates.add(id);
    }
    return candidates;
  }
  evaluate(ast){
    if(ast.type==='all')return this.all;
    if(ast.type==='term')return this.termLookup(ast);
    if(ast.type==='not'){const no=this.evaluate(ast.child);return new Set([...this.all].filter(x=>!no.has(x)));}
    const left=this.evaluate(ast.left),right=this.evaluate(ast.right);
    return ast.type==='and'?intersection(left,right):new Set([...left,...right]);
  }
  evidence(doc,terms){
    const evidence=[];
    for(const term of terms){
      const needle=' '+canonical(term.value)+' ';
      for(const field of term.field?[term.field]:searchable){
        if(!normalized(doc,field).includes(needle))continue;
        const text=String(doc.fields[field]||'');const at=Math.max(0,fold(text).indexOf(fold(term.value)));
        evidence.push({field,term:term.value,text:(at>70?'…':'')+text.slice(Math.max(0,at-70),at+170)+(text.length>at+170?'…':'')});break;
      }
    }
    return evidence.slice(0,5);
  }
  search(query,filters={},limit=50){
    const tick=performance.now(),ast=parseQuery(query),terms=positiveTerms(ast),now=Date.now();let candidates=[...this.evaluate(ast)];
    const excluded={workplace:0,level:0,location:0,skills:0,salary:0,freshness:0,employment_type:0};
    const requireSkills=(filters.skills||[]).map(canonical);
    candidates=candidates.filter(id=>{
      const doc=this.docs[id],{job}=doc;
      if(filters.workplace&&job.workplace!==filters.workplace){excluded.workplace++;return false;}
      if(filters.levels?.length&&!filters.levels.includes(job.seniority)){excluded.level++;return false;}
      if(filters.location&&!normalized(doc,'location').includes(' '+canonical(filters.location)+' ')){excluded.location++;return false;}
      if(filters.employment_type&&job.employment_type!==filters.employment_type){excluded.employment_type++;return false;}
      if(requireSkills.some(skill=>!normalized(doc,'skill').includes(' '+skill+' '))){excluded.skills++;return false;}
      if(filters.min_salary){const s=job.salary;const annual=s&&/year|annual/i.test(s.period||'');if(!s||s.currency!=='USD'||!annual||!(s.min>=Number(filters.min_salary))){excluded.salary++;return false;}}
      if(filters.max_age_hours&&(now-job.seen_at*1000)>filters.max_age_hours*3600000){excluded.freshness++;return false;}
      return true;
    });
    const facets={workplace:{},level:{},company:{},type:{}};
    const dfs=new Map();
    for(const term of terms)for(const word of words(term.value)){const fields=term.field?[term.field]:searchable;const docs=new Set();for(const f of fields)for(const id of this.postings.get(f+':'+word)?.keys()||[])docs.add(id);dfs.set(word,docs.size);}
    const seenOpportunities=new Set();
    const ranked=candidates.map(id=>{
      const doc=this.docs[id];let score=0;
      for(const term of terms)for(const word of words(term.value))for(const field of term.field?[term.field]:searchable){
        const tf=this.postings.get(field+':'+word)?.get(id)||0;if(!tf)continue;
        const idf=Math.log(1+(this.docs.length-(dfs.get(word)||0)+.5)/((dfs.get(word)||0)+.5));
        score+=(weights[field]||1)*idf*(tf*2.2)/(tf+1.2*(.25+.75*doc.length/this.averageLength));
      }
      return {id,score};
    }).sort((a,b)=>b.score-a.score||this.docs[a.id].job.id.localeCompare(this.docs[b.id].job.id)).filter(row=>{const job=this.docs[row.id].job,key=job.canonical_id||job.id;if(seenOpportunities.has(key))return false;seenOpportunities.add(key);return true;});
    for(const row of ranked){const j=this.docs[row.id].job;for(const [facet,value]of Object.entries({workplace:j.workplace,level:j.seniority,company:j.company,type:j.employment_type}))facets[facet][value]=(facets[facet][value]||0)+1;}
    return {query,ast,total:ranked.length,matching_postings:candidates.length,duplicate_postings_removed:candidates.length-ranked.length,query_ms:performance.now()-tick,facets,excluded,
      results:ranked.slice(0,Math.max(1,Math.min(100,limit))).map(({id,score})=>({
        ...this.docs[id].job,rank_score:Math.round(score*100)/100,evidence:this.evidence(this.docs[id],terms),
        posted_time:postedTime(this.docs[id].job.posted_at),application_capability:'sandbox_only'}))};
  }
}

export function emailDraft(job){
  return {to:'',subject:`Application for ${job.title} at ${job.company}`,
    body:`Hello ${job.company} team,\n\nI am interested in your ${job.title} opening. My demonstration profile includes Python, SQL and a software portfolio. ${job.skills?.some(s=>['Python','SQL'].includes(s))?'The listed technologies overlap with that profile.':'I would like to learn more about the role requirements.'}\n\nPortfolio: https://example.test/portfolio\nResume: synthetic-resume.txt\n\nThank you,\nDemo Candidate`,
    note:'Synthetic profile and template only. No recruiter address is inferred; no email is sent.'};
}
