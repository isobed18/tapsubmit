"""Local browser companion. Owns the private automation profile; one task per process.

Protocol: the first stdin line (or --request FILE) is the task. Events are JSON lines on stdout.
Later stdin lines are commands: {"type":"intent_ack","seq":n} and {"type":"close"}. Before every
final submit click the companion emits an "intent" event and waits for the server to acknowledge
that the attempt is durably recorded as submitting. No acknowledgement, no click.

Tasks: prepare (fill and stop before the final button), submit (exact reviewed plan only),
inspect (read-only), open (fill and hand the page to the person), login, session.
No model calls, no CAPTCHA solving, no credential export.
"""
import argparse
import asyncio
import json
import os
import re
import shutil
import sqlite3
import subprocess
import sys
import tempfile
import threading
import time
from pathlib import Path
from urllib.parse import urlsplit, urljoin

from .adapters import GENERIC, LinkedIn, Indeed, adapter_for, family_for, human_check_visible
from .formfill import fill_step
from .formscan import compile_plan, disclosure, plan_digest, scan, signature

LOGIN_PAGES = {'linkedin': 'https://www.linkedin.com/login', 'indeed': 'https://secure.indeed.com/auth',
               'glassdoor': 'https://www.glassdoor.com/profile/login_input.htm', 'wellfound': 'https://wellfound.com/login'}
SESSION_COOKIES = {'linkedin': ('https://www.linkedin.com', ('li_at',)), 'indeed': ('https://www.indeed.com', ('SOCK', 'SHOE')),
                   'glassdoor': ('https://www.glassdoor.com', ('at', 'gdId')), 'wellfound': ('https://wellfound.com', ('_wellfound',))}
TERMINAL_SUBMIT = {'confirmed', 'already_applied'}


class Channel:
    """JSON lines out; commands in through a reader thread (works with Windows pipes)."""

    def __init__(self, stream=None):
        self.loop = asyncio.get_running_loop()
        self.commands = asyncio.Queue()
        self.inputs = asyncio.Queue()
        self.job_updates = asyncio.Queue()
        self.acks = {}
        self.classified, self.classify_waits = {}, {}
        self.denials = {}
        self.closed = asyncio.Event()
        # Soft pause: jobs already on a page finish; no new job starts until resume (or close).
        self.running = asyncio.Event()
        self.running.set()
        self.seq = 0
        self.out = sys.stdout
        if stream is not None:
            threading.Thread(target=self._read, args=(stream,), daemon=True).start()

    def _read(self, stream):
        for line in stream:
            line = line.strip()
            if not line:
                continue
            try:
                command = json.loads(line)
            except ValueError:
                continue
            self.loop.call_soon_threadsafe(self._dispatch, command)
        self.loop.call_soon_threadsafe(self._dispatch, {'type': 'close', 'reason': 'input closed'})

    def _dispatch(self, command):
        if command.get('type') == 'classify_result':
            future = self.classify_waits.pop(command.get('seq'), None)
            if future and not future.done():
                future.set_result(command.get('results') or [])
            return
        if command.get('type') == 'intent_ack':
            future = self.acks.pop(command.get('seq'), None)
            if future and not future.done():
                future.set_result({'recorded':bool(command.get('recorded', True)),'reason':command.get('reason')})
        elif command.get('type') == 'input':
            # Remote-browser input from the person (may contain a password): handled, never echoed or logged.
            if self.inputs.qsize() < 200:
                self.inputs.put_nowait(command)
        elif command.get('type') in ('add_jobs', 'jobs_complete'):
            if self.job_updates.qsize() < 100:
                self.job_updates.put_nowait(command)
        elif command.get('type') == 'pause':
            self.running.clear()
        elif command.get('type') == 'resume':
            self.running.set()
        elif command.get('type') == 'close':
            self.closed.set()
            self.running.set()
            self.job_updates.put_nowait({'type':'jobs_complete'})
            for future in self.acks.values():
                if not future.done():
                    future.set_result(False)

    async def classify(self, kind, texts, timeout=4):
        """Multilingual intent per text from the local server's encoder; None when unsure or unavailable."""
        texts = [str(t or '')[:200] for t in texts]
        missing = [t for t in dict.fromkeys(texts) if (kind, t) not in self.classified and t]
        if missing and not self.closed.is_set():
            self.seq += 1
            seq = self.seq
            future = self.loop.create_future()
            self.classify_waits[seq] = future
            self.emit({'type': 'classify', 'seq': seq, 'kind': kind, 'texts': missing})
            try:
                results = await asyncio.wait_for(future, timeout)
            except asyncio.TimeoutError:
                self.classify_waits.pop(seq, None)
                results = []
            for text, result in zip(missing, list(results) + [None] * len(missing)):
                self.classified[(kind, text)] = result
        return [self.classified.get((kind, t)) for t in texts]

    def emit(self, event):
        event.setdefault('at', time.time())
        self.out.write(json.dumps(event, default=str) + '\n')
        self.out.flush()

    async def intent(self, job_id, digest, timeout=15, **detail):
        """True only when the server confirms it recorded 'submitting' for this job."""
        if self.closed.is_set():
            return False
        self.seq += 1
        seq = self.seq
        future = self.loop.create_future()
        self.acks[seq] = future
        self.emit({'type': 'intent', 'seq': seq, 'job_id': job_id, 'plan_hash': digest, **detail})
        try:
            answer = await asyncio.wait_for(future, timeout)
            if isinstance(answer, dict):
                if not answer['recorded'] and answer.get('reason'): self.denials[job_id] = answer['reason']
                return answer['recorded']
            return bool(answer)
        except asyncio.TimeoutError:
            self.acks.pop(seq, None)
            return False


