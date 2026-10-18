const BASE='/applyburst';
const $=selector=>document.querySelector(selector);
const make=(tag,cls='',text='')=>{const element=document.createElement(tag);if(cls)element.className=cls;if(text!==undefined&&text!==null&&text!=='')element.textContent=text;return element;};
const state={csrf:'',boot:null,tab:'find',jobs:[],selected:new Set(),filter:'all',discoveryTimer:null,browserTimer:null,browserKey:'',apps:null,searchRunning:false};
const STATE_LABEL={ready_to_submit:'Ready to submit',needs_answers:'Needs your answers',needs_login:'Needs sign-in',needs_human_verification:'Needs you in the browser',unsupported_site:'Not supported yet',employer_site_redirect:'Applies on company site',form_not_found:'Form not found',adapter_needs_update:'Form not understood',failed_before_submit:'Failed · nothing sent',plan_changed:'Form changed · review again',preparing:'Preparing…',submit_in_progress:'Opening…',submitting:'Submitting…',confirmed:'Confirmed by employer',unknown_after_submit:'Sent? Unknown · check it',submit_rejected:'Rejected by the website',already_applied:'Already applied',rate_limited:'Site limit reached',closed_or_unavailable:'Closed',not_started:'Not started · nothing sent',marked_submitted:'You marked: submitted',marked_not_submitted:'You marked: not submitted',inspected:'Inspected'};
const TONE={confirmed:'good',already_applied:'good',marked_submitted:'good',ready_to_submit:'ready',preparing:'busy',submit_in_progress:'busy',submitting:'busy',unknown_after_submit:'bad',submit_rejected:'bad',failed_before_submit:'bad'};
const BLOCKING=new Set(['submitting','unknown_after_submit','confirmed','already_applied','marked_submitted']);
const SOURCE_LABEL={resume:'Résumé',approved_answer:'Your answer',derived_from_phone:'From your phone number',site_prefilled:'Already on the website'};
const SITE_LABEL={linkedin:'LinkedIn',indeed:'Indeed',glassdoor:'Glassdoor',google:'Google Jobs',greenhouse:'Greenhouse',lever:'Lever',ashby:'Ashby',smartrecruiters:'SmartRecruiters'};
let toastTimer;
function toast(text){$('#toast').textContent=text;$('#toast').hidden=false;clearTimeout(toastTimer);toastTimer=setTimeout(()=>$('#toast').hidden=true,4200);}
async function api(path,options={}){
 const method=options.method||'GET',headers={...options.headers};if(method!=='GET'&&state.csrf)headers['X-CSRF-Token']=state.csrf;if(typeof options.body==='string')headers['Content-Type']='application/json';
 const response=await fetch(BASE+'/api/'+path,{...options,method,headers,credentials:'same-origin'});let data={};try{data=await response.json();}catch{}
 if(!response.ok){if(response.status===401&&document.body.dataset.screen==='app')location.assign(BASE+'/');throw new Error(data.error||'Request failed.');}return data;
}
const post=(path,data={})=>api(path,{method:'POST',body:JSON.stringify(data)});
const store={get(key,fallback){try{return JSON.parse(localStorage.getItem('ab:'+key))??fallback;}catch{return fallback;}},set(key,value){try{localStorage.setItem('ab:'+key,JSON.stringify(value));}catch{}}};
function ago(seconds){if(!seconds)return'';const s=Math.max(0,Date.now()/1000-seconds);return s<90?'just now':s<5400?Math.round(s/60)+' min ago':s<129600?Math.round(s/3600)+' h ago':Math.round(s/86400)+' d ago';}
function posted(value){if(!value)return'';const t=Date.parse(value);if(!Number.isFinite(t))return'';const d=Math.round((Date.now()-t)/86400000);return d<=0?'Posted today':d===1?'Posted yesterday':'Posted '+d+' days ago';}
function chip(text,tone=''){return make('span','chip-state'+(tone?' '+tone:''),text);}
function stateChip(value){return chip(STATE_LABEL[value]||value.replaceAll('_',' '),TONE[value]||(value?.startsWith('needs')?'warn':''));}
function showTab(tab){state.tab=tab;for(const id of ['find','apply','history','settings']){$('#'+id+'-view').hidden=id!==tab;document.querySelector(`nav [data-tab="${id}"]`).classList.toggle('active',id===tab);}
 updateSelectionBar();if(tab==='apply')loadApplications();if(tab==='history')loadHistory();if(tab==='settings')loadSettings();window.scrollTo({top:0});}

// ---------------- Find ----------------------------------------------------------------------------
function renderResume(){const target=$('#resume-strip'),profile=state.boot.profile;target.replaceChildren();
 if(!profile){const text=make('div');text.append(make('strong','','Add your résumé'),make('p','fine','It fills application forms and suggests searches. DOCX or TXT, private to this PC.'));const label=make('label','outline small upload-label','Upload');const input=make('input');input.type='file';input.accept='.docx,.txt';input.hidden=true;input.addEventListener('change',uploadResume);label.append(input);target.append(text,label);return;}
 const text=make('div');text.append(make('strong','',profile.name),make('p','fine',(profile.headline||'')+' · '+profile.skills.length+' skills'));const edit=make('button','quiet small','Change');edit.type='button';edit.addEventListener('click',()=>showTab('settings'));target.append(text,edit);}
