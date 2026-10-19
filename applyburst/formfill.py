"""Apply a compiled plan to the page and verify each value actually took effect."""
import re
import time
import unicodedata

from .formscan import compile_plan, match_suggestion, norm, scan

TEXT_KINDS = {'text', 'email', 'tel', 'url', 'number', 'textarea', 'search', 'date', 'password'}


class FillError(Exception):
    pass


def keyed(scope, key):
    return scope.locator(f'[data-applyburst-key="{key}"]')


def frame_of(scope):
    """Where floating menus render: a dialog's page, or the Page/Frame scope itself."""
    from playwright.async_api import Locator
    return scope.page if isinstance(scope, Locator) else scope


async def _single(scope, key):
    locator = keyed(scope, key)
    count = await locator.count()
    if count != 1:
        raise FillError('The form changed while filling; it will be scanned again.')
    return locator


async def _check(scope, key, wanted=True):
    """Set a radio/checkbox, including visually hidden inputs behind styled labels."""
    locator = await _single(scope, key)
    if await locator.is_checked(timeout=2000) == wanted:
        return
    try:
        # A visually hidden input behind a styled label never becomes actionable: go straight to the fallbacks.
        if not await locator.is_visible():
            raise FillError('hidden input')
        await locator.set_checked(wanted, timeout=1500)
    except Exception:
        label = locator.locator('xpath=ancestor::label[1]')
        clicked = False
        if await label.count():
            try:
                await label.first.click(timeout=1500)
                clicked = True
            except Exception:
                pass
        if not clicked:
            ident = await locator.get_attribute('id')
            target = scope.locator(f'label[for="{ident}"]') if ident else None
            # Custom controls (e.g. LinkedIn's role=radio wrappers) react to clicks on the wrapper.
            wrapper = locator.locator('xpath=ancestor::*[@role="radio" or @role="checkbox" or @role="option"][1]')
            if target is not None and await target.count() and await target.first.is_visible():
                await target.first.click(timeout=1500)
            elif await wrapper.count():
                await wrapper.first.click(timeout=1500)
            else:
                await locator.evaluate('el => el.click()')
            # React forms (LinkedIn) re-render the control on click; the tagged element can disappear.
            # Never wait the 30 s default for it: the rescan that follows verifies what stayed.
            if await locator.count() and await locator.is_checked(timeout=1000) != wanted and await wrapper.count():
                await wrapper.first.click(timeout=1500)
    if not await locator.count():
        return
    if await locator.is_checked(timeout=1000) != wanted:
        raise FillError('A choice did not stay selected.')


async def _options_of(root, locator):
    """This combobox's own choices: its aria-controls/aria-owns listbox, else visible options only.

    Hidden menus of other dropdowns often stay in the DOM; they must never be read or clicked.
    """
    for attribute in ('aria-controls', 'aria-owns'):
        ident = await locator.get_attribute(attribute)
        if ident:
            owned = root.locator(f'[id="{ident}"] [role=option]')
            if await owned.count():
                return owned
    return root.locator('[role=option]:visible')


async def _wait_options(root, locator, timeout=5.0):
    import asyncio
    import time
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        options = await _options_of(root, locator)
        try:
            if await options.count() and await options.first.is_visible():
                return options
        except Exception:
            pass
        await asyncio.sleep(0.1)
    return None


async def read_combobox_options(scope, key, limit=300):
    """Open a closed-list combobox, read its choices, close it. No value is chosen."""
    locator = await _single(scope, key)
    root = frame_of(scope)
    labels = []
    try:
        await locator.click(timeout=3000)
        options = await _wait_options(root, locator, 2.5)
        if options:
            labels = [re.sub(r'\s+', ' ', t).strip() for t in await options.all_inner_texts()][:limit]
    except Exception:
        labels = []
    finally:
        try:
            await locator.press('Escape')
        except Exception:
            pass
    return [label for label in labels if label]


