// TapSubmit Chrome & Edge Extension Background Service Worker (Manifest V3)
// Executes multi-source job discovery (with caching, continuation cursors, and rate limits)
// and coordinates tab-based form filling, tap-to-submit, and auto-submit using the user's browser sessions.

const ALLOWED_ORIGINS = new Set([
  'https://tapsubmit.com',
  'https://www.tapsubmit.com',
  'http://127.0.0.1:8788',
  'http://127.0.0.1:53357',
  'http://localhost:8788',
  'http://localhost:53357'
]);

const FEED_TTL_MS = 10 * 60 * 1000;
const preparedTabs = new Map(); // job_id -> { tabId, job, disclosure }
const activeQueue = [];
let workersRunning = 0;
const MAX_CONCURRENCY = 2;

function isAllowedOrigin(origin) {
  if (!origin) return false;
  if (ALLOWED_ORIGINS.has(origin)) return true;
  return /^http:\/\/(127\.0\.0\.1|localhost):\d+$/.test(origin);
}

async function getStore(key, fallback = null) {
  const data = await chrome.storage.local.get([key]);
  return data[key] !== undefined ? data[key] : fallback;
}

async function setStore(key, value) {
  await chrome.storage.local.set({ [key]: value });
}

function stripHtml(html = '') {
  return String(html || '')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim();
}

function classifyRoute(url = '') {
  const lower = String(url || '').toLowerCase();
  if (lower.includes('greenhouse.io') || lower.includes('grnh.se') || lower.includes('/gh/')) return { label: 'Greenhouse', family: 'greenhouse', automatable: true };
  if (lower.includes('lever.co') || lower.includes('/lever/')) return { label: 'Lever', family: 'lever', automatable: true };
  if (lower.includes('ashbyhq.com') || lower.includes('/ashby/')) return { label: 'Ashby', family: 'ashby', automatable: true };
  if (lower.includes('workable.com')) return { label: 'Workable', family: 'workable', automatable: true };
  if (lower.includes('linkedin.com')) return { label: 'LinkedIn', family: 'linkedin', automatable: true };
  return { label: 'Direct apply', family: 'generic', automatable: true };
}