function renderSearchForm(){
 const boot=state.boot,saved=store.get('search',{});
 $('#country').replaceChildren(...boot.countries.map(([id,label])=>{const o=make('option','',label);o.value=id;return o;}));$('#country').value=saved.country||'turkey';
 $('#location').value=saved.location??'';['q0','q1','q2'].forEach((id,i)=>$('#'+id).value=saved.queries?.[i]||'');$('#easy-apply').checked=!!saved.easy_apply;$('#remote').checked=!!saved.remote;$('#hours').value=saved.hours_old||'';$('#limit').value=String(saved.limit||25);$('#li-signed').checked=!!saved.linkedin_signed_in;
 const list=$('#site-list');list.replaceChildren();const chosen=new Set(saved.sites||boot.sources.filter(s=>s.default).map(s=>s.id));
 for(const source of boot.sources){const row=make('label','site-option');const box=make('input');box.type='checkbox';box.value=source.id;box.checked=chosen.has(source.id);const text=make('span');text.append(make('strong','',source.label),make('small','',source.access));
  if(source.cooling_until&&source.cooling_until>Date.now()/1000)text.append(make('small','warn-text','Paused after throttling until '+new Date(source.cooling_until*1000).toLocaleTimeString([], {hour:'2-digit',minute:'2-digit'})+'. Saved results are still shown.'));
  row.append(box,text);list.append(row);}
 const chips=$('#suggestions');chips.replaceChildren();for(const item of boot.suggested||[]){const button=make('button','chip',item.query);button.type='button';button.addEventListener('click',()=>{const empty=['q0','q1','q2'].map(id=>$('#'+id)).find(input=>!input.value.trim());(empty||$('#q2')).value=item.query;});chips.append(button);}
}
function searchInput(){return{queries:['q0','q1','q2'].map(id=>$('#'+id).value.trim()).filter(Boolean),sites:[...document.querySelectorAll('#site-list input:checked')].map(box=>box.value),location:$('#location').value.trim(),country:$('#country').value,easy_apply:$('#easy-apply').checked,remote:$('#remote').checked,hours_old:$('#hours').value?Number($('#hours').value):null,limit:Number($('#limit').value),force:$('#force').checked,linkedin_signed_in:$('#li-signed').checked};}
async function startSearch(event){event.preventDefault();$('#search-error').textContent='';const input=searchInput();store.set('search',{...input,force:false});
 const button=$('#start-search');button.disabled=true;button.textContent='Starting…';
 try{await post('discovery/start',input);$('#force').checked=false;pollDiscovery();}catch(error){$('#search-error').textContent=error.message;button.disabled=false;button.textContent='Start searching';}}
async function pollDiscovery(){clearTimeout(state.discoveryTimer);
 try{const data=await api('discovery/status');renderDiscovery(data);if(data.task?.running){state.discoveryTimer=setTimeout(pollDiscovery,1200);}else{$('#start-search').disabled=false;$('#start-search').textContent='Start searching';}}
 catch(error){$('#search-error').textContent=error.message;$('#start-search').disabled=false;$('#start-search').textContent='Start searching';}}
