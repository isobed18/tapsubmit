"""Deterministic application-form understanding: scan, identify known facts, plan, fill.

No model calls. A question is filled only from the imported resume facts, a value derived
from them by an explicit rule (phone country code), an exact approved answer for the same
question fingerprint, or a value the website itself prefilled. Everything else required is
reported as missing so the person answers it; nothing about eligibility is guessed.
"""
import hashlib
import json
import re
import unicodedata
from pathlib import Path

# Marks every scanned control with data-applyburst-key so later actions address exactly the
# element that was read, even with duplicate ids, React re-renders or visually hidden inputs.
SCAN = r'''(root) => {
 const scope = root && root.nodeType === 1 ? root : document;
 const doc = scope.ownerDocument || document;
 const clean = s => String(s || '').replace(/\s+/g, ' ').trim();
 const shown = el => { if (!el || !el.isConnected) return false; const st = getComputedStyle(el);
  if (st.display === 'none' || st.visibility === 'hidden') return false; const r = el.getBoundingClientRect(); return r.width > 1 && r.height > 1; };
 const proxyShown = el => shown(el) || [...(el.labels || [])].some(shown) || shown(el.closest('label')) || shown(el.parentElement);
 const CONTAINER = 'fieldset,[role=radiogroup],[role=group],.application-question,.ashby-application-form-field-entry,.field-wrapper,[data-test-form-element],.fb-dash-form-element,.jobs-easy-apply-form-element,.form-group,.form-field,[data-ab-question],[data-fabric-component="FileUpload"]';
 const TITLE = 'legend,.application-label,.ashby-application-form-question-title,[data-test-form-builder-radio-button-form-component__title],.fb-dash-form-element__label,.label,label';
 let counter = Number(doc.documentElement.dataset.applyburstCounter || 0);
 const keyOf = el => { if (!el.dataset.applyburstKey) el.dataset.applyburstKey = 'k' + (++counter); return el.dataset.applyburstKey; };
 const byIds = ids => clean(String(ids || '').split(/\s+/).filter(Boolean).map(id => doc.getElementById(id)?.innerText || '').join(' '));
 const container = el => el.closest(CONTAINER);
 function title(box, el, group) {
  if (!box) return '';
  if (box.getAttribute('aria-labelledby')) { const t = byIds(box.getAttribute('aria-labelledby')); if (t) return t; }
  for (const t of box.querySelectorAll(TITLE)) {
   if (t.matches('label') && (t.querySelector('input,select,textarea') || (group && t.control && t.control.matches('[type=radio],[type=checkbox]')))) continue;
   if (t.matches('label') && t.control && t.control !== el && !group) continue;
   const text = clean(t.innerText || t.textContent); if (text) return text;
  }
  return preceding(box);
 }
 // Forms that render the question as a plain text block right before the control group
 // (e.g. LinkedIn Easy Apply 2026: <p>Question*</p><fieldset role=radiogroup>…).
 function preceding(node) {
  for (let n = node, depth = 0; n && depth < 3; n = n.parentElement, depth++) {
   const p = n.previousElementSibling;
   if (p && !p.querySelector('input,select,textarea,button') && !p.matches('input,select,textarea,button')) {
    const text = clean(p.innerText || p.textContent); if (text && text.length <= 400) return text;
   }
   if (p) break;
  }
  return '';
 }
 function ownLabel(el) {
  // Accessible-name order: aria-labelledby, then aria-label, then <label> (which can contain icon fallback text).
  const by = byIds(el.getAttribute('aria-labelledby')); if (by && !/^(attach|upload|browse|choose( a)? file)$/i.test(by)) return by;
  if (el.getAttribute('aria-label') && !/^(search|attach)$/i.test(el.getAttribute('aria-label'))) return clean(el.getAttribute('aria-label'));
  const own = clean([...(el.labels || [])].map(l => l.innerText || l.textContent).join(' '));
  if (own && !/^(attach|upload|browse|choose( a)? file|select file|dosya seç)/i.test(own)) return own;
  const group = el.closest('[role=group][aria-labelledby]'); if (group) { const t = byIds(group.getAttribute('aria-labelledby')); if (t) return t; }
  return '';
 }
 const markerRequired = t => /[*✱]\s*$/.test(t) || /\((required|zorunlu)\)/i.test(t);
 function required(el, box, text) {
  if (/\((optional|isteğe bağlı)\)/i.test(text)) return false;
  if (el.required || el.getAttribute('aria-required') === 'true' || markerRequired(text)) return true;
  if (el.closest('[aria-required=true]')) return true;
  if (!box) return false;
  return [...box.querySelectorAll('label,legend,span,div,abbr')].some(n => n !== el && /(^|[\s_-])required(?![a-z])/i.test(String(n.className || '')) && (n.matches('label,legend,span,abbr') || /required-field/i.test(n.className)))
   || [...box.querySelectorAll('input[required]:not([id]):not([name])')].length > 0;
 }
 function errorText(box, el) {
  const ids = String(el.getAttribute('aria-errormessage') || '') + ' ' + String(el.getAttribute('aria-describedby') || '');
  const linked = ids.split(/\s+/).filter(id => /error/i.test(id)).map(id => doc.getElementById(id)).filter(n => n && shown(n)).map(n => n.innerText);
  const near = box ? [...box.querySelectorAll('[role=alert],[class*=error i],[class*=invalid i],.artdeco-inline-feedback--error')].filter(n => shown(n) && !n.matches('input,select,textarea')).map(n => n.innerText) : [];
  return clean([...linked, ...near].join(' ')).slice(0, 240);
 }
 const out = [], seenGroups = new Set();
 const controls = [...scope.querySelectorAll('input,textarea,select')];
 for (const el of controls) {
  const type = (el.getAttribute('type') || (el.tagName === 'SELECT' ? 'select' : el.tagName === 'TEXTAREA' ? 'textarea' : 'text')).toLowerCase();
  if (['hidden', 'submit', 'button', 'reset', 'image'].includes(type) || el.disabled) continue;
  const role = el.getAttribute('role') === 'combobox' || el.getAttribute('aria-autocomplete') === 'list' ? 'combobox' : el.getAttribute('role');
  if (!el.id && !el.name && type !== 'file' && role !== 'combobox' && type !== 'radio' && type !== 'checkbox') continue;
  if (el.closest('[aria-hidden=true]') && type !== 'file') continue;
  if (el.closest('.ashby-application-form-input-yesno')) continue;
  if (el.matches('.iti__search-input,[name=g-recaptcha-response],[name=h-captcha-response]')) continue;
  const box = container(el);
  if (type === 'radio' || (type === 'checkbox' && el.name && scope.querySelectorAll('input[type=checkbox][name="' + CSS.escape(el.name) + '"]').length > 1)) {
   const groupKey = type + ':' + (el.name || keyOf(box || el));
   if (seenGroups.has(groupKey)) continue; seenGroups.add(groupKey);
   const members = el.name ? [...scope.querySelectorAll('input[type=' + type + '][name="' + CSS.escape(el.name) + '"]')] : [...(box || el.parentElement).querySelectorAll('input[type=' + type + ']')];
   if (!members.some(proxyShown)) continue;
   const text = title(box, el, true) || ownLabel(el) || clean(el.closest('[role=radio],[role=checkbox]')?.getAttribute('aria-label'));
   // Option text: its <label>, else a custom role=radio wrapper's visible text, else text beside the input.
   const optionText = m => clean([...(m.labels || [])].map(l => l.innerText || l.textContent).join(' ')) || clean(m.closest('label')?.innerText)
    || clean(m.closest('[role=radio],[role=checkbox],[role=option]')?.innerText) || clean(m.parentElement?.nextElementSibling?.innerText) || m.value;
   const options = members.map(m => ({label: optionText(m), value: m.value, key: keyOf(m)}));
   out.push({key: keyOf(members[0]), kind: type === 'radio' ? 'radio' : 'checkbox_group', label: text, required: members.some(m => required(m, box, text)), options,
    value: type === 'radio' ? (options.find((o, i) => members[i].checked)?.label || '') : options.filter((o, i) => members[i].checked).map(o => o.label), name: el.name || '', id: '', error: errorText(box, el)});
   continue;
  }
  if (type !== 'file' && !proxyShown(el)) continue;
  let text = ownLabel(el) || title(box, el, false) || clean(el.getAttribute('placeholder')) || clean(el.name || el.id);
  // Some accessible upload widgets name every input "file-input". The adjacent
  // field heading distinguishes Resume from Cover Letter; never reuse the CV for both.
  if (type === 'file' && /^(file[- ]?input|upload|choose file|attach)$/i.test(text)) text = title(box, el, false) || text;
  const q = {key: keyOf(el), kind: role === 'combobox' ? 'combobox' : type === 'select' ? 'select' : type === 'checkbox' ? 'checkbox' : type, label: text,
   required: required(el, box, text), name: el.name || '', id: el.id || '', autocomplete: el.getAttribute('autocomplete') || '', placeholder: clean(el.getAttribute('placeholder')),
   group: clean(el.closest('fieldset')?.querySelector('legend')?.innerText || ''), error: errorText(box, el), options: null, value: ''};
  if (type === 'select') { q.options = [...el.options].filter(o => o.value !== '' && !/^(select|choose|seç|please select)\b/i.test(clean(o.text))).map(o => ({label: clean(o.text), value: o.value}));
   const chosen = el.options[el.selectedIndex]; q.value = chosen && chosen.value !== '' && q.options.some(o => o.value === chosen.value) ? clean(chosen.text) : ''; }
  else if (type === 'checkbox') q.value = el.checked;
  else if (type === 'file') { q.value = el.files && el.files.length ? el.files[0].name : ''; q.accept = el.getAttribute('accept') || '';
   const up = box && [...box.querySelectorAll('[class*=filename i],[class*=file-name i],[class*=uploaded i],[data-test-document-name]')].filter(shown).map(n => clean(n.innerText)).find(Boolean); if (!q.value && up) q.value = up; }
  else if (role === 'combobox') {
   // react-select keeps typed filter text in the input and the chosen value in a separate element.
   const shell = el.closest('.select') || el.closest('[class*=select-shell]') || box;
   const singles = shell ? [...shell.querySelectorAll('[class*=single-value],[class*=singleValue]')] : [];
   q.value = singles.length || (shell && shell.querySelector('[class*=placeholder]')) ? clean(singles.map(n => n.innerText).join(' ')) : (el.value || ''); }
  else q.value = el.value || '';
  out.push(q);
 }
 for (const box of scope.querySelectorAll('.ashby-application-form-input-yesno,[data-ab-yesno]')) {
  const buttons = [...box.querySelectorAll('button')].filter(b => /^(yes|no|evet|hayır)$/i.test(clean(b.innerText)));
  if (buttons.length < 2 || !buttons.some(shown)) continue;
  const entry = box.closest('.ashby-application-form-field-entry,[data-ab-question]') || box.parentElement, text = title(entry, box, true);
  const pressed = buttons.find(b => b.getAttribute('aria-pressed') === 'true');
  out.push({key: keyOf(box), kind: 'yesno', label: text, required: [...entry.querySelectorAll('label,legend,div,span')].some(n => /_required_|(^|\s)required(\s|$)/.test(String(n.className || ''))) || markerRequired(text),
   options: buttons.map(b => ({label: clean(b.innerText), key: keyOf(b)})), value: pressed ? clean(pressed.innerText) : '', name: '', id: '', error: errorText(entry, box)});
 }
 doc.documentElement.dataset.applyburstCounter = String(counter);
 return out;
}'''