// Extension-level multi-source fetchers (runs from the user's device, including non-CORS sources)
const EXTENSION_SOURCES = {
  himalayas: {
    label: 'Himalayas',
    async fetchPage(query, page = 1) {
      const offset = (page - 1) * 50;
      const res = await fetch(`https://himalayas.app/jobs/api?limit=50&offset=${offset}`, { signal: AbortSignal.timeout(9000) });
      if (!res.ok) throw Object.assign(new Error('HTTP ' + res.status), { status: res.status });
      const data = await res.json();
      const rows = Array.isArray(data?.jobs) ? data.jobs : [];
      return rows.map(r => ({
        id: 'himalayas:' + (r.guid || r.id || r.applicationLink),
        title: String(r.title || '').trim(),
        company: String(r.companyName || '').trim(),
        location: Array.isArray(r.locationRestrictions) && r.locationRestrictions.length ? r.locationRestrictions.join(', ') : 'Remote',
        workplace: 'remote',
        description: stripHtml(r.description || r.excerpt || '').slice(0, 4000),
        url: String(r.applicationLink || r.guid || '').trim(),
        posted_at: r.pubDate ? new Date(r.pubDate * 1000).toISOString() : null,
        source: 'himalayas',
        skills: Array.isArray(r.categories) ? r.categories.slice(0, 6) : []
      }));
    }
  },
  remoteok: {
    label: 'Remote OK',
    async fetchPage() {
      const res = await fetch('https://remoteok.com/api', { signal: AbortSignal.timeout(9000) });
      if (!res.ok) throw Object.assign(new Error('HTTP ' + res.status), { status: res.status });
      const raw = await res.json();
      const rows = Array.isArray(raw) ? raw.filter(r => r && r.id && r.position) : [];
      return rows.map(r => ({
        id: 'remoteok:' + r.id,
        title: String(r.position || '').trim(),
        company: String(r.company || '').trim(),
        location: String(r.location || 'Remote').trim(),
        workplace: 'remote',
        description: stripHtml(r.description || '').slice(0, 4000),
        url: String(r.apply_url || r.url || '').trim(),
        posted_at: r.date || null,
        source: 'remoteok',
        skills: Array.isArray(r.tags) ? r.tags.slice(0, 8) : []
      }));
    }
  },
  jobicy: {
    label: 'Jobicy',
    async fetchPage(query) {
      const tag = encodeURIComponent(String(query || '').split(/\s+/)[0] || '');
      const res = await fetch('https://jobicy.com/api/v2/remote-jobs?count=50' + (tag ? '&tag=' + tag : ''), { signal: AbortSignal.timeout(9000) });
      if (!res.ok) throw Object.assign(new Error('HTTP ' + res.status), { status: res.status });
      const data = await res.json();
      return (Array.isArray(data?.jobs) ? data.jobs : []).map(r => ({
        id: 'jobicy:' + r.id,
        title: String(r.jobTitle || '').trim(),
        company: String(r.companyName || '').trim(),
        location: String(r.jobGeo || 'Remote').trim(),
        workplace: 'remote',
        description: stripHtml(r.jobDescription || r.jobExcerpt || '').slice(0, 4000),
        url: String(r.url || '').trim(),
        posted_at: r.pubDate || null,
        source: 'jobicy',
        skills: Array.isArray(r.jobIndustry) ? r.jobIndustry.slice(0, 5) : []
      }));
    }
  },
  remotive: {
    label: 'Remotive',
    async fetchPage(query) {
      const q = encodeURIComponent(String(query || '').trim());
      const res = await fetch('https://remotive.com/api/remote-jobs?limit=50' + (q ? '&search=' + q : ''), { signal: AbortSignal.timeout(9000) });
      if (!res.ok) throw Object.assign(new Error('HTTP ' + res.status), { status: res.status });
      const data = await res.json();
      return (Array.isArray(data?.jobs) ? data.jobs : []).map(r => ({
        id: 'remotive:' + r.id,
        title: String(r.title || '').trim(),
        company: String(r.company_name || '').trim(),
        location: String(r.candidate_required_location || 'Remote').trim(),
        workplace: 'remote',
        description: stripHtml(r.description || '').slice(0, 4000),
        url: String(r.url || '').trim(),
        posted_at: r.publication_date || null,
        source: 'remotive',
        skills: Array.isArray(r.tags) ? r.tags.slice(0, 8) : []
      }));
    }
  },
  arbeitnow: {
    label: 'Arbeitnow',
    async fetchPage(query, page = 1) {
      const res = await fetch(`https://www.arbeitnow.com/api/job-board-api?page=${page}`, { signal: AbortSignal.timeout(9000) });
      if (!res.ok) throw Object.assign(new Error('HTTP ' + res.status), { status: res.status });
      const data = await res.json();
      return (Array.isArray(data?.data) ? data.data : []).map(r => ({
        id: 'arbeitnow:' + r.slug,
        title: String(r.title || '').trim(),
        company: String(r.company_name || '').trim(),
        location: String(r.location || '').trim(),
        workplace: r.remote ? 'remote' : 'onsite',
        description: stripHtml(r.description || '').slice(0, 4000),
        url: String(r.url || '').trim(),
        posted_at: r.created_at ? new Date(r.created_at * 1000).toISOString() : null,
        source: 'arbeitnow',
        skills: Array.isArray(r.tags) ? r.tags.slice(0, 8) : []
      }));
    }
  }
};

