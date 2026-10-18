// Bounded integration experiment. Synthetic candidate + loopback employers only; no real Telegram traffic.
// Start form_fixtures on 8795 and demo_live_run.mjs on 8793 first, then run this script.
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,mkdirSync,readdirSync} from 'node:fs';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {Assistant} from '../web/lib/assistant.mjs';
import {TelegramReview} from '../web/lib/telegram.mjs';
import {createPortal} from '../web/server.mjs';
import {normalizedJob} from '../web/lib/jobs.mjs';
if(process.argv.includes('--scope-only')){
 const app=await createPortal({directory:'.data/question-scope-'+Date.now(),seed:false,automaticRefresh:false,mode:'local',provisionAdmin:true});
 try{const source={id:'synthetic-scope',provider:'lever',board:'scope',kind:'ats'},jobs=['a','b'].map((id,i)=>normalizedJob(source,{external_id:id,title:'Engineer',company:'Synthetic '+id,description:'Synthetic scope probe',location:i?'United States':'Türkiye',apply_url:'https://example.test/jobs/'+id}));app.store.replaceSource(source,jobs,{complete:true});
  const unknown={fingerprint:'a'.repeat(64),label:'Are you authorized to work here?',kind:'select',options:['Yes','No']},known={fingerprint:'b'.repeat(64),label:'How many hours per week can you work?',kind:'number',preference:{id:'weekly_hours'}};
  for(const job of jobs)app.applications.set(job.id,job.apply_url,'needs_answers',{missing:[unknown,known]});
  let q=app.assistant.pendingQuestions();assert.equal(q.length,3);assert.equal(q.filter(x=>x.fingerprint===unknown.fingerprint&&x.job_id).length,2);assert.equal(q.find(x=>x.fingerprint===known.fingerprint).jobs.length,2);
  app.assistant.saveAnswers({answers:[{...known,value:'40'}],retry:false});q=app.assistant.pendingQuestions();assert.equal(q.length,2);
  app.assistant.saveAnswers({answers:[{...unknown,job_id:jobs[0].id,value:'No'}],retry:false});q=app.assistant.pendingQuestions();assert.equal(q.length,1);assert.equal(q[0].job_id,jobs[1].id);assert.equal((app.store.setting('answer_bank')||{})[unknown.fingerprint],undefined);
  const report={date:new Date().toISOString(),synthetic_only:true,passed:5,checks:['unknown-context question is split per application','known weekly-hours preference is grouped across applications','known answer clears equivalent questions','scoped reply leaves the other country waiting','unknown answer never enters the global bank']};mkdirSync('reports',{recursive:true});writeFileSync('reports/local-question-scope.json',JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report,null,2));
 }finally{await app.close();}process.exit(0);
}
const report={at:new Date().toISOString(),synthetic_only:true,checks:[],measurements:{}};
const check=(name,condition)=>{assert.ok(condition,name);report.checks.push(name);};
const settings=new Map(),store={setting(k,v){if(v!==undefined)settings.set(k,JSON.parse(JSON.stringify(v)));return settings.has(k)?JSON.parse(JSON.stringify(settings.get(k))):undefined;}};
let waiting=[{key:'question-a',fingerprint:'a'.repeat(64),label:'Need sponsorship?',kind:'select',options:['Yes','No'],jobs:[{id:'a',title:'Engineer',company:'Example A'},{id:'b',title:'Engineer',company:'Example B'}]}],answers=[],calls=[],remoteShown=false,notes='Synthetic candidate. Backend engineer. Python APIs.';
const assistant=new Assistant({store,pendingQuestions:()=>waiting,saveAnswers:input=>{answers.push(input);waiting=waiting.filter(q=>q.fingerprint!==input.answers[0].fingerprint);return{retrying:['a','b'],queued:true};},candidateNotes:()=>notes,fetchImpl:async(url,opt={})=>{
 const body=opt.body?JSON.parse(opt.body):null;calls.push({path:new URL(url).pathname,body});
 if(url.endsWith('/api/chat'))return Response.json({message:{content:'I build Python APIs and would like to contribute to this role.'}});
 if(url.endsWith('/api/show'))return Response.json(remoteShown?{remote_model:'remote',remote_host:'https://example.invalid'}:{details:{format:'gguf'}});
 if(url.endsWith('/api/pull'))return new Response('{"status":"downloading","total":100,"completed":50}\n{"status":"success"}\n');
 if(url.endsWith('/api/tags'))return Response.json({models:[{name:'synthetic:3b',size:1000}]});return Response.json({models:[]});
}});
assistant.sync();await assistant.handle('Evet','web','wrong-question');check('stale question rejected',answers.length===0);
const tick=performance.now();await assistant.handle('Hayır','web','question-a');report.measurements.exact_turkish_option_ms=+(performance.now()-tick).toFixed(2);
check('Turkish reply maps to exact English option and unblocks shared jobs',answers[0].answers[0].value==='No'&&answers[0].retry);
check('known option does not invoke an LLM',calls.length===0);
waiting=[{key:'essay:c',fingerprint:'c'.repeat(64),job_id:'c',label:'Why this role?',kind:'textarea',options:[],jobs:[{id:'c',title:'Backend Engineer',company:'Example C'}]}];assistant.sync();assistant.setLLM({enabled:true,model:'synthetic:3b'});
await assistant.handle('/draft','web','essay:c');await new Promise(r=>setTimeout(r,20));let draft=assistant.state().draft;
check('draft is held for explicit review',draft?.text&&answers.length===1);
const request=calls.find(c=>c.path==='/api/chat').body;
check('local draft pins CPU and unloads after each request',request.options.num_gpu===0&&request.keep_alive===0&&request.think===false);
check('stateless request excludes previous conversation',request.messages.length===2&&!JSON.stringify(request.messages).includes('Need sponsorship?'));
await assistant.handle('/use','web','essay:c','stale-draft');check('old draft approval rejected',answers.length===1);
notes+=' Updated notes.';await assistant.handle('/use','web','essay:c',draft.id);check('changed candidate notes invalidate a draft',answers.length===1);
await assistant.handle('/draft','web','essay:c');await new Promise(r=>setTimeout(r,20));draft=assistant.state().draft;
await assistant.handle('/use','web','essay:c',draft.id);check('approved essay is saved only for its application',answers[1].answers[0].job_id==='c');
await assistant.installModel('synthetic:3b');await new Promise(r=>setTimeout(r,20));check('download progress completes without loading a model',assistant.download.status==='success'&&assistant.download.percent===100);
waiting=[{key:'remote-check',fingerprint:'e'.repeat(64),job_id:'e',label:'Why this team?',kind:'textarea',options:[],jobs:[{id:'e',title:'Engineer',company:'Example E'}]}];assistant.sync();remoteShown=true;
const chatCount=calls.filter(c=>c.path==='/api/chat').length;await assistant.handle('/draft','web','remote-check');await new Promise(r=>setTimeout(r,20));check('remote Ollama aliases are rejected before candidate notes are transmitted',calls.filter(c=>c.path==='/api/chat').length===chatCount);remoteShown=false;
const telegramCalls=[],telegram=new TelegramReview({store,assistant,fetchImpl:async(url,opt)=>{const body=JSON.parse(opt.body);telegramCalls.push({method:url.split('/').at(-1),body});return Response.json({ok:true,result:{message_id:telegramCalls.length}});}});
waiting=[{key:'telegram-d',fingerprint:'d'.repeat(64),label:'Relocate?',kind:'select',options:['Yes','No'],jobs:[{id:'d',title:'Engineer',company:'Example D'}]}];assistant.sync();
telegram.save({enabled:true,token:'123456:synthetic-not-a-real-token',chat_id:'10',user_id:'20',sent:[],prompts:{},tickets:{},notifications:true});
const before=answers.length;await telegram.receive({message:{chat:{id:10,type:'private'},from:{id:99},text:'Yes',reply_to_message:{message_id:1}}});check('Telegram ignores an unauthorized sender',answers.length===before);
await telegram.deliver({id:'test-question',text:'Relocate?',question:assistant.publicQuestion(assistant.active())});const message=telegramCalls.find(c=>c.method==='sendMessage'),callback=message.body.reply_markup.inline_keyboard[1][0].callback_data;
await telegram.receive({callback_query:{id:'cb-synthetic',from:{id:20},message:{chat:{id:10,type:'private'}},data:callback}});check('paired Telegram option uses the same validated answer path',answers.length===before+1&&answers.at(-1).answers[0].value==='No');
check('Telegram status never returns its token',!JSON.stringify(telegram.status()).includes('synthetic-not-a-real-token'));
telegram.close();assistant.close();