function renderDiscovery({task,jobs}){
 const progress=$('#search-progress');progress.replaceChildren();state.jobs=jobs||[];
 if(!task){renderResults();return;}
 const elapsed=((task.finished_at||Date.now())-task.started_at)/1000;
 progress.append(make('p','fine progress-head',(task.running?'Searching… ':'Search finished · ')+elapsed.toFixed(1)+' s · '+jobs.length+' unique jobs'));
 for(const row of task.rows){const item=make('div','progress-row'),left=make('div');left.append(make('strong','',SITE_LABEL[row.site]||(row.site==='boards'?'Company boards':row.site)),make('span','fine',' “'+row.query+'”'));
  const labels={queued:['Waiting',''],searching:['Searching'+(row.count?' · '+row.count+' so far':'')+'…','busy'],cached:['Saved results · '+Math.round((row.cache_age_seconds||0)/60)+' min old','ready'],done:[row.count+' found','good'],no_results:['No results',''],failed:['Failed','bad'],throttled:['Throttled','bad'],cooling_down:['Paused (throttled)','warn']};
  const [label,tone]=labels[row.state]||[row.state,''];const right=make('div','progress-state');right.append(chip(label,tone));if(row.elapsed_seconds)right.append(make('small','fine',row.elapsed_seconds.toFixed(1)+' s'));
  item.append(left,right);const notes=[row.error,row.note,...(row.warnings||[]).slice(0,2)].filter(Boolean);if(row.state==='done'&&row.site==='linkedin'&&row.details!=null)notes.push(row.details+' job pages read for descriptions and apply type.');
  for(const note of notes)item.append(make('small','row-note',note));progress.append(item);}
 renderResults();
}
function routeGroup(job){if(job.route?.automatable)return job.route.family==='linkedin'?'easy':'forms';return'other';}
function renderResults(){
 const target=$('#results');target.replaceChildren();const jobs=state.jobs;$('#result-bar').hidden=!jobs.length;$('#filters').hidden=!jobs.length;
 const counts={all:jobs.length,auto:jobs.filter(j=>j.route?.automatable).length,easy:jobs.filter(j=>routeGroup(j)==='easy').length,forms:jobs.filter(j=>routeGroup(j)==='forms').length,other:jobs.filter(j=>routeGroup(j)==='other').length};
 const filters=$('#filters');filters.replaceChildren();for(const [id,label]of [['all','All'],['auto','Can apply from here'],['easy','LinkedIn Easy Apply'],['forms','Company forms'],['other','Other sites']]){const b=make('button','chip'+(state.filter===id?' active':''),label+' · '+counts[id]);b.type='button';b.addEventListener('click',()=>{state.filter=id;renderResults();});filters.append(b);}
 const visible=jobs.filter(job=>state.filter==='all'||(state.filter==='auto'?job.route?.automatable:routeGroup(job)===state.filter));
 $('#result-count').textContent=visible.length+' jobs';$('#result-note').textContent=counts.auto?' · '+counts.auto+' can be applied to from here':'';
 if(!jobs.length&&!document.querySelector('.progress-row'))target.append(make('p','empty','Enter a search and choose websites. Results appear here as each site answers.'));
 for(const job of visible.slice(0,300)){
  const row=make('article','job-row'+(state.selected.has(job.id)?' selected':''));const box=make('input');box.type='checkbox';box.checked=state.selected.has(job.id);box.setAttribute('aria-label','Select '+job.title);
  const blocked=job.application&&BLOCKING.has(job.application.state);box.disabled=blocked;box.addEventListener('change',()=>{box.checked?state.selected.add(job.id):state.selected.delete(job.id);row.classList.toggle('selected',box.checked);updateSelectionBar();});
  const body=make('div','job-body');const title=make('button','job-title',job.title);title.type='button';title.addEventListener('click',()=>openJob(job.id));
  body.append(title,make('p','job-meta',[job.company,job.location,posted(job.posted_at)].filter(Boolean).join(' · ')));
  const tags=make('div','tags');tags.append(make('span','tag site',SITE_LABEL[job.provider]||job.provider),make('span','tag route'+(job.route?.automatable?' auto':''),job.route?.label||'Unknown'));
  if(job.seniority&&job.seniority!=='unknown')tags.append(make('span','tag',job.seniority));if(job.description_state!=='present')tags.append(make('span','tag muted-tag','No description yet'));
  if(job.application)tags.append(stateChip(job.application.state));body.append(tags);row.append(box,body);target.append(row);}
 updateSelectionBar();
}
function updateSelectionBar(){const n=state.selected.size,auto=state.boot?.permissions&&state.boot.permissions.mode!=='review'&&!state.boot.permissions.paused;$('#selection-bar').hidden=!n||state.tab!=='find';$('#selection-text').textContent=n+' selected';$('#prepare-selected').textContent=n>50?'Choose up to 50':(auto?'Apply to ':'Prepare ')+n+' job'+(n===1?'':'s');$('#prepare-selected').disabled=n>50;}
async function prepare(ids){if(!ids.length)return;try{await post('applications/prepare',{ids});const p=state.boot.permissions;toast(p.mode!=='review'&&!p.paused?'Preparing; applications with every value known are then submitted automatically ('+MODE_LABEL[p.mode]+').':'Preparing on your PC. Nothing is submitted in this step.');state.selected.clear();renderResults();showTab('apply');pollBrowser();}catch(error){toast(error.message);}}
async function openJob(id){
 try{const {job,match,application,events}=await api('job?id='+encodeURIComponent(id));$('#detail-company').textContent=job.company;const content=$('#detail-content');content.replaceChildren(make('h2','detail-title',job.title),make('p','job-meta',[job.location,posted(job.posted_at),'seen '+ago(job.seen_at)].filter(Boolean).join(' · ')));
  const tags=make('div','tags');tags.append(make('span','tag site',SITE_LABEL[job.provider]||job.provider),make('span','tag route'+(job.route.automatable?' auto':''),job.route.label));if(application)tags.append(stateChip(application.state));content.append(tags);
  const links=make('div','detail-buttons');for(const [label,href]of [['Open listing ↗',job.listing_url],['Employer page ↗',job.destination_url]]){if(!href)continue;try{const u=new URL(href);if(!['http:','https:'].includes(u.protocol))continue;const a=make('a','outline small',label);a.href=u.href;a.target='_blank';a.rel='noopener noreferrer';links.append(a);}catch{}}
  if(!application||!BLOCKING.has(application.state)){const prep=make('button','primary small','Prepare this application');prep.addEventListener('click',()=>{$('#job-dialog').close();prepare([job.id]);});links.append(prep);}
  content.append(links);if(match?.overlap?.length)content.append(make('p','overlap','Résumé overlap: '+match.overlap.join(' · ')));for(const note of match?.notes||[])content.append(make('p','review-note',note));
  if(application?.detail?.evidence)content.append(make('p','evidence','Evidence: '+(application.detail.evidence.text||application.detail.evidence.kind)+' · '+(application.detail.evidence.url||'')));
  content.append(make('p','description',job.description||'Only the title and link are known so far. Open the listing for the full description.'));$('#job-dialog').showModal();}
 catch(error){toast(error.message);}
}

// ---------------- The browser on the PC + Apply ----------------------------------------------------
const TASK_LABEL={prepare:'Preparing applications',submit:'Submitting the reviewed batch',login:'Sign-in window open',session:'Checking sign-ins',open:'Form open for you',inspect:'Inspecting forms'};
function renderPill(browser){const pill=$('#pc-status');if(!browser||!browser.running){pill.textContent='PC · idle';pill.className='pc-pill';return;}
 const done=browser.jobs.filter(j=>!['queued','preparing','submit_in_progress','submitting'].includes(j.state)).length;pill.textContent='PC · '+(TASK_LABEL[browser.task]||browser.task)+(browser.jobs.length?' '+done+'/'+browser.jobs.length:'');pill.className='pc-pill busy';}
