"""Site-family adapters: how to reach a form, advance it, and recognise the employer's outcome.

Every adapter is deterministic. A confirmation must be *new* evidence that appears after the
final click (a success URL, a success container, a post-apply dialog). Text that was already on
the page before the click never counts. HTTP status codes and clicked buttons never count.
"""
import re
from urllib.parse import urlparse

HUMAN_CHECK = re.compile(r'verify (that )?you are (a )?human|are you a robot|checking your browser|security check|unusual traffic|complete the (security )?challenge|press and hold', re.I)
CLOSED = re.compile(r'no longer accepting applications|artık başvuru kabul edilmiyor|başvurular kapandı|this job is no longer (available|open)|job (posting )?(has )?(expired|closed)|position (has been )?(filled|closed)|job not found|page not found|couldn.t find (that|this) (job|page)', re.I)


def host_of(url):
    try:
        parsed = urlparse(url)
    except ValueError:
        return ''
    return (parsed.hostname or '').lower() if parsed.scheme in ('https', 'http') else ''


def on_domain(url, domains):
    host = host_of(url)
    return bool(host) and urlparse(url).scheme == 'https' and any(host == d or host.endswith('.' + d) for d in domains)


async def first_visible(locator, limit=12):
    try:
        items = await locator.all()
    except Exception:
        return None
    for item in items[:limit]:
        try:
            if await item.is_visible():
                return item
        except Exception:
            continue
    return None


# Set by the companion when the local server can classify text by meaning (multilingual encoder).
CLASSIFY = None


async def semantic_button(scope, role):
    """Visible button whose name means next/review/submit in any language; None when unsure."""
    if not CLASSIFY:
        return None
    try:
        items = [item for item in (await scope.get_by_role('button').all())[:40] if await item.is_visible()]
    except Exception:
        return None
    names = []
    for item in items:
        try:
            names.append(((await item.get_attribute('aria-label')) or (await item.inner_text()) or '').strip()[:80])
        except Exception:
            names.append('')
    pairs = [(item, name) for item, name in zip(items, names) if name]
    if not pairs:
        return None
    results = await CLASSIFY('buttons', [name for _, name in pairs])
    ranked = sorted([(result['score'], item) for (item, _), result in zip(pairs, results or []) if result and result['label'] == role], key=lambda pair: -pair[0])
    return ranked[0][1] if ranked else None


async def button(scope, patterns):
    """First visible button whose accessible name matches one of the patterns, in priority order."""
    for pattern in patterns:
        found = await first_visible(scope.get_by_role('button', name=re.compile(pattern, re.I)))
        if found:
            return found
    return None


async def visible_text(scope, pattern):
    """Visible text nodes matching a pattern (bounded)."""
    found = []
    try:
        for item in (await scope.get_by_text(pattern).all())[:8]:
            if await item.is_visible():
                found.append((await item.inner_text())[:300])
    except Exception:
        pass
    return found


async def texts_in(page, scope, pattern):
    """Visible matches in the page and, for an embedded form, inside its frame too."""
    found = await visible_text(page, pattern)
    if scope is not page and not hasattr(scope, 'filter'):
        found += await visible_text(scope, pattern)
    return found


async def page_text(page, limit=20000):
    try:
        return (await page.locator('body').inner_text(timeout=5000))[:limit]
    except Exception:
        return ''


async def human_check_visible(page):
    """A CAPTCHA or bot challenge the person must complete. ApplyBurst never solves these."""
    try:
        if re.search(r'^(?:blocked\b|access denied\b|just a moment\b|security (?:check|verification)\b)', await page.title(), re.I):
            return True
    except Exception:
        pass
    for frame in page.frames:
        url = frame.url or ''
        if ('hcaptcha.com' in url and 'challenge' in url) or ('recaptcha' in url and '/bframe' in url) or 'captcha-delivery.com' in url or 'challenges.cloudflare.com' in url:
            try:
                element = await frame.frame_element()
                box = await element.bounding_box()
                if box and box['width'] > 50 and box['height'] > 50 and await element.is_visible():
                    return True
            except Exception:
                continue
    if await first_visible(page.locator('[data-ab-captcha], .h-captcha-challenge, #challenge-form, iframe[title*="challenge" i]')):
        return True
    return bool(HUMAN_CHECK.search(await page_text(page, 4000)))


