// TapSubmit On-Page Application Assistant & Automated Form Filler (Chrome & Edge)
// Supports both:
// 1. User-opened application pages: renders a minimal floating TapSubmit bar ("Fill", "Review", "Submit")
// 2. Website-driven automated flow: scans, fills known fields, attaches CV, pauses on CAPTCHA/unknown questions,
//    and verifies employer confirmation receipts before reporting "confirmed" ("Applied").

(function () {
  if (window.__tapsubmitApplyInjected) return;
  window.__tapsubmitApplyInjected = true;

  const host = location.hostname.toLowerCase();
  if (host === 'tapsubmit.com' || host === 'www.tapsubmit.com') return;
  if ((host === '127.0.0.1' || host === 'localhost') && location.pathname.startsWith('/applyburst')) return;

  let cachedMemberState = null;
  let lastScan = null;
  let widgetEl = null;

  function norm(text) {
    return String(text || '')
      .normalize('NFKC')
      .replace(/[ıİ]/g, 'i')
      .toLowerCase()
      .replace(/[*✱]+/g, ' ')
      .replace(/\((?:required|optional|zorunlu|isteğe bağlı)\)/gi, ' ')
      .normalize('NFKD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/\s+/g, ' ')
      .replace(/^[\s:?.-]+|[\s:?.-]+$/g, '');
  }

  function simpleHash(str) {
    let h = 2166136261;
    for (let i = 0; i < str.length; i++) {
      h ^= str.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    return 'q_' + (h >>> 0).toString(16);
  }

  function detectSecurityOrLoginWall() {
    if (document.querySelector('iframe[src*="recaptcha"], iframe[src*="hcaptcha"], iframe[src*="turnstile"], .g-recaptcha, .h-captcha, .cf-turnstile')) {
      return 'Security verification (CAPTCHA) requires your attention.';
    }
    const bodyText = (document.body?.innerText || '').slice(0, 2000).toLowerCase();
    if (document.querySelector('input[type="password"]') && /sign in|log in|giriş yap/i.test(bodyText)) {
      return 'Sign in to your job-site account on this tab to continue.';
    }
    return null;
  }

  function detectConfirmationReceipt() {
    const text = (document.body?.innerText || '').slice(0, 6000);
    const patterns = [
      /thank you for applying/i,
      /application(?: has been)? submitted/i,
      /we(?:'ve| have) received your application/i,
      /your application was sent/i,
      /başvurunuz alındı/i,
      /gracias por postular/i,
      /vielen dank für ihre bewerbung/i
    ];
    for (const re of patterns) {
      const m = text.match(re);
      if (m) return m[0];
    }
    if (/confirmation|submitted|thank-you|thanks/i.test(location.pathname + location.search)) {
      return 'Confirmation page reached (' + location.pathname + ')';
    }
    const receiptEl = document.querySelector('[data-receipt-id], #application-confirmation, .application-confirmation');
    if (receiptEl) return receiptEl.innerText.trim().slice(0, 140) || 'Confirmation receipt verified';
    return null;
  }

  function findLabelForControl(el) {
    if (el.id) {
      const explicit = document.querySelector(`label[for="${CSS.escape(el.id)}"]`);
      if (explicit?.innerText?.trim()) return explicit.innerText.trim();
    }
    const parentLabel = el.closest('label');
    if (parentLabel) {
      const clone = parentLabel.cloneNode(true);
      clone.querySelectorAll('input,select,textarea').forEach(n => n.remove());
      if (clone.innerText?.trim()) return clone.innerText.trim();
    }
    const ariaLabel = el.getAttribute('aria-label');
    if (ariaLabel?.trim()) return ariaLabel.trim();
    const wrapper = el.closest('.field, .form-group, .application-question, [data-qa], li, div');
    if (wrapper) {
      const heading = wrapper.querySelector('label, .label, .field-label, legend, h4');
      if (heading?.innerText?.trim()) return heading.innerText.trim();
    }
    return el.getAttribute('placeholder') || el.name || '';
  }

  function resolveFieldValue(label, type, nameAttr, options, memberState) {
    const l = norm(label || nameAttr);
    const profile = memberState?.profile || {};
    const prefs = memberState?.preferences || {};
    const answers = memberState?.answer_bank || {};
    const fullName = String(profile.name || '').trim();
    const parts = fullName.split(/\s+/).filter(Boolean);
    const firstName = parts.length > 1 ? parts.slice(0, -1).join(' ') : (parts[0] || '');
    const lastName = parts.length > 1 ? parts[parts.length - 1] : '';

    if (type === 'file') {
      if (/cover.?letter|motivasyon/i.test(l)) return null;
      if (/resume|cv|özgeçmiş|curriculum/i.test(l) || /resume|cv/i.test(nameAttr)) {
        return memberState?.resume?.base64 ? { kind: 'file', resume: memberState.resume } : null;
      }
      return null;
    }

    if (/^(full )?name$|^ad soyad$/i.test(l) || nameAttr === 'name') return fullName || null;
    if (/^first name$|^given name$|^adınız$/i.test(l) || nameAttr === 'first_name') return firstName || null;
    if (/^last name$|^surname$|^family name$|^soyadınız$/i.test(l) || nameAttr === 'last_name') return lastName || null;
    if (/email|e-posta/i.test(l) || type === 'email') return profile.email || null;
    if (/phone|mobile|telefon/i.test(l) || type === 'tel') return profile.phone || null;
    if (/^(current )?(city|location|address)$|^konum$|^şehir$/i.test(l) || nameAttr === 'location') return profile.location || null;
    if (/linkedin/i.test(l)) return profile.linkedin || prefs.website?.value || null;
    if (/github/i.test(l)) return profile.github || null;
    if (/portfolio/i.test(l)) return prefs.portfolio_url?.value || prefs.website?.value || profile.github || null;
    if (/website|personal site|blog/i.test(l)) return prefs.website?.value || prefs.portfolio_url?.value || null;
    if (/current (company|employer)|org/i.test(l) || nameAttr === 'org') return prefs.current_company?.value || null;
    if (/current (job )?title/i.test(l)) return prefs.current_title?.value || profile.headline || null;
    if (/hours (per|a|each) week|weekly hours|haftada kaç saat/i.test(l) || nameAttr === 'weekly_hours') return prefs.weekly_hours?.value || null;
    if (/notice period|how much notice|ihbar/i.test(l)) return prefs.notice_period?.value || null;
    if (/start date|when can you start|ne zaman/i.test(l)) return prefs.earliest_start_date?.value || null;
    if (/relocat|taşın/i.test(l)) return prefs.relocation?.value || null;
    if (/pronoun/i.test(l)) return prefs.pronouns?.value || null;
    if (/university|college|school|üniversite/i.test(l)) return prefs.university?.value || null;
    if (/graduation year|mezuniyet/i.test(l)) return prefs.graduation_year?.value || null;
    if (/how did you hear|referral source/i.test(l)) return prefs.how_heard?.value || null;

    const skillMatch = l.match(/years of (?:work |professional )?experience (?:do you have )?(?:with|in|using) ([a-z0-9+#.-]+)/) || l.match(/years of ([a-z0-9+#.-]+) experience/);
    if (skillMatch && prefs['years_experience:' + skillMatch[1]]?.value) {
      return prefs['years_experience:' + skillMatch[1]].value;
    }
    if (/years of (?:professional |work |total )?experience/i.test(l) && prefs.years_experience?.value) {
      return prefs.years_experience.value;
    }

    if (/salary|compensation|maaş/i.test(l) || nameAttr === 'expected_salary') {
      for (const [k, v] of Object.entries(prefs)) {
        if (k.startsWith('salary:') && v?.confirmed && v?.value) return v.value;
      }
    }
    if (/authorized.*work|work authorization|çalışma izni/i.test(l)) {
      for (const [k, v] of Object.entries(prefs)) {
        if (k.startsWith('work_authorization:') && v?.confirmed && v?.value) return v.value;
      }
    }
    if (/visa|sponsorship/i.test(l)) {
      for (const [k, v] of Object.entries(prefs)) {
        if (k.startsWith('visa_sponsorship:') && v?.confirmed && v?.value) return v.value;
      }
    }

    const qHash = simpleHash(l);
    if (answers[qHash]?.value !== undefined) return answers[qHash].value;
    if (answers[l]?.value !== undefined) return answers[l].value;
    return null;
  }

  function setInputValue(el, val) {
    if (el.tagName === 'SELECT') {
      const target = norm(val);
      const yesWords = new Set(['yes', 'evet', 'ja', 'true', '1']);
      const noWords = new Set(['no', 'hayir', 'nein', 'false', '0']);
      let matched = null;
      for (const opt of el.options) {
        const oNorm = norm(opt.text || opt.value);
        if (oNorm === target || norm(opt.value) === target) { matched = opt.value; break; }
        if (yesWords.has(target) && yesWords.has(oNorm)) { matched = opt.value; break; }
        if (noWords.has(target) && noWords.has(oNorm)) { matched = opt.value; break; }
      }
      if (matched === null) return false;
      el.value = matched;
    } else {
      const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
      if (setter) setter.call(el, String(val));
      else el.value = String(val);
    }
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  }

  function attachResumeFile(fileInput, resumeObj) {
    try {
      const binary = atob(resumeObj.base64);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
      const file = new File([bytes], resumeObj.filename || 'resume.pdf', { type: resumeObj.mime || 'application/pdf' });
      const dt = new DataTransfer();
      dt.items.add(file);
      fileInput.files = dt.files;
      fileInput.dispatchEvent(new Event('input', { bubbles: true }));
      fileInput.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    } catch {
      return false;
    }
  }

  function scanAndFill(memberState) {
    const wall = detectSecurityOrLoginWall();
    if (wall) return { status: 'captcha_or_login', reason: wall, disclosure: [], missing: [] };

    const controls = [...document.querySelectorAll('input:not([type="hidden"]):not([type="submit"]):not([type="button"]), select, textarea')];
    const disclosure = [];
    const missing = [];

    for (const el of controls) {
      if (el.disabled || el.offsetParent === null && el.type !== 'file') continue;
      const label = findLabelForControl(el);
      const type = (el.type || el.tagName).toLowerCase();
      const nameAttr = (el.name || el.id || '').toLowerCase();
      const required = el.required || el.getAttribute('aria-required') === 'true' || /\*|\(required\)|zorunlu/i.test(label);
      if (!label && !nameAttr) continue;

      const resolved = resolveFieldValue(label, type, nameAttr, null, memberState);
      if (resolved && typeof resolved === 'object' && resolved.kind === 'file') {
        if (attachResumeFile(el, resolved.resume)) {
          disclosure.push({ label: label || 'Resume / CV', value: resolved.resume.filename || 'CV attached' });
          continue;
        }
      } else if (resolved !== null && resolved !== undefined && resolved !== '') {
        if (setInputValue(el, resolved)) {
          disclosure.push({ label: label || nameAttr, value: String(resolved) });
          continue;
        }
      }

      if (required && !el.value) {
        const fingerprint = simpleHash(norm(label || nameAttr));
        const options = el.tagName === 'SELECT'
          ? [...el.options].filter(o => o.value).map(o => ({ label: o.text.trim(), value: o.value }))
          : [];
        missing.push({
          fingerprint,
          label: (label || nameAttr).replace(/\s+/g, ' ').trim(),
          kind: el.tagName === 'SELECT' ? 'select' : type,
          options
        });
        el.style.outline = '2px solid #d97706';
        el.dataset.tapsubmitFingerprint = fingerprint;
        el.dataset.tapsubmitLabel = (label || nameAttr).trim();
      }
    }

    const status = missing.length > 0 ? 'needs_answers' : 'ready';
    lastScan = { status, disclosure, missing };
    updateFloatingBar();
    return lastScan;
  }

  async function executeSubmit() {
    const submitBtn = document.querySelector(
      'button[type="submit"], input[type="submit"], button[id*="submit" i], button[data-qa*="submit" i], .postings-btn-submit'
    );
    if (!submitBtn) {
      return { confirmed: false, reason: 'Submit button not found on form.' };
    }
    submitBtn.click();
    const start = Date.now();
    while (Date.now() - start < 7000) {
      await new Promise(r => setTimeout(r, 250));
      const evidence = detectConfirmationReceipt();
      if (evidence) {
        return { confirmed: true, evidence, url: location.href };
      }
    }
    const finalEvidence = detectConfirmationReceipt();
    return finalEvidence
      ? { confirmed: true, evidence: finalEvidence, url: location.href }
      : { confirmed: false, reason: 'Waiting for employer confirmation banner.' };
  }

  function looksLikeApplicationPage() {
    if (/greenhouse\.io|lever\.co|ashbyhq\.com|workable\.com|myworkdayjobs\.com|smartrecruiters\.com|bamboohr\.com/i.test(host)) return true;
    const hasFile = !!document.querySelector('input[type="file"]');
    const hasEmail = !!document.querySelector('input[type="email"], input[name*="email" i]');
    return hasFile && hasEmail;
  }

  function mountFloatingBar() {
    if (widgetEl || !looksLikeApplicationPage()) return;
    widgetEl = document.createElement('div');
    widgetEl.id = 'tapsubmit-floating-bar';
    widgetEl.style.cssText = 'position:fixed;bottom:18px;right:18px;z-index:2147483646;background:#111318;color:#f9fafb;border-radius:999px;padding:8px 14px;display:flex;align-items:center;gap:10px;font:500 13px/1.3 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;box-shadow:0 10px 28px rgba(0,0,0,0.24);border:1px solid rgba(255,255,255,0.12);';
    widgetEl.innerHTML = `
      <span style="width:8px;height:8px;border-radius:50%;background:#10b981;display:inline-block;" id="ts-dot"></span>
      <span id="ts-status-text">TapSubmit</span>
      <button id="ts-fill-btn" type="button" style="background:#2563eb;color:#fff;border:none;border-radius:999px;padding:5px 12px;font:600 12px/1.2 inherit;cursor:pointer;">Fill from CV</button>
      <button id="ts-submit-btn" type="button" style="background:#10b981;color:#052e16;border:none;border-radius:999px;padding:5px 12px;font:600 12px/1.2 inherit;cursor:pointer;display:none;">Submit</button>
    `;
    document.body.appendChild(widgetEl);

    widgetEl.querySelector('#ts-fill-btn').addEventListener('click', async () => {
      const res = await chrome.runtime.sendMessage({ type: 'GET_MEMBER_STATE_FOR_PAGE' });
      cachedMemberState = res?.state || {};
      scanAndFill(cachedMemberState);
    });

    widgetEl.querySelector('#ts-submit-btn').addEventListener('click', async (e) => {
      const btn = e.currentTarget;
      btn.disabled = true;
      btn.textContent = 'Submitting…';
      // Capture any newly typed answers on highlighted fields before submitting
      const newAnswers = {};
      document.querySelectorAll('[data-tapsubmit-fingerprint]').forEach(el => {
        if (el.value?.trim()) {
          newAnswers[el.dataset.tapsubmitFingerprint] = {
            value: el.value.trim(),
            label: el.dataset.tapsubmitLabel || '',
            kind: el.tagName === 'SELECT' ? 'select' : (el.type || 'text'),
            reusable: true
          };
        }
      });
      if (Object.keys(newAnswers).length > 0) {
        chrome.runtime.sendMessage({ type: 'SAVE_NEW_ANSWER', answers: newAnswers }).catch(() => {});
      }
      const out = await executeSubmit();
      const statusText = widgetEl.querySelector('#ts-status-text');
      if (out.confirmed) {
        statusText.textContent = 'Applied ✓';
        btn.style.display = 'none';
        chrome.runtime.sendMessage({
          type: 'PAGE_APPLICATION_EVENT',
          event: {
            job_id: 'manual:' + location.href,
            url: location.href,
            title: document.title,
            state: 'confirmed',
            at: Date.now() / 1000,
            detail: { note: out.evidence, confirmation: out.evidence, disclosure: lastScan?.disclosure || [] }
          }
        }).catch(() => {});
      } else {
        statusText.textContent = out.reason || 'Check form';
        btn.disabled = false;
        btn.textContent = 'Submit';
      }
    });
  }

  function updateFloatingBar() {
    if (!widgetEl || !lastScan) return;
    const dot = widgetEl.querySelector('#ts-dot');
    const txt = widgetEl.querySelector('#ts-status-text');
    const subBtn = widgetEl.querySelector('#ts-submit-btn');
    if (lastScan.status === 'ready') {
      dot.style.background = '#10b981';
      txt.textContent = `Ready (${lastScan.disclosure.length} filled)`;
      subBtn.style.display = 'inline-block';
    } else if (lastScan.status === 'needs_answers') {
      dot.style.background = '#f59e0b';
      txt.textContent = `${lastScan.missing.length} answer${lastScan.missing.length === 1 ? '' : 's'} needed`;
      subBtn.style.display = 'inline-block';
    }
  }

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    (async () => {
      if (msg?.type === 'SCAN_AND_FILL_FORM') {
        cachedMemberState = msg.memberState || cachedMemberState || {};
        const result = scanAndFill(cachedMemberState);
        sendResponse(result);
        return;
      }
      if (msg?.type === 'APPLY_ANSWERS') {
        const answers = msg.answers || {};
        for (const [fp, item] of Object.entries(answers)) {
          const val = typeof item === 'object' ? item.value : item;
          const el = document.querySelector(`[data-tapsubmit-fingerprint="${CSS.escape(fp)}"]`);
          if (el && val !== undefined) setInputValue(el, val);
        }
        sendResponse({ ok: true });
        return;
      }
      if (msg?.type === 'EXECUTE_SUBMIT') {
        const out = await executeSubmit();
        sendResponse(out);
        return;
      }
    })();
    return true;
  });

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', mountFloatingBar);
  } else {
    mountFloatingBar();
  }
})();
