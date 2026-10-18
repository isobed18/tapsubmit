import {resumeText} from './resume-reader.mjs';
import {profileFeatures,sanitizeFeatures} from './features.mjs';
import {matchProfessionalTitles} from './professional.mjs';

const $ = id => document.getElementById(id);
const BASE = '/api/public/';

const SITE_LABELS = {
  linkedin: 'LinkedIn',
  indeed: 'Indeed',
  greenhouse: 'Greenhouse',
  ashby: 'Ashby',
  lever: 'Lever',
  smartrecruiters: 'SmartRecruiters',
  workable: 'Workable',
  personio: 'Personio',
  remoteok: 'Remote OK',
  jobicy: 'Jobicy',
  remotive: 'Remotive',
  arbeitnow: 'Arbeitnow',
  himalayas: 'Himalayas',
  wwr: 'WeWorkRemotely',
  wellfound: 'Wellfound',
  dice: 'Dice',
  boards: 'Company Careers'
};

let features = null, titles = [], vocabulary = null, sequence = 0, limit = 100, manualCountry = false;
let allJobs = [];
const nodeSections = new Map(); // siteId -> { section, countEl, dotEl, stateEl, listEl, count: 0 }

function getCardSite(job) {
  const src = String(job.source || job.provider || '').toLowerCase();
  const fam = String(job.family || '').toLowerCase();
  const id = String(job.id || '').toLowerCase();

  if (src.includes('linkedin') || id.startsWith('linkedin:')) return 'linkedin';
  if (src.includes('greenhouse') || fam.includes('greenhouse') || id.startsWith('greenhouse:')) return 'greenhouse';
  if (src.includes('lever') || fam.includes('lever') || id.startsWith('lever:')) return 'lever';
  if (src.includes('ashby') || fam.includes('ashby') || id.startsWith('ashby:')) return 'ashby';
  if (src.includes('indeed') || id.startsWith('indeed:')) return 'indeed';
  if (src.includes('remoteok') || id.startsWith('remoteok:')) return 'remoteok';
  if (src.includes('jobicy') || id.startsWith('jobicy:')) return 'jobicy';
  if (src.includes('remotive') || id.startsWith('remotive:')) return 'remotive';
  if (src.includes('arbeitnow') || id.startsWith('arbeitnow:')) return 'arbeitnow';
  if (src.includes('himalayas') || id.startsWith('himalayas:')) return 'himalayas';
  if (src.includes('workable') || fam.includes('workable')) return 'workable';
  if (src.includes('smartrecruiters') || fam.includes('smartrecruiters')) return 'smartrecruiters';
  if (src.includes('personio') || fam.includes('personio')) return 'personio';
  if (src.includes('wwr') || id.startsWith('wwr:')) return 'wwr';
  return 'boards';
}

function ensureNodeSection(siteId) {
  if (nodeSections.has(siteId)) return nodeSections.get(siteId);

  const container = $('nodes-stream');
  const label = SITE_LABELS[siteId] || siteId.toUpperCase();

  const section = document.createElement('section');
  section.className = 'site-node-section';
  section.id = 'node-section-' + siteId;

  section.innerHTML = `
    <div class="node-section-header">
      <div class="node-header-left">
        <span class="node-status-dot idle" id="dot-${siteId}"></span>
        <h3 class="node-title">${label}</h3>
        <span class="node-badge" id="badge-${siteId}">0 found</span>
      </div>
      <div class="node-header-right">
        <span class="node-state-text" id="state-${siteId}">Searching…</span>
      </div>
    </div>
    <div class="node-jobs-list" id="jobs-${siteId}">
      <div class="node-empty-msg" id="empty-${siteId}">Searching for matching opportunities…</div>
    </div>
  `;

  container.append(section);

  const meta = {
    section,
    countEl: section.querySelector('#badge-' + siteId),
    dotEl: section.querySelector('#dot-' + siteId),
    stateEl: section.querySelector('#state-' + siteId),
    listEl: section.querySelector('#jobs-' + siteId),
    emptyEl: section.querySelector('#empty-' + siteId),
    count: 0
  };

  nodeSections.set(siteId, meta);
  return meta;
}