class Adapter:
    family = 'generic'
    domains = ()
    login_required = False
    discovery_only = False
    submit_patterns = [r'^submit application$', r'^submit your application$', r'^send application$', r'^submit$', r'^başvuruyu gönder$', r'^başvurunuzu gönderin$', r'^gönder$']
    advance_patterns = [r'^continue to next step$', r'^next$', r'^continue$', r'^review your application$', r'^review$', r'sonraki adıma', r'^[iİ]leri$', r'^devam$', r'^devam et$', r'^başvurunuzu inceleyin$', r'^[iİ]ncele$']
    success = re.compile(r'thank you for (applying|your application)|thanks for applying|application (has been |was )?(successfully )?(submitted|received|sent)|we.ve received your application|başvurunuz (alındı|gönderildi)', re.I)
    rejected = re.compile(r'there was (a problem|an error)|could not be submitted|please (fix|correct|complete) (the )?(errors|fields|following)|flagged as (possible )?spam|something went wrong|try again later', re.I)
    already = re.compile(r'you( have|.ve)? already applied|already submitted an application|duplicate application', re.I)

    def matches(self, url):
        return on_domain(url, self.domains)

    async def blocker(self, page):
        """A state that prevents reaching the form at all."""
        if await human_check_visible(page):
            return {'state': 'needs_human_verification', 'note': 'Complete the verification in the browser window on this PC.'}
        text = await page_text(page, 6000)
        if CLOSED.search(text):
            return {'state': 'closed_or_unavailable', 'note': CLOSED.search(text).group(0)}
        return None

    async def open(self, page, job):
        """Return the scope (Page, Frame or Locator) that contains the application form."""
        return page

    async def form_ready(self, scope, timeout=10000):
        try:
            await scope.locator('input:not([type=hidden]),textarea,select,[role=combobox]').first.wait_for(state='attached', timeout=timeout)
            return True
        except Exception:
            return False

    async def submit_button(self, scope):
        return await button(scope, self.submit_patterns) or await semantic_button(scope, 'submit')

    async def advance_button(self, scope):
        return await button(scope, self.advance_patterns) or await semantic_button(scope, 'next') or await semantic_button(scope, 'review')

    async def snapshot(self, page, scope):
        """State before the final click, so later evidence can be proven new."""
        return {'url': page.url, 'success_text': await texts_in(page, scope, self.success)}

    async def evidence(self, page, scope, before):
        """One non-blocking check for a confirmation that did not exist before the click."""
        texts = [t for t in await texts_in(page, scope, self.success) if t not in before['success_text']]
        if texts and not await self.form_still_open(scope):
            return {'kind': 'success_message', 'text': texts[0], 'url': page.url}
        return None

    async def outcome_problem(self, page, scope, before):
        """A definite non-success outcome after the click: rejection, duplicate or limit."""
        text = await page_text(page, 12000)
        if scope is not page and not hasattr(scope, 'filter'):
            text += '\n' + await page_text(scope, 12000)
        if self.already.search(text) and not self.already.search(before.get('text', '')):
            return {'state': 'already_applied', 'note': self.already.search(text).group(0)}
        for item in await texts_in(page, scope, self.rejected):
            if item not in before.get('rejected', []):
                return {'state': 'submit_rejected', 'note': item[:300]}
        return None

    async def form_still_open(self, scope):
        try:
            return bool(await first_visible(scope.get_by_role('button', name=re.compile('|'.join(self.submit_patterns), re.I))))
        except Exception:
            return False