class Stream:
    """Remote view of one page: JPEG frames out (CDP screencast), the person's clicks and typing in.

    This is how sign-in, CAPTCHA checks and manual completion work from the website (even a phone)
    while the browser itself runs headless on the PC. Typed text is never stored or emitted.
    """

    def __init__(self, emit, channel):
        self.emit, self.channel, self.page, self.cdp, self.seq, self.reason = emit, channel, None, None, 0, None
        self.task = asyncio.ensure_future(self._inputs()) if hasattr(channel, 'inputs') else None

    async def attach(self, page, reason='view', job_id=None):
        if self.page is page and self.cdp:
            return
        await self.detach()
        self.page, self.reason = page, reason
        try:
            self.cdp = await page.context.new_cdp_session(page)
            self.cdp.on('Page.screencastFrame', self._frame)
            await self.cdp.send('Page.startScreencast', {'format': 'jpeg', 'quality': 60, 'maxWidth': 1100, 'maxHeight': 1800, 'everyNthFrame': 1})
            self.emit({'type': 'stream', 'state': 'on', 'reason': reason, 'job_id': job_id, 'url': page.url})
        except Exception as error:
            self.cdp = None
            self.emit({'type': 'stream', 'state': 'unavailable', 'error': str(error).splitlines()[0][:200]})

    def _frame(self, params):
        self.seq += 1
        meta = params.get('metadata') or {}
        try:
            url = self.page.url if self.page and not self.page.is_closed() else ''
        except Exception:
            url = ''
        self.emit({'type': 'frame', 'seq': self.seq, 'data': params.get('data'), 'width': meta.get('deviceWidth'), 'height': meta.get('deviceHeight'), 'url': url})
        if self.cdp:
            asyncio.ensure_future(self._ack(params.get('sessionId')))

    async def _ack(self, session_id):
        try:
            await self.cdp.send('Page.screencastFrameAck', {'sessionId': session_id})
        except Exception:
            pass

    async def detach(self):
        if self.cdp:
            try:
                await self.cdp.send('Page.stopScreencast')
                await self.cdp.detach()
            except Exception:
                pass
        self.cdp, self.page = None, None

    async def _inputs(self):
        while True:
            command = await self.channel.inputs.get()
            page = self.page
            if not page or page.is_closed():
                continue
            try:
                kind = command.get('kind')
                if kind == 'click':
                    await page.mouse.click(float(command['x']), float(command['y']))
                elif kind == 'type':
                    await page.keyboard.type(str(command.get('text', ''))[:500], delay=15)
                elif kind == 'key' and command.get('key') in ('Enter', 'Backspace', 'Tab', 'Escape', 'ArrowDown', 'ArrowUp', 'Space', 'Delete'):
                    await page.keyboard.press(' ' if command['key'] == 'Space' else command['key'])
                elif kind == 'scroll':
                    size = page.viewport_size or {'width': 800, 'height': 800}
                    await page.mouse.move(size['width'] / 2, size['height'] / 2)
                    await page.mouse.wheel(0, max(-2000, min(2000, float(command.get('dy', 0)))))
                elif kind == 'back':
                    await page.go_back(timeout=15000)
                elif kind == 'navigate' and str(command.get('url', '')).startswith('https://'):
                    await page.goto(command['url'], wait_until='domcontentloaded', timeout=30000)
            except Exception as error:
                self.emit({'type': 'stream_input_error', 'error': str(error).splitlines()[0][:160]})


class AutoAck:
    """In-process acknowledgement for tests and the command line: records intents in a list."""

    def __init__(self, record=None, allow=True):
        self.events, self.record, self.allow = [], record if record is not None else [], allow
        self.closed = asyncio.Event()

    def emit(self, event):
        self.events.append(event)

    async def intent(self, job_id, digest, timeout=15, **detail):
        self.record.append({'job_id': job_id, 'plan_hash': digest, **detail})
        self.events.append({'type': 'intent', 'job_id': job_id, 'plan_hash': digest, **detail})
        return self.allow


async def settle(scope, timeout=3.0):
    """Wait until the visible form stops changing (React steps render asynchronously)."""
    deadline = time.monotonic() + timeout
    previous = None
    while time.monotonic() < deadline:
        try:
            current = await signature(scope)
        except Exception:
            current = None
        if current is not None and current == previous:
            return current
        previous = current
        await asyncio.sleep(0.15)
    return previous


async def step_changed(scope, before, timeout=8.0):
    """After Next/Review: True when a different step is shown; False on validation errors or no change."""
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        await asyncio.sleep(0.15)
        try:
            current = await signature(scope)
        except Exception:
            continue
        if current != before:
            await settle(scope)
            return True
        try:
            errors = [t for t in await scope.locator('.artdeco-inline-feedback--error, [role=alert], [aria-invalid=true] ~ .error, .error-message').all_inner_texts() if t.strip()]
        except Exception:
            errors = []
        if errors:
            return False
    return False


async def visible_messages(page, scope, limit=25):
    """Short visible headings/status/dialog texts: where sites announce outcomes in any language."""
    texts = []
    for target in [page] + ([scope] if scope is not page and hasattr(scope, 'locator') else []):
        try:
            texts += await target.locator('h1, h2, h3, [role=alert], [role=status], [role=dialog] h2, [role=dialog] p, .success, [class*=success i], [class*=confirmation i]').evaluate_all(
                "els => els.filter(e => e.offsetParent !== null).map(e => (e.innerText || '').replace(/\\s+/g, ' ').trim()).filter(t => t.length > 6 && t.length < 300)")
        except Exception:
            continue
    return list(dict.fromkeys(texts))[:limit]


async def semantic_confirmation(page, scope, adapter, before):
    """A new message that means "application received" (any language) and a form that is gone."""
    from . import adapters as adapter_module
    if not adapter_module.CLASSIFY:
        return None
    fresh = [t for t in await visible_messages(page, scope) if t not in before.get('_messages', set())]
    if not fresh or await adapter.form_still_open(scope):
        return None
    results = await adapter_module.CLASSIFY('success', fresh)
    for text, result in zip(fresh, results or []):
        if result:
            return {'kind': 'semantic_confirmation', 'text': text[:300], 'url': page.url, 'score': result.get('score')}
    return None