async def _combobox(scope, key, value, fact):
    locator = await _single(scope, key)
    root = frame_of(scope)
    await locator.click(timeout=3000)
    # Typing filters a closed list and triggers suggestions for a search list.
    query = value
    if fact == 'phone_country':
        query = {'+90': 'Tur', '+1': 'United', '+44': 'United Kingdom', '+49': 'Germ'}.get(value, value)
    elif fact == 'location':
        query = value.split(',')[0].strip()
    # Many autocompletes match a plain prefix: "İstanbul".lower() keeps a combining dot and finds nothing,
    # so the accent-folded spelling goes first and the original spelling second.
    folded = ''.join(c for c in unicodedata.normalize('NFKD', query.replace('ı', 'i').replace('İ', 'I')) if not unicodedata.combining(c))
    options = None
    for attempt in dict.fromkeys([folded, query] if fact == 'location' else [query]):
        await locator.fill(attempt)
        options = await _wait_options(root, locator)
        if options is not None:
            break
    if options is None:
        await locator.fill('')
        await locator.press('Escape')
        raise FillError('No choices appeared for ' + repr(value) + '.')
    labels = [re.sub(r'\s+', ' ', t).strip() for t in await options.all_inner_texts()]
    pick = None
    if fact == 'phone_country':
        hits = [label for label in labels if re.search(r'(^|[\s(])' + re.escape(value) + r'(\)|\s|$)', label)]
        named = [label for label in labels if norm(label).split(' +')[0] in ('turkey', 'turkiye')] if value == '+90' else []
        pick = hits[0] if len(hits) == 1 else (named[0] if len(named) == 1 else None)
    else:
        pick = next((label for label in labels if norm(label) == norm(value)), None)
        if pick is None and fact == 'location':
            pick = match_suggestion(value, labels)
    if pick is None:
        await locator.fill('')
        await locator.press('Escape')
        raise FillError(f'No offered choice exactly matches {value!r}.')
    index = labels.index(pick)
    await options.nth(index).click(timeout=3000)


async def apply_entry(scope, question, entry):
    kind, key, value = entry['kind'], question['key'], entry['value']
    if kind in TEXT_KINDS:
        locator = await _single(scope, key)
        await locator.fill(str(value), timeout=5000)
        actual = await locator.input_value()
        if norm(actual) != norm(value) and re.sub(r'\D', '', actual) != re.sub(r'\D', '', str(value)):
            raise FillError('A typed value was changed by the page.')
    elif kind == 'select':
        locator = await _single(scope, key)
        option = next(o for o in question['options'] if o['label'] == value)
        await locator.select_option(value=option['value'], timeout=5000)
    elif kind == 'radio':
        option = next(o for o in question['options'] if o['label'] == value)
        await _check(scope, option['key'], True)
    elif kind == 'checkbox_group':
        wanted = set(value)
        for option in question['options']:
            await _check(scope, option['key'], option['label'] in wanted)
    elif kind == 'checkbox':
        await _check(scope, key, bool(value))
    elif kind == 'yesno':
        option = next(o for o in question['options'] if norm(o['label']) == norm(value))
        target = await _single(scope, option['key'])
        if await target.get_attribute('aria-pressed') != 'true':
            await target.click(timeout=3000)
        if await target.get_attribute('aria-pressed') != 'true':
            raise FillError('A Yes/No answer did not stay selected.')
    elif kind == 'combobox':
        await _combobox(scope, key, str(value), entry.get('fact'))
    elif kind == 'file':
        locator = await _single(scope, key)
        await locator.set_input_files(str(value), timeout=10000)
    else:
        raise FillError('Unsupported field type: ' + str(kind))


async def _with_choices(scope, questions, known):
    """Read closed-list combobox choices once per question, so missing answers can offer them."""
    for question in questions:
        if question['kind'] != 'combobox' or question.get('options'):
            continue
        if question['key'] in known:
            question['options'] = known[question['key']]
        elif question.get('required') and not question.get('value'):
            choices = await read_combobox_options(scope, question['key'])
            known[question['key']] = [{'label': label} for label in choices] or None
            question['options'] = known[question['key']]
    return questions


