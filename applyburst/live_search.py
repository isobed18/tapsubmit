"""Query-driven discovery from public job-site search. Read-only: no accounts, no applications.

Emits JSON lines on stdout as results arrive:
  {"type":"jobs","jobs":[...]}       new or updated postings (LinkedIn cards first, details later)
  {"type":"warning","message":...}   throttling, blocking or partial coverage
  {"type":"done",...}                outcome, counts and timing
LinkedIn uses its public guest job search and job pages; the job page also tells whether the
job is Easy Apply or applied for on the company website. Indeed, Glassdoor and Google use
JobSpy's scrapers with bounded result counts. Coverage is always partial, never "complete".
"""
import argparse
import asyncio
import io
import json
import logging
import re
import sys
import time
from pathlib import Path

SITES = ('linkedin', 'indeed', 'glassdoor', 'google', 'himalayas', 'remoteok')
UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/155.0.0.0 Safari/537.36'
GUEST = 'https://www.linkedin.com/jobs-guest/jobs/api'
# LinkedIn location IDs. Turkey's was verified on 16 Oct 2026 (98 vs 4 results without it); the 2026
# signed-in search ignores free-text locations, so a country ID is required there.
GEO_IDS = {'turkey': '102105699', 'germany': '101282230', 'uk': '101165590', 'usa': '103644278', 'netherlands': '102890719', 'france': '105015875',
           'canada': '101174742', 'ireland': '104738515', 'spain': '105646813', 'poland': '105072130', 'uae': '104305776', 'india': '102713980',
           'singapore': '102454443', 'worldwide': '92000000'}


def city_filter(jobs, location, country):
    """A typed city narrows results locally; a bare country name does not."""
    import unicodedata
    fold = lambda t: ''.join(c for c in unicodedata.normalize('NFKD', str(t or '').replace('ı', 'i').replace('İ', 'i').lower()) if not unicodedata.combining(c))
    wanted = fold(location).split(',')[0].strip()
    if not wanted or wanted in ('turkey', 'turkiye', fold(country)):
        return jobs
    return [job for job in jobs if wanted in fold(job.get('location'))]


def emit(event):
    sys.stdout.write(json.dumps(event, default=str) + '\n')
    sys.stdout.flush()


def text(node):
    return re.sub(r'\s+', ' ', node.get_text(' ', strip=True)).strip() if node else ''


def linkedin_cards(html):
    from bs4 import BeautifulSoup
    soup = BeautifulSoup(html, 'html.parser')
    jobs = []
    for card in soup.select('.base-search-card'):
        ident = (card.get('data-entity-urn') or '').rsplit(':', 1)[-1]
        if not ident.isdigit():
            link = card.select_one('a.base-card__full-link')
            match = re.search(r'-(\d+)\?', (link.get('href') if link else '') or '')
            ident = match.group(1) if match else ''
        if not ident:
            continue
        posted = card.select_one('time')
        card_raw = text(card)
        wp = ('hybrid' if re.search(r'\b(?:hybrid|hibrit)\b', card_raw, re.I)
              else 'remote' if re.search(r'\b(?:remote|uzaktan)\b', card_raw, re.I)
              else 'onsite' if re.search(r'\b(?:on[- ]site|onsite|yerinde|iş yerinde)\b', card_raw, re.I)
              else 'unknown')
        jobs.append({'external_id': ident, 'title': text(card.select_one('.base-search-card__title')),
                     'company': text(card.select_one('.base-search-card__subtitle')), 'location': text(card.select_one('.job-search-card__location')),
                     'posted_at': posted.get('datetime') if posted else None, 'listing_url': f'https://www.linkedin.com/jobs/view/{ident}/',
                     'apply_url': f'https://www.linkedin.com/jobs/view/{ident}/', 'description': '', 'description_state': 'card_only',
                     'easy_apply_badge': 'easy apply' in card_raw.lower(), 'workplace': wp})
    return jobs


