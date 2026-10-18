"""Loopback fixtures shaped like real application families (structure observed read-only on
public Greenhouse, Lever and Ashby pages; LinkedIn Easy Apply modelled on its accessible names).

They exercise the production companion, including failure paths. This is NOT an employer:
submissions land in memory and are inspected by tests. Synthetic data only.
"""
import hashlib
import html
import json

from fastapi import FastAPI, Request
from fastapi.responses import HTMLResponse, JSONResponse, RedirectResponse, Response

STYLE = '''<style>body{font:15px system-ui;max-width:760px;margin:24px auto;padding:0 12px}label,legend{display:block;margin:10px 0 4px}
input,select,textarea{display:block;width:95%;padding:7px;margin-bottom:6px}.visually-hidden{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0)}
.select__menu{border:1px solid #999;background:#fff}.select__option{padding:6px;cursor:pointer}.select__single-value{min-height:18px;color:#124}
[role=dialog]{border:2px solid #333;padding:14px;margin:14px 0;background:#fafafa}.error,.error-message,[role=alert]{color:#a00}button{padding:8px 14px;margin:6px 4px 6px 0}
.hidden-input{opacity:0;position:absolute;width:1px;height:1px}</style>'''

COMMON_JS = r'''
function esc(s){return String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));}
function combo(id,label,options,o={}){return `<div class="select"><label id="${id}-label" for="${id}" class="label select__label">${esc(label)}${o.required?'<span aria-hidden="true">*</span>':''}</label>
 <div class="select__control"><div class="select__single-value" id="${id}-value"></div><input class="select__input" id="${id}" role="combobox" aria-labelledby="${id}-label" aria-required="${!!o.required}" aria-expanded="false" autocomplete="off" data-options='${esc(JSON.stringify(options))}' ${o.search?'data-search="1"':''}>
 <input class="requiredInput hidden-input" ${o.required?'required':''} tabindex="-1" value="" data-for="${id}"></div><div class="select__menu" id="${id}-menu" role="listbox" hidden></div></div>`;}
const SEARCH=['Ankara, Ankara, Turkey','Ankara, Iowa, United States','Istanbul, Istanbul, Turkey','Izmir, Izmir, Turkey'];
function comboRender(input){const menu=document.getElementById(input.id+'-menu'),typed=input.value.trim().toLowerCase();
 let opts=input.dataset.search?(typed.length>=2?SEARCH.filter(x=>x.toLowerCase().startsWith(typed)):[]):JSON.parse(input.dataset.options).filter(x=>!typed||x.toLowerCase().includes(typed));
 menu.innerHTML=opts.map((x,i)=>`<div role="option" class="select__option" id="${input.id}-option-${i}">${esc(x)}</div>`).join('');menu.hidden=!opts.length;input.setAttribute('aria-expanded',String(!menu.hidden));
 if(!menu.hidden)input.setAttribute('aria-controls',menu.id);}
function comboWire(root){for(const input of root.querySelectorAll('input[role=combobox]')){const menu=document.getElementById(input.id+'-menu');
 input.addEventListener('focus',()=>setTimeout(()=>comboRender(input),60));input.addEventListener('click',()=>setTimeout(()=>comboRender(input),60));
 input.addEventListener('input',()=>setTimeout(()=>comboRender(input),input.dataset.search?180:40));
 input.addEventListener('keydown',e=>{if(e.key==='Escape'){menu.hidden=true;input.setAttribute('aria-expanded','false');}});
 menu.addEventListener('mousedown',e=>{const opt=e.target.closest('[role=option]');if(!opt)return;e.preventDefault();input.dataset.selected=opt.textContent;
  document.getElementById(input.id+'-value').textContent=opt.textContent;input.value='';menu.hidden=true;input.setAttribute('aria-expanded','false');
  const hidden=root.querySelector(`[data-for="${input.id}"]`);if(hidden)hidden.value=opt.textContent;input.dispatchEvent(new CustomEvent('chosen',{bubbles:true,detail:opt.textContent}));});}}
function fieldError(el,msg){const box=el.closest('.field-wrapper,.fb-dash-form-element,.ashby-application-form-field-entry,fieldset')||el.parentElement;
 if(!box.querySelector('.error')){const d=document.createElement('div');d.className='error';d.setAttribute('role','alert');d.id=(el.id||'x')+'-error';d.textContent=msg;box.appendChild(d);}el.setAttribute('aria-invalid','true');}
'''

