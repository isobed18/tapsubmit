"""The production companion against loopback form families, including failure paths.

Real Chromium, synthetic data, loopback receiver only. Each test checks what the receiver got,
so "confirmed" is never accepted without exactly one recorded submission behind it.
"""
import hashlib
import os
from contextlib import asynccontextmanager

import pytest

from applyburst.companion import AutoAck, run_jobs
from applyburst.fixture import RESUME
from applyburst.form_fixtures import make_app
from applyburst.harness import serve

os.environ.setdefault('PLAYWRIGHT_BROWSERS_PATH', r'D:\cache\ms-playwright' if os.name == 'nt' else os.environ.get('PLAYWRIGHT_BROWSERS_PATH', ''))
pytest.importorskip('playwright')


@pytest.fixture
def profile(tmp_path):
    resume = tmp_path / 'synthetic-resume.txt'
    resume.write_bytes(RESUME)
    return {'name': 'Demo Middle Candidate', 'email': 'candidate@example.test', 'phone': '+90 555 000 00 00', 'location': 'Ankara, Turkiye',
            'linkedin': 'https://www.linkedin.com/in/demo-candidate', 'github': 'https://github.com/demo-candidate', 'resume_path': str(resume)}


@asynccontextmanager
async def lab():
    from playwright.async_api import async_playwright
    app = make_app()
    async with serve(app) as base, async_playwright() as pw:
        browser = await pw.chromium.launch(headless=True, args=['--disable-gpu'])
        context = await browser.new_context(locale='en-US')
        try:
            yield app, base, context
        finally:
            await context.close()
            await browser.close()


async def run(context, jobs, task, profile, answers=None, allow=True, **extra):
    ack = AutoAck(allow=allow)
    request = {'task': task, 'jobs': jobs, 'profile': profile, 'answers': answers or {}, 'headless': True, 'confirm_timeout': 4, 'human_timeout': 5, **extra}
    results, kept = await run_jobs(context, request, ack.emit, ack)
    for page, _, _ in kept:
        await page.close()
    return results, ack


def answer(missing, mapping):
    """Approve answers by question wording, the way a person does in the review screen."""
    found = {}
    for item in missing:
        for label, value in mapping.items():
            if label.lower() in item['label'].lower():
                found[item['fingerprint']] = value
    return found


def job(base, path, family, ident='j1'):
    return {'id': ident, 'url': base + path, 'family': family}


RESUME_SHA = hashlib.sha256(RESUME).hexdigest()


async def test_greenhouse_review_then_exact_submit_confirms(profile):
    async with lab() as (app, base, context):
        target = job(base, '/gh/ok/jobs/101', 'greenhouse')
        first, _ = await run(context, [target], 'prepare', profile)
        assert first[0]['state'] == 'needs_answers'
        assert [m['label'] for m in first[0]['missing']] == ['Will you now or in the future require visa sponsorship?*']
        assert first[0]['missing'][0]['options'] == ['Yes', 'No']
        answers = answer(first[0]['missing'], {'visa sponsorship': 'No'})
        ready, _ = await run(context, [target], 'prepare', profile, answers)
        assert ready[0]['state'] == 'ready_to_submit', ready[0]
        shown = {row['label']: row['value'] for row in ready[0]['disclosure']}
        assert shown['First Name*'] == 'Demo Middle' and shown['Last Name*'] == 'Candidate'
        assert shown['Country*'] == 'Turkey +90' and shown['Phone*'] == '5550000000'
        assert shown['Location (City)'] == 'Ankara, Ankara, Turkey'
        assert app.state.submissions == []
        done, ack = await run(context, [{**target, 'expected_plan': ready[0]['plan_hash']}], 'submit', profile, answers)
        assert done[0]['state'] == 'confirmed', done[0]
        assert done[0]['evidence']['kind'] == 'confirmation_url'
        assert len(ack.record) == 1 and len(app.state.submissions) == 1
        sent = app.state.submissions[0]
        assert sent['fields'] == {'first_name': 'Demo Middle', 'last_name': 'Candidate', 'email': 'candidate@example.test', 'country': 'Turkey +90',
                                  'phone': '5550000000', 'question_1': 'https://www.linkedin.com/in/demo-candidate', 'question_2': 'No', 'location': 'Ankara, Ankara, Turkey'}
        assert sent['files']['resume']['sha256'] == RESUME_SHA