class Greenhouse(Adapter):
    family = 'greenhouse'
    domains = ('job-boards.greenhouse.io', 'boards.greenhouse.io', 'job-boards.eu.greenhouse.io', 'boards.eu.greenhouse.io', 'grnh.se')

    async def open(self, page, job):
        # Hosted board page, or an employer page embedding the Greenhouse application iframe.
        for _ in range(40):
            if await page.locator('#application-form, #application_form').count():
                return page
            for frame in page.frames[1:]:
                try:
                    if await frame.locator('#application-form, #application_form').count():
                        return frame
                except Exception:
                    continue
            await page.wait_for_timeout(250)
        return None

    @staticmethod
    def confirmation_path(url):
        return bool(url) and urlparse(url).path.rstrip('/').endswith('/confirmation')

    async def evidence(self, page, scope, before):
        for url in [page.url] + ([scope.url] if scope is not page else []):
            if self.confirmation_path(url) and not any(self.confirmation_path(u) for u in (before['url'], before.get('frame_url'))):
                texts = await visible_text(scope if scope is not page else page, self.success)
                return {'kind': 'confirmation_url', 'url': url, 'text': texts[0] if texts else ''}
        return await super().evidence(page, scope, before)

    async def snapshot(self, page, scope):
        data = await super().snapshot(page, scope)
        data['frame_url'] = scope.url if scope is not page else ''
        data['text'] = await page_text(page, 12000)
        data['rejected'] = await visible_text(page, self.rejected)
        return data


class Lever(Adapter):
    family = 'lever'
    domains = ('jobs.lever.co', 'jobs.eu.lever.co')

    async def open(self, page, job):
        path = urlparse(page.url).path.rstrip('/')
        if not path.endswith('/apply'):
            link = await first_visible(page.locator('a[href$="/apply"], a[href*="/apply?"], a.postings-btn'))
            if link:
                await link.click()
                await page.wait_for_load_state('domcontentloaded')
        try:
            await page.locator('#application-form, form[action*="/apply"]').first.wait_for(state='attached', timeout=10000)
        except Exception:
            return None
        return page

    async def evidence(self, page, scope, before):
        path = urlparse(page.url).path.rstrip('/')
        if path.endswith('/thanks') and not urlparse(before['url']).path.rstrip('/').endswith('/thanks'):
            texts = await visible_text(page, self.success)
            return {'kind': 'confirmation_url', 'url': page.url, 'text': texts[0] if texts else ''}
        return await super().evidence(page, scope, before)

    async def snapshot(self, page, scope):
        data = await super().snapshot(page, scope)
        data['text'] = await page_text(page, 12000)
        data['rejected'] = await visible_text(page, self.rejected)
        return data


class Ashby(Adapter):
    family = 'ashby'
    domains = ('jobs.ashbyhq.com',)
    submit_patterns = [r'^submit application$', r'^submit$']

    async def open(self, page, job):
        if not await page.locator('.ashby-application-form-field-entry, #_systemfield_name').count():
            tab = await button(page, [r'^apply for this job$', r'^application$', r'^apply$']) or await first_visible(page.get_by_role('tab', name=re.compile(r'^application$', re.I)))
            if tab:
                await tab.click()
        try:
            await page.locator('.ashby-application-form-field-entry, #_systemfield_name').first.wait_for(state='visible', timeout=12000)
        except Exception:
            return None
        return page

    async def evidence(self, page, scope, before):
        success = await first_visible(page.locator('.ashby-application-form-success-container, [data-ab-success]'))
        if success and not before.get('success_container'):
            return {'kind': 'success_container', 'text': (await success.inner_text())[:300], 'url': page.url}
        return await super().evidence(page, scope, before)

    async def snapshot(self, page, scope):
        data = await super().snapshot(page, scope)
        data['success_container'] = bool(await first_visible(page.locator('.ashby-application-form-success-container, [data-ab-success]')))
        data['text'] = await page_text(page, 12000)
        data['rejected'] = await visible_text(page, self.rejected)
        return data


class BambooHR(Adapter):
    family = 'bamboohr'
    domains = ('bamboohr.com',)
    submit_patterns = [r'^submit application$', r'^submit your application$', r'^submit$', r'^send application$']

    async def open(self, page, job):
        # The hosted career page mounts its application after an explicit Apply action.
        # Only that action opens the form; the final Submit button belongs to execute().
        for _ in range(48):
            blocked = await self.blocker(page)
            if blocked:
                return {'blocked': blocked}
            if await page.locator('input[name="firstName"]').count():
                forms = page.locator('form').filter(has=page.locator('input[name="firstName"]'))
                return forms.first if await forms.count() else page
            action = await button(page, [r'^apply for this job$', r'^apply now$', r'^apply$'])
            if action:
                await action.click(timeout=3000)
            await page.wait_for_timeout(250)
        return None