async def await_outcome(page, scope, adapter, before, emit, job, confirm_timeout, human_timeout):
    """Poll for new employer evidence after the final click. Absence is unknown, never success."""
    started = time.monotonic()
    deadline, announced = started + confirm_timeout, False
    while True:
        evidence = await adapter.evidence(page, scope, before)
        if evidence:
            return {'state': 'confirmed', 'evidence': evidence, 'confirmed_at': time.time(), 'confirm_seconds': round(time.monotonic() - started, 3)}
        problem = await adapter.outcome_problem(page, scope, before)
        if problem:
            return {**problem, 'confirm_seconds': round(time.monotonic() - started, 3)}
        semantic = await semantic_confirmation(page, scope, adapter, before)
        if semantic:
            return {'state': 'confirmed', 'evidence': semantic, 'confirmed_at': time.time(), 'confirm_seconds': round(time.monotonic() - started, 3)}
        if await human_check_visible(page):
            if not announced:
                stream = job.get('_stream')
                if stream:
                    await stream.attach(page, 'verification', job['id'])
                emit({'type': 'needs_human', 'job_id': job['id'], 'note': 'The website asks for a human check. Complete it in the live browser view; ApplyBurst never solves it.'})
                announced = True
            deadline = max(deadline, started + human_timeout)
        if time.monotonic() > deadline or page.is_closed():
            return {'state': 'unknown_after_submit', 'note': 'No recognised confirmation appeared. Check the website before retrying; ApplyBurst will not resend.',
                    'url': None if page.is_closed() else page.url, 'confirm_seconds': round(time.monotonic() - started, 3)}
        # Fast confirmations shouldn't pay a fixed quarter-second polling penalty.
        elapsed = time.monotonic() - started
        await asyncio.sleep(0.05 if elapsed < 0.5 else 0.1 if elapsed < 2 else 0.25)


def summarise_steps(steps):
    return [{'step': s['step'], 'questions': len(s['entries']), 'filled_or_kept': sum(e['action'] in ('fill', 'keep') for e in s['entries']),
             'missing': sum(e['action'] == 'missing' for e in s['entries']), 'ms': s.get('ms'), 'fill_ms': s.get('fill_ms')} for s in steps]


async def execute(page, job, request, emit, mode):
    """Bound the automatic preparation lane; final clicks have a separate confirmation budget."""
    budget = (max(3, min(120, float(request.get('fast_prepare_seconds', 60)))) if mode == 'auto'
              else max(15, min(600, float(request.get('prepare_timeout_seconds', 180)))) if mode == 'prepare' else None)
    tick = time.perf_counter()
    try:
        async with asyncio.timeout(budget) as deadline:
            return await _execute(page, job, request, emit, mode, deadline)
    except TimeoutError:
        adapter = adapter_for(job['url'], job.get('family'))
        return {'job_id': job['id'], 'family': adapter.family, 'url': job['url'], 'mode': mode,
                'state': 'deferred_slow', 'elapsed_ms': round((time.perf_counter()-tick)*1000, 1),
                'note': 'Preparation exceeded its time budget. No final click; review or retry this job separately.'}


async def location_policy_blocker(page, job, request, mode='auto'):
    if mode != 'auto':
        return None
    policy = request.get('search_policy') or {}
    if policy.get('work_mode') != 'remote_only':
        return None
    if job.get('workplace') in ('hybrid', 'onsite'):
        return {'state': 'policy_mismatch', 'note': 'Remote-only is selected; this job requires hybrid or onsite work. Nothing sent.'}
    title = await page.title()
    try:
        heading = page.locator('main h1, h1').first
        title += ' ' + await heading.inner_text(timeout=1000)
    except Exception:
        pass
    text = await page.locator('body').inner_text(timeout=3000)
    if re.search(r'\b(?:hybrid|hibrit|on[- ]site|onsite)\b', title, re.I) or re.search(r'\bhybrid (?:role|position|work(?:ing)? (?:model|arrangement))\b|\b(?:in[- ]office|on[- ]site)\s+(?:at least )?\d\s+days?\s+(?:per |a )?week|çalışma modeli\s*[:–-]\s*hibrit', text[:20000], re.I):
        job['workplace'] = 'hybrid' if re.search(r'\b(?:hybrid|hibrit)\b', text[:20000], re.I) else 'onsite'
        return {'state': 'policy_mismatch', 'note': 'The employer page says hybrid/onsite, but you selected remote-only. Nothing sent.'}
    if re.search(r'\b(?:remote|uzaktan)\b', title, re.I) or re.search(r'\b(?:remote|uzaktan çalışma|çalışma modeli\s*[:–-]\s*uzaktan)\b', text[:20000], re.I):
        job['workplace'] = 'remote'
    return None