# Lightweight signature to notice a step change without a full rescan.
SIGNATURE = r'''(root) => { const scope = root && root.nodeType === 1 ? root : document;
 return [...scope.querySelectorAll('input,textarea,select,[role=combobox]')].filter(el => !['hidden','submit','button'].includes(el.type)).map(el => (el.id || el.name || el.type) + ':' + (el.labels?.[0]?.innerText || el.getAttribute('aria-label') || '').slice(0, 60)).join('|'); }'''

def norm(value):
    """Lowercase, accent-folded text with required/optional markers removed."""
    text = unicodedata.normalize('NFKC', str(value or '')).replace('ı', 'i').replace('İ', 'i').casefold()
    text = re.sub(r'[*✱]+', ' ', text)
    text = re.sub(r'\((required|optional|zorunlu|isteğe bağlı)\)', ' ', text)
    text = ''.join(c for c in unicodedata.normalize('NFKD', text) if not unicodedata.combining(c))
    return re.sub(r'\s+', ' ', text).strip(' :?.-')


def fingerprint(question):
    """Exact identity of a question for approved-answer reuse: wording, kind and choices.

    Combobox choices load lazily (only when opened), so their identity is wording + kind; an
    approved answer must still equal one offered choice exactly when it is applied.
    """
    kind = question.get('kind')
    options = None if kind == 'combobox' else sorted(norm(o.get('label')) for o in question.get('options') or []) or None
    return hashlib.sha256(json.dumps({'label': norm(question.get('label')), 'kind': kind, 'options': options}, sort_keys=True).encode()).hexdigest()