async def label_intents(questions, classify):
    """Attach a multilingual intent to labels the rules could not place. No classifier: rules only."""
    if not classify:
        return questions
    from .formscan import identify
    from .preferences import describe
    pending = [q for q in questions if q.get('label') and 'intent' not in q and q.get('kind') not in ('checkbox', 'checkbox_group') and identify(q) is None and describe(q) is None]
    # Every rescan of a step returns the same labels: classify each label once per worker.
    for question in pending:
        if question['label'] in _INTENTS:
            question['intent'] = _INTENTS[question['label']]
    todo = [q for q in pending if 'intent' not in q]
    if todo:
        results = await classify('fields', [q['label'] for q in todo])
        for question, result in zip(todo, results or []):
            question['intent'] = _INTENTS[question['label']] = result['label'] if result else None
    return questions


_INTENTS = {}


async def fill_step(scope, profile, answers, passes=4, stop_on_missing=False, preferences=None, classify=None):
    """Fill one visible step until no new questions appear (conditional fields).

    Returns (questions, plan) for the page as it finally looks. In the final plan, 'keep' means
    the value is on the page; a value that could not be applied becomes a missing question with
    the reason, so nothing unverified is reported as filled.
    """
    attempts, problems, known, spent = {}, {}, {}, {}
    for _ in range(passes):
        questions = await label_intents(await _with_choices(scope, await scan(scope), known), classify)
        plan = compile_plan(questions, profile, answers, preferences)
        # Automatic runs skip immediately when a required answer is unknown. Do not upload
        # a resume and fill every known field on a form that cannot be submitted.
        if stop_on_missing and plan['missing']:
            return questions, plan
        # Optional fields get one attempt: they never block an application.
        todo = [(q, e) for q, e in zip(questions, plan['entries']) if e['action'] == 'fill' and attempts.get(e['fingerprint'], 0) < (2 if q.get('required') else 1)]
        if not todo:
            break
        for question, entry in todo:
            attempts[entry['fingerprint']] = attempts.get(entry['fingerprint'], 0) + 1
            started = time.perf_counter()
            try:
                await apply_entry(scope, question, entry)
                problems.pop(entry['fingerprint'], None)
            except FillError as error:
                problems[entry['fingerprint']] = str(error)
            except Exception as error:
                problems[entry['fingerprint']] = 'Could not set this field: ' + str(error).splitlines()[0][:160]
            finally:
                spent[question.get('label') or entry['fingerprint'][:8]] = spent.get(question.get('label') or entry['fingerprint'][:8], 0) + round((time.perf_counter() - started) * 1000)
        # Rescan on the next pass: answers can reveal conditional questions.
    final = await label_intents(await _with_choices(scope, await scan(scope), known), classify)
    final_plan = compile_plan(final, profile, answers, preferences)
    for question, entry in zip(final, final_plan['entries']):
        if entry['action'] == 'fill' and not question.get('required'):
            # An optional value that did not stay is left empty, not guessed and not reported as sent.
            try:
                locator = await _single(scope, question['key'])
                if question.get('kind') in TEXT_KINDS or question.get('kind') == 'combobox':
                    await locator.fill('', timeout=2000)
            except Exception:
                pass
            entry['action'] = 'skip'
            entry['problem'] = problems.get(entry['fingerprint']) or 'Optional value did not stay; left empty.'
            continue
        if entry['action'] == 'fill':
            entry['action'] = 'missing'
            entry['problem'] = problems.get(entry['fingerprint']) or 'The value did not stay on the page.'
            final_plan['missing'].append({'fingerprint': entry['fingerprint'], 'label': entry['label'] or '(unlabelled question)', 'kind': entry['kind'],
                                          'options': [o.get('label') for o in question.get('options') or []] or None, 'fact': entry.get('fact'),
                                          'problem': entry['problem'], 'error': question.get('error') or None})
    final_plan['fill_ms'] = spent
    return final, final_plan
