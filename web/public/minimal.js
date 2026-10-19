import {
 processCVInBrowser,
 getSavedGuestCV,
 getPendingCVFile,
 clearPendingCVFile,
 probeLocalCompanion,
 isExtensionInstalled,
 initExtensionBridge,
 sendExtensionCommand,
 subscribeExtensionEvents
} from './client-engine.mjs';
import {createReviewSettings} from './review-settings.mjs';
import {createCityPicker} from './city-picker.mjs';

const $=s=>document.querySelector(s),BASE='/applyburst/api/';
const el=(tag,cls='',text='')=>{const node=document.createElement(tag);if(cls)node.className=cls;if(text)node.textContent=text;return node;};
const S={
 authenticated:false,authMode:'login',registrationOpen:true,pendingAction:null,
 boot:null,publicConfig:null,guestCV:null,publicSearchId:null,publicLimit:100,canExpand:false,clientCards:[],
 csrf:'',profile:'find_only',feed:null,runId:null,cards:new Map(),savedIds:new Set(),
 timer:null,frameTimer:null,frameSeq:0,live:true,unseen:0,hover:false,initial:true,appsKey:'',tab:'completed',
 companion:null,extensionConnected:false,openReviews:new Set(),viewEpoch:0,resultsCleared:false,
 queryTags:null,previewEdited:false,requestedSearch:false,connectionLost:false,uploading:false,starting:false
};
let toastTimer;
const cityPicker=createCityPicker({onChange:values=>{$('#city-choice').value=values.join('; ');$('#location').value=$('#city-choice').value;remember({location:$('#city-choice').value});S.previewEdited=true;if(!running(S.feed?.run))setSearchStatus('ready');},onError:toast});
const reviewSettings=createReviewSettings({api,toast,onChange:enabled=>{if(S.boot)S.boot.local_drafts_enabled=enabled;for(const entry of S.cards.values())if(entry.card.stage==='needs_you'){entry.key='';paint(entry);}},onPreferences:async result=>{S.preferences=result.preferences;remember(result.search_policy||{});const policy=result.search_policy||{};if(policy.country&&$('#country'))$('#country').value=policy.country;if(policy.work_mode&&$('#work-mode'))$('#work-mode').value=policy.work_mode;if($('#city-choice'))$('#city-choice').value=policy.location||'';if($('#location'))$('#location').value=policy.location||'';if($('#remote'))$('#remote').checked=!!policy.remote;renderCountries();await Promise.all([renderSaved(),renderFacts()]);renderScreeningPreferences();syncExtensionProfile();}});

// A quick first pass per source and query; "Keep searching" deepens from the saved cursors.
const FIRST_DEPTH=25,DEPTHS=[25,50,100,200];
const nextDepth=current=>DEPTHS.find(d=>d>(current||FIRST_DEPTH))||null;
const PROFILES=[
 {id:'find_only',name:'Discover',line:'Stream matching jobs immediately from your CV.'},
 {id:'prepare_review',name:'Tap to submit',line:'Prepare applications automatically. One tap submits.'},
 {id:'controlled_auto',name:'Auto-submit',line:'Submit prepared applications automatically within your permissions.'}];

const STAGES={
 matching:{icon:'◌',text:'Found',busy:true},
 matched:{icon:'●',text:'Found'},
 related:{icon:'○',text:'Found'},
 manual:{icon:'↗',text:'Open to apply'},
 queued:{icon:'⋯',text:'Preparing',busy:true},
 opening:{icon:'↻',text:'Preparing',busy:true},
 filling:{icon:'✎',text:'Preparing',busy:true},
 ready:{icon:'●',text:'Ready'},
 sending:{icon:'➤',text:'Submitting',busy:true},
 confirmed:{icon:'✓',text:'Applied'},
 needs_you:{icon:'!',text:'Needs review'},
 uncertain:{icon:'?',text:'Needs review'},
 skipped:{icon:'–',text:'Skipped'}
};
const REASON={
 needs_login:'Sign-in needed',
 needs_human_verification:'Verification needed',
 unsupported_site:'Direct form not supported yet',
 employer_site_redirect:'Applies on employer website',
 closed_or_unavailable:'Job closed or unavailable',
 form_not_found:'Application form not found',
 adapter_needs_update:'Form layout not recognised',
 plan_changed:'Form changed after review',
 failed_before_submit:'Could not complete form · nothing sent',
 submit_rejected:'Submission rejected by website',
 rate_limited:'Rate limit · slowing down',
 deferred_slow:'Deferred to review queue',
 site_not_enabled:'Platform not enabled in settings',
 not_started:'Not started · nothing sent',
 inspected:'Checked · nothing sent'
 ,policy_mismatch:'Outside your work-location preferences'
};
const ACTIVE=new Set(['matching','queued','opening','filling','ready','sending']);
const HOME={confirmed:'completed',ready:'stream',needs_you:'needs',uncertain:'needs',related:'other',manual:'other',matched:'other',skipped:'skipped'};
const SITE_NAME={linkedin:'LinkedIn Easy Apply',indeed:'Indeed Apply',glassdoor:'Glassdoor Apply',greenhouse:'Greenhouse',lever:'Lever',ashby:'Ashby',workable:'Workable'};
let SETTINGS_KEY='applyburst:search';

async function api(path,data,options={}){
 let response;try{response=await fetch(BASE+path,data===undefined?{credentials:'same-origin',...options}:{method:'POST',credentials:'same-origin',headers:{'Content-Type':'application/json','X-CSRF-Token':S.csrf},body:JSON.stringify(data),...options});}
 catch(error){throw Object.assign(new Error('Connection to the local app was interrupted.'),{network:true,cause:error});}
 const result=await response.json().catch(()=>({error:'Unexpected response.'}));
 if(!response.ok){
  if(response.status===401){S.authenticated=false;renderNav();openAuthModal();throw new Error('Sign in to continue.');}
  throw Object.assign(new Error(result.error||'Request failed.'),{data:result,status:response.status});
 }
 return result;
}
function toast(text){$('#toast').textContent=text;$('#toast').hidden=false;clearTimeout(toastTimer);toastTimer=setTimeout(()=>$('#toast').hidden=true,4200);}
const fail=message=>{$('#error').textContent=message;};
function stored(){try{return JSON.parse(localStorage.getItem(SETTINGS_KEY)||'{}');}catch{return{};}}
function remember(values){try{localStorage.setItem(SETTINGS_KEY,JSON.stringify({...stored(),...values}));}catch{}}
const seconds=ms=>ms==null?'–':ms<1000?ms+' ms':(ms/1000).toFixed(1)+' s';
const link=(href,text)=>{const a=el('a','',text);a.href=href;a.target='_blank';a.rel='noopener noreferrer';return a;};

// ---- Navigation & Authentication -------------------------------------------------------------------
function renderNav(){
 $('#auth-button').textContent=S.authenticated?'Sign out':'Sign in';
 $('#nav-saved-count').textContent=String(S.savedIds.size);
 $('#n-saved').textContent=String(S.savedIds.size);
}
function setAuthTab(mode){
 S.authMode=mode;
 $('#tab-login').classList.toggle('active',mode==='login');
 $('#tab-register').classList.toggle('active',mode==='register');
 $('#auth-submit').textContent=mode==='register'?'Create account':'Sign in';
 $('#auth-password').autocomplete=mode==='register'?'new-password':'current-password';
 $('#auth-error').textContent='';
}
function openAuthModal(subtitle='Sign in or create an account to save jobs, connect accounts, and submit applications.',pendingAction=null){
 S.pendingAction=pendingAction;
 $('#auth-subtitle').textContent=subtitle;
 setAuthTab(S.registrationOpen&&!S.boot?.configured?'register':'login');
 if(!$('#auth-dialog').open)$('#auth-dialog').showModal();
 $('#auth-username').focus();
}
function requireAuth(subtitle,action){
 if(S.authenticated)return true;
 openAuthModal(subtitle,action);
 return false;
}
async function loadMemberSession(){
 const [boot,prefs]=await Promise.all([
  api('bootstrap',undefined,{signal:AbortSignal.timeout(10000)}),
  api('preferences',undefined,{signal:AbortSignal.timeout(10000)})
 ]);
 S.boot=boot;
 S.authenticated=true;
 S.csrf=S.boot.csrf;
 S.preferences=prefs.preferences;S.searchPolicy=prefs.search_policy;
 S.profile=S.boot.safety_profile||'find_only';
 S.savedIds=new Set(S.boot.saved_ids||[]);
 SETTINGS_KEY='applyburst:search:'+S.boot.workspace_id;
 S.queryTags=Array.isArray(stored().query_tags)?stored().query_tags:null;
 if(S.searchPolicy&&!stored().work_mode)remember(S.searchPolicy);
 renderNav();renderCV();renderProfiles();renderCountries();renderSettings();renderSavedTab();
 renderScreeningPreferences();renderReadinessStrip();
 syncExtensionProfile();
 if(S.boot.browser?.running&&['login','live'].includes(S.boot.browser.task))watchLogin();
}

// ---- Browser Extension Bridge (Chrome & Edge) ------------------------------------------------------
async function syncExtensionProfile(){
 S.extensionConnected=isExtensionInstalled();
 renderExtensionStatus();
 if(!S.extensionConnected||!S.authenticated)return;
 try{
  const syncData=await api('extension/sync');
  await sendExtensionCommand({type:'SYNC_PROFILE',payload:syncData});
 }catch{}
}
function renderExtensionStatus(){
 const label=$('#ext-status-label'),note=$('#ext-status-note');
 if(!label||!note)return;
 if(S.extensionConnected){
  label.textContent='Chrome & Edge extension · Connected';
  note.textContent='Active in this browser. Uses your existing sessions to search, fill, and submit applications.';
 }else{
  label.textContent='Chrome & Edge extension';
  note.textContent='Optional: download and load in chrome://extensions or edge://extensions to fill and submit directly in your browser.';
 }
}
function handleExtensionEvent(event,payload){
 S.extensionConnected=true;
 renderExtensionStatus();
 if(event==='JOB_BATCH'&&Array.isArray(payload?.jobs)){
  const existingIds=new Set(S.clientCards.map(c=>c.id));
  for(const job of payload.jobs){
   if(!existingIds.has(job.id)){existingIds.add(job.id);S.clientCards.push(job);}
  }
  renderImmediateClientStream();
 }else if(event==='APPLICATION_EVENT'&&payload?.job_id){
  if(S.authenticated){
   api('extension/event',payload).then(()=>poll()).catch(()=>{});
  }
  const entry=S.cards.get(payload.job_id);
  if(entry){
   const stageMap={opening:'opening',filling:'filling',ready_to_submit:'ready',submitting:'sending',confirmed:'confirmed',needs_human:'needs_you',needs_login:'needs_you',needs_answers:'needs_you'};
   const nextStage=stageMap[payload.state]||entry.card.stage;
   upsert({
    ...entry.card,
    stage:nextStage,
    app_state:payload.state,
    note:payload.note||entry.card.note,
    evidence:payload.evidence||entry.card.evidence,
    questions:payload.questions||entry.card.questions,
    disclosure:payload.filled_fields?{fields:payload.filled_fields}:entry.card.disclosure,
    via_extension:true
   });
   settle();countLists();
  }
 }
}

