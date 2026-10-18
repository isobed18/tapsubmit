from pathlib import Path

from applyburst.formscan import (compile_plan, disclosure, fingerprint, identify, match_suggestion, plan_digest,
                                 split_phone)

PROFILE = {'name': 'Demo Middle Candidate', 'email': 'candidate@example.test', 'phone': '+90 555 000 00 00',
           'location': 'Ankara, Turkiye', 'linkedin': 'https://www.linkedin.com/in/demo', 'github': 'https://github.com/demo'}


def q(key, label, kind='text', **extra):
    return {'key': key, 'label': label, 'kind': kind, 'required': extra.pop('required', True), 'value': extra.pop('value', ''), **extra}


def test_unknown_sensitive_fields_require_answers():
    questions = [q('a', 'Email address', 'email'),
                 q('b', 'Do you need visa sponsorship?', 'select', options=[{'label': 'Yes', 'value': '1'}, {'label': 'No', 'value': '0'}]),
                 q('c', 'Email me promotional material', 'checkbox', value=False)]
    plan = compile_plan(questions, PROFILE)
    assert [e['action'] for e in plan['entries']] == ['fill', 'missing', 'missing']
    assert {m['label'] for m in plan['missing']} == {'Do you need visa sponsorship?', 'Email me promotional material'}


def test_middle_names_are_not_moved_into_surname():
    plan = compile_plan([q('f', 'First Name*'), q('l', 'Last Name*')], PROFILE)
    assert [e['value'] for e in plan['entries']] == ['Demo Middle', 'Candidate']


def test_lookalike_labels_and_cover_letters_abstain():
    assert identify(q('x', 'Company name')) is None
    assert identify(q('x', 'Name of your previous employer')) is None
    assert identify(q('x', 'Cover letter', 'file')) is None
    assert identify(q('x', 'Resume/CV*', 'file')) == 'resume'
    assert identify(q('x', 'GitHub Link (if applicable)')) == 'github'
    assert identify(q('x', 'Linkedin Profile Link')) == 'linkedin'
    assert identify(q('x', 'Full name ✱')) == 'name'
    assert identify(q('x', 'Country', 'combobox', group='Phone')) == 'phone_country'
    assert identify(q('x', 'Country', 'combobox')) is None


def test_phone_country_is_derived_only_from_an_international_number():
    assert split_phone('+90 555 000 00 00') == ('+90', '5550000000')
    assert split_phone('0090 555 000 0000') == ('+90', '5550000000')
    assert split_phone('+1 (415) 555-0100') == ('+1', '4155550100')
    assert split_phone('0555 000 00 00') == (None, '05550000000')
    questions = [q('c', 'Phone country code', 'select', options=[{'label': 'United States (+1)', 'value': 'us'}, {'label': 'Turkey (+90)', 'value': 'tr'}], value='United States (+1)'),
                 q('p', 'Mobile phone number')]
    plan = compile_plan(questions, PROFILE)
    assert [(e['action'], e['value'], e['source']) for e in plan['entries']] == [('fill', 'Turkey (+90)', 'derived_from_phone'), ('fill', '5550000000', 'resume')]
    # Without a separate country control the full international number is used.
    assert compile_plan([q('p', 'Phone')], PROFILE)['entries'][0]['value'] == '+90 555 000 00 00'


def test_approved_answers_are_exact_and_must_match_an_offered_choice():
    radio = q('r', 'Are you legally authorized to work in Turkey?', 'radio', options=[{'label': 'Yes', 'key': 'y'}, {'label': 'No', 'key': 'n'}])
    fp = fingerprint(radio)
    assert compile_plan([radio], PROFILE, {fp: 'Yes'})['entries'][0]['value'] == 'Yes'
    stale = compile_plan([radio], PROFILE, {fp: 'Maybe'})
    assert stale['missing'][0]['problem'] == 'approved value is not one of the offered choices'
    # The same wording with different choices is a different question.
    other = q('r', 'Are you legally authorized to work in Turkey?', 'radio', options=[{'label': 'Yes, without sponsorship'}, {'label': 'No'}])
    assert fingerprint(other) != fp
    # Required markers and case do not change a question's identity.
    assert fingerprint(q('a', 'Why Anthropic?*', 'textarea')) == fingerprint(q('b', 'why anthropic?', 'textarea'))


def test_site_prefilled_values_are_kept_and_disclosed():
    plan = compile_plan([q('e', 'Years of Python experience', value='3'), q('o', 'Optional note', required=False)], PROFILE)
    assert [(e['action'], e['source']) for e in plan['entries']] == [('keep', 'site_prefilled'), ('skip', None)]
    rows = disclosure(plan['entries'])
    assert rows == [{'label': 'Years of Python experience', 'value': '3', 'source': 'site_prefilled', 'action': 'keep', 'fingerprint': plan['entries'][0]['fingerprint']}]


def test_resume_file_identity_enters_the_plan_digest(tmp_path: Path):
    resume = tmp_path / 'resume.txt'
    resume.write_bytes(b'one')
    profile = {**PROFILE, 'resume_path': str(resume)}
    upload = q('u', 'Resume/CV', 'file')
    first = plan_digest(compile_plan([upload], profile)['entries'])
    resume.write_bytes(b'two')
    assert plan_digest(compile_plan([upload], profile)['entries']) != first
    # After upload the page shows our file name: still ours, not "prefilled by the site".
    kept = compile_plan([{**upload, 'value': 'resume.txt'}], profile)['entries'][0]
    assert (kept['action'], kept['source']) == ('keep', 'resume')
    other = compile_plan([{**upload, 'value': 'old.pdf'}], profile)['entries'][0]
    assert (other['action'], other['source'], other['value']) == ('keep', 'site_prefilled', 'old.pdf')


def test_location_suggestions_need_one_unambiguous_city():
    options = ['Ankara, Ankara, Turkey', 'Ankara, Iowa, United States', 'Istanbul, Istanbul, Turkey']
    assert match_suggestion('Ankara, Turkiye', options) == 'Ankara, Ankara, Turkey'
    assert match_suggestion('Ankara', options) is None  # Turkey or Iowa: ambiguous without a country
    assert match_suggestion('Izmir, Turkiye', options) is None
    assert match_suggestion('Istanbul, Turkey', ['Istanbul, Turkey', 'Istanbul, Istanbul, Turkey']) == 'Istanbul, Turkey'