async def test_conditional_and_unknown_required_questions_stop_for_answers(profile):
    async with lab() as (app, base, context):
        target = job(base, '/gh/ok/jobs/102', 'greenhouse')
        first, _ = await run(context, [target], 'prepare', profile)
        answers = answer(first[0]['missing'], {'visa sponsorship': 'Yes'})
        second, _ = await run(context, [target], 'prepare', profile, answers)
        assert second[0]['state'] == 'needs_answers'
        assert [m['label'] for m in second[0]['missing']] == ['Please describe your sponsorship needs*']
        unknown, _ = await run(context, [job(base, '/gh/unknown_required/jobs/103', 'greenhouse')], 'prepare', profile, answers)
        assert 'Why do you want to work here?*' in [m['label'] for m in unknown[0]['missing']]
        assert app.state.submissions == []


async def test_changed_plan_or_unrecorded_intent_never_clicks(profile):
    async with lab() as (app, base, context):
        target = job(base, '/gh/ok/jobs/104', 'greenhouse')
        first, _ = await run(context, [target], 'prepare', profile)
        answers = answer(first[0]['missing'], {'visa sponsorship': 'No'})
        ready, _ = await run(context, [target], 'prepare', profile, answers)
        changed, ack = await run(context, [{**target, 'expected_plan': '0' * 64}], 'submit', profile, answers)
        assert changed[0]['state'] == 'plan_changed' and ack.record == []
        refused, ack = await run(context, [{**target, 'expected_plan': ready[0]['plan_hash']}], 'submit', profile, answers, allow=False)
        assert refused[0]['state'] == 'failed_before_submit' and len(ack.record) == 1
        assert app.state.submissions == []


async def test_missing_or_stale_confirmation_stays_unknown(profile):
    async with lab() as (app, base, context):
        for scenario in ('no_confirmation', 'preexisting_thanks'):
            target = job(base, f'/gh/{scenario}/jobs/105', 'greenhouse', scenario)
            first, _ = await run(context, [target], 'prepare', profile)
            answers = answer(first[0]['missing'], {'visa sponsorship': 'No'})
            ready, _ = await run(context, [target], 'prepare', profile, answers)
            done, _ = await run(context, [{**target, 'expected_plan': ready[0]['plan_hash']}], 'submit', profile, answers)
            assert done[0]['state'] == 'unknown_after_submit', (scenario, done[0])
        # The receiver did get both; ApplyBurst just could not prove it, so it must not claim it.
        assert len(app.state.submissions) == 2


async def test_rejection_after_click_is_not_confirmed(profile):
    async with lab() as (app, base, context):
        target = job(base, '/gh/server_error/jobs/106', 'greenhouse')
        first, _ = await run(context, [target], 'prepare', profile)
        answers = answer(first[0]['missing'], {'visa sponsorship': 'No'})
        ready, _ = await run(context, [target], 'prepare', profile, answers)
        done, _ = await run(context, [{**target, 'expected_plan': ready[0]['plan_hash']}], 'submit', profile, answers)
        assert done[0]['state'] == 'submit_rejected' and 'problem submitting' in done[0]['note']
        assert app.state.submissions == [] and len(app.state.rejections) == 1


async def test_embedded_greenhouse_iframe(profile):
    async with lab() as (app, base, context):
        target = job(base, '/embed/ok/107', 'greenhouse')
        first, _ = await run(context, [target], 'prepare', profile)
        answers = answer(first[0]['missing'], {'visa sponsorship': 'No'})
        ready, _ = await run(context, [target], 'prepare', profile, answers)
        assert ready[0]['state'] == 'ready_to_submit', ready[0]
        done, _ = await run(context, [{**target, 'expected_plan': ready[0]['plan_hash']}], 'submit', profile, answers)
        assert done[0]['state'] == 'confirmed' and done[0]['evidence']['url'].endswith('/jobs/107/confirmation?embed=1')
        assert len(app.state.submissions) == 1