// ---- Setup: CV, profile, country -------------------------------------------------------------------
function activeProfile(){
 return S.authenticated?S.boot?.profile:S.guestCV;
}
function activeQueries(){
 if(Array.isArray(S.queryTags))return S.queryTags;
 if(S.authenticated&&S.boot?.plan?.queries?.length)return S.boot.plan.queries;
 if(S.guestCV?.queries?.length)return S.guestCV.queries;
 return[];
}
function setQueryTags(queries){
 S.queryTags=[...new Map(queries.map(q=>String(q).trim()).filter(Boolean).map(q=>[q.toLowerCase(),q])).values()].slice(0,6);
 remember({query_tags:S.queryTags});S.previewEdited=true;renderCV();
 if(!running(S.feed?.run))setSearchStatus('ready');
 else toast('Roles updated for your next search. The current search keeps its original roles.');
}
function addQueryTag(){
 const query=$('#query').value.trim();if(!query)return;
 if(activeQueries().length>=6&&!activeQueries().some(q=>q.toLowerCase()===query.toLowerCase())){toast('Use up to six roles per search. Remove one to add another.');return;}
 setQueryTags([...activeQueries(),query]);$('#query').value='';renderCV();
}
function candidateName(){return String(activeProfile()?.name||'').trim().slice(0,80);}
function setSearchStatus(state,detail=''){
 const name=candidateName(),messages={
  reading:'Reading your CV · no search has started.',
  ready:name?`${name}, your search is ready. Review the roles, then press Start.`:'Ready · add a role or CV, then press Start.',
  starting:name?`Starting your search, ${name}…`:'Starting your search…',
  searching:name?`Finding jobs for ${name}…`:'Searching for jobs…',
  matching:name?`Checking matches for ${name}…`:'Checking job matches…',
  applying:name?`Preparing applications for ${name}…`:'Preparing applications…',
  complete:name?`${name}, your search is complete.`:'Search complete.',
  stopped:'Stopped · press Start for a new search.',
  stopping:'Stopping · waiting for active source requests to finish.',
  interrupted:'The previous search was interrupted. Press Start to search again.',
  paused:'Applications paused · job search continues.',
  reconnecting:'Connection interrupted · checking the search status…',
  error:'Search needs attention. Review the error below.'
 };
 $('#search-status').dataset.state=state;$('#search-status-text').textContent=detail||messages[state]||state;
}
function connectionIssue(){S.connectionLost=true;$('#connection-status').hidden=false;setSearchStatus('reconnecting');}
function connectionRecovered(){S.connectionLost=false;$('#connection-status').hidden=true;}
function renderCV(){
 const profile=activeProfile(),queries=activeQueries();
 $('#resume-name').textContent=profile?profile.name||profile.filename||'CV ready':'Drop your CV here';
 $('#resume-note').textContent=profile?(profile.filename?profile.filename+' · ready':'CV ready'):'or choose a file · PDF, DOCX, TXT';
 $('#resume-action').textContent=profile?'Replace':'Choose file';
 $('#resume-button').classList.toggle('has-cv',!!profile);$('#resume-button').querySelector('.upload-icon').textContent=profile?'✓':'↑';
 $('#plan-row').hidden=!queries.length;
 $('#plan-chips').replaceChildren(...queries.map(role=>{const chip=el('span','chip'),remove=el('button','chip-remove','×');remove.type='button';remove.setAttribute('aria-label','Remove '+role);remove.title='Remove '+role;remove.addEventListener('click',()=>setQueryTags(activeQueries().filter(q=>q!==role)));chip.append(document.createTextNode(role),remove);return chip;}));
 if(!S.uploading&&!S.starting&&!S.connectionLost&&!running(S.feed?.run))setSearchStatus('ready');
}
function renderProfiles(){
 const box=$('#profiles');box.querySelectorAll('label').forEach(node=>node.remove());
 const effectiveId=S.profile==='full_auto'?'controlled_auto':S.profile;
 for(const item of PROFILES){
  const selected=effectiveId===item.id;
  const label=el('label','profile'+(selected?' selected':'')),input=el('input');
  input.type='radio';input.name='profile';input.value=item.id;input.checked=selected;
  input.addEventListener('change',()=>chooseProfile(item.id));
  label.append(input,el('strong','',item.name),el('small','',item.line));box.append(label);
 }
 // The full-auto option only matters once automatic submission is chosen.
 const fullAuto=$('#full-auto-toggle')?.closest('label');if(fullAuto)fullAuto.hidden=!['controlled_auto','full_auto'].includes(S.profile);
 const perm=S.boot?.permissions||{daily_cap:25,sites:{linkedin:true,greenhouse:true,lever:true,ashby:true,workable:true}};
 const sites=Object.entries(perm.sites).filter(([,on])=>on).map(([site])=>SITE_NAME[site]||site).join(', ');
 $('#profile-note').textContent=S.profile==='find_only'
  ?'Streams matching jobs immediately. Tap Prepare or Apply on any card when ready.'
  :S.profile==='prepare_review'
  ?'Prepares applications automatically. Ready cards show Submit and optional Review.'
  :`Auto-submits up to ${stored().application_limit||10} prepared applications per run (${perm.daily_cap}/day) on ${sites}. Exceptions pause under Needs review.`;
}
async function chooseProfile(id,consent=false){
 const targetId=(id==='controlled_auto'&&$('#full-auto-toggle')?.checked)?'full_auto':id;
 const labelName=PROFILES.find(p=>p.id===id)?.name||'this mode';
 if(targetId!=='find_only'&&!S.authenticated){
  renderProfiles();
  openAuthModal('Create an account or sign in to enable '+labelName.toLowerCase()+'.',()=>chooseProfile(id,consent));
  return false;
 }
 if(!S.authenticated){S.profile='find_only';renderProfiles();return true;}
 const previous=S.profile;
 try{
  const result=await api('settings/profile',{profile:targetId,consent});
  if(result.consent_required){openConsent(targetId,result.scope,previous);return false;}
  S.profile=result.profile;S.boot.consented=result.consented;S.boot.permissions=result.permissions;renderProfiles();renderConsents();return true;
 }catch(error){
  S.profile=previous;renderProfiles();toast(error.message);return false;
 }
}
function openConsent(id,scope,previous){
 const isFull=id==='full_auto';
 const modeTitle=isFull?'Auto-submit (including profile prefill)':'Auto-submit';
 const body=$('#consent-body');$('#consent-title').textContent='Enable '+modeTitle;
 const list=el('ul','consent-list');
 for(const line of [
  'TapSubmit searches with your CV and submits prepared applications within your permissions.',
  'Enabled platforms: '+scope.sites.map(site=>SITE_NAME[site]||site).join(', ')+' (up to '+scope.daily_cap+' per day).',
  isFull?'Uses your CV, your details, your saved answers, and values prefilled by your connected profile.':'Uses only your CV, your details, and your saved answers.',
  'Unknown required questions, CAPTCHAs, or expired sessions pause under Needs review while other applications continue.',
  'Applications are marked Applied only after verified employer confirmation.'])list.append(el('li','',line));
 body.replaceChildren(list);let allowed=false;
 $('#consent-allow').onclick=async()=>{allowed=true;$('#consent').close();if(await chooseProfile(id,true))toast(modeTitle+' enabled.');};
 $('#consent').onclose=()=>{if(!allowed){S.profile=previous;renderProfiles();}};
 $('#consent').showModal();
}
function renderCountries(){
 const countries=S.boot?.countries||S.publicConfig?.countries||[['worldwide','Worldwide'],['turkey','Türkiye'],['usa','United States'],['uk','United Kingdom'],['germany','Germany']];
 const local=['local_only','local_and_remote'].includes($('#work-mode').value),select=$('#country'),saved=stored().country,location=String(activeProfile()?.location||S.guestCV?.features?.country||'').toLowerCase();
 select.replaceChildren(...(local?[new Option('Choose country','')]:[]),...countries.filter(([id])=>!local||id!=='worldwide').map(([id,name])=>{const o=el('option','',id==='worldwide'?'Worldwide · global remote + my country':name);o.value=id;return o;}));
 const guess=countries.find(([id,name])=>location&&(location.includes(name.toLowerCase())||location.includes(id)||id==='turkey'&&/türkiye|turkey|istanbul|ankara|izmir/.test(location)||id==='usa'&&/united states|\busa?\b/.test(location)||id==='uk'&&/united kingdom|london|\buk\b/.test(location)))?.[0];
 select.value=local?(saved&&saved!=='worldwide'?saved:stored().last_local_country||guess||''):(saved||guess||'worldwide');
 updateLocationControls();
}
function updateLocationControls(){
 const mode=$('#work-mode').value,local=['local_only','local_and_remote'].includes(mode);
 $('#country-wrap').hidden=!mode||mode==='anywhere';$('#country-label').textContent=local?'Country':'Eligible in';
 if(mode==='anywhere')$('#country').value='worldwide';
 cityPicker.update({country:$('#country').value,visible:local,values:$('#city-choice').value.split(/[;|]/).map(v=>v.trim()).filter(Boolean)});
 if($('#remote'))$('#remote').checked=mode==='remote_only';
}

// ---- Settings & Member Controls --------------------------------------------------------------------
function searchInput(limitOverride=null){
 const s=stored();
 const defaultSites=S.boot?.sources?S.boot.sources.filter(x=>x.default).map(x=>x.id):(S.publicConfig?.default_sources||['indeed','himalayas','remoteok','jobicy','remotive','arbeitnow','boards']);
 const queries=activeQueries();
 return{
  queries,
  country:$('#work-mode').value==='anywhere'?'worldwide':$('#country').value||'worldwide',
  location:['local_only','local_and_remote'].includes($('#work-mode').value)?$('#city-choice').value.trim():'',work_mode:$('#work-mode').value,
  sites:s.sites||defaultSites,
  // Unset = the server uses languages found in the CV; an explicit empty list disables the language filter.
  ...(Array.isArray(s.languages)?{languages:s.languages}:{}),
  hours_old:Number(s.hours_old??168),
  limit:Number(limitOverride||s.limit||100),
  force:!!s.force,
  remote:$('#work-mode').value==='remote_only',
  // A connected LinkedIn session searches like a signed-in person (no guest throttling) unless switched off.
  linkedin_signed_in:s.signed===undefined?!!S.boot?.sessions?.linkedin?.signed_in:!!s.signed,
  easy_apply:!!s.easy,
  application_limit:Math.min(50,Math.max(1,Number(s.application_limit)||10))
 };
}
function renderSettings(){
 if(!S.boot)return;
 const s=stored(),b=S.boot,chosen=new Set(s.sites||b.sources.filter(x=>x.default).map(x=>x.id));
 $('#work-mode').value=s.work_mode||(s.remote?'remote_only':s.location?'local_and_remote':'');$('#city-choice').value=s.location||'';
 renderCountries();
 $('#account-username').textContent=b.username;$('#password-error').textContent='';$('#password-form').reset();
 renderExtensionStatus();
 $('#sites').querySelectorAll('label').forEach(node=>node.remove());
 for(const source of b.sources){const label=el('label','check'),box=el('input');box.type='checkbox';box.value=source.id;box.checked=chosen.has(source.id);label.append(box,document.createTextNode(source.label));$('#sites').append(label);}
 $('#job-languages').querySelectorAll('label').forEach(node=>node.remove());
 const languages=new Set(Array.isArray(s.languages)?s.languages:activeProfile()?.languages||[]);
 for(const [id,name]of b.languages||[]){const label=el('label','check'),box=el('input');box.type='checkbox';box.value=id;box.checked=languages.has(id);label.append(box,document.createTextNode(name));$('#job-languages').append(label);}
 if($('#hours'))$('#hours').value=String(s.hours_old??168);if($('#limit'))$('#limit').value=String(s.limit||100);if($('#location'))$('#location').value=s.location||'';if($('#remote'))$('#remote').checked=!!s.remote;if($('#fresh'))$('#fresh').checked=!!s.force;if($('#signed'))$('#signed').checked=s.signed===undefined?!!S.boot?.sessions?.linkedin?.signed_in:!!s.signed;if($('#easy'))$('#easy').checked=!!s.easy;
 $('#targets').querySelectorAll('label').forEach(node=>node.remove());
 for(const [site,name]of Object.entries(SITE_NAME)){const label=el('label','check'),box=el('input');box.type='checkbox';box.value=site;box.checked=!!b.permissions.sites[site];label.append(box,document.createTextNode(name));$('#targets').append(label);}
 $('#run-cap').value=s.application_limit||10;$('#daily-cap').value=b.permissions.daily_cap;$('#concurrency').value=String(b.pace.concurrency||2);$('#linkedin-pace').value=b.pace.linkedin_apply_seconds||4;
 if($('#full-auto-toggle'))$('#full-auto-toggle').checked=S.profile==='full_auto';
 if($('#windows'))$('#windows').checked=!!b.show_browser_windows;
 renderConsents();renderAccounts();
}
function renderConsents(){
 if(!S.boot)return;
 const box=$('#consents');box.replaceChildren();
 for(const id of S.boot.consented||[]){
  const name=id==='full_auto'?'Auto-submit (full)':id==='controlled_auto'?'Auto-submit':id;
  const row=el('div','consent-row'),button=el('button','link','Disable');button.type='button';
  button.addEventListener('click',async()=>{try{const result=await api('settings/consent',{profile:id});S.boot.consented=result.consented;S.profile=result.profile;renderProfiles();renderConsents();toast('Updated.');}catch(error){toast(error.message);}});
  row.append(el('small','',name+' enabled.'),button);box.append(row);
 }
}
function saveSearchSettings(){
 remember({sites:[...document.querySelectorAll('#sites input:checked')].map(box=>box.value),...(S.boot?.languages?{languages:[...document.querySelectorAll('#job-languages input:checked')].map(box=>box.value)}:{}),hours_old:Number($('#hours')?.value||168),limit:Number($('#limit')?.value||100),location:$('#location')?.value.trim()||'',remote:!!$('#remote')?.checked,force:!!$('#fresh')?.checked,signed:!!$('#signed')?.checked,easy:!!$('#easy')?.checked});
 remember({work_mode:$('#work-mode').value});
}
async function saveApplySettings(){
 try{
  remember({application_limit:Math.min(50,Math.max(1,Number($('#run-cap').value)||10))});
  const sites=Object.fromEntries([...document.querySelectorAll('#targets input')].map(box=>[box.value,box.checked]));
  S.boot.permissions=await api('settings/permissions',{sites,daily_cap:Number($('#daily-cap').value)||25});
  S.boot.pace={...S.boot.pace,...await api('settings/pace',{concurrency:Number($('#concurrency').value),linkedin_apply_seconds:Number($('#linkedin-pace').value),confirm_timeout:S.boot.pace.confirm_timeout})};
  await api('settings/windows',{show:!!$('#windows')?.checked});S.boot.show_browser_windows=!!$('#windows')?.checked;
  if(['controlled_auto','full_auto'].includes(S.profile)){
   const desired=$('#full-auto-toggle')?.checked?'full_auto':'controlled_auto';
   if(desired!==S.profile)await chooseProfile(desired);
  }
  renderProfiles();syncExtensionProfile();toast('Settings saved.');
 }catch(error){toast(error.message);}
}
async function renderFacts(){
 const {profile}=await api('profile'),box=$('#facts');box.replaceChildren();
 for(const [key,label,type]of [['name','Full name','text'],['email','Email','email'],['phone','Phone with country code','tel'],['location','City, country','text'],['linkedin','LinkedIn URL','url'],['github','GitHub / website URL','url']]){
  const field=el('label','',label),input=el('input');input.type=type;input.name=key;input.value=profile?.[key]||'';input.disabled=!profile;field.append(input);box.append(field);}
 $('#save-facts').disabled=!profile;
}
async function saveFacts(){
 try{const values=Object.fromEntries([...document.querySelectorAll('#facts input')].map(input=>[input.name,input.value.trim()]));await api('profile',values);syncExtensionProfile();toast('Details saved.');}catch(error){toast(error.message);}
}
function renderReadinessStrip(){
 const badge=$('#linkedin-badge'),status=$('#linkedin-status-text'),btn=$('#connect-linkedin-btn');
 if(!badge||!status||!btn)return;
 const isConnected=!!S.boot?.sessions?.linkedin?.signed_in;
 if(isConnected){
  badge.className='platform-badge badge-ready';
  badge.textContent='Connected ✓';
  status.className='platform-status text-ready';
  status.textContent='Active session verified';
  btn.textContent='Reconnect';
  btn.disabled=!!S.boot?.browser?.running;
 }else if(S.extensionConnected){
  badge.className='platform-badge badge-ready';
  badge.textContent='Extension Active';
  status.className='platform-status text-ready';
  status.textContent='Uses browser session';
  btn.textContent='Open LinkedIn';
  btn.disabled=false;
 }else{
  badge.className='platform-badge badge-auth';
  badge.textContent='Requires Login';
  status.className='platform-status';
  status.textContent='Not connected';
  btn.textContent='Connect LinkedIn';
  btn.disabled=!!S.boot?.browser?.running;
 }
}

