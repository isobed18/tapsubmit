"""Measure actual loopback HTTP search on an existing catalog; no external requests."""
import argparse
import asyncio
import json
import statistics
import time
from pathlib import Path

import httpx

from .api import create_app
from .bench import metadata, percentile
from .catalog import Catalog
from .harness import serve


async def main(args):
    catalog = Catalog(args.db)
    report = {"metadata": metadata(), "scope": "CPU-only title search, actual loopback HTTP",
              "indexed": catalog.count(), "coverage": catalog.stats(), "query": "engineer"}
    async with serve(create_app(catalog=catalog)) as url:
        async with httpx.AsyncClient(timeout=5, trust_env=False) as client:
            samples, counts = [], []
            for _ in range(200):
                tick = time.perf_counter()
                response = await client.get(url + "/jobs?query=engineer&limit=50&scope=title")
                response.raise_for_status()
                counts.append(response.json()["count"])
                samples.append((time.perf_counter()-tick)*1000)
    catalog.close()
    report.update(samples_ms=samples, first_request_ms=samples[0], median_ms=statistics.median(samples),
                  p95_ms=percentile(samples, .95), min_returned=min(counts), max_returned=max(counts))
    Path(args.output).parent.mkdir(parents=True, exist_ok=True)
    Path(args.output).write_text(json.dumps(report, indent=2), encoding="utf-8")
    print(json.dumps({key: value for key, value in report.items() if key not in
                      {"metadata", "samples_ms", "coverage"}}, indent=2))


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--db", default=".data/catalog.sqlite")
    parser.add_argument("--output", default="reports/search-http.json")
    asyncio.run(main(parser.parse_args()))