# German employer form with neutral ids and no autocomplete hints: labels, buttons and the
# in-place thank-you message can only be understood by meaning (language-independent path).
GREENHOUSE_DE_JS = r'''
setTimeout(()=>{
 const field=(id,label,req,type='text')=>`<div class="field-wrapper"><label for="${id}">${esc(label)}${req?'<span class="required">*</span>':''}</label><input id="${id}" type="${type}" class="input" aria-required="${req}"></div>`;
 document.getElementById('app').innerHTML=`<form id="application-form" class="application--form" novalidate>
 ${field('f1','Vorname',true)}${field('f2','Nachname',true)}${field('f3','E-Mail-Adresse',true)}${field('f4','Telefonnummer',true,'tel')}
 <div class="field-wrapper"><div role="group" aria-labelledby="upload-label-f5" aria-required="true" class="file-upload"><div id="upload-label-f5" class="label upload-label">Lebenslauf<span class="required">*</span></div>
 <button type="button" onclick="document.getElementById('f5').click()">Datei anhängen</button><input id="f5" class="visually-hidden" type="file"></div></div>
 ${field('f6','LinkedIn-Profil',false)}
 <div class="field-wrapper"><label for="f7">Warum möchten Sie bei uns arbeiten?<span class="required">*</span></label><textarea id="f7" aria-required="true"></textarea></div>
 <div class="application--submit"><button type="submit" class="btn">Bewerbung absenden</button></div></form>`;
 const form=document.getElementById('application-form');
 form.addEventListener('submit',async e=>{e.preventDefault();form.querySelectorAll('.error').forEach(n=>n.remove());let bad=false;
  for(const el of form.querySelectorAll('[aria-required=true]')){if(el.matches('[role=group]')){if(!document.getElementById('f5').files.length){bad=true;fieldError(document.getElementById('f5'),'Dieses Feld ist erforderlich.');}continue;}if(!el.value){bad=true;fieldError(el,'Dieses Feld ist erforderlich.');}}
  if(bad)return;const data=new FormData();for(const el of form.querySelectorAll('input,textarea')){if(!el.id)continue;if(el.type==='file'){if(el.files[0])data.set(el.id,el.files[0]);}else if(el.value)data.set(el.id,el.value);}
  const r=await fetch(location.pathname.replace(/\/$/,'')+'/submit',{method:'POST',body:data});
  if(!r.ok){const b=document.createElement('div');b.className='error-banner';b.setAttribute('role','alert');b.textContent='Beim Senden ist ein Fehler aufgetreten.';form.prepend(b);return;}
  // No URL change and no English text: the outcome is only this new message.
  document.getElementById('app').innerHTML='<div class="application--success"><h2>Vielen Dank! Ihre Bewerbung ist bei uns eingegangen.</h2><p>Wir melden uns in Kürze.</p></div>';});
},250);
'''

GREENHOUSE_JS = r'''
const COUNTRIES=['Germany +49','Turkey +90','United Kingdom +44','United States +1'];
function text(id,label,req,auto){return `<div class="field-wrapper"><label for="${id}" id="${id}-label">${esc(label)}${req?'<span class="required">*</span>':''}</label><input id="${id}" class="input" aria-required="${req}" ${auto?`autocomplete="${auto}"`:''}></div>`;}
function area(id,label,req){return `<label for="${id}">${esc(label)}${req?'<span class="required">*</span>':''}</label><textarea id="${id}" aria-required="${req}"></textarea>`;}
setTimeout(()=>{
 const unknown=SCENARIO==='unknown_required'?`<div class="field-wrapper">${area('question_9','Why do you want to work here?',true)}</div>`:'';
 document.getElementById('app').innerHTML=`<form id="application-form" class="application--form" novalidate>
 ${text('first_name','First Name',true,'given-name')}${text('last_name','Last Name',true,'family-name')}${text('email','Email',true,'email')}
 <fieldset class="phone-input"><legend class="visually-hidden">Phone</legend><div class="field-wrapper">${combo('country','Country',COUNTRIES,{required:true})}</div>
 <div class="field-wrapper"><label for="phone">Phone<span class="required">*</span></label><input id="phone" type="tel" aria-required="true"></div></fieldset>
 <div class="field-wrapper"><div role="group" aria-labelledby="upload-label-resume" aria-required="true" class="file-upload"><div id="upload-label-resume" class="label upload-label">Resume/CV<span class="required">*</span></div>
 <button type="button" onclick="document.getElementById('resume').click()">Attach</button><label class="visually-hidden" for="resume">Attach</label><input id="resume" class="visually-hidden" type="file"></div></div>
 ${text('question_1','LinkedIn Profile',false)}
 <div class="field-wrapper">${combo('question_2','Will you now or in the future require visa sponsorship?',['Yes','No'],{required:true})}</div>
 <div class="field-wrapper" id="conditional" hidden>${area('question_3','Please describe your sponsorship needs',true)}</div>${unknown}
 <div class="field-wrapper">${combo('location','Location (City)',[],{search:true})}</div>
 <div class="eeoc__question__wrapper field-wrapper">${combo('gender','Gender',['Female','Male','Decline to self-identify'],{})}</div>
 <div class="application--submit"><button type="submit" class="btn">Submit application</button></div></form>`;
 const form=document.getElementById('application-form');comboWire(form);
 form.addEventListener('chosen',e=>{if(e.target.id==='question_2')document.getElementById('conditional').hidden=e.detail!=='Yes';});
 form.addEventListener('submit',async e=>{e.preventDefault();form.querySelectorAll('.error').forEach(n=>n.remove());let bad=false;
  for(const el of form.querySelectorAll('[aria-required=true]')){if(el.closest('[hidden]'))continue;const v=el.getAttribute('role')==='combobox'?el.dataset.selected:el.type==='file'?el.files.length:el.value;
   if(el.matches('[role=group]')){if(!document.getElementById('resume').files.length){bad=true;fieldError(document.getElementById('resume'),'This field is required.');}continue;}if(!v){bad=true;fieldError(el,'This field is required.');}}
  if(bad)return;const data=new FormData();for(const el of form.querySelectorAll('input,textarea')){if(!el.id||el.closest('[hidden]'))continue;
   if(el.getAttribute('role')==='combobox'){if(el.dataset.selected)data.set(el.id,el.dataset.selected);}else if(el.type==='file'){if(el.files[0])data.set(el.id,el.files[0]);}else if(el.value)data.set(el.id,el.value);}
  const r=await fetch(location.pathname.replace(/\/$/,'')+'/submit',{method:'POST',body:data});
  if(!r.ok){const b=document.createElement('div');b.className='error-banner';b.setAttribute('role','alert');b.textContent='There was a problem submitting your application. Please try again.';form.prepend(b);return;}
  if(SCENARIO==='no_confirmation'||SCENARIO==='preexisting_thanks')return;location.href=location.pathname.replace(/\/$/,'')+'/confirmation'+location.search;});
},SCENARIO==='slow_prepare'?16000:250);
'''