class Workable(Adapter):
    family = 'workable'
    domains = ('apply.workable.com',)

    async def open(self, page, job):
        consent = await button(page, [r'^decline all$', r'^reject all$'])
        if consent:
            await consent.click()
        if not urlparse(page.url).path.rstrip('/').endswith('/apply'):
            link = await button(page, [r'^apply for this job$', r'^apply now$']) or await first_visible(page.get_by_role('link', name=re.compile(r'^apply for this job$', re.I)))
            if link:
                await link.click()
            else:
                await page.goto(page.url.split('?')[0].rstrip('/') + '/apply/', wait_until='domcontentloaded')
        try:
            await page.locator('#firstname, input[name=firstname], input[type=email]').first.wait_for(state='visible', timeout=12000)
        except Exception:
            return None
        consent = await button(page, [r'^decline all$', r'^reject all$'])
        if consent:
            await consent.click()
        return page

    async def snapshot(self, page, scope):
        data = await super().snapshot(page, scope)
        data['text'] = await page_text(page, 12000)
        data['rejected'] = await visible_text(page, self.rejected)
        return data


class LinkedIn(Adapter):
    family = 'linkedin'
    domains = ('linkedin.com',)
    login_required = True
    # innerText joins inline elements without spaces ("Applied 2 days agoSee application"): no \b at the edges.
    applied = re.compile(r'applied (\d+|an?) (second|minute|hour|day|week|month)s? ago|applied (just )?now|application submitted|see application|başvuruldu|başvuruyu görüntüle|(\d+|bir) (saniye|dakika|saat|gün|hafta|ay) önce başvurdunuz', re.I)
    limit = re.compile(r'reached the easy apply (application )?limit|easy apply limit for today|kolay başvuru (başvuru )?sınırına ulaştınız|günlük kolay başvuru sınır', re.I)
    success = re.compile(r'your application was sent( to [^!.]+)?|application sent|application (was )?submitted|başvurunuz [^.!]{0,60}gönderildi|başvuru gönderildi|başvurunuz iletildi', re.I)
    easy_name = re.compile(r'easy apply|kolay başvuru', re.I)

    async def blocker(self, page):
        path = urlparse(page.url).path
        if re.match(r'^/(login|authwall|signup|uas/login|checkpoint/lg)', path) or await first_visible(page.locator('form.login__form, [data-ab-login-wall]')):
            return {'state': 'needs_login', 'note': 'Sign in to LinkedIn in the ApplyBurst browser on this PC, then retry.'}
        if path.startswith('/checkpoint') or await human_check_visible(page):
            return {'state': 'needs_human_verification', 'note': 'LinkedIn asked for verification. Complete it in the browser window on this PC.'}
        text = await page_text(page, 8000)
        if self.limit.search(text):
            return {'state': 'rate_limited', 'note': 'LinkedIn reports the daily Easy Apply limit. Continue tomorrow.'}
        if CLOSED.search(text):
            return {'state': 'closed_or_unavailable', 'note': CLOSED.search(text).group(0)}
        top = await self.top_card_text(page)
        if self.applied.search(top):
            return {'state': 'already_applied', 'note': self.applied.search(top).group(0)}
        return None

    async def top_card_text(self, page):
        # 2026 markup uses generated class names: take the block around the job title (h1), never the
        # whole page, whose "similar jobs" rail can say "Applied" for other listings.
        card = await first_visible(page.locator('.job-details-jobs-unified-top-card__container--two-pane, .jobs-unified-top-card, [data-ab-top-card]'))
        try:
            if card:
                return (await card.inner_text())[:3000]
            return await page.evaluate('''() => { const h = document.querySelector('main h1, h1'); if (!h) return '';
              let box = h; for (let i = 0; i < 6 && box.parentElement; i++) { box = box.parentElement; if ((box.innerText || '').length > 600) break; }
              return (box.innerText || '').slice(0, 3000); }''')
        except Exception:
            return ''

    async def open(self, page, job):
        # English or Turkish UI; the 2026 button is named by aria-label ("Bu işe kolay başvuru yapın").
        easy = None
        for attempt in range(40):
            easy = await first_visible(page.get_by_role('button', name=self.easy_name))
            if not easy:
                easy = await first_visible(page.locator('button.jobs-apply-button').filter(has_text=self.easy_name))
            if easy:
                break
            offsite = await button(page, [r'^apply( on company (website|site))?( to .*)?$', r'^başvur$', r'şirket (web )?sitesinde başvur']) or await first_visible(page.get_by_role('link', name=re.compile(r'^(apply|başvur)( on company (website|site))?$', re.I)))
            if offsite:
                return {'offsite': offsite}
            if attempt % 5 == 0:
                blocked = await self.blocker(page)
                if blocked:
                    return {'blocked': blocked}
            # DOMContentLoaded precedes the React job header. An absent Apply button
            # on that first frame is not evidence that the job has no application.
            await page.wait_for_timeout(200)
        if not easy:
            return None
        await easy.click()
        dialog = page.get_by_role('dialog').filter(has=page.locator('input, select, textarea, [role=combobox], button'))
        for _ in range(50):
            if await first_visible(dialog):
                return dialog.first
            if self.limit.search(await page_text(page, 8000)):
                return {'blocked': {'state': 'rate_limited', 'note': 'LinkedIn reports the daily Easy Apply limit. Continue tomorrow.'}}
            await page.wait_for_timeout(200)
        return None

    async def snapshot(self, page, scope):
        return {'url': page.url, 'success_text': await visible_text(page, self.success), 'top': await self.top_card_text(page),
                'text': await page_text(page, 12000), 'rejected': []}

    async def evidence(self, page, scope, before):
        for text in await visible_text(page, self.success):
            if text not in before['success_text']:
                dialog_open = await first_visible(page.get_by_role('dialog').filter(has=page.get_by_role('button', name=re.compile(r'^(submit application|başvuruyu gönder)$', re.I))))
                if not dialog_open:
                    return {'kind': 'post_apply_dialog', 'text': text, 'url': page.url}
        top = await self.top_card_text(page)
        match = self.applied.search(top)
        if match and not self.applied.search(before.get('top', '')):
            return {'kind': 'top_card_applied', 'text': match.group(0), 'url': page.url}
        return None

    async def outcome_problem(self, page, scope, before):
        text = await page_text(page, 12000)
        if self.limit.search(text) and not self.limit.search(before.get('text', '')):
            return {'state': 'rate_limited', 'note': 'LinkedIn reports the daily Easy Apply limit.'}
        try:
            errors = [t for t in await scope.locator('.artdeco-inline-feedback--error, [role=alert]').all_inner_texts() if t.strip()]
        except Exception:
            errors = []
        if errors and await self.form_still_open(scope):
            return {'state': 'submit_rejected', 'note': errors[0][:300]}
        return None