async function pollBrowser(){clearTimeout(state.browserTimer);
 try{const {browser,sessions}=await api('browser/status');state.boot.sessions=sessions;renderPill(browser);if(state.tab==='apply')renderBrowserPanel(browser);
  const key=JSON.stringify(browser?.jobs?.map(j=>j.state))+browser?.running;if(key!==state.browserKey){state.browserKey=key;if(state.tab==='apply')loadApplications(false);if(state.tab==='settings')renderAccounts();}
  if(browser?.running&&(browser.task==='live'||browser.stream?.state==='on')&&!live.open)openLive(browser.task==='live'?'Sign in':browser.stream?.reason==='verification'?'Human check needed':'Finish this application');
  if(!browser?.running&&live.open)closeLiveView();
  if(browser?.running)state.browserTimer=setTimeout(pollBrowser,1500);}
 catch(error){state.browserTimer=setTimeout(pollBrowser,5000);}}
function renderBrowserPanel(browser){const panel=$('#browser-panel');panel.replaceChildren();const pill=make('p','mode-pill');pill.id='mode-pill';panel.append(pill);renderModePill();
 if(!browser){panel.append(make('h2','','The browser on your PC'),make('p','fine','Preparing and submitting happen in a Chrome window on the PC running ApplyBurst. You can control it from your phone.'));return;}
 const head=make('div','panel-head');head.append(make('h2','',TASK_LABEL[browser.task]||browser.task),browser.running?chip('Running','busy'):chip('Finished',''));panel.append(head);
 if(browser.task==='login'&&browser.running)panel.append(make('p','review-note','A Chrome window is open on your PC at the '+(state.boot.login_sites[browser.site]||browser.site)+' sign-in page. Sign in there, then close that window.'));
 if(browser.needs_human&&browser.running)panel.append(make('p','review-note','A website is asking for human verification. Complete it in the browser on your PC; ApplyBurst waits and never solves it for you.'));
 if(browser.waiting?.length&&browser.running)panel.append(make('p','review-note','Some pages are left open on your PC for you to check or finish. If you submit one yourself, ApplyBurst records the confirmation it sees.'));
 if(browser.error)panel.append(make('p','error',browser.error));
 if(browser.jobs.length){const list=make('div','task-jobs');for(const job of browser.jobs){const row=make('div','task-job');row.append(make('span','',job.title+' · '+job.company),stateChip(job.state));list.append(row);}panel.append(list);}
 if(browser.running){const done=make('button','outline small',browser.task==='login'?'Stop waiting':'Done · close the browser');done.addEventListener('click',async()=>{await post('browser/done');pollBrowser();});panel.append(done);}
 else if(browser.finished_at)panel.append(make('p','fine','Finished '+ago(browser.finished_at/1000)+(browser.counts?' · '+Object.entries(browser.counts).map(([k,v])=>v+' '+(STATE_LABEL[k]||k).toLowerCase()).join(', '):'')));
}
async function loadApplications(scroll=true){try{const [data,status]=await Promise.all([api('applications'),api('browser/status')]);state.apps=data;renderPill(status.browser);renderBrowserPanel(status.browser);renderQuestions(data.questions);renderGroups(data.applications);
 const ready=data.applications.filter(a=>a.state==='ready_to_submit').length+data.questions.length;$('#apply-count').hidden=!ready;$('#apply-count').textContent=ready;if(status.browser?.running)pollBrowser();}catch(error){toast(error.message);}}
function answerInput(question){
 const options=question.options||[];let input;
 if(question.kind==='checkbox_group'&&options.length){input=make('div','multi');for(const option of options){const label=make('label','check'),box=make('input');box.type='checkbox';box.value=option;label.append(box,document.createTextNode(option));input.append(label);}input.read=()=>[...input.querySelectorAll('input:checked')].map(b=>b.value);return input;}
 if(options.length||question.kind==='checkbox'||question.kind==='yesno'){input=make('select');const list=options.length?options:question.kind==='checkbox'?['Yes','No']:['Yes','No'];input.append(make('option','','Choose…'));for(const option of list){const o=make('option','',option);o.value=option;input.append(o);}input.read=()=>input.value;return input;}
 input=make(question.kind==='textarea'?'textarea':'input');if(question.kind==='number')input.inputMode='decimal';input.maxLength=3000;input.read=()=>input.value.trim();return input;
}
function renderQuestions(questions){const panel=$('#questions-panel');panel.replaceChildren();if(!questions.length)return;
 const card=make('div','card questions');card.append(make('h2','',questions.length+' question'+(questions.length===1?'':'s')+' need your answer'),make('p','fine','Answered once, reused only where exactly the same question appears. Nothing is guessed: visa, salary, consent and eligibility always come from you.'));
 const inputs=[];for(const question of questions){const row=make('div','question');row.append(make('label','',question.label.replace(/[*✱]\s*$/,'')));if(question.problem)row.append(make('small','warn-text',question.problem));
  row.append(make('small','fine','Asked by: '+question.jobs.map(j=>j.company).filter((v,i,a)=>a.indexOf(v)===i).join(', ')));const input=answerInput(question);row.append(input);inputs.push({question,input});card.append(row);}
 const save=make('button','primary','Save answers and prepare again');save.addEventListener('click',async()=>{const answers=inputs.map(({question,input})=>({fingerprint:question.fingerprint,value:input.read(),label:question.label,kind:question.kind})).filter(a=>Array.isArray(a.value)?a.value.length:a.value);
  if(!answers.length){toast('Answer at least one question.');return;}save.disabled=true;try{await post('answers',{answers});const ids=[...new Set(questions.filter(q=>answers.some(a=>a.fingerprint===q.fingerprint)).flatMap(q=>q.jobs.map(j=>j.id)))];await prepare(ids);}catch(error){toast(error.message);}finally{save.disabled=false;}});
 card.append(save);panel.append(card);}