# Anchored patterns over the normalized label: "Company name" never becomes the candidate's name.
FACTS = [
    ('first_name', r'(legal )?(first|given|fore) ?name|ad(iniz)?|isim'),
    ('last_name', r'(legal )?(last|family|sur) ?name|surname|soyad(i|iniz)?|soyisim'),
    ('name', r'(your |legal |candidate )?(full )?name|ad soyad|adiniz soyadiniz|isim soyisim'),
    ('email', r'(your )?e-?mail( address)?|e-?posta( adresi(niz)?)?'),
    ('phone_country', r'phone country( code)?|country code|country calling code|ulke( telefon)? kodu|telefon ulke kodu'),
    ('phone', r'(your )?(mobile |cell |primary )?(phone|mobile)( number| no)?|mobile phone number|telefon( numarasi(niz)?)?|cep telefonu( numarasi(niz)?)?'),
    # Address-style boxes take the candidate's declared location; otherwise the site's IP-based guess
    # (e.g. a prefilled "Ankara") would be kept and disclosed as if it were the candidate's.
    ('location', r'(current )?(city|location)( \(city\))?|where are you (currently )?(located|based)|where do you (currently )?live|location city|sehir|konum|(current |home )?address|adres(iniz)?|ikamet (ettiginiz )?(sehir|il)|adresse|direccion|ville'),
    ('linkedin', r'linkedin( profile| profil)?( url| link| profile link| profile url| address)?( \(.*\))?|linkedin url'),
    ('github', r'github( profile)?( url| link| username)?( \(.*\))?'),
]
FACT_PATTERNS = [(fact, re.compile('^(?:' + pattern + ')$')) for fact, pattern in FACTS]
AUTOCOMPLETE = {'given-name': 'first_name', 'family-name': 'last_name', 'name': 'name', 'email': 'email', 'tel': 'phone', 'tel-national': 'phone'}


