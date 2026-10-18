from __future__ import annotations

import asyncio
import hashlib
import time
from email.message import EmailMessage
from urllib.parse import urlparse

import aiosmtplib
import httpx

from .fixture import RESUME
from .forms import known_answers
from .ledger import Ledger


def loopback_only(url):
    parsed = urlparse(url)
    if parsed.scheme != "http" or parsed.hostname not in {"127.0.0.1", "localhost", "::1"}:
        raise ValueError("Baseline write adapters accept loopback HTTP targets only")
    if parsed.username or parsed.password:
        raise ValueError("Unexpected URL credentials")


def verify_receipt(receipt, job_id):
    if not isinstance(receipt, dict) or receipt.get("status") != "confirmed_fixture" or \
       receipt.get("job_id") != job_id or not receipt.get("receipt_id") or \
       receipt.get("resume_sha256") != hashlib.sha256(RESUME).hexdigest() or \
       receipt.get("resume_bytes") != len(RESUME):
        raise ValueError("Missing or invalid fixture confirmation")
    return receipt


class Pacer:
    """No burst: successive request starts are separated by 1/rate seconds."""
    def __init__(self, rate):
        self.interval = 1/rate if rate else 0
        self.next = 0.0
        self.lock = asyncio.Lock()

    async def wait(self):
        async with self.lock:
            tick = time.perf_counter()
            when = max(tick, self.next)
            self.next = when + self.interval
        await asyncio.sleep(max(0, when-time.perf_counter()))


async def run_http(base_url, job_ids, ledger: Ledger, concurrency=10, timeout=5,
                   max_attempts=3, rate=None):
    loopback_only(base_url)
    sem, pacer = asyncio.Semaphore(concurrency), Pacer(rate)
    start = time.perf_counter()
    async with httpx.AsyncClient(timeout=timeout, follow_redirects=False, trust_env=False,
                                 limits=httpx.Limits(max_connections=concurrency)) as client:
        async def submit(job_id):
            key = "demo-candidate:" + job_id
            tick = time.perf_counter()
            if not ledger.claim(key):
                previous = ledger.get(key)
                return {"job_id": job_id, "state": "deduplicated", "previous_state": previous["state"],
                        "elapsed_ms": 0, "attempts": 0}
            state, receipt, attempts = "failed", None, 0
            try:
                async with sem:
                    for attempt in range(max_attempts):
                        await pacer.wait()
                        attempts += 1
                        response = await client.post(
                            base_url + "/applications/" + job_id, data=known_answers(),
                            files={"resume": ("synthetic-resume.txt", RESUME, "text/plain")})
                        # Only the fixture's explicit pre-effect rate rejection is retried.
                        if response.status_code == 429 and attempt+1 < max_attempts:
                            await asyncio.sleep(min(5, max(0, float(response.headers.get("Retry-After", "0.5")))))
                            continue
                        response.raise_for_status()
                        receipt = verify_receipt(response.json(), job_id)
                        state = "confirmed_fixture"
                        break
            except httpx.TimeoutException:
                state = "unknown"
            except httpx.TransportError:
                state = "unknown"
            except httpx.HTTPStatusError as exc:
                state = "failed" if exc.response.status_code in {400, 401, 403, 404, 410, 422, 429} else "unknown"
            except (ValueError, KeyError, TypeError):
                state = "unknown"
            ledger.finish(key, state, receipt)
            return {"job_id": job_id, "state": state, "receipt": receipt, "attempts": attempts,
                    "elapsed_ms": round((time.perf_counter()-tick)*1000, 3)}
        results = await asyncio.gather(*(submit(job_id) for job_id in job_ids))
    return {"elapsed_ms": round((time.perf_counter()-start)*1000, 3), "results": results,
            "confirmed": sum(r["state"] == "confirmed_fixture" for r in results),
            "model_calls": 0, "concurrency": concurrency}


async def run_smtp(host, port, job_ids, concurrency=10):
    if host not in {"127.0.0.1", "localhost", "::1"}:
        raise ValueError("Baseline SMTP adapter is loopback only")
    sem = asyncio.Semaphore(concurrency)
    start = time.perf_counter()
    async def send(job_id):
        async with sem:
            message = EmailMessage()
            message["From"] = "candidate@example.test"
            message["To"] = f"{job_id}@employer.example.test"
            message["Subject"] = f"Synthetic application {job_id}"
            message["Message-ID"] = f"<{job_id}@applyburst.example.test>"
            message.set_content("Synthetic benchmark application. No real candidate data.")
            message.add_attachment(RESUME, maintype="text", subtype="plain", filename="synthetic-resume.txt")
            try:
                errors, response = await aiosmtplib.send(message, hostname=host, port=port,
                                                       start_tls=False, timeout=10)
                state = "accepted_by_mail_server" if not errors else "failed"
                return {"job_id": job_id, "state": state, "message_id": message["Message-ID"],
                        "smtp_response": response}
            except Exception as exc:
                return {"job_id": job_id, "state": "unknown", "error": type(exc).__name__}
    results = await asyncio.gather(*(send(job_id) for job_id in job_ids))
    return {"elapsed_ms": round((time.perf_counter()-start)*1000, 3), "results": results,
            "accepted": sum(r["state"] == "accepted_by_mail_server" for r in results),
            "concurrency": concurrency, "model_calls": 0}
