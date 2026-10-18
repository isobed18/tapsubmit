// UI only; all private state and background work live in the authenticated loopback service.
export function createAssistantUI({api,toast,onChange}){
 const $=id=>document.getElementById(id),make=(tag,cls,text)=>{const e=document.createElement(tag);if(cls)e.className=cls;if(text)e.textContent=text;return e;};
 let active=false,timer=null,current=null,messageKey='',questionKey='',epoch=0,sending=false,settingsLoaded=false;
 function render(data){
  current=data;$('assistant-count').textContent=data.pending?`${data.pending} question(s) waiting`:'No questions waiting';
  const log=$('assistant-messages'),key=data.messages.map(m=>m.id).join('|');if(key!==messageKey){const bottom=log.scrollHeight-log.scrollTop-log.clientHeight<50;log.replaceChildren(...data.messages.slice(-50).map(m=>{const e=make('p','assistant-message '+(m.role==='user'?'from-user':'from-assistant'),m.text);return e;}));if(bottom)log.scrollTop=log.scrollHeight;messageKey=key;}
  const q=data.question;$('assistant-question').hidden=!q;$('assistant-question').textContent=q?`${q.label} · ${q.scope}`:'';
  const next=q?.key||'';if(next!==questionKey){$('assistant-input').value='';questionKey=next;}
  $('assistant-input').disabled=!q||sending;$('assistant-send').disabled=!q||sending;
  $('assistant-options').replaceChildren();for(const option of q?.options||[]){const b=make('button','secondary small',String(option));b.type='button';b.disabled=sending;b.addEventListener('click',()=>send(option,q.key));$('assistant-options').append(b);}
  $('assistant-draft').hidden=!q?.can_draft;$('assistant-draft').disabled=!!data.drafting;
  $('assistant-use').hidden=!data.draft||data.draft.questionId!==q?.key;$('assistant-skip').hidden=!q;
  $('assistant-resume').hidden=!data.skipped;$('assistant-status').textContent=data.drafting?'Drafting locally on CPU…':'';
 }
 async function refresh(){if(!active)return;const generation=epoch;try{const data=await api('assistant');if(active&&epoch===generation)render(data);}catch(e){if(active)$('assistant-status').textContent=e.message;}}
 async function send(text,id=current?.question?.key){if(sending)return;sending=true;const generation=epoch;$('assistant-send').disabled=true;
  try{const data=await api('assistant/message',{text,question_id:id||null,draft_id:current?.draft?.id||null});if(active&&epoch===generation){$('assistant-input').value='';render(data);onChange();}}
  catch(e){toast(e.message);}finally{sending=false;if(active&&epoch===generation&&current)render(current);}
 }
 async function modelStatus(){const data=await api('assistant/llm'),select=$('llm-model');
  const names=[...new Set(['qwen2.5:3b',data.model,...data.models.map(m=>m.name)])].filter(Boolean),selected=select.value;
  select.replaceChildren(...names.map(name=>{const o=make('option','',name+(data.models.some(m=>m.name===name)?' · installed':' · download needed'));o.value=name;return o;}));select.value=settingsLoaded&&names.includes(selected)?selected:data.model;
  if(!settingsLoaded)$('llm-enabled').checked=data.enabled;
  const installed=data.models.some(m=>m.name===data.model),gpu=data.loaded?.gpu_bytes>0;
  $('llm-status').textContent=!data.reachable?'Ollama is not running. Install or start it to use optional drafts.':`${data.enabled?'Enabled':'Off'} · ${installed?'model installed':'model not downloaded'} · ${data.loaded?'loaded':'not loaded'} · TapSubmit uses CPU only`+(gpu?' · another request has a model loaded on GPU':'')+(data.download?' · '+(data.download.error||data.download.status):'');
  $('llm-install').disabled=!data.reachable||!!data.download?.running;$('llm-progress').hidden=!data.download?.running;$('llm-progress').value=data.download?.percent||0;
 }
 async function telegramStatus(data=null){data??=await api('telegram');$('telegram-status').textContent=(data.connected?'Connected to @'+data.bot:data.enabled?'Open the pairing link, then tap Start in Telegram.':'Not connected')+(data.last_error?' · '+data.last_error:'');
  if(!settingsLoaded){$('telegram-enabled').checked=data.enabled;$('telegram-notifications').checked=data.notifications!==false;}
  $('telegram-pair').hidden=!data.pair_url;if(data.pair_url)$('telegram-pair').href=data.pair_url;$('telegram-token').placeholder=data.configured?'Token saved locally · leave blank to keep it':'Paste your BotFather token';
 }
 async function settings(){if(!active)return;try{const [notes]=await Promise.all([api('assistant/notes'),modelStatus(),telegramStatus()]);if(!settingsLoaded)$('candidate-notes').value=notes.notes||'';settingsLoaded=true;}catch(e){toast(e.message);}}
 async function tick(){clearTimeout(timer);if(!active)return;await refresh();if($('settings').open){try{await Promise.all([modelStatus(),telegramStatus()]);}catch{}}if(active)timer=setTimeout(tick,document.hidden?10000:2500);}
 $('assistant-form').addEventListener('submit',e=>{e.preventDefault();const text=$('assistant-input').value.trim();if(text)send(text);});
 for(const [id,cmd]of [['assistant-draft','/draft'],['assistant-use','/use'],['assistant-skip','/skip'],['assistant-resume','/resume']])$(id).addEventListener('click',()=>send(cmd));
 $('llm-save').addEventListener('click',async()=>{try{await api('assistant/llm',{enabled:$('llm-enabled').checked,model:$('llm-model').value});await modelStatus();toast('Local model settings saved.');}catch(e){toast(e.message);}});
 $('llm-install').addEventListener('click',async()=>{try{await api('assistant/install',{model:$('llm-model').value});await modelStatus();toast('Downloading locally. You can keep using the app.');}catch(e){toast(e.message);}});
 $('save-notes').addEventListener('click',async()=>{try{await api('assistant/notes',{notes:$('candidate-notes').value});toast('Candidate notes saved locally.');}catch(e){toast(e.message);}});
 $('telegram-save').addEventListener('click',async()=>{try{const data=await api('telegram',{token:$('telegram-token').value.trim(),enabled:$('telegram-enabled').checked,notifications:$('telegram-notifications').checked});$('telegram-token').value='';await telegramStatus(data);toast('Telegram settings saved.');}catch(e){toast(e.message);}});
 $('telegram-disconnect').addEventListener('click',async()=>{try{await api('telegram',{disconnect:true});$('telegram-enabled').checked=false;await telegramStatus();toast('Telegram disconnected.');}catch(e){toast(e.message);}});
 return{start(){if(active)return;active=true;epoch++;$('assistant-panel').hidden=false;tick();},stop(){active=false;epoch++;clearTimeout(timer);$('assistant-panel').hidden=true;current=null;messageKey='';questionKey='';settingsLoaded=false;$('assistant-messages').replaceChildren();$('candidate-notes').value='';$('telegram-token').value='';},settings,refresh};
}
