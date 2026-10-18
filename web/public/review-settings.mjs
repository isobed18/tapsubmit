// Settings only. Questions and drafts belong to individual application cards, never a chat.
export function createReviewSettings({api,toast,onChange=()=>{},onPreferences=()=>{}}){
 const $=id=>document.getElementById(id);let loaded=false,timer=null,epoch=0;
 async function modelStatus(){const data=await api('assistant/llm'),select=$('llm-model'),current=select.value;
  const names=[...new Set([data.model,...data.models.map(m=>m.name)])].filter(Boolean);
  select.replaceChildren(...names.map(name=>{const option=document.createElement('option');option.value=name;option.textContent=name+(data.models.some(m=>m.name===name)?' · installed':' · download needed');return option;}));select.value=loaded&&names.includes(current)?current:data.model;
  if(!loaded)$('llm-enabled').checked=data.enabled;
  $('llm-status').textContent=!data.reachable?'Start Ollama to use optional drafts.':`${data.enabled?'Enabled':'Off'} · CPU only · unloaded after each draft`+(data.download?.running?' · '+data.download.status:'');
  $('llm-install').disabled=!data.reachable||!!data.download?.running;$('llm-progress').hidden=!data.download?.running;$('llm-progress').value=data.download?.percent||0;
  if(data.download?.running&&$('settings').open){clearTimeout(timer);const generation=epoch;timer=setTimeout(()=>{if(generation===epoch&&$('settings').open)modelStatus().catch(()=>{});},1500);}
 }
 async function telegramStatus(data=null){data??=await api('telegram');$('telegram-status').textContent=data.connected?'Connected to @'+data.bot:data.enabled?'Open the pairing link and tap Start.':'Not connected';
  if(!loaded){$('telegram-enabled').checked=data.enabled;$('telegram-notifications').checked=data.notifications!==false;}
  $('telegram-pair').hidden=!data.pair_url;if(data.pair_url)$('telegram-pair').href=data.pair_url;$('telegram-token').placeholder=data.configured?'Token saved locally · leave blank to keep it':'Paste your BotFather token';
 }
 async function load(){loaded=false;const generation=++epoch;const [notes]=await Promise.all([api('assistant/notes'),modelStatus(),telegramStatus()]);if(generation!==epoch)return;$('candidate-notes').value=notes.notes||'';$('preference-message').value=notes.notes||'';loaded=true;}
 $('extract-preferences').addEventListener('click',async()=>{
  const button=$('extract-preferences'),status=$('preference-message-status'),box=$('preference-preview'),generation=epoch;button.disabled=true;box.replaceChildren();status.textContent='Reading this message locally…';
  try{
   const date=new Date(),today=[date.getFullYear(),String(date.getMonth()+1).padStart(2,'0'),String(date.getDate()).padStart(2,'0')].join('-');
   let {draft}=await api('preferences/message',{text:$('preference-message').value,today});
   while(['queued','running'].includes(draft?.state)){if(generation!==epoch)return;status.textContent=draft.state==='queued'?'Queued · you can keep using the app':'Reading this message locally…';await new Promise(resolve=>setTimeout(resolve,1000));({draft}=await api('preferences/message'));}
   if(generation!==epoch)return;if(draft?.state!=='ready')throw Error(draft?.error||'Could not read this message.');
   const preview=draft.preview,dl=document.createElement('dl');
   const pair=(label,value)=>{const dt=document.createElement('dt'),dd=document.createElement('dd');dt.textContent=label;dd.textContent=String(value);dl.append(dt,dd);};
   for(const field of preview.fields)pair(field.label,field.value);
   if(preview.home_location)pair('Current location',preview.home_location);
   if(preview.search.work_mode)pair('Work preference',{remote_only:'Remote only',local_only:'Selected cities only',local_and_remote:'Selected cities + remote',anywhere:'Any location'}[preview.search.work_mode]);
   if(preview.search.location)pair('Preferred cities',preview.search.location);
   if(preview.search.country)pair('Search country',preview.search.country);
   if(preview.search.languages?.length)pair('Languages you can work in',preview.search.languages.map(code=>new Intl.DisplayNames(['en'],{type:'language'}).of(code)).join(', '));
   if(!dl.children.length)pair('Nothing recognised','Try naming your city, work mode, salary with currency, hours or start date.');
   box.append(dl);for(const issue of [...preview.issues,draft.note].filter(Boolean)){const note=document.createElement('p');note.className='fine';note.textContent=issue;box.append(note);}
   const apply=document.createElement('button');apply.type='button';apply.className='secondary small';apply.textContent='Apply these settings';box.append(apply);status.textContent='Review these values. Nothing has been saved yet.'+(draft.method==='rules+model'?' Read with rules and the local model.':'');
   apply.addEventListener('click',async()=>{apply.disabled=true;try{const result=await api('preferences/message',{apply:true,draft_id:draft.id});await onPreferences(result);$('candidate-notes').value=preview.notes;status.textContent='Saved. Applications use these fields and notes.';box.replaceChildren();toast('Application preferences saved.');}catch(error){toast(error.message);apply.disabled=false;}});
  }catch(error){if(generation===epoch)status.textContent=error.message;}
  finally{button.disabled=false;}
 });
 $('llm-save').addEventListener('click',async()=>{try{const result=await api('assistant/llm',{enabled:$('llm-enabled').checked,model:$('llm-model').value});onChange(!!result.enabled);await modelStatus();toast('Saved.');}catch(error){toast(error.message);}});
 $('llm-install').addEventListener('click',async()=>{try{await api('assistant/install',{model:$('llm-model').value});await modelStatus();toast('Downloading.');}catch(error){toast(error.message);}});
 $('save-notes').addEventListener('click',async()=>{try{await api('assistant/notes',{notes:$('candidate-notes').value});toast('Saved. Used by future application drafts.');}catch(error){toast(error.message);}});
 $('telegram-save').addEventListener('click',async()=>{try{const data=await api('telegram',{token:$('telegram-token').value.trim(),enabled:$('telegram-enabled').checked,notifications:$('telegram-notifications').checked});$('telegram-token').value='';await telegramStatus(data);toast('Saved.');}catch(error){toast(error.message);}});
 $('telegram-disconnect').addEventListener('click',async()=>{try{await api('telegram',{disconnect:true});loaded=false;await telegramStatus();loaded=true;toast('Disconnected.');}catch(error){toast(error.message);}});
 return{load,stop(){++epoch;clearTimeout(timer);loaded=false;$('candidate-notes').value='';$('telegram-token').value='';}};
}