function updateNodeStatus(siteId, { state = 'searching', count = 0, captcha = false, error = null }) {
  const node = ensureNodeSection(siteId);
  node.dotEl.className = 'node-status-dot ' + (captcha ? 'captcha' : state);

  if (captcha) {
    node.stateEl.textContent = 'CAPTCHA Required';
    node.dotEl.className = 'node-status-dot captcha';
    showCaptchaAlert(siteId);
  } else if (state === 'searching') {
    node.stateEl.textContent = 'Searching…';
  } else if (state === 'throttled') {
    node.stateEl.textContent = 'Rate limited';
  } else if (state === 'failed') {
    node.stateEl.textContent = 'Unavailable';
  } else {
    node.stateEl.textContent = node.count ? `${node.count} found` : 'Complete';
  }
}

function showCaptchaAlert(site) {
  const alertBox = $('captcha-alert');
  if (!alertBox) return;
  alertBox.hidden = false;
  $('alert-title').textContent = `Action Required: ${site.toUpperCase()} Checkpoint`;
  $('alert-msg').textContent = `${site.toUpperCase()} returned a CAPTCHA or security verification. Open the site in your browser to verify or use the extension.`;
  if (site === 'linkedin') $('alert-link').href = 'https://www.linkedin.com/jobs';
  else if (site === 'indeed') $('alert-link').href = 'https://www.indeed.com';
}

function addJobs(jobs) {
  const seenIds = new Set(allJobs.map(j => j.id));
  let countChanged = false;

  for (const job of jobs) {
    if (!job?.id || seenIds.has(job.id)) continue;
    seenIds.add(job.id);
    allJobs.push(job);
    countChanged = true;

    const siteId = getCardSite(job);
    const node = ensureNodeSection(siteId);

    if (node.emptyEl) {
      node.emptyEl.remove();
      node.emptyEl = null;
    }

    node.count++;
    node.countEl.textContent = `${node.count} found`;
    node.countEl.classList.add('has-jobs');
    node.dotEl.className = 'node-status-dot done';
    node.stateEl.textContent = `${node.count} found`;

    // Create job card directly under this site's node container!
    const item = document.createElement('article');
    item.className = 'job-item';
    item.innerHTML = `
      <div class="job-main">
        <a class="job-title" href="${job.url}" target="_blank" rel="noopener noreferrer">${job.title}</a>
        <div class="job-company">${[job.company, job.location].filter(Boolean).join(' · ')}</div>
        <div class="job-badges">
          <span class="job-match-tag">${job.review ? 'Review requirements' : 'Role match'}</span>
          ${job.workplace === 'remote' ? '<span class="job-match-tag" style="background:#f1f5f9; color:#475569;">Remote</span>' : ''}
        </div>
      </div>
      <a class="job-arrow" href="${job.url}" target="_blank" rel="noopener noreferrer" aria-label="Open ${job.title}">↗</a>
    `;

    node.listEl.append(item);
  }

  if (countChanged) {
    $('result-count').textContent = allJobs.length.toLocaleString();
  }
}

async function readFile(file) {
  if (!file) return;
  const seq = ++sequence;
  $('resume-label').textContent = 'Reading CV…';
  $('resume-note').textContent = file.name;

  try {
    const [text, entries] = await Promise.all([
      resumeText(file),
      vocabulary ? Promise.resolve(vocabulary) : fetch(BASE + 'vocabulary').then(r => r.json()).then(d => d.entries)
    ]);
    if (seq !== sequence) return;
    vocabulary = entries;
    features = sanitizeFeatures(profileFeatures(text));
    titles = matchProfessionalTitles(text, entries);

    if (!manualCountry) $('country').value = features.country || 'worldwide';
    $('resume-label').textContent = file.name;
    $('resume-note').textContent = 'CV parsed on device · Ready to search';

    const rolesContainer = $('roles');
    rolesContainer.replaceChildren(
      ...titles.slice(0, 6).map(t => {
        const s = document.createElement('span');
        s.className = 'role-chip';
        s.textContent = t;
        return s;
      })
    );
    rolesContainer.hidden = !titles.length;
    await search(false);
  } catch (err) {
    $('resume-label').textContent = 'Error reading CV';
    $('resume-note').textContent = err.message;
  }
}