def linkedin_detail(html):
    """Description, criteria and the apply route from a public job page."""
    from bs4 import BeautifulSoup
    soup = BeautifulSoup(html, 'html.parser')
    controls = ' '.join(tag.get('data-tracking-control-name', '') for tag in soup.select('[data-tracking-control-name*="apply"]'))
    if 'apply-link-offsite' in controls:
        route = 'linkedin_offsite'
    elif 'apply-link-onsite' in controls or 'apply-link-simple_onsite' in controls:
        route = 'linkedin_easy_apply'
    else:
        route = 'unknown'
    criteria = {text(item.select_one('h3')).lower(): text(item.select_one('span')) for item in soup.select('.description__job-criteria-item')}
    markup = soup.select_one('.show-more-less-html__markup')
    description = markup.get_text('\n', strip=True) if markup else ''
    closed = bool(soup.find(string=re.compile(r'No longer accepting applications', re.I)))
    return {'description': description, 'description_state': 'present' if description else 'missing', 'apply_route': route,
            'seniority': criteria.get('seniority level'), 'employment_type': criteria.get('employment type') or 'unknown',
            'closed': closed}


async def linkedin(request, report):
    import httpx
    query, location, limit = request['query'], request.get('location') or None, max(1, min(100, int(request.get('limit') or 25)))
    geo = GEO_IDS.get(request.get('country') or '')
    params = {'keywords': query, 'location': location, 'geoId': geo}
    if request.get('level') in EXPERIENCE_FILTER:
        params['f_E'] = EXPERIENCE_FILTER[request['level']]
    if request.get('easy_apply'):
        params['f_AL'] = 'true'
    if request.get('hours_old'):
        params['f_TPR'] = 'r%d' % (int(request['hours_old']) * 3600)
    if request.get('remote'):
        params['f_WT'] = '2'
    found, order = {}, []
    async with httpx.AsyncClient(headers={'user-agent': UA, 'accept': 'text/html,*/*', 'accept-language': 'en-US,en;q=0.9'}, timeout=20, follow_redirects=True) as client:
        start, pages = 0, 0
        while len(order) < limit and start < 1000:
            if pages:
                await asyncio.sleep(float(request.get('page_delay', 4.0)))
            response = await client.get(GUEST + '/seeMoreJobPostings/search', params={**{k: v for k, v in params.items() if v}, 'start': start})
            pages += 1
            if response.status_code in (429, 999):
                report['warnings'].append(f'LinkedIn throttled the search (HTTP {response.status_code}) after {len(order)} results.')
                break
            if response.status_code != 200:
                report['warnings'].append(f'LinkedIn search returned HTTP {response.status_code}.')
                break
            cards = [c for c in linkedin_cards(response.text) if c['external_id'] not in found]
            if not cards:
                break
            cards = cards[:limit - len(order)]
            for card in cards:
                card['apply_route'] = 'linkedin_easy_apply' if request.get('easy_apply') else 'unknown'
                if request.get('remote') and card.get('workplace') == 'unknown':
                    card['workplace'] = 'remote'
                found[card['external_id']] = card
                order.append(card['external_id'])
            emit({'type': 'jobs', 'jobs': cards, 'phase': 'search', 'page': pages})
            start += 10
        report['search_pages'] = pages
        # Job pages: description and apply route. Two at a time, stop on throttling.
        queue, details, throttled = list(order), 0, False

        async def hydrate():
            nonlocal details, throttled
            while queue and not throttled:
                ident = queue.pop(0)
                try:
                    response = await client.get(f'{GUEST}/jobPosting/{ident}')
                except Exception as error:
                    report['warnings'].append(f'Job page {ident}: {type(error).__name__}')
                    continue
                if response.status_code in (429, 999):
                    throttled = True
                    report['warnings'].append(f'LinkedIn throttled job pages after {details} details; the rest keep card data only.')
                    break
                if response.status_code != 200:
                    continue
                detail = linkedin_detail(response.text)
                job = {**found[ident], **{k: v for k, v in detail.items() if v not in (None, '') or k == 'apply_route'}}
                if request.get('easy_apply') and detail['apply_route'] == 'unknown':
                    job['apply_route'] = 'linkedin_easy_apply'
                found[ident] = job
                details += 1
                emit({'type': 'jobs', 'jobs': [job], 'phase': 'detail'})
                await asyncio.sleep(float(request.get('detail_delay', 1.5)))

        # Job pages are what LinkedIn throttles first. With the Easy Apply filter the apply route
        # is already known, so pages are read only when asked for; otherwise one at a time.
        if request.get('details', not request.get('easy_apply')):
            await hydrate()
        report['details'] = details
    return [found[i] for i in order]