def identify(question):
    """Return the resume fact a question asks for, or None. Abstains on anything uncertain."""
    kind, label = question.get('kind'), norm(question.get('label'))
    if kind in ('checkbox', 'checkbox_group', 'yesno', 'radio'):
        return None
    intent = question.get('intent')
    if kind == 'file':
        if re.search(r'cover|motivation|on yazi|transcript|portfolio', label):
            return None
        if re.search(r'resume|cv|curriculum|ozgecmis', label) or intent == 'resume':
            return 'resume'
        return None
    by_autocomplete = AUTOCOMPLETE.get((question.get('autocomplete') or '').lower())
    if by_autocomplete:
        return by_autocomplete
    if label == 'country' and re.search(r'phone|telefon', norm(question.get('group'))):
        return 'phone_country'
    for fact, pattern in FACT_PATTERNS:
        if pattern.match(label):
            return fact
    identity = norm(question.get('id') or question.get('name'))
    if identity in ('_systemfield_name', 'name', 'full_name'):
        return 'name'
    if identity in ('_systemfield_email', 'email'):
        return 'email'
    if kind == 'email':
        return 'email'
    if kind == 'tel':
        return 'phone'
    # Language-independent fallback: a label classified by meaning (any language) to a resume fact.
    if intent in SEMANTIC_FACTS and kind not in ('textarea',):
        return intent
    return None