class Indeed(Adapter):
    family = 'indeed'
    domains = ('indeed.com',)
    login_required = True
    apply_selector = '#indeedApplyButton, #applyButtonLinkContainer a, #applyButtonLinkContainer button, [data-testid="applyButton"], [data-testid="apply-now-button"], .jobsearch-IndeedApplyButton-newDesign'
    form_selector = '#ia-container, #indeedapply-form, .ia-BasePage, [data-testid="indeed-apply-form"], [data-indeed-apply-form]'
    submit_patterns = [r'^submit( (your )?application)?$', r'^send( (your )?application)?$', r'^confirm and (send|submit)$', r'^başvuruyu gönder$', r'^başvurunuzu gönderin$']
    success = re.compile(r'(your )?application (has been |was )?(successfully )?(submitted|sent|received)|you( have|.ve) applied|thank you for applying|başvurunuz (gönderildi|alındı|iletildi)', re.I)
    limit = re.compile(r'(daily |application )?limit (has been )?reached|too many applications|you.ve applied to (the maximum|too many)|try applying again tomorrow', re.I)

    @staticmethod
    def application_url(url):
        parsed = urlparse(url)
        return ('indeedapply' in parsed.path.lower() or parsed.hostname in ('smartapply.indeed.com', 'apply.indeed.com')) and not re.search(r'/(auth|login|account)(/|$)', parsed.path, re.I)

    @staticmethod
    def confirmation_path(url):
        return bool(re.search(r'/(?:post-apply|application-submitted|application-confirmation|confirmation|success)/?$', urlparse(url).path, re.I))

    async def applied_text(self, page):
        control = await first_visible(page.locator(self.apply_selector))
        return (await control.inner_text())[:300] if control else ''

    async def application_scope(self, page):
        if self.application_url(page.url) or await first_visible(page.locator(self.form_selector)):
            return page
        return None

    async def blocker(self, page):
        if await human_check_visible(page):
            return {'state': 'needs_human_verification', 'note': 'Indeed asks for verification. Open its normal browser sign-in window and complete it yourself.'}
        parsed = urlparse(page.url)
        if parsed.hostname in ('secure.indeed.com', 'auth.indeed.com') or re.search(r'/(?:auth|account/login|login|signin)(?:/|$)', parsed.path, re.I) or await first_visible(page.locator('input[type=password], form[data-testid="login-form"], #login-email-input, [data-ab-login-wall]')):
            return {'state': 'needs_login', 'note': 'Connect your Indeed account, finish signing in in Chrome, then retry. Nothing sent.'}
        # Inspect the job/application status, not a similar-jobs sidebar or the job description.
        heading = await first_visible(page.locator('main h1, h1, [role=alert]'))
        status = ((await heading.inner_text()) if heading else '') + '\n' + await self.applied_text(page)
        text = await page_text(page, 5000)
        if self.limit.search(text):
            return {'state': 'rate_limited', 'note': 'Indeed reports an application limit. This Indeed lane is paused; nothing more will be sent.'}
        if CLOSED.search(status):
            return {'state': 'closed_or_unavailable', 'note': 'This Indeed job is no longer accepting applications.'}
        if re.search(r'^\s*(already applied|applied|application submitted|başvuruldu)\s*$', await self.applied_text(page), re.I):
            return {'state': 'already_applied', 'note': 'Indeed already shows this job as applied.'}
        return None

    async def open(self, page, job):
        # Accessible controls and Indeed's own form container work across UI languages.
        # New windows are adopted into this job's page; no orphan application tabs are left behind.
        initial_pages, clicked = set(page.context.pages), False
        fixture = job.get('family') == 'indeed' and host_of(job['url']) in ('127.0.0.1', 'localhost')
        for _ in range(65):
            blocked = await self.blocker(page)
            if blocked:
                return {'blocked': blocked}
            if not self.matches(page.url) and host_of(page.url) not in ('127.0.0.1', 'localhost'):
                return {'redirect': page.url}
            for frame in page.frames[1:]:
                if self.application_url(frame.url) and (self.matches(frame.url) or fixture and host_of(frame.url) in ('127.0.0.1', 'localhost')):
                    try:
                        if await (await frame.frame_element()).is_visible():
                            return frame
                    except Exception:
                        continue
            scope = await self.application_scope(page)
            if scope is not None:
                return scope
            for popup in [p for p in page.context.pages if p not in initial_pages and not p.is_closed()]:
                if await popup.opener() is not page:
                    continue
                try:
                    await popup.wait_for_url(re.compile(r'^https?://'), timeout=8000)
                    await popup.wait_for_load_state('domcontentloaded', timeout=8000)
                    destination = popup.url
                    if destination.startswith('https://') or host_of(destination) in ('127.0.0.1', 'localhost'):
                        await page.goto(destination, wait_until='domcontentloaded', timeout=15000)
                finally:
                    await popup.close()
                break
            if not clicked:
                action = await first_visible(page.locator(self.apply_selector)) or await button(page, [r'^apply now$', r'^apply on (the )?(company|employer)(.s)? (site|website)$', r'^şimdi başvur$', r'^hemen başvur$'])
                if action:
                    href = await action.get_attribute('href')
                    if href and (href.startswith('https://') or fixture and host_of(href) in ('127.0.0.1', 'localhost')) and not self.matches(href):
                        return {'offsite': action}
                    await action.click(timeout=8000)
                    clicked = True
            await page.wait_for_timeout(100)
        return None

    async def submit_button(self, scope):
        return await first_visible(scope.locator('#ia-SubmitButton, button[data-testid="submit-application-button"], button[name="submitApplication"]')) or await super().submit_button(scope)

    async def snapshot(self, page, scope):
        data = await super().snapshot(page, scope)
        data.update(frame_url=scope.url if scope is not page and hasattr(scope, 'url') else '', top=await self.applied_text(page), text=await page_text(page, 8000))
        return data

    async def evidence(self, page, scope, before):
        urls = [page.url] + ([scope.url] if scope is not page and hasattr(scope, 'url') else [])
        old = [before.get('url', ''), before.get('frame_url', '')]
        for url in urls:
            if self.confirmation_path(url) and not any(self.confirmation_path(previous) for previous in old) and not await self.form_still_open(scope):
                return {'kind': 'confirmation_url', 'url': url, 'text': 'Indeed application confirmation page'}
        top = await self.applied_text(page)
        if top != before.get('top') and re.search(r'^\s*(applied|application submitted|başvuruldu)\s*$', top, re.I) and not await self.form_still_open(scope):
            return {'kind': 'top_card_applied', 'text': top, 'url': page.url}
        return await super().evidence(page, scope, before)

    async def outcome_problem(self, page, scope, before):
        text = await page_text(page, 8000)
        if self.limit.search(text) and not self.limit.search(before.get('text', '')):
            return {'state': 'rate_limited', 'note': 'Indeed reports an application limit.'}
        return await super().outcome_problem(page, scope, before)


