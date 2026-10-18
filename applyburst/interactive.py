"""Browser companion foundation: inspect dynamic forms, map facts, and abstain.

The 24-site registry routes work; it does not claim 24 verified submission adapters.
Live runs here inspect only. The separately tested loopback browser adapter can submit.
"""
import argparse
import asyncio
import hashlib
import json
import re
import time
import unicodedata
from pathlib import Path
from urllib.parse import urlparse

def key(value):
    value=unicodedata.normalize('NFKD',str(value).lower().replace('ı','i'))
    return re.sub('[^a-z0-9]','',value)

IDENTITY={
    'name':['name','fullname','full_name','adsoyad','isimsoyisim'],
    'first_name':['firstname','givenname','first_name','ad','isim'],
    'last_name':['lastname','surname','familyname','last_name','soyad','soyisim'],
    'email':['email','emailaddress','email_address','eposta','epostaadresi'],
    'phone':['phone','phonenumber','mobile','telephone','telefon','telefonnumarasi'],
    'github':['github','githubprofile','githuburl'],
    'linkedin':['linkedin','linkedinprofile','linkedinurl'],
    'website':['website','websiteurl','portfolio','portfoliourl','personalwebsite'],
    'city':['city','currentcity','sehir'],
    'resume':['resume','resumecv','cv','uploadresume','attachresume'],
}

def identify_field(field):
    if field.get('type') in ('checkbox','radio'):
        return None
    labels=[key(field.get(name,'')) for name in ('name','id','label','autocomplete')]
    if field.get('type')=='email':return 'email'
    if field.get('type')=='tel':return 'phone'
    for fact,aliases in IDENTITY.items():
        if any(label in {key(alias) for alias in aliases} for label in labels):
            if field.get('type')=='file' and fact!='resume':return None
            return fact
    return None

def compile_form(fields,profile,answer_bank=None):
    names=str(profile.get('name','')).split()
    facts={**profile,'first_name':' '.join(names[:-1]) if len(names)>1 else (names[0] if names else None),
           'last_name':names[-1] if len(names)>1 else None,'city':profile.get('city'),'website':profile.get('github')}
    mapping=[];missing=[]
    for field in fields:
        fingerprint=hashlib.sha256(json.dumps({'label':field.get('label'),'type':field.get('type'),'options':field.get('options')},sort_keys=True).encode()).hexdigest()
        fact=identify_field(field);value=facts.get(fact) if fact else None
        if answer_bank and fingerprint in answer_bank:value=answer_bank[fingerprint]
        if field.get('type')=='file' and fact=='resume':value=profile.get('resume_path')
        if field.get('options') and value is not None:
            options=field['options'];match=next((o for o in options if str(o.get('label','')).casefold()==str(value).casefold() or str(o.get('value','')).casefold()==str(value).casefold()),None)
            value=match.get('value') if match else None
        if value in (None,''):
            if field.get('required'):missing.append({**field,'fingerprint':fingerprint})
        else:mapping.append({'selector':field['selector'],'type':field['type'],'fact':fact,'value':value})
    return {'mapping':mapping,'missing':missing,'status':'needs_answers' if missing else 'known_fields_mapped','submission_verified':False}

SCAN=r'''(root) => {root=root?.querySelectorAll?root:document;return [...root.querySelectorAll('input,textarea,select')].map((el,index)=>{
 if(['hidden','submit','button','reset'].includes(el.type)||el.disabled)return null;
 const visible=el.type==='file'||(el.getClientRects().length&&getComputedStyle(el).visibility!=='hidden');if(!visible)return null;
 const labels=[...(el.labels||[])].map(l=>l.innerText).join(' ').trim();
 const label=labels||el.getAttribute('aria-label')||el.getAttribute('placeholder')||el.name||'';
 const selector=el.id&&document.querySelectorAll('#'+CSS.escape(el.id)).length===1?'#'+CSS.escape(el.id):'input,textarea,select >> nth='+index;
 return {id:el.id,name:el.name,label,type:el.tagName==='SELECT'?'select':el.type||'text',required:el.required||el.getAttribute('aria-required')==='true',autocomplete:el.autocomplete,selector,index,options:el.tagName==='SELECT'?[...el.options].filter(o=>o.value).map(o=>({label:o.label,value:o.value})):null};
}).filter(Boolean)}'''

async def inspect(page,job,profile):
    await page.goto(job['url'],wait_until='domcontentloaded',timeout=20000)
    # A short selector wait is bounded; no arbitrary per-click sleep or model call.
    try:await page.locator('input:not([type=hidden]),select,textarea').first.wait_for(state='attached',timeout=5000)
    except Exception:pass
    fields=await page.evaluate(SCAN)
    text=(await page.locator('body').inner_text())[:12000]
    if re.search(r'verify you are human|complete the captcha|security verification|checking your browser',text,re.I):status='needs_human_verification'
    elif not fields or (re.search(r'sign in|log in',text,re.I) and not any(f['type']=='file' for f in fields)):status='needs_login_or_application_navigation'
    else:status='form_observed'
    return {'job_id':job['id'],'url':page.url,'state':status,'fields':fields,'plan':compile_form(fields,profile),'mode':'read_only_inspection','automatic_submission_verified':False}

async def main(args):
    from playwright.async_api import async_playwright
    request=json.loads(Path(args.request).read_text(encoding='utf-8'))
    root=Path(__file__).resolve().parent.parent
    sites=json.loads((root/'config/application_sites.json').read_text(encoding='utf-8'))
    allowed=[domain for site in sites for domain in site['domains']]
    def safe(url):
        parsed=urlparse(url)
        return parsed.scheme=='https' and bool(parsed.hostname) and any(parsed.hostname==d or parsed.hostname.endswith('.'+d) for d in allowed)
    start=time.perf_counter();results=[]
    async with async_playwright() as playwright:
        context=await playwright.chromium.launch_persistent_context(str(Path(args.profile).resolve()),headless=not args.login,args=['--disable-gpu'])
        if args.login:
            if not safe(args.login):raise ValueError('Site is outside the reviewed registry')
            page=await context.new_page();await page.goto(args.login,wait_until='domcontentloaded')
            stop=Path(args.stop_file)
            while not stop.exists():await asyncio.sleep(.5)
            await context.close();return
        queue=asyncio.Queue()
        for job in request['jobs'][:50]:queue.put_nowait(job)
        async def worker():
            page=await context.new_page()
            while not queue.empty():
                job=queue.get_nowait()
                try:
                    if not safe(job['url']):raise ValueError('Custom employer host needs review')
                    result=await inspect(page,job,request.get('profile',{}))
                except Exception as error:result={'job_id':job['id'],'state':'inspection_failed','error':str(error)[:300]}
                results.append(result)
            await page.close()
        await asyncio.gather(worker(),worker());await context.close()
    output={'scope':'Read-only browser form inspection. No profile values filled or employer submissions sent.','elapsed_seconds':time.perf_counter()-start,'results':results,'gpu_enabled':False,'model_calls':0}
    Path(args.output).write_text(json.dumps(output,indent=2),encoding='utf-8')

if __name__=='__main__':
    parser=argparse.ArgumentParser();parser.add_argument('--request',required=True);parser.add_argument('--profile',required=True);parser.add_argument('--output',default='');parser.add_argument('--login');parser.add_argument('--stop-file',default='')
    asyncio.run(main(parser.parse_args()))
