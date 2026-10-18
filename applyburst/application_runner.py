"""Deterministic local application execution, with exact-batch approval in the API.

No model calls, credential export, guessed screening answers or blind retries.
Each site has explicit navigation/final-button/confirmation recognition.
"""
import argparse
import asyncio
import json
import re
import time
from pathlib import Path
from urllib.parse import urlparse
from .interactive import SCAN,compile_form

FAMILIES={
 'linkedin':('linkedin.com',),
 'lever':('jobs.lever.co',),
 'greenhouse':('job-boards.greenhouse.io','boards.greenhouse.io'),
 'ashby':('jobs.ashbyhq.com',),
}
def family_for(url):
    parsed=urlparse(url);host=parsed.hostname or ''
    if parsed.scheme!='https':return None
    return next((family for family,domains in FAMILIES.items() if any(host==d or host.endswith('.'+d) for d in domains)),None)

async def visible(locator):
    for item in await locator.all():
        if await item.is_visible():return item
    return None

async def action(scope,names):
    for name in names:
        found=await visible(scope.get_by_role('button',name=re.compile(name,re.I)))
        if found:return found
    return None

async def application_scope(page,family):
    if family=='linkedin':
        dialog=page.get_by_role('dialog')
        if await dialog.count() and await dialog.first.is_visible():return dialog.first
        easy=await action(page,[r'^Easy Apply(?: to .*)?$'])
        if not easy:return None
        await easy.click();await dialog.first.wait_for(state='visible',timeout=10000);return dialog.first
    if family=='lever' and not urlparse(page.url).path.rstrip('/').endswith('/apply'):
        link=await visible(page.locator('a[href$="/apply"],a[href*="/apply?"]'))
        if link:await link.click();await page.wait_for_load_state('domcontentloaded')
    if family=='greenhouse':
        for frame in page.frames:
            if frame!=page.main_frame and family_for(frame.url)=='greenhouse':return frame
    if family=='ashby':
        if not await page.locator('input[type=email],input[type=file]').count():
            button=await action(page,[r'^Apply(?: for this job)?$',r'^Application$'])
            if button:await button.click()
    try:await page.locator('input[type=email],input[type=file],textarea').first.wait_for(state='attached',timeout=10000)
    except Exception:pass
    return page

async def fill_fields(scope,fields,profile,answer_bank):
    plan=compile_form(fields,profile,answer_bank)
    for item in plan['mapping']:
        locator=scope.locator(item['selector'])
        if await locator.count()!=1:raise ValueError('Ambiguous field locator; adapter needs updating.')
        if item['type']=='file':
            path=Path(item['value'])
            if not path.is_file():raise ValueError('Resume file is unavailable.')
            await locator.set_input_files(str(path))
        elif item['type']=='select':await locator.select_option(str(item['value']))
        elif item['type']=='checkbox':await locator.set_checked(str(item['value']).lower() in ('yes','true','1'))
        elif item['type']=='radio':await locator.check()
        else:await locator.fill(str(item['value']))
    return plan