async function handleConnectLinkedIn(){
 return handleConnectSite('linkedin');
}
async function handleConnectIndeed(){
 return handleConnectSite('indeed');
}
async function handleConnectSite(site){
 const name={linkedin:'LinkedIn',indeed:'Indeed',glassdoor:'Glassdoor'}[site]||site;
 if(!S.authenticated){
  openAuthModal('Sign in or create an account to connect your '+name+' account.',()=>handleConnectSite(site));
  return;
 }
 const btn=$('#connect-'+site+'-btn');if(btn)btn.disabled=true;
 try{
  S.boot.browser=await api('browser/login',{site,mode:'window'});
  renderReadinessStrip();
  renderAccounts();
  toast('Sign in on '+site+'.com in the opened browser, then close that window.');
  watchLogin();
 }catch(err){if(btn)btn.disabled=false;toast(err.message);}
}

function renderScreeningPreferences(){
 const s=stored(),prefs=S.preferences||{},code={turkey:'TR',usa:'US',uk:'GB',germany:'DE',canada:'CA'}[$('#country').value];
 const polarity=id=>prefs[id]?.confirmed?({yes:'yes',no:'no'}[String(prefs[id].value).toLowerCase()]||''):'';
 $('#pref-auth').value=code?polarity('work_authorization:'+code):'';
 $('#pref-visa').value=code?polarity('visa_sponsorship:'+code+':now_or_future'):'';
 $('#pref-notice').value=Object.entries({immediate:'Immediately available','2weeks':'2 weeks','1month':'1 month','3months':'3 months'}).find(([,v])=>v===prefs.notice_period?.value)?.[0]||'';
 if($('#pref-level')&&s.pref_level)$('#pref-level').value=s.pref_level;
}

async function saveScreeningPreferences(event){
 const id=event?.target?.id, country=$('#country').value;
 const code={turkey:'TR',usa:'US',uk:'GB',germany:'DE',canada:'CA'}[country];
 const pref_auth=$('#pref-auth')?.value||'',pref_visa=$('#pref-visa')?.value||'',pref_notice=$('#pref-notice')?.value||'',pref_level=$('#pref-level')?.value||'auto';
 remember({pref_auth,pref_visa,pref_notice,pref_level});
 if(!S.authenticated||id==='pref-level')return;
 try{
  const preferences=[];
  if(id==='pref-notice')preferences.push({id:'notice_period',value:{immediate:'Immediately available','2weeks':'2 weeks','1month':'1 month','3months':'3 months'}[pref_notice]||null,confirmed:true});
  if(id==='pref-auth'||id==='pref-visa'){
   if(!code)throw new Error('Choose a specific supported search country first. Work rights are country-specific.');
   const value=id==='pref-auth'?pref_auth:pref_visa;
   preferences.push({id:id==='pref-auth'?'work_authorization:'+code:'visa_sponsorship:'+code+':now_or_future',value:value?(value==='yes'?'Yes':'No'):null,confirmed:true});
  }
  if(preferences.length){S.preferences=(await api('preferences',{preferences})).preferences;syncExtensionProfile();toast('Saved for '+(id==='pref-notice'?'future forms':$('#country').selectedOptions[0].textContent)+'.');}
 }catch(error){renderScreeningPreferences();toast(error.message);}
}

// Shared job pool (optional): sharing found jobs and searching the downloaded pool are both off by default.
let poolTimer=null;
async function renderPool(data=null){
 data=data||await api('pool');const local=data.local,remote=data.remote,dl=data.download||{};
 if($('#pool-share'))$('#pool-share').checked=!!data.share;if($('#pool-use')){$('#pool-use').checked=!!data.use_pool;$('#pool-use').disabled=!local;}
 const busy=['downloading','indexing'].includes(dl.state);$('#pool-download').disabled=busy;$('#pool-download').textContent=local?'Update download':'Download & use for my searches';
 $('#pool-status-label').textContent='Shared pool'+(remote?.records?' · '+remote.records.toLocaleString('en-US')+' active jobs on tapsubmit.com':'');
 $('#pool-status-note').textContent=busy?(dl.state==='downloading'?'Downloading'+(dl.bytes?' '+Math.round(dl.bytes/1e6)+' MB':'')+'…':'Building the local search index…'):dl.state==='failed'?dl.error:local?local.records.toLocaleString('en-US')+' jobs downloaded'+(local.generated_at?' · '+new Date(local.generated_at).toLocaleDateString():''):remote?'Not downloaded. We collect these jobs and search them for you.':'tapsubmit.com is not reachable right now.';
 clearTimeout(poolTimer);if(busy)poolTimer=setTimeout(()=>renderPool().catch(()=>{}),2000);
}
function renderAccounts(){
 renderReadinessStrip();
 updateLocalLinkedInNodeState();
 if(!S.boot)return;
 for(const [site,name]of [['indeed','Indeed'],['glassdoor','Glassdoor']]){
  const connected=!!S.boot.sessions?.[site]?.signed_in,button=$('#connect-'+site+'-btn'),badge=$('#'+site+'-badge');
  if(button){button.disabled=!!S.boot.browser?.running;button.textContent=connected?'Reconnect':'Connect '+name;}
  if(badge){badge.textContent=connected?'Connected ✓':'Connect to apply';badge.className='platform-badge '+(connected?'badge-ready':'badge-auth');}
 }
 const b=S.boot,box=$('#accounts'),browser=b.browser,signingIn=!!browser?.running&&['login','live'].includes(browser.task);box.replaceChildren();
 for(const [id,name]of Object.entries(b.login_sites||{linkedin:'LinkedIn',indeed:'Indeed',glassdoor:'Glassdoor'})){
  const row=el('div','account-row'),text=el('div'),connected=b.sessions?.[id]?.signed_in,pending=signingIn&&browser.site===id;
  text.append(el('strong','',name),el('small','',pending?(browser.task==='login'?'Finish signing in in the browser, then close that window.':'Sign-in in progress…'):connected?'Connected':S.extensionConnected?'Uses browser session or connect here':'Not connected'));
  const actions=el('div','card-actions');
  const connectBtn=el('button','link',pending?'Active':connected?'Reconnect':'Connect');connectBtn.type='button';connectBtn.disabled=!!browser?.running;
  connectBtn.addEventListener('click',async()=>{
   connectBtn.disabled=true;
   try{
    b.browser=await api('browser/login',{site:id,mode:'window'});
    renderAccounts();
    toast('Sign in on '+id+'.com in the opened browser, then close that window.');
    watchLogin();
   }catch(error){connectBtn.disabled=false;toast(error.message);}
  });
  actions.append(connectBtn);
  // Let an older embedded sign-in finish cleanly after upgrading, preserving its cookies.
  if(pending&&browser.task==='live'){
   const done=el('button','link','Close sign-in');done.type='button';
   done.addEventListener('click',async()=>{done.disabled=true;try{await api('browser/done',{});if($('#live-browser').open)$('#live-browser').close();watchLogin();}catch(error){done.disabled=false;toast(error.message);}});
   actions.append(done);
  }
  row.append(text,actions);box.append(row);
 }
}
function watchLogin(){setTimeout(async()=>{try{const status=await api('browser/status');S.boot.browser=status.browser;S.boot.sessions=status.sessions;renderAccounts();if(status.browser?.running)watchLogin();else if($('#live-browser').open)$('#live-browser').close();}catch{}},1400);}

function openLiveBrowser(title='Interactive view'){
 $('#live-browser-title').textContent=title;
 S.frameSeq=0;
 if(!$('#live-browser').open)$('#live-browser').showModal();
 pollLiveFrame();
}
async function pollLiveFrame(){
 clearTimeout(S.frameTimer);
 if(!$('#live-browser').open)return;
 try{
  const res=await fetch(`${BASE}browser/frame?after=${S.frameSeq}`,{credentials:'same-origin'});
  if(res.status===200){
   const frame=await res.json();
   S.frameSeq=frame.seq||S.frameSeq;
   const img=$('#live-frame');
   img.src='data:image/jpeg;base64,'+frame.data;
   img.dataset.w=frame.width||1100;
   img.dataset.h=frame.height||820;
  }
 }catch{}
 S.frameTimer=setTimeout(pollLiveFrame,350);
}

function answerControl(q){
 const input=q.options?.length||q.kind==='checkbox'?el('select'):['textarea','text'].includes(q.kind)&&!q.fact?el('textarea'):el('input');
 if(input.tagName==='TEXTAREA'){input.rows=3;input.maxLength=4000;}
 if(input.tagName==='SELECT'){
  if(q.kind==='checkbox_group')input.multiple=true;else{const placeholder=el('option','','Choose…');placeholder.value='';input.append(placeholder);}
  for(const value of q.options?.length?q.options:['Yes','No']){const option=el('option','',String(value));option.value=String(value);input.append(option);}
 }else if(['number','date','url'].includes(q.preference?.kind))input.type=q.preference.kind;
 return{input,value:()=>input.multiple?[...input.selectedOptions].map(o=>o.value):input.value};
}
async function renderSaved(){
 const data=await api('preferences'),box=$('#saved-facts');box.replaceChildren();
 for(const spec of data.schema){
  const field=el('label','',spec.label+(spec.unit?' · '+spec.unit:'')),input=el('input');input.type=['number','date','url'].includes(spec.kind)?spec.kind:'text';input.value=data.preferences[spec.id]?.value||'';if(spec.min!==undefined)input.min=spec.min;if(spec.max!==undefined)input.max=spec.max;
  const save=el('button','link','Save');save.type='button';save.addEventListener('click',async()=>{try{await api('preferences',{preferences:[{id:spec.id,value:input.value,confirmed:true}]});syncExtensionProfile();toast('Saved for future applications.');}catch(error){toast(error.message);}});
  // Where an automatic value came from; typed values carry no tag.
  const source=data.preferences[spec.id]?.source;if(source)field.append(el('small','pref-source',source==='cv'?'from your CV':'from your notes'));
  field.append(input,save);box.append(field);
 }
 const {answers}=await api('answers'),list=$('#answers');list.replaceChildren();
 if(answers.length)list.append(el('small','','Previous answers'));
 for(const answer of answers){const row=el('div','answer-row'),remove=el('button','link','Remove');remove.type='button';
  remove.addEventListener('click',async()=>{try{await api('answers',{answers:[{fingerprint:answer.fingerprint,value:null}]});syncExtensionProfile();row.remove();}catch(error){toast(error.message);}});
  row.append(el('span','',(answer.label||'Question')+' → '+(Array.isArray(answer.value)?answer.value.join(', '):answer.value)),remove);list.append(row);}
}