function renderGroups(apps){const target=$('#apply-groups');target.replaceChildren();
 const groups=[['ready','Ready to submit',a=>a.state==='ready_to_submit'],['busy','In progress',a=>['preparing','submit_in_progress','submitting'].includes(a.state)],['login','Needs sign-in',a=>a.state==='needs_login'],['human','Needs you in the browser',a=>a.state==='needs_human_verification'],
  ['check','Check these',a=>['unknown_after_submit','submit_rejected','plan_changed','failed_before_submit','adapter_needs_update','form_not_found','rate_limited','not_started'].includes(a.state)],['manual','Apply on the website yourself',a=>['unsupported_site','employer_site_redirect','closed_or_unavailable'].includes(a.state)],['done','Done',a=>['confirmed','already_applied','marked_submitted'].includes(a.state)]];
 if(!apps.length){target.append(make('p','empty','Select jobs in Find and choose Prepare. ApplyBurst fills each form on your PC and stops before the final button.'));return;}
 for(const [id,title,test]of groups){const items=apps.filter(test);if(!items.length)continue;const card=make('div','card group group-'+id),head=make('div','panel-head');head.append(make('h2','',title+' · '+items.length));card.append(head);
  if(id==='ready'){const review=make('button','primary','Review & submit '+items.length);review.addEventListener('click',()=>openReview([...card.querySelectorAll('input[data-id]:checked')].map(b=>b.dataset.id)));head.append(review);}
  if(id==='check'||id==='login'||id==='human'){const again=make('button','outline small','Prepare again');again.addEventListener('click',()=>prepare(items.filter(a=>!BLOCKING.has(a.state)).map(a=>a.job_id)));if(items.some(a=>!BLOCKING.has(a.state)))head.append(again);}
  if(id==='login'){const sites=[...new Set(items.map(a=>a.route?.login).filter(Boolean))];for(const site of sites){const b=make('button','outline small','Sign in to '+(state.boot.login_sites[site]||site));b.addEventListener('click',()=>signIn(site));head.append(b);}}
  if(id==='human'){const b=make('button','outline small','Open live view');b.addEventListener('click',()=>openLive('Human check'));head.append(b);}
  for(const app of items.slice(0,id==='done'?10:100)){const row=make('div','app-row');if(id==='ready'){const box=make('input');box.type='checkbox';box.checked=true;box.dataset.id=app.job_id;row.append(box);}
   const body=make('div');const title=make('button','job-title small-title',app.title);title.addEventListener('click',()=>openJob(app.job_id));body.append(title,make('p','job-meta',[app.company,app.route?.label].filter(Boolean).join(' · ')));
   const note=app.detail.note||app.detail.error;if(note&&id!=='ready')body.append(make('small','row-note',note));if(app.detail.destination)body.append(make('small','row-note','Destination: '+app.detail.destination));
   if(id==='ready')body.append(make('small','fine',(app.detail.disclosure||[]).length+' fields ready · prepared '+ago(app.updated_at)));
   if(id==='manual'||app.state==='needs_answers'||app.state==='adapter_needs_update'){const finish=make('button','quiet small','Finish in live view');finish.addEventListener('click',async()=>{try{await post('applications/open',{id:app.job_id});openLive('Finish this application');pollBrowser();}catch(error){toast(error.message);}});body.append(finish);}
   row.append(body,stateChip(app.state));card.append(row);}
  target.append(card);}
}
async function openReview(ids){if(!ids.length){toast('Select at least one prepared application.');return;}
 try{const review=await post('applications/review',{ids}),content=$('#review-content');content.replaceChildren(make('p','fine',review.disclosure));
  for(const job of review.jobs){const block=make('div','review-job');block.append(make('h3','',job.title+' · '+job.company),make('p','fine','Sent to '+job.destination+' · '+job.route.label));
   const table=make('dl','review-fields');for(const field of job.fields){table.append(make('dt','',field.label.replace(/[*✱]\s*$/,'')));const dd=make('dd','',Array.isArray(field.value)?field.value.join(', '):field.value===true?'Yes (checked)':field.value===false?'No':String(field.value));dd.append(make('span','source',SOURCE_LABEL[field.source]||field.source||''));table.append(dd);}block.append(table);content.append(block);}
  const confirm=make('label','check confirm');const box=make('input');box.type='checkbox';confirm.append(box,document.createTextNode(`I reviewed these ${review.jobs.length} applications. Submit them now.`));
  const submit=make('button','primary wide','Submit '+review.jobs.length+' application'+(review.jobs.length===1?'':'s'));submit.disabled=true;box.addEventListener('change',()=>submit.disabled=!box.checked);
  submit.addEventListener('click',async()=>{submit.disabled=true;try{await post('applications/submit',{ids:review.jobs.map(j=>j.id),token:review.token});$('#review-dialog').close();toast('Submitting on your PC. Each one is recorded before its final click.');loadApplications();pollBrowser();}catch(error){toast(error.message);submit.disabled=false;}});
  content.append(make('p','fine','This review is valid for 10 minutes and only for exactly these forms, values, résumé and answers.'),confirm,submit);$('#review-dialog').showModal();}
 catch(error){toast(error.message);}
}

