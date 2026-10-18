import asyncio
import json
import time

from playwright.async_api import async_playwright

from .execution import loopback_only, verify_receipt
from .fixture import RESUME
from .forms import EXPECTED, FIELDS, PROFILE, validate_plan


async def fill_and_submit(page, base_url, job_id, mapping=None):
    loopback_only(base_url)
    mapping = validate_plan({"mapping": mapping or EXPECTED})
    await page.goto(base_url + "/jobs/" + job_id, wait_until="domcontentloaded")
    for field in FIELDS:
        selector = page.locator('[name="' + field["name"] + '"]')
        value = PROFILE[mapping[field["name"]]]
        if field["kind"] == "select":
            await selector.select_option(value)
        else:
            await selector.fill(value)
    await page.locator('[name="resume"]').set_input_files(
        {"name": "synthetic-resume.txt", "mimeType": "text/plain", "buffer": RESUME})
    await page.get_by_role("button", name="Submit application").click()
    receipt = json.loads(await page.locator("#receipt").inner_text())
    return verify_receipt(receipt, job_id)


async def run_browser(base_url, job_ids, concurrency=2, mapping=None):
    loopback_only(base_url)
    startup = time.perf_counter()
    async with async_playwright() as playwright:
        browser = await playwright.chromium.launch(headless=True, args=["--disable-gpu"])
        contexts = [await browser.new_context() for _ in range(concurrency)]
        pages = [await context.new_page() for context in contexts]
        startup_ms = (time.perf_counter()-startup)*1000
        queue = asyncio.Queue()
        for job_id in job_ids:
            queue.put_nowait(job_id)
        start = time.perf_counter()
        results = []
        async def worker(page):
            while not queue.empty():
                job_id = queue.get_nowait()
                tick = time.perf_counter()
                try:
                    receipt = await fill_and_submit(page, base_url, job_id, mapping)
                    result = {"job_id": job_id, "state": "confirmed_fixture", "receipt": receipt}
                except Exception as exc:
                    result = {"job_id": job_id, "state": "unknown", "error": type(exc).__name__}
                result["elapsed_ms"] = round((time.perf_counter()-tick)*1000, 3)
                results.append(result)
        await asyncio.gather(*(worker(page) for page in pages))
        elapsed_ms = (time.perf_counter()-start)*1000
        await browser.close()
    return {"elapsed_ms": round(elapsed_ms, 3), "startup_ms": round(startup_ms, 3),
            "cold_total_ms": round(startup_ms+elapsed_ms, 3), "results": results,
            "confirmed": sum(r["state"] == "confirmed_fixture" for r in results),
            "concurrency": concurrency, "model_calls": 0}