async def _execute(page, job, request, emit, mode, deadline):
    """Run one job. Returns a result dict; never raises."""
    adapter = adapter_for(job['url'], job.get('family'))
    family = adapter.family if adapter is not GENERIC else None
    base = {'job_id': job['id'], 'family': family, 'url': job['url'], 'mode': mode}
    profile = request.get('profile') or {}
    answers = {**(request.get('answers') or {}), **((request.get('scoped_answers') or {}).get(job['id']) or {})}
    tick, submitted, steps, entries = time.perf_counter(), False, [], []
    timings = {}

    def done(result):
        result = {**base, **result}
        result['elapsed_ms'] = round((time.perf_counter() - tick) * 1000, 1)
        result['timings_ms'] = {key:round(value,1) for key,value in timings.items()}
        if steps:
            result['steps'] = summarise_steps(steps)
        return result

    try:
        visited = job.get('_visited', [])
        if job['url'] in visited:
            return done({'state': 'employer_site_redirect', 'destination': job['url'], 'note': 'The source returned a redirect loop instead of an employer form. Open this posting to review; nothing sent.'})
        job = {**job, '_visited': [*visited, job['url']]}
        try:
            response=await page.goto(job['url'], wait_until='domcontentloaded', timeout=30000)
            timings['navigation']=(time.perf_counter()-tick)*1000
            if response and response.status in (429,999):return done({'state':'rate_limited','http_status':response.status})
        except Exception as error:
            return done({'state': 'failed_before_submit', 'error': 'Could not open the page: ' + str(error).splitlines()[0][:200]})
        landed = adapter_for(page.url)
        if mode != 'inspect':
            mismatch = await location_policy_blocker(page, job, request, mode)
            if mismatch:
                return done(mismatch)
        if landed is not GENERIC and landed.family != family:
            adapter, family = landed, landed.family
            base['family'] = family
        if adapter is GENERIC:
            # Short links and company career pages often redirect to, or embed, a known form family.
            adapter = adapter_for(page.url)
            if adapter is GENERIC:
                try:
                    await page.wait_for_load_state('load', timeout=8000)
                except Exception:
                    pass
                for frame in page.frames[1:]:
                    candidate = adapter_for(frame.url)
                    if candidate is not GENERIC and not candidate.login_required:
                        adapter = candidate
                        break
            family = adapter.family if adapter is not GENERIC else None
            base['family'] = family
        blocked = await adapter.blocker(page)
        if blocked:
            return done(blocked)
        if adapter is GENERIC:
            questions = await scan(page)
            plan = compile_plan(questions, profile, answers, request.get('preferences'))
            return done({'state': 'unsupported_site', 'note': 'No verified adapter for this website yet. Open it to apply yourself.',
                         'questions_seen': len(questions), 'missing': plan['missing'][:30]})
        if mode == 'auto' and not adapter.discovery_only:
            policy = request.get('permission') or {}
            if policy.get('mode') not in ('auto_known','auto_all') or policy.get('paused') or not policy.get('sites',{}).get(family):
                return done({'state':'site_not_enabled','note':'Automatic permission does not include this destination; nothing filled or sent.'})
        stage = time.perf_counter()
        opened = await adapter.open(page, job)
        if isinstance(opened, dict) and opened.get('blocked'):
            return done(opened['blocked'])
        if isinstance(opened, dict) and opened.get('redirect'):
            destination = opened['redirect']
            if family_for(destination) and job.get('_redirects', 0) < 2:
                return await _execute(page, {**job, 'url': destination, 'family': None, '_redirects': job.get('_redirects', 0) + 1}, request, emit, mode, deadline)
            return done({'state': 'employer_site_redirect', 'destination': destination, 'note': 'This job applies on an employer website without a supported adapter.'})
        if isinstance(opened, dict) and opened.get('offsite'):
            destination = await follow_offsite(page, opened['offsite'], job)
            if destination.get('destination'):
                emit({'type': 'route_resolved', 'job_id': job['id'], 'destination': destination['destination'], 'family': destination.get('destination_family')})
            # Resolve LinkedIn's employer handoff in this same task. A known destination still
            # checks its own permission, questions and durable intent before any final click.
            if destination.get('destination') and destination['destination'].startswith('https://') and job.get('_redirects',0) < 3:
                result = await _execute(page,{**job,'url':destination['destination'],'family':None,'_redirects':job.get('_redirects',0)+1},request,emit,mode,deadline)
                return done({**result,'destination':destination['destination']})
            return done(destination)
        if opened is None:
            blocked = await adapter.blocker(page)
            result = blocked or {'state': 'form_not_found', 'note': 'The application form was not found where this adapter expects it.'}
            if mode == 'inspect':
                # Read-only, owner-local diagnostics: no values, resume bytes, cookies or URL queries.
                result['inspect_diagnostic'] = await page.evaluate('''() => ({
                  path: location.origin + location.pathname, title: document.title,
                  controls: [...document.querySelectorAll('button,a[role=button],a[id*=apply i],a[data-testid*=apply i]')].filter(e=>e.getClientRects().length).slice(0,30).map(e=>({tag:e.tagName,id:e.id,test:e.getAttribute('data-testid'),label:(e.getAttribute('aria-label')||e.innerText||'').trim().slice(0,100)})),
                  frames: [...document.querySelectorAll('iframe[src]')].slice(0,5).map(e=>{try{const u=new URL(e.src);return u.origin+u.pathname;}catch{return '';}})
                })''')
            return done(result)
        scope = opened
        await adapter.form_ready(scope)
        timings['open_form']=(time.perf_counter()-stage)*1000
        if mode != 'inspect':
            emit({'type': 'stage', 'job_id': job['id'], 'stage': 'filling'})
        if mode == 'inspect':
            questions = await scan(scope)
            plan = compile_plan(questions, profile, answers, request.get('preferences'))
            final = await adapter.submit_button(scope)
            # What a fill would put where (label -> fact/source), so mappings can be audited without typing.
            mapped = [{'label': e.get('label'), 'kind': e.get('kind'), 'action': e.get('action'), 'source': e.get('source'),
                       'fact': e.get('fact'), 'value': (str(e.get('value'))[:60] if e.get('value') is not None else None)}
                      for e in plan['entries'] if e.get('action') in ('fill', 'keep')]
            return done({'state': 'inspected', 'questions_seen': len(questions), 'missing': plan['missing'], 'mapped': mapped,
                         'final_button_visible': bool(final), 'note': 'Read-only inspection: nothing was typed or sent.'})
        for index in range(12):
            blocked = await adapter.blocker(page)
            if blocked:
                return done(blocked)
            stage = time.perf_counter()
            await settle(scope)
            questions, plan = await fill_step(scope, profile, answers,stop_on_missing=mode=='auto',preferences=request.get('preferences'),classify=request.get('_classify'))
            timings['fill_and_verify']=timings.get('fill_and_verify',0)+(time.perf_counter()-stage)*1000
            steps.append({'step': index + 1, 'entries': plan['entries'], 'ms': round((time.perf_counter()-stage)*1000), 'fill_ms': plan.get('fill_ms')})
            entries.extend(plan['entries'])
            if plan['missing']:
                return done({'state': 'needs_answers', 'missing': plan['missing'], 'disclosure': disclosure(entries),
                             'note': 'Answer these questions in ApplyBurst; nothing was submitted.'})
            final = await adapter.submit_button(scope)
            if final:
                digest = plan_digest(entries)
                if mode in ('prepare', 'open'):
                    return done({'state': 'ready_to_submit', 'plan_hash': digest, 'disclosure': disclosure(entries),
                                 'note': 'Every required field is known. Stopped before the final button.'})
                fields=disclosure(entries)
                if mode=='auto':
                    policy=request.get('permission') or {}
                    sources={'resume','approved_answer','derived_from_phone','derived_from_location','user_preference'}
                    if policy.get('mode')=='auto_all':sources.add('site_prefilled')
                    if policy.get('mode') not in ('auto_known','auto_all') or policy.get('paused') or not policy.get('sites',{}).get(family) or any(row.get('source') not in sources for row in fields):
                        prefilled=[row.get('label','Field') for row in fields if row.get('source')=='site_prefilled']
                        note=('Website-prefilled values need permission ('+', '.join(prefilled[:3])+'). Enable "Also use values a website prefilled" under Auto-submit, or review and tap Submit.'
                              if prefilled and policy.get('mode')=='auto_known' else 'Automatic permission does not cover this form; nothing sent.')
                        return done({'state':'ready_to_submit','plan_hash':digest,'disclosure':fields,'note':note})
                expected = job.get('expected_plan')
                if mode!='auto' and (not expected or expected != digest):
                    return done({'state': 'plan_changed', 'plan_hash': digest, 'disclosure': disclosure(entries),
                                 'note': 'The form or its values differ from the reviewed plan. Review again; nothing was submitted.'})
                before = await adapter.snapshot(page, scope)
                mismatch = await location_policy_blocker(page, job, request, mode)
                if mismatch:
                    return done(mismatch)
                before['_messages'] = set(await visible_messages(page, scope))
                scope_url=getattr(scope,'url',None)
                stage = time.perf_counter()
                # Stop the preparation deadline BEFORE requesting intent. Once a final click
                # might be authorized, only the normal confirmed/unknown protocol applies.
                deadline.reschedule(None)
                if not await emit_intent(request, job, digest,disclosure=fields,family=family,destination=scope_url if isinstance(scope_url,str) else page.url,workplace=job.get('workplace')):
                    return done({'state': 'failed_before_submit', 'note': getattr(request['_channel'],'denials',{}).get(job['id']) or 'The submission was not recorded first, so the final button was not clicked.'})
                timings['durable_ack']=(time.perf_counter()-stage)*1000
                submitted = True
                stage = time.perf_counter()
                await final.click(timeout=10000)
                outcome = await await_outcome(page, scope, adapter, before, request['_emit'], job,
                                              request.get('confirm_timeout', 45), request.get('human_timeout', 600))
                timings['click_and_confirm']=(time.perf_counter()-stage)*1000
                return done({**outcome, 'plan_hash': digest})
            advance = await adapter.advance_button(scope)
            if not advance:
                return done({'state': 'adapter_needs_update', 'note': 'No recognised Next or Submit button on this step.', 'disclosure': disclosure(entries)})
            before_sig = await signature(scope)
            stage = time.perf_counter()
            await advance.click(timeout=10000)
            changed = await step_changed(scope, before_sig)
            timings['step_transitions']=timings.get('step_transitions',0)+(time.perf_counter()-stage)*1000
            if not changed:
                questions = await scan(scope)
                errors = [q for q in questions if q.get('error')]
                # Every question this step left empty (judged optional, or its value did not stay). When the
                # site refuses the step, those are the likely required ones: ask the person instead of
                # reporting an unrecognised form.
                left = [e for e in plan['entries'] if e.get('action') in ('skip', 'missing')]
                debug = await save_step_debug(request, job, page, scope, index + 1)
                step_detail = [{'label': e.get('label'), 'kind': e.get('kind'), 'action': e.get('action'), 'source': e.get('source'),
                                'problem': e.get('problem')} for e in plan['entries']][:30]
                if errors or left:
                    missing = [{'fingerprint': None, 'label': q['label'], 'kind': q['kind'], 'error': q['error']} for q in errors]
                    choices = {q.get('label'): [o.get('label') for o in q.get('options') or []] or None for q in questions}
                    missing += [{'fingerprint': e.get('fingerprint'), 'label': e.get('label') or '(unlabelled question)', 'kind': e.get('kind'),
                                 'options': choices.get(e.get('label')), 'problem': e.get('problem')} for e in left
                                if not any(m['label'] == e.get('label') for m in missing)]
                    return done({'state': 'needs_answers', 'missing': missing[:20], 'step_detail': step_detail, 'debug': debug,
                                 'note': 'The website did not accept this step. Answer the questions below and retry; nothing was submitted.'})
                return done({'state': 'adapter_needs_update', 'note': 'The website did not accept this step.', 'step_detail': step_detail, 'debug': debug})
        return done({'state': 'adapter_needs_update', 'note': 'More steps than this adapter allows.'})
    except Exception as error:
        message = str(error).splitlines()[0][:300] if str(error) else type(error).__name__
        return done({'state': 'unknown_after_submit' if submitted else 'failed_before_submit', 'error': message})