// ---------------- Live browser (sign-in, human checks, finishing a form) ----------------------------
const live={seq:0,timer:null,width:0,height:0,open:false};
function liveSize(){return{width:Math.max(360,Math.min(1100,Math.round(window.innerWidth-24))),height:Math.max(560,Math.min(1100,Math.round(window.innerHeight-230)))};}
function openLive(title){const dialog=$('#live-dialog');$('#live-title').textContent=title||'Live browser';if(!dialog.open)dialog.showModal();live.open=true;pollLive();}
async function pollLive(){clearTimeout(live.timer);if(!live.open)return;
 try{const response=await fetch(BASE+'/api/browser/frame?after='+live.seq,{credentials:'same-origin'});
  if(response.status===200){const frame=await response.json();live.seq=frame.seq;live.width=frame.width;live.height=frame.height;$('#live-img').src='data:image/jpeg;base64,'+frame.data;$('#live-wait').hidden=true;
   try{$('#live-host').textContent=new URL(frame.url).hostname;}catch{$('#live-host').textContent='';}
   if(frame.stream?.reason==='verification')$('#live-note').textContent='The website wants a human check. Complete it here; ApplyBurst never solves it for you.';
   else if(frame.stream?.reason==='manual')$('#live-note').textContent='ApplyBurst filled what it knows. Finish the remaining fields and submit here; the confirmation will be recorded.';}
  else if(response.status===401){location.assign(BASE+'/');return;}}
 catch{}
 live.timer=setTimeout(pollLive,350);}
async function liveInput(data){try{await post('browser/input',data);setTimeout(pollLive,120);}catch(error){toast(error.message);}}
function closeLiveView(){live.open=false;clearTimeout(live.timer);if($('#live-dialog').open)$('#live-dialog').close();}
function wireLive(){
 $('#live-img').addEventListener('click',event=>{const img=event.currentTarget,rect=img.getBoundingClientRect();if(!live.width)return;
  liveInput({kind:'click',x:Math.round((event.clientX-rect.left)*live.width/rect.width),y:Math.round((event.clientY-rect.top)*live.height/rect.height)});});
 const send=()=>{const box=$('#live-text');if(!box.value)return;liveInput({kind:'type',text:box.value});box.value='';};
 $('#live-send').addEventListener('click',send);$('#live-text').addEventListener('keydown',event=>{if(event.key==='Enter'){event.preventDefault();send();}});
 for(const b of document.querySelectorAll('#live-dialog [data-key]'))b.addEventListener('click',()=>liveInput({kind:'key',key:b.dataset.key}));
 for(const b of document.querySelectorAll('#live-dialog [data-scroll]'))b.addEventListener('click',()=>liveInput({kind:'scroll',dy:Number(b.dataset.scroll)}));
 $('#live-back').addEventListener('click',()=>liveInput({kind:'back'}));$('#live-close').addEventListener('click',closeLiveView);
 $('#live-done').addEventListener('click',async()=>{closeLiveView();try{await post('browser/done');}catch{}pollBrowser();});
}

// ---------------- History -------------------------------------------------------------------------
async function loadHistory(){try{const {applications}=await api('applications'),target=$('#history');target.replaceChildren();
 if(!applications.length){target.append(make('p','empty','No applications yet.'));return;}
 for(const app of applications){const row=make('div','history-row'),body=make('div');const title=make('button','job-title small-title',app.title);title.addEventListener('click',()=>openJob(app.job_id));body.append(title,make('p','job-meta',[app.company,app.route?.label,ago(app.updated_at)].filter(Boolean).join(' · ')));
  if(app.detail.evidence)body.append(make('small','evidence','Employer confirmation: '+(app.detail.evidence.text||app.detail.evidence.kind)));const note=app.detail.note||app.detail.error;if(note)body.append(make('small','row-note',note));
  if(['unknown_after_submit','submit_rejected','plan_changed','failed_before_submit'].includes(app.state)){const actions=make('div','row-actions');for(const [outcome,label]of [['submitted','It was submitted'],['not_submitted','Not submitted · allow retry']]){const b=make('button','outline small',label);b.addEventListener('click',async()=>{try{await post('applications/resolve',{id:app.job_id,outcome});loadHistory();}catch(error){toast(error.message);}});actions.append(b);}body.append(actions);}
  row.append(body,stateChip(app.state));target.append(row);}}catch(error){toast(error.message);}}

// ---------------- Settings ------------------------------------------------------------------------
const MODE_LABEL={review:'Review every batch',auto_known:'Automatic when everything is known',auto_all:'Fully automatic'};
const PERM_SITES={linkedin:'LinkedIn Easy Apply',greenhouse:'Greenhouse',lever:'Lever',ashby:'Ashby',workable:'Workable'};
function renderPermissions(){const p=state.boot.permissions,form=$('#perm-form');for(const radio of form.querySelectorAll('input[name=mode]'))radio.checked=radio.value===p.mode;
 const sites=$('#perm-sites');sites.replaceChildren();for(const [id,label]of Object.entries(PERM_SITES)){const l=make('label','check'),box=make('input');box.type='checkbox';box.name='site';box.value=id;box.checked=!!p.sites[id];l.append(box,document.createTextNode(label));sites.append(l);}
 $('#perm-cap').value=p.daily_cap;$('#perm-paused').checked=!!p.paused;$('#perm-status').textContent=`${p.submitted_today||0} of ${p.daily_cap} automatic-or-reviewed submissions used today.`;}