SEMANTIC_FACTS = {'first_name', 'last_name', 'name', 'email', 'phone', 'phone_country', 'location', 'linkedin', 'github'}


# ITU-T E.164 country calling codes are prefix-free, so the first match is the only match.
CALLING_CODES = set('''1 7 20 27 30 31 32 33 34 36 39 40 41 43 44 45 46 47 48 49 51 52 53 54 55 56 57 58 60 61 62 63 64 65 66
81 82 84 86 90 91 92 93 94 95 98 211 212 213 216 218 220 221 222 223 224 225 226 227 228 229 230 231 232 233 234 235 236
237 238 239 240 241 242 243 244 245 246 248 249 250 251 252 253 254 255 256 257 258 260 261 262 263 264 265 266 267 268
269 290 291 297 298 299 350 351 352 353 354 355 356 357 358 359 370 371 372 373 374 375 376 377 378 380 381 382 383 385
386 387 389 420 421 423 500 501 502 503 504 505 506 507 508 509 590 591 592 593 594 595 596 597 598 599 670 672 673 674
675 676 677 678 679 680 681 682 683 685 686 687 688 689 690 691 692 850 852 853 855 856 880 886 960 961 962 963 964 965
966 967 968 970 971 972 973 974 975 976 977 992 993 994 995 996 998'''.split())


def split_phone(phone):
    """(+CC, national digits) for an explicitly international number, else (None, digits)."""
    raw = str(phone or '').strip()
    digits = re.sub(r'\D', '', raw)
    if raw.startswith('00'):
        digits = digits[2:]
    elif not raw.startswith('+'):
        return None, digits
    for size in (1, 2, 3):
        if digits[:size] in CALLING_CODES:
            return '+' + digits[:size], digits[size:]
    return None, digits


COUNTRY_NAMES = {'+90': ('turkey', 'turkiye'), '+1': ('united states', 'usa', 'canada'), '+44': ('united kingdom', 'uk'), '+49': ('germany', 'deutschland')}


def facts_from_profile(profile, form_has_phone_country=False):
    """Explicit candidate facts. City/website/visa/salary are never inferred from other text."""
    name = re.sub(r'\s+', ' ', str(profile.get('name') or '')).strip()
    parts = name.split(' ') if name else []
    code, national = split_phone(profile.get('phone'))
    phone = str(profile.get('phone') or '').strip() or None
    return {
        'name': name or None,
        'first_name': ' '.join(parts[:-1]) if len(parts) > 1 else (parts[0] if parts else None),
        'last_name': parts[-1] if len(parts) > 1 else None,
        'email': (profile.get('email') or '').strip() or None,
        'phone': (national if (form_has_phone_country and code) else phone) or None,
        'phone_country': code,
        'location': (profile.get('location') or '').strip() or None,
        'linkedin': (profile.get('linkedin') or '').strip() or None,
        'github': (profile.get('github') or '').strip() or None,
        'resume': profile.get('resume_path') or None,
    }


