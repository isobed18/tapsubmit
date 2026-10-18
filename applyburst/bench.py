"""Run with python -m applyburst.bench [--live] [--browser] [--repeats 3]."""
import argparse
import asyncio
import importlib.metadata
import json
import platform
import statistics
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

from aiosmtpd.controller import Controller

from .catalog import Catalog, Job
from .discovery import refresh
from .execution import run_http, run_smtp
from .fixture import MailSink, make_fixture
from .harness import free_port, serve
from .ledger import Ledger


def percentile(values, p):
    values = sorted(values)
    return values[min(len(values)-1, int((len(values)-1)*p))]


def metadata():
    return {"utc": datetime.now(timezone.utc).isoformat(), "platform": platform.platform(),
            "python": sys.version, "cpu": platform.processor(),
            "packages": {name: importlib.metadata.version(name) for name in
                         ("httpx", "fastapi", "uvicorn", "playwright", "aiosmtpd", "aiosmtplib")}}


def search_bench(catalog, samples=200):
    times, counts = [], []
    for _ in range(samples):
        tick = time.perf_counter()
        rows = catalog.search("engineer", limit=50)
        times.append((time.perf_counter()-tick)*1000)
        counts.append(len(rows))
    return {"query": "engineer", "samples": samples, "median_ms": statistics.median(times),
            "p95_ms": percentile(times, .95), "min_returned": min(counts), "max_returned": max(counts),
            "indexed": catalog.count(), "samples_ms": times}


async def main(args):
    Path(".data").mkdir(exist_ok=True)
    output = {"metadata": metadata(), "scope": "Loopback fixture submissions; public GET-only discovery",
              "batch_size": args.jobs, "repeats": args.repeats, "scenarios": []}
    catalog = Catalog(":memory:")
    if args.live:
        output["live_discovery"] = await refresh(catalog)
        output["live_cached_search"] = search_bench(catalog)
        print("Live discovery:", json.dumps({k: v for k, v in output["live_discovery"].items() if k != "boards"}), flush=True)
    catalog.close()
    synthetic = Catalog(":memory:")
    tick = time.perf_counter()
    synthetic.replace_board("fixture", "synthetic", [
        Job("fixture", "synthetic", str(i), f"Software Engineer {i}", "Remote",
            f"https://example.test/jobs/{i}", "Python distributed systems") for i in range(10000)])
    output["synthetic_index_build_ms"] = (time.perf_counter()-tick)*1000
    output["synthetic_cached_search"] = search_bench(synthetic)
    synthetic.close()

    for latency, concurrencies in [(100, [1, 5, 10, 20]), (500, [10])]:
        app = make_fixture(latency)
        async with serve(app) as url:
            for concurrency in concurrencies:
                for repeat in range(args.repeats):
                    ledger = Ledger(":memory:")
                    ids = [f"http-{latency}-{concurrency}-{repeat}-{i}" for i in range(args.jobs)]
                    result = await run_http(url, ids, ledger, concurrency=concurrency)
                    ledger.close()
                    result.update(mode="http", injected_response_ms=latency, repeat=repeat)
                    result["receiver_count"] = sum(1 for v in app.state.receipts.values() if v["job_id"] in ids)
                    output["scenarios"].append(result)
                    assert result["confirmed"] == result["receiver_count"] == args.jobs, "Missing HTTP receipts"
                    print(f"HTTP delay={latency}ms c={concurrency}: {result['elapsed_ms']:.1f} ms, "
                          f"{result['confirmed']}/{args.jobs} receipts", flush=True)

    app = make_fixture(100)
    async with serve(app) as url:
        ledger = Ledger(":memory:")
        ids = [f"rate-{i}" for i in range(args.jobs)]
        result = await run_http(url, ids, ledger, concurrency=10, rate=2)
        result.update(mode="http_paced_2_per_second", injected_response_ms=100, repeat=0)
        output["scenarios"].append(result)
        ledger.close()
        print(f"Rate-constrained HTTP 2/s: {result['elapsed_ms']:.1f} ms", flush=True)

    for repeat in range(args.repeats):
        sink, port = MailSink(100), free_port()
        controller = Controller(sink, hostname="127.0.0.1", port=port)
        controller.start()
        try:
            result = await run_smtp("127.0.0.1", port,
                                    [f"mail-{repeat}-{i}" for i in range(args.jobs)], concurrency=10)
            result.update(mode="smtp", injected_response_ms=100, repeat=repeat, receiver_count=len(sink.messages))
            output["scenarios"].append(result)
            assert result["accepted"] == result["receiver_count"] == args.jobs, "Missing SMTP acceptance"
            print(f"SMTP c=10: {result['elapsed_ms']:.1f} ms, {len(sink.messages)} accepted", flush=True)
        finally:
            controller.stop()

    if args.browser:
        from .browser import run_browser
        app = make_fixture(100)
        async with serve(app) as url:
            for concurrency in [1, 2, 5]:
                for repeat in range(args.repeats):
                    ids = [f"browser-{concurrency}-{repeat}-{i}" for i in range(args.jobs)]
                    result = await run_browser(url, ids, concurrency)
                    result.update(mode="browser_replay", injected_response_ms=100, repeat=repeat,
                                  receiver_count=sum(1 for v in app.state.receipts.values() if v["job_id"] in ids))
                    output["scenarios"].append(result)
                    assert result["confirmed"] == result["receiver_count"] == args.jobs, "Missing browser receipts"
                    print(f"Browser c={concurrency}: {result['elapsed_ms']:.1f} ms + "
                          f"{result['startup_ms']:.1f} ms startup, {result['confirmed']} receipts", flush=True)

    target = Path(args.output)
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(json.dumps(output, indent=2), encoding="utf-8")
    print(f"Saved {target}", flush=True)


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--live", action="store_true")
    parser.add_argument("--browser", action="store_true")
    parser.add_argument("--jobs", type=int, default=50)
    parser.add_argument("--repeats", type=int, default=3)
    parser.add_argument("--output", default="reports/baseline.json")
    asyncio.run(main(parser.parse_args()))