async function runExtensionSearch(payload, senderTabId) {
  const sites = (payload.sites || Object.keys(EXTENSION_SOURCES)).filter(s => EXTENSION_SOURCES[s]);
  const primaryQuery = String((payload.queries || [])[0] || (payload.titles || [])[0] || '').trim();
  const expand = !!payload.expand;
  const feedCache = (await getStore('ext_feed_cache', {})) || {};
  const cursors = (await getStore('ext_cursors', {})) || {};
  const rates = (await getStore('ext_rates', {})) || {};
  const now = Date.now();
  const allJobs = [];

  await Promise.all(sites.map(async site => {
    const rate = rates[site] || {};
    if (rate.cooldown_until && now < rate.cooldown_until) return;
    const cursorKey = `${site}:${primaryQuery.toLowerCase()}`;
    const prev = cursors[cursorKey] || { page: 1 };
    const page = expand ? Math.min(4, (prev.page || 1) + 1) : 1;
    const cacheKey = `${cursorKey}:p${page}`;
    let jobs = null;
    if (!expand && feedCache[cacheKey] && now - feedCache[cacheKey].at < FEED_TTL_MS) {
      jobs = feedCache[cacheKey].jobs;
    } else {
      try {
        jobs = await EXTENSION_SOURCES[site].fetchPage(primaryQuery, page);
        feedCache[cacheKey] = { at: now, jobs: jobs.slice(0, 120) };
        cursors[cursorKey] = { page, count: jobs.length, at: now };
        rates[site] = { last_ok_at: now, cooldown_until: 0 };
      } catch (err) {
        if (err?.status === 429) rates[site] = { ...rate, cooldown_until: now + 60000 };
        jobs = feedCache[cacheKey]?.jobs || [];
      }
    }
    const decorated = (jobs || []).map(j => {
      const route = classifyRoute(j.url);
      return {
        ...j,
        target: route.label,
        family: route.family,
        automatable: route.automatable
      };
    });
    allJobs.push(...decorated);
    if (senderTabId) {
      chrome.tabs.sendMessage(senderTabId, {
        type: 'EXTENSION_SOURCE_BATCH',
        site,
        label: EXTENSION_SOURCES[site].label,
        page,
        jobs: decorated
      }).catch(() => {});
    }
  }));

  await setStore('ext_feed_cache', feedCache);
  await setStore('ext_cursors', cursors);
  await setStore('ext_rates', rates);
  return { ok: true, count: allJobs.length, jobs: allJobs };
}

async function syncFromServer(authContext) {
  const ctx = authContext || (await getStore('ext_auth', null));
  if (!ctx?.apiBase) return null;
  try {
    const headers = { 'X-ApplyBurst-Extension': '1' };
    if (ctx.authToken) headers['Authorization'] = 'Bearer ' + ctx.authToken;
    if (ctx.csrf) headers['X-CSRF-Token'] = ctx.csrf;
    const res = await fetch(ctx.apiBase + 'extension/sync', {
      method: 'GET',
      credentials: 'include',
      headers
    });
    if (!res.ok) return null;
    const state = await res.json();
    await setStore('ext_member_state', { ...state, synced_at: Date.now() });
    return state;
  } catch {
    return await getStore('ext_member_state', null);
  }
}

async function reportEventToServerAndWebsite(event) {
  const ctx = await getStore('ext_auth', null);
  if (ctx?.websiteTabId) {
    chrome.tabs.sendMessage(ctx.websiteTabId, { type: 'EXTENSION_APPLICATION_EVENT', event }).catch(() => {});
  }
  if (ctx?.apiBase) {
    try {
      const headers = { 'Content-Type': 'application/json', 'X-ApplyBurst-Extension': '1' };
      if (ctx.authToken) headers['Authorization'] = 'Bearer ' + ctx.authToken;
      if (ctx.csrf) headers['X-CSRF-Token'] = ctx.csrf;
      await fetch(ctx.apiBase + 'extension/event', {
        method: 'POST',
        credentials: 'include',
        headers,
        body: JSON.stringify(event)
      });
    } catch {}
  }
}

async function waitForTabComplete(tabId, timeoutMs = 15000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const tab = await chrome.tabs.get(tabId);
      if (tab.status === 'complete') return true;
    } catch {
      return false;
    }
    await new Promise(r => setTimeout(r, 200));
  }
  return false;
}