def choose_option(question, value, fact=None, preference_id=None):
    """Exact option for a value: label/value equality, or for a phone country its dial code."""
    options = question.get('options') or []
    wanted = norm(value)
    for option in options:
        if norm(option.get('label')) == wanted or (option.get('value') is not None and norm(option.get('value')) == wanted):
            return option
    if preference_id:
        yes_words = {'yes', 'evet', 'ja', 'si', 'oui', 'true'}
        no_words = {'no', 'hayir', 'nein', 'non', 'false'}
        if wanted in yes_words | no_words and len(options) == 2:
            target_set = yes_words if wanted in yes_words else no_words
            hits = [o for o in options if norm(o.get('label')) in target_set]
            if len(hits) == 1:
                return hits[0]
    if preference_id == 'weekly_hours':
        # Only an unambiguous advertised numeric interval. Adjacent inclusive buckets
        # overlap at their boundary, so a value on that boundary deliberately abstains.
        hits = []
        try:
            number = float(value)
            for option in options:
                label = norm(option.get('label'))
                match = re.fullmatch(r'(\d+(?:\.\d+)?)\s*(?:-|–|—|to)\s*(\d+(?:\.\d+)?)(?:\s*(?:hours?|hrs?|saat)(?:\s*(?:per|a|each) week)?)?', label)
                if match and float(match[1]) <= number <= float(match[2]): hits.append(option)
            if len(hits) == 1: return hits[0]
        except (TypeError, ValueError): pass
    if fact == 'phone_country' and value:
        names = COUNTRY_NAMES.get(value, ())
        code = re.escape(value)
        hits = [o for o in options if re.search(r'(^|[\s(])' + code + r'(\)|\s|$)', o.get('label') or '') or norm(o.get('label')) in names]
        if len(hits) == 1:
            return hits[0]
        named = [o for o in hits if any(n in norm(o.get('label')) for n in names)]
        if len(named) == 1:
            return named[0]
    return None


def file_digest(path):
    data = Path(path).read_bytes()
    return hashlib.sha256(data).hexdigest()


_RESIDE = re.compile(r"(?:do you|are you(?: currently)?)\s+(?:live|living|reside|residing|based|located)\s+in\s+(?:the\s+)?(?P<a>[^?,(]{2,60})"
                     r"|(?P<b>[^?,]{2,60}?)['’]?(?:da|de|ta|te)\s+m[ıiuü]\s+(?:ikamet|ya[sş]|otur)", re.I)
_PLACE_ALIASES = {'turkiye': 'turkey', 'deutschland': 'germany', 'united states': 'usa', 'united kingdom': 'uk', 'nederland': 'netherlands'}
_GENERIC_PLACE = {'greater', 'area', 'region', 'metropolitan', 'metro', 'city', 'the', 'province', 'state', 'il', 'ili', 'sehri', 'sehir', 'merkez'}


def _fold_place(text):
    text = unicodedata.normalize('NFKD', str(text or '').replace('ı', 'i').replace('İ', 'i')).encode('ascii', 'ignore').decode().lower()
    text = re.sub(r'[^a-z ,]+', ' ', text)
    for alias, name in _PLACE_ALIASES.items():
        text = text.replace(alias, name)
    return text


_CITY_INDEX = None


def _cities():
    """name -> set of regions, from the bundled per-country gazetteers (config/cities/*.json)."""
    global _CITY_INDEX
    if _CITY_INDEX is None:
        _CITY_INDEX = {}
        for path in (Path(__file__).resolve().parents[1] / 'config' / 'cities').glob('*.json'):
            try:
                for row in json.loads(path.read_text(encoding='utf-8')):
                    _CITY_INDEX.setdefault(_fold_place(row.get('name')).strip(), set()).add(_fold_place(row.get('region')).strip())
            except Exception:
                continue
    return _CITY_INDEX


def _other_city(place, home):
    """True when `place` is a known city that is neither the home city nor a district inside it."""
    index, home_city = _cities(), home.split(',')[0].strip()
    if place not in index or home_city not in index or place == home_city:
        return False
    return home_city not in index[place]