CARD_JS = r'''() => [...document.querySelectorAll('[data-occludable-job-id],[data-job-id],[componentkey^="job-card-component-ref-"]')]
 .filter(card => !card.parentElement?.closest('[componentkey^="job-card-component-ref-"]')).map(card => {
 // 2026 results use generated class names and componentkey="job-card-component-ref-<id>"; older markup keeps data attributes.
 const id = card.getAttribute('data-occludable-job-id') || card.getAttribute('data-job-id') || (card.getAttribute('componentkey') || '').replace('job-card-component-ref-', '');
 const link = card.querySelector('a[href*="/jobs/view/"]');
 const text = card.innerText || '';
 const lines = text.split('\n').map(s => s.trim()).filter(Boolean).filter(l => !/^(seçildi|selected)\b/i.test(l) && !/doğrulanmış iş ilanı|verified job/i.test(l));
 const unique = lines.filter((l, i) => lines.indexOf(l) === i);
 const title = (card.querySelector('.job-card-list__title, .job-card-container__link strong, a[href*="/jobs/view/"] strong')?.innerText || link?.getAttribute('aria-label') || unique[0] || '').trim();
 const company = (card.querySelector('.artdeco-entity-lockup__subtitle, .job-card-container__primary-description, .job-card-container__company-name')?.innerText || unique.find(l => l !== title) || '').trim();
 const place = (card.querySelector('.artdeco-entity-lockup__caption, .job-card-container__metadata-item, .job-card-container__metadata-wrapper')?.innerText
   || unique.find(l => l !== title && l !== company && /,|\(|türkiye|turkey|remote|uzaktan|hybrid|hibrit|iş yerinde|on-site/i.test(l)) || '').trim();
 return {id, title, company, place, easy: /easy apply|kolay başvuru/i.test(text), applied: /\bapplied\b|başvuruldu/i.test(text), text: unique.slice(0, 8).join(' | ')};
}).filter(c => c.id && /^\d+$/.test(c.id))'''


async def linkedin_signed_in(request, report):
    """Signed-in LinkedIn job search in the background browser: the page a person would see."""
    from urllib.parse import urlencode
    from playwright.async_api import async_playwright
    from .companion import launch
    limit = max(1, min(100, int(request.get('limit') or 25)))
    params = {'keywords': request['query'], 'geoId': GEO_IDS.get(request.get('country') or '') or ''}
    if request.get('location') and not request.get('remote'):
        params['location'] = request['location']
    if request.get('remote'):
        params['f_WT'] = '2'
    if request.get('level') in EXPERIENCE_FILTER:
        params['f_E'] = EXPERIENCE_FILTER[request['level']]
    if request.get('easy_apply'):
        params['f_AL'] = 'true'
    if request.get('hours_old'):
        params['f_TPR'] = 'r%d' % (int(request['hours_old']) * 3600)
    found, order = {}, []
    async with async_playwright() as playwright:
        context = await launch(playwright, {'browser_profile': request['browser_profile'], 'headless': True})
        try:
            page = await context.new_page()
            for start in range(0, limit, 25):
                await page.goto('https://www.linkedin.com/jobs/search-results/?' + urlencode({**{k: v for k, v in params.items() if v}, 'start': start}), wait_until='domcontentloaded', timeout=30000)
                path = page.url.split('?')[0]
                if any(part in path for part in ('/login', '/authwall', '/checkpoint', '/signup')):
                    report['warnings'].append('LinkedIn session is not signed in (redirected to ' + path.split('linkedin.com')[-1] + ').')
                    break
                try:
                    await page.locator('[data-occludable-job-id],[data-job-id],[componentkey^="job-card-component-ref-"]').first.wait_for(timeout=15000)
                except Exception:
                    report['warnings'].append('No job cards appeared on the signed-in search page.')
                    break
                # Cards render lazily while the list scrolls.
                for _ in range(10):
                    await page.evaluate('''() => { const list = document.querySelector('.jobs-search-results-list, .scaffold-layout__list > div, .scaffold-layout__list'); (list || document.scrollingElement).scrollBy(0, 900); }''')
                    await page.wait_for_timeout(250)
                cards = await page.evaluate(CARD_JS)
                fresh = [c for c in cards if c['id'] not in found]
                kept_ids = {j['external_id'] for j in city_filter([{'external_id': c['id'], 'location': c['place']} for c in fresh], request.get('location'), request.get('country'))}
                if not fresh:
                    break
                batch = []
                for card in [c for c in fresh if c['id'] in kept_ids][:limit - len(order)]:
                    job = {'external_id': card['id'], 'title': card['title'].split('\n')[0], 'company': card['company'], 'location': card['place'],
                           'listing_url': f"https://www.linkedin.com/jobs/view/{card['id']}/", 'apply_url': f"https://www.linkedin.com/jobs/view/{card['id']}/",
                           'description': '', 'description_state': 'card_only', 'apply_route': 'linkedin_easy_apply' if card['easy'] else 'unknown', 'already_applied': card['applied'],
                           'workplace': 'hybrid' if re.search(r'\bhybrid\b|hibrit', card['text'], re.I) else 'remote' if re.search(r'\bremote\b|uzaktan', card['text'], re.I) else 'onsite' if re.search(r'on[- ]site|iş yerinde', card['text'], re.I) else 'unknown'}
                    if job['title']:
                        found[card['id']] = job
                        order.append(card['id'])
                        batch.append(job)
                emit({'type': 'jobs', 'jobs': batch, 'phase': 'signed_in_search'})
                if len(order) >= limit or len(cards) < 20:
                    break
                await asyncio.sleep(float(request.get('page_delay', 2.0)))
        finally:
            await context.close()
    report['method'] = 'signed_in_browser'
    return [found[i] for i in order]


