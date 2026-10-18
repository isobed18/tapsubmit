"""Bounded UTF-8 pipe check: source and desktop entry points, synthetic profile, fill-only.

The child is deliberately launched with a conflicting Windows encoding. No employer submission.
Run with the project venv; loopback fixture receiver defaults to 8797.
"""
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import threading
import time

root = Path(__file__).resolve().parents[1]
directory = Path(tempfile.mkdtemp(prefix='protocol-', dir=root / '.data/model-eval'))
resume = directory / 'synthetic.txt'
resume.write_text('Synthetic transport check. No real candidate.', encoding='utf-8')
expected = 'Zoë Şule'
rows = []
for name, args in [('source', ['-m', 'applyburst.companion']),
                   ('desktop_entry', ['desktop/worker.py', '--worker', 'companion'])]:
    request = {'task': 'prepare', 'headless': True, 'watch_seconds': 0, 'human_timeout': 1,
               'browser_profile': str(directory / name), 'jobs': [{'id': name, 'family': 'lever',
               'url': 'http://127.0.0.1:8797/lever/happy/utf8-' + name}],
               'profile': {'name': expected, 'email': 'synthetic@example.test', 'phone': '+90 555 000 00 00',
                           'location': 'Ankara, Turkey', 'linkedin': 'https://example.test/profile', 'resume_path': str(resume)}}
    env = {**os.environ, 'PYTHONIOENCODING': 'cp1252', 'PYTHONUTF8': '0',
           'PYTHONPATH': str(root), 'PLAYWRIGHT_BROWSERS_PATH': 'D:/cache/ms-playwright'}
    tick = time.perf_counter()
    child = subprocess.Popen([sys.executable, *args, '--request', '-'], cwd=root, env=env,
                             stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    timer = threading.Timer(40, child.kill)
    timer.start()
    try:
        child.stdin.write((json.dumps(request, ensure_ascii=False) + '\n').encode('utf-8'))
        child.stdin.flush()  # keep command channel open until the fill-only task exits
        events = [json.loads(line) for line in child.stdout if line.strip()]
        code = child.wait(timeout=2)
        stderr = child.stderr.read().decode('utf-8', errors='replace')
        results = [e for e in events if e.get('type') == 'result']
        values = [r.get('value') for e in results for r in e.get('disclosure', [])]
        assert code == 0 and expected in values, (name, code, results, stderr[-500:])
        assert not any(e.get('type') == 'intent' for e in events)
        rows.append({'entry': name, 'forced_initial_encoding': 'cp1252', 'non_ascii_profile_exact': True,
                     'state': results[-1]['state'], 'submission_intents': 0,
                     'elapsed_ms': round((time.perf_counter() - tick) * 1000)})
    finally:
        timer.cancel()
        if child.poll() is None:
            child.kill()
        child.stdin.close()
report = {'utc': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()),
          'scope': 'UTF-8 protocol check on source Python and desktop Python entry point, not a frozen executable or clean-machine installer. Loopback synthetic employer, fill only.',
          'checks': rows, 'source_sha256': {}}
for file in ['applyburst/companion.py', 'applyburst/live_search.py', 'desktop/worker.py']:
    report['source_sha256'][file] = hashlib.sha256((root / file).read_bytes()).hexdigest()
(root / 'reports/model-layer/protocol-utf8-18oct.json').write_text(json.dumps(report, indent=2) + '\n', encoding='utf-8')
print(json.dumps(report))