async def save_step_debug(request, job, page, scope, step):
    """Keep the refused step's HTML and a screenshot in the local data folder (never uploaded) so a
    rejected application step can be diagnosed. Only the 20 newest captures are kept."""
    try:
        folder = Path(request['browser_profile']).resolve().parent / 'debug'
        folder.mkdir(parents=True, exist_ok=True)
        stem = re.sub(r'[^A-Za-z0-9_-]+', '_', str(job.get('id') or 'job'))[:80] + f'-step{step}-{int(time.time())}'
        html = await scope.evaluate('e => e.outerHTML') if hasattr(scope, 'evaluate') and scope is not page else await page.content()
        (folder / (stem + '.html')).write_text(html, encoding='utf-8')
        try:
            await page.screenshot(path=str(folder / (stem + '.png')), full_page=False, timeout=5000)
        except Exception:
            pass
        captures = sorted(folder.glob('*.html'), key=lambda p: p.stat().st_mtime)
        for old in captures[:-20]:
            old.unlink(missing_ok=True)
            old.with_suffix('.png').unlink(missing_ok=True)
        return str(folder / (stem + '.html'))
    except Exception:
        return None


async def emit_intent(request, job, digest,**detail):
    return await request['_channel'].intent(job['id'], digest,**detail)


async def follow_offsite(page, link, job):
    """A listing's Apply link: locate its real destination without assuming it is a form."""
    context = page.context
    href = await link.get_attribute('href')
    resolved = urljoin(page.url, href) if href else None
    if resolved and resolved.startswith('https://') and resolved.split('#')[0] != page.url.split('#')[0]:
        return {'state':'employer_site_redirect','destination':resolved,'destination_family':family_for(resolved)}
    # Watch this page's own popup and same-tab navigation concurrently. A context-level
    # listener could capture and close another application's new tab. Waiting only for a
    # popup also adds an eight-second delay to ordinary same-tab Apply buttons.
    previous = page.url.split('#')[0]
    popup_wait = asyncio.create_task(page.wait_for_event('popup', timeout=8000))
    navigation_wait = asyncio.create_task(page.wait_for_url(lambda url: str(url).split('#')[0] != previous, timeout=8000, wait_until='domcontentloaded'))
    popup = None
    try:
        await link.click()
        completed, _ = await asyncio.wait([popup_wait, navigation_wait], return_when=asyncio.FIRST_COMPLETED)
        if navigation_wait in completed and not navigation_wait.exception():
            destination = page.url
        else:
            popup = await popup_wait
            await popup.wait_for_url(re.compile(r'^https?://'), timeout=15000)
            await popup.wait_for_load_state('domcontentloaded', timeout=15000)
            destination = popup.url
    except Exception:
        destination = page.url
    finally:
        for waiting in (popup_wait, navigation_wait):
            if not waiting.done():
                waiting.cancel()
        await asyncio.gather(popup_wait, navigation_wait, return_exceptions=True)
        if popup is None and popup_wait.done() and not popup_wait.cancelled() and popup_wait.exception() is None:
            popup = popup_wait.result()
        if popup is not None and not popup.is_closed():
            await popup.close()
    return {'state': 'employer_site_redirect', 'destination': destination, 'destination_family': family_for(destination),
            'note': 'This job is applied for on the employer website. Prepare it from that destination.'}


