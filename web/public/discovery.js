import {resumeText} from './resume-reader.mjs';
import {profileFeatures,sanitizeFeatures} from './features.mjs';
import {matchProfessionalTitles} from './professional.mjs';
import {createCityPicker} from './city-picker.mjs';
const $=id=>document.getElementById(id),BASE='/api/public/';
const NAMES={indeed:'Indeed',himalayas:'Himalayas',remoteok:'Remote OK',jobicy:'Jobicy',remotive:'Remotive',arbeitnow:'Arbeitnow',boards:'Company careers',linkedin:'LinkedIn'};
let features=null,titles=[],vocabulary=null,sequence=0,limit=100,started=0,timer=null,manualCountry=false;
const cards=new Map(),targets=new Set(),found=new Map();
let countries=[],cities=[],savedCountry='';
const cityPicker=createCityPicker({endpoint:BASE+'locations/cities',onChange:values=>{cities=values;remember();},onError:message=>error(message)});
function remember(){try{localStorage.setItem('tapsubmit:location',JSON.stringify({work_mode:$('work-mode').value,country:$('country').value,cities}));}catch{}}
function renderCountries(){
 const mode=$('work-mode').value,local=['local_only','local_and_remote'].includes(mode),current=$('country').value||savedCountry;
 $('country').replaceChildren(...(local?[node('option','Choose country')]:[]),...countries.filter(([id])=>!local||id!=='worldwide').map(([id,label])=>{const o=node('option',id==='worldwide'?'Worldwide · global remote + my country':label);o.value=id;return o;}));
 if(local)$('country').options[0].value='';
 $('country').value=[...$('country').options].some(o=>o.value===current)&&!(local&&current==='worldwide')?current:local?'':'worldwide';
 updateLocation();
}
function updateLocation(){
 const mode=$('work-mode').value,local=['local_only','local_and_remote'].includes(mode);
 $('country-wrap').hidden=!mode||mode==='anywhere';$('country-label').textContent=local?'Country':'Eligible in';
 if($('country').dataset.last!==$('country').value){if($('country').dataset.last!==undefined)cities=[];$('country').dataset.last=$('country').value;}
 cityPicker.update({country:$('country').value,visible:local,values:cities});remember();
}
// Sharing found jobs is opt-in, remembered only in this browser.
const sharing=()=>$('share-pool').checked;
async function shareFound(){
 if(!sharing()||!found.size)return;const jobs=[...found.values()];found.clear();
 for(let i=0;i<jobs.length;i+=200)try{await fetch(BASE+'pool/contribute',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({consent:true,jobs:jobs.slice(i,i+200)})});}catch{}
}
const node=(tag,text,cls)=>{const e=document.createElement(tag);if(text)e.textContent=text;if(cls)e.className=cls;return e;};
const selected=()=>[...document.querySelectorAll('#source-options input:checked')].map(e=>e.value);
const error=text=>{$('error').textContent=text||'';};
const tags=values=>{$('roles').replaceChildren(...[...new Set(values)].slice(0,6).map(value=>node('span',value,'role')));$('roles').hidden=!values.length;};
function activity(active){$('busy').hidden=!active;clearInterval(timer);if(active)timer=setInterval(()=>{$('elapsed').textContent=((performance.now()-started)/1000).toFixed(1)+' s';},100);}
function sourceProgress(rows){
 const groups=new Map();for(const row of rows||[]){const s=groups.get(row.site)||{busy:false,failed:false,count:0};s.busy||=['queued','searching'].includes(row.state);s.failed||=['failed','throttled','cooling_down'].includes(row.state);s.count+=row.count||0;groups.set(row.site,s);}
 $('progress').replaceChildren(...[...groups].map(([site,s])=>node('span',(NAMES[site]||site)+(s.busy?' · searching':s.failed?' · unavailable':' · done'),'source-status '+(s.busy?'':s.failed?'failed':'done'))));
}
function addJobs(jobs){
 for(const job of jobs){
  let url;try{url=new URL(job.url);if(url.protocol!=='https:')continue;}catch{continue;}
  url.hash='';const target=url.href;if(cards.has(job.id)||targets.has(target))continue;
  const card=node('article','','job-card'),main=node('div'),tag=node('span',job.review?'Check requirements':'Role match','match-tag');
  const title=node('a',job.title,'job-title');title.href=job.url;title.target='_blank';title.rel='noopener noreferrer';
  main.append(tag,node('br'),title,node('p',[job.company,job.location].filter(Boolean).join(' · '),'job-company'));
  const meta=node('div','','job-meta');for(const value of [NAMES[job.source]||job.source,job.closest_role,job.experience_review?'Check experience':null].filter(Boolean))meta.append(node('span',value));main.append(meta);
  const open=node('a','↗','job-arrow');open.href=job.url;open.target='_blank';open.rel='noopener noreferrer';open.setAttribute('aria-label','Open '+job.title+' at '+(job.company||'employer website'));
  card.append(main,open);cards.set(job.id,card);targets.add(target);found.set(job.id,{id:job.id,title:job.title,company:job.company,location:job.location,workplace:job.workplace,url:target,provider:job.source});$('results').append(card);
 }
 $('result-count').textContent=cards.size.toLocaleString();
}
async function readFile(file){
 if(!file)return;const seq=++sequence;activity(false);error('');$('resume-label').textContent='Reading your CV…';
 try{
  const[text,entries]=await Promise.all([resumeText(file),vocabulary?Promise.resolve(vocabulary):fetch(BASE+'vocabulary').then(async r=>{if(!r.ok)throw new Error('Could not load search suggestions. Please try again.');return(await r.json()).entries;})]);
  if(seq!==sequence)return;vocabulary=entries;features=sanitizeFeatures(profileFeatures(text));titles=matchProfessionalTitles(text,entries);
  if(!manualCountry&&features.country&&[...$('country').options].some(o=>o.value===features.country)){$('country').value=features.country;updateLocation();}
  $('resume-label').textContent=file.name;$('resume-note').textContent='Ready · choose where you can work, then press Find jobs';tags(titles);if(!$('work-mode').value)$('work-mode').focus();
 }catch(e){if(seq===sequence){$('resume-label').textContent='Choose another CV';error(e.message);}}
}
async function search(expand=false){
 const query=$('query').value.trim(),sites=selected();error('');
 if(!features&&!query){$('query').focus();error('Upload your CV or enter a job title.');return;}
 if(!sites.length){error('Choose at least one source.');return;}
 const mode=$('work-mode').value,local=['local_only','local_and_remote'].includes(mode);
 if(!mode){error('Choose where you can work: remote only, selected cities or any location.');$('work-mode').focus();return;}
 if(local&&!$('country').value){error('Choose the country of your cities.');$('country').focus();return;}
 if(local&&!cities.length){error('Select at least one city where you can work.');document.querySelector('#city-picker-wrap .ts-control input')?.focus();return;}
 const seq=++sequence;limit=expand?Math.min(300,limit+100):100;started=performance.now();activity(true);
 if(!expand){cards.clear();targets.clear();$('results').replaceChildren();$('result-count').textContent='0';}
 $('results-section').hidden=false;$('more').hidden=true;$('empty').hidden=true;$('search-state').textContent='FINDING YOUR NEXT MOVE';$('summary').textContent='Finding relevant jobs across your selected sites…';sourceProgress(sites.map(site=>({site,state:'searching'})));$('search').disabled=true;
 try{
  const response=await fetch(BASE+'search',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({query,titles,features:{...(features||profileFeatures(query)),country:mode==='anywhere'?'worldwide':$('country').value||'worldwide',remote:mode==='remote_only'},location:local?cities.join('; '):'',work_mode:mode,sites,limit,hours_old:Number($('hours').value)})});
  const task=await response.json();if(!response.ok)throw new Error(task.error||'Search could not start.');if(seq!==sequence)return;
  tags(task.titles?.length?task.titles:task.queries);
  for(let poll=0;poll<240&&seq===sequence;poll++){
   const r=await fetch(BASE+'status?id='+encodeURIComponent(task.id));const data=await r.json();if(!r.ok)throw new Error(data.error||'Search expired. Please search again.');if(seq!==sequence)return;
   addJobs(data.jobs||[]);sourceProgress(data.rows);$('summary').textContent=(data.checked||0).toLocaleString()+' job pages checked'+(data.running?(data.phase==='matching'?' · matching your profile…':' · more sources are searching…'):'');
   if(!data.running){
    $('search-state').textContent='YOUR NEXT POSSIBILITIES';$('empty').hidden=cards.size>0;
    $('summary').textContent=(data.checked||0).toLocaleString()+' job pages checked'+(data.stop_reason==='throttled'?' · some sites are temporarily unavailable':data.can_expand?' · more available':'');
    $('more').hidden=!data.can_expand;if(data.error)error(data.error);shareFound();return;
   }
   await new Promise(resolve=>setTimeout(resolve,650));
  }
  if(seq===sequence)throw new Error('Search is taking longer than expected. Try fewer sources.');
 }catch(e){if(seq===sequence){error(e.message);$('search-state').textContent='SEARCH PAUSED';$('summary').textContent=cards.size?'Your matches are still available below.':'Try again or choose different sources.';}}
 finally{if(seq===sequence){activity(false);$('search').disabled=false;}}
}
$('search-form').addEventListener('submit',e=>{e.preventDefault();search();});
$('resume').addEventListener('change',e=>{const file=e.target.files[0];e.target.value='';readFile(file);});
const upload=document.querySelector('.upload');for(const event of ['dragenter','dragover'])upload.addEventListener(event,e=>{e.preventDefault();upload.classList.add('dragover');});
for(const event of ['dragleave','drop'])upload.addEventListener(event,e=>{e.preventDefault();upload.classList.remove('dragover');if(event==='drop')readFile(e.dataTransfer.files[0]);});
$('filter-toggle').addEventListener('click',()=>{$('filters').hidden=!$('filters').hidden;$('filter-toggle').setAttribute('aria-expanded',String(!$('filters').hidden));});
$('privacy-toggle').addEventListener('click',()=>{$('privacy-detail').hidden=!$('privacy-detail').hidden;});
$('country').addEventListener('change',()=>{manualCountry=true;updateLocation();});
$('work-mode').addEventListener('change',()=>{renderCountries();});$('more').addEventListener('click',()=>search(true));
$('share-toggle').addEventListener('click',()=>{$('share-detail').hidden=!$('share-detail').hidden;});
try{$('share-pool').checked=localStorage.getItem('tapsubmit:share-pool')==='1';}catch{}
$('share-pool').addEventListener('change',()=>{try{localStorage.setItem('tapsubmit:share-pool',sharing()?'1':'0');}catch{}if(sharing())shareFound();});
try{
 const response=await fetch(BASE+'config');if(!response.ok)throw new Error('Could not load job sources. Please reload.');const config=await response.json();
 countries=config.countries;try{const saved=JSON.parse(localStorage.getItem('tapsubmit:location')||'{}');if(saved.work_mode)$('work-mode').value=saved.work_mode;if(saved.country)savedCountry=saved.country;if(Array.isArray(saved.cities))cities=saved.cities;}catch{}renderCountries();
 for(const source of config.sources){const label=node('label'),input=document.createElement('input');input.type='checkbox';input.value=source;input.checked=(config.default_sources||config.sources).includes(source);label.append(input,document.createTextNode(NAMES[source]||source));$('source-options').append(label);}
 if(config.pool?.records){$('pool-count').textContent=config.pool.records.toLocaleString('en-US');if(config.pool.download_bytes)$('pool-size').textContent=' ('+Math.round(config.pool.download_bytes/1e6)+' MB)';$('pool-line').hidden=false;}
 if(config.source_url){for(const id of ['source-link','app-source']){$(id).href=config.source_url;$(id).hidden=false;}$('footer-note').textContent='Free. Open source. Yours.';}else $('source-copy').textContent='We are preparing the public source code; until then, use only what you are comfortable with.';
 if(config.app_url){$('app-download').href=config.app_url;$('app-download').hidden=false;}
 const count=()=>{$('source-count').textContent=selected().length;};$('source-options').addEventListener('change',count);count();
}catch(e){error(e.message);$('search').disabled=true;}