async def test_lever_radio_and_checkbox_groups(profile):
    async with lab() as (app, base, context):
        target = job(base, '/lever/ok/201', 'lever')
        first, _ = await run(context, [target], 'prepare', profile)
        assert first[0]['state'] == 'needs_answers'
        assert [(m['label'], m['options']) for m in first[0]['missing']] == [('Are you legally authorized to work in Turkey?✱', ['Yes', 'No'])]
        answers = answer(first[0]['missing'], {'authorized to work': 'Yes'})
        languages = {'Which languages do you speak professionally?': ['English', 'Turkish']}
        from applyburst.formscan import fingerprint
        answers[fingerprint({'label': 'Which languages do you speak professionally?', 'kind': 'checkbox_group',
                             'options': [{'label': 'English'}, {'label': 'Turkish'}, {'label': 'German'}]})] = languages['Which languages do you speak professionally?']
        ready, _ = await run(context, [target], 'prepare', profile, answers)
        assert ready[0]['state'] == 'ready_to_submit', ready[0]
        done, _ = await run(context, [{**target, 'expected_plan': ready[0]['plan_hash']}], 'submit', profile, answers)
        assert done[0]['state'] == 'confirmed' and done[0]['evidence']['kind'] == 'confirmation_url'
        sent = app.state.submissions[0]
        assert sent['fields']['name'] == 'Demo Middle Candidate' and sent['fields']['phone'] == '+90 555 000 00 00'
        assert sent['fields']['cards[c1][field0]'] == 'Yes' and sent['fields']['cards[c1][field1]'] == ['English', 'Turkish']
        assert sent['fields']['urls[GitHub]'] == 'https://github.com/demo-candidate' and 'consent[marketing]' not in sent['fields']
        assert sent['files']['resume']['sha256'] == RESUME_SHA


async def test_lever_captcha_and_duplicate_outcomes(profile):
    async with lab() as (app, base, context):
        for scenario, expected in (('captcha', 'unknown_after_submit'), ('already_applied', 'already_applied')):
            target = job(base, f'/lever/{scenario}/202/apply', 'lever', scenario)
            first, _ = await run(context, [target], 'prepare', profile)
            answers = answer(first[0]['missing'], {'authorized to work': 'Yes'})
            ready, _ = await run(context, [target], 'prepare', profile, answers)
            done, ack = await run(context, [{**target, 'expected_plan': ready[0]['plan_hash']}], 'submit', profile, answers)
            assert done[0]['state'] == expected, (scenario, done[0])
            if scenario == 'captcha':
                assert any(e['type'] == 'needs_human' for e in ack.events)
        assert app.state.submissions == []


async def test_ashby_yes_no_buttons_and_spam_rejection(profile):
    async with lab() as (app, base, context):
        target = job(base, '/ashby/ok/301/application', 'ashby')
        first, _ = await run(context, [target], 'prepare', profile)
        assert [(m['label'], m['kind']) for m in first[0]['missing']] == [('Will you now or in the future require sponsorship to work in Turkey?', 'yesno')]
        answers = answer(first[0]['missing'], {'sponsorship': 'No'})
        ready, _ = await run(context, [target], 'prepare', profile, answers)
        assert ready[0]['state'] == 'ready_to_submit', ready[0]
        done, _ = await run(context, [{**target, 'expected_plan': ready[0]['plan_hash']}], 'submit', profile, answers)
        assert done[0]['state'] == 'confirmed' and done[0]['evidence']['kind'] == 'success_container'
        sent = app.state.submissions[0]
        assert sent['fields'] == {'_systemfield_name': 'Demo Middle Candidate', '_systemfield_email': 'candidate@example.test', 'gh': 'https://github.com/demo-candidate',
                                  'li': 'https://www.linkedin.com/in/demo-candidate', 'sponsorship': 'No', 'location': 'Ankara, Ankara, Turkey'}
        spam = job(base, '/ashby/spam/302/application', 'ashby', 'spam')
        ready, _ = await run(context, [spam], 'prepare', profile, answers)
        done, _ = await run(context, [{**spam, 'expected_plan': ready[0]['plan_hash']}], 'submit', profile, answers)
        assert done[0]['state'] == 'submit_rejected' and 'spam' in done[0]['note']
        assert len(app.state.submissions) == 1