# LinkedIn's native experience filter from the CV level (1 internship, 2 entry, 3 associate, 4 mid-senior, 5 director).
EXPERIENCE_FILTER = {'early': '1,2', 'mid': '2,3,4', 'senior': '4,5'}

COUNTRY_LABEL = {'turkey': 'turkey', 'germany': 'germany', 'uk': 'united kingdom', 'usa': 'united states', 'netherlands': 'netherlands', 'france': 'france',
                 'canada': 'canada', 'ireland': 'ireland', 'spain': 'spain', 'poland': 'poland', 'uae': 'united arab emirates', 'india': 'india', 'singapore': 'singapore'}
OPEN_REGIONS = ('worldwide', 'anywhere', 'global', 'remote', 'emea', 'europe', 'eu')


def remote_allowed(restrictions, country):
    """A remote posting restricted to other countries is not shown; unknown or worldwide stays."""
    wanted = COUNTRY_LABEL.get(country or '', '')
    if not wanted or not restrictions:
        return True
    text = ' | '.join(restrictions).lower()
    return wanted in text or (wanted == 'turkey' and 'türkiye' in text) or any(region in text for region in OPEN_REGIONS)


def himalayas(request, report):
    import httpx
    limit, jobs, page = max(1, min(100, int(request.get('limit') or 25))), [], 1
    with httpx.Client(headers={'user-agent': 'ApplyBurst/0.4 (personal job search; read-only)', 'accept': 'application/json'}, timeout=20) as client:
        while len(jobs) < limit and page <= 6:
            response = client.get('https://himalayas.app/jobs/api/search', params={'q': request['query'], 'limit': 20, 'page': page})
            if response.status_code != 200:
                report['warnings'].append(f'Himalayas returned HTTP {response.status_code}.')
                break
            rows = response.json().get('jobs') or []
            if not rows:
                break
            batch = []
            for row in rows:
                restrictions = row.get('locationRestrictions') or []
                if not remote_allowed(restrictions, request.get('country')):
                    continue
                link = row.get('applicationLink') or ''
                if not link.startswith('https://'):
                    continue
                salary = {'min': row.get('minSalary'), 'max': row.get('maxSalary'), 'currency': row.get('currency'), 'period': row.get('salaryPeriod'), 'source': 'provider_field'} if row.get('minSalary') or row.get('maxSalary') else None
                posted = row.get('pubDate')
                batch.append({'external_id': str(row.get('guid') or link).rsplit('/', 1)[-1][:120], 'title': row.get('title') or '', 'company': row.get('companyName') or '',
                              'location': ', '.join(restrictions) or 'Remote (worldwide)', 'location_restriction': ', '.join(restrictions) or None, 'description': row.get('description') or row.get('excerpt') or '',
                              'description_state': 'present' if row.get('description') else 'missing', 'listing_url': link, 'apply_url': link, 'apply_route': 'link_out',
                              'posted_at': time.strftime('%Y-%m-%d', time.gmtime(posted)) if isinstance(posted, (int, float)) else posted, 'workplace': 'remote',
                              'employment_type': row.get('employmentType') or 'unknown', 'salary': salary})
            batch = batch[:limit - len(jobs)]
            jobs.extend(batch)
            if batch:
                emit({'type': 'jobs', 'jobs': batch, 'phase': 'search', 'page': page})
            page += 1
            time.sleep(0.4)
    return jobs