def residence_answer(question, location):
    """'Do you live in X?' / 'X'te mi ikamet ediyorsunuz?' from the person's own location.
    Yes when X matches it; No only when the location names both a city and a country and X matches
    neither; otherwise unknown (the question is asked)."""
    if question.get('kind') not in ('radio', 'select', 'yesno') or not location:
        return None
    match = _RESIDE.search(question.get('label') or '')
    if not match:
        return None
    place = [w for w in _fold_place(match.group('a') or match.group('b')).replace(',', ' ').split() if len(w) >= 3 and w not in _GENERIC_PLACE]
    home = _fold_place(location)
    if not place:
        return None
    lives_there = any(re.search(r'\b' + re.escape(w) + r'\b', home) for w in place[-2:])
    if not lives_there and len([p for p in home.split(',') if p.strip()]) < 2 and not _other_city(place[-1], home):
        return None
    yes, no = re.compile(r'^(yes|evet|ja|oui|si|sí|sim)\b', re.I), re.compile(r'^(no|hay[ıi]r|nein|non|nao|não)\b', re.I)
    wanted = yes if lives_there else no
    return next((o['label'] for o in question.get('options') or [] if wanted.search(str(o.get('label') or '').strip())), None)


def compile_plan(questions, profile, answers=None, preferences=None):
    """Decide each question's action. Returns entries plus missing required questions.

    action fill: ApplyBurst types/selects the value; keep: the site already shows a value that
    is kept (and disclosed in review); skip: optional and unanswered. Missing questions block.
    """
    from .preferences import resolve, describe
    answers = answers or {}
    has_country = any(identify(q) == 'phone_country' for q in questions)
    facts = facts_from_profile(profile, has_country)
    entries, missing = [], []
    for question in questions:
        fp = fingerprint(question)
        fact = identify(question)
        kind = question.get('kind')
        value, source = None, None
        if fp in answers and answers[fp] not in (None, ''):
            value, source = answers[fp], 'approved_answer'
        elif fact and facts.get(fact):
            value, source = facts[fact], 'derived_from_phone' if fact == 'phone_country' else 'resume'
        else:
            preference = resolve(question, preferences)
            if preference:
                value, source = preference['value'], 'user_preference'
            else:
                derived = residence_answer(question, (profile or {}).get('location'))
                if derived:
                    value, source = derived, 'derived_from_location'
        entry = {'key': question['key'], 'fingerprint': fp, 'label': question.get('label') or '', 'kind': kind, 'fact': fact,
                 'required': bool(question.get('required')), 'source': source, 'options': question.get('options')}
        if source == 'user_preference': entry['preference_id'] = preference['id']
        current = question.get('value')
        # A location box is a search list: its suggestions depend on what is typed, so it is matched at fill time.
        closed_choice = kind in ('select', 'radio', 'yesno') or (kind == 'combobox' and question.get('options') and fact != 'location')
        if value is not None and closed_choice:
            option = choose_option(question, value, fact, entry.get('preference_id'))
            if option is None:
                if fact == 'phone_country' and current:
                    value, source = None, None
                else:
                    entry['problem'] = 'approved value is not one of the offered choices'
                    value, source = None, None
            else:
                value = option.get('label')
        if value is not None and kind == 'checkbox_group':
            chosen = value if isinstance(value, list) else [v.strip() for v in str(value).split('|') if v.strip()]
            labels = [o.get('label') for o in question.get('options') or []]
            if not chosen or any(norm(c) not in {norm(l) for l in labels} for c in chosen):
                entry['problem'] = 'approved value is not one of the offered choices'
                value, source = None, None
            else:
                value = [l for l in labels if norm(l) in {norm(c) for c in chosen}]
        if value is not None and kind == 'checkbox':
            if norm(value) in ('yes', 'true', 'checked', 'evet', '1'):
                value = True
            elif norm(value) in ('no', 'false', 'unchecked', 'hayir', '0'):
                value = False
            else:
                value, source = None, None
        if kind == 'file' and value is not None:
            path = Path(str(value))
            if not path.is_file():
                entry['problem'] = 'resume file is unavailable'
                value, source = None, None
            else:
                entry['file_name'] = path.name
                entry['file_sha256'] = file_digest(path)
        if value is not None:
            same = (current == value) or (kind not in ('file', 'checkbox', 'checkbox_group') and norm(current) == norm(value) and current not in ('', None))
            if kind == 'combobox' and fact == 'location' and current and not question.get('options'):
                same = match_suggestion(value, [current]) == current
            if kind == 'file' and current:
                if current == entry.get('file_name'):
                    entry.update(action='keep', value=current)
                else:
                    # A different document is already attached (for example LinkedIn's selected resume).
                    entry.update(action='keep', value=current, source='site_prefilled')
                    entry.pop('file_sha256', None)
                    entry.pop('file_name', None)
            else:
                # Once on the page, report the page's own value (e.g. the chosen location suggestion).
                entry.update(action='keep' if same else 'fill', value=current if same and current not in ('', None) else value)
        elif current not in (None, '', False, []) and kind != 'file':
            entry.update(action='keep', value=current, source='site_prefilled')
        elif kind == 'file' and current:
            entry.update(action='keep', value=current, source='site_prefilled')
        elif question.get('required'):
            entry.update(action='missing', value=None)
            missing.append({'fingerprint': fp, 'label': question.get('label') or '(unlabelled question)', 'kind': kind, 'options': [o.get('label') for o in question.get('options') or []] or None,
                            'fact': fact, 'preference': describe(question), 'problem': entry.get('problem'), 'error': question.get('error') or None})
        else:
            entry.update(action='skip', value=None)
        entries.append(entry)
    return {'entries': entries, 'missing': missing}