async def test_linkedin_easy_apply_multi_step(profile):
    async with lab() as (app, base, context):
        target = job(base, '/li/ok/jobs/view/401', 'linkedin')
        first, _ = await run(context, [target], 'prepare', profile)
        assert first[0]['state'] == 'needs_answers', first[0]
        assert [m['label'] for m in first[0]['missing']] == ['How many years of work experience do you have with Python?*',
                                                            'Are you legally authorized to work in Türkiye?*', 'What is your level of proficiency in English?*']
        assert len(first[0]['steps']) == 3
        answers = answer(first[0]['missing'], {'years of work experience': '2', 'authorized': 'Yes', 'proficiency in english': 'Professional'})
        ready, _ = await run(context, [target], 'prepare', profile, answers)
        assert ready[0]['state'] == 'ready_to_submit', ready[0]
        shown = {row['label']: (row['value'], row['source']) for row in ready[0]['disclosure']}
        assert shown['Upload resume'] == ('old_resume.pdf', 'site_prefilled')
        assert shown['Phone country code*'] == ('Turkey (+90)', 'derived_from_phone')
        assert shown['Follow Example Labs to stay up to date with their page.'] == (True, 'site_prefilled')
        done, _ = await run(context, [{**target, 'expected_plan': ready[0]['plan_hash']}], 'submit', profile, answers)
        assert done[0]['state'] == 'confirmed', done[0]
        assert done[0]['evidence']['kind'] == 'post_apply_dialog'
        sent = app.state.submissions[0]['fields']
        assert {k: sent[k] for k in ('email', 'cc', 'phone', 'years', 'auth', 'english', 'resume')} == {
            'email': 'candidate@example.test', 'cc': 'tr', 'phone': '5550000000', 'years': '2', 'auth': 'Yes', 'english': 'Professional', 'resume': 'old_resume.pdf'}


async def test_linkedin_slow_steps_conditional_and_own_resume(profile):
    explain = 'Turkish citizen; no sponsorship needed.'
    async with lab() as (app, base, context):
        for scenario in ('slow_steps', 'conditional', 'no_resume'):
            target = job(base, f'/li/{scenario}/jobs/view/402', 'linkedin', scenario)
            mapping = {'years of work experience': '2', 'authorized': 'No' if scenario == 'conditional' else 'Yes',
                       'proficiency in english': 'Professional', 'explain your work authorization': explain}
            answers, rounds = {}, []
            # A person answers what each preparation run reports, until nothing is missing.
            for _ in range(3):
                ready, _ = await run(context, [target], 'prepare', profile, answers)
                rounds.append([m['label'] for m in ready[0].get('missing', [])])
                if ready[0]['state'] != 'needs_answers':
                    break
                answers.update(answer(ready[0]['missing'], mapping))
            assert ready[0]['state'] == 'ready_to_submit', (scenario, ready[0])
            if scenario == 'conditional':
                # The explanation exists only after "No" is chosen, so it is asked in a second round.
                assert rounds[1] == ['Please explain your work authorization status*']
            done, _ = await run(context, [{**target, 'expected_plan': ready[0]['plan_hash']}], 'submit', profile, answers)
            assert done[0]['state'] == 'confirmed', (scenario, done[0])
        by = {s['scenario']: s for s in app.state.submissions}
        assert len(app.state.submissions) == 3
        assert by['conditional']['fields']['auth'] == 'No' and by['conditional']['fields']['explain'] == explain
        assert by['no_resume']['files']['file']['sha256'] == RESUME_SHA and by['slow_steps']['fields']['resume'] == 'old_resume.pdf'


async def test_linkedin_blockers_never_submit(profile):
    async with lab() as (app, base, context):
        jobs = [job(base, f'/li/{s}/jobs/view/40{i}', 'linkedin', s) for i, s in enumerate(('login_wall', 'already_applied', 'daily_limit', 'offsite'))]
        results, _ = await run(context, jobs, 'prepare', profile, linkedin_pace_seconds=0)
        states = {r['job_id']: r['state'] for r in results}
        assert states == {'login_wall': 'needs_login', 'already_applied': 'already_applied', 'daily_limit': 'rate_limited', 'offsite': 'not_started'}
        offsite, _ = await run(context, [jobs[3]], 'prepare', profile)
        assert offsite[0]['state'] == 'employer_site_redirect' and '/gh/ok/jobs/' in offsite[0]['destination']
        assert app.state.submissions == []