async def run_jobs(context, request, emit, channel):
    """Process jobs: LinkedIn sequentially with pacing, other hosts with bounded concurrency."""
    mode = request['task']
    request['_emit'], request['_channel'] = emit, channel
    jobs = request.get('jobs', [])[:50]
    linked = [j for j in jobs if isinstance(adapter_for(j['url'], j.get('family')), LinkedIn)]
    indeed = [j for j in jobs if isinstance(adapter_for(j['url'], j.get('family')), Indeed)]
    others = [j for j in jobs if j not in linked and j not in indeed]
    results, kept = [], []
    slots = asyncio.Semaphore(max(1,min(4,int(request.get('concurrency',2)))))
    circuits={}
    keep_states = {'needs_answers', 'unknown_after_submit', 'submit_rejected', 'needs_human_verification', 'plan_changed', 'ready_to_submit', 'adapter_needs_update'}
    headless = request.get('headless', False)

    stream = request.get('_stream')

    async def handle_one(job):
        if hasattr(channel, 'running') and not channel.running.is_set():
            emit({'type': 'job_paused', 'job_id': job['id']})
            await channel.running.wait()
        if channel.closed.is_set():
            return
        job_adapter=adapter_for(job['url'], job.get('family'))
        origin='platform:'+job_adapter.family if job_adapter.login_required else urlsplit(job['url']).netloc
        if origin in circuits:
            result={'job_id':job['id'],'state':circuits[origin],'mode':mode,'note':'Skipped after this origin required login/verification or limited the run.'};results.append(result);emit({'type':'result',**result});return
        page = await context.new_page()
        page.on('dialog', lambda dialog: asyncio.ensure_future(dialog.dismiss()))
        emit({'type': 'job_started', 'job_id': job['id']})
        job = {**job, '_stream': stream}
        result = await execute(page, job, request, emit, mode)
        if mode=='auto' and result['state'] in ('rate_limited','needs_login','needs_human_verification'):circuits[origin]=result['state']
        results.append(result)
        emit({'type': 'result', **result})
        keep = (not headless) and (mode == 'open' or (mode != 'prepare' and result['state'] in keep_states) or (mode == 'prepare' and request.get('keep_open') and result['state'] in keep_states))
        if keep and not page.is_closed():
            kept.append((page, job, result))
            if mode == 'open' and stream:
                # Hand the filled form to the person in the live view to finish and submit themselves.
                await stream.attach(page, 'manual', job['id'])
        elif not page.is_closed():
            await page.close()

    async def handle(job):
        # LinkedIn's sequential lane shares the same total page budget as other employers.
        async with slots:
            await handle_one(job)

    async def sequential(items, pace):
        for position, job in enumerate(items):
            if position and pace:
                await asyncio.sleep(pace)
            await handle(job)
            if results and results[-1]['state'] == 'rate_limited':
                for rest in items[position + 1:]:
                    skipped = {'job_id': rest['id'], 'state': 'not_started', 'note': 'Stopped after the site reported a rate limit.', 'mode': mode}
                    results.append(skipped)
                    emit({'type': 'result', **skipped})
                return

    async def pool(items, size):
        queue = list(items)

        async def worker():
            while queue:
                await handle(queue.pop(0))
        await asyncio.gather(*(worker() for _ in range(max(1, min(size, len(queue))))))

    if mode in ('auto', 'prepare') and request.get('stream_jobs') and hasattr(channel, 'job_updates'):
        # Discovery feeds this one warm context while HTTP searches are still running.
        # The two lanes share the same total page semaphore, including LinkedIn.
        linked_queue, indeed_queue, other_queue = asyncio.Queue(), asyncio.Queue(), asyncio.Queue()
        seen = set()
        size = max(1, min(4, int(request.get('concurrency', 2))))

        def enqueue(items):
            for job in items[:50]:
                if len(seen) >= 50 or not job.get('id') or job['id'] in seen: continue
                seen.add(job['id'])
                adapter = adapter_for(job['url'], job.get('family'))
                queue = linked_queue if isinstance(adapter, LinkedIn) else indeed_queue if isinstance(adapter, Indeed) else other_queue
                queue.put_nowait(job)

        async def produce():
            enqueue(jobs)
            while not channel.closed.is_set():
                command = await channel.job_updates.get()
                if command.get('type') == 'jobs_complete': break
                if command.get('type') == 'add_jobs': enqueue(command.get('jobs') or [])
            linked_queue.put_nowait(None)
            indeed_queue.put_nowait(None)
            for _ in range(size): other_queue.put_nowait(None)

        async def consume(queue, pace=0):
            previous = False
            while True:
                job = await queue.get()
                if job is None: return
                if previous and pace: await asyncio.sleep(pace)
                await handle(job)
                previous = True

        await asyncio.gather(produce(), consume(linked_queue, request.get('linkedin_pace_seconds', 2)), consume(indeed_queue, request.get('indeed_pace_seconds', 2)), *(consume(other_queue) for _ in range(size)))
    else:
        await asyncio.gather(sequential(linked, request.get('linkedin_pace_seconds', 2.0)), sequential(indeed, request.get('indeed_pace_seconds', 2.0)), pool(others, request.get('concurrency', 2)))
    return results, kept