def remoteok(request, report):
    import httpx
    limit = max(1, min(100, int(request.get('limit') or 25)))
    words = [w for w in re.findall(r'[a-z0-9+#.]+', request['query'].lower()) if len(w) > 1]
    with httpx.Client(headers={'user-agent': 'ApplyBurst/0.4 (personal job search; read-only)', 'accept': 'application/json'}, timeout=25) as client:
        response = client.get('https://remoteok.com/api')
    if response.status_code != 200:
        report['warnings'].append(f'Remote OK returned HTTP {response.status_code}.')
        return []
    jobs = []
    for row in response.json():
        if not isinstance(row, dict) or not row.get('id'):
            continue
        haystack = ' '.join([row.get('position') or '', ' '.join(row.get('tags') or []), row.get('company') or '', re.sub('<[^>]+>', ' ', row.get('description') or '')]).lower()
        if words and not all(word in haystack for word in words):
            continue
        location = (row.get('location') or '').strip()
        if not remote_allowed([location] if location else [], request.get('country')):
            continue
        link = row.get('url') or ''
        if not link.startswith('https://'):
            continue
        salary = {'min': row.get('salary_min'), 'max': row.get('salary_max'), 'currency': 'USD', 'period': 'year', 'source': 'provider_field'} if row.get('salary_min') else None
        jobs.append({'external_id': str(row['id']), 'title': row.get('position') or '', 'company': row.get('company') or '', 'location': location or 'Remote (worldwide)',
                     'location_restriction': location or None, 'description': row.get('description') or '', 'description_state': 'present' if row.get('description') else 'missing',
                     'listing_url': link, 'apply_url': row.get('apply_url') if (row.get('apply_url') or '').startswith('https://') else link, 'apply_route': 'link_out',
                     'posted_at': row.get('date'), 'workplace': 'remote', 'employment_type': 'unknown', 'salary': salary})
        if len(jobs) >= limit:
            break
    if jobs:
        emit({'type': 'jobs', 'jobs': jobs, 'phase': 'search'})
    report['note'] = 'Latest Remote OK postings filtered by every word of the search.'
    return jobs


def jobspy_post(post, site):
    """Normalise a JobSpy JobPost: typed pydantic fields, no pandas NaN handling needed."""
    direct = post.job_url_direct if post.job_url_direct and post.job_url_direct.startswith('https://') else None
    location = post.location.display_location() if post.location else ''
    description = post.description or ''
    route = {'indeed': 'indeed', 'glassdoor': 'glassdoor', 'google': 'link_out'}[site]
    if direct and site != 'google':
        route = 'employer_site'
    salary = None
    if post.compensation and (post.compensation.min_amount or post.compensation.max_amount):
        salary = {'min': post.compensation.min_amount, 'max': post.compensation.max_amount, 'currency': post.compensation.currency,
                  'period': post.compensation.interval.value if post.compensation.interval else None, 'source': 'provider_field'}
    ident = (post.id or '').split('-', 1)[-1] or post.job_url
    return {'external_id': ident, 'title': post.title, 'company': post.company_name or '', 'location': location, 'description': description,
            'description_state': 'present' if description else 'missing', 'listing_url': post.job_url, 'apply_url': direct or post.job_url,
            'destination_url': direct, 'apply_route': route, 'posted_at': post.date_posted.isoformat() if post.date_posted else None,
            'workplace': 'remote' if post.is_remote else 'unknown', 'employment_type': ', '.join(t.value[0] for t in post.job_type) if post.job_type else 'unknown',
            'emails': post.emails or [], 'salary': salary}