class Glassdoor(Indeed):
    family = 'glassdoor'
    domains = ('glassdoor.com', 'glassdoor.co.uk', 'glassdoor.de', 'glassdoor.fr', 'glassdoor.nl', 'glassdoor.ca', 'glassdoor.co.in', 'glassdoor.com.au', 'glassdoor.ie', 'glassdoor.es')
    apply_selector = '[data-test="applyButton"], [data-test="apply-button"], [data-testid="applyButton"], [data-test="easyApply"], [data-test="easy-apply-button"]'
    form_selector = '[data-test="easy-apply-modal"], [data-testid="easy-apply-modal"], [data-test="application-form"]'

    @staticmethod
    def application_url(url):
        return bool(re.search(r'/(?:apply|application)(?:/|$)', urlparse(url).path, re.I))

    async def blocker(self, page):
        if await human_check_visible(page):
            return {'state': 'needs_human_verification', 'note': 'Glassdoor asks for verification. Complete it in its normal browser window.'}
        if re.search(r'/profile/login|/member/|/login|/signin', urlparse(page.url).path, re.I) or await first_visible(page.locator('input[type=password], [data-ab-login-wall]')):
            return {'state': 'needs_login', 'note': 'Connect your Glassdoor account and finish signing in before retrying.'}
        text = await page_text(page, 5000)
        if self.limit.search(text):
            return {'state': 'rate_limited', 'note': 'Glassdoor reports an application limit.'}
        if re.search(r'^\s*(applied|application submitted)\s*$', await self.applied_text(page), re.I):
            return {'state': 'already_applied', 'note': 'Glassdoor already shows this application as sent.'}
        return None

    async def application_scope(self, page):
        for frame in page.frames[1:]:
            if family_for(frame.url) in ('indeed', 'greenhouse', 'lever', 'ashby', 'workable'):
                try:
                    if await (await frame.frame_element()).is_visible():
                        return {'redirect': frame.url}
                except Exception:
                    pass
        for index, dialog in enumerate(await page.get_by_role('dialog').all()):
            if await dialog.is_visible() and await dialog.locator('input:not([type=hidden]):not([type=password]), textarea, select').count():
                # Keep the dialog index stable when a later review step removes its fields.
                return page.get_by_role('dialog').nth(index)
        return await super().application_scope(page)