async def watch_open_pages(kept, emit, channel, max_seconds=1800):
    """Keep handed-over pages open; report a confirmation the person reaches by themselves."""
    from .formscan import scan as _scan  # noqa: F401  (pages may be scanned by future checks)
    watched = []
    for page, job, result in kept:
        adapter = adapter_for(job['url'], job.get('family'))
        try:
            scope = page
            before = await adapter.snapshot(page, scope)
        except Exception:
            continue
        watched.append({'page': page, 'job': job, 'adapter': adapter, 'before': before, 'reported': False})
    if not watched:
        return
    emit({'type': 'waiting_for_user', 'open_jobs': [w['job']['id'] for w in watched]})
    deadline = time.monotonic() + max_seconds
    while not channel.closed.is_set() and time.monotonic() < deadline:
        live = [w for w in watched if not w['page'].is_closed() and not w['reported']]
        if not live:
            break
        for item in live:
            try:
                evidence = await item['adapter'].evidence(item['page'], item['page'], item['before'])
            except Exception:
                evidence = None
            if evidence:
                item['reported'] = True
                emit({'type': 'observed_confirmation', 'job_id': item['job']['id'], 'evidence': evidence, 'confirmed_at': time.time(),
                      'note': 'Confirmation observed after the person completed the form in the browser.'})
        try:
            await asyncio.wait_for(channel.closed.wait(), 1.0)
        except asyncio.TimeoutError:
            pass


async def session_status(context, sites):
    status = {}
    for site in sites:
        origin, names = SESSION_COOKIES[site]
        cookies = await context.cookies(origin)
        found = [c for c in cookies if c['name'] in names]
        status[site] = {'signed_in': bool(found), 'expires': max((c.get('expires', -1) for c in found), default=None),
                        'evidence': 'session cookie present' if found else 'no session cookie'}
    return status


