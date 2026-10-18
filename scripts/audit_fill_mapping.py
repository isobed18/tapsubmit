"""Read-only audit of how real employer forms would be filled from a SYNTHETIC profile.

Runs the production companion in `inspect` mode: the form is opened and scanned, nothing is typed, uploaded
or sent. For each form it prints which fields map to which fact/source and which required questions stay
unknown (those would wait for the person). Run from the repository root:
  .venv/Scripts/python.exe scripts/audit_fill_mapping.py [--db .data/desktop-live/portal.sqlite] [--per 3]
"""
import argparse, json, os, sqlite3, subprocess, sys, tempfile
from collections import Counter
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
parser = argparse.ArgumentParser()
parser.add_argument('--db', default=str(ROOT / '.data/desktop-live/portal.sqlite'))
parser.add_argument('--per', type=int, default=3, help='forms per ATS family')
parser.add_argument('--out', default=str(ROOT / 'reports/fill-mapping-audit.json'))
args = parser.parse_args()

db = sqlite3.connect(f'file:{args.db}?mode=ro', uri=True)
jobs = []
for provider in ('greenhouse', 'lever', 'ashby', 'workable'):
    rows = db.execute("SELECT id,payload FROM jobs WHERE active=1 AND json_extract(payload,'$.provider')=? "
                      "ORDER BY last_seen DESC LIMIT ?", (provider, args.per)).fetchall()
    for job_id, payload in rows:
        job = json.loads(payload)
        url = job.get('apply_url') or job.get('listing_url')
        if url:
            jobs.append({'id': job_id, 'url': url, 'title': job.get('title'), 'company': job.get('company')})

work = Path(tempfile.mkdtemp(prefix='fill-audit-', dir=str(ROOT / '.data')))
resume = work / 'Murat_Caz_CV.txt'
resume.write_text((ROOT / '.data/test_resumes/murat_caz_lojistik.txt').read_text(encoding='utf-8'), encoding='utf-8')
request = {
    'task': 'inspect', 'jobs': jobs, 'headless': True, 'browser_profile': str(work / 'profile'), 'concurrency': 2,
    'profile': {'name': 'Murat Caz', 'email': 'murat.caz.demo@example.com', 'phone': '+90 555 010 20 30',
                'location': 'İstanbul, Türkiye', 'linkedin': 'https://www.linkedin.com/in/murat-caz-demo',
                'github': '', 'resume_path': str(resume)},
    'answers': {}, 'scoped_answers': {}, 'preferences': {},
}
req_file = work / 'request.json'
req_file.write_text(json.dumps(request), encoding='utf-8')
env = {**os.environ, 'PYTHONIOENCODING': 'utf-8'}
env.setdefault('PLAYWRIGHT_BROWSERS_PATH', r'D:\cache\ms-playwright')
proc = subprocess.run([sys.executable, '-m', 'applyburst.companion', '--request', str(req_file)], cwd=ROOT, env=env,
                      capture_output=True, text=True, encoding='utf-8', timeout=900)
results = [json.loads(line) for line in proc.stdout.splitlines() if line.startswith('{') and '"result"' in line]
results = [r for r in results if r.get('type') == 'result']

sources, unknown = Counter(), Counter()
for r in results:
    print(f"\n# {r.get('state')} | {r.get('family')} | {next((j['title'] for j in jobs if j['id'] == r.get('job_id')), '')[:60]}")
    for m in r.get('mapped') or []:
        sources[m.get('source')] += 1
        print(f"   {str(m.get('source')):<16} {str(m.get('fact') or ''):<14} {str(m.get('label') or '')[:58]:<60} = {m.get('value')}")
    for q in r.get('missing') or []:
        unknown[str(q.get('label'))[:70]] += 1
        print(f"   UNKNOWN          {str(q.get('kind')):<14} {str(q.get('label'))[:70]}")
    if r.get('note') or r.get('error'):
        print('   note:', str(r.get('note') or r.get('error'))[:140])
summary = {'forms': len(results), 'states': Counter(r.get('state') for r in results), 'filled_by_source': sources,
           'most_common_unknown_questions': unknown.most_common(15)}
print('\nSUMMARY', json.dumps(summary, ensure_ascii=False, default=dict))
Path(args.out).write_text(json.dumps({'note': 'Read-only inspect with synthetic Murat Caz facts; nothing typed or sent.',
                                       'summary': summary, 'results': results}, ensure_ascii=False, indent=1, default=dict), encoding='utf-8')
if proc.returncode and not results:
    print(proc.stderr[-2000:])