async function savePermissions(event){event.preventDefault();const form=$('#perm-form'),mode=form.querySelector('input[name=mode]:checked')?.value||'review';
 if(mode!=='review'&&state.boot.permissions.mode==='review'&&!confirm('Automatic modes send applications without showing you each one first. Continue?'))return;
 const sites=Object.fromEntries([...form.querySelectorAll('input[name=site]')].map(box=>[box.value,box.checked]));
 try{state.boot.permissions=await post('settings/permissions',{mode,sites,daily_cap:Number($('#perm-cap').value),paused:$('#perm-paused').checked});renderPermissions();renderModePill();toast('Permissions saved: '+MODE_LABEL[state.boot.permissions.mode]+'.');}catch(error){toast(error.message);}}
function renderModePill(){const p=state.boot.permissions,pill=$('#mode-pill');if(!pill)return;pill.textContent='Sending mode: '+MODE_LABEL[p.mode]+(p.paused?' (paused)':'')+(p.mode!=='review'?' · '+(p.submitted_today||0)+'/'+p.daily_cap+' today':'');
 $('#prepare-selected').dataset.mode=p.mode;}
async function loadSettings(){renderAccounts();renderPermissions();try{const [{profile},{answers}]=await Promise.all([api('profile'),api('answers')]);const target=$('#profile-content');target.replaceChildren();
 if(profile){
  // These exact values are what application forms receive. Edit casing or details here.
  const form=make('form','facts-form'),fields=[['name','Full name'],['email','Email'],['phone','Phone (with country code)'],['location','City, country'],['linkedin','LinkedIn URL'],['github','GitHub URL']];
  for(const [key,label]of fields){const wrap=make('label','',label),input=make('input');input.name=key;input.value=profile[key]||'';input.autocomplete='off';wrap.append(input);form.append(wrap);}
  const save=make('button','outline small','Save details');save.type='submit';form.append(save);
  form.addEventListener('submit',async event=>{event.preventDefault();const data=Object.fromEntries(new FormData(form));try{const {profile}=await post('profile',data);state.boot.profile={...state.boot.profile,name:profile.name,location:profile.location};renderResume();toast('Saved. Forms prepared earlier must be prepared again.');}catch(error){toast(error.message);}});
  target.append(make('p','fine','Forms receive exactly these values. Imported from '+(profile.filename||'your résumé')+'.'),form,make('p','fine','Skills found: '+profile.skills.join(', ')));}
 else target.append(make('p','fine','No résumé yet.'));
 const list=$('#answer-list');list.replaceChildren();if(!answers.length)list.append(make('p','fine','None yet.'));
 for(const answer of answers){const row=make('div','answer-row'),text=make('div');text.append(make('strong','',(answer.label||'Question').replace(/[*✱]\s*$/,'')),make('span','fine',' → '+(Array.isArray(answer.value)?answer.value.join(', '):answer.value)));const del=make('button','quiet small','Remove');del.addEventListener('click',async()=>{await post('answers',{answers:[{fingerprint:answer.fingerprint,value:null}]});loadSettings();});row.append(text,del);list.append(row);}
 $('#pace-linkedin').value=state.boot.pace.linkedin_apply_seconds;$('#pace-concurrency').value=state.boot.pace.concurrency;$('#pace-confirm').value=state.boot.pace.confirm_timeout;}catch(error){toast(error.message);}}
function renderAccounts(){const target=$('#accounts');target.replaceChildren();for(const [site,label]of Object.entries(state.boot.login_sites)){const s=state.boot.sessions[site]||{},row=make('div','account-row'),text=make('div');
 text.append(make('strong','',label),make('small','fine',s.signed_in?'Signed in · session stored on the ApplyBurst PC'+(s.checked_at?' · checked '+ago(s.checked_at):''):s.checked_at?'Not signed in · checked '+ago(s.checked_at):'Not checked yet'));const buttons=make('div','bar-buttons'),b=make('button','outline small',s.signed_in?'Sign in again':'Sign in here');b.addEventListener('click',()=>signIn(site));const w=make('button','quiet small','Window on PC');w.addEventListener('click',()=>signIn(site,'window'));buttons.append(b,w);row.append(text,buttons);target.append(row);}
 const check=make('button','quiet small','Check sign-ins');check.addEventListener('click',async()=>{try{await post('browser/session');pollBrowser();toast('Checking sign-ins on your PC…');}catch(error){toast(error.message);}});target.append(check);}
async function signIn(site,mode='remote'){try{await post('browser/login',{site,mode,...liveSize()});if(mode==='window')toast('A Chrome window opened on your PC. Sign in there, then close it.');else{openLive('Sign in to '+(state.boot.login_sites[site]||site));toast('Sign in with your email and password. Google sign-in is blocked in remote browsers.');}pollBrowser();if(state.tab==='settings')setTimeout(renderAccounts,500);}catch(error){toast(error.message);}}
async function uploadResume(event){const file=event.target.files[0];if(!file)return;$('#resume-status').textContent='Reading your résumé…';
 try{const form=new FormData();form.set('resume',file);const result=await api('resume',{method:'POST',body:form});state.boot.profile=result.profile;state.boot.suggested=result.suggested;renderResume();renderSearchForm();$('#resume-status').textContent='Résumé ready: '+result.profile.skills.length+' skills found.';if(state.tab==='settings')loadSettings();}
 catch(error){$('#resume-status').textContent=error.message;}finally{event.target.value='';}}