def jobspy_site(request, report):
    from jobspy.model import Country, DescriptionFormat, ScraperInput
    site = request['site']
    country = Country.from_string(request.get('country') or 'turkey')
    if site == 'glassdoor':
        try:
            country.glassdoor_domain_value
        except Exception:
            # The SDK's country list configures its web domain; its location lookup also supports
            # countries outside that list. Preserve the requested location on the global domain.
            country = Country.from_string('usa')
            report['method'] = 'global_domain_location_lookup'
    if site == 'indeed':
        from jobspy.indeed import Indeed as Scraper
    elif site == 'glassdoor':
        from jobspy.glassdoor import Glassdoor as Scraper
    else:
        from jobspy.google import Google as Scraper
    location = request.get('location') or (COUNTRY_LABEL.get(request.get('country')) if site == 'glassdoor' else None)
    search = ScraperInput(search_term=request['query'], location=location, country=country, results_wanted=max(1, min(100, int(request.get('limit') or 25))),
                          description_format=DescriptionFormat.PLAIN, easy_apply=bool(request.get('easy_apply')) or None, hours_old=request.get('hours_old') or None,
                          is_remote=bool(request.get('remote')),
                          google_search_term=f"{request['query']} jobs" + (f' near {location}' if location else ''))
    captured = io.StringIO()
    handler = logging.StreamHandler(captured)
    loggers = [logging.getLogger(name) for name in ('JobSpy', 'JobSpy:Indeed', 'JobSpy:Glassdoor', 'JobSpy:Google', 'Indeed', 'Glassdoor', 'Google')]
    for logger in loggers:
        logger.addHandler(handler)
    try:
        response = Scraper().scrape(search)
    finally:
        for logger in loggers:
            logger.removeHandler(handler)
    log = captured.getvalue()
    for line in log.splitlines():
        if re.search(r'error|status code|blocked|throttl|429|403', line, re.I):
            report['warnings'].append(line.strip()[:300])
    jobs = [jobspy_post(post, site) for post in response.jobs if post.title and post.job_url]
    if jobs:
        emit({'type': 'jobs', 'jobs': jobs, 'phase': 'search'})
    return jobs


def run(request):
    site = request.get('site')
    report = {'warnings': []}
    tick = time.perf_counter()
    if site not in SITES:
        raise ValueError('Unsupported search source.')
    if site == 'linkedin' and request.get('signed_in'):
        jobs = asyncio.run(linkedin_signed_in(request, report))
    elif site == 'linkedin':
        jobs = asyncio.run(linkedin(request, report))
    elif site == 'himalayas':
        jobs = himalayas(request, report)
    elif site == 'remoteok':
        jobs = remoteok(request, report)
    else:
        jobs = jobspy_site(request, report)
    seconds = round(time.perf_counter() - tick, 3)
    outcome = 'returned' if jobs else ('blocked_or_throttled' if report['warnings'] else 'no_results')
    return {'type': 'done', 'site': site, 'query': request['query'], 'outcome': outcome, 'count': len(jobs), 'elapsed_seconds': seconds,
            'warnings': report['warnings'][:10], 'search_pages': report.get('search_pages'), 'details': report.get('details'),
            'method': report.get('method', 'public_http'), 'complete': False}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--request', default='-', help='Search JSON file, or - for the first stdin line')
    args = parser.parse_args()
    for stream in (sys.stdin, sys.stdout, sys.stderr):
        if hasattr(stream, 'reconfigure'):
            stream.reconfigure(encoding='utf-8')
    request = json.loads(sys.stdin.readline() if args.request == '-' else Path(args.request).read_text(encoding='utf-8'))
    try:
        emit(run(request))
    except Exception as error:
        emit({'type': 'done', 'site': request.get('site'), 'query': request.get('query'), 'outcome': 'failed', 'count': 0,
              'error': str(error).splitlines()[0][:400] if str(error) else type(error).__name__, 'complete': False})


if __name__ == '__main__':
    main()