ASHBY_JS = r'''
setTimeout(()=>{const root=document.getElementById('root');
 const entry=(id,label,req,input)=>`<div class="ashby-application-form-field-entry"><label class="ashby-application-form-question-title ${req?'_required_x1':''}" for="${id}">${esc(label)}</label>${input}</div>`;
 root.innerHTML=`<div class="ashby-application-form-container"><div class="ashby-application-form-autofill-input-root"><p>Autofill from resume</p><input type="file" class="hidden-input"><button type="button">Upload file</button></div>
 ${entry('_systemfield_name','Name',true,'<input id="_systemfield_name" name="_systemfield_name" required placeholder="Type here...">')}
 ${entry('_systemfield_email','Email',true,'<input id="_systemfield_email" name="_systemfield_email" type="email" required placeholder="hello@example.com...">')}
 ${entry('_systemfield_resume','Resume',true,'<input id="_systemfield_resume" type="file" class="hidden-input"><button type="button">Upload File</button>')}
 <div class="ashby-application-form-field-entry"><label class="ashby-application-form-question-title" for="_systemfield_location">Location</label>${combo('loc','',[],{search:true}).replace('<label id="loc-label" for="loc" class="label select__label"></label>','')}</div>
 <div class="ashby-application-form-field-entry"><label class="ashby-application-form-question-title _required_x1" for="q1">Will you now or in the future require sponsorship to work in Turkey?</label>
  <div class="ashby-application-form-input-yesno"><button type="button" aria-pressed="false" data-option="yes">Yes</button><button type="button" aria-pressed="false" data-option="no">No</button><input type="checkbox" name="q1" tabindex="-1" class="hidden-input"></div></div>
 ${entry('gh','GitHub Link (if applicable)',false,'<input id="gh" name="gh" placeholder="Type here...">')}
 ${entry('li','Linkedin Profile Link',false,'<input id="li" name="li" placeholder="Type here...">')}
 <button type="button" class="ashby-application-form-submit-button">Submit Application</button></div>`;
 comboWire(root);
 root.querySelector('#loc').removeAttribute('aria-labelledby');
 for(const b of root.querySelectorAll('.ashby-application-form-input-yesno button'))b.addEventListener('click',()=>{const box=b.parentElement;
  for(const o of box.querySelectorAll('button'))o.setAttribute('aria-pressed',String(o===b));box.querySelector('input').checked=b.dataset.option==='yes';box.dataset.answer=b.textContent;});
 root.querySelector('.ashby-application-form-submit-button').addEventListener('click',async()=>{root.querySelectorAll('.error').forEach(n=>n.remove());let bad=false;
  for(const el of root.querySelectorAll('[required]'))if(!el.value){bad=true;fieldError(el,'This field is required.');}
  if(!root.querySelector('#_systemfield_resume').files.length){bad=true;fieldError(root.querySelector('#_systemfield_resume'),'This field is required.');}
  const yn=root.querySelector('.ashby-application-form-input-yesno');if(!yn.dataset.answer){bad=true;fieldError(yn,'This field is required.');}if(bad)return;
  const d=new FormData();for(const id of ['_systemfield_name','_systemfield_email','gh','li'])if(root.querySelector('#'+id).value)d.set(id,root.querySelector('#'+id).value);
  d.set('resume',root.querySelector('#_systemfield_resume').files[0]);d.set('sponsorship',yn.dataset.answer);if(root.querySelector('#loc').dataset.selected)d.set('location',root.querySelector('#loc').dataset.selected);
  const r=await fetch(location.pathname.replace(/\/$/,'')+'/submit',{method:'POST',body:d}),j=await r.json();
  if(!r.ok){const f=document.createElement('div');f.className='ashby-application-form-failure';f.setAttribute('role','alert');f.textContent=j.error;root.querySelector('.ashby-application-form-container').prepend(f);return;}
  root.innerHTML='<div class="ashby-application-form-success-container"><h2>Thank you for applying</h2><p>Your application was successfully submitted.</p></div>';});
},300);
'''