def plan_digest(entries):
    """Order-independent hash of what will be submitted: question identity and value."""
    rows = []
    for entry in entries:
        if entry['action'] not in ('fill', 'keep'):
            continue
        value = entry.get('value')
        if entry['kind'] == 'file' and entry.get('file_sha256'):
            value = {'file': entry.get('file_name'), 'sha256': entry.get('file_sha256')}
        rows.append([entry['fingerprint'], value])
    rows.sort(key=lambda row: json.dumps(row, sort_keys=True, default=str))
    return hashlib.sha256(json.dumps(rows, sort_keys=True, default=str).encode()).hexdigest()


def disclosure(entries):
    """What the person reviews before submitting: label, value and where it came from."""
    rows = []
    for entry in entries:
        if entry['action'] not in ('fill', 'keep'):
            continue
        value = entry.get('value')
        if entry['kind'] == 'file' and entry.get('file_sha256'):
            value = entry.get('file_name')  # our resume; otherwise the page's own attached document name
        rows.append({'label': entry['label'], 'value': value, 'source': entry.get('source'), 'action': entry['action'], 'fingerprint': entry['fingerprint'], **({'preference_id':entry['preference_id']} if entry.get('preference_id') else {})})
    return rows


def match_suggestion(value, labels):
    """Pick an autocomplete suggestion for typed text: exact, else one unambiguous city match.

    "Ankara, Turkiye" accepts "Ankara, Turkey" or "Ankara, Ankara, Türkiye"; several distinct
    cities with that prefix, or none, abstain.
    """
    wanted = norm(value)
    exact = [label for label in labels if norm(label) == wanted]
    if exact:
        return exact[0]
    parts = [p.strip() for p in wanted.split(',') if p.strip()]
    if not parts:
        return None
    alias = {'turkiye': 'turkey', 'türkiye': 'turkey'}
    country = alias.get(parts[-1], parts[-1]) if len(parts) > 1 else None
    hits, countries = [], set()
    for label in labels:
        text = norm(label)
        segments = [alias.get(s.strip(), s.strip()) for s in text.split(',')]
        if segments and segments[0] == parts[0] and (country is None or country in segments):
            hits.append(label)
            countries.add(segments[-1])
    if not hits or len(countries) > 1:
        return None
    # Same city and country written at different detail ("Ankara, Turkey" / "Ankara, Ankara, Turkey").
    return min(hits, key=len)


def _is_locator(scope):
    from playwright.async_api import Locator
    return isinstance(scope, Locator)


async def scan(scope):
    """Questions in a Page, Frame or Locator scope."""
    return await (scope.evaluate(SCAN) if _is_locator(scope) else scope.evaluate(SCAN, None))


async def signature(scope):
    return await (scope.evaluate(SIGNATURE) if _is_locator(scope) else scope.evaluate(SIGNATURE, None))
