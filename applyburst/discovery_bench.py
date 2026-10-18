"""CPU-only cold vs cached discovery. Hardware metadata is recorded, not simulated."""
import argparse
import asyncio
import json
import os
import statistics
import time
from pathlib import Path

import httpx

from .bench import metadata, search_bench
from .catalog import Catalog
from .discovery import Board, load_boards, refresh
from .api import create_app
from .harness import serve


async def main(args):
    Path(".data").mkdir(exist_ok=True)
    report = {"metadata": metadata(), "scope": "CPU-only discovery; no inference, browser, or GPU"}
    # A new catalog per run makes 'cold' repeatable without deleting any existing user's data.
    catalog = Catalog(":memory:")
    boards = load_boards(preset=args.preset)
    report["preset"] = args.preset or "all"
    report["cold"] = await refresh(catalog, boards)
    print(f"Cold: {report['cold']['total_indexed']} jobs in {report['cold']['elapsed_ms']:.1f}ms", flush=True)
    report["cached_search"] = search_bench(catalog)
    async with serve(create_app(catalog=catalog)) as local_url:
        async with httpx.AsyncClient(timeout=5, trust_env=False) as client:
            samples, counts = [], []
            for _ in range(200):
                tick = time.perf_counter()
                response = await client.get(local_url + "/jobs", params={"query": "engineer", "scope": "title"})
                response.raise_for_status()
                counts.append(response.json()["count"])
                samples.append((time.perf_counter()-tick)*1000)
            report["cached_http_search"] = {"samples": len(samples), "median_ms": statistics.median(samples),
                "p95_ms": sorted(samples)[int((len(samples)-1)*.95)], "samples_ms": samples,
                "min_returned": min(counts), "scope": "title", "transport": "actual loopback HTTP"}
    report["repeat_refresh"] = await refresh(catalog, boards)
    report["coverage"] = catalog.stats()
    report["location_observations"] = [dict(row) for row in catalog.db.execute(
        "SELECT json_extract(payload,'$.location') AS location,count(*) AS count FROM jobs "
        "WHERE active=1 GROUP BY location ORDER BY count DESC LIMIT 15")]
    report["turkey_location_counts"] = dict(catalog.db.execute(
        "SELECT 'turkey_location_mentions',COUNT(*) FROM jobs WHERE active=1 AND "
        "(lower(json_extract(payload,'$.location')) LIKE '%turkey%' OR "
        "lower(json_extract(payload,'$.location')) LIKE '%turkiye%' OR "
        "lower(json_extract(payload,'$.location')) LIKE '%istanbul%' OR "
        "lower(json_extract(payload,'$.location')) LIKE '%ankara%')"))
    # Same company and transport. Two observations, not a statistically stable latency comparison.
    report["greenhouse_payload_probe"] = []
    async with httpx.AsyncClient(timeout=25, follow_redirects=True) as client:
        for include_content in [False, True]:
            board = Board("greenhouse", "stripe", content=include_content)
            tick = time.perf_counter()
            response = await client.get(board.url)
            entry = {"url": board.url, "status": response.status_code,
                     "elapsed_ms": (time.perf_counter()-tick)*1000, "decoded_bytes": len(response.content),
                     "content_length_header": response.headers.get("content-length"),
                     "content_encoding": response.headers.get("content-encoding")}
            if response.is_success:
                entry["jobs"] = len(response.json()["jobs"])
            report["greenhouse_payload_probe"].append(entry)
    catalog.close()
    target = Path(args.output)
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(json.dumps(report, indent=2), encoding="utf-8")
    print(f"Cache: p50={report['cached_search']['median_ms']:.3f}ms; "
          f"p95={report['cached_search']['p95_ms']:.3f}ms; min results={report['cached_search']['min_returned']}", flush=True)
    print(f"Saved {target}", flush=True)


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--preset", choices=["international", "turkey"])
    parser.add_argument("--output", default="reports/discovery.json")
    asyncio.run(main(parser.parse_args()))