// ---- Saved Jobs & Instant Card Actions (Prepare / Tap-to-Submit / Review) -------------------------
async function toggleSaveJob(card,btn){
 if(!requireAuth('Sign in or create an account to save jobs.',()=>toggleSaveJob(card,btn)))return;
 const next=!S.savedIds.has(card.id);
 try{
  const res=await api('saved',{id:card.id,saved:next});
  S.savedIds=new Set(res.ids||[]);
  renderNav();
  if(btn){btn.classList.toggle('saved',S.savedIds.has(card.id));btn.textContent=S.savedIds.has(card.id)?'★ Saved':'☆ Save';}
  renderSavedTab();
  toast(next?'Job saved.':'Removed from saved jobs.');
 }catch(error){toast(error.message);}
}

async function prepareOrApplyCard(entry,btn){
 const {card}=entry;
 if(!requireAuth('Sign in or create an account to prepare and submit applications.',()=>prepareOrApplyCard(entry,btn)))return;
 if(!S.boot?.profile){toast('Upload your CV first.');return;}
 if(btn)btn.disabled=true;
 const autoSubmit=S.profile==='controlled_auto'||S.profile==='full_auto';
 // Immediately acknowledge action: transition card to Preparing
 card.stage='opening';
 card.note='Preparing application…';
 entry.key='';
 paint(entry);
 if(S.extensionConnected&&card.via_extension&&card.url){
  try{await sendExtensionCommand({type:'ENQUEUE_APPLICATIONS',payload:{jobs:[card],mode:autoSubmit?'controlled_auto':'prepare_review'}});}catch(error){card.stage='needs_you';card.note=error.message;paint(entry);toast(error.message);}return;
 }
 try{
  const res=await api('applications/prepare-one',{id:card.id,auto_submit:autoSubmit});
  applySingleAppResult(entry,res);
  setTimeout(poll,250);
 }catch(error){
  card.stage='matched';card.note=error.message;entry.key='';paint(entry);
  toast(error.message);
 }
}

async function submitReadyCard(entry,btn){
 const {card}=entry;
 if(card.submitting||card.stage==='sending')return;
 if(!requireAuth('Sign in to submit this application.',()=>submitReadyCard(entry,btn)))return;
 // Acknowledge action instantly: change card to Submitting and prevent duplicate taps
 card.submitting=true;
 card.stage='sending';
 card.note='Submitting · waiting for confirmation';
 entry.key='';
 if(btn){btn.disabled=true;btn.textContent='Submitting…';}
 paint(entry);
 if(S.extensionConnected&&card.via_extension){
  try{await sendExtensionCommand({type:'SUBMIT_PREPARED',jobId:card.id});}catch(error){card.submitting=false;card.stage='ready';card.note=error.message;paint(entry);toast(error.message);}return;
 }
 try{
  const res=await api('applications/submit-one',{id:card.id});
  card.submitting=false;
  applySingleAppResult(entry,res);
  setTimeout(poll,250);
 }catch(error){
  card.submitting=false;
  card.stage='ready';
  card.note=error.message;
  entry.key='';
  paint(entry);
  toast(error.message);
 }
}

function applySingleAppResult(entry,res){
 if(!res)return;
 const {card}=entry;
 const stageMap={
  confirmed:'confirmed',
  ready_to_submit:'ready',
  opening:'opening',
  filling:'filling',
  submitting:'sending',
  needs_answers:'needs_you',
  needs_login:'needs_you',
  needs_human_verification:'needs_you',
  unknown_after_submit:'uncertain'
 };
 const nextStage=stageMap[res.state]||(res.state?.startsWith('needs_')?'needs_you':'skipped');
 const prevStage=card.stage;
 card.stage=nextStage;
 card.app_state=res.state;
 card.note=res.detail?.note||card.note;
 card.evidence=res.detail?.evidence||card.evidence;
 card.questions=res.detail?.missing||card.questions;
 card.missing=card.questions?.length||0;
 card.disclosure=res.detail?.disclosure||card.disclosure;
 entry.key='';
 entry.since=Date.now();
 paint(entry);
 if(nextStage==='confirmed'&&prevStage!=='confirmed'){
  entry.node.classList.add('celebrate');
  setTimeout(()=>entry.node.classList.remove('celebrate'),1200);
 }
 settle();
 countLists();
}

async function toggleInlineReview(entry){
 const {card}=entry;
 if(S.openReviews.has(card.id)){
  S.openReviews.delete(card.id);
  paint(entry);
  return;
 }
 if(!card.disclosure?.fields?.length&&S.authenticated){
  try{
   const data=await api('applications/review',{ids:[card.id]});
   const jobReview=data.jobs?.[0];
   if(jobReview?.fields)card.disclosure={fields:jobReview.fields};
  }catch{}
 }
 S.openReviews.add(card.id);
 paint(entry);
}

async function renderSavedTab(){
 const panel=$('#tab-saved');if(!panel)return;
 if(!S.authenticated){panel.replaceChildren();return;}
 try{
  const {jobs}=await api('saved');
  panel.replaceChildren();
  for(const job of jobs){
   const card={id:job.id,title:job.title,company:job.company,location:job.location,source:job.provider,target:job.route?.label,automatable:job.route?.automatable,url:job.listing_url,stage:job.application?.state||'matched'};
   const node=cardNode(card);paint({card,node});panel.append(node);
  }
 }catch{}
}

// ---- Live stream & Animated Cards (Found → Preparing → Ready → Submitting → Applied) --------------
const running=run=>!!run&&(!!run.search_running||['searching','applying'].includes(run.state));
function stageText(card){
 const base=STAGES[card.stage]||{icon:'·',text:card.stage};
 if(card.stage==='needs_you'&&card.app_state==='needs_login')return{...base,text:'Needs review · Sign in'};
 if(card.stage==='needs_you'&&card.app_state==='needs_human_verification')return{...base,text:'Needs review · Verify'};
 if(card.stage==='needs_you'&&card.missing)return{...base,text:card.missing===1?'Needs review · 1 question':'Needs review · '+card.missing+' questions'};
 if(card.stage==='skipped')return{...base,text:'Skipped · '+(card.note||REASON[card.app_state]||card.app_state||'')};
 if(card.stage==='confirmed'&&card.earlier)return{...base,text:'Applied'};
 return base;
}
function homeFor(card){
 const run=S.feed?.run;
 if(!run)return'other';
 if(ACTIVE.has(card.stage))return'stream';
 if(!run.auto&&['matched','related','manual'].includes(card.stage))return'stream';
 if(card.stage==='matched'&&running(run))return'stream';
 return HOME[card.stage]||'other';
}
function cardNode(card){
 const node=el('article','card'),main=el('div','card-main'),title=el('button','card-title',card.title);title.type='button';title.addEventListener('click',()=>showJob(card.id,card));
 main.append(title,el('small','card-meta',[card.company,card.location].filter(Boolean).join(' · ')),el('small','card-route',card.source+(card.target?' → '+card.target:'')));
 const state=el('div','card-state'),icon=el('span','state-icon');icon.setAttribute('aria-hidden','true');state.append(icon,el('span','state-text'));
 node.append(main,state,el('div','card-extra'));node.dataset.id=card.id;return node;
}
function paint(entry){
 const {card,node}=entry,meta=stageText(card);
 node.classList.remove(...[...node.classList].filter(c=>c.startsWith('stage-')||c==='busy'));node.classList.add('stage-'+card.stage);if(meta.busy)node.classList.add('busy');
 node.querySelector('.state-icon').textContent=meta.icon;node.querySelector('.state-text').textContent=meta.text;
 node.querySelectorAll('.card-review,.card-questions').forEach(n=>n.remove());
 const extra=node.querySelector('.card-extra');extra.replaceChildren();
 const reasonText=card.note||card.why;
 if(reasonText&&!['confirmed','filling','opening','sending','ready'].includes(card.stage))extra.append(el('small','card-why',reasonText));
 // Match strength from the encoder's calibrated cut-offs (same occupation / near / related), not a fake percentage.
 if(card.role&&['matched','related','queued','manual'].includes(card.stage)){const strength=card.fit==null?'Match':card.fit>=0.8?'Strong match':card.fit>=0.62?'Good match':'Related';extra.append(el('small','card-role fit-'+strength.split(' ')[0].toLowerCase(),strength+' · '+card.role));}
 if(card.stage==='confirmed'&&card.evidence?.text)extra.append(el('small','card-evidence','Confirmed: “'+card.evidence.text+'”'));
 if(card.stage==='ready'){
  const fieldCount=card.disclosure?.fields?.length||0;
  extra.append(el('small','card-evidence',fieldCount?`${fieldCount} fields prepared from your CV`:'Prepared and ready to submit'));
  if(card.note&&/prefilled|permission/i.test(card.note))extra.append(el('small','card-why',card.note));
 }

 const actions=el('div','card-actions');
 const saved=S.savedIds.has(card.id);
 const saveBtn=el('button','save-btn'+(saved?' saved':''),saved?'★ Saved':'☆ Save');saveBtn.type='button';
 saveBtn.addEventListener('click',()=>toggleSaveJob(card,saveBtn));
 actions.append(saveBtn);

 if(card.stage==='ready'||card.stage==='sending'){
  const reviewBtn=el('button','review-btn',S.openReviews.has(card.id)?'Hide review':'Review');
  reviewBtn.type='button';
  reviewBtn.disabled=card.stage==='sending';
  reviewBtn.addEventListener('click',()=>toggleInlineReview(entry));
  const submitBtn=el('button','submit-btn',card.stage==='sending'?'Submitting…':'Submit');
  submitBtn.type='button';
  submitBtn.disabled=card.stage==='sending'||!!card.submitting;
  submitBtn.addEventListener('click',()=>submitReadyCard(entry,submitBtn));
  actions.append(reviewBtn,submitBtn);
 }else if(['matched','related'].includes(card.stage)&&(card.automatable||card.family)){
  const needsLogin=['linkedin','indeed','glassdoor'].includes(card.family)&&!S.boot?.sessions?.[card.family]?.signed_in;
  const btnLabel=needsLogin?'Connect '+({linkedin:'LinkedIn',indeed:'Indeed',glassdoor:'Glassdoor'}[card.family]):S.profile==='prepare_review'?'Prepare':'Apply';
  const applyBtn=el('button','apply-btn',btnLabel);applyBtn.type='button';
  applyBtn.addEventListener('click',()=>needsLogin?handleConnectSite(card.family):prepareOrApplyCard(entry,applyBtn));
  actions.append(applyBtn);
 }

 // A LinkedIn card cannot be prepared until the session tells us it is Easy Apply: say so and offer the fix.
 if(card.stage==='manual'&&/linkedin/i.test(String(card.source||''))&&!S.boot?.sessions?.linkedin?.signed_in){const connect=el('button','apply-btn','Connect LinkedIn to apply');connect.type='button';connect.addEventListener('click',handleConnectLinkedIn);actions.append(connect);}
 if(['matched','related','manual','skipped','needs_you'].includes(card.stage)&&/^https?:\/\//.test(card.url||'')){
  actions.append(link(card.url,'Open ↗'));
 }
 if(card.stage==='needs_you'&&['linkedin','indeed','glassdoor'].includes(card.family)&&['needs_login','needs_human_verification'].includes(card.app_state)){
  const connect=el('button','apply-btn','Open '+({linkedin:'LinkedIn',indeed:'Indeed',glassdoor:'Glassdoor'}[card.family])+' sign-in');connect.type='button';connect.addEventListener('click',()=>handleConnectSite(card.family));actions.append(connect);
 }
 if(card.stage==='needs_you'&&!card.missing&&['needs_login','needs_human_verification','deferred_slow'].includes(card.app_state)){
  const retry=el('button','apply-btn','Retry');retry.type='button';retry.addEventListener('click',()=>prepareOrApplyCard(entry,retry));actions.append(retry);
 }
 if(card.stage==='uncertain')for(const [outcome,text]of [['submitted','Mark applied'],['not_submitted','Not submitted · allow retry']]){const button=el('button','review-btn',text);button.type='button';button.addEventListener('click',async()=>{try{await api('applications/resolve',{id:card.id,outcome});toast('Updated.');poll();}catch(error){toast(error.message);}});actions.append(button);}
 extra.append(actions);

 // Optional inline Review drawer for Ready cards
 if(card.stage==='ready'&&S.openReviews.has(card.id)){
  const drawer=el('div','card-review');
  const fields=card.disclosure?.fields||[];
  if(fields.length){
   const dl=el('dl');
   for(const f of fields){
    dl.append(el('dt','',String(f.label||'Field').replace(/\*$/,'')),el('dd','',Array.isArray(f.value)?f.value.join(', '):String(f.value??'')));
   }
   drawer.append(dl);
  }else{
   drawer.append(el('small','','CV and contact details prepared.'));
  }
  node.append(drawer);
 }

 // Inline next action on Needs review cards
 if(card.stage==='needs_you'&&Array.isArray(card.questions)&&card.questions.length){
  const qBox=el('div','card-questions'),controls=[];
  for(const q of card.questions){
   if(q.kind==='file'){qBox.append(el('small','','Open this application to attach the required file: '+q.label));continue;}
   const row=el('div','q-inline'),control=answerControl(q);
   if(control.input.tagName==='INPUT')control.input.placeholder=q.label||'Required answer';
   control.input.setAttribute('aria-label',q.label||'Required answer');controls.push({q,control});
   row.append(el('small','',q.label||'Question'),control.input);
   if(S.boot?.local_drafts_enabled&&!q.options?.length&&!q.fact&&!['checkbox','checkbox_group','password','hidden'].includes(q.kind))mountJobDraft(row,card,q,control);
   qBox.append(row);
  }
  if(controls.length){
   const saveBtn=el('button','submit-btn','Save & retry');saveBtn.type='button';
   saveBtn.addEventListener('click',async()=>{
    const answers=controls.map(({q,control})=>({fingerprint:q.fingerprint,label:q.label,kind:q.kind,value:control.value(),job_id:card.id}));
    if(answers.some(answer=>answer.value===''||Array.isArray(answer.value)&&!answer.value.length)){toast('Answer the questions for this job first.');return;}
    saveBtn.disabled=true;saveBtn.textContent='Saving…';
    try{
     const result=await api('answers',{answers,retry:true});
     if(result.retrying.includes(card.id)){card.stage='queued';card.note='Answers saved. Resuming this application…';}else card.note='Saved. Check the remaining requirements for this job.';
     entry.key='';paint(entry);syncExtensionProfile();
     setTimeout(poll,300);
    }catch(error){saveBtn.disabled=false;saveBtn.textContent='Save & retry';toast(error.message);}
   });
   qBox.append(saveBtn);
  }
  node.append(qBox);
 }
}
function mountJobDraft(row,card,q,control){
 const button=el('button','review-btn','Draft answer'),status=el('small','draft-status');button.type='button';row.append(button,status);
 button.addEventListener('click',async()=>{
  button.disabled=true;const epoch=S.viewEpoch;status.textContent='Queued · other applications continue';
  try{
   let {draft}=await api('applications/draft',{id:card.id,fingerprint:q.fingerprint});
   while(['queued','running'].includes(draft?.state)){
    if(!row.isConnected||epoch!==S.viewEpoch)return;
    status.textContent=draft.state==='running'?'Preparing this answer…':'Queued · other applications continue';
    await new Promise(resolve=>setTimeout(resolve,800));({draft}=await api('applications/draft?id='+encodeURIComponent(card.id)+'&fingerprint='+encodeURIComponent(q.fingerprint)));
   }
   if(!row.isConnected||epoch!==S.viewEpoch)return;
   if(draft?.state==='ready'){
    const text=el('p','draft-preview',draft.text),use=el('button','review-btn','Use draft');use.type='button';status.textContent='Check the facts before saving.';
    use.addEventListener('click',()=>{control.input.value=draft.text;control.input.dispatchEvent(new Event('input',{bubbles:true}));text.remove();use.remove();});row.append(text,use);
   }else status.textContent=draft?.error||'No draft needed. You can answer directly.';
  }catch(error){if(row.isConnected)status.textContent=error.message;}
  finally{if(row.isConnected)button.disabled=false;}
 });
}
const LOCAL_NODE_SECTIONS = new Map();