async def execute(page,job,profile,answer_bank,mode,checkpoint=lambda row:None,fixture_family=None):
    family=fixture_family or family_for(job['url'])
    base={'job_id':job['id'],'adapter':family,'url':job['url'],'mode':mode}
    if not family:return{**base,'state':'unsupported_site','note':'No execution adapter for this employer host yet.'}
    submitted=False;steps=[]
    try:
        await page.goto(job['url'],wait_until='domcontentloaded',timeout=30000)
        body=(await page.locator('body').inner_text())[:12000]
        if re.search(r'verify you are human|captcha|security verification|checking your browser',body,re.I):return{**base,'state':'needs_human_verification'}
        scope=await application_scope(page,family)
        if scope is None:return{**base,'state':'needs_login_or_application_navigation'}
        previous=None
        for step in range(8):
            fields=await scope.evaluate(SCAN) if hasattr(scope,'evaluate') else await scope.locator('body').evaluate('(el)=>'+SCAN.replace('() =>','',1))
            if not fields:return{**base,'state':'form_not_found','steps':steps}
            plan=await fill_fields(scope,fields,profile,answer_bank)
            steps.append({'step':step+1,'mapped':len(plan['mapping']),'missing':plan['missing']})
            if plan['missing']:return{**base,'state':'needs_answers','steps':steps,'missing':plan['missing']}
            final=await action(scope,[r'^Submit application$',r'^Submit$',r'^Send application$'])
            if final:
                if mode!='submit':return{**base,'state':'ready_for_review','steps':steps,'note':'Fields filled; final submission was not clicked.'}
                # Persist intent before clicking: a timeout afterwards must never trigger a blind retry.
                pattern=re.compile(r'application (?:was |has been )?(?:successfully )?(?:submitted|sent|received)|thank you for applying|thanks for applying|your application was sent',re.I)
                before=await page.get_by_text(pattern).all_text_contents()
                checkpoint({**base,'state':'submitting','steps':steps});submitted=True
                await final.click()
                try:await page.get_by_text(pattern).first.wait_for(state='visible',timeout=15000)
                except Exception:return{**base,'state':'unknown_after_submit','steps':steps,'url':page.url,'note':'No recognized confirmation. Check the site before retrying.'}
                confirmation=await page.get_by_text(pattern).first.inner_text()
                if confirmation in before:return{**base,'state':'unknown_after_submit','steps':steps,'note':'Confirmation text was already present before submission.'}
                return{**base,'state':'confirmed','steps':steps,'confirmation':confirmation[:500],'url':page.url,'confirmed_at':time.time()}
            next_button=await action(scope,[r'^Next$',r'^Continue$',r'^Review(?: your application)?$'])
            signature=[(field['label'],field['type']) for field in fields]
            if not next_button or previous==signature:return{**base,'state':'adapter_needs_update','steps':steps,'note':'Unrecognized or unchanged application step.'}
            previous=signature;old_fields=fields;await next_button.click()
            # Wait for the application step to change, rather than a fixed sleep.
            try:
                old_label=old_fields[0]['selector']
                await scope.locator(old_label).wait_for(state='hidden',timeout=5000)
            except Exception:pass
        return{**base,'state':'step_limit','steps':steps}
    except Exception as error:return{**base,'state':'unknown_after_submit' if submitted else 'failed_before_submit','error':str(error)[:500],'steps':steps}

async def run(request,profile_dir,output):
    from playwright.async_api import async_playwright
    start=time.perf_counter();results=[];checkpoint_file=Path(request['checkpoint'])
    def checkpoint(row):
        checkpoint_file.write_text(json.dumps({'results':results,'current':row},indent=2),encoding='utf-8')
    async with async_playwright() as pw:
        # Keep incomplete forms visible so a person can finish unsupported questions.
        context=await pw.chromium.launch_persistent_context(str(Path(profile_dir).resolve()),headless=False,args=['--disable-gpu'])
        for job in request['jobs'][:50]:
            page=await context.new_page();result=await execute(page,job,request['profile'],request.get('answer_bank',{}),request['mode'],checkpoint)
            results.append(result);checkpoint(result)
            if result['state']=='confirmed':await page.close()
        Path(output).write_text(json.dumps({'results':results,'elapsed_seconds':time.perf_counter()-start,'gpu_enabled':False,'model_calls':0},indent=2),encoding='utf-8')
        # Review mode and stopped forms remain open until the user chooses Done in ApplyBurst.
        stop=Path(request.get('stop_file',str(checkpoint_file)+'.stop'))
        if any(row['state']!='confirmed' for row in results):
            while not stop.exists():await asyncio.sleep(.5)
        await context.close()

def main():
    parser=argparse.ArgumentParser();parser.add_argument('--request',required=True);parser.add_argument('--profile',required=True);parser.add_argument('--output',required=True);args=parser.parse_args()
    asyncio.run(run(json.loads(Path(args.request).read_text(encoding='utf-8')),args.profile,args.output))
if __name__=='__main__':main()
