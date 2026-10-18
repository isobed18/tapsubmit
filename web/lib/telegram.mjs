// Opt-in, locally polled Telegram bridge. No webhooks, tunnels or CV uploads. Token stays in local SQLite.
import {randomBytes} from 'node:crypto';
export class TelegramReview{
 constructor({store,assistant,fetchImpl=fetch,apiRoot='https://api.telegram.org'}){Object.assign(this,{store,assistant,fetch:fetchImpl,apiRoot});this.closed=false;this.generation=0;this.controller=null;this.timer=null;this.outgoing=Promise.resolve();this.lastError=null;this.unsubscribe=assistant.onMessage(m=>{this.outgoing=this.outgoing.then(()=>this.deliver(m)).catch(()=>{this.lastError='Could not deliver a Telegram message. Check the connection.';});});}
 settings(){return{enabled:false,token:'',chat_id:null,user_id:null,username:'',offset:0,tickets:{},prompts:{},sent:[],notifications:true,...(this.store.setting('telegram_local')||{})};}
 save(s){this.store.setting('telegram_local',s);}
 status(){const s=this.settings();return{enabled:s.enabled,configured:!!s.token,connected:!!s.chat_id,bot:s.username||null,notifications:s.notifications,last_error:this.lastError,pair_url:s.enabled&&!s.chat_id&&s.pair_expires>Date.now()&&s.username?`https://t.me/${s.username}?start=${s.pair_code}`:null};}
 async call(method,body={},signal=null){
  const s=this.settings();if(!s.token)throw Error('Add your bot token first.');
  let r;try{r=await this.fetch(`${this.apiRoot}/bot${s.token}/${method}`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body),signal:signal||AbortSignal.timeout(10000)});}catch{throw Error('Telegram is unavailable.');}
  const data=await r.json().catch(()=>({}));if(!r.ok||!data.ok){const e=Error(data.error_code===409?'This bot is already used by another poller or webhook. Use a dedicated bot.':'Telegram rejected the request. Check the token and connection.');e.retryAfter=Number(data.parameters?.retry_after)||0;throw e;}return data.result;
 }
 async configure(input){
  const before=this.settings(),next={...before};
  if(input.disconnect===true){this.stop();this.save({enabled:false,token:'',chat_id:null,user_id:null});return this.status();}
  if(input.token){if(!/^\d{5,15}:[A-Za-z0-9_-]{20,100}$/.test(input.token))throw Error('Enter a valid BotFather token.');next.token=input.token;if(next.token!==before.token)Object.assign(next,{chat_id:null,user_id:null,offset:0,tickets:{},prompts:{},sent:[]});}
  if('notifications'in input)next.notifications=input.notifications===true;
  if('enabled'in input)next.enabled=input.enabled===true;
  if(next.enabled&&!next.token)throw Error('Create a bot with @BotFather, then paste its token here.');
  this.stop();this.save(next);
  try{if(next.enabled){const bot=await this.call('getMe');if(!bot.is_bot)throw Error('Use a bot token.');next.username=bot.username;
    if(!next.chat_id)Object.assign(next,{pair_code:randomBytes(20).toString('hex'),pair_expires:Date.now()+10*60*1000});this.save(next);this.start();}}
  catch(e){this.save(before);if(before.enabled)this.start();throw e;}
  return this.status();
 }
 start(){if(this.closed||!this.settings().enabled)return;const generation=++this.generation;this.schedule(generation,0);}
 stop(){++this.generation;clearTimeout(this.timer);this.controller?.abort();this.controller=null;}
 schedule(generation,delay){if(this.closed||generation!==this.generation)return;this.timer=setTimeout(()=>this.poll(generation),delay);this.timer.unref();}
 async poll(generation){
  const s=this.settings();if(!s.enabled||this.closed||generation!==this.generation)return;this.controller=new AbortController();let delay=100;
  try{const updates=await this.call('getUpdates',{offset:s.offset,timeout:20,allowed_updates:['message','callback_query']},AbortSignal.any([this.controller.signal,AbortSignal.timeout(25000)]));
   for(const update of updates){if(generation!==this.generation)return;const latest=this.settings();if(update.update_id<latest.offset)continue;
    await this.receive(update);const current=this.settings();current.offset=update.update_id+1;this.save(current);}
   this.lastError=null;
  }catch(e){if(generation!==this.generation||this.closed)return;this.lastError=e.message;delay=Math.max(5000,Math.min(60000,(e.retryAfter||0)*1000));}
  finally{this.controller=null;this.schedule(generation,delay);}
 }
 async send(text,markup=null){const s=this.settings();if(!s.enabled||!s.chat_id)return null;return this.call('sendMessage',{chat_id:s.chat_id,text:String(text).slice(0,4000),...(markup?{reply_markup:markup}:{}),link_preview_options:{is_disabled:true}});}
 async deliver(message){
  let s=this.settings();if(this.closed||!s.enabled||!s.chat_id||s.sent.includes(message.id))return;
  const q=message.question||this.assistant.publicQuestion(this.assistant.active());let markup=null,ticket=null;
  if(q&&(message.question||message.draft)){
   ticket=randomBytes(8).toString('hex');s.tickets[ticket]={key:q.key,options:q.options||[],draftId:message.draftId||null,at:Date.now()};s.tickets=Object.fromEntries(Object.entries(s.tickets).slice(-40));this.save(s);
   const rows=(message.question?(q.options||[]).slice(0,8).map((o,i)=>[{text:String(o).slice(0,55),callback_data:`ts:${ticket}:${i}`} ]):[]);
   rows.push(message.draft?[{text:'Approve answer',callback_data:`ts:${ticket}:use`}]:[{text:'Skip for now',callback_data:`ts:${ticket}:skip`},...(q.can_draft?[{text:'Draft locally',callback_data:`ts:${ticket}:draft`}]:[])]);markup={inline_keyboard:rows};
  }
  const sent=await this.send(message.text+(message.question?'\n\nReply to this message to answer.':''),markup);if(!sent)return;
  s=this.settings();s.sent=[...s.sent,message.id].slice(-150);if(q&&(message.question||message.draft)){s.prompts[sent.message_id]=q.key;s.prompts=Object.fromEntries(Object.entries(s.prompts).slice(-60));if(message.draftId){s.draft_prompts={...(s.draft_prompts||{}),[sent.message_id]:message.draftId};s.draft_prompts=Object.fromEntries(Object.entries(s.draft_prompts).slice(-60));}}this.save(s);
 }
 async receive(update){
  let s=this.settings();const m=update.message,c=update.callback_query;
  if(m){if(m.chat?.type!=='private'||m.from?.is_bot)return;
   if(!s.chat_id){if(m.text!==`/start ${s.pair_code}`||!s.pair_code||Date.now()>s.pair_expires)return;
    Object.assign(s,{chat_id:String(m.chat.id),user_id:String(m.from.id),pair_code:null,pair_expires:null});this.save(s);await this.send('TapSubmit connected. Only replies from this private chat are accepted. Questions and drafts may leave this computer via Telegram.');
    this.assistant.sync();const active=this.assistant.active();if(active)await this.deliver({id:'pair-'+Date.now(),text:active.label,question:this.assistant.publicQuestion(active)});return;
   }
   if(String(m.chat.id)!==String(s.chat_id)||String(m.from.id)!==String(s.user_id)||typeof m.text!=='string')return;
   if(['/status','/resume'].includes(m.text.trim())){await this.assistant.handle(m.text,'telegram',null);return;}
   const key=s.prompts[m.reply_to_message?.message_id];if(!key){await this.send('Reply to the question message, or tap one of its buttons. This prevents answering a different question by accident.');return;}
   const draftId=m.reply_to_message?.message_id?this.settings().draft_prompts?.[m.reply_to_message.message_id]:null;await this.assistant.handle(m.text,'telegram',key,draftId);return;
  }
  if(c){if(String(c.from?.id)!==String(s.user_id)||String(c.message?.chat?.id)!==String(s.chat_id)||c.message?.chat?.type!=='private')return;
   const match=String(c.data||'').match(/^ts:([a-f0-9]{16}):(\d+|skip|draft|use)$/),ticket=match&&s.tickets[match[1]];
   await this.call('answerCallbackQuery',{callback_query_id:c.id,text:ticket?'Received':'This question has expired'});if(!ticket||Date.now()-ticket.at>86400000)return;
   const value=/^\d+$/.test(match[2])?ticket.options[Number(match[2])]:'/'+match[2];if(value!==undefined)await this.assistant.handle(value,'telegram',ticket.key,ticket.draftId);
  }
 }
 async notifyApplication(event,job){if(event.state!=='confirmed'||!this.settings().notifications)return;this.outgoing=this.outgoing.then(()=>this.send(`Applied ✓\n${job?.title||'Application'} · ${job?.company||''}`)).catch(()=>{});}
 close(){this.closed=true;this.stop();this.unsubscribe();}
}
