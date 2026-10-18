"""Bounded Indeed adapter experiment. Real Chromium, synthetic loopback forms only.

These pages model accessible Indeed-style steps; this is not live Indeed verification.
"""
import asyncio
import hashlib
import json
import os
import tempfile
import time
from pathlib import Path
from urllib.parse import urlparse

from applyburst.companion import AutoAck, run_jobs
from applyburst.fixture import RESUME
from applyburst.form_fixtures import make_app
from applyburst.formscan import fingerprint
from applyburst.harness import serve

os.environ.setdefault('PLAYWRIGHT_BROWSERS_PATH', 'D:/cache/ms-playwright')


async def main():
    from playwright.async_api import async_playwright
    root = Path(__file__).resolve().parents[1]
    report = {'synthetic_only': True, 'live_indeed_verified': False, 'checks': [], 'runs': []}
    def check(label, condition):
        report['checks'].append({'label': label, 'passed': bool(condition)})
        assert condition, label
    with tempfile.TemporaryDirectory(dir=root / '.data', prefix='indeed-probe-') as temporary:
        resume = Path(temporary) / 'synthetic-resume.txt'
        resume.write_bytes(RESUME)
        profile = {'name': 'Demo Candidate', 'email': 'candidate@example.test', 'phone': '+90 555 000 00 00',
                   'resume_path': str(resume), 'location': 'Ankara, Turkey'}
        app = make_app()
        async with serve(app) as base, async_playwright() as pw:
            browser = await pw.chromium.launch(headless=True, args=['--disable-gpu'])
            context = await browser.new_context(locale='en-US')
            try:
                async def run(scenario, task='auto', answers=None, expected=None):
                    target = {'id': scenario, 'url': base + '/indeed/' + scenario + '/viewjob?jk=501', 'family': 'indeed'}
                    if expected:
                        target['expected_plan'] = expected
                    request = {'task': task, 'jobs': [target], 'profile': profile, 'answers': answers or {},
                               'preferences': {'weekly_hours': {'value': '40', 'confirmed': True}},
                               'permission': {'mode': 'auto_known', 'sites': {'indeed': True}, 'paused': False},
                               'headless': True, 'indeed_pace_seconds': 0, 'confirm_timeout': 1.5, 'human_timeout': 1.5}
                    channel = AutoAck()
                    tick = time.perf_counter()
                    rows, kept = await run_jobs(context, request, channel.emit, channel)
                    for page, _, _ in kept:
                        await page.close()
                    result = rows[0]
                    report['runs'].append({'scenario': scenario, 'task': task, 'state': result['state'],
                                           'elapsed_ms': round((time.perf_counter()-tick)*1000, 1),
                                           'timings_ms': result.get('timings_ms'), 'note': result.get('note'), 'error': result.get('error')})
                    print(json.dumps(report['runs'][-1]), flush=True)
                    return result

                ready = await run('happy', 'prepare')
                check('prepare stops before sending', ready['state'] == 'ready_to_submit' and len(app.state.submissions) == 0)
                confirmed = await run('happy', 'submit', expected=ready['plan_hash'])
                check('reviewed submit has a new confirmation', confirmed['state'] == 'confirmed')
                received = app.state.submissions[-1]
                check('receiver gets exact CV contacts and saved hours', received['fields']['name'] == profile['name'] and received['fields']['email'] == profile['email'] and received['fields']['phone'] == profile['phone'] and received['fields']['weekly_hours'] == '40')
                check('receiver gets the original resume bytes', received['files']['resume']['sha256'] == hashlib.sha256(RESUME).hexdigest())
                auto = await run('auto')
                check('automatic known form confirms', auto['state'] == 'confirmed')
                before = len(app.state.submissions)
                missing = await run('questions')
                check('unknown required essay blocks only this job', missing['state'] == 'needs_answers' and len(app.state.submissions) == before and len(missing['missing']) == 1)
                approved = {missing['missing'][0]['fingerprint']: 'Approved synthetic motivation.'}
                resumed = await run('questions', answers=approved)
                check('approved answer resumes and confirms', resumed['state'] == 'confirmed' and app.state.submissions[-1]['fields']['essay'] == 'Approved synthetic motivation.')
                for scenario in ('popup', 'iframe'):
                    result = await run(scenario)
                    check(scenario + ' form confirms', result['state'] == 'confirmed')
                    check(scenario + ' leaves no orphan application page', len(context.pages) == 0)
                rejected = await run('rejected')
                check('rejection is not success', rejected['state'] == 'submit_rejected')
                for scenario in ('no_confirmation', 'preexisting_thanks'):
                    result = await run(scenario)
                    check(scenario + ' remains uncertain', result['state'] == 'unknown_after_submit')
                for scenario, state in [('login_wall', 'needs_login'), ('captcha', 'needs_human_verification'), ('already_applied', 'already_applied'), ('daily_limit', 'rate_limited'), ('offsite', 'employer_site_redirect')]:
                    count = len(app.state.submissions)
                    result = await run(scenario, 'prepare')
                    check(scenario + ' stops without submitting', result['state'] == state and len(app.state.submissions) == count)
                report['accepted_receiver_requests'] = len(app.state.submissions)
                report['rejected_receiver_requests'] = len(app.state.rejections)
                report['confirmed_applications'] = sum(run['state'] == 'confirmed' for run in report['runs'])
                # Exercise actual production-host routing with every external request intercepted.
                # Bodies/submissions are forwarded only to this loopback receiver, never to a job site.
                source_runs = []
                hosts = {'himalayas': 'himalayas.app', 'remoteok': 'remoteok.com', 'jobicy': 'jobicy.com',
                         'remotive': 'remotive.com', 'arbeitnow': 'www.arbeitnow.com', 'google': 'www.google.com'}

                async def local_only(route):
                    request, parsed = route.request, urlparse(route.request.url)
                    if parsed.hostname in hosts.values() and parsed.path.startswith('/fixture/source/'):
                        source = parsed.path.rsplit('/', 1)[-1]
                        target = f'https://smartapply.indeed.com/indeedapply/auto/{source}/form/contact-info'
                        await route.fulfill(content_type='text/html', body=f'<main><h1>Logistics Specialist</h1><a href="{target}">Apply for this job</a></main>')
                    elif parsed.hostname == 'www.glassdoor.com' and parsed.path == '/fixture/native':
                        body = '''<h1>Logistics Specialist</h1><button data-test="apply-button" id="open-application">Easy Apply</button><div id="modal-root"></div><script>
document.getElementById('open-application').onclick=async()=>{const html=await(await fetch('/indeedapply/auto/glassdoor/form/contact-info')).text();const doc=new DOMParser().parseFromString(html,'text/html');const dialog=document.createElement('div');dialog.setAttribute('role','dialog');dialog.append(doc.getElementById('ia-container'));document.getElementById('modal-root').append(dialog);for(const source of doc.querySelectorAll('script')){const script=document.createElement('script');script.textContent=source.textContent;document.body.append(script);}};
</script>'''
                        await route.fulfill(content_type='text/html', body=body)
                    elif parsed.hostname in ('smartapply.indeed.com', 'www.glassdoor.com') and parsed.path.startswith('/indeedapply/'):
                        response = await context.request.fetch(base + parsed.path, method=request.method,
                                                               headers={'content-type': request.headers.get('content-type', 'text/plain')}, data=request.post_data_buffer)
                        await route.fulfill(response=response)
                    elif parsed.hostname == 'www.linkedin.com' and parsed.path.startswith('/jobs/view/501'):
                        response = await context.request.fetch(base + '/li/no_resume' + parsed.path, method=request.method,
                                                               headers={'content-type': request.headers.get('content-type', 'text/plain')}, data=request.post_data_buffer)
                        await route.fulfill(response=response)
                    else:
                        await route.abort()

                await context.route('https://**/*', local_only)
                routes = [(source, f'https://{host}/fixture/source/{source}') for source, host in hosts.items()]
                routes += [('glassdoor', 'https://www.glassdoor.com/fixture/native'), ('linkedin', 'https://www.linkedin.com/jobs/view/501'), ('indeed', 'https://smartapply.indeed.com/indeedapply/auto/indeed/form/contact-info')]
                for source, url in routes:
                    count = len(app.state.submissions)
                    request = {'task': 'auto', 'jobs': [{'id': source, 'url': url}], 'profile': profile,
                               'preferences': {key: {'value': value, 'confirmed': True} for key, value in {'weekly_hours': '40', 'years_experience:python': '4', 'work_authorization:TR': 'Yes', 'language_proficiency:english': 'Professional'}.items()},
                               'permission': {'mode': 'auto_all', 'sites': {'indeed': True, 'glassdoor': True, 'linkedin': True}, 'paused': False},
                               'headless': True, 'confirm_timeout': 2, 'human_timeout': 2}
                    ack = AutoAck()
                    result, _ = await run_jobs(context, request, ack.emit, ack)
                    source_runs.append({'source': source, 'state': result[0]['state'], 'destination_family': result[0].get('family'), 'elapsed_ms': result[0].get('elapsed_ms')})
                    print(json.dumps(source_runs[-1]), flush=True)
                    check(source + ' routing produces exactly one local receipt', result[0]['state'] == 'confirmed' and len(app.state.submissions) == count + 1)
                count = len(app.state.submissions)
                before_pages = list(context.pages)
                concurrent = {**request, 'concurrency': 3, 'jobs': [
                    {'id': 'concurrent-popup', 'url': base + '/indeed/popup/viewjob?jk=concurrent-popup', 'family': 'indeed'},
                    {'id': 'concurrent-board', 'url': 'https://himalayas.app/fixture/source/concurrent-board'}]}
                ack = AutoAck()
                results, _ = await run_jobs(context, concurrent, ack.emit, ack)
                await asyncio.sleep(0.1)
                print(json.dumps({'concurrent_sources': results, 'new_receipts': len(app.state.submissions)-count, 'pages_before': [p.url for p in before_pages], 'pages_after': [p.url for p in context.pages]}), flush=True)
                check('concurrent popup cannot adopt or close another source tab', all(r['state'] == 'confirmed' for r in results) and len(app.state.submissions) == count + 2 and set(context.pages) == set(before_pages))

                from applyburst.companion import follow_offsite
                parent = await context.new_page()
                await parent.goto(base + '/indeed/auto/viewjob?jk=popup-scope')
                await parent.evaluate('''url => { document.body.innerHTML='<button id="popup-link">Apply</button>'; document.getElementById('popup-link').onclick=()=>setTimeout(()=>window.open(url),200); }''', base + '/indeedapply/auto/popup-scope/form/contact-info')
                async def unrelated_tab():
                    await asyncio.sleep(0.02)
                    return await context.new_page()
                unrelated = asyncio.create_task(unrelated_tab())
                destination = await follow_offsite(parent, parent.locator('#popup-link'), {})
                other = await unrelated
                check('source popup listener ignores a concurrent unrelated new page', 'popup-scope/form' in destination.get('destination', '') and not other.is_closed())
                await parent.close()
                await other.close()
                page = await context.new_page()
                await page.set_content('<title>Blocked - Indeed.com</title>')
                from applyburst.adapters import Indeed
                check('blocked page is verification rather than a missing form', (await Indeed().blocker(page))['state'] == 'needs_human_verification')
                await page.close()
                (root / 'reports/source-application-routing.json').write_text(json.dumps({'synthetic_only': True, 'external_network': 'all intercepted; unrecognized URLs aborted', 'live_site_submission_verified': False, 'sources': source_runs, 'concurrent_sources': [{'state': r['state'], 'family': r.get('family')} for r in results], 'popup_isolation_verified': True}, indent=2) + '\n', encoding='utf-8')
            finally:
                await context.close()
                await browser.close()
    report['passed'] = len(report['checks'])
    output = root / 'reports/indeed-adapter.json'
    output.write_text(json.dumps(report, indent=2) + '\n', encoding='utf-8')
    print(json.dumps({'passed': report['passed'], 'confirmed_synthetic': report['confirmed_applications'], 'report': str(output)}))


if __name__ == '__main__':
    asyncio.run(main())