const DEFAULT_SITE_NODES = [
 { id: 'linkedin', label: 'LinkedIn', auth: true, readyText: 'Requires Login' },
 { id: 'indeed', label: 'Indeed', auth: false, readyText: 'Job board' }
];

// One column per site the job was FOUND on (LinkedIn, Indeed, Himalayas…); the card still shows where it applies.
const SOURCE_NAMES={linkedin:'LinkedIn',indeed:'Indeed',glassdoor:'Glassdoor',google:'Google Jobs',himalayas:'Himalayas',remoteok:'Remote OK',remote_ok:'Remote OK',jobicy:'Jobicy',remotive:'Remotive',arbeitnow:'Arbeitnow',wwr:'We Work Remotely',greenhouse:'Greenhouse',lever:'Lever',ashby:'Ashby',workable:'Workable',smartrecruiters:'SmartRecruiters',personio:'Personio',bamboohr:'BambooHR',workday:'Workday',company_career_sites:'Company careers',boards:'Company careers'};
const ATS_SOURCES=new Set(['greenhouse','lever','ashby','workable','smartrecruiters','personio','bamboohr','workday']);
function getCardSite(card) {
 const raw = String(card.source || card.provider || String(card.id||'').split(':')[0] || 'other').trim().toLowerCase();
 if(ATS_SOURCES.has(raw))return'boards';
 return raw.replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '') || 'other';
}
function siteLabel(siteId, card) {
 return SOURCE_NAMES[siteId] || String(card?.source || siteId).replace(/^./, c => c.toUpperCase());
}

function ensureLocalNodeSection(siteId, label = null) {
 if (LOCAL_NODE_SECTIONS.has(siteId)) return LOCAL_NODE_SECTIONS.get(siteId);
 const container = $('#nodes-stream');
 if (!container) return null;

 const conf = DEFAULT_SITE_NODES.find(n => n.id === siteId) || { id: siteId, label: label || SOURCE_NAMES[siteId] || siteId, auth: false, readyText: ATS_SOURCES.has(siteId) ? 'Company careers' : 'Job board' };

 const section = el('section', 'site-node-section');
 section.id = 'node-section-' + siteId;

 const header = el('div', 'node-section-header');
 const left = el('div', 'node-header-left');
 const dot = el('span', 'node-status-dot idle');
 dot.id = 'dot-node-' + siteId;
 const title = el('h3', 'node-title', conf.label);
 const badge = el('span', 'node-badge', '0 found');
 badge.id = 'badge-node-' + siteId;
 left.append(dot, title, badge);

 const right = el('div', 'node-header-right');
 right.id = 'right-node-' + siteId;

 const stateText = el('span', 'node-state-text', conf.readyText);
 stateText.id = 'state-node-' + siteId;
 right.append(stateText);

 if (siteId === 'linkedin') {
  const isConnected = !!S.boot?.sessions?.linkedin?.signed_in;
  if (isConnected) {
   stateText.textContent = 'Connected ✓';
   stateText.classList.add('text-ready');
   dot.className = 'node-status-dot done';
  } else {
   const connectBtn = el('button', 'btn-connect-node', 'Connect');
   connectBtn.type = 'button';
   connectBtn.addEventListener('click', handleConnectLinkedIn);
   right.append(connectBtn);
  }
 }

 header.append(left, right);

 const list = el('div', 'node-jobs-list');
 list.id = 'node-jobs-' + siteId;

 const emptyMsg = el('div', 'node-empty-msg', 'Ready to search\nStart to discover jobs');
 emptyMsg.id = 'empty-node-' + siteId;
 list.append(emptyMsg);

 section.append(header, list);
 container.append(section);

 const meta = { section, dot, title, badge, stateText, right, list, emptyMsg, count: 0 };
 LOCAL_NODE_SECTIONS.set(siteId, meta);
 return meta;
}

function initDefaultNodeSections() {
 for (const conf of DEFAULT_SITE_NODES) {
  ensureLocalNodeSection(conf.id);
 }
}

function updateLocalLinkedInNodeState() {
 const meta = LOCAL_NODE_SECTIONS.get('linkedin');
 if (!meta) return;
 const isConnected = !!S.boot?.sessions?.linkedin?.signed_in;
 meta.right.replaceChildren();
 if (isConnected) {
  meta.stateText.textContent = 'Connected ✓';
  meta.stateText.className = 'node-state-text text-ready';
  meta.dot.className = 'node-status-dot done';
  meta.right.append(meta.stateText);
 } else {
  meta.stateText.textContent = 'Requires Login';
  meta.stateText.className = 'node-state-text';
  meta.dot.className = 'node-status-dot idle';
  const connectBtn = el('button', 'btn-connect-node', 'Connect');
  connectBtn.type = 'button';
  connectBtn.addEventListener('click', handleConnectLinkedIn);
  meta.right.append(meta.stateText, connectBtn);
 }
}

function showCaptchaAlert(site = 'linkedin') {
 const alertBox = $('#captcha-alert');
 if (!alertBox) return;
 alertBox.hidden = false;
 $('#alert-title').textContent = `Action Required: ${site.toUpperCase()} Checkpoint`;
 $('#alert-msg').textContent = `${site.toUpperCase()} returned a CAPTCHA or security verification. Open the site in your browser to verify or use the extension.`;
 if (site === 'linkedin') $('#alert-link').href = 'https://www.linkedin.com/jobs';
 else if (site === 'indeed') $('#alert-link').href = 'https://www.indeed.com';
 const meta = LOCAL_NODE_SECTIONS.get(site);
 if (meta) {
  meta.dot.className = 'node-status-dot captcha';
  meta.stateText.textContent = 'CAPTCHA Required';
 }
}