INSTALLED = {
    'chrome': [r'C:\Program Files\Google\Chrome\Application\chrome.exe', r'C:\Program Files (x86)\Google\Chrome\Application\chrome.exe',
               os.path.expandvars(r'%LOCALAPPDATA%\Google\Chrome\Application\chrome.exe'), '/usr/bin/google-chrome', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'],
    'msedge': [r'C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe', r'C:\Program Files\Microsoft\Edge\Application\msedge.exe', '/usr/bin/microsoft-edge'],
}


def installed_browser(preferred=None):
    """An installed Chrome or Edge. Sign-in pages (Google SSO) refuse automation-controlled browsers."""
    for channel in ([preferred] if preferred in INSTALLED else []) + ['chrome', 'msedge']:
        for path in INSTALLED[channel]:
            if path and Path(path).is_file():
                return channel, path
    return None, None


def profile_channel(profile, request):
    """A profile stays paired with the browser that created its session (cookie encryption)."""
    explicit = request.get('browser_channel') or os.environ.get('APPLYBURST_BROWSER_CHANNEL')
    if explicit:
        return explicit
    meta = Path(profile) / 'applyburst-browser.json'
    try:
        return json.loads(meta.read_text(encoding='utf-8')).get('channel') or 'chromium'
    except (OSError, ValueError):
        return 'chromium'


def cookie_names(profile, host_suffix):
    """Names (never values) of stored cookies for a host, read from a copy of the cookie database."""
    for relative in ('Default/Network/Cookies', 'Default/Cookies'):
        source = Path(profile) / relative
        if not source.is_file():
            continue
        with tempfile.TemporaryDirectory(ignore_cleanup_errors=True) as folder:
            copy = Path(folder) / 'Cookies'
            try:
                shutil.copyfile(source, copy)
                db = sqlite3.connect(f'file:{copy}?mode=ro', uri=True)
                try:
                    rows = db.execute('SELECT name, expires_utc FROM cookies WHERE host_key LIKE ?', ('%' + host_suffix,)).fetchall()
                finally:
                    db.close()
                return {name: expires for name, expires in rows}
            except (OSError, sqlite3.Error):
                return None
    return {}


async def plain_login(request, emit):
    """Open the installed browser on ApplyBurst's private profile with no automation attached.

    The person signs in exactly as in their normal browser (including Google sign-in). ApplyBurst
    only checks afterwards that a session cookie name exists; it never reads cookie values.
    """
    site = request['site']
    profile = Path(request['browser_profile']).resolve()
    profile.mkdir(parents=True, exist_ok=True)
    channel, executable = installed_browser(request.get('browser_channel'))
    if not executable:
        emit({'type': 'error', 'message': 'Install Google Chrome or Microsoft Edge to sign in.'})
        return
    (profile / 'applyburst-browser.json').write_text(json.dumps({'channel': channel}), encoding='utf-8')
    url = LOGIN_PAGES.get(site) or request.get('url')
    process = subprocess.Popen([executable, f'--user-data-dir={profile}', '--no-first-run', '--no-default-browser-check', '--disable-gpu', '--new-window', url])
    emit({'type': 'started', 'task': 'login', 'pid': process.pid, 'browser': channel, 'automation': False, 'gpu_enabled': False, 'model_calls': 0})
    origin_host = {'linkedin': 'linkedin.com', 'indeed': 'indeed.com', 'glassdoor': 'glassdoor.com', 'wellfound': 'wellfound.com'}.get(site, '')
    wanted = SESSION_COOKIES.get(site, ('', ()))[1]
    deadline, last = time.monotonic() + request.get('login_seconds', 2700), None
    while process.poll() is None and time.monotonic() < deadline:
        names = cookie_names(profile, origin_host) or {}
        signed = any(name in names for name in wanted)
        if signed != last:
            emit({'type': 'login_state', 'site': site, 'signed_in': signed, 'evidence': 'session cookie present' if signed else 'no session cookie yet', 'browser': channel})
            last = signed
        await asyncio.sleep(2.0)
    if process.poll() is None:
        process.terminate()
    await asyncio.sleep(1.0)
    names = cookie_names(profile, origin_host) or {}
    signed = any(name in names for name in wanted)
    emit({'type': 'login_state', 'site': site, 'signed_in': signed, 'evidence': 'session cookie present' if signed else 'no session cookie', 'browser': channel, 'final': True})


async def launch(playwright, request):
    profile = Path(request['browser_profile']).resolve()
    profile.mkdir(parents=True, exist_ok=True)
    options = {'headless': bool(request.get('headless', False)), 'args': ['--disable-gpu', '--no-first-run', '--no-default-browser-check'],
               'locale': 'en-US', 'accept_downloads': False}
    if options['headless']:
        options['viewport'] = {'width': 1280, 'height': 900}
    else:
        options['no_viewport'] = True
    channel = profile_channel(profile, request)
    if channel and channel != 'chromium':
        options['channel'] = channel
    return await playwright.chromium.launch_persistent_context(str(profile), **options)


async def main_async(request, stream):
    from playwright.async_api import async_playwright
    channel = Channel(stream)
    emit = channel.emit
    task = request.get('task')
    started = time.perf_counter()
    lock = Path(request['browser_profile']) / 'applyburst.lock'
    try:
        Path(request['browser_profile']).mkdir(parents=True, exist_ok=True)
        lock.write_text(json.dumps({'pid': os.getpid(), 'task': task, 'started_at': time.time()}), encoding='utf-8')
        if task == 'login' and request.get('plain', True):
            await plain_login(request, emit)
            return
        async with async_playwright() as playwright:
            if task == 'login':
                request['headless'] = False
            if task == 'session':
                request['headless'] = True
            context = await launch(playwright, request)
            async def close_when_requested():
                await channel.closed.wait()
                try:await context.close()
                except Exception:pass
            stop_task=asyncio.create_task(close_when_requested())
            emit({'type': 'started', 'task': task, 'pid': os.getpid(), 'headless': bool(request.get('headless')), 'gpu_enabled': False, 'model_calls': 0})
            try:
                if task == 'session':
                    emit({'type': 'session', 'sites': await session_status(context, request.get('sites') or list(SESSION_COOKIES))})
                elif task == 'live':
                    # Remote browser on the website: sign-in or a person's own steps, streamed to the page.
                    site = request.get('site')
                    page = context.pages[0] if context.pages else await context.new_page()
                    width, height = int(request.get('width') or 1100), int(request.get('height') or 900)
                    await page.set_viewport_size({'width': max(360, min(1400, width)), 'height': max(560, min(1600, height))})
                    stream = Stream(emit, channel)
                    url = request.get('url') or LOGIN_PAGES.get(site) or 'https://www.linkedin.com/login'
                    await page.goto(url, wait_until='domcontentloaded', timeout=30000)
                    await stream.attach(page, request.get('reason') or 'sign_in')
                    last, deadline = None, time.monotonic() + int(request.get('live_seconds', 1800))
                    context.on('page', lambda new: asyncio.ensure_future(stream.attach(new, 'popup')))
                    while not channel.closed.is_set() and time.monotonic() < deadline:
                        if site in SESSION_COOKIES:
                            state = (await session_status(context, [site]))[site]
                            if state['signed_in'] != last:
                                emit({'type': 'login_state', 'site': site, **state, 'browser': profile_channel(request['browser_profile'], request)})
                                last = state['signed_in']
                        open_pages = [p for p in context.pages if not p.is_closed()]
                        if not open_pages:
                            break
                        if stream.page is None or stream.page.is_closed():
                            await stream.attach(open_pages[-1], 'view')
                        try:
                            await asyncio.wait_for(channel.closed.wait(), 1.5)
                        except asyncio.TimeoutError:
                            pass
                    await stream.detach()
                elif task == 'login':
                    # The person signs in themselves; ApplyBurst only watches for the session cookie.
                    site = request['site']
                    page = context.pages[0] if context.pages else await context.new_page()
                    await page.goto(LOGIN_PAGES.get(site, request.get('url') or LOGIN_PAGES['linkedin']), wait_until='domcontentloaded')
                    last, deadline = None, time.monotonic() + request.get('login_seconds', 2700)
                    window_mode = bool(request.get('until_window_closed'))
                    while time.monotonic() < deadline and (window_mode or not channel.closed.is_set()):
                        if not [p for p in context.pages if not p.is_closed()]:
                            break
                        try:
                            state = (await session_status(context, [site]))[site]
                        except Exception:
                            break
                        if state['signed_in'] != last:
                            emit({'type': 'login_state', 'site': site, **state})
                            last = state['signed_in']
                        await asyncio.sleep(2.0)
                elif task in ('prepare', 'submit', 'inspect', 'open','auto'):
                    if stream is not None:
                        from . import adapters as adapter_module
                        request['_classify'] = adapter_module.CLASSIFY = channel.classify
                    request['_stream'] = Stream(emit, channel) if stream is not None else None
                    results, kept = await run_jobs(context, request, emit, channel)
                    counts = {}
                    for row in results:
                        counts[row['state']] = counts.get(row['state'], 0) + 1
                    emit({'type': 'finished', 'task': task, 'counts': counts, 'elapsed_seconds': round(time.perf_counter() - started, 3)})
                    await watch_open_pages(kept, emit, channel, request.get('watch_seconds', 1800))
                    if request.get('_stream'):
                        await request['_stream'].detach()
                else:
                    emit({'type': 'error', 'message': 'Unknown task.'})
            finally:
                stop_task.cancel()
                try:
                    await context.close()
                except Exception:
                    pass  # the person may already have closed the window
    except Exception as error:
        emit({'type': 'error', 'message': str(error).splitlines()[0][:400] if str(error) else type(error).__name__})
    finally:
        try:
            lock.unlink()
        except OSError:
            pass
        emit({'type': 'exit', 'elapsed_seconds': round(time.perf_counter() - started, 3)})


def main(argv=None):
    parser = argparse.ArgumentParser(description='ApplyBurst local browser companion')
    parser.add_argument('--request', default='-', help='Task JSON file, or - to read the first stdin line')
    args = parser.parse_args(argv)
    # The JSON-lines protocol is UTF-8 in both directions, including Windows/frozen entry points
    # launched without PYTHONIOENCODING. Reconfiguring only stdout corrupted non-ASCII input.
    for stream in (sys.stdin, sys.stdout, sys.stderr):
        if hasattr(stream, 'reconfigure'):
            stream.reconfigure(encoding='utf-8')
    if args.request == '-':
        request = json.loads(sys.stdin.readline())
        stream = sys.stdin
    else:
        # Command-line use: no command channel, so no intent can be acknowledged and nothing is submitted.
        request = json.loads(Path(args.request).read_text(encoding='utf-8'))
        stream = None
    asyncio.run(main_async(request, stream))


if __name__ == '__main__':
    main()