async function processQueueItem(item) {
  const { job, mode } = item;
  await reportEventToServerAndWebsite({
    job_id: job.id,
    state: 'preparing',
    at: Date.now() / 1000,
    detail: { note: 'Opening application form in browser' }
  });

  const memberState = (await syncFromServer()) || (await getStore('ext_member_state', {})) || {};
  let tab;
  try {
    tab = await chrome.tabs.create({ url: job.url, active: false });
    const loaded = await waitForTabComplete(tab.id, 15000);
    if (!loaded) {
      await chrome.tabs.remove(tab.id).catch(() => {});
      await reportEventToServerAndWebsite({
        job_id: job.id,
        state: 'deferred_slow',
        at: Date.now() / 1000,
        detail: { note: 'Application page took too long to load.' }
      });
      return;
    }
    await new Promise(r => setTimeout(r, 500));

    const scanResult = await chrome.tabs.sendMessage(tab.id, {
      type: 'SCAN_AND_FILL_FORM',
      job,
      mode,
      memberState
    });

    if (!scanResult || scanResult.status === 'captcha_or_login') {
      preparedTabs.set(job.id, { tabId: tab.id, job, disclosure: scanResult?.disclosure || [] });
      await reportEventToServerAndWebsite({
        job_id: job.id,
        state: 'needs_human',
        at: Date.now() / 1000,
        detail: {
          note: scanResult?.reason || 'Sign-in or security verification needed on this tab.',
          disclosure: scanResult?.disclosure || [],
          tab_id: tab.id
        }
      });
      return;
    }

    if (scanResult.status === 'needs_answers') {
      preparedTabs.set(job.id, { tabId: tab.id, job, disclosure: scanResult.disclosure || [] });
      await reportEventToServerAndWebsite({
        job_id: job.id,
        state: 'needs_answers',
        at: Date.now() / 1000,
        detail: {
          note: 'Required questions need your answer.',
          missing: scanResult.missing || [],
          disclosure: scanResult.disclosure || [],
          tab_id: tab.id
        }
      });
      return;
    }

    if (mode === 'tap') {
      // Tap-to-submit mode: pause at Ready and wait for single tap
      preparedTabs.set(job.id, { tabId: tab.id, job, disclosure: scanResult.disclosure || [] });
      await reportEventToServerAndWebsite({
        job_id: job.id,
        state: 'ready_to_submit',
        at: Date.now() / 1000,
        detail: {
          note: 'Prepared and ready to submit.',
          disclosure: scanResult.disclosure || [],
          tab_id: tab.id
        }
      });
      return;
    }

    // Auto-submit mode: submit immediately and verify confirmation
    await executeSubmitOnTab(job.id, tab.id, scanResult.disclosure || []);
  } catch (err) {
    if (tab?.id) await chrome.tabs.remove(tab.id).catch(() => {});
    await reportEventToServerAndWebsite({
      job_id: job.id,
      state: 'needs_human',
      at: Date.now() / 1000,
      detail: { note: err?.message || 'Could not inspect application form.' }
    });
  }
}

async function executeSubmitOnTab(jobId, tabId, disclosure = []) {
  await reportEventToServerAndWebsite({
    job_id: jobId,
    state: 'submitting',
    at: Date.now() / 1000,
    detail: { note: 'Submitting application...', disclosure }
  });
  try {
    const submitRes = await chrome.tabs.sendMessage(tabId, { type: 'EXECUTE_SUBMIT', jobId });
    if (submitRes?.confirmed) {
      preparedTabs.delete(jobId);
      await chrome.tabs.remove(tabId).catch(() => {});
      await reportEventToServerAndWebsite({
        job_id: jobId,
        state: 'confirmed',
        at: Date.now() / 1000,
        detail: {
          note: submitRes.evidence || 'Employer confirmation verified.',
          confirmation: submitRes.evidence || 'Application confirmed',
          confirmation_url: submitRes.url || null,
          disclosure
        }
      });
    } else {
      await reportEventToServerAndWebsite({
        job_id: jobId,
        state: 'needs_human',
        at: Date.now() / 1000,
        detail: {
          note: submitRes?.reason || 'Submitted click executed, but confirmation banner was not yet detected. Check tab to verify.',
          disclosure,
          tab_id: tabId
        }
      });
    }
  } catch (err) {
    await reportEventToServerAndWebsite({
      job_id: jobId,
      state: 'needs_human',
      at: Date.now() / 1000,
      detail: { note: err?.message || 'Submission interrupted; review tab.', disclosure, tab_id: tabId }
    });
  }
}

