"""Bounded read-only audit of public employer questions; no candidate data or submissions.

Run from the repository root with .venv/Scripts/python.exe scripts/audit_forms.py.
This is a descriptive sample, not a market-wide estimate of answerable applications.
"""
import asyncio
import json
import os
import sys
import time
from collections import Counter
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import httpx
from applyburst.adapters import adapter_for
from applyburst.formscan import identify, scan
from applyburst.preferences import describe

ROOT = Path(__file__).resolve().parents[1]
BOARDS = {
    'greenhouse': ['anthropic', 'cloudflare', 'datadog', 'duolingo', 'figma', 'gitlab'],
    'lever': ['trendyol', 'mistral', 'spotify'],
    'ashby': ['langchain', 'notion', 'linear'],
    'workable': ['wingieenuygun'],
}

def public_question(q):
    return {**{key: q.get(key) for key in ['label', 'kind', 'required', 'id', 'name', 'autocomplete']},
            'options': [{'label': o.get('label'), 'value': o.get('value')} for o in q.get('options') or []],
            'fact': identify(q), 'preference': describe(q)}

async def main():
    os.environ['CUDA_VISIBLE_DEVICES'] = '-1'
    os.environ.setdefault('PLAYWRIGHT_BROWSERS_PATH', r'D:\cache\ms-playwright')
    forms, errors, browser_jobs = [], [], []
    slots = asyncio.Semaphore(3)
    async with httpx.AsyncClient(timeout=18, follow_redirects=True, headers={'User-Agent': 'ApplyBurst question audit (read-only)'}) as client:
        async def board(family, slug):
            async with slots:
                try:
                    url = {'greenhouse': f'https://boards-api.greenhouse.io/v1/boards/{slug}/jobs',
                           'lever': f'https://api.lever.co/v0/postings/{slug}?mode=json',
                           'ashby': f'https://api.ashbyhq.com/posting-api/job-board/{slug}',
                           'workable': f'https://apply.workable.com/api/v1/widget/accounts/{slug}?details=true'}[family]
                    r = await client.get(url); r.raise_for_status(); data = r.json()
                    rows = data if isinstance(data, list) else data.get('jobs', [])
                    rows.sort(key=lambda j: (not any(t in (j.get('title') or j.get('text') or '').lower() for t in ['engineer', 'learning', 'developer']), str(j.get('id'))))
                    for row in rows[:(3 if family == 'greenhouse' else 2)]:
                        job_url = row.get('absolute_url') or row.get('applyUrl') or row.get('url')
                        if family == 'greenhouse':
                            tick = time.perf_counter()
                            detail = await client.get(f'https://boards-api.greenhouse.io/v1/boards/{slug}/jobs/{row["id"]}?questions=true')
                            detail.raise_for_status(); payload = detail.json(); questions = []
                            kinds = {'input_text': 'text', 'textarea': 'textarea', 'input_file': 'file', 'multi_value_single_select': 'select', 'multi_value_multi_select': 'checkbox_group'}
                            for q in payload.get('questions', []) + payload.get('location_questions', []):
                                # A resume file and its text alternative are one logical question.
                                fields = [f for f in q.get('fields', []) if f.get('type') != 'input_hidden']
                                if not fields: continue
                                for field in sorted(fields, key=lambda f: f.get('type') != 'input_file')[:1]:
                                    item = {'label': q.get('label'), 'kind': kinds.get(field.get('type'), field.get('type')),
                                            'required': q.get('required', False), 'id': field.get('name'), 'name': field.get('name'),
                                            'options': [{'label': v.get('label'), 'value': str(v.get('value'))} for v in field.get('values') or []]}
                                    questions.append(public_question(item))
                            forms.append({'family': family, 'employer': slug, 'url': payload.get('absolute_url') or job_url,
                                          'title': row.get('title'), 'location': row.get('location', {}).get('name'), 'method': 'public_question_schema',
                                          'elapsed_ms': round((time.perf_counter()-tick)*1000, 1), 'questions': questions,
                                          'compliance_schema_present': bool(payload.get('compliance') or payload.get('demographic_questions'))})
                        elif job_url:
                            browser_jobs.append({'family': family, 'employer': slug, 'url': job_url, 'title': row.get('title') or row.get('text')})
                except Exception as error:
                    errors.append({'family': family, 'employer': slug, 'error': str(error).splitlines()[0][:200]})
        await asyncio.gather(*(board(family, slug) for family, slugs in BOARDS.items() for slug in slugs))
    from playwright.async_api import async_playwright
    async with async_playwright() as pw:
        browser = await pw.chromium.launch(headless=True, args=['--disable-gpu'])
        context = await browser.new_context(locale='en-US')
        slots = asyncio.Semaphore(2)
        async def inspect(job):
            async with slots:
                page = await context.new_page(); tick = time.perf_counter()
                try:
                    r = await page.goto(job['url'], wait_until='domcontentloaded', timeout=20000)
                    if r and r.status >= 400: raise RuntimeError(f'HTTP {r.status}')
                    adapter = adapter_for(page.url)
                    blocked = await adapter.blocker(page)
                    if blocked: raise RuntimeError(blocked['state'])
                    scope = await adapter.open(page, job)
                    if scope is None or isinstance(scope, dict): raise RuntimeError('form_not_found_or_handoff')
                    await adapter.form_ready(scope)
                    questions = await scan(scope)
                    forms.append({**job, 'method': 'read_only_DOM', 'elapsed_ms': round((time.perf_counter()-tick)*1000, 1),
                                  'questions': [public_question(q) for q in questions], 'final_button_visible': bool(await adapter.submit_button(scope))})
                except Exception as error:
                    errors.append({**job, 'error': str(error).splitlines()[0][:200]})
                finally: await page.close()
        await asyncio.gather(*(inspect(job) for job in browser_jobs))
        await browser.close()
    questions = [q for form in forms for q in form['questions']]
    report = {'utc': datetime.now(timezone.utc).isoformat(),
              'scope': 'Bounded convenience sample of public schemas and untouched DOM forms; no login, typing, upload, or submission. Counts are descriptive, not representative prevalence.',
              'forms': forms, 'errors': errors, 'summary': {'forms': len(forms), 'employers': len({(f['family'], f['employer']) for f in forms}),
            'questions': len(questions), 'required': sum(bool(q['required']) for q in questions),
              'known_identity_fields': sum(bool(q['fact']) for q in questions), 'reusable_preference_questions': sum(bool(q['preference']) for q in questions), 'kinds': dict(Counter(q['kind'] for q in questions)),
              'frequent_labels': Counter(q['label'] for q in questions).most_common(35)}, 'submission_intents': 0, 'model_calls': 0}
    output = ROOT/'reports/form-question-audit.json'; output.write_text(json.dumps(report, indent=2, ensure_ascii=False), encoding='utf8')
    print(json.dumps({'output': str(output), **report['summary'], 'failed_sources': len(errors)}))

asyncio.run(main())
