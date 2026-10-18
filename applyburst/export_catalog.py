"""Refresh full descriptions and export the normalized corpus for the CPU-only web demo."""
import argparse
import asyncio
import json
import time
from pathlib import Path

from .catalog import Catalog
from .discovery import load_boards, refresh

COMPANIES = {"stripe": "Stripe", "cloudflare": "Cloudflare", "palantir": "Palantir", "ashby": "Ashby",
             "ramp": "Ramp", "trendyol": "Trendyol", "insiderone": "Insider One", "peakgames": "Peak",
             "dreamgames": "Dream Games"}


async def main(args):
    Path(args.db).parent.mkdir(parents=True, exist_ok=True)
    catalog = Catalog(args.db)
    report = await refresh(catalog, load_boards(), deadline_seconds=20)
    jobs = []
    for row in catalog.db.execute("SELECT key,payload,seen_at FROM jobs WHERE active=1 ORDER BY key"):
        job = json.loads(row["payload"])
        job.update(id=row["key"], company=COMPANIES.get(job["board"], job["board"]),
                   canonical_id=f"{job['provider']}:{job['board']}:{job.get('opportunity_id') or job['external_id']}",
                   seen_at=row["seen_at"], source_url=next((b["url"] for b in report["boards"]
                       if b["provider"] == job["provider"] and b["board"] == job["board"]), ""))
        jobs.append(job)
    payload = {"schema_version": 2, "generated_at": time.time(), "jobs": jobs, "sources": report,
               "coverage": {"jobs": len(jobs), "unique_opportunities":len({j['canonical_id'] for j in jobs}),"with_description": sum(bool(j["description"]) for j in jobs),
                            "with_skills": sum(bool(j["skills"]) for j in jobs),
                            "workplace_known": sum(j["workplace"] != "unknown" for j in jobs),
                            "seniority_known": sum(j["seniority"] != "unknown" for j in jobs)}}
    target = Path(args.output)
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(json.dumps(payload, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    Path("reports/discovery-v2.json").write_text(json.dumps({k:v for k,v in payload.items() if k != "jobs"}, indent=2), encoding="utf-8")
    print(json.dumps({"output": str(target), "bytes": target.stat().st_size, **payload["coverage"]}), flush=True)
    catalog.close()


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--db", default=".data/demo-catalog.sqlite")
    parser.add_argument("--output", default="demo/public/jobs.json")
    asyncio.run(main(parser.parse_args()))
