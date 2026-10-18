"""Conservative question routing to explicit, reusable user facts. No model or default answers.

Patterns classify what is being asked, never supply a fact. Offered choices must still
match exactly in formscan. Unknown currency/period/country/qualification stays unknown.
"""
import json
import re
import sys
from pathlib import Path
from .formscan import norm

SCHEMA_ROOT = Path(getattr(sys, '_MEIPASS', Path(__file__).resolve().parents[1]))
SCHEMA = json.loads((SCHEMA_ROOT/'config/preference_intents.json').read_text(encoding='utf8'))
PATTERNS = [(spec, re.compile('^(?:'+'|'.join(spec['patterns'])+')$')) for spec in SCHEMA]
COUNTRIES = {'US': r'\bunited states\b|\bu[.]?s[.]?a?\b', 'GB': r'\bunited kingdom\b|\bu[.]?k\b',
             'TR': r'\bturkey\b|\bturkiye\b', 'DE': r'\bgermany\b|\bdeutschland\b', 'CA': r'\bcanada\b'}

def describe(question):
    label, kind = norm(question.get('label')), question.get('kind')
    if kind in ('file', 'checkbox_group', 'password', 'hidden'):
        return None
    if kind != 'checkbox':
        for spec, pattern in PATTERNS:
            if kind in ('radio', 'yesno') and spec.get('kind') != 'choice':
                continue
            if spec['id'] == 'salary_statement' and kind not in ('text', 'textarea'):
                continue
            if pattern.fullmatch(label):
                return {key: value for key, value in spec.items() if key != 'patterns'}
        # Meaning-based route for other languages/wordings; still one explicit, reusable value per id.
        intent = question.get('intent')
        target = {'salary_expectation': 'salary_statement' if kind in ('text', 'textarea') else None, 'weekly_hours': 'weekly_hours', 'website': 'website', 'current_company': 'current_company', 'current_title': 'current_title',
                  'preferred_name': 'preferred_name', 'years_experience': 'years_experience', 'relocation': 'relocation',
                  'education': 'education', 'university': 'university', 'graduation_year': 'graduation_year',
                  'how_heard': 'how_heard', 'pronouns': 'pronouns',
                  'notice_period': 'earliest_start_date' if kind == 'date' else 'notice_period'}.get(intent)
        if target:
            spec = next((spec for spec, _ in PATTERNS if spec['id'] == target), None)
            if spec and (kind not in ('radio', 'yesno') or spec.get('kind') == 'choice'):
                return {key: value for key, value in spec.items() if key != 'patterns'}
    # Skill-specific years of experience ("How many years of work experience do you have with Python?")
    skill_exp = (re.fullmatch(r'(?:how many )?years of (?:work |professional |hands[- ]on |industry )?experience (?:do you have )?(?:with|in|using) ([a-z0-9+#.-]{2,25})', label)
                 or re.fullmatch(r'(?:how many )?years of ([a-z0-9+#.-]{2,25}) (?:work |professional )?experience(?: do you have)?', label))
    if skill_exp and kind not in ('checkbox', 'radio', 'yesno') and skill_exp.group(1) not in ('work', 'professional', 'relevant', 'industry', 'total'):
        skill = skill_exp.group(1)
        return {'id': 'years_experience:' + skill, 'label': f'Years of {skill} experience', 'kind': 'number', 'min': 0, 'max': 60, 'unit': 'years'}
    # Language proficiency ("What is your level of proficiency in English?")
    lang_match = re.fullmatch(r'(?:what is your )?(?:level of )?(?:proficiency|fluency) in (english|turkish|german|french|spanish|arabic)|(?:your )?(english|turkish|german|french|spanish|arabic) (?:proficiency|fluency|level)', label)
    if lang_match and kind != 'checkbox':
        lang = (lang_match.group(1) or lang_match.group(2)).lower()
        return {'id': 'language_proficiency:' + lang, 'label': f'{lang.capitalize()} proficiency', 'kind': 'choice', 'unit': lang}
    # Salary reuse requires all units explicitly on the question; never infer USD/year/gross.
    if re.search(r'\b(salary|compensation)\b|\bmaas\b', label) and not re.search(r'current|previous|minimum|maximum|range|mevcut', label):
        currency = [code for code in ('USD', 'EUR', 'GBP', 'TRY', 'CAD') if re.search(r'\b'+code.lower()+r'\b', label)]
        periods = [period for period, pattern in [('year', r'\bannual|\byearly|\bper year|\byillik'), ('month', r'\bmonthly|\bper month|\baylik'), ('hour', r'\bhourly|\bper hour|\bsaatlik')] if re.search(pattern, label)]
        bases = [basis for basis, pattern in [('gross', r'\bgross\b|\bbrut\b'), ('net', r'\bnet\b')] if re.search(pattern, label)]
        if len(currency) == len(periods) == len(bases) == 1:
            key = ':'.join(['salary', currency[0], periods[0], bases[0]])
            return {'id': key, 'label': 'Expected salary', 'kind': 'number', 'min': 0, 'max': 1000000000, 'unit': ' '.join([currency[0], periods[0], bases[0]])}
    # Authorization/sponsorship is only transferable when the country is literally named.
    countries = [country for country, pattern in COUNTRIES.items() if re.search(pattern, label)]
    if len(countries) == 1 and kind in ('select', 'radio', 'yesno', 'combobox'):
        if re.search(r'(authorized|authorised|authorization|authorisation).*\bwork\b', label) and not re.search(r'not authorized|without|full.time|part.time|citizen|national|sponsor', label):
            return {'id': 'work_authorization:'+countries[0], 'label': 'Work authorization', 'kind': 'choice', 'unit': countries[0]}
        if re.search(r'\brequire\b.*\bsponsor(?:ship)?\b', label) and not re.search(r'not require|without|remain|opt|h.?1b|extension', label):
            horizon = 'now_or_future' if re.search(r'now.*future', label) else None
            if horizon:
                return {'id': 'visa_sponsorship:'+countries[0]+':'+horizon, 'label': 'Visa sponsorship now or in future', 'kind': 'choice', 'unit': countries[0]}
    return None

def resolve(question, preferences):
    spec = describe(question)
    if not spec:
        return None
    record = (preferences or {}).get(spec['id'])
    if not isinstance(record, dict) or record.get('confirmed') is not True:
        return None
    value = record.get('value')
    if value is None or value == '': return None
    if spec['kind'] == 'number':
        try:
            number = float(value)
            if not spec['min'] <= number <= spec['max']: return None
            value = str(int(number)) if number.is_integer() else str(number)
        except (ValueError, TypeError): return None
    if spec['kind'] == 'url' and not re.match(r'^https?://[^\s]+$', str(value)): return None
    if spec['kind'] == 'date' and not re.fullmatch(r'\d{4}-\d{2}-\d{2}', str(value)): return None
    return {'value': value, 'id': spec['id'], 'unit': spec.get('unit')}
