from __future__ import annotations

import asyncio
import hashlib
import time
import json
from pathlib import Path
from dataclasses import dataclass

import httpx

from .catalog import Catalog, Job
from .enrichment import plain_text, enrich


@dataclass(frozen=True)
class Board:
    provider: str
    name: str
    content: bool = False

    @property
    def url(self):
        return {
            "greenhouse": f"https://boards-api.greenhouse.io/v1/boards/{self.name}/jobs?content={'true' if self.content else 'false'}",
            "lever": f"https://api.lever.co/v0/postings/{self.name}?mode=json",
            "ashby": f"https://api.ashbyhq.com/posting-api/job-board/{self.name}",
        }[self.provider]


DEFAULT_BOARDS = [Board("greenhouse", "stripe"), Board("greenhouse", "cloudflare"),
                  Board("lever", "palantir"), Board("ashby", "ashby"), Board("ashby", "ramp")]


def load_boards(path="config/boards.json", preset=None):
    rows = json.loads(Path(path).read_text(encoding="utf-8"))
    return [Board(row["provider"], row["name"], content=row.get("content", True)) for row in rows
            if row.get("enabled", True) and (preset is None or preset in row.get("tags", []))]


def normalize(board: Board, payload) -> list[Job]:
    if board.provider == "greenhouse":
        rows = payload["jobs"]
        jobs = []
        for j in rows:
            if j.get("internal_job_id") is None:
                continue
            location = j.get("location", {}).get("name", "")
            description = plain_text(j.get("content", ""))
            offices = [o["name"] for o in j.get("offices", []) if o.get("name")]
            jobs.append(Job(board.provider, board.name, str(j["id"]), j["title"], location,
                j["absolute_url"], description, locations=tuple(dict.fromkeys([location]+offices)),
                opportunity_id=str(j['internal_job_id']),
                department=", ".join(d["name"] for d in j.get("departments", []) if d.get("name")),
                posted_at=j.get("first_published"), **enrich(j["title"], description, location)))
        return jobs
    if board.provider == "lever":
        if not isinstance(payload, list):
            raise ValueError("Expected Lever postings array")
        jobs = []
        for j in payload:
            categories = j.get("categories", {})
            location = categories.get("location", "")
            # Lever's first paragraph alone excludes most responsibilities/requirements.
            sections = [j.get("descriptionPlain", j.get("description", ""))]
            sections += [section.get("text", "") + "\n" + section.get("content", "") for section in j.get("lists", [])]
            sections += [j.get("additionalPlain", j.get("additional", "")), j.get("salaryDescriptionPlain", "")]
            description = plain_text("\n\n".join(sections))
            locations = categories.get("allLocations", []) or [location]
            if isinstance(locations, str):
                locations = [locations]
            salary = j.get("salaryRange")
            if salary:
                salary = {"min": salary.get("min"), "max": salary.get("max"),
                          "currency": salary.get("currency"), "period": salary.get("interval"), "source": "provider_field"}
            jobs.append(Job(board.provider, board.name, j["id"], j["text"], location, j["applyUrl"], description,
                locations=tuple(dict.fromkeys([location]+locations)), department=categories.get("department", ""),
                posted_at=str(j["createdAt"]) if j.get("createdAt") else None, salary=salary,
                **enrich(j["text"], description, location, j.get("workplaceType"), categories.get("commitment"))))
        return jobs
    jobs = []
    for j in payload["jobs"]:
        if not j.get("isListed", True):
            continue
        location = j.get("location", "")
        description = plain_text(j.get("descriptionPlain", j.get("descriptionHtml", "")))
        locations = [location] + [x["location"] for x in j.get("secondaryLocations", []) if x.get("location")]
        jobs.append(Job(board.provider, board.name, j["id"], j["title"], location, j["applyUrl"], description,
            locations=tuple(dict.fromkeys(locations)), department=j.get("department", ""), posted_at=j.get("publishedAt"),
            **enrich(j["title"], description, location, "remote" if j.get("isRemote") else None, j.get("employmentType"))))
    return jobs


async def refresh(catalog: Catalog, boards: list[Board] | None = None, concurrency: int = 4,
                  transport=None, deadline_seconds=8, milestone_query="engineer"):
    semaphore = asyncio.Semaphore(concurrency)
    start = time.perf_counter()
    first_50_indexed_ms = 0.0 if catalog.count() >= 50 else None
    first_50_matches_ms = 0.0 if len(catalog.search(milestone_query, scope="title")) >= 50 else None
    origins = {provider: asyncio.Semaphore(2) for provider in {"greenhouse", "lever", "ashby"}}
    # No credentials, browser sessions, employer writes, or model calls.
    async with httpx.AsyncClient(timeout=25, follow_redirects=True,
                                 transport=transport,
                                 headers={"User-Agent": "ApplyBurst-research/0.1 (read-only)"}) as client:
        async def fetch(board):
            nonlocal first_50_indexed_ms, first_50_matches_ms
            async with semaphore, origins[board.provider]:
                tick = time.perf_counter()
                report = {"provider": board.provider, "board": board.name, "url": board.url}
                try:
                    state = catalog.board_state(board.provider, board.name)
                    representation='normalizer-v3:'+board.url
                    if state.get('representation') != representation:
                        state={}
                    headers = {}
                    if state.get("etag"):
                        headers["If-None-Match"] = state["etag"]
                    if state.get("modified"):
                        headers["If-Modified-Since"] = state["modified"]
                    async with asyncio.timeout(deadline_seconds):
                        response = await client.get(board.url, headers=headers)
                    digest = hashlib.sha256(response.content).hexdigest()
                    report.update(status=response.status_code, bytes=len(response.content),
                                  response_sha256=digest)
                    if response.status_code == 304:
                        if not state.get("sha256"):
                            raise ValueError("304 without a previous successful snapshot")
                        catalog.touch_board(board.provider, board.name)
                        catalog.record_refresh(board.provider, board.name, state.get("etag"),
                                               state.get("modified"), state["sha256"],representation)
                        report.update(jobs=None, outcome="not_modified")
                    else:
                        response.raise_for_status()
                        if state.get("sha256") == digest:
                            catalog.touch_board(board.provider, board.name)
                            report.update(jobs=None, outcome="unchanged_hash")
                        else:
                            jobs = normalize(board, response.json())
                            catalog.replace_board(board.provider, board.name, jobs)
                            report.update(jobs=len(jobs), outcome="indexed")
                        catalog.record_refresh(board.provider, board.name, response.headers.get("etag"),
                                               response.headers.get("last-modified"), digest,representation)
                    if first_50_indexed_ms is None and catalog.count() >= 50:
                        first_50_indexed_ms = round((time.perf_counter()-start)*1000, 3)
                    if first_50_matches_ms is None and len(catalog.search(milestone_query, scope="title")) >= 50:
                        first_50_matches_ms = round((time.perf_counter()-start)*1000, 3)
                except Exception as exc:
                    report.update(jobs=0, outcome="failed", error=f"{type(exc).__name__}: {exc}")
                report["elapsed_ms"] = round((time.perf_counter()-tick)*1000, 3)
                return report
        results = await asyncio.gather(*(fetch(board) for board in (boards or DEFAULT_BOARDS)))
    return {"kind": "live_read_only_discovery", "elapsed_ms": round((time.perf_counter()-start)*1000, 3),
            "total_indexed": catalog.count(), "boards": results,
            "first_50_indexed_ms": first_50_indexed_ms, "first_50_matches_ms": first_50_matches_ms,
            "milestone_query": milestone_query, "milestone_scope": "title",
            "per_source_deadline_seconds": deadline_seconds}
