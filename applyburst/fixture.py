"""Loopback-only application receiver. This is NOT an employer ATS implementation."""
import asyncio
import hashlib
import html
import json
import time
from email import policy
from email.parser import BytesParser

from fastapi import FastAPI, Request
from fastapi.responses import HTMLResponse, JSONResponse

from .forms import FIELDS, known_answers

RESUME = b"ApplyBurst synthetic resume\nNo real candidate data.\n" * 512


def make_fixture(delay_ms=100, fault="none"):
    app = FastAPI()
    receipts = {}
    attempts = {}
    app.state.receipts = receipts
    app.state.attempts = attempts

    @app.get("/health")
    async def health():
        return {"ok": True, "fixture": True}

    @app.get("/jobs/{job_id}", response_class=HTMLResponse)
    async def job_form(job_id: str):
        controls = []
        for field in FIELDS:
            name, label = field["name"], html.escape(field["label"])
            if field["kind"] == "select":
                control = f'<select id="{name}" name="{name}" required><option value="">Choose</option>'
                control += ''.join(f'<option>{x}</option>' for x in field["options"]) + '</select>'
            else:
                control = f'<input id="{name}" name="{name}" type="{field["kind"]}" required>'
            controls.append(f'<label for="{name}">{label}</label>{control}')
        return '<!doctype html><html lang="en"><meta charset="utf-8"><title>Application fixture</title>' + \
            '<style>body{font:16px system-ui;max-width:580px;margin:30px auto;background:#fafafa}' + \
            'label,input,select{display:block;margin:8px 0}input,select{padding:8px;width:95%}' + \
            'button{padding:12px 20px;margin-top:20px}</style><h1>Synthetic application</h1>' + \
            f'<p>Job {html.escape(job_id)} · local benchmark only</p>' + \
            f'<form action="/applications/{html.escape(job_id)}" method="post" enctype="multipart/form-data">' + \
            ''.join(controls) + '<label for="resume">Resume</label><input id="resume" name="resume" type="file" required>' + \
            '<button type="submit">Submit application</button></form></html>'

    @app.post("/applications/{job_id}")
    async def apply(job_id: str, request: Request):
        form = await request.form()
        attempt_key = str(form.get("email", "")) + ":" + job_id
        attempts[attempt_key] = attempts.get(attempt_key, 0) + 1
        if fault == "rate_limit" and attempts[attempt_key] == 1:
            return JSONResponse({"error": "slow down"}, status_code=429, headers={"Retry-After": "0.15"})
        if fault == "rejected":
            return JSONResponse({"error": "closed"}, status_code=410)
        for name, expected in known_answers().items():
            if form.get(name) != expected:
                return JSONResponse({"error": f"Invalid answer: {name}"}, status_code=422)
        resume = form.get("resume")
        if resume is None or not hasattr(resume, "read"):
            return JSONResponse({"error": "Resume required"}, status_code=422)
        content = await resume.read()
        if content != RESUME:
            return JSONResponse({"error": "Wrong resume bytes"}, status_code=422)
        await asyncio.sleep(delay_ms/1000)
        receipt = {"receipt_id": hashlib.sha256(attempt_key.encode()).hexdigest()[:24],
                   "job_id": job_id, "status": "confirmed_fixture", "received_at": time.time(),
                   "resume_sha256": hashlib.sha256(content).hexdigest(), "resume_bytes": len(content)}
        receipts[attempt_key] = receipt
        if fault == "ambiguous":
            # Side effect committed, but response arrives too late for the caller.
            await asyncio.sleep(1)
        if fault == "missing_receipt":
            return {"ok": True}
        if "text/html" in request.headers.get("accept", ""):
            return HTMLResponse('<h1>Application received by fixture</h1><pre id="receipt">' +
                                html.escape(json.dumps(receipt)) + '</pre>')
        return receipt

    return app


class MailSink:
    def __init__(self, delay_ms=100):
        self.messages = {}
        self.delay_ms = delay_ms

    async def handle_DATA(self, server, session, envelope):
        message = BytesParser(policy=policy.default).parsebytes(envelope.content)
        attachments = list(message.iter_attachments())
        if not attachments or attachments[0].get_payload(decode=True) != RESUME:
            return "550 missing or invalid synthetic resume"
        await asyncio.sleep(self.delay_ms/1000)
        self.messages[message["Message-ID"]] = {"to": envelope.rcpt_tos, "bytes": len(envelope.content)}
        return "250 accepted by local fixture; not employer delivery"