class JobBoard(Adapter):
    """Read-only handoff from an aggregator to its actual application destination."""
    discovery_only = True

    def __init__(self, family, domains):
        self.family, self.domains = family, domains

    async def blocker(self, page):
        blocked = await super().blocker(page)
        if blocked:
            return blocked
        if self.family == 'jobicy' and await first_visible(page.locator('#jv-open-apply-auth')):
            return {'state': 'needs_login', 'note': 'Jobicy requires its own account before showing the application link. Open this posting in your browser to sign in; nothing sent.'}
        return None

    async def open(self, page, job):
        semantic_checked = False
        for _ in range(20):
            blocked = await self.blocker(page)
            if blocked:
                return {'blocked': blocked}
            links = page.locator('a[href]')
            candidates = await links.evaluate_all('''els => els.slice(0,250).map((e,index) => ({index,href:e.getAttribute('href'),label:(e.getAttribute('aria-label')||e.innerText||'').trim(),visible:!!e.getClientRects().length})).filter(e=>e.visible)''')
            for item in candidates:
                label = item['label']
                if re.match(r'^apply(?: now| for (?:this|the) (?:job|position)| on (?:the )?(?:company|employer)(?:.s)? (?:site|website))?[\s↗→!]*$', label, re.I):
                    link = links.nth(item['index'])
                    href = await link.get_attribute('href')
                    if href != item['href']:
                        continue
                    if href and not href.startswith(('#', 'javascript:', 'mailto:')):
                        return {'offsite': link}
            action = await button(page, [r'^apply now$', r'^apply for this job$', r'^apply$'])
            if action:
                return {'offsite': action}
            # Structural metadata and the shared multilingual classifier avoid a separate
            # list of translated Apply labels for every source/language. Handoff is read-only.
            structural_action = await first_visible(page.locator('[data-apply-button]'))
            if structural_action:
                return {'offsite': structural_action}
            structural = page.locator('a[href][data-testid*="apply" i], a[href][data-test*="apply" i], a[href][id*="apply" i]')
            structural_items = [item for item in await structural.all() if await item.is_visible()]
            if len(structural_items) == 1:
                return {'offsite': structural_items[0]}
            if CLASSIFY and not semantic_checked and candidates:
                semantic_checked = True
                labelled = [item for item in candidates if 0 < len(item['label']) <= 120][:50]
                results = await CLASSIFY('buttons', [item['label'] for item in labelled])
                matches = [item for item,result in zip(labelled,results or []) if result and result['label'] == 'submit' and result['score'] >= 0.72]
                if len(matches) == 1:
                    return {'offsite': links.nth(matches[0]['index'])}
            await page.wait_for_timeout(100)
        return {'blocked': {'state': 'unsupported_site', 'note': 'No unambiguous application link was found on this job page. Open it to review.'}}


ADAPTERS = [LinkedIn(), Indeed(), Glassdoor(), Greenhouse(), Lever(), Ashby(), Workable(), BambooHR(),
            JobBoard('himalayas', ('himalayas.app',)), JobBoard('remoteok', ('remoteok.com',)),
            JobBoard('jobicy', ('jobicy.com',)), JobBoard('remotive', ('remotive.com', 'remotive.io')),
            JobBoard('arbeitnow', ('arbeitnow.com',)), JobBoard('google', ('google.com',))]
GENERIC = Adapter()


def adapter_for(url, override=None):
    """Adapter by exact host. A family override is honoured only for loopback test fixtures."""
    if override:
        host = host_of(url)
        if host in ('127.0.0.1', 'localhost'):
            return next((a for a in ADAPTERS if a.family == override), GENERIC)
    return next((a for a in ADAPTERS if a.matches(url)), GENERIC)


def family_for(url):
    adapter = adapter_for(url)
    return adapter.family if adapter is not GENERIC else None
