import {resumeText} from './resume-reader.mjs';
import {profileFeatures} from './features.mjs';
import {matchProfessionalTitles} from './professional.mjs';
const $=selector=>document.querySelector(selector),node=(tag,text)=>{const element=document.createElement(tag);element.textContent=text;return element;};
const NAMES={linkedin:'LinkedIn',indeed:'Indeed',himalayas:'Himalayas',remoteok:'Remote OK',jobicy:'Jobicy',remotive:'Remotive',arbeitnow:'Arbeitnow',boards:'Company career sites'};
let features=null,titles=[],sequence=0,vocabulary=null,currentLimit=100;
const config=await(await fetch('/applyburst/api/public/config')).json();
for(const[id,label]of config.countries){const option=node('option',label);option.value=id;$('#country').append(option);}
for(const source of config.sources){const label=node('label',''),input=document.createElement('input');input.type='checkbox';input.name='source';input.value=source;input.checked=(config.default_sources||config.sources).includes(source);label.append(input,document.createTextNode(NAMES[source]||source));$('#sources').append(label);}
const selectedSources=()=>[...document.querySelectorAll('#sources input:checked')].map(input=>input.value);
function sourceSummary(){const n=selectedSources().length;$('#source-summary').textContent='Sources · '+n+' selected';}
sourceSummary();$('#sources').addEventListener('change',()=>{sourceSummary();if(features)$('#search-again').hidden=false;});
const setTags=labels=>$('#roles').replaceChildren(...labels.map(label=>node('span',label)));
function sourceProgress(rows){
 const grouped=new Map();for(const row of rows){const item=grouped.get(row.site)||{active:0,found:0,failed:0,cached:0};item.active+=['queued','searching'].includes(row.state)?1:0;item.found+=row.count||0;item.failed+=['failed','throttled','cooling_down'].includes(row.state)?1:0;item.cached+=row.state==='cached'?1:0;grouped.set(row.site,item);}
 $('#source-progress').replaceChildren(...[...grouped].map(([site,s])=>node('span',(NAMES[site]||site)+': '+(s.active?'searching':s.failed?'partly unavailable':s.cached?'saved results':'done')+' · '+s.found+' candidates')));
}
async function search(limit=100){
 if(!features)return;
 const sites=selectedSources();if(!sites.length){$('#error').textContent='Choose at least one job source.';return;}
 const seq=++sequence,cards=new Map();currentLimit=limit;$('#error').textContent='';$('#results').replaceChildren();$('#source-progress').replaceChildren();$('#more').hidden=true;$('#search-again').hidden=true;$('#status').textContent='Searching selected sources…';
 try{
  const response=await fetch('/applyburst/api/public/search',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({titles,features:{...features,country:$('#country').value,remote:$('#remote').checked},sites,limit})}),task=await response.json();
  if(!response.ok)throw new Error(task.error);if(seq!==sequence)return;
  setTags(task.titles);$('#queries').textContent='Searching: '+task.queries.join(' · ');
  for(let tries=0;tries<170&&seq===sequence;tries++){
   const result=await fetch('/applyburst/api/public/status?id='+encodeURIComponent(task.id)),data=await result.json();if(!result.ok)throw new Error(data.error);if(seq!==sequence)return;
   const stopNote=!data.running?(data.stop_reason==='budget_reached'?' · pass limit reached (more available)':data.stop_reason==='max_budget_reached'?' · max depth (300/source) reached':data.stop_reason==='throttled'?' · some sources throttled':' · all available matches checked'):(data.phase==='matching'?' · checking matches…':' · still searching…');
   $('#status').textContent=data.jobs.length+' matching jobs · '+data.checked+' checked · '+(data.elapsed_ms/1000).toFixed(1)+' s'+stopNote;
   sourceProgress(data.rows);
   const ordered=[];for(const job of data.jobs){if(!/^https:\/\//.test(job.url))continue;let card=cards.get(job.id);if(!card){card=node('article','');const link=node('a',job.title);link.href=job.url;link.target='_blank';link.rel='noopener noreferrer';card.append(link,node('p',[job.company,job.location].filter(Boolean).join(' · ')),node('small',[NAMES[job.source]||job.source,job.route,job.closest_role?'Matches '+job.closest_role:'',job.experience_review?'Check experience requirements':job.review?'Check requirements':''].filter(Boolean).join(' · ')));cards.set(job.id,card);}ordered.push(card);}
   $('#results').replaceChildren(...ordered);
   if(!data.running){if(data.error)throw new Error(data.error);$('#more').hidden=!data.can_expand;if(data.can_expand)$('#more').textContent='Search deeper (up to '+Math.min(300,data.limit+100)+' per source)';if(!data.jobs.length)$('#status').textContent='No confident matches among '+data.checked+' candidates'+(data.stop_reason==='budget_reached'?' in the first pass — try Search deeper or another region/source.':'. Try another region or source.');return;}
   await new Promise(resolve=>setTimeout(resolve,650));
  }
  if(seq===sequence)throw new Error('This search is taking longer than expected. Try fewer sources.');
 }catch(error){if(seq===sequence){$('#error').textContent=error.message;$('#search-again').hidden=false;}}
}
$('#resume').addEventListener('change',async event=>{
 const file=event.target.files[0];if(!file)return;event.target.value='';const importSeq=++sequence;features=null;titles=[];$('#results').replaceChildren();$('#source-progress').replaceChildren();$('#preferences').hidden=true;$('#more').hidden=true;$('#status').textContent='Reading your CV on this device…';$('#error').textContent='';
 try{const text=await resumeText(file);vocabulary??=(await(await fetch('/applyburst/api/public/vocabulary')).json()).entries||[];if(importSeq!==sequence)return;features=profileFeatures(text);titles=matchProfessionalTitles(text,vocabulary);$('#country').value=features.country;$('#preferences').hidden=false;await search();}
 catch(error){if(importSeq===sequence){$('#error').textContent=error.message;$('#status').textContent='';}}
});
$('#country').addEventListener('change',()=>search());$('#remote').addEventListener('change',()=>search());
$('#search-again').addEventListener('click',()=>search());$('#more').addEventListener('click',()=>search(Math.min(300,currentLimit+100)));