// Each site column scrolls on its own: a column follows new jobs only while its reader is at its bottom.
const atBottom=list=>list.scrollHeight-list.scrollTop-list.clientHeight<48;
function streamAtBottom(){return[...document.querySelectorAll('.node-jobs-list')].every(atBottom);}
function toBottom(){for(const list of document.querySelectorAll('.node-jobs-list'))list.scrollTop=list.scrollHeight;S.unseen=0;$('#back-live').hidden=true;}
function intoStream(entry,animate){
 entry.list='stream';entry.node.classList.remove('leaving');entry.node.style.maxHeight='';
 if(animate){entry.node.classList.add('enter');setTimeout(()=>entry.node.classList.remove('enter'),340);}
 
 const siteId = getCardSite(entry.card);
 const node = ensureLocalNodeSection(siteId, siteLabel(siteId, entry.card));
 if (node) {
  if (node.emptyMsg && node.emptyMsg.parentNode) {
   node.emptyMsg.remove();
   node.emptyMsg = null;
  }
  node.count++;
  node.badge.textContent = `${node.count} found`;
  node.badge.classList.add('has-jobs');
  if (siteId !== 'linkedin' || S.boot?.sessions?.linkedin?.signed_in) {
   node.dot.className = 'node-status-dot done';
  }
  // Follow only a column the reader already scrolled to its end; a fresh column keeps its first job in view.
  const follow=node.list.scrollTop>0&&atBottom(node.list);node.list.append(entry.node);
  if(follow)requestAnimationFrame(()=>{node.list.scrollTop=node.list.scrollHeight;});
 } else {
  $('#stream').append(entry.node);
 }
}
// A job stays in its site column for the whole run; the review tabs below hold a painted copy.
function intoList(entry,list){
 entry.list=list;entry.node.classList.remove('leaving','enter');entry.node.style.maxHeight='';
 if(!entry.node.closest('.node-jobs-list'))intoStream(entry,false);
 entry.list=list;entry.mirror?.remove();
 entry.mirror=cardNode(entry.card);paint({card:entry.card,node:entry.mirror,key:entry.key});
 const panel=$('#tab-'+list);if(list==='completed')panel.prepend(entry.mirror);else panel.append(entry.mirror);
}
function settle(){
 // Copying into the tabs never moves a card the reader is looking at, so it is not paused while reading.
 const now=Date.now();
 for(const entry of S.cards.values()){
  if(entry.list!=='stream'||entry.leaving)continue;const home=homeFor(entry.card);if(home==='stream')continue;
  if(now-entry.since<(entry.card.stage==='confirmed'?1600:1200))continue;
  intoList(entry,home);countLists();
 }
}
function upsert(card){
 let entry=S.cards.get(card.id);
 if(entry?.card?.submitting&&card.stage==='ready')card={...card,stage:'sending',submitting:true};
 const key=[card.stage,card.app_state,card.note,card.missing,S.savedIds.has(card.id),S.openReviews.has(card.id)].join('|');
 if(!entry){
  entry={card,node:cardNode(card),key,since:Date.now(),list:null};S.cards.set(card.id,entry);paint(entry);
  const home=homeFor(card);if(S.initial&&home!=='stream')intoList(entry,home);else intoStream(entry,!S.initial);return;
 }
 const previous=entry.card.stage;entry.card={...entry.card,...card};if(entry.key===key)return;
 entry.key=key;entry.since=Date.now();paint(entry);
 if(card.stage==='confirmed'&&previous!=='confirmed'){entry.node.classList.add('celebrate');setTimeout(()=>entry.node.classList.remove('celebrate'),1100);}
 const home=homeFor(entry.card);if(entry.list!=='stream'){if(home==='stream'){entry.mirror?.remove();entry.mirror=null;entry.list='stream';}else intoList(entry,home);}
}
function drop(entry){
 S.cards.delete(entry.card.id);const node=entry.node;entry.mirror?.remove();
 if(entry.list==='stream'&&!S.initial){node.querySelector('.state-text').textContent='Filtered out';node.style.maxHeight=node.scrollHeight+'px';requestAnimationFrame(()=>node.classList.add('leaving','dropped'));setTimeout(()=>node.remove(),360);}else node.remove();
}
// Site columns read like text (left to right, then the next row), busiest first; empty columns last.
// CSS order keeps each column's own scroll position (no DOM moves).
const columnSeen=new WeakMap();let columnSeq=0,columnFrame=0;
function orderColumns(){
 columnFrame=0;const stream=$('#nodes-stream');if(!stream)return;
 for(const section of stream.children){
  if(!columnSeen.has(section))columnSeen.set(section,++columnSeq);
  const count=section.querySelectorAll('.node-jobs-list > .card').length;
  section.style.order=String(-count*10000+columnSeen.get(section));
 }
}
function scheduleColumnOrder(){if(!columnFrame)columnFrame=requestAnimationFrame(orderColumns);}
new MutationObserver(scheduleColumnOrder).observe(document.querySelector('#nodes-stream')||document.body,{childList:true,subtree:true});
// Role suggestions from the occupation vocabulary used to read CVs (titles and multilingual aliases).
let roleVocabulary=null,roleIndex=null;
async function suggestRoles(){
 const fold=t=>String(t||'').toLocaleLowerCase('tr').normalize('NFKD').replace(/\p{M}/gu,'').replace(/ı/g,'i').trim(),q=fold($('#query').value),list=$('#role-suggestions');
 if(q.length<2){list.replaceChildren();return;}
 try{roleVocabulary??=(await fetch(BASE+'public/vocabulary').then(r=>r.ok?r.json():{entries:[]})).entries||[];}catch{roleVocabulary=[];}
 roleIndex??=roleVocabulary.flatMap(e=>[...new Set([e.title,...(e.aliases||[])])].map(label=>({label,key:fold(label)})));
 const starts=[],contains=[],seen=new Set();
 for(const item of roleIndex){if(seen.has(item.key))continue;const at=item.key.indexOf(q);if(at<0)continue;seen.add(item.key);(at===0||item.key[at-1]===' '?starts:contains).push(item);if(starts.length>=20)break;}
 list.replaceChildren(...[...starts.sort((a,b)=>a.label.length-b.label.length),...contains.sort((a,b)=>a.label.length-b.label.length)].slice(0,20).map(item=>{const o=document.createElement('option');o.value=item.label;return o;}));
}
document.querySelector('#query')?.addEventListener('input',()=>{suggestRoles();});
function resetStream(){
 S.cards.clear();
 LOCAL_NODE_SECTIONS.clear();
 const streamContainer = $('#nodes-stream');
 if (streamContainer) streamContainer.replaceChildren();
 $('#stream').replaceChildren();
 for(const id of ['completed','needs','other','skipped'])$('#tab-'+id).replaceChildren();
 S.live=true;S.unseen=0;$('#back-live').hidden=true;
}
async function clearResults(){
 const button=$('#clear-results');button.disabled=true;
 try{
  if(running(S.feed?.run))throw new Error('Stop the current run before clearing results.');
  if(S.authenticated)await api('run/clear',{});
  S.viewEpoch++;S.resultsCleared=true;clearTimeout(S.timer);
  S.feed=null;S.runId=null;S.publicSearchId=null;S.clientCards=[];S.canExpand=false;S.publicLimit=FIRST_DEPTH;S.appsKey='';S.started=false;S.openReviews.clear();
  if(S.boot)S.boot.last_search=null;
  resetStream();countLists();
  for(const id of ['live','expand-search','pause','stop','captcha-alert'])$('#'+id).hidden=true;
  $('#start').hidden=false;$('#start').disabled=false;
  $('#counters').replaceChildren();$('#sources').replaceChildren();$('#metrics').textContent='';fail('');
  connectionRecovered();S.previewEdited=true;S.requestedSearch=false;setSearchStatus('ready');
  document.querySelectorAll('#profiles input').forEach(input=>input.disabled=false);
  toast('Results cleared. Your CV, accounts and saved jobs are kept.');
  if(S.authenticated)S.timer=setTimeout(poll,4000);
 }catch(error){toast(error.message);}
 finally{button.disabled=false;}
}
function countLists(){
 const n={completed:0,needs:0,other:0,skipped:0};for(const entry of S.cards.values())if(entry.list in n)n[entry.list]++;
 for(const [id,count]of Object.entries(n))$('#n-'+id).textContent=count;
 $('#n-saved').textContent=String(S.savedIds.size);
 $('#lists').hidden=!Object.values(n).some(Boolean)&&!S.savedIds.size;
}
function renderHead(feed){
 const run=feed.run,counts=feed.counts||{},title=$('#run-title'),active=running(run);
 const readyCount=counts.ready||0;
 title.textContent=run.state==='stopped'&&run.search_running?'Stopping · waiting for sources…'
  :run.paused?'Paused · search continues'
  :run.error?'Search ended with an error'
  :run.state==='searching'?(run.auto?'Streaming jobs & preparing…':'Streaming matching jobs…')
  :run.state==='applying'?(readyCount?`${readyCount} ready to submit · preparing more…`:'Preparing & submitting…')
  :run.state==='stopped'?'Stopped'
  :run.state==='interrupted'?'Interrupted'
  :readyCount?`${readyCount} ready · tap Submit on any card`
  :run.auto?'Complete':(S.requestedSearch&&!S.previewEdited?'Search complete':'Previous search')+' · '+run.matched+' matches';
 if(!S.connectionLost){
  const state=run.state==='stopped'?(run.search_running?'stopping':'stopped'):run.paused?'paused':run.state==='interrupted'?'interrupted':active?(run.phase==='matching'?'matching':run.state==='applying'?'applying':'searching'):'complete';
  setSearchStatus(run.error?'error':!active&&S.previewEdited?'ready':state);
 }
 const plan=run.plan?.roles?.length?run.plan.roles.slice(0,4).join(' · '):run.queries?.length?run.queries.join(' · '):'';
 $('#run-sub').textContent=[plan,((((run.finished_at||Date.now())-run.started_at)/1000).toFixed(1))+' s'].filter(Boolean).join(' · ');
 const filters=run.filters||{},country=(S.boot?.countries||S.publicConfig?.countries||[]).find(([id])=>id===filters.country)?.[1]||filters.country;
 $('#search-filters').textContent=[run.sources?.length?new Set(run.sources.map(r=>r.site)).size+' sources':null,country,filters.work_mode==='remote_only'?'Remote only':filters.work_mode==='anywhere'?'Any location':filters.location+(filters.work_mode==='local_and_remote'?' + remote':''),filters.hours_old?'Past '+(filters.hours_old/24)+' days':null,filters.limit?filters.limit+' per role / source in this pass':null].filter(Boolean).join(' · ');
 $('#search-exclusions').textContent=[run.excluded?run.excluded+' excluded by your filters':null,...Object.entries(run.exclusion_summary||{}).map(([reason,n])=>n+' '+reason),run.can_expand?'More pages are available. Use Keep searching to continue.':null].filter(Boolean).join(' · ');
 $('#source-details').replaceChildren(...mergeSources(run.sources).map(source=>el('p','source-detail',source.site+': '+source.count+' unique candidates'+(source.matched!=null?' · '+source.matched+' matched':'')+' · '+source.state.replaceAll('_',' ')+(source.method?' · '+(source.method==='signed_in_browser'?'connected account':'public search'):'')+(source.has_more?' · more pages available':'')+(source.examined?' · '+source.examined+' checked'+(source.indexed_matches?' / '+source.indexed_matches+' indexed hits':''):'')+(source.notes.length?' · '+source.notes.join(' · '):''))));
 $('#run-indicator').hidden=!active||run.paused;
 // In apply modes, say plainly when nothing in the results has a form TapSubmit can fill yet.
 const fillable=feed.cards.filter(c=>c.automatable||['queued','opening','filling','ready','sending','confirmed','needs_you','uncertain'].includes(c.stage)).length;
 if(run.auto&&!active&&feed.cards.length&&!fillable)$('#run-sub').textContent+=' · No supported application form in these results yet: connect LinkedIn for Easy Apply, or open a job to apply on its site.';
 $('#sources').replaceChildren(...mergeSources(run.sources).map(source=>{const done=['done','cached'].includes(source.state),chip=el('span','source '+(done?'done':['searching','queued'].includes(source.state)?'busy':'off'));chip.textContent=source.site+' '+(done?'✓ '+source.count:source.state==='searching'?'…':source.state.replaceAll('_',' '));return chip;}));
 const preparing=(counts.queued||0)+(counts.opening||0)+(counts.filling||0),submitting=counts.sending||0,appliedNow=feed.cards.filter(c=>c.stage==='confirmed'&&!c.earlier).length,needs=(counts.needs_you||0)+(counts.uncertain||0);
 const items=[['Found',run.found]];
 if(run.auto){
  items.push(['Preparing',preparing],['Ready',readyCount],['Submitting',submitting],['Applied ✓',appliedNow],['Needs review',needs]);
 }else{
  items.push(['Matched',run.matched]);
 }
 const box=$('#counters');if(box.children.length!==items.length)box.replaceChildren(...items.map(()=>{const cell=el('div','counter');cell.append(el('b'),el('small'));return cell;}));
 items.forEach(([label,value],i)=>{const cell=box.children[i],b=cell.querySelector('b');if(b.textContent!==String(value)){b.textContent=value;cell.classList.remove('bump');void cell.offsetWidth;if(!S.initial)cell.classList.add('bump');}cell.querySelector('small').textContent=label;});
 const m=run.metrics;$('#metrics').textContent=m?['first job '+seconds(m.first_job_ms),m.first_match_ms!=null&&'first match '+seconds(m.first_match_ms),m.first_application_ms!=null&&'first form '+seconds(m.first_application_ms),m.first_confirmed_ms!=null&&'first confirmed '+seconds(m.first_confirmed_ms)].filter(Boolean).join(' · '):'';
 if(run.error)$('#error').textContent=run.error;
 const busy=active;$('#start').hidden=busy;$('#pause').hidden=!busy||!run.auto||run.state==='stopped';$('#stop').hidden=!busy;$('#stop').disabled=run.state==='stopped';$('#pause').textContent=run.paused?'Resume':'Pause';
 $('#clear-results').disabled=busy;
 // Local runs can always go deeper once finished; the public path reports can_expand itself.
 if(!busy&&S.authenticated)S.canExpand=!!run.can_expand;
 const deeper=nextDepth(S.publicLimit);
 $('#expand-search').hidden=busy||!S.canExpand||!deeper;
 if(deeper)$('#expand-search').textContent=`Keep searching · up to ${deeper} per source ↓`;
 document.querySelectorAll('#profiles input').forEach(input=>input.disabled=busy);
}
function mergeSources(rows=[]){const by=new Map();for(const row of rows){const entry=by.get(row.site)||{site:row.site,count:0,states:[],notes:[],has_more:false,examined:0,indexed_matches:0};entry.count+=row.count||0;entry.examined+=row.examined||0;entry.indexed_matches+=row.indexed_matches||0;if(row.source_total!=null)entry.unique=row.source_total;if(row.source_matched!=null)entry.matched=row.source_matched;entry.states.push(row.state);entry.has_more||=!!row.has_more;if(row.method)entry.method=row.method;for(const note of [row.error,row.note,...(row.warnings||[])])if(note&&!entry.notes.includes(note))entry.notes.push(note);by.set(row.site,entry);}
 return[...by.values()].map(entry=>({...entry,count:entry.unique??entry.count,state:entry.states.some(s=>s==='searching')?'searching':entry.states.some(s=>s==='queued')?'queued':entry.states.every(s=>['done','cached','no_results'].includes(s))?'done':entry.states.some(s=>['done','cached','no_results'].includes(s))?'partly_unavailable':entry.states[0]}));}

function mergeClientAndServerCards(serverCards=[]){
 if(S.authenticated)return serverCards;
 const seen=new Set(serverCards.map(c=>`${(c.title||'').toLowerCase()}|${(c.company||'').toLowerCase()}`));
 const combined=[...serverCards];
 for(const c of Array.isArray(S.clientCards)?S.clientCards:[]){
  const key=`${(c.title||'').toLowerCase()}|${(c.company||'').toLowerCase()}`;
  if(seen.has(key))continue;
  seen.add(key);
  combined.push({...c,order:combined.length});
 }
 return combined;
}

function renderImmediateClientStream(){
 if(S.resultsCleared)return;
 if(S.feed){
  applyFeed(S.feed);
  return;
 }
 if(!S.clientCards.length)return;
 const runId=S.publicSearchId||'live-stream';
 applyFeed({
  run:{
   id:runId,profile:S.profile,auto:S.profile!=='find_only',state:'searching',paused:false,
   search_running:true,started_at:S.publicStartedAt||Date.now(),finished_at:null,
   queries:activeQueries(),sources:[],found:S.clientCards.length,matched:S.clientCards.length
  },
  cards:S.clientCards,counts:{}
 });
}
function receiveClientBatch(batch){
 const jobs=new Map((Array.isArray(S.clientCards)?S.clientCards:[]).map(job=>[job.id,job]));for(const job of Array.isArray(batch)?batch:[])jobs.set(job.id,job);S.clientCards=[...jobs.values()];renderImmediateClientStream();
}