async function loadLab(){try{const data=await api('status'),stats=data.stats;$('#system-summary').textContent=`${stats.opportunities.toLocaleString()} jobs indexed · ${stats.sources.length} sources · search index ${Math.round(data.index_ms)} ms · GPU calls 0`;
 const log=$('#rate-log');log.replaceChildren(make('h3','','Search attempts (throttling log)'));if(!data.rate_events.length)log.append(make('p','fine','No live searches yet.'));
 for(const e of data.rate_events.slice(0,25)){const row=make('div','source-row');row.append(make('span','',`${SITE_LABEL[e.site]||e.site} · ${new Date(e.at*1000).toLocaleTimeString()}`),make('span',e.outcome==='throttled'||e.outcome==='failed'?'bad-text':'',`${e.outcome} · ${e.count} · ${Number(e.elapsed_seconds||0).toFixed(1)} s`));if(e.note)row.append(make('small','row-note',e.note));log.append(row);}
 const sources=$('#sources');sources.replaceChildren(make('h3','','Company boards and feeds'));for(const source of stats.sources){const row=make('div','source-row');row.append(make('span','',source.board+' · '+source.provider),make('span',source.outcome==='failed'?'bad-text':'',(source.outcome||'').replaceAll('_',' ')+' · '+(source.jobs??source.retained_jobs??0)));sources.append(row);}}
 catch(error){$('#system-summary').textContent=error.message;}}
async function runSandbox(){const button=$('#run-sandbox');button.disabled=true;const out=$('#sandbox-result');out.textContent='Running…';
 try{const {results}=await api('search?q=engineer'),ids=results.slice(0,50).map(j=>j.id),runId=crypto.randomUUID(),resume='ApplyBurst synthetic resume\nNo real candidate data.\n'.repeat(512),answers={full_name:'Demo Candidate',email:'candidate@example.test',phone:'+10000000000',portfolio:'https://example.test/portfolio',city:'Istanbul',authorization:'Yes'},start=performance.now();let ok=0;
  const queue=[...ids];await Promise.all(Array.from({length:5},async()=>{while(queue.length){const id=queue.shift();const form=new FormData();form.set('job_id',id);form.set('run_id',runId);for(const [k,v]of Object.entries(answers))form.set(k,v);form.set('resume',new Blob([resume],{type:'text/plain'}),'synthetic-resume.txt');try{const r=await api('sandbox/apply',{method:'POST',body:form});if(r.state==='confirmed_sandbox')ok++;}catch{}}}));
  const stored=await api('sandbox/receipts?run_id='+runId);out.textContent=`${ok}/${ids.length} synthetic receipts in ${((performance.now()-start)/1000).toFixed(2)} s · ${stored.count} persisted. Sandbox only: no employer received anything.`;}
 catch(error){out.textContent=error.message;}finally{button.disabled=false;}}

// ---------------- Start ---------------------------------------------------------------------------
if(document.body.dataset.screen==='login'){
 $('#login-form').addEventListener('submit',async event=>{event.preventDefault();const button=event.target.querySelector('button');button.disabled=true;$('#login-error').textContent='';try{const data=new FormData(event.target);await post('login',{username:data.get('username'),password:data.get('password')});location.assign(BASE+'/');}catch(error){$('#login-error').textContent=error.message;button.disabled=false;}});
}else{
 try{state.boot=await api('bootstrap');state.csrf=state.boot.csrf;state.selected=new Set(store.get('selected',[]));
  renderResume();renderSearchForm();renderPill(state.boot.browser);
  for(const button of document.querySelectorAll('nav [data-tab]'))button.addEventListener('click',()=>showTab(button.dataset.tab));
  $('#search-form').addEventListener('submit',startSearch);$('#pc-status').addEventListener('click',()=>showTab('apply'));
  $('#select-auto').addEventListener('click',()=>{for(const job of state.jobs)if(job.route?.automatable&&!(job.application&&BLOCKING.has(job.application.state))&&state.selected.size<50)state.selected.add(job.id);renderResults();});
  $('#select-none').addEventListener('click',()=>{state.selected.clear();renderResults();});
  $('#prepare-selected').addEventListener('click',()=>prepare([...state.selected].slice(0,50)));
  $('#resume-upload').addEventListener('change',uploadResume);$('#logout').addEventListener('click',async()=>{await post('logout');location.assign(BASE+'/');});
  for(const dialog of document.querySelectorAll('dialog'))dialog.querySelector('[data-close]').addEventListener('click',()=>dialog.close());
  $('#pace-form').addEventListener('submit',async event=>{event.preventDefault();try{state.boot.pace=await post('settings/pace',{linkedin_apply_seconds:$('#pace-linkedin').value,concurrency:$('#pace-concurrency').value,confirm_timeout:$('#pace-confirm').value});toast('Pacing saved.');}catch(error){toast(error.message);}});
  $('#lab').addEventListener('toggle',event=>{if(event.target.open)loadLab();});$('#refresh').addEventListener('click',async()=>{try{await post('refresh');toast('Refreshing company boards in the background.');}catch(error){toast(error.message);}});$('#run-sandbox').addEventListener('click',runSandbox);
  wireLive();$('#perm-form').addEventListener('submit',savePermissions);window.addEventListener('beforeunload',()=>store.set('selected',[...state.selected]));
  if(state.boot.sessions?.linkedin?.signed_in&&store.get('search',{}).linkedin_signed_in===undefined)$('#li-signed').checked=true;
  await pollDiscovery();if(state.boot.browser?.running)pollBrowser();
 }catch(error){$('#search-error').textContent=error.message;}
}