async function pumpQueue() {
  while (workersRunning < MAX_CONCURRENCY && activeQueue.length > 0) {
    const next = activeQueue.shift();
    workersRunning++;
    processQueueItem(next).finally(() => {
      workersRunning--;
      pumpQueue();
    });
  }
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    if (msg?.type === 'WEBSITE_BRIDGE_INIT') {
      const origin = sender.origin || (sender.url ? new URL(sender.url).origin : '');
      if (!isAllowedOrigin(origin)) {
        sendResponse({ ok: false, error: 'Unauthorized origin' });
        return;
      }
      const prev = (await getStore('ext_auth', {})) || {};
      const nextCtx = {
        ...prev,
        apiOrigin: origin,
        apiBase: msg.apiBase || (origin + '/applyburst/api/'),
        authToken: msg.authToken || prev.authToken || null,
        csrf: msg.csrf || prev.csrf || null,
        websiteTabId: sender.tab?.id || prev.websiteTabId || null,
        updatedAt: Date.now()
      };
      await setStore('ext_auth', nextCtx);
      const synced = await syncFromServer(nextCtx);
      sendResponse({
        ok: true,
        extensionVersion: chrome.runtime.getManifest().version,
        synced: !!synced,
        preparedIds: [...preparedTabs.keys()]
      });
      return;
    }

    if (msg?.type === 'EXTENSION_SEARCH') {
      const result = await runExtensionSearch(msg.payload || {}, sender.tab?.id);
      sendResponse(result);
      return;
    }

    if (msg?.type === 'QUEUE_APPLICATIONS') {
      const jobs = Array.isArray(msg.jobs) ? msg.jobs : [];
      const mode = msg.mode === 'auto' ? 'auto' : 'tap';
      for (const job of jobs) {
        if (!activeQueue.some(q => q.job.id === job.id)) {
          activeQueue.push({ job, mode });
        }
      }
      pumpQueue();
      sendResponse({ ok: true, queued: jobs.length });
      return;
    }

    if (msg?.type === 'SUBMIT_PREPARED') {
      const jobId = msg.job_id;
      const entry = preparedTabs.get(jobId);
      if (entry?.tabId) {
        if (msg.answers && typeof msg.answers === 'object') {
          await chrome.tabs.sendMessage(entry.tabId, { type: 'APPLY_ANSWERS', answers: msg.answers }).catch(() => {});
        }
        executeSubmitOnTab(jobId, entry.tabId, entry.disclosure);
        sendResponse({ ok: true, submitting: true });
      } else if (msg.job?.url) {
        activeQueue.unshift({ job: msg.job, mode: 'auto' });
        pumpQueue();
        sendResponse({ ok: true, submitting: true });
      } else {
        sendResponse({ ok: false, error: 'Prepared tab not found' });
      }
      return;
    }

    if (msg?.type === 'FOCUS_PREPARED_TAB') {
      const entry = preparedTabs.get(msg.job_id);
      if (entry?.tabId) {
        await chrome.tabs.update(entry.tabId, { active: true });
        sendResponse({ ok: true });
      } else {
        sendResponse({ ok: false });
      }
      return;
    }

    if (msg?.type === 'GET_MEMBER_STATE_FOR_PAGE') {
      const state = (await syncFromServer()) || (await getStore('ext_member_state', null));
      const auth = await getStore('ext_auth', null);
      sendResponse({ ok: true, state, auth });
      return;
    }

    if (msg?.type === 'PAGE_APPLICATION_EVENT') {
      await reportEventToServerAndWebsite(msg.event);
      sendResponse({ ok: true });
      return;
    }

    if (msg?.type === 'SAVE_NEW_ANSWER') {
      const ctx = await getStore('ext_auth', null);
      if (ctx?.apiBase && msg.answers) {
        const headers = { 'Content-Type': 'application/json', 'X-ApplyBurst-Extension': '1' };
        if (ctx.authToken) headers['Authorization'] = 'Bearer ' + ctx.authToken;
        if (ctx.csrf) headers['X-CSRF-Token'] = ctx.csrf;
        await fetch(ctx.apiBase + 'answers', {
          method: 'POST',
          credentials: 'include',
          headers,
          body: JSON.stringify({ answers: msg.answers })
        }).catch(() => {});
        await syncFromServer(ctx);
      }
      sendResponse({ ok: true });
      return;
    }

    sendResponse({ ok: false, error: 'Unknown message type' });
  })();
  return true;
});