function applyFeed(feed){
 if(!feed||!feed.run){$('#live').hidden=true;return;}
 const cards=mergeClientAndServerCards(feed.cards||[]);
 const counts={};for(const card of cards)counts[card.stage]=(counts[card.stage]||0)+1;
 feed={...feed,cards,counts,run:{...feed.run,found:Math.max(feed.run.found||0,cards.length),matched:S.authenticated?feed.run.matched:Math.max(feed.run.matched||0,cards.filter(c=>!['skipped','matching'].includes(c.stage)).length)}};
 S.feed=feed;const run=feed.run;
 if(S.runId!==run.id){resetStream();S.runId=run.id;S.initial=!S.started;S.started=false;}
 $('#live').hidden=false;renderHead(feed);$('#stream').dataset.empty=running(run)?'Matching jobs stream here as sources respond…':'All results from this run are organized below.';
 for(const source of mergeSources(run.sources)){
  const sourceId=S.boot?.sources?.find(s=>s.label.toLowerCase()===String(source.site).toLowerCase())?.id||String(source.site).toLowerCase().replace(/[^a-z0-9]+/g,'_');
  const section=ensureLocalNodeSection(sourceId,source.site);section.stateText.textContent=source.state==='done'?source.count+' found':source.state.replaceAll('_',' ');
  if(section.emptyMsg){section.emptyMsg.textContent=source.state==='done'?'No matches after your filters':source.state==='searching'||source.state==='queued'?'Searching…':source.state.replaceAll('_',' ');}
 }
 const ids=new Set();for(const card of [...feed.cards].sort((a,b)=>a.order-b.order)){ids.add(card.id);upsert(card);}
 for(const entry of [...S.cards.values()])if(!ids.has(entry.card.id))drop(entry);
 settle();S.initial=false;countLists();
}

async function pollPublicSearch(){
 clearTimeout(S.timer);
 if(!S.publicSearchId)return;
 const epoch=S.viewEpoch;
 try{
  const res=await fetch(`${BASE}public/status?id=${encodeURIComponent(S.publicSearchId)}`,{credentials:'same-origin',signal:AbortSignal.timeout(7000)});
  if(res.status===404){S.publicSearchId=null;connectionRecovered();if(S.feed){S.feed.run.state='interrupted';S.feed.run.search_running=false;applyFeed(S.feed);}setSearchStatus('interrupted');fail('This search session expired. Your displayed results are kept; press Start for a new search.');return;}
  if(!res.ok)throw Error('Could not read search status.');
  const data=await res.json();
  if(epoch!==S.viewEpoch)return;
  connectionRecovered();
  S.canExpand=!!data.can_expand;
  S.publicLimit=data.limit||S.publicLimit;
  const serverCards=(data.jobs||[]).map((job,idx)=>({
   id:job.id,order:idx,title:job.title,company:job.company||'',location:String(job.location||'').split(/[;|]/)[0].trim().slice(0,60),
   workplace:job.workplace||null,source:job.source,target:job.route,family:job.family,automatable:job.automatable,url:job.url,
   stage:job.review?'related':job.automatable?'matched':'manual',role:job.closest_role||null,
   why:job.experience_review?'Check seniority / experience requirements':null
  }));
  const startedAt=S.publicStartedAt||(Date.now()-(data.elapsed_ms||0));
  applyFeed({
   run:{
    id:S.publicSearchId,profile:'find_only',auto:false,state:data.cancelled?'stopped':data.running?'searching':'complete',paused:false,phase:data.phase,
    search_running:!!data.running,started_at:startedAt,finished_at:data.running?null:Date.now(),
    error:data.error||null,plan:data.plan||null,queries:data.queries||activeQueries(),
    sources:data.rows||[],found:Math.max(data.checked||0,serverCards.length),matched:serverCards.length,can_expand:data.can_expand,filters:data.filters,excluded:data.excluded,exclusion_summary:data.exclusion_summary
   },
   cards:serverCards,counts:{}
  });
  if(data.running)S.timer=setTimeout(pollPublicSearch,450);
 }catch(error){if(epoch===S.viewEpoch){connectionIssue();S.timer=setTimeout(pollPublicSearch,2500);}}
}

async function poll(){
 clearTimeout(S.timer);
 if(!S.authenticated){if(S.publicSearchId)await pollPublicSearch();return;}
 const epoch=S.viewEpoch;
 let delay=5000;
 try{
  const feed=await api('run/feed',undefined,{signal:AbortSignal.timeout(7000)});
  if(epoch!==S.viewEpoch)return;
  if(S.starting&&(!feed.run||feed.run.started_at<S.publicStartedAt-1000))return;
  connectionRecovered();
  if(feed?.run){
   applyFeed(feed);
   if(feed.run.state==='applying'||S.boot?.browser?.running){
    const status=await api('automation/status',undefined,{signal:AbortSignal.timeout(7000)});
    if(status.browser?.stream?.state==='on'&&status.browser.needs_human&&!$('#live-browser').open){
     openLiveBrowser('Complete verification');
    }
   }
   delay=running(feed.run)?500:document.hidden?15000:4000;
  }else if(S.publicSearchId){
   await pollPublicSearch();return;
  }
  if(!feed?.run)setSearchStatus('ready');
 }catch(error){if(error.network)connectionIssue();else fail(error.message);delay=3000;}
 if(epoch===S.viewEpoch)S.timer=setTimeout(poll,delay);
}

// ---- Lists that need the person -------------------------------------------------------------------
async function review(ids){
 try{
  const data=await api('applications/review',{ids}),body=$('#review-body');body.replaceChildren(el('p','fine',data.disclosure));
  for(const job of data.jobs){const box=el('div','review-job');box.append(el('strong','',job.title+' · '+job.company),el('small','',job.destination));
   const table=el('dl');for(const field of job.fields){table.append(el('dt','',field.label.replace(/\*$/,'')),el('dd','',(Array.isArray(field.value)?field.value.join(', '):String(field.value??''))+(field.source==='site_prefilled'?' · prefilled':'')));}box.append(table);body.append(box);}
  $('#review-title').textContent='Submit '+data.jobs.length+(data.jobs.length===1?' application':' applications');$('#review-send').textContent='Submit '+data.jobs.length;
  $('#review-send').onclick=async()=>{$('#review-send').disabled=true;try{await api('applications/submit',{ids,token:data.token});$('#review').close();toast('Submitting applications…');S.appsKey='';setTimeout(poll,300);}catch(error){toast(error.message);}finally{$('#review-send').disabled=false;}};
  $('#review').showModal();
 }catch(error){toast(error.message);}
}
async function showJob(id,fallbackCard=null){
 try{
  const {job,application}=await api('job?id='+encodeURIComponent(id)),body=$('#dialog-body');$('#dialog-title').textContent=job.title;
  body.replaceChildren(el('p','',[job.company,job.location].filter(Boolean).join(' · ')),link(job.apply_url,'Open job posting ↗'));
  if(application)body.append(el('p','fine',(STAGES[application.state]?.text||REASON[application.state]||application.state.replaceAll('_',' '))+(application.detail?.note?' · '+application.detail.note:'')));
  body.append(el('p','description',job.description||'Open the original job posting for full details.'));$('#details').showModal();
 }catch{
  if(fallbackCard){
   const body=$('#dialog-body');$('#dialog-title').textContent=fallbackCard.title;
   body.replaceChildren(el('p','',[fallbackCard.company,fallbackCard.location].filter(Boolean).join(' · ')),link(fallbackCard.url,'Open job posting ↗'));
   $('#details').showModal();
  }
 }
}
async function history(){
 if(!requireAuth('Sign in to view your application history.',history))return;
 try{const {applications}=await api('applications'),body=$('#dialog-body');$('#dialog-title').textContent='Application history';body.replaceChildren();
  if(!applications.length)body.append(el('p','fine','No applications yet.'));
  for(const app of applications){const row=el('div','history-row');row.append(el('strong','',app.title+(app.company?' · '+app.company:'')),el('small','',(app.state==='confirmed'?'✓ Applied · confirmed':REASON[app.state]||app.state.replaceAll('_',' '))+' · '+new Date(app.updated_at*1000).toLocaleString()));body.append(row);}
  $('#details').showModal();}
 catch(error){toast(error.message);}
}

// ---- Discovery & Autonomous Run Controls ----------------------------------------------------------
async function startPublicDiscovery(limit=100,expand=false){
 fail('');
 const input=searchInput(limit);
 const queryText=$('#query').value.trim();
 const titles=S.guestCV?.titles||[];
 const features={...(S.guestCV?.features||{roles:[],skills:[],level:'mid'}),country:input.country,remote:input.remote};
 if(!input.queries.length){
  fail('Add at least one search role.');$('#query').focus();return;
 }
 S.starting=true;S.previewEdited=false;S.requestedSearch=true;connectionRecovered();setSearchStatus('starting');
 $('#start').disabled=true;$('#expand-search').disabled=true;remember({country:input.country});
 const epoch=++S.viewEpoch;S.resultsCleared=false;
 S.publicStartedAt=Date.now();S.publicLimit=limit;S.started=true;S.live=true;
 if(!expand)S.clientCards=[];
 $('#live').hidden=false;
 $('#live').scrollIntoView({behavior:'smooth',block:'start'});

 // The localhost public API uses this same device/IP and applies one authoritative policy gate.

 try{
  const res=await fetch(BASE+'public/search',{
   method:'POST',credentials:'same-origin',headers:{'Content-Type':'application/json'},
   body:JSON.stringify({queries:input.queries,titles:input.queries,features,sites:input.sites,limit,hours_old:input.hours_old,location:input.location,work_mode:input.work_mode})
  });
  const data=await res.json();
  if(epoch!==S.viewEpoch)return;
  if(!res.ok)throw new Error(data.error||'Search failed.');
  S.publicSearchId=data.id;
  await pollPublicSearch();
 }catch(error){S.started=false;setSearchStatus('error');fail(error.message==='Failed to fetch'?'Connection interrupted before search could be confirmed. Check the local app and try again.':error.message);}
 finally{S.starting=false;$('#start').disabled=false;$('#expand-search').disabled=false;}
}

async function start(limitOverride=null,expand=false){
 if(S.uploading||S.starting)return;
 if($('#query').value.trim()){addQueryTag();if($('#query').value.trim())return;}
 if(!$('#work-mode').value){fail('Choose where you can work first.');$('#work-mode').focus();return;}
 if(['local_only','local_and_remote'].includes($('#work-mode').value)&&(!$('#country').value||$('#country').value==='worldwide')){fail('Choose a country, then select your cities.');$('#country').focus();return;}
 if(['local_only','local_and_remote'].includes($('#work-mode').value)&&!$('#city-choice').value.trim()){fail('Select the cities where you can work.');document.querySelector('#city-picker-wrap .ts-control input')?.focus();return;}
 fail('');
 if(!S.authenticated||S.profile==='find_only'&&!S.boot?.profile){
  if(S.profile!=='find_only'&&!S.authenticated){
   openAuthModal('Sign in or create an account to prepare and submit applications.',()=>start(limitOverride,expand));
   return;
  }
  if(!S.authenticated){await startPublicDiscovery(limitOverride||100,expand);return;}
 }
 const input=searchInput(limitOverride);S.publicLimit=input.limit;
 if(S.profile!=='find_only'&&!S.boot.profile){fail('Upload your CV first.');return;}
 if(!input.queries.length){fail('Add at least one search role.');$('#query').focus();return;}
 if(['controlled_auto','full_auto'].includes(S.profile)&&!(S.boot.consented||[]).includes(S.profile)){if(!await chooseProfile(S.profile))return;}
 S.starting=true;S.previewEdited=false;S.requestedSearch=true;connectionRecovered();setSearchStatus('starting');
 $('#start').disabled=true;remember({country:input.country});
 const epoch=++S.viewEpoch;S.resultsCleared=false;
 S.publicStartedAt=Date.now();
 if(!expand)S.clientCards=[];
 $('#live').hidden=false;
 $('#live').scrollIntoView({behavior:'smooth',block:'start'});

 // The authenticated local engine already fetches these feeds using the user's IP.
 // Keep one authoritative ranking/policy gate instead of merging unfiltered duplicate cards.

 try{S.started=true;await api('automation/start',input,{signal:AbortSignal.timeout(15000)});S.live=true;await poll();}
 catch(error){S.started=false;if(error.network){connectionIssue();S.timer=setTimeout(poll,1000);}else{setSearchStatus('error');fail(error.message);}}
 finally{S.starting=false;$('#start').disabled=false;}
}

async function uploadCVToServer(file){
 const form=new FormData();form.set('resume',file);
 const response=await fetch(BASE+'resume',{method:'POST',credentials:'same-origin',headers:{'X-CSRF-Token':S.csrf},body:form}),data=await response.json();
 if(!response.ok)throw new Error(data.error||'CV upload failed.');
 if(data.cv_preferences?.length)toast('Filled '+data.cv_preferences.length+' settings from your CV. Review them in Settings.');
 S.boot.profile=data.profile;S.boot.plan=data.profile?.plan?.queries?{queries:data.profile.plan.queries}:null;
 S.queryTags=null;remember({query_tags:null});
 clearPendingCVFile();
 syncExtensionProfile();
}