LINKEDIN_JS = r'''
const state={email:'account@example.test',cc:'us',phone:'',resume:SCENARIO==='no_resume'?'':'old_resume.pdf',file:null,years:'',auth:'',english:'',explain:'',follow:true};let step=0,busy=false;
const req='<span class="fb-dash-form-element__label-title--is-required" aria-hidden="true">*</span>';
const STEPS=[()=>`<h3>Contact info</h3><div class="fb-dash-form-element" data-test-form-element><label for="ea-email">Email address${req}</label><select id="ea-email" required aria-required="true"><option value="">Select an option</option>
 ${['account@example.test','candidate@example.test'].map(x=>`<option value="${x}" ${state.email===x?'selected':''}>${x}</option>`).join('')}</select></div>
 <div class="fb-dash-form-element" data-test-form-element><label for="ea-cc">Phone country code${req}</label><select id="ea-cc" required aria-required="true"><option value="">Select an option</option>
 ${[['us','United States (+1)'],['tr','Turkey (+90)'],['de','Germany (+49)']].map(([v,l])=>`<option value="${v}" ${state.cc===v?'selected':''}>${l}</option>`).join('')}</select></div>
 <div class="fb-dash-form-element" data-test-form-element><label for="ea-phone">Mobile phone number${req}</label><input id="ea-phone" class="artdeco-text-input--input" type="text" required aria-required="true" value="${esc(state.phone)}"></div>`,
 ()=>`<h3>Resume</h3><div class="jobs-document-upload-redesign-card__container" data-test-form-element>${state.resume?`<h3 class="jobs-document-upload-redesign-card__file-name" data-test-document-name>${esc(state.resume)}</h3>`:''}
 <label for="ea-upload">Upload resume</label><input id="ea-upload" name="file" type="file" class="hidden-input" ${state.resume?'':'required aria-required="true"'}></div>`,
 ()=>`<h3>Additional Questions</h3><div class="fb-dash-form-element" data-test-form-element><label for="ea-years">How many years of work experience do you have with Python?${req}</label><input id="ea-years" type="text" required aria-required="true" value="${esc(state.years)}"></div>
 <fieldset data-test-form-builder-radio-button-form-component="true"><legend><span data-test-form-builder-radio-button-form-component__title>Are you legally authorized to work in Türkiye?${req}</span></legend>
 ${['Yes','No'].map(v=>`<div><input type="radio" id="ea-auth-${v}" name="ea-auth" value="${v}" required class="hidden-input" ${state.auth===v?'checked':''}><label for="ea-auth-${v}" data-test-text-selectable-option__label>${v}</label></div>`).join('')}</fieldset>
 <div class="fb-dash-form-element" data-test-form-element id="ea-explain-wrap" ${SCENARIO==='conditional'&&state.auth==='No'?'':'hidden'}><label for="ea-explain">Please explain your work authorization status${req}</label><textarea id="ea-explain" required>${esc(state.explain)}</textarea></div>
 <div class="fb-dash-form-element" data-test-form-element><label for="ea-english">What is your level of proficiency in English?${req}</label><select id="ea-english" required aria-required="true"><option value="">Select an option</option>
 ${['None','Conversational','Professional','Native or bilingual'].map(v=>`<option ${state.english===v?'selected':''}>${v}</option>`).join('')}</select></div>`,
 ()=>`<h3>Review your application</h3><p>The employer will also receive a copy of your profile.</p><div><input type="checkbox" id="follow-company-checkbox" ${state.follow?'checked':''}><label for="follow-company-checkbox">Follow ${esc(COMPANY)} to stay up to date with their page.</label></div>`];
const FOOT=[['Continue to next step','Next'],['Continue to next step','Next'],['Review your application','Review'],['Submit application','Submit application']];
function save(){const g=id=>document.getElementById(id);if(g('ea-email'))state.email=g('ea-email').value;if(g('ea-cc'))state.cc=g('ea-cc').value;if(g('ea-phone'))state.phone=g('ea-phone').value;
 if(g('ea-upload')&&g('ea-upload').files[0]){state.file=g('ea-upload').files[0];state.resume=state.file.name;}if(g('ea-years'))state.years=g('ea-years').value;
 const a=document.querySelector('input[name=ea-auth]:checked');if(a)state.auth=a.value;if(g('ea-english'))state.english=g('ea-english').value;if(g('ea-explain'))state.explain=g('ea-explain').value;
 if(g('follow-company-checkbox'))state.follow=g('follow-company-checkbox').checked;}
function render(){const body=document.getElementById('ea-step'),foot=document.getElementById('ea-footer');body.innerHTML=STEPS[step]();
 foot.innerHTML=(step?'<button type="button" aria-label="Back to previous step">Back</button>':'')+`<button type="button" class="artdeco-button--primary" aria-label="${FOOT[step][0]}"><span>${FOOT[step][1]}</span></button>`;
 foot.querySelector('.artdeco-button--primary').addEventListener('click',next);
 for(const r of body.querySelectorAll('input[name=ea-auth]'))r.addEventListener('change',()=>{save();if(SCENARIO==='conditional'){document.getElementById('ea-explain-wrap').hidden=state.auth!=='No';}});}
function valid(){let ok=true;document.querySelectorAll('#ea-step .error').forEach(n=>n.remove());
 for(const el of document.querySelectorAll('#ea-step [required]')){if(el.closest('[hidden]'))continue;const empty=el.type==='radio'?!document.querySelector(`input[name="${el.name}"]:checked`):el.type==='file'?!el.files.length:!el.value;
  if(empty){ok=false;const box=el.closest('.fb-dash-form-element,fieldset,[data-test-form-element]');if(!box.querySelector('.artdeco-inline-feedback--error'))box.insertAdjacentHTML('beforeend','<div class="artdeco-inline-feedback artdeco-inline-feedback--error" role="alert"><span>Please enter a valid answer</span></div>');}}
 return ok;}
async function next(){if(busy)return;save();if(!valid())return;if(step===3)return submit();busy=true;document.getElementById('ea-step').innerHTML='<div class="artdeco-loader">Loading</div>';
 await new Promise(r=>setTimeout(r,SCENARIO==='slow_steps'?1500:350));step++;busy=false;render();}
async function submit(){const d=new FormData();for(const k of ['email','cc','phone','years','auth','english','explain','resume'])d.set(k,state[k]);if(state.file)d.set('file',state.file);d.set('follow',String(state.follow));
 const r=await fetch(location.pathname.replace(/\/$/,'')+'/submit',{method:'POST',body:d});document.getElementById('modal-root').innerHTML='';
 if(SCENARIO==='no_confirmation')return;
 document.getElementById('modal-root').innerHTML=`<div role="dialog" aria-labelledby="post-apply-modal"><h2 id="post-apply-modal">Application sent</h2><p>Your application was sent to ${esc(COMPANY)}!</p><button type="button" onclick="this.closest('[role=dialog]').remove()">Done</button></div>`;
 document.getElementById('apply-area').innerHTML='<span class="artdeco-inline-feedback__message">Applied 1 second ago</span><a href="#">See application</a>';}
function openEasy(){if(SCENARIO==='daily_limit'){document.getElementById('modal-root').innerHTML='<div role="dialog"><h2>Easy Apply limit reached</h2><p>You’ve reached the Easy Apply application limit for today. Save this job and come back tomorrow to continue applying.</p></div>';return;}
 document.getElementById('modal-root').innerHTML=`<div role="dialog" class="artdeco-modal jobs-easy-apply-modal" aria-labelledby="jobs-apply-header"><h2 id="jobs-apply-header">Apply to ${esc(COMPANY)}</h2>
 <div class="jobs-easy-apply-content"><form id="ea-form" onsubmit="return false"><div id="ea-step"><div class="artdeco-loader">Loading</div></div></form></div><footer id="ea-footer"></footer></div>`;setTimeout(render,250);}
const easy=document.querySelector('button.jobs-apply-button');if(easy&&SCENARIO!=='offsite')easy.addEventListener('click',openEasy);
if(SCENARIO==='offsite')easy.addEventListener('click',()=>window.open(OFFSITE,'_blank'));
'''