async function search(expand = false) {
  const query = $('query').value.trim();
  const seq = ++sequence;
  limit = expand ? Math.min(300, limit + 100) : 100;

  if (!expand) {
    allJobs = [];
    nodeSections.clear();
    $('nodes-stream').replaceChildren();
    $('results-section').hidden = false;
    $('captcha-alert').hidden = true;
    $('result-count').textContent = '0';

    // Pre-create common site nodes
    ['linkedin', 'greenhouse', 'ashby', 'lever', 'indeed', 'remoteok', 'himalayas', 'jobicy', 'remotive', 'arbeitnow', 'boards'].forEach(site => {
      ensureNodeSection(site);
      updateNodeStatus(site, { state: 'searching', count: 0 });
    });
  }

  $('search').disabled = true;
  $('summary').textContent = 'Searching active nodes…';

  try {
    const sites = Object.keys(SITE_LABELS);
    const body = {
      query,
      titles,
      features: { ...(features || profileFeatures(query)), country: $('country').value, remote: $('remote').checked },
      sites,
      limit,
      hours_old: 720
    };

    const res = await fetch(BASE + 'search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    const task = await res.json();
    if (!res.ok) throw new Error(task.error || 'Search failed to start.');

    for (let i = 0; i < 180 && seq === sequence; i++) {
      const sRes = await fetch(BASE + 'status?id=' + encodeURIComponent(task.id));
      const sData = await sRes.json();
      if (!sRes.ok) break;

      addJobs(sData.jobs || []);

      if (Array.isArray(sData.rows)) {
        for (const row of sData.rows) {
          updateNodeStatus(row.site, {
            state: row.state,
            count: row.count,
            captcha: row.captcha || row.stop_reason === 'captcha_required'
          });
        }
      }

      $('summary').textContent = `${(sData.checked || 0).toLocaleString()} listings inspected · ${allJobs.length} matched across nodes`;

      if (!sData.running) {
        $('summary').textContent = `Complete · ${allJobs.length} opportunities matched`;
        $('more').hidden = !sData.can_expand;
        // Clean up empty nodes that finished with 0
        nodeSections.forEach(node => {
          if (!node.count && node.emptyEl) {
            node.emptyEl.textContent = 'No matching opportunities found on this node.';
          }
        });
        break;
      }
      await new Promise(r => setTimeout(r, 650));
    }
  } catch (err) {
    $('summary').textContent = 'Search halted: ' + err.message;
  } finally {
    $('search').disabled = false;
  }
}

// Event Listeners
$('search-form').addEventListener('submit', e => { e.preventDefault(); search(); });
$('resume').addEventListener('change', e => { if (e.target.files[0]) readFile(e.target.files[0]); });

const dropzone = document.querySelector('.upload-zone');
['dragenter', 'dragover'].forEach(evt => dropzone.addEventListener(evt, e => { e.preventDefault(); dropzone.classList.add('dragover'); }));
['dragleave', 'drop'].forEach(evt => dropzone.addEventListener(evt, e => { e.preventDefault(); dropzone.classList.remove('dragover'); if (evt === 'drop') readFile(e.dataTransfer.files[0]); }));

$('country').addEventListener('change', () => { manualCountry = true; });
$('more').addEventListener('click', () => search(true));
$('setup').addEventListener('click', () => $('setup-dialog').showModal());
document.querySelector('.dialog-close').addEventListener('click', () => $('setup-dialog').close());

try {
  const confRes = await fetch(BASE + 'config');
  if (confRes.ok) {
    const config = await confRes.json();
    for (const [id, label] of config.countries) {
      const opt = document.createElement('option');
      opt.value = id;
      opt.textContent = label;
      $('country').append(opt);
    }
    $('country').value = 'worldwide';
  }
} catch {}