async function upload(file){
 if(S.uploading)return;
 if(running(S.feed?.run)){toast('Stop the current search before replacing your CV.');return;}
 fail('');
 S.uploading=true;$('#start').disabled=true;setSearchStatus('reading');
 try{
  $('#resume-note').textContent='Reading your CV…';
  const {summary}=await processCVInBrowser(file,BASE);
  S.guestCV=summary;
  S.queryTags=null;remember({query_tags:null});S.previewEdited=true;
  renderCV();renderCountries();
  if(S.authenticated){
   await uploadCVToServer(file);
   renderCV();renderCountries();
  }
  toast('CV ready. Review your roles and press Start.');
 }catch(error){fail(error.message==='Failed to fetch'?'CV upload was interrupted. Reconnect and upload it again; no search was started.':error.message);toast(error.message);}
 finally{S.uploading=false;$('#start').disabled=false;renderCV();setSearchStatus($('#error').textContent?'error':'ready');}
}

// ---- Startup & Event Wiring -----------------------------------------------------------------------
try{
 subscribeExtensionEvents(handleExtensionEvent);
 initExtensionBridge().then(ok=>{if(ok){S.extensionConnected=true;syncExtensionProfile();}}).catch(()=>{});
 // Render the shell and wire actions before making any network-dependent startup calls.
 renderCV();renderProfiles();renderCountries();
 renderReadinessStrip();
 initDefaultNodeSections();

 $('#start').addEventListener('click',()=>start(FIRST_DEPTH,false));
 $('#connect-linkedin-btn')?.addEventListener('click',handleConnectLinkedIn);
 $('#connect-indeed-btn')?.addEventListener('click',handleConnectIndeed);
 $('#connect-glassdoor-btn')?.addEventListener('click',()=>handleConnectSite('glassdoor'));
 $('#add-query-btn')?.addEventListener('click',addQueryTag);
 $('#retry-connection').addEventListener('click',poll);
 for(const id of ['pref-auth','pref-visa','pref-notice','pref-level']){
  $('#'+id)?.addEventListener('change',saveScreeningPreferences);
 }
 $('#expand-search').addEventListener('click',()=>{
  const nextLimit=nextDepth(S.publicLimit);if(nextLimit)start(nextLimit,true);
 });
 $('#pause').addEventListener('click',async()=>{try{await api('automation/pause',{paused:!S.feed?.run?.paused});poll();}catch(error){toast(error.message);}});
 $('#stop').addEventListener('click',async()=>{try{setSearchStatus('stopping');if(S.authenticated)await api('automation/stop',{});else{const response=await fetch(BASE+'public/stop',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({id:S.publicSearchId})});if(!response.ok)throw Error('Could not stop the search.');}poll();}catch(error){toast(error.message);}});
 $('#clear-results').addEventListener('click',clearResults);
 $('#work-mode').addEventListener('change',()=>{const country=$('#country').value;if(country&&country!=='worldwide')remember({last_local_country:country});remember({work_mode:$('#work-mode').value,remote:$('#work-mode').value==='remote_only'});S.previewEdited=true;renderCountries();if(!running(S.feed?.run))setSearchStatus('ready');});
 $('#resume').addEventListener('change',event=>{const file=event.target.files[0];if(file)upload(file);event.target.value='';});
 $('#full-auto-toggle')?.addEventListener('change',()=>{if(['controlled_auto','full_auto'].includes(S.profile))chooseProfile('controlled_auto');});
 $('#query').addEventListener('input',renderCV);
 $('#sources-link')?.addEventListener('click',()=>$('#open-settings').click());
 // Drop a CV anywhere on the upload panel, as on tapsubmit.com.
 const drop=$('#resume-button');
 for(const type of ['dragenter','dragover'])drop.addEventListener(type,event=>{event.preventDefault();drop.classList.add('dragover');});
 for(const type of ['dragleave','drop'])drop.addEventListener(type,()=>drop.classList.remove('dragover'));
 drop.addEventListener('drop',event=>{event.preventDefault();const file=event.dataTransfer?.files?.[0];if(file)upload(file);});
 $('#query').addEventListener('keydown',e=>{if(e.key==='Enter'){e.preventDefault();addQueryTag();}});
 $('#country').addEventListener('change',()=>{$('#city-choice').value='';$('#location').value='';remember({country:$('#country').value,location:'',...($('#country').value!=='worldwide'?{last_local_country:$('#country').value}:{})});S.previewEdited=true;updateLocationControls();renderScreeningPreferences();if(!running(S.feed?.run))setSearchStatus('ready');});

 $('#saved-nav').addEventListener('click',()=>{
  if(!requireAuth('Sign in or create an account to view saved jobs.',()=>$('#saved-nav').click()))return;
  $('#lists').hidden=false;
  const tabBtn=document.querySelector('[role=tab][data-tab="saved"]');
  if(tabBtn){tabBtn.click();$('#lists').scrollIntoView({behavior:'smooth'});}
 });
 $('#open-settings').addEventListener('click',async()=>{
  if(!requireAuth('Sign in or create an account to manage settings and connected accounts.',()=>$('#open-settings').click()))return;
  renderSettings();$('#settings').showModal();try{await Promise.all([renderFacts(),renderSaved(),reviewSettings.load(),renderPool()]);}catch(error){toast(error.message);}
 });
 for(const id of ['pool-share','pool-use'])$('#'+id)?.addEventListener('change',async()=>{try{await renderPool(await api('pool',{share:!!$('#pool-share')?.checked,use_pool:!!$('#pool-use')?.checked}));toast($('#pool-share')?.checked&&id==='pool-share'?'Found jobs will be shared after each search (public job details only).':'Saved.');}catch(error){toast(error.message);}});
 $('#pool-download').addEventListener('click',async()=>{try{await renderPool(await api('pool/download',{}));}catch(error){toast(error.message);}});
 $('#settings').addEventListener('change',event=>{if(event.target.closest('#sites')||event.target.closest('#job-languages')||['hours','limit','location','remote','fresh','signed','easy'].includes(event.target.id))saveSearchSettings();});
 $('#save-apply').addEventListener('click',saveApplySettings);$('#save-facts').addEventListener('click',saveFacts);
 $('#history-button').addEventListener('click',history);

 $('#auth-button').addEventListener('click',async()=>{
  if(S.authenticated){
   await api('logout',{});reviewSettings.stop();S.authenticated=false;S.boot=null;S.preferences={};SETTINGS_KEY='applyburst:search';S.queryTags=Array.isArray(stored().query_tags)?stored().query_tags:null;S.savedIds.clear();renderNav();renderCV();renderProfiles();renderScreeningPreferences();toast('Signed out.');
  }else openAuthModal();
 });
 $('#tab-login').addEventListener('click',()=>setAuthTab('login'));
 $('#tab-register').addEventListener('click',()=>setAuthTab('register'));
 $('#auth-form').addEventListener('submit',async event=>{
  event.preventDefault();
  const btn=$('#auth-submit');btn.disabled=true;$('#auth-error').textContent='';
  try{
   const username=$('#auth-username').value.trim(),password=$('#auth-password').value;
   const endpoint=S.authMode==='register'?'register':'login';
   const res=await fetch(BASE+endpoint,{method:'POST',credentials:'same-origin',headers:{'Content-Type':'application/json'},body:JSON.stringify({username,password})});
   const data=await res.json().catch(()=>({}));
   if(!res.ok)throw new Error(data.error||'Authentication failed.');
   $('#auth-dialog').close();$('#auth-form').reset();
   await loadMemberSession();
   const pendingFile=getPendingCVFile();
   if(pendingFile&&!S.boot.profile){try{await uploadCVToServer(pendingFile);renderCV();}catch{}}
   toast(S.authMode==='register'?'Account created.':'Signed in.');
   const action=S.pendingAction;S.pendingAction=null;
   if(action)action();
  }catch(error){$('#auth-error').textContent=error.message;}
  finally{btn.disabled=false;}
 });

 $('#password-form').addEventListener('submit',async event=>{event.preventDefault();const form=event.currentTarget,button=form.querySelector('button');button.disabled=true;$('#password-error').textContent='';try{const fields=new FormData(form);if(fields.get('new_password')!==fields.get('confirm_password'))throw new Error('The new passwords do not match.');await api('account/password',{current_password:fields.get('current_password'),new_password:fields.get('new_password')});form.reset();toast('Password updated.');}catch(error){$('#password-error').textContent=error.message;}finally{button.disabled=false;}});

 $('#live-frame').addEventListener('click',async event=>{
  const img=event.currentTarget,rect=img.getBoundingClientRect();
  if(!rect.width||!rect.height)return;
  const x=Math.round((event.clientX-rect.left)*(Number(img.dataset.w||1100)/rect.width));
  const y=Math.round((event.clientY-rect.top)*(Number(img.dataset.h||820)/rect.height));
  try{await api('browser/input',{kind:'click',x,y});}catch{}
 });
 $('#live-send').addEventListener('click',async()=>{
  const input=$('#live-type'),text=input.value;if(!text)return;
  input.value='';
  try{await api('browser/input',{kind:'type',text});await api('browser/input',{kind:'key',key:'Enter'});}catch(error){toast(error.message);}
 });
 $('#live-done').addEventListener('click',async()=>{try{await api('browser/done',{});}catch{}$('#live-browser').close();});
 $('#live-browser-close').addEventListener('click',async()=>{try{await api('browser/done',{});}catch{}$('#live-browser').close();});

 document.querySelectorAll('[data-close]').forEach(button=>button.addEventListener('click',()=>button.closest('dialog').close()));
 // Reading a column (scrolled up or pointer inside) freezes card moves so nothing jumps under the reader.
 const stream=$('#nodes-stream');stream.addEventListener('scroll',()=>{S.live=streamAtBottom();if(S.live){S.unseen=0;$('#back-live').hidden=true;settle();}},true);
 stream.addEventListener('pointerenter',()=>S.hover=true);stream.addEventListener('pointerleave',()=>{S.hover=false;settle();});
 $('#back-live').addEventListener('click',()=>{S.live=true;toBottom();settle();});
 document.querySelectorAll('[role=tab]').forEach(tab=>tab.addEventListener('click',()=>{S.tab=tab.dataset.tab;document.querySelectorAll('[role=tab]').forEach(t=>t.setAttribute('aria-selected',String(t===tab)));document.querySelectorAll('.tab-panel').forEach(panel=>panel.hidden=panel.id!=='tab-'+S.tab);}));
 document.addEventListener('visibilitychange',()=>{if(!document.hidden)poll();});

 // Optional public metadata does not gate local authentication or workspace readiness.
 fetch(BASE+'public/config',{credentials:'same-origin',signal:AbortSignal.timeout(10000)})
  .then(r=>r.ok?r.json():null).then(config=>{
   if(!config)return;S.publicConfig=config;
   if(!S.authenticated){const country=$('#country').value;renderCountries();if(country)$('#country').value=country;}
  }).catch(()=>{});
 const authResponse=await fetch(BASE+'auth/status',{credentials:'same-origin',signal:AbortSignal.timeout(10000)});
 if(!authResponse.ok)throw new Error('Could not load your session. Reload to retry.');
 const authStatus=await authResponse.json();
 // A local account-data reset also retires browser-held CV/search state, exactly once per reset.
 if(authStatus.client_reset_id)try{
  if(localStorage.getItem('ab_local_reset_id')!==authStatus.client_reset_id){
   for(const key of Object.keys(localStorage))if(['ab_guest_cv_v1','ab_client_cursors_v1','ab_client_feeds_v1'].includes(key)||key.startsWith('applyburst:search'))localStorage.removeItem(key);
   clearPendingCVFile();localStorage.setItem('ab_local_reset_id',authStatus.client_reset_id);
  }
 }catch{}
 S.guestCV=getSavedGuestCV();
 const savedLocation=stored();$('#work-mode').value=savedLocation.work_mode||'';$('#city-choice').value=savedLocation.location||'';
 S.queryTags=Array.isArray(stored().query_tags)?stored().query_tags:null;
 S.registrationOpen=authStatus.registration_open!==false;
 if(authStatus.authenticated)await loadMemberSession();
 else{S.authenticated=false;renderNav();renderCV();renderProfiles();renderCountries();}
 renderReadinessStrip();renderScreeningPreferences();updateLocalLinkedInNodeState();
 document.body.dataset.ready='1';$('main').inert=false;$('main').setAttribute('aria-busy','false');
 probeLocalCompanion().then(comp=>{S.companion=comp;}).catch(()=>{});
 if(S.authenticated)await poll();
}catch(error){document.body.dataset.ready='1';$('main').inert=false;$('main').setAttribute('aria-busy','false');renderNav();fail(error.name==='TimeoutError'?'Your session took too long to load. Reload to retry.':error.message);}