def page(title, body, scripts=''):
    return HTMLResponse(f'<!doctype html><html lang="en"><head><meta charset="utf-8"><title>{html.escape(title)}</title>{STYLE}</head><body>{body}{scripts}</body></html>')


def make_app():
    app = FastAPI()
    app.state.submissions = []
    app.state.rejections = []

    async def record(family, scenario, job_id, request, accept=True):
        form = await request.form()
        fields, files = {}, {}
        for key, value in form.multi_items():
            if hasattr(value, 'read'):
                data = await value.read()
                files[key] = {'filename': value.filename, 'sha256': hashlib.sha256(data).hexdigest(), 'size': len(data)}
            elif key in fields:
                fields[key] = (fields[key] if isinstance(fields[key], list) else [fields[key]]) + [value]
            else:
                fields[key] = value
        row = {'family': family, 'scenario': scenario, 'job_id': job_id, 'fields': fields, 'files': files}
        (app.state.submissions if accept else app.state.rejections).append(row)
        return row

    def boot(scenario, job_id, company='Example Labs', extra=''):
        return f'<script>{COMMON_JS}const SCENARIO={json.dumps(scenario)},JOB={json.dumps(job_id)},COMPANY={json.dumps(company)};{extra}</script>'

    @app.get('/gh/{scenario}/jobs/{job_id}')
    async def greenhouse(scenario: str, job_id: str):
        faq = '<section class="faq"><h3>FAQ</h3><p>Thank you for applying to our programme in earlier years; alumni may apply again.</p></section>' if scenario == 'preexisting_thanks' else ''
        return page('Machine Learning Engineer', f'<main><h1>Machine Learning Engineer</h1><p>Example Labs · Ankara</p>{faq}<div id="app">Loading…</div></main>',
                    boot(scenario, job_id) + f'<script>{GREENHOUSE_DE_JS if scenario == "de" else GREENHOUSE_JS}</script>')

    @app.post('/gh/{scenario}/jobs/{job_id}/submit')
    async def greenhouse_submit(scenario: str, job_id: str, request: Request):
        if scenario == 'server_error':
            await record('greenhouse', scenario, job_id, request, accept=False)
            return JSONResponse({'error': 'rejected'}, status_code=422)
        await record('greenhouse', scenario, job_id, request)
        return {'ok': True}

    @app.get('/gh/{scenario}/jobs/{job_id}/confirmation')
    async def greenhouse_done(scenario: str, job_id: str):
        return page('Thanks', '<main><h1>Thank you for applying.</h1><p>Your application has been submitted.</p></main>')

    @app.get('/embed/{scenario}/{job_id}')
    async def embed(scenario: str, job_id: str):
        return page('Careers', f'<h1>Careers at Example Labs</h1><p>Join us.</p><iframe id="grnhse_iframe" title="Greenhouse Job Board" src="/gh/{scenario}/jobs/{job_id}?embed=1" style="width:100%;height:1500px;border:0"></iframe>')

    @app.get('/lever/{scenario}/{job_id}')
    async def lever_job(scenario: str, job_id: str):
        return page('Backend Engineer', f'<h1>Backend Engineer</h1><p>Example Labs</p><a class="postings-btn" href="/lever/{scenario}/{job_id}/apply">Apply for this job</a>')

    def lever_form(scenario, job_id, banner=''):
        def plain(name, label, required=True, kind='text'):
            mark = '<span class="required">✱</span>' if required else ''
            return f'<li class="application-question"><label><div class="application-label">{label}{mark}</div><div class="application-field"><input type="{kind}" name="{name}" {"required" if required else ""}></div></label></li>'
        radios = ''.join(f'<li><label><input type="radio" name="cards[c1][field0]" value="{v}" required><span class="application-answer-alternative">{v}</span></label></li>' for v in ('Yes', 'No'))
        boxes = ''.join(f'<li><label><input type="checkbox" name="cards[c1][field1]" value="{v}"><span>{v}</span></label></li>' for v in ('English', 'Turkish', 'German'))
        preference_fields = ''
        if scenario.startswith('preferences'):
            hours_label = 'How many hours can you work per week?' if str(job_id).endswith(('0','2','4','6','8')) else 'How many hours per week can you work?'
            salary_label = 'Expected salary' if scenario == 'preferences_ambiguous' else 'Expected gross monthly salary (TRY)'
            preference_fields = plain('weekly_hours', hours_label, kind='number') + plain('expected_salary', salary_label, kind='number')
            if scenario == 'preferences_unknown': preference_fields += plain('custom_essay', 'Why do you want this role?')
        return f'''<h2>Backend Engineer</h2>{banner}<form id="application-form" method="POST" enctype="multipart/form-data" action="/lever/{scenario}/{job_id}/apply"><ul>
<li class="application-question resume"><div class="application-label">Resume/CV <span class="required">✱</span></div><div class="application-field"><a class="visible-resume-upload">ATTACH RESUME/CV</a>
<input type="file" name="resume" id="resume-upload-input" class="application-file-input invisible-resume-upload hidden-input" required></div></li>
{plain('name', 'Full name')}{plain('email', 'Email', kind='email')}{plain('phone', 'Phone')}{plain('location', 'Current location', False)}{plain('org', 'Current company', scenario == 'company_required')}
{plain('urls[LinkedIn]', 'LinkedIn URL', False)}{plain('urls[GitHub]', 'GitHub URL', False)}
{preference_fields}
<li class="application-question custom-question"><div class="application-label full-width multiple-choice"><div class="text">Are you legally authorized to work in Turkey?<span class="required">✱</span></div></div>
<div class="application-field full-width required-field"><ul data-qa="multiple-choice">{radios}</ul></div></li>
<li class="application-question custom-question"><div class="application-label"><div class="text">Which languages do you speak professionally?</div></div><div class="application-field"><ul data-qa="checkboxes">{boxes}</ul></div></li>
<li class="application-question custom-question"><label><div class="application-label"><div class="text">How did you hear about us?</div></div><div class="application-field"><select name="cards[c1][field2]"><option value="">Select...</option><option>LinkedIn</option><option>Friend</option></select></div></label></li>
<li class="application-question"><label><input type="checkbox" name="consent[marketing]" value="1"> Yes, Example Labs can contact me about future job opportunities</label></li>
</ul><input type="hidden" name="h-captcha-response" id="hcaptchaResponseInput"><button type="button" id="btn-submit" class="postings-btn template-btn-submit">Submit application</button></form>
<script>const SCENARIO={json.dumps(scenario)};document.getElementById('btn-submit').addEventListener('click',()=>{{if(SCENARIO==='captcha'){{const c=document.createElement('div');c.className='h-captcha-challenge';c.dataset.abCaptcha='1';c.style.cssText='width:320px;height:300px;border:1px solid #888';c.textContent='Please verify you are human';document.body.appendChild(c);return;}}document.getElementById('application-form').requestSubmit();}});</script>'''

    @app.get('/lever/{scenario}/{job_id}/apply')
    async def lever_apply(scenario: str, job_id: str):
        return page('Apply', lever_form(scenario, job_id))

    @app.post('/lever/{scenario}/{job_id}/apply')
    async def lever_post(scenario: str, job_id: str, request: Request):
        if scenario == 'already_applied':
            await record('lever', scenario, job_id, request, accept=False)
            return page('Apply', lever_form(scenario, job_id, '<div class="error-message" role="alert">You have already applied to this position.</div>'))
        await record('lever', scenario, job_id, request)
        return RedirectResponse(f'/lever/{scenario}/{job_id}/thanks', status_code=303)

    @app.get('/lever/{scenario}/{job_id}/thanks')
    async def lever_thanks(scenario: str, job_id: str):
        return page('Thanks', '<h2>Application submitted!</h2><p>Thanks for applying to Example Labs.</p>')

    @app.get('/ashby/{scenario}/{job_id}/application')
    async def ashby(scenario: str, job_id: str):
        return page('Ashby', '<h1>Software Engineer</h1><div id="root">Loading…</div>', boot(scenario, job_id) + f'<script>{ASHBY_JS}</script>')

    @app.post('/ashby/{scenario}/{job_id}/application/submit')
    async def ashby_submit(scenario: str, job_id: str, request: Request):
        if scenario == 'spam':
            await record('ashby', scenario, job_id, request, accept=False)
            return JSONResponse({'error': 'Your application submission was flagged as possible spam.'}, status_code=400)
        await record('ashby', scenario, job_id, request)
        return {'ok': True}

    @app.get('/li/{scenario}/jobs/view/{job_id}')
    async def linkedin(scenario: str, job_id: str, request: Request):
        if scenario == 'login_wall':
            return page('Sign in', '<form class="login__form" data-ab-login-wall><h1>Sign in</h1><input name="session_key"><input name="session_password" type="password"><button>Sign in</button></form>')
        offsite = f'http://{request.url.netloc}/gh/ok/jobs/{job_id}'
        if scenario == 'already_applied':
            area = '<span class="artdeco-inline-feedback__message">Applied 2 days ago</span><a href="#">See application</a>'
        elif scenario == 'offsite':
            area = '<button class="jobs-apply-button artdeco-button" aria-label="Apply to Machine Learning Engineer on company website"><span>Apply</span></button>'
        else:
            area = '<button class="jobs-apply-button artdeco-button" aria-label="Easy Apply to Machine Learning Engineer at Example Labs"><span>Easy Apply</span></button>'
        body = f'<div class="jobs-unified-top-card" data-ab-top-card><h1>Machine Learning Engineer</h1><a>Example Labs</a><span>Ankara, Türkiye · 3 days ago</span><div id="apply-area">{area}</div></div><div id="modal-root"></div>'
        return page('Machine Learning Engineer | Example Labs | LinkedIn', body, boot(scenario, job_id, extra=f'const OFFSITE={json.dumps(offsite)};') + f'<script>{LINKEDIN_JS}</script>')

    @app.post('/li/{scenario}/jobs/view/{job_id}/submit')
    async def linkedin_submit(scenario: str, job_id: str, request: Request):
        await record('linkedin', scenario, job_id, request)
        return {'ok': True}

    @app.get('/indeed/{scenario}/viewjob')
    async def indeed_listing(scenario: str, request: Request, jk: str = '501'):
        if scenario == 'login_wall':
            return page('Sign in', '<form data-ab-login-wall><input type="password" name="password"><button>Sign in</button></form>')
        if scenario == 'captcha':
            return page('Verification', '<div data-ab-captcha>Please verify you are human</div>')
        if scenario == 'already_applied':
            return page('Job', '<h1>Logistics Specialist</h1><button id="indeedApplyButton" disabled>Applied</button>')
        if scenario == 'daily_limit':
            return page('Job', '<h1>Application limit reached</h1>')
        url = f'/indeedapply/{scenario}/{jk}/form/contact-info'
        if scenario == 'iframe':
            return page('Job', f'<h1>Logistics Specialist</h1><iframe title="Indeed Apply" src="{url}" style="width:100%;height:750px"></iframe>')
        if scenario == 'offsite':
            url = f'http://{request.url.netloc}/gh/ok/jobs/{jk}'
        target = ' target="_blank"' if scenario in ('popup', 'offsite') else ''
        return page('Job', f'<h1>Logistics Specialist</h1><a id="indeedApplyButton" href="{url}"{target}>Apply now</a>')

    @app.get('/indeedapply/{scenario}/{job_id}/form/contact-info')
    async def indeed_application(scenario: str, job_id: str):
        # Modelled Indeed-style steps, accessible names, iframe and popup variants. Not captured live DOM.
        script = r'''<script>
const SCENARIO=__SCENARIO__,JOB=__JOB__,state={name:'',email:'',phone:'',weekly_hours:'',essay:''};let step=0,file=null;
const root=document.getElementById('ia-container');
function field(name,label,type='text'){return `<label for="ia-${name}">${label}*</label><input id="ia-${name}" name="${name}" type="${type}" required value="${state[name]||''}">`;}
function save(){for(const name of Object.keys(state)){const input=document.getElementById('ia-'+name);if(input)state[name]=input.value;}const upload=document.getElementById('ia-resume');if(upload?.files[0])file=upload.files[0];}
function render(){
 const content=step===0?field('name','Full name')+field('email','Email','email')+field('phone','Phone','tel'):
 step===1?`<label for="ia-resume">Resume/CV*</label><input id="ia-resume" name="resume" type="file" required>`:
 step===2?field('weekly_hours','How many hours per week can you work?','number')+(SCENARIO==='questions'?`<label for="ia-essay">Why do you want this role?*</label><textarea id="ia-essay" name="essay" required>${state.essay}</textarea>`:''):
 '<h2>Review your application</h2><p>Your contact details, resume and answers are ready.</p>';
 root.innerHTML='<form id="indeedapply-form">'+content+(step===3?'<button id="ia-SubmitButton" type="button">Submit application</button>':'<button id="ia-continue-button" type="button">Continue</button>')+'</form>';
 root.querySelector('button').onclick=async()=>{save();if(step<3){step++;render();return;}
 const data=new FormData();for(const [key,value] of Object.entries(state))data.set(key,value);if(file)data.set('resume',file);
 const response=await fetch(`/indeedapply/${SCENARIO}/${JOB}/submit`,{method:'POST',body:data});
 if(!response.ok){root.insertAdjacentHTML('beforeend','<div role="alert">Your application could not be submitted. Please fix the errors.</div>');return;}
 if(SCENARIO==='no_confirmation'||SCENARIO==='preexisting_thanks'){root.innerHTML='<p>Processing</p>';return;}
 location.href=`/indeedapply/${SCENARIO}/${JOB}/confirmation`;
 };}
render();</script>'''.replace('__SCENARIO__', json.dumps(scenario)).replace('__JOB__', json.dumps(job_id))
        stale = '<p>Thank you for applying</p>' if scenario == 'preexisting_thanks' else ''
        return page('Indeed Apply', stale + '<main><div id="ia-container" class="ia-BasePage"></div></main>', script)

    @app.post('/indeedapply/{scenario}/{job_id}/submit')
    async def indeed_submit(scenario: str, job_id: str, request: Request):
        await record('indeed', scenario, job_id, request, accept=scenario != 'rejected')
        return JSONResponse({'ok': scenario != 'rejected'}, status_code=422 if scenario == 'rejected' else 200)

    @app.get('/indeedapply/{scenario}/{job_id}/confirmation')
    async def indeed_confirmation(scenario: str, job_id: str):
        return page('Submitted', '<main><h1>Your application has been submitted</h1><p>We have received your application.</p></main>')

    @app.get('/__submissions')
    async def submissions():
        return {'accepted': app.state.submissions, 'rejected': app.state.rejections}

    @app.get('/favicon.ico')
    async def favicon():
        return Response(status_code=204)

    return app