const dir=process.argv[2]||join('.data/demo-live',readdirSync('.data/demo-live').filter(n=>n.startsWith('run-')).sort().at(-1)),origin='http://127.0.0.1:8793',base=origin+'/applyburst/api/';
const credentials=JSON.parse(readFileSync(join(dir,'first-login.json'))),login=await fetch(base+'login',{method:'POST',headers:{Origin:origin,'Content-Type':'application/json'},body:JSON.stringify(credentials)}),cookie=login.headers.get('set-cookie').split(';')[0];
const boot=await(await fetch(base+'bootstrap',{headers:{Cookie:cookie}})).json(),headers={Cookie:cookie,Origin:origin,'X-CSRF-Token':boot.csrf,'Content-Type':'application/json'};
async function get(path){const r=await fetch(base+path,{headers:{Cookie:cookie}});assert.equal(r.status,200);return r.json();}
async function post(path,body){const r=await fetch(base+path,{method:'POST',headers,body:JSON.stringify(body)});return{status:r.status,...await r.json()};}
check('assistant endpoints require local authentication',(await fetch(base+'assistant')).status===401);
check('assistant mutations require CSRF',(await fetch(base+'assistant/message',{method:'POST',headers:{Cookie:cookie,Origin:origin,'Content-Type':'application/json'},body:'{}'})).status===403);
let apps=await get('applications'),ready=apps.applications.find(a=>a.state==='ready_to_submit');assert.ok(ready,'Prepare synthetic jobs in the UI first.');
const submitted=await(await fetch('http://127.0.0.1:8795/__submissions')).json();
const start=performance.now(),result=await post('applications/submit-one',{id:ready.job_id});report.measurements.tap_submit_ms=Math.round(performance.now()-start);
check('tap submit reaches confirmed employer receipt',result.state==='confirmed');
const again=await post('applications/submit-one',{id:ready.job_id});check('repeat submit is rejected',again.status===409);
const receipts=await(await fetch('http://127.0.0.1:8795/__submissions')).json();
report.measurements.receiver_before=submitted.accepted.length;report.measurements.receiver_after=receipts.accepted.length;
check('single tap creates exactly one accepted receiver submission',receipts.accepted.length===submitted.accepted.length+1);
const received=receipts.accepted.at(-1),resumeHash=createHash('sha256').update(readFileSync(join(dir,'resume.txt'))).digest('hex');
check('receiver gets the synthetic candidate identity exactly',received.fields.email==='deniz@example.test'&&received.fields.name==='Deniz Example');
check('receiver gets the original resume bytes',Object.values(received.files).some(file=>file.sha256===resumeHash));
report.measurements.rejected_receiver_submissions=receipts.rejected.length;
report.measurements.applications=(await get('applications')).applications.reduce((o,a)=>(o[a.state]=(o[a.state]||0)+1,o),{});
check('model status endpoint is local and does not generate',(await get('assistant/llm')).processor==='CPU only');
const localState=await get('assistant');report.measurements.pending_questions=localState.pending;
mkdirSync('reports',{recursive:true});writeFileSync('reports/local-assistant-flow.json',JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report,null,2));
